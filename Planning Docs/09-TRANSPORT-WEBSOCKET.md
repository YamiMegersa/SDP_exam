# 09 — WebSocket Transport

**Component.** The push channel: a `hello` snapshot on connect, coalesced high-rate frames,
replay binding, and per-client back pressure. It exists because 90 messages/s of scan samples
cannot be polled.

**Owner files.** `server/src/http/ws.ts`, `web/src/lib/live.ts` (client half).

**Rubric.** Architecture 5 % (*"handles the data rates and failures with reasoned decisions,
e.g. batching, reconnection, back pressure"*).

**Depends on.** `01` (bus), `04` (states), `05`, `07`.

---

## 1. Boundary

In scope: framing, coalescing, client registry, heartbeat, replay watch. Out of scope: deciding
what is worth sending (the bus decides) and rendering (`13`).

---

## 2. Current foundation

`WebSocketServer({ server, path: '/ws', maxPayload: 1 MiB })`. On connect it sends `hello`
with services (topology + latest states), raised alerts, last 25 commands, counts and the
replay list. Telemetry is coalesced per `(service, entity, stream)` into `frames` every 100 ms.
`watch`/`unwatch` bind replay sessions and emit `replay-frame`/`replay-status`. Ping/pong
heartbeat every 30 s. Per-client bounded queues.

---

## 3. Gaps

| Gap | Effect | Fix |
| :--- | :--- | :--- |
| Coalescing keeps only the newest sample per stream/entity | Charts lose intermediate points between two 100 ms flushes at high rate | Keep a per-key ring of up to N samples per window (`MAX_SAMPLES_PER_KEY = 4`) |
| No per-client topic filtering | Every client receives every service's frames even on one page | `subscribe` message listing wanted services; default all |
| Slow client is a risk | A paused tab accumulates frames | Drop policy with an explicit `skipped` counter sent to the client |
| No compression | Frames with repeated keys are large at 90 msg/s | `perMessageDeflate` with a 1 KiB threshold |
| `hello` can be large | 100 dishes × states + topology | Send topology lazily (`get_topology` request) and states in full |

---

## 4. Decomposition

### 4.1 Session subsystem

#### 4.1.1 Handshake

- **Responsibility.** A fresh client is immediately correct.
- **Contract.** First frame is always:
  ```ts
  { type: 'hello', simTime, services: ServiceSnapshot[], alerts: AlertRecord[],
    counts, commands: CommandRow[], replays: ReplaySnapshot[], ingest, serverVersion }
  ```
  `ServiceSnapshot = { service, version, online, describe, states: StateRow[], focal: string[] }`.
- **Steps.** Load states from the store, not from memory, so a client that connects during a
  retention sweep still gets a consistent view. Cap `states` at 20 000 rows and set
  `statesTruncated: true` if exceeded.
- **Acceptance.** Reloading the browser during a scan paints the dish matrix with correct
  values and the mosaic resumes filling, with no empty flash.

#### 4.1.2 Heartbeat and liveness

- **Responsibility.** Reap dead clients without dropping slow ones.
- **Contract.** Server pings every 30 s; a client that misses two pongs is terminated with
  code 1001.
- **Steps.** Track `lastPong` per client; sweep in one interval, not one timer per client.
- **Acceptance.** A laptop sleeping for 90 s reconnects on wake and re-receives `hello`.

### 4.2 Fan-out subsystem

#### 4.2.1 Coalescer

- **Responsibility.** Turn a burst of samples into one frame per window without losing shape.
- **Contract.** Buffer keyed by `${service}|${entity}|${stream}`; each key holds up to
  `MAX_SAMPLES_PER_KEY` samples (newest kept, oldest dropped only beyond the cap). Flush every
  100 ms emits:
  ```ts
  { type: 'frames', simTime, data: { [service]: { [entity]: { [stream]: Sample[] } } },
    states: StateRow[], events: EventRow[], alerts: AlertRecord[], commands: CommandRow[] }
  ```
- **Steps.** Merge all four kinds into a single frame per tick so the client applies one
  update and notifies once. Reset the buffer on flush regardless of send success (a failed
  send means the client is gone; a slow client is handled by the drop policy).
- **Acceptance.** 90 msg/s produces 10 frames/s, each carrying ~9 samples per dish-key, and the
  client's chart ring receives all of them.

#### 4.2.2 Subscription filtering

- **Responsibility.** Let a single-service page avoid three services' traffic.
- **Contract.** Client sends `{ type: 'subscribe', services: ['rta'] }`; the server filters
  frames per client and always includes platform-wide alerts and commands.
- **Steps.** Default is all services. Unknown service names are ignored with a log line.
- **Acceptance.** On the MHE page the client receives no RTA scan frames, and the RTA counters
  in the header still update via `counts` in the frame envelope.

#### 4.2.3 Back pressure

- **Responsibility.** A stalled consumer must not grow the server.
- **Contract.** `bufferedAmount` above 1 MiB → enter `Skipping` mode: keep only state and
  alert frames, drop telemetry, and include `{ skipped: n }` in the next delivered frame.
- **Steps.** Exit `Skipping` when `bufferedAmount` falls below 256 KiB. The client shows a
  "live data paused — resuming" badge while `skipped > 0` and backfills the affected charts
  from `/api/series`.
- **Acceptance.** Pausing the browser's JS for 10 s (debugger) causes skipping, not a
  disconnect, and the charts backfill on resume.

### 4.3 Replay binding subsystem

#### 4.3.1 Watch / unwatch

- **Responsibility.** Replayed frames must arrive through the same path as live frames.
- **Contract.** `{ type: 'watch', id }` → frames become `replay-frame`; `{ type: 'unwatch', id }`
  → return to live. One watched session per client; a second `watch` unwatches the first.
- **Steps.** While a replay is watched, suppress live telemetry for that client (otherwise the
  page would mix two times). Keep alerts live-suppressed too, so the purple mode is honest.
- **Acceptance.** During replay the header shows `HISTORICAL REPLAY`, the annunciator shows the
  alerts *as of the cursor*, and no live value leaks in.

#### 4.3.2 Status and termination

- **Responsibility.** The client must know why a replay stopped.
- **Contract.** `{ type: 'replay-status', id, status, progress, virtualNow, emitted, decimation }`
  at most 4 Hz; `{ type: 'replay-end', id, reason }` with
  `reason ∈ {completed, stopped, data_expired, error}`.
- **Acceptance.** The UI's "return to live" works from every reason and re-enables controls.

---

## 5. Failure modes

| Failure | Behaviour |
| :--- | :--- |
| Client sends malformed JSON | Send `{ type: 'error', code: 'bad_frame' }`, keep the socket |
| Client sends 10 MiB | `maxPayload` closes the socket with 1009 |
| Bus event with no clients | No work; the coalescer is only armed when a client exists |
| Replay session deleted while watched | `replay-end` with `stopped` |
| Server shutting down | Close 1001 with reason `server_shutdown`; the client retries |

---

## 6. Test plan

- Unit: coalescer keeps ≤ N samples per key and the newest wins beyond the cap.
- Unit: subscription filter drops other services' telemetry but keeps alerts.
- Integration (ws client in the test): connect → assert `hello` shape; publish 90 messages →
  assert 10 frames and complete sample coverage.
- Integration: `watch` a session → assert `replay-frame` ordering and that live frames stop.
- Back pressure: a client that never reads → server buffers stay under the cap, `skipped`
  reported.

---

## 7. Open decisions

- **Binary frames?** No. JSON with per-100 ms coalescing is well within budget and keeps the
  client decoder trivial.
- **Should the client be able to request a custom frame rate?** No. One rate keeps behaviour
  predictable under load.