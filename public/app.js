/* eslint-env browser */
/**
 * Demo UI for the notification system.
 *
 * No framework and no build step on purpose: the point of this page is to make the backend
 * pipeline visible, not to demonstrate frontend architecture.
 */

const API_KEY = 'dev-key-please-change';
const API = '';

const state = {
  users: [],
  topics: [],
  userId: null,
  eventSource: null,
};

// ------------------------------------------------------------------ helpers

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: {
      'x-api-key': API_KEY,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const err = new Error((body && body.message) || `HTTP ${res.status}`);
    err.body = body;
    throw err;
  }
  return body;
}

const $ = (id) => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Status -> badge colour. Groups the many delivery statuses into four visual buckets. */
function statusClass(status) {
  if (['SENT', 'DELIVERED', 'OPENED', 'CLICKED', 'COMPLETED'].includes(status)) return 'badge-ok';
  if (['FAILED', 'BOUNCED', 'COMPLAINED'].includes(status)) return 'badge-bad';
  if (['SKIPPED', 'SUPPRESSED', 'PARTIAL'].includes(status)) return 'badge-warn';
  return 'badge-muted';
}

function timeAgo(iso) {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Plausible sample payloads so the demo works without hand-writing JSON. */
const SAMPLE_PAYLOADS = {
  'user.welcome': { name: 'Alice', activationUrl: 'https://example.com/activate/abc123' },
  'order.shipped': {
    orderId: 'A-1001',
    carrier: 'DHL',
    trackingNumber: 'TRK-99231',
    trackingUrl: 'https://example.com/track/TRK-99231',
    etaDate: 'Friday, 14 August',
    items: [
      { name: 'Mechanical keyboard', qty: 1 },
      { name: 'USB-C cable', qty: 2 },
    ],
  },
  'security.login_alert': {
    ipAddress: '203.0.113.42',
    location: 'Dhaka, Bangladesh',
    device: 'Chrome on Windows',
    at: new Date().toISOString(),
    secureAccountUrl: 'https://example.com/security',
  },
  'product.newsletter': {
    headline: 'What shipped in August',
    body: 'Digest batching, circuit breakers and a much faster delivery trace view.',
    ctaLabel: 'Read the changelog',
    ctaUrl: 'https://example.com/changelog',
  },
  'comment.mentioned': {
    authorName: 'Bob',
    excerpt: 'Can you take a look at the retry logic in the email worker?',
    threadUrl: 'https://example.com/threads/42',
  },
};

// ------------------------------------------------------------------ bootstrap

async function init() {
  await loadUsers();
  await loadTopics();
  bindEvents();
  await refreshAll();
  connectStream();
  await refreshPushStatus();
}

async function loadUsers() {
  state.users = await api('/v1/users');
  const select = $('user-select');
  select.innerHTML = '';
  for (const user of state.users) {
    const option = el('option', null, `${user.email} (${user.timezone})`);
    option.value = user.id;
    select.appendChild(option);
  }
  state.userId = state.users[0]?.id ?? null;
  select.value = state.userId ?? '';
}

async function loadTopics() {
  // system.* topics are internal — the ingest endpoint rejects them, so hide them here too.
  state.topics = (await api('/v1/topics')).filter((t) => !t.key.startsWith('system.'));
  const select = $('topic-select');
  select.innerHTML = '';
  for (const topic of state.topics) {
    const option = el('option', null, `${topic.name} — ${topic.key}`);
    option.value = topic.key;
    select.appendChild(option);
  }
  onTopicChange();
}

function onTopicChange() {
  const key = $('topic-select').value;
  const topic = state.topics.find((t) => t.key === key);
  if (!topic) return;

  $('payload').value = JSON.stringify(SAMPLE_PAYLOADS[key] ?? {}, null, 2);

  const meta = $('topic-meta');
  meta.innerHTML = '';
  meta.append(
    `${topic.category} · priority ${topic.priority} · default channels: `,
    topic.defaultChannels.join(', ') || 'none',
    topic.dedupWindowSec > 0 ? ` · dedup window ${topic.dedupWindowSec}s` : '',
  );
}

function bindEvents() {
  $('user-select').addEventListener('change', async (e) => {
    state.userId = e.target.value;
    await refreshAll();
    connectStream();
    await refreshPushStatus();
  });
  $('topic-select').addEventListener('change', onTopicChange);
  $('new-key').addEventListener('click', () => {
    $('idempotency-key').value = `demo-${Date.now().toString(36)}`;
  });
  $('send').addEventListener('click', () => send(false));
  $('send-dup').addEventListener('click', () => send(true));
  $('mark-all-read').addEventListener('click', markAllRead);
  $('refresh-inbox').addEventListener('click', refreshAll);
  $('push-subscribe').addEventListener('click', subscribePush);
  $('push-unsubscribe').addEventListener('click', unsubscribePush);

  $('new-key').click();
}

// ------------------------------------------------------------------ sending

async function send(reuseKey) {
  const result = $('send-result');
  result.hidden = false;
  result.textContent = 'Sending…';

  let data;
  try {
    data = JSON.parse($('payload').value);
  } catch (err) {
    result.textContent = `Payload is not valid JSON: ${err.message}`;
    return;
  }

  if (!reuseKey && !$('idempotency-key').value) {
    $('new-key').click();
  }

  const idempotencyKey = $('idempotency-key').value.trim();

  try {
    const body = await api('/v1/notifications', {
      method: 'POST',
      headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {},
      body: JSON.stringify({ userId: state.userId, topicKey: $('topic-select').value, data }),
    });

    const note =
      body.outcome === 'replayed'
        ? '  <- replayed: same Idempotency-Key, no new send'
        : body.outcome === 'deduplicated'
          ? '  <- deduplicated: identical payload inside the topic dedup window'
          : '';
    result.textContent = JSON.stringify(body, null, 2) + note;

    // Give the outbox relay and workers a moment before reading the trace back.
    setTimeout(refreshAll, 1200);
    setTimeout(refreshAll, 3000);
  } catch (err) {
    result.textContent = `${err.message}\n\n${JSON.stringify(err.body ?? {}, null, 2)}`;
  }
}

// ------------------------------------------------------------------ inbox

async function refreshAll() {
  await Promise.all([refreshInbox(), refreshDeliveries(), refreshPreferences(), refreshOps()]);
}

async function refreshInbox(flashId) {
  if (!state.userId) return;
  const data = await api(`/v1/inbox?userId=${encodeURIComponent(state.userId)}&limit=15`);

  const badge = $('unread-badge');
  badge.hidden = data.unreadCount === 0;
  badge.textContent = String(data.unreadCount);

  const list = $('inbox');
  list.innerHTML = '';

  if (data.items.length === 0) {
    list.appendChild(el('li', 'empty', 'No in-app notifications yet.'));
    return;
  }

  for (const item of data.items) {
    const li = el('li', item.read ? '' : 'unread');
    if (flashId && item.id === flashId) li.classList.add('flash');
    li.appendChild(el('div', 'subject', item.subject || item.topicKey));
    li.appendChild(el('div', 'body', item.body || ''));

    const meta = el('div', 'meta');
    meta.appendChild(el('span', null, item.topicKey));
    meta.appendChild(el('span', null, timeAgo(item.createdAt)));
    li.appendChild(meta);

    li.addEventListener('click', async () => {
      if (item.read) return;
      await api(`/v1/inbox/${item.id}/read`, { method: 'POST' });
      await refreshInbox();
    });

    list.appendChild(li);
  }
}

async function markAllRead() {
  await api(`/v1/inbox/read-all?userId=${encodeURIComponent(state.userId)}`, { method: 'POST' });
  await refreshInbox();
}

// ------------------------------------------------------------------ deliveries

async function refreshDeliveries() {
  if (!state.userId) return;
  const data = await api(`/v1/notifications?userId=${encodeURIComponent(state.userId)}&limit=6`);
  const container = $('deliveries');
  container.innerHTML = '';

  if (data.items.length === 0) {
    container.appendChild(el('div', 'empty', 'No notifications yet — send one above.'));
    return;
  }

  for (const notification of data.items) {
    const full = await api(`/v1/notifications/${notification.id}`);
    container.appendChild(renderNotification(full));
  }
}

function renderNotification(n) {
  const wrap = el('div', 'notif');

  const head = el('div', 'notif-head');
  head.appendChild(el('span', 'topic', n.topic.name));
  const status = el('span', `badge ${statusClass(n.status)}`, n.status);
  head.appendChild(status);
  head.appendChild(el('span', 'id', n.id));
  head.appendChild(el('span', 'id', timeAgo(n.createdAt)));
  wrap.appendChild(head);

  const tableWrap = el('div', 'table-wrap');
  const table = document.createElement('table');
  table.innerHTML =
    '<thead><tr><th>Channel</th><th>Status</th><th>Provider</th>' +
    '<th>Reason</th><th>Events</th></tr></thead>';

  const tbody = document.createElement('tbody');
  for (const delivery of n.deliveries) {
    const tr = document.createElement('tr');

    tr.appendChild(td(delivery.channel));

    const statusCell = document.createElement('td');
    statusCell.appendChild(el('span', `badge ${statusClass(delivery.status)}`, delivery.status));
    tr.appendChild(statusCell);

    tr.appendChild(td(delivery.provider || '—'));
    tr.appendChild(td(delivery.reason || '—', 'reason'));

    const eventsCell = document.createElement('td');
    const events = el('div', 'events');
    for (const event of delivery.events) {
      // `applied: false` marks an out-of-order provider event that the monotonic state machine
      // recorded but refused to apply — the single most useful thing on this screen.
      const ignored = event.payload && event.payload.applied === false;
      const line = el(
        'div',
        null,
        `${new Date(event.occurredAt).toLocaleTimeString()}  ${event.type}${
          ignored ? '  (ignored: out of order)' : ''
        }`,
      );
      if (ignored) line.style.opacity = '0.6';
      events.appendChild(line);
    }
    eventsCell.appendChild(events);
    tr.appendChild(eventsCell);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  wrap.appendChild(tableWrap);
  return wrap;
}

function td(text, className) {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  cell.textContent = text;
  return cell;
}

// ------------------------------------------------------------------ preferences

async function refreshPreferences() {
  if (!state.userId) return;
  const rows = await api(`/v1/preferences?userId=${encodeURIComponent(state.userId)}`);

  const byTopic = new Map();
  for (const row of rows) {
    if (!byTopic.has(row.topicKey)) byTopic.set(row.topicKey, []);
    byTopic.get(row.topicKey).push(row);
  }

  const container = $('preferences');
  container.innerHTML = '';

  for (const [topicKey, channels] of byTopic) {
    const card = el('div', 'pref-topic');
    const heading = el('h4');
    heading.appendChild(el('span', null, channels[0].topicName));
    heading.appendChild(
      el(
        'span',
        `badge ${channels[0].category === 'MARKETING' ? 'badge-warn' : 'badge-muted'}`,
        channels[0].category,
      ),
    );
    card.appendChild(heading);

    const row = el('div', 'pref-channels');
    for (const pref of channels) {
      const wrap = el('div', 'pref-channel');
      wrap.appendChild(el('span', null, pref.channel));

      const select = document.createElement('select');
      for (const [value, label] of [
        ['inherit', `inherit (${pref.default ? 'on' : 'off'})`],
        ['on', 'on'],
        ['off', 'off'],
      ]) {
        const option = el('option', null, label);
        option.value = value;
        select.appendChild(option);
      }
      select.value = pref.override === null ? 'inherit' : pref.override ? 'on' : 'off';

      select.addEventListener('change', async () => {
        const value = select.value;
        await api(`/v1/preferences?userId=${encodeURIComponent(state.userId)}`, {
          method: 'PUT',
          body: JSON.stringify({
            updates: [
              {
                topicKey,
                channel: pref.channel,
                enabled: value === 'inherit' ? null : value === 'on',
              },
            ],
          }),
        });
        await refreshPreferences();
      });

      wrap.appendChild(select);
      row.appendChild(wrap);
    }
    card.appendChild(row);
    container.appendChild(card);
  }
}

// ------------------------------------------------------------------ ops

async function refreshOps() {
  const [breakers, dlq] = await Promise.all([
    api('/v1/ops/circuit-breakers'),
    api('/v1/ops/dlq?limit=5'),
  ]);

  const breakerBox = $('breakers');
  breakerBox.innerHTML = '';
  for (const [provider, breakerState] of Object.entries(breakers)) {
    const row = el('div', 'breaker');
    row.appendChild(el('span', null, provider));
    const cls =
      breakerState === 'closed' ? 'badge-ok' : breakerState === 'open' ? 'badge-bad' : 'badge-warn';
    row.appendChild(el('span', `badge ${cls}`, breakerState));
    breakerBox.appendChild(row);
  }

  const dlqBox = $('dlq');
  dlqBox.innerHTML = '';
  if (dlq.length === 0) {
    dlqBox.appendChild(el('div', 'empty', 'Empty — nothing has exhausted its retries.'));
    return;
  }
  for (const job of dlq) {
    const item = el('div', 'dlq-item');
    item.appendChild(el('div', null, `${job.queue} · ${job.attemptsMade} attempts`));
    item.appendChild(el('div', 'reason', job.failedReason));

    const replay = el('button', 'btn btn-ghost', 'Replay');
    replay.addEventListener('click', async () => {
      await api(`/v1/ops/dlq/${job.id}/replay`, { method: 'POST' });
      await refreshOps();
    });
    item.appendChild(replay);
    dlqBox.appendChild(item);
  }
}

// ------------------------------------------------------------------ SSE

function connectStream() {
  if (state.eventSource) state.eventSource.close();
  if (!state.userId) return;

  const status = $('sse-status');
  // EventSource cannot set headers, which is why the stream route is public and takes the user
  // id as a query param. A real deployment would pass a short-lived signed stream token here.
  const source = new EventSource(`/v1/inbox/stream?userId=${encodeURIComponent(state.userId)}`);
  state.eventSource = source;

  source.onopen = () => {
    status.textContent = 'stream: live';
    status.className = 'badge badge-ok';
  };

  source.onerror = () => {
    status.textContent = 'stream: reconnecting…';
    status.className = 'badge badge-warn';
    // No manual retry needed: EventSource reconnects on its own, which is a large part of why
    // SSE is a better fit here than a raw WebSocket.
  };

  source.onmessage = (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (payload.type === 'ping') return;

    if (payload.type === 'notification') {
      refreshInbox(payload.payload.deliveryId);
      refreshDeliveries();
    } else {
      refreshInbox();
    }
  };
}

// ------------------------------------------------------------------ web push

async function refreshPushStatus() {
  const status = $('push-status');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    status.textContent = 'This browser does not support the Push API.';
    $('push-subscribe').disabled = true;
    return;
  }

  const { configured } = await api('/v1/devices/vapid-public-key');
  if (!configured) {
    status.textContent = 'Server has no VAPID keys — run `npm run keys:vapid` and restart.';
    $('push-subscribe').disabled = true;
    return;
  }

  const registration = await navigator.serviceWorker.getRegistration('/demo/');
  const subscription = registration && (await registration.pushManager.getSubscription());
  status.textContent = subscription
    ? 'Subscribed — PUSH deliveries will reach this browser.'
    : 'Not subscribed. Notification permission is requested on click.';
}

async function subscribePush() {
  const status = $('push-status');
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      status.textContent = `Permission ${permission} — the browser will not deliver push messages.`;
      return;
    }

    // Scope must cover the page; /demo/ is where this app is served from.
    const registration = await navigator.serviceWorker.register('/demo/sw.js', { scope: '/demo/' });
    await navigator.serviceWorker.ready;

    const { publicKey } = await api('/v1/devices/vapid-public-key');
    const subscription = await registration.pushManager.subscribe({
      // Non-negotiable in Chrome: it refuses silent push entirely, so every message must show a
      // visible notification.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    const json = subscription.toJSON();
    await api('/v1/devices', {
      method: 'POST',
      body: JSON.stringify({
        userId: state.userId,
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      }),
    });

    status.textContent = 'Subscribed — send an order.shipped notification to see it fire.';
  } catch (err) {
    status.textContent = `Subscription failed: ${err.message}`;
  }
}

async function unsubscribePush() {
  const registration = await navigator.serviceWorker.getRegistration('/demo/');
  const subscription = registration && (await registration.pushManager.getSubscription());
  if (!subscription) return;

  await api('/v1/devices', {
    method: 'DELETE',
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  });
  await subscription.unsubscribe();
  $('push-status').textContent = 'Unsubscribed.';
}

/**
 * The VAPID public key is base64url text, but `applicationServerKey` requires a Uint8Array of the
 * raw bytes — the browser will not accept the string form.
 */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

init().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Demo init failed', err);
  document.body.prepend(el('div', 'empty', `Demo failed to load: ${err.message}`));
});
