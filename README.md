# ARL Operations Platform — COMS3011A SDP Exam 2026

A web-based monitoring, alerting and replay platform for the Astro-Research Laboratory (ARL) near
Carnarvon, Northern Cape. It ingests live telemetry from three laboratory services over MQTT,
persists it, visualises it, raises and manages alerts, and replays captured history.

This README is the single entry point for the project **and the live progress tracker** for the exam.
Decisions, decision changes, implemented features, known bugs and open questions are recorded here as
they happen (see [Progress Log](#progress-log) and [Decision Register](#decision-register)).

> Running the ARL sim locally: see [Running Locally](#running-locally).
> Running the platform: see [Running the Platform](#running-the-platform).
> Running the tests: see [Testing](#testing).

---

## Scope

The exam requires three of the five ARL services. **Selected:**

| Slot | Weight | Service | Code | Status |
| --- | --- | --- | --- | --- |
| Required | 30% | Radio Telescope Array | `rta` | Planned |
| Best of MHE / LWM | 17.5% | Mars Habitation Experiment | `mhe` | Planned |
| Best of OPG / OWT | 17.5% | On-demand Power Generation | `opg` | Planned |
| Platform | 10% | Alert system (annunciator + audit) | — | Planned |
| Platform | 10% | Replay system | — | Planned |
| Platform | 5% | Architecture | — | In progress |
| Platform | 5% | Security | — | Planned |
| Platform | 2.5% | UI / UX | — | Planned |
| Platform | 2.5% | Testing | — | Planned |

Implementation order: **RTA → OPG → MHE**. The shared shell (ingestion, persistence, alerts, replay,
websocket push) is built first and is generic; each service then plugs in.

Rationale for order: the RTA is the required 30% and carries the highest data rate and the hardest
visualisation (2D scan reconstruction), so it drives the architecture. OPG is the sparsest and
cheapest service (4 entities, 1 message/minute, 6 controls) and validates that the shared shell really
is generic before spending time on MHE's larger alert and control surface.

Non-goals (explicitly out of scope per the brief): authentication of researchers, fixing the lab's
weak security, and the two unselected services.

---

## Chosen Stack

| Layer | Choice | Rationale |
| --- | --- | --- |
| Language | Node.js + TypeScript | One language and one set of types shared between server and browser; non-blocking I/O suits high-rate streams (RTA peaks near 90 msg/s). |
| HTTP framework | Express | Thin routing for control dispatch, researcher authorisation and replay range queries. |
| MQTT client | `mqtt` (mqtt.js) | Automatic reconnect, configurable backpressure queue, wildcard subscriptions for dynamic topic discovery. |
| Persistence | SQLite via `better-sqlite3` | Embedded, zero daemon (no Docker needed to run the platform). WAL mode + batched transactions give high write throughput without blocking the event loop. |
| Server→browser push | `ws` (WebSocket) | Low-overhead push of ingested deltas and alert transitions straight to the operator UI. |
| ARL API client | `axios` | Promise-based HTTP for researcher verification, target catalogue and alert limits. |
| UI | React + TypeScript + Vite | Fast builds/HMR, component isolation, dense operator UI. |
| Styling / graphics | Tailwind CSS, Lucide icons, HTML5 Canvas | Tailwind for dense operator layouts (status LEDs, split grids, always-visible annunciator); Canvas for pixel-level scan rasters and spatial maps without DOM overhead. |

---

## Architecture

Single deployment: one Node process serves the JSON/WebSocket API and the built SPA.

```
                        +---------------------------+
                        |   Browser (React SPA)     |
                        |  services · annunciator   |
                        |  replay · controls        |
                        +------+------------+-------+
                     REST  |            |  WebSocket (deltas)
                           v            v
+-----------------------------------------------------------------------+
|  Node / TypeScript server                                             |
|                                                                       |
|  config.ts        env only, no hard-coded credentials                 |
|  topology.ts      retained $topology per service -> entity/stream      |
|                   /state/event/control registry (drives everything)    |
|  mqtt/ingest.ts   wildcard subs per service, reconnect, seq-gap check  |
|  services/*       per-service adapters (presentation + transforms)     |
|  db/              SQLite WAL: batch writer, queries, migrations       |
|  alerts/engine.ts service alerts + platform alerts, lifecycle, audit   |
|  commands/        researcher verify (ARL API) -> publish -> await ack  |
|  replay/          range queries over captured data + virtual clock     |
|  http/            REST + static SPA + WebSocket broadcaster           |
+-------------------+---------------------+-----------------------------+
                    |                     |
          MQTT (sub/pub)            HTTP (axios, cached)
                    v                     v
        +---------------------+   +--------------------+
        |  ARL MQTT broker    |   |  ARL API /v1       |
        |  arl/<svc>/#         |   |  researchers       |
        +---------------------+   |  targets           |
                                  |  alert-limits      |
                                  +--------------------+
```

### Data flow

1. `topology.ts` subscribes to `arl/<svc>/$topology` (retained) for each configured service and builds a
   registry of entities, streams (with field names, types, units, periods), state items, event kinds and
   controls. **The registry drives ingestion, validation, rendering and control UI generation** — adding a
   device needs no ingestion change.
2. Ingest subscribes to `arl/<svc>/<entity>/telemetry/<stream>`, `arl/<svc>/<entity>/state/<item>`,
   `arl/<svc>/events/<kind>` and `arl/<svc>/ack/<command_id>`.
3. Messages are validated against the registry, stamped with both the envelope `ts` (simulated time) and
   the local receive time, then queued.
4. A batch writer flushes the queue to SQLite in one transaction (bounded by count and elapsed time), so
   burst rates do not translate into one transaction per message.
5. Deltas are pushed over WebSocket to the browser; alert events additionally go through the alert engine
   before broadcast.
6. Controls: the browser posts `{service, entity, control, value, researcher}`; the server verifies the
   researcher code against the ARL API (cached), publishes to `arl/<svc>/cmd/<entity>/<control>` with a
   freshly generated `command_id`, and correlates the resulting ack stream back to the UI.

### Time handling (important)

Envelope `ts` is **simulated** time and is the only clock used for ordering, charting and replay. Wall
clock is stored separately (`recv_ts`) and used only for ingestion health (gap detection, staleness).
This keeps replay correct when the sim runs at `ARL_SPEEDUP` > 1 and when services replay buffered
samples (`backfill: true`) out of order.

### Persistence model (SQLite, WAL)

| Table | Purpose |
| --- | --- |
| `service` | Per-service `online` state, last message, last topology version. |
| `topology` | Latest `$topology` JSON per service (versioned). |
| `entity` | Entity ids, kinds and metadata (from `$topology`). |
| `telemetry` | `(service, entity, stream, ts, seq, data JSON, recv_ts)`; indexed for entity/stream/time range scans. |
| `state_change` | History of retained state items `(service, entity, item, ts, value)`. |
| `event` | Non-alert events (scan lifecycle, EVA, survey, refuel, backwash, lightning). |
| `alert` | One row per `alert_id`: type, severity, raised/cleared times, ack and resolve times **and researchers**, cause, resolution note. |
| `alert_transition` | Append-only audit of every alert transition (raised, escalated, cleared, acknowledged, resolved). |
| `command` | One row per `command_id`: control, value, researcher, sent time, terminal state, reason, detail. |
| `command_ack` | Append-only ack log (accepted → in_progress → completed/failed, progress). |
| `ingest_gap` | Detected `seq` discontinuities and heartbeat staleness per topic. |
| `researcher_cache` | Verified researcher codes with TTL and their permitted services. |

---

## MQTT contract (identical for every service)

```
arl/<svc>/$topology                 retained — machine-readable schema of the whole service
arl/<svc>/<entity>/telemetry/<st>   periodic measurements, envelope {v, ts, seq, entity}
arl/<svc>/<entity>/state/<item>     retained, {v, ts, entity, item, value}
arl/<svc>/events/<kind>             one-off events, including <kind> = alert
arl/<svc>/cmd/<entity>/<control>    platform -> service, {command_id, researcher, value}
arl/<svc>/ack/<command_id>          service -> platform, state/progress/reason/detail
```

- `null` measurements mean "could not be taken" and must not be charted as zero.
- `seq` is per-topic and restarts with the service; **gaps are recorded, not silently dropped**.
- Every service publishes `state/online` (last-will) and `state/active_alerts`.
- Alerts: `alert_id` is stable across escalation; `state` is `raised` or `cleared`; thresholds come from
  `GET /v1/alert-limits/<service>`, which is the single source of truth.

---

## Configuration

Everything is configured through environment variables. No credentials are committed.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `MQTT_BROKER_ADDRESS` | yes | — | MQTT broker host. |
| `MQTT_BROKER_PORT` | yes | — | MQTT broker port. |
| `MQTT_BROKER_USER` | no | empty | Broker username (anonymous when empty). |
| `MQTT_BROKER_PASSWORD` | no | empty | Broker password. |
| `ARL_API_ADDRESS` | yes | — | ARL API host. |
| `ARL_API_PORT` | yes | — | ARL API port. |
| `ARL_SERVICES` | no | `rta,mhe,opg` | Services to ingest. |
| `PORT` | no | `3000` | Platform HTTP/WebSocket port. |
| `DB_PATH` | no | `./data/arl.sqlite` | SQLite file. |
| `ARL_API_TIMEOUT_MS` | no | `5000` | ARL API request timeout. |
| `RESEARCHER_CACHE_TTL_S` | no | `60` | Researcher verification cache TTL. |
| `TELEMETRY_BATCH_MS` | no | `250` | Max delay before a batch flush. |
| `TELEMETRY_BATCH_ROWS` | no | `1000` | Max rows per batch flush. |

---

## Running Locally

### 1. The ARL simulator

The bundle unpacks to `arl-sim/` (`arl-test.yaml`, `config/*.toml`, `scenarios/`, `mosquitto/`,
`images/*.tar`, `bin/arl-*`). It needs an MQTT broker (Mosquitto), the ARL API and PostgreSQL for the
API's own store.

With Docker (the documented path):

```bash
cd arl-sim
docker load -i images/arl-api.tar          # and arl-rta, arl-mhe, arl-opg as needed
docker compose -f arl-test.yaml up -d api rta mhe opg
docker compose -f arl-test.yaml ps
```

With Podman (this machine has no Docker):

```bash
cd arl-sim
podman load -i images/arl-rta.tar          # etc.
podman-compose -f arl-test.yaml up -d api rta mhe opg
```

Useful knobs (prefix any of the commands above):

```bash
ARL_SPEEDUP=10 ARL_SEED=7 ARL_SCENARIO=/scenarios/example.toml \
  docker compose -f arl-test.yaml up -d rta
```

`ARL_SPEEDUP` caps: RTA 50, MHE 2000, LWM/OPG/OWT 500. Scenario faults are the way to exercise every
alert rule.

### 2. The platform

```bash
npm install
cp .env.example .env        # fill in broker and API details
npm run dev                 # server + web dev server
```

Production-style single process (server also serves the built SPA):

```bash
npm run build
npm start
```

---

## Running the Platform

After `npm run build && npm start`, open `http://localhost:3000`.

The platform does **not** authenticate users. Selecting a researcher code in the header is an
*identity for control actions*, not a login: monitoring, alerts and replay are visible to everyone;
control actions are attributed to, and gated by, the selected code's permitted services.

---

## Testing

```bash
npm test            # unit + integration
npm run test:watch
```

Strategy (and the reasoning behind it):

- **Unit — parsing:** envelope validation, `null` measurement handling, `seq` gap detection, `$topology`
  registry construction, alert-limit decoding.
- **Unit — alert rules:** alert lifecycle transitions (raise → escalate → clear), acknowledgement and
  resolution state machine, audit rows, and refusal to ack a cleared/unknown alert.
- **Integration — persistence:** batch writer under burst load (RTA scan rate), replay range queries
  returning exactly the captured window, and ordering by simulated `ts` when backfilled samples arrive.
- **Integration — against the test broker:** the local sim runs with controls enabled, so command
  publishing, ack correlation and rejection reasons (`researcher_not_permitted`, `precondition_failed`)
  are tested end-to-end. Simulated faults (`ARL_SCENARIO`) drive the alert rules with real payloads
  rather than fixtures.

---

## Security Decisions

The lab's security is weak and out of scope; the requirement is not to weaken it further.

- **No authentication by design.** There is no login, no session, no password. Researcher *codes* are
  the lab's existing control mechanism and are only used to attribute and authorise control actions.
- **Least privilege on control.** Every control request is verified against the ARL API
  (`POST /v1/researchers/verify`) and cached briefly. A code that is unknown, defunct, or not permitted
  for the service cannot dispatch a command, and the UI explains why.
- **Server-side authorisation.** The browser cannot bypass the check: the server owns verification and
  command construction. Researcher codes are never trusted from client-supplied claims about permissions.
- **No hard-coded credentials.** Broker and API details come only from environment variables; `.env` is
  git-ignored. The API is read-only in the live deployment, so a leaked credential cannot write.
- **Input handling.** All inbound MQTT payloads are treated as untrusted: validated against the
  `$topology` registry, size-bounded, type-checked, and never evaluated or used to build SQL. All SQL is
  parameterised. Control values are validated against the control schema before publishing.
- **No secrets in the DB or logs.** Only the last four characters of a researcher code are logged for
  correlation.

---

## Decision Register

| # | Date | Decision | Why | Alternatives rejected |
| --- | --- | --- | --- | --- |
| D1 | 2026-11-02 | Node.js + TypeScript, Express, mqtt.js, better-sqlite3 (WAL), `ws`, axios, React + Vite, Tailwind + Canvas | Shared types end-to-end; embedded DB avoids a daemon; async I/O suits the RTA's 90 msg/s; Canvas handles pixel rasters and maps | Python/FastAPI (no shared types with UI); Postgres in Docker (extra moving part, no benefit at this scale) |
| D2 | 2026-11-02 | Services: RTA, MHE, OPG | RTA is mandatory and drives the architecture; MHE and OPG cover the other two slots (best-of grading means the pair is judged individually) | LWM (would duplicate RTA's spatial/map work); OWT (30-minute reporting makes replay and visualisation thin) |
| D3 | 2026-11-02 | Implementation order RTA → OPG → MHE | Build the shared shell against the hardest service, validate genericity on the simplest, then absorb MHE's larger surface | MHE first (large surface with unproven shell) |
| D4 | 2026-11-02 | Simulated `ts` is the only ordering/charting clock; wall clock kept separately | `ARL_SPEEDUP` and LWM/MHE backfill make wall clock wrong for replay | Ordering by receive time (breaks replay and backfill) |
| D5 | 2026-11-02 | `$topology`-driven generic ingestion and UI, with per-service adapter modules for presentation | Architecture rubric rewards services plugging into a shared shell through a common interface | Three hand-written integrations (highest score band unavailable) |
| D6 | 2026-11-02 | A state change is stored (and pushed) only when its value differs from the last one seen | The RTA republishes every dish's `commanded`/`enabled`/`stowed` items about once a second with an unchanged value; storing each repeat would make `state_change` grow at ~500 rows/s and bury real transitions | Storing every publish (volume without information); sampling state on a timer (misses short-lived transitions) |
| D7 | 2026-11-02 | Controls require a researcher code verified by the ARL API (fail closed). Alert acknowledge/resolve accept a well-formed code without the API, and resolve the name opportunistically | Losing the API must not block alarm handling, but it must block moving hardware. The audit trail records who either way | Verifying codes for acknowledgements too (an API outage would freeze the alarm panel); no code at all for alerts (no attribution) |
| D8 | 2026-11-02 | RTA image geometry (`grid_size`, `fov_rad`, `overlap`, `band_hz`, `dishes`) is read from the `events/scan` *started* payload, not from the target catalogue | Verified against the sim: the catalogue lists `fov_rad = 0.005` for `tgt-cen`, while the started event reports `fov_rad = 0.01`, `grid_size = 128`, `overlap = 3`. Using the catalogue would put every sample at the wrong pixel | Assuming a fixed 128 grid and the catalogue FOV (silently misplaced image) |

---

## Progress Log

Newest first. Each entry: what changed, and why if non-obvious.

- **2026-11-02 — Shared server shell built and verified end to end.** Config, domain types, SQLite schema +
  store, topology registry, ARL API client, alert engine, MQTT ingest, command service, replay engine,
  REST + websocket layer, and `index.ts` wiring. Typechecks clean (`tsc --noEmit`, 18 files).
- **2026-11-02 — Verified against the live sim.** Ingest: 454 telemetry rows across all three services,
  21 alerts recorded, 0 sequence gaps. Control round trip: `set_target` → `completed`;
  `start_scan` → `completed` with ack detail `scan-0001`; 13,360 scan samples over 80 dishes recorded.
  Rejections arrive with the service's own reason codes (`precondition_failed`/`no_target`,
  `precondition_failed`/`target_below_horizon`, `invalid_value`/`out_of_range`).
- **2026-11-02 — Bugs found and fixed during that verification** (each was a real defect, not a config slip):
  - *Topology was never ingested.* Any message for a service with no topology was held back for later
    replay — including the `$topology` message itself, so the hold queue could never drain. The topology
    path now runs before the registry lookup.
  - *Concrete state topics were dropped.* Topologies spell some items generically
    (`arl/rta/+/state/commanded`) and others exactly (`arl/rta/global/state/online`); the matcher only
    tried the generic form, so `online`, `active_dishes`, `wind_stow` and `active_alerts` were invisible.
    Matching now tries both spellings.
  - *Every control was rejected as `unknown_control`.* The lookup built `arl/<svc>/+/cmd/<control>`
    instead of `arl/<svc>/cmd/+/<control>`, so no control definition ever matched.
  - *`NOT NULL constraint failed: service.online`* on the first message from each service: the insert
    bound `NULL` for an unknown online state. The insert now defaults to 0 and the upsert still preserves
    a known value.
  - *Services showed as offline while publishing.* The topology insert did not set `online`, so the column
    kept its default of 0 even though `$topology` had just arrived.
- **2026-11-02 — Planning.** Brief and all specs (`arl-api`, `arl-rta`, `arl-mhe`, `arl-lwm`, `arl-opg`,
  `arl-owt`, `running-the-arl`) read and extracted to text for reference. Stack and services chosen
  (D1–D3). Local toolchain audited: no Docker, but Podman 4.9.3 + podman-compose 1.0.6, Node 18.19,
  Python 3.12, Java 21, sqlite3. ARL images for `api`, `rta`, `mhe`, `opg`, `lwm` loaded into Podman.
- **2026-11-02 — Sim bring-up.** Pulling `eclipse-mosquitto:2` and `postgres:16` for the local broker and
  the API's own database.

---

## Known Issues / Risks

| # | Risk | Mitigation |
| --- | --- | --- |
| R1 | RTA scan payloads are deliberately noisy: random noise, per-dish sensitivity spread, faulty dishes producing very bright outliers or nothing | Do not render raw samples. Filter per-sample (`snr_db`, null offsets), average overlapping samples per pixel, and clip outliers before contrast stretching; validate against the four reference images (`tgt-cen`, `tgt-ori`, `tgt-vel`, `tgt-lmc`). |
| R2 | A scan is 128×128 pixels × 3 samples = 49,152 samples in ~9 minutes at ~90 msg/s | Batch writes, one transaction per flush, indexed range queries; never per-message transactions or per-message API calls. |
| R3 | Live ARL API is read-only and rate limited (20 req/s, burst 40; one backlog download at a time) | Cache researcher verifications, targets and alert limits with TTL; never call the API from the ingest path. |
| R4 | "No authentication" could be read as "no authorisation" | Monitoring is open; control is gated by researcher code verified server-side and attributed in the audit trail. |
| R5 | Replay grade depends on *our* captured data, not the API backlog | Persistence is a first-class requirement from the start; replay reads only local tables. |
| R6 | Cleared (service) vs resolved (researcher) are different lifecycle steps | Separate columns and separate audit transitions; ack and resolve both record the researcher. |
| R7 | RTA cannot be sped up beyond 50×, so alert tests are slow | Test RTA rules at 50×; use MHE (2000×) and OPG (500×) for lifecycle and load tests. |
| R8 | Services replay buffered samples after an outage (`backfill: true`) | Store backfilled rows (they are real history) but exclude them from live alert evaluation and from "latest value" caches. |
| R9 | Alert *events* are not retained, so alerts raised before the platform started exist in the service's `state/active_alerts` but not in our `alert` table | Show the service's reported active-alert ids next to the platform's own list and flag the difference as "not observed since start-up" rather than inventing detail we never received. |
| R10 | Local ARL sim containers restarted mid-session and the RTA's simulated clock stalled at its start time (every state message reused the boot timestamp, so `start_scan` kept answering `target_below_horizon`) | Restart the simulator, not the platform; the platform tolerates it (state de-duplication and `seq` reset are both handled). Recreated the sims with `ARL_START_TIME=now` and speedups (rta 5, mhe 30, opg 30) to keep a working profile. |
| R11 | `tsx` (and any tool that opens an IPC socket in `/tmp`) fails under the sandbox with `EROFS` | Develop with `tsc -w` + `node dist/index.js`, or run the dev server outside the sandbox. `npm run build && npm start` is the path that works everywhere. |

---

## Open Items / Questions

- [ ] **Submission repository.** The graded repository must be named `<student-number>-sdp-exam-2026`
      and be private on `sdp.ms.wits.ac.za`; it is scanned at lunch and 30 minutes before the end. This
      workspace currently points at `SDP_Exam`, which **will not be detected**. Student number required.
- [ ] Brief §3.1 planning answers still to be written up in their own words: "What is MQTT / how does it
      work", "initial architecture", "why a bespoke solution over off-the-shelf", "what should the
      application look like". (The stack/service/order/storage answers are captured in D1–D5 above.)
- [ ] Confirm whether the graded repo is developed in directly or mirrored from this workspace.

---

## AI Declaration

This project was developed with assistance from an agentic coding assistant (Qoder). Architecture
decisions, verification of behaviour against the ARL simulators, and all committed code were reviewed and
approved by the student. Tools used: _(complete/edit before submission)_.

---

## Licences / Attribution

Reference sky images in the RTA specification are credited there (NRAO/AUI/NSF, NASA/ESA, ESO) under
CC BY 4.0 and are used only for validating reconstructions. The ARL simulator, specifications and site
data are exam materials.
