/**
 * Service worker for Web Push.
 *
 * A service worker is mandatory for web push — the browser will only deliver a push message to a
 * registered worker, because the whole point is that the message arrives when your page is closed.
 * That is also why this file must be served from the site root scope and cannot be inlined.
 */

self.addEventListener('install', (event) => {
  // Take over immediately instead of waiting for existing tabs to close. Fine here; on a real site
  // you would think harder about version skew between an open page and a new worker.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: 'Notification', body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || 'Notification';
  const options = {
    body: payload.body || '',
    // Replaces an earlier notification with the same tag rather than stacking duplicates.
    tag: payload.tag || 'notify',
    renotify: true,
    data: payload.data || {},
    icon: '/demo/icon.png',
    badge: '/demo/icon.png',
  };

  // waitUntil keeps the worker alive until the notification is actually shown. Without it the
  // browser may kill the worker first and the notification silently never appears.
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url;
  const target = url || '/demo/';

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Focus an existing tab if one is already open rather than piling up new ones.
      for (const client of clients) {
        if (client.url.includes('/demo') && 'focus' in client) {
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow(target);
    })(),
  );
});
