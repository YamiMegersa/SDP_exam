# 01 — Platform Runtime

**Component.** Everything that makes the server a process: configuration, boot order,
the simulator clock, the internal event bus, logging, health, and graceful shutdown.

**Owner files.** `server/src/config.ts`, `server/src/index.ts`, `server/src/util/clock.ts`,
`server/src/util/log.ts`, `server/src/platform/bus.ts`, `server/src/platform/events.ts`.

**Rubric.** Architecture 5 % — "starts from the README, configured through the provided
environment variables with no hard-coded credentials, with the code separated into modules".

**Depends on.** Nothing. This is the first thing that loads and the last thing that stops.

---

## 1. Boundary

In scope: the process, its environment, its lifecycle, and the in-process message bus that
every other subsystem talks over. Out of scope: anything that talks to MQTT, SQLite, HTTP
or the browser — those are separate components.

The test for this boundary: if a file could still be correct with MQTT, SQLite and Express
deleted, it belongs here.

---

## 2. Current foundation

- `config.ts` reads `process.env`, applies defaults, collects every missing required key
  and throws one aggregated error at boot. Required: `MQTT_BROKER_ADDRESS`,
  `MQTT_BROKER_PORT`, `ARL_API_ADDRESS`, `ARL_API_PORT`. A minimal `loadDotEnv()` reads
  `.env` without a dependency.
- `index.ts` constructs Store → Bus → SimClock → TopologyRegistry → ArlApi → AlertEngine →
  Ingest → CommandService → ReplayService → Express app → WsHub, then listens and starts
  the hub, alert sweeper, command expirer and ingest.
- `clock.ts` keeps the newest `ts` seen per service and exposes `now()`, `forService(svc)`
  and `known()`.
- `bus.ts` is a synchronous, allocation-light emitter with error isolation.
- Shutdown closes ingest → websocket → http → store.

---

## 3. Gaps

| Gap | Effect | Fix |
| :--- | :--- | :--- |
| No config validation beyond presence | A typo like `PORT=abc` becomes `NaN` and Express throws an opaque error | Typed parsing with per-key coercion and a named failure |
| No readiness vs liveness distinction | `/api/health` says "ok" before MQTT is connected | Split `ready` (broker connected, store writable) from `alive` |
| Shutdown does not flush the ingest batch | Up to 250 ms of telemetry lost on restart | Flush before closing the store |
| No record of which config values were actually used | Impossible to explain a run in the README | Log a redacted config summary at boot |
| Bus has no typed channel list | Handlers can subscribe to a typo and silently never fire | Keep the union type, add a `subscribe` overload per kind |

---

## 4. Decomposition

### 4.1 Configuration subsystem

#### 4.1.1 Environment reader

- **Responsibility.** Turn `process.env` plus `.env` into a frozen, typed object.
- **Contract.** One exported `config` object; no other module reads `process.env`.
- **Steps.**
  1. Parse integers with `parseIntStrict(name, raw)` that throws on `NaN`.
  2. Parse booleans accepting `1/0/true/false/yes/no`.
  3. Parse lists (`ARL_SERVICES`) by splitting on `,`, trimming, lower-casing, rejecting
     unknown service codes against the set `rta|mhe|opg|lwm|owt`.
  4. Parse `DB_PATH` and resolve it against `process.cwd()`; create the parent directory.
  5. Freeze the result.
- **Acceptance.** `PORT=abc npm start` exits non-zero with
  `config: PORT must be an integer, got "abc"`. `ARL_SERVICES=rta,XX` exits naming `XX`.

#### 4.1.2 Secret hygiene

- **Responsibility.** Ensure no credential reaches a log, an error body, or the browser.
- **Contract.** `redactedConfig()` returns the same keys with `MQTT_BROKER_PASSWORD` and
  any key matching `/(SECRET|TOKEN|PASSWORD|KEY)/` replaced by `"***"`.
- **Steps.** Build the redacted view once at boot; log it at `info`. Assert in a unit test
  that the redacted view never contains the raw value.
- **Acceptance.** `51` unit test passes: setting `MQTT_BROKER_PASSWORD=hunter2` never
  produces a log line or JSON body containing `hunter2`.

#### 4.1.3 Boot-order contract

- **Responsibility.** Guarantee that no subscriber exists before its dependency.
- **Order (fixed).**
  1. Config (throws on bad input — fail before opening anything).
  2. Store (opens SQLite, runs migrations — the schema must be current before any write).
  3. Bus, Clock.
  4. TopologyRegistry, rehydrated from stored topology so the first frame after a restart
     is already routable.
  5. ArlApi (no network calls yet; lazily fetches).
  6. AlertEngine, CommandService, ReplayService (they register bus handlers).
  7. Ingest (connects to the broker — last, because connecting triggers retained-message
     storms that must land on a fully wired bus).
  8. HTTP + WS listen, then start the hub and sweepers.
- **Acceptance.** Restarting the server with services running produces `hello` frames that
  already contain topology and states, with no `unknown service` log lines.

### 4.2 Simulator clock subsystem

#### 4.2.1 Per-service skew tracking

- **Responsibility.** Answer "what time is it for this service?" when the three services
  run at different speedups or one is stopped.
- **Contract.** `observe(service, ts)` updates a max; `forService(service)` returns that
  max or `Date.now()` if the service has never been seen; `now()` returns the newest across
  services, falling back to wall clock.
- **Steps.** Ignore `ts` older than what is already stored (out-of-order retained messages
  arrive with old `ts`). Never let `forService` go backwards within a session.
- **Acceptance.** With RTA at 1× and MHE at 2000×, the header clock follows the fastest
  service and each service page stamps its own values with its own clock.

#### 4.2.2 Clock exposure to the client

- **Responsibility.** The browser must never compute "now" from `Date.now()` for display.
- **Contract.** Every WS `hello` and every coalesced frame carries `simTime`; the client
  store exposes `live.simTime`.
- **Acceptance.** With `ARL_START_TIME=2027-03-02T08:00:00+02:00` the console header shows
  2027, not the host date.

### 4.3 Event bus subsystem

#### 4.3.1 Topic registry

- **Responsibility.** A single, typed, synchronous fan-out for platform events.
- **Contract.** `PlatformEvent` union already covers `telemetry | state | event | alert |
  command | topology | service | broker | ingest`. `on(kind, handler)` returns an
  unsubscribe function.
- **Steps.** Keep synchronous delivery (no promises) so ordering is deterministic; wrap each
  handler in try/catch and log the failure with the event kind and a sample of the payload;
  cap the logged payload to 512 bytes.
- **Acceptance.** A handler that throws does not stop the next handler, and the ingest flush
  continues.

#### 4.3.2 Handler budget

- **Responsibility.** Nothing on the hot path may block the ingest loop.
- **Contract.** Handlers must not do synchronous I/O. Anything expensive (an ARL API call,
  a replay chunk read) is queued off-bus.
- **Steps.** Add a dev-only assertion that a bus handler returns within 2 ms, logged once
  per 60 s with the offending handler name.
- **Acceptance.** At 90 messages/s (RTA scanning) the ingest loop keeps up with zero queue
  growth on the MQTT client.

### 4.4 Observability subsystem

#### 4.4.1 Structured log

- **Responsibility.** One line per event, greppable, with a stable prefix.
- **Contract.** `log.info(area, message, fields?)`. Areas: `boot`, `config`, `mqtt`, `ingest`,
  `db`, `alerts`, `cmd`, `replay`, `http`, `ws`, `api`.
- **Steps.** Emit ISO timestamps from wall clock (logs describe the process, not the sim).
  Include `service` and `entity` where known. Never log a full telemetry payload at `info`.
- **Acceptance.** `journalctl`-style filtering by area works; no log line exceeds 2 KB.

#### 4.4.2 Health and readiness

- **Responsibility.** Let the README's run instructions be verifiable, and let the UI show
  honest platform state.
- **Contract.**
  - `GET /api/health` → `{ status: 'ok'|'degraded', broker, store, uptimeS, version, config }`
    where `config` is the redacted summary.
  - `ready` is true only when `broker === true` and a write to SQLite has succeeded since
    boot.
- **Steps.** Track a `wroteOnce` flag set by the store after the first successful batch.
  Return HTTP 200 for `ok` and `degraded`, 503 only when `ready === false` (used by the
  README's curl check).
- **Acceptance.** Starting the server with the broker down shows `degraded`, `broker:false`,
  and a visible red broker LED in the header; starting it with the broker up flips to `ok`
  within 2 s.

#### 4.4.3 Ingest counters

- **Responsibility.** Make data loss visible rather than silent.
- **Contract.** Counters `{ messages, batches, rows, gaps, dropped, reconnects, lastRecvTs }`
  exposed on `/api/health` and broadcast in the WS hello.
- **Acceptance.** Triggering a broker restart increments `reconnects` and the footer's gap
  counter stays at whatever the real `seq` discontinuity was.

### 4.5 Lifecycle subsystem

#### 4.5.1 Graceful shutdown

- **Responsibility.** No data loss and no half-open sockets on `SIGINT`/`SIGTERM`.
- **Order (fixed).** 1) stop accepting new HTTP, 2) end the MQTT client (flush its queue
  first with a 2 s cap), 3) flush the pending ingest batch, 4) close WS clients with code
  1001, 5) close the SQLite handle, 6) exit 0.
- **Steps.** Add a 5 s watchdog that forces exit with a logged warning if any step hangs.
  Ignore a second signal after the first so a double Ctrl-C does not corrupt the DB.
- **Acceptance.** Killing the server mid-scan and restarting loses zero rows that were in a
  completed batch; `data/arl.sqlite-wal` is empty after shutdown.

#### 4.5.2 Restart continuity

- **Responsibility.** A restart must not look like a service outage to the operator.
- **Steps.** On boot, load the last topology per configured service from the store so
  `hello` is complete. Mark services offline only when their retained `state/online` says
  false, or when the silence sweeper fires after the grace period — not merely because the
  platform restarted.
- **Acceptance.** Restarting the platform during a run does not raise `service_offline` for
  services that never stopped.

---

## 5. Failure modes

| Failure | Detected by | Behaviour |
| :--- | :--- | :--- |
| Missing required env | Config throw | Exit 1 with all missing keys listed at once |
| Unparseable integer | Config throw | Exit 1 naming the key and the raw value |
| Port already in use | `listen` error | Exit 1 with the port number; do not retry |
| SQLite locked by another process | `busy_timeout` then error | Log, retry the batch once, then `degraded` |
| Broker never connects | `broker:false` after 10 s | Keep running, `degraded`, keep retrying every 2 s |
| Handler throws on the hot path | Bus isolation | Log with event kind, drop that handler's effect only |

---

## 6. Test plan (see `51`)

- Unit: config coercion for every key, including three bad values per numeric key.
- Unit: `redactedConfig` never contains a secret.
- Unit: `SimClock` monotonicity across out-of-order observations.
- Unit: bus isolation — a throwing handler does not prevent delivery.
- Integration: boot with broker down → `/api/health` is `degraded`, then up → `ok`.
- Integration: `SIGTERM` during a scan flushes the pending batch.

---

## 7. Open decisions

- **Do we keep `loadDotEnv()` or add `dotenv`?** Keep. Zero dependencies, and the README
  documents `.env.example`, so behaviour is explicit.
- **Is `zod` used here?** Use it only in `02` for `$topology` shape validation. Config
  parsing stays hand-rolled so the error messages stay actionable.