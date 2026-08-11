# Notification System

A multi-channel notification service built to learn the patterns real ones use — not a toy that
just calls an email API. Email (Resend), in-app with live SSE, Web Push, Slack and SMS, behind a
single `POST /v1/notifications`.

**Stack:** NestJS 10 · TypeScript · Prisma/Postgres · BullMQ/Redis · Winston · Prometheus · Swagger

---

## Quick start

```powershell
docker compose up -d          # redis + mailhog (see the note on Postgres below)
copy .env.example .env
npm install
npm run prisma:migrate
npm run prisma:seed           # 6 topics, 18 templates, 2 users, 1 API key
npm run dev
```

Then open:

| URL | What |
|---|---|
| http://localhost:3000/demo | Demo UI — trigger notifications and watch the pipeline |
| http://localhost:3000/docs | Swagger |
| http://localhost:8025 | MailHog — every email sent via the SMTP fallback lands here |
| http://localhost:3000/health | Postgres, Redis and per-channel provider status |
| http://localhost:3000/metrics | Prometheus |
| http://localhost:8081 | Redis Commander — inspect the queues |

Nothing above needs a single third-party account. Email goes to MailHog, SMS to a mock provider,
and push/Slack report themselves unconfigured and get `SKIPPED`. Add credentials to enable each.

> **Postgres is not in docker-compose.** This machine already runs a local PostgreSQL 18 service on
> 5432 alongside other project databases, and publishing a container on the same host port makes
> which server you reach ambiguous. `DATABASE_URL` points at the local instance. To containerise it,
> add a service on host port **5433** and update `DATABASE_URL` — do not reuse 5432.

### Fire your first notification

```bash
curl -X POST http://localhost:3000/v1/notifications \
  -H "x-api-key: dev-key-please-change" \
  -H "content-type: application/json" \
  -H "Idempotency-Key: demo-1" \
  -d '{"userId":"<alice-id>","topicKey":"order.shipped",
       "data":{"orderId":"A-1001","carrier":"DHL","trackingNumber":"TRK123"}}'
```

Returns `202 Accepted` immediately. `GET /v1/notifications/<id>` then shows one row per channel with
its status, provider and full event timeline.

---

## Architecture

```
                        ┌──────────────────────────────────────────────┐
  demo UI / curl ─────► │  API  (NestJS HTTP)                          │
                        │  POST /v1/notifications   (Idempotency-Key)  │
                        │  GET  /v1/notifications/:id   ← trace view    │
                        │  GET  /v1/inbox  +  /v1/inbox/stream (SSE)   │
                        │  POST /v1/webhooks/resend   (svix-signed)    │
                        └───────────────┬──────────────────────────────┘
                                        │ ONE Postgres transaction
                                        ▼
                     Notification(PENDING) + OutboxEvent(notification.created)
                                        │
                          Outbox relay (poll 500ms, FOR UPDATE SKIP LOCKED)
                                        ▼
                              ┌───────────────────┐
                              │ queue: dispatch   │
                              └─────────┬─────────┘
                                        ▼
   ┌──────────────────────── Dispatch worker (fan-out) ────────────────────────┐
   │ resolve recipient → resolve channels (topic ∩ prefs − unsubscribe)        │
   │ → suppression check → dedup window → quiet hours → digest bucket          │
   │ → one Delivery row per channel → enqueue one job per sendable channel     │
   └───────┬──────────┬──────────────┬──────────────┬──────────────┬──────────┘
           ▼          ▼              ▼              ▼              ▼
    channel-email  -push        -inapp         -slack          -sms
           │          │              │              │              │
   ┌───────▼──────────▼──────────────▼──────────────▼──────────────▼────────┐
   │ Channel worker:  render → rate-limit → circuit breaker                 │
   │                  → ChannelProvider.send() → Delivery.SENT + msgId      │
   │ retryable error → BullMQ backoff (exp + full jitter, 5 attempts) → DLQ │
   │ permanent error → FAILED immediately, no retry, no failover            │
   └───────┬────────────────────────────────────────────────────────────────┘
           │                                     ▲
           ▼                                     │ email.delivered / bounced /
   Resend → SMTP fallback · web-push ·           │ opened / clicked / complained
   Slack · Twilio|MockSms · DB+SSE ─────────────┘  (POST /v1/webhooks/resend)
```

---

## The patterns, and why each is there

| Pattern | Where | Why it exists |
|---|---|---|
| **Accept-then-process** (`202`) | `notifications.controller.ts` | The API stays fast and a provider outage never fails the caller |
| **Idempotency keys** | `notifications.service.ts` | Producers retry on timeout. The stored response is replayed verbatim so a retry is indistinguishable from the original call |
| **Content dedup** | `stableStringify` | Catches the same event fired twice with *different* idempotency keys. Keys are sorted before hashing — `JSON.stringify` is not canonical |
| **Transactional outbox** | `outbox.relay.ts` | Committing then calling `queue.add()` loses the job if the process dies in between. The outbox row is written in the same transaction, so either both exist or neither does |
| **`FOR UPDATE SKIP LOCKED`** | `outbox.relay.ts` | Lets every instance run a relay concurrently without two of them claiming the same event |
| **Queue per channel** | `queue.constants.ts` | A Slack hook limited to ~1 msg/sec must not starve email. Also gives per-channel concurrency and rate limits |
| **Retryable vs permanent errors** | `provider.errors.ts` | The single most important call in the worker path. Retrying a bad address burns quota; *not* retrying a 429 silently drops a notification |
| **Jittered backoff** | `queue/backoff.ts` | Plain exponential backoff synchronises retries — 500 failed jobs all retry at t+1s and re-kill the recovering provider |
| **Circuit breaker** | `circuit-breaker.service.ts` | Retries are per-job; the breaker is per-provider. State lives in Redis so all workers share one view. Half-open lets exactly **one** probe through via `SET NX` |
| **Provider failover** | `base-channel.processor.ts` | Resend → SMTP. Only on *retryable* errors: a permanently invalid address fails identically everywhere |
| **Dead-letter queue** | `dlq.listener.ts` | BullMQ has none — failed jobs just sit in the `failed` set. Replay is deliberately manual |
| **Monotonic status** | `delivery-status.ts` | Provider webhooks arrive out of order. `email.sent` routinely lands *after* `email.delivered`; a naive UPDATE would regress a delivered email |
| **Webhook idempotency** | `webhooks.service.ts` | `svix-id` is the primary key of `webhook_events`. Providers retry webhooks aggressively; double-processing `email.opened` corrupts engagement counts |
| **Tri-state preferences** | `channel-resolver.service.ts` | `enabled` is a *nullable* boolean. Collapsing "unset" into "off" means changing a topic default silently overrides real user choices |
| **Suppression list** | `suppression.service.ts` | A hard bounce means "never try this address again". Mailing bouncing addresses is what gets a sending domain throttled |
| **Skip ≠ suppress** | `dispatch.processor.ts` | `SKIPPED` = nowhere to send (no phone number). `SUPPRESSED` = we chose not to. Every non-send records a reason — a silent drop is unsupportable |
| **Digest batching** | `digest.service.ts` | Forty "you were mentioned" emails in an hour is worse than none. Items are stored pre-rendered, because templates are versioned |
| **Repeatable jobs, not `@Cron`** | `digest.processor.ts` | `@Cron` fires on *every* instance — three replicas would send three copies of each digest |
| **Correlation IDs** | `correlation.store.ts` | AsyncLocalStorage carries one id from the HTTP request through the outbox, the dispatch job, each channel worker, and the webhook that arrives minutes later |

### Delivery state machine

```
QUEUED(0) → RENDERED(1) → SENT(2) → DELIVERED(3) → OPENED(4) → CLICKED(5)

side exits:  SKIPPED / SUPPRESSED (10)  ·  FAILED (11)  ·  BOUNCED (12)  ·  COMPLAINED (13)
```

A status is written only when `rank(next) > rank(current)`. Terminal outcomes sit above every
in-flight state, so a late `email.delivered` can't undo a bounce. `FAILED` is the one asymmetric
case — it can go back to `SENT`, because a DLQ replay can succeed.

Rejected transitions are still appended to `delivery_events` with `applied: false`. Knowing a late
webhook arrived *and was correctly ignored* is exactly what you need when reconstructing an incident.

---

## Provider notes

### Email — Resend

Free tier: 100/day, 3,000/month, **10 requests/second per team** (hence the email queue's
`limiter: { max: 8, duration: 1000 }` — a per-process limiter would not hold across instances).

`PROVIDER_MODE=sandbox` rewrites recipients to Resend's test addresses so the bounce and complaint
paths are exercisable without touching a real inbox or accruing bounces against a real domain:

| Address | Outcome |
|---|---|
| `delivered@resend.dev` | accepted and delivered |
| `bounced@resend.dev` | hard bounce (SMTP 550) |
| `complained@resend.dev` | delivered, then marked as spam |

Any address containing `bounce` routes to the bounce address, `complain`/`spam` to the complaint
one, everything else to `delivered` — so you can force an outcome from the demo UI.

**Webhooks** are signed with [svix](https://docs.svix.com): `svix-id`, `svix-timestamp`,
`svix-signature`, verified against the **raw request body** (see the scoped `express.raw` middleware
in `main.ts` — a re-serialised body never matches). Handled events: `email.sent`, `delivered`,
`delivery_delayed`, `opened`, `clicked`, `bounced`, `complained`, `failed`.

For local webhooks you need a tunnel:

```bash
cloudflared tunnel --url http://localhost:3000     # or: ngrok http 3000
# paste <public-url>/v1/webhooks/resend into https://resend.com/webhooks
```

Or skip the tunnel entirely — `POST /v1/webhooks/resend/simulate` injects an event directly
(dev-only, gated by `WEBHOOK_ALLOW_UNSIGNED`, and `env.validation.ts` refuses to boot with that
enabled in production).

### Web Push — VAPID

Free and vendor-free. `npm run keys:vapid`, paste the output into `.env`, restart, then click
*Enable browser notifications* in the demo UI. Regenerating the keys invalidates every existing
subscription. `404`/`410` from a push service means the subscription is permanently gone and the
device row is disabled.

### Slack / SMS

Slack is an incoming webhook (`SLACK_WEBHOOK_URL`) using Block Kit — note Slack's own dialect:
`<url|label>`, not markdown. SMS defaults to a mock provider that does real work: E.164 validation,
GSM-7 vs UCS-2 segment counting (one emoji drops the per-segment budget from 160 to 70 and multiplies
the bill), and a deterministic failure hook — **any number ending `0000` always fails retryably**, so
you can drive the retry → breaker → DLQ path on demand. `SMS_PROVIDER=twilio` switches to Twilio.

---

## Templates

Stored in the database, versioned per `(topicKey, channel, locale, version)`. Email bodies are
**MJML**, compiled to HTML first, then **Handlebars** runs over the result — that order matters, so
producer data never reaches the MJML compiler. Locale falls back to `en` rather than failing: a
wrong language beats silence.

Preview without sending:

```bash
curl -X POST http://localhost:3000/v1/templates/order.shipped/preview \
  -H "x-api-key: dev-key-please-change" -H "content-type: application/json" \
  -d '{"channel":"EMAIL","data":{"orderId":"A-1","carrier":"DHL","trackingNumber":"T1"}}'
```

> ### Gotcha worth knowing
>
> **Handlebars block helpers between MJML components must be wrapped in `<mj-raw>`.**
>
> MJML only keeps text inside a component's *content*. A bare `{{#each items}}` sitting between two
> `<mj-text>` elements is a text node child of `<mj-column>` and is silently discarded — so the loop
> body renders once with every variable blank, and an `{{#if url}}`-guarded button renders
> unconditionally with `href=""`. Nothing throws.
>
> Related: never write an angle-bracketed tag name inside a `{{!-- comment --}}`. The HTML parser
> runs first and reads it as real markup; if it names the component it sits inside, the real closing
> tag closes the phantom element and every following sibling is absorbed and deleted.
>
> `assertDirectivesSurvived()` in `template.service.ts` compares directive counts either side of
> compilation and throws, turning both silent corruptions into a loud error. `template.service.spec.ts`
> asserts it for every seeded email template.

---

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/notifications` | Enqueue. `Idempotency-Key` header strongly recommended |
| GET | `/v1/notifications/:id` | Trace: notification + deliveries + events |
| GET | `/v1/notifications` | List with per-channel status summary |
| GET | `/v1/inbox` | In-app feed, cursor-paginated, with unread count |
| POST | `/v1/inbox/:id/read`, `/v1/inbox/read-all` | Mark read |
| GET | `/v1/inbox/stream` | **SSE** live feed |
| GET/PUT | `/v1/preferences` | Matrix of default / override / effective per topic × channel |
| GET | `/unsubscribe?token=` | One-click opt-out (HMAC-signed, no auth) |
| POST/DELETE/GET | `/v1/devices` | Web Push subscriptions |
| GET | `/v1/topics`, `/v1/templates`, `POST /v1/templates/:key/preview` | Registry + preview |
| GET/POST/DELETE | `/v1/suppressions` | Do-not-contact list |
| GET/POST | `/v1/digests`, `/v1/digests/flush` | Inspect and force-flush digest buckets |
| GET/POST/DELETE | `/v1/ops/dlq`, `/v1/ops/dlq/:id/replay` | Dead letters |
| GET/POST | `/v1/ops/circuit-breakers`, `/:provider/reset` | Breaker state |
| POST | `/v1/webhooks/resend` | Provider callbacks (signature-verified, not API-key'd) |
| GET | `/health`, `/metrics`, `/docs` | Ops |

Auth is `x-api-key` (SHA-256 hashed `ApiKey` rows) on `/v1/*`. Webhooks, `/unsubscribe`, `/health`,
`/metrics` and the SSE stream are `@Public()` — each for a specific reason documented at the route.

---

## Queue topology

| Queue | Concurrency | Limiter | Note |
|---|---|---|---|
| `dispatch` | 10 | — | fan-out only, no network I/O |
| `channel-email` | 5 | 8/sec | under Resend's 10 rps team cap |
| `channel-push` | 20 | — | prunes `404`/`410` endpoints |
| `channel-inapp` | 20 | — | DB write + SSE publish |
| `channel-slack` | 5 | 1/sec | Slack's per-hook limit |
| `channel-sms` | 5 | 5/sec | mock by default |
| `digest` | 2 | — | repeatable: hourly + daily |
| `maintenance` | 1 | — | daily retention prune |
| `dlq` | 1 | — | `attempts: 1`, never auto-retried |

Queue names use hyphens, not colons — BullMQ reserves `:` as its Redis key separator and rejects
both queue names and custom job ids containing it.

---

## Verifying it works

```bash
npm run lint          # eslint
npm test              # 87 unit tests
npm run test:e2e      # 26 e2e tests against real Postgres + Redis (needs a seeded DB)
```

The e2e suite deliberately runs the real queues rather than mocking them, because the things most
likely to break — the outbox relay's timestamp comparison, BullMQ's job-id constraints, status
transitions under concurrency — only fail against real infrastructure.

Manual walkthrough, all from the demo UI at `/demo`:

1. Send `order.shipped` → five delivery rows appear, each with a status and reason.
2. Click **Re-send same key** → `outcome: "replayed"`, no second notification.
3. Send the identical payload with a *new* key inside 300s → `outcome: "deduplicated"`.
4. Toggle email **off** for a topic → next send shows `SUPPRESSED (preference)`.
5. Set a user's phone to one ending `0000` and send SMS-only → watch 5 jittered retries, the breaker
   trip at 5 failures, and the job land in the DLQ. Reset the breaker, fix the number, hit **Replay**
   → `FAILED` becomes `SENT` and the parent rolls up to `COMPLETED`.
6. Set the newsletter to a **daily** digest, send three → all `SUPPRESSED (batched into daily
   digest)`, then `POST /v1/digests/flush` produces one summary email.
7. Simulate an out-of-order webhook and watch it be recorded but ignored:

```bash
MID=<providerMessageId from the trace>
for T in email.delivered email.opened email.sent; do
  curl -s -X POST http://localhost:3000/v1/webhooks/resend/simulate \
    -H "content-type: application/json" \
    -d "{\"type\":\"$T\",\"created_at\":\"$(date -u +%FT%TZ)\",\"data\":{\"email_id\":\"$MID\",\"to\":[\"alice@example.com\"]}}"
done
# status stays OPENED; the late email.sent is stored with applied: false
```

---

## Layout

```
src/
  config/            typed config + fail-fast env validation
  common/            auth guard · correlation (AsyncLocalStorage) · error taxonomy · filters
  prisma/  redis/    infrastructure
  queue/             topology, job types, jittered backoff strategy
  modules/
    notifications/   ingest: idempotency, validation, transaction + outbox
    outbox/          relay poller (SKIP LOCKED)
    dispatch/        fan-out · channel resolver · quiet hours
    deliveries/      monotonic state machine + parent status rollup
    channels/
      shared/        ChannelProvider interface · base processor · breaker · DLQ
      email/ push/ inapp/ slack/ sms/
    templates/  topics/  preferences/  suppression/  digest/
    webhooks/  recipients/  maintenance/  health/  metrics/
public/              demo UI (no build step) + service worker
prisma/              schema.prisma · migrations · seeds
test/                e2e suite
```

Adding a channel means writing one `ChannelProvider` and one processor that lists it — nothing in
the dispatch path changes.

---

## Deliberately out of scope

No multi-tenancy, no admin template editor, no analytics warehouse. Recipient data lives in this
service's own `User` table; a real deployment would sync it from the identity service. SMS is mocked
unless you add Twilio credentials, so the project costs nothing to run.
