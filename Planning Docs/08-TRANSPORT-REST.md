# 08 — REST Transport

**Component.** The HTTP surface: one contract that the console, the tests and any external
checked-out verifier can rely on. Also serves the built web app.

**Owner files.** `server/src/http/app.ts`, `web/src/lib/api.ts`.

**Rubric.** Architecture 5 % (module separation); Testing 2.5 % (a stable surface to assert
against); Control 30 % (command endpoints and honest error codes).

**Depends on.** `04`, `05`, `06`, `07`, `10`, `11`.

---

## 1. Boundary

In scope: route definitions, request validation, response shaping, error mapping, static file
serving. Out of scope: business rules (each subsystem owns them), and push updates (`09`).

---

## 2. Current foundation

JSON body limit 64 kb, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
`Cache-Control: no-store` on `/api`. Routes: health, services, topology, series, states, range,
targets, alert-limits, researchers, alerts (list/detail/acknowledge/resolve), commands
(list/acks/create), replay (create/play/pause/speed/seek/delete/get). Serves `web/dist` with
an SPA fallback; JSON 404 for `/api`; single error handler.

---

## 3. Additions required by the other documents

| Route | Needed by | Purpose |
| :--- | :--- | :--- |
| `GET /api/health` (extended) | `01` | `ready`, `config` (redacted), ingest counters |
| `GET /api/aggregate` | `04`, `11` | One series across many entities |
| `GET /api/alerts/timeline` | `05`, `07` | Ticks for the scrubber |
| `GET /api/alerts/:id/context` | `05` | The context pack |
| `GET /api/measure/:service/:measure` | `11` | Named derived measure |
| `POST /api/commands/batch` | `06` | Presets, all-or-nothing |
| `GET /api/commands/limits` | `06` | Per-control timeouts, so the UI can show a countdown |
| `GET /api/replay/range` | `07` | What can be replayed |
| `GET /api/replay/:id/alerts` | `07` | Replay-scoped alert lifecycle |
| `GET /api/events` | `07`, `22` | Event list by service/kind/window |
| `GET /api/capabilities/:service` | `12` | Adapter view: focal entities, measures, accents |

---

## 4. Decomposition

### 4.1 Request validation subsystem

#### 4.1.1 Coercion helpers

- **Responsibility.** One place for parsing query strings, so routes stay declarative.
- **Contract.** `qInt(name, { min, max, default })`, `qMs(name)`, `qEnum(name, values)`,
  `qBool(name)`, `qList(name)`. Each throws a `BadRequest` with `{ code, detail }`.
- **Steps.** Reject `NaN`, reject arrays where a scalar is expected, clamp with an explicit
  error rather than silently.
- **Acceptance.** `/api/series?limit=999999` returns 400 `bad_request` naming `limit` and its
  maximum, not a silently clamped 20 000.

#### 4.1.2 Body validation

- **Responsibility.** Reject unknown fields so a typo is not silently ignored.
- **Contract.** Per-route zod schema; unknown keys are an error with the key named.
- **Acceptance.** `POST /api/alerts/:id/acknowledge { researchr: 'x' }` returns 400 naming
  `researchr` and listing `researcher`.

### 4.2 Error contract subsystem

#### 4.2.1 Shape and status

- **Responsibility.** One error shape, one meaning per status.
- **Contract.**
  ```json
  { "error": "<machine_code>", "detail": "<human sentence or null>" }
  ```
  | Status | Meaning | Examples |
  | :--- | :--- | :--- |
  | 400 | the request is malformed | `bad_request`, `invalid_value`, `invalid_researcher`, `invalid_cause` |
  | 403 | authorised but not permitted | `unknown_researcher`, `researcher_not_permitted`, `researcher_defunct` |
  | 404 | no such thing | `unknown_service`, `not_found`, `unknown_alert` |
  | 409 | the state forbids it | `already_acknowledged`, `not_acknowledged`, `already_resolved` |
  | 413 | the result is too big | `window_too_large`, `too_many_rows` |
  | 422 | the entity or control does not exist | `unknown_target`, `unknown_control` |
  | 503 | a dependency is down | `api_unavailable`, `broker_unavailable` |
- **Steps.** Map thrown typed errors in a single handler; log 5xx with the stack, log 4xx at
  `debug`. Never leak a stack or a credential in `detail`.
- **Acceptance.** Every error in the suite has a documented code, and `errorText()` in the
  client renders `code — detail` for all of them.

#### 4.2.2 Service reason passthrough

- **Responsibility.** The service's own vocabulary is the truth for control outcomes.
- **Contract.** Reasons from acks are stored and returned verbatim in `command.reason` and
  `command.detail`; the platform never translates them.
- **Acceptance.** `precondition_failed` from the service is rendered as "precondition_failed"
  with the service's detail, not as "the command failed".

### 4.3 Static serving subsystem

#### 4.3.1 SPA hosting

- **Responsibility.** One process serves the app so the README's start command is enough.
- **Contract.** Serve `web/dist` if present; any non-`/api`, non-`/ws` GET returns
  `index.html`. If `web/dist` is missing, return a 200 page that says "run `npm run build`".
- **Steps.** Hash routing means no server route mapping is needed. Set a 1-hour cache on
  hashed assets and `no-store` on `index.html`.
- **Acceptance.** `npm start` on a clean clone with no build prints the instruction page
  instead of a bare 404.

---

## 5. Surface summary (the contract the console codes against)

```
GET  /api/health                         → { status, ready, broker, store, uptimeS, ingest, config }
GET  /api/services                       → [{ service, version, online, entities, lastTs, describe }]
GET  /api/capabilities/:service          → Capabilities
GET  /api/services/:service/topology     → raw document
GET  /api/services/:service/entities     → [{ id, kind, meta }]
GET  /api/states?service=&entity=&kind=  → latest states
GET  /api/series?service=&stream=&entity=&field=&from=&to=&limit=
GET  /api/aggregate?service=&stream=&field=&from=&to=&bucketMs=&agg=
GET  /api/measure/:service/:measure?from=&to=&entity=
GET  /api/range?services=                → capture window per service
GET  /api/events?service=&kind=&from=&to=&limit=
GET  /api/targets                        → ARL catalogue (cached)
GET  /api/alert-limits/:service          → [{ key, value, unit }]
GET  /api/researchers/:code              → Researcher | 404
GET  /api/alerts?status=&service=&severity=&from=&to=&limit=
GET  /api/alerts/:id                     → AlertRecord + transitions
GET  /api/alerts/:id/context             → AlertContext
GET  /api/alerts/timeline?from=&to=&service=
POST /api/alerts/:id/acknowledge         { researcher, note? }
POST /api/alerts/:id/resolve             { researcher, cause, resolution }
GET  /api/commands?service=&state=&from=&limit=
GET  /api/commands/limits                → { control: timeoutMs }
GET  /api/commands/:id/acks              → [CommandAckRow]
POST /api/commands                       { service, entity, control, value, researcher, request_id? }
POST /api/commands/batch                 { service, researcher, request_id?, commands: [] }
GET  /api/replay                         → ReplaySnapshot[]
POST /api/replay                         { services, from, to, speed }
GET  /api/replay/range?services=
GET  /api/replay/:id
GET  /api/replay/:id/alerts
POST /api/replay/:id/play | /pause | /speed | /seek
DELETE /api/replay/:id
```

---

## 6. Failure modes

| Failure | Behaviour |
| :--- | :--- |
| Unknown `/api` route | JSON 404 `not_found`, never HTML |
| Oversized body | 413 `too_many_rows`, body ignored |
| Handler throws | 500 `internal` with a correlation id in the log, not in the body |
| Store closed during shutdown | 503 `api_unavailable` for the last few hundred ms |
| Slow aggregate | 200 with the result if under 5 s; there is no request timeout by design |

---

## 7. Test plan (supertest, see `51`)

- One test per route asserting shape and the happy path against a seeded DB.
- One test per error code in §4.2.1.
- Contract test: a snapshot of the route table so an accidental rename fails loudly.
- Client-alignment test: every path in `web/src/lib/api.ts` exists in the route table.

---

## 8. Open decisions

- **Versioning.** No `/v1` prefix. This is a single-purpose internal API; the tests are the
  contract.
- **Pagination.** `limit` plus `from`/`to` only. No cursor pagination for the console, because
  the windows are bounded by design.