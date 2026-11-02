# 13 — Web Live Store

**Component.** The client-side single source of truth: one mutable store outside React that
receives every WS frame, maintains per-service runtime state, rolling chart rings, accumulators
for the scan mosaic, the alert map, and the replay bridge. React subscribes; it does not own
data.

**Owner files.** `web/src/lib/live.ts`, `web/src/lib/hooks.ts`, `web/src/lib/types.ts`,
`web/src/lib/api.ts`, `web/src/lib/format.ts`.

**Rubric.** Supports every service's Data and Visualisation bands (this is where the numbers come
from) and the Replay band (the same store renders history).

**Depends on.** `09` (frames), `08` (REST backfill).

---

## 1. Boundary

In scope: frame application, derived client state, rings, accumulators, notifying React at a
bounded rate, connection management. Out of scope: pixel rendering (`14`), layout (`12`).

**Why outside React.** At 90 messages/s, `useState` would re-render the tree 90 times a second.
The store coalesces to 10 Hz and React reads snapshots via `useSyncExternalStore`.

---

## 2. Current foundation

`LiveClient` singleton `live`. Holds `services: Map<string, ServiceRuntime>` (topology, states
keyed `${entity}|${item}`, latest telemetry keyed `${stream}|${entity}`, events, samples,
`raster: ScanRaster`, `scan` geometry), `alerts`, `counts`, `commands`, `connection`, `simTime`,
`brokerOnline`, `ingest`, `receivedFrames`. 100 ms notify coalescing; auto-reconnect with
exponential backoff; replay watch/unwatch and frame/status handlers; `apply(frame)` dispatch;
`foldScanSample` resets the raster on a new scan id; `pushToRings` samples aggregate rings at
~1 Hz simulator time; `retain/release/seed` rings keyed `${service}|${stream}|${entity}|${field}`;
`severityRank`.

---

## 3. Gaps

| Gap | Effect | Fix |
| :--- | :--- | :--- |
| Ring updates only for *retained* keys, sampled at 1 Hz | A 2-minute normal stream never appears in a ring because nothing samples it | Push a ring point for every sample, and downsample on read rather than ingest |
| `CommandRow` type drift (D-2) | Ack and completion columns render empty | Fix the type; use `settled_ts` and parsed `value` |
| No derived selectors | Each page recomputes array means, p95s, and counts | Add a selector module with memoised, version-keyed computations |
| Replay accumulators are page-local | The store cannot serve the annunciator during replay | Move replay accumulators into `ServiceRuntime` behind a `replay` flag |
| No `skipped` handling | Charts show a gap with no explanation | Track `skippedByService` and expose a `stale` flag per ring |
| `apply()` is one large switch | Hard to extend and to test | Split into `applyTelemetry/applyState/applyEvent/applyAlert/applyCommand` |

---

## 4. Decomposition

### 4.1 Connection subsystem

#### 4.1.1 Socket lifecycle

- **Responsibility.** Stay connected through sleeps, server restarts and broker outages.
- **Contract.** `connect()` on first subscriber; backoff 250 ms → 5 s with jitter; on `hello`
  reset the backoff; on close, set `connection = 'reconnecting'` and keep the previous data
  visible.
- **Steps.** `visibilitychange` triggers an immediate reconnect attempt when the tab becomes
  visible again. A `hello` replaces `services` wholesale so a long absence cannot leave phantom
  entities.
- **Acceptance.** Putting the laptop to sleep for 5 minutes and waking it repopulates the console
  within 2 s without a reload.

#### 4.1.2 Frame dispatch

- **Responsibility.** Apply one frame completely, then notify once.
- **Contract.** `apply(frame)` returns the list of changed keys so the notifier can be selective.
- **Steps.** Order within a frame matters: telemetry → states → events → alerts → commands, so a
  scan `started` event that resets the raster is applied before that tick's samples.
- **Acceptance.** A frame containing a scan start and the first samples produces a raster with
  exactly those samples, not samples folded into the previous scan's grid.

### 4.2 Service runtime subsystem

#### 4.2.1 Runtime shape

```ts
interface ServiceRuntime {
  code: string; label: string; accent: string;
  version: number; online: boolean; lastTs: number; describe: Describe;
  states: Map<string, StateEntry>;            // `${entity}|${item}`
  latest: Map<string, Sample>;                // `${stream}|${entity}`
  samples: Map<string, Sample[]>;             // short window per `${stream}|${entity}`
  events: EventRow[];                         // capped at 200
  raster: ScanRaster; scan: ScanGeometry | null;
  scanHistory: Map<string, ScanSummary>;      // per scan id, for comparison
  skipped: number; stale: boolean;
}
```

#### 4.2.2 State access

- **Responsibility.** Typed accessors so no page reaches into the maps.
- **Contract.** `state(service, entity, item)`, `stateEntry()`, `latestField(service, stream,
  entity, field)`, `statesOf(service, kind)`, `entitiesOf(service, kind)`.
- **Steps.** Return `undefined` rather than a default; a missing measurement must be visibly
  missing, never zero.
- **Acceptance.** Before the first message from a dish, `temperature` reads `undefined` and the UI
  shows `—`.

#### 4.2.3 Scan accumulation

- **Responsibility.** Build the image from samples, with cleaning.
- **Contract.** `foldScanSample(service, entity, sample)` →
  - on a new `scan_id`, reset the raster and store the previous scan's summary in `scanHistory`;
  - store `(dRa, dDec, signal, snr)` into a per-dish buffer, not directly into pixels;
  - call `raster.add(x, y, signal)` only for samples passing the cleaning rules (`20` §4.3).
- **Steps.** Cleaning rules live in `web/src/lib/imaging.ts` as a pure function so they are
  unit-testable without a canvas: reject `null` offsets or signal, reject samples whose dish is
  flagged `fault_code != none`, reject samples with `snr_db < limit`, and reject samples beyond a
  robust outlier bound computed per scan.
- **Acceptance.** With `receiver_fault` injected on dish-007, the mosaic is not dominated by that
  dish's outliers and `summary.rejected` counts them.

#### 4.2.4 Rings

- **Responsibility.** A rolling buffer per chart, fed directly from samples.
- **Contract.** `retain(service, stream, entity, field, max) → Ring`; `release(...)` refcounts
  and deletes at zero; `seed(ring, points)` merges a backfilled window.
- **Steps.** Push one point per sample (no 1 Hz sampling) using the sample's own `ts`. When more
  than `max` points are pending in a window, keep the newest and mark `ring.downsampled`. Sort on
  seed so a backfill followed by live data is monotonic.
- **Acceptance.** A 2-minute normal stream at 1× produces one point per dish per 2 minutes, and a
  1 Hz scan stream produces one per second without dropping to 1 Hz.

### 4.3 Alert subsystem (client side)

#### 4.3.1 Alert map

- **Responsibility.** O(1) updates and consistent ordering.
- **Contract.** `alerts: Map<alert_id, AlertRecord>`; `activeAlerts()` (raised), `clearedAlerts()`
  (cleared not resolved), `upsertAlert`, `dropAlert` (on resolve).
- **Steps.** Sort by `severityRank` then `raised_ts` descending, computed on read and memoised by
  a version counter so sorting 500 alerts does not run per render.
- **Acceptance.** An escalated alert replaces in place without jumping to the top, because the
  sort is by `raised_ts`.

#### 4.3.2 As-of-cursor view

- **Responsibility.** Replay must show lifecycle state at a time, not at present.
- **Contract.** `alertsAsOf(service?, ts)`: for each alert, derive state from
  `raised_ts/cleared_ts/ack_ts/resolved_ts` relative to `ts`.
- **Steps.** Pure function over `AlertRecord[]`; used only in replay. Unit-test it with an alert
  whose four timestamps straddle the cursor.
- **Acceptance.** Three cursors (before ack, after ack, after resolve) yield three different
  states for the same alert.

### 4.4 Selector subsystem

- **Responsibility.** Derived numbers computed once, shared by every component that needs them.
- **Contract.** `selectors` object, each memoised on `(service, version, args)`:
  - `arrayMean(service, field)` and `arrayP95`
  - `dishesInService(service)` and `dishBuckets(service)` (ok/stow/fault/off/hot)
  - `roomsOutOfCompliance(service)`
  - `powerMargin(service)` = `total_generation_w − total_load_w`
  - `socBand(service)` = `crit | warn | ok`
  - `crewNeedingAttention(service)`
  - `wellbeingRolling(service, days)`
- **Steps.** Keep them pure over the store's maps, so they work identically in replay. Never
  fetch.
- **Acceptance.** Rendering the Overview and the RTA page concurrently computes the array mean
  once per version bump.

### 4.5 API client subsystem

#### 4.5.1 Typed requests

- **Responsibility.** One place that knows the REST surface.
- **Contract.** `ApiError(status, code, detail)`; `errorText()` renders `code — detail`; one
  function per route in `08` §5.
- **Steps.** Fix D-2 and D-3 in `types.ts` so the client mirrors the server. Add a compile-time
  check: `server/src/types.ts` exports a `WireContract` interface, duplicated deliberately in
  `web/src/lib/types.ts`, and a test asserts deep structural assignability in both directions
  using `satisfies`.
- **Acceptance.** `npm run typecheck` fails if a server field is renamed without the client being
  updated.

#### 4.5.2 Formatting

- **Responsibility.** Consistent units everywhere.
- **Contract.** `fmt(value, unit, { digits })` renders `—` for `null`/`undefined`, chooses
  engineering prefixes (kW, MJ, kPa), and never rounds a value to a zero that hides a warning
  (a 0.4 % SOC shows `0.4 %`, not `0 %`).
- **Acceptance.** Unit tests for null, zero, small values, and each unit family.

---

## 5. Data contracts

```ts
type Ring = { ts: number[]; v: number[]; max: number; downsampled: boolean; version: number };
interface ScanGeometry { scanId: string; target: unknown; raRad: number; decRad: number;
                         fovRad: number; gridSize: number; overlap: number;
                         bandHz: number; dishes: string[]; expectedDurationS: number;
                         origin: 'command' | 'schedule' }
```

---

## 6. Failure modes

| Failure | Behaviour |
| :--- | :--- |
| Frame arrives for an unknown service | Created on the fly from the frame's own topology, if present; otherwise ignored and counted |
| Out-of-order sample (`ts` lower than the ring's last) | Inserted in order if within the ring window, else dropped and counted |
| `hello` after reconnect lacks a service | That service's runtime is removed and its page shows the absence panel |
| Backfill returns 400 points for a 20-minute window | Seeded and marked `downsampled` so the chart shows a density hint |
| Replay frame for a scan id already in history | The cached scan summary is restored instead of rebuilding |

---

## 7. Test plan

- Unit: `apply()` ordering with a combined frame.
- Unit: `foldScanSample` cleaning rules (5 reject cases, 2 accept cases).
- Unit: ring downsampling and monotonic seeding.
- Unit: `alertsAsOf` at three cursors.
- Unit: selectors against a fixture store.
- Unit: `fmt` for null/zero/small/large.
- Integration: feed 100 recorded frames into the store and assert final states equal the expected
  snapshot.

---

## 8. Open decisions

- **Should rings live in the store or in each chart component?** In the store, because two
  components often need the same series and because replay must feed them identically.
- **Do we cap `samples` per entity?** Yes, 300 points, and rely on rings for history.