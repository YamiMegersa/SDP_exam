# 07 — Replay System

**Component.** Time travel over the platform's *own* captured data: session creation, an
ordered merged cursor over telemetry/state/event, transport controls, and the injection of
replayed frames into the same console components that render live data.

**Owner files.** `server/src/replay/session.ts`, `server/src/replay/service.ts` (factory),
`server/src/http/app.ts` (replay routes), `server/src/http/ws.ts` (watch/unwatch),
`web/src/pages/Replay.tsx`, `web/src/lib/live.ts` (replay injection).

**Rubric.** Replay 10 % — the 100 % band is *"replay is integrated with the rest of the
platform, e.g. alerts and events shown in the context of the replay"*.

**Depends on.** `04` (replay chunk reader), `09` (transport), `13` (client store).

---

## 1. Boundary

In scope: a window over local tables, ordered emission at a chosen speed, pausing, seeking,
rewinding, fast-forwarding, and the alert/event context. Out of scope: fetching the ARL API
backlog. **The rubric explicitly forbids it**: replay must run "from the data the student's
platform captured (not the backlog dump)".

This is why `03` must persist everything, including at speedup: a replay is only as good as
the capture.

---

## 2. Current foundation

`ReplaySession` merges `telemetry`, `state_change` and `event` by `(ts, id)` using keyset
pagination (`CHUNK = 500`, `HARD_ROW_LIMIT = 250 000`, `TICK_MS = 50`, `MAX_ROWS_PER_TICK = 3000`).
Speed clamped to 0.1–64. `play/pause/seek/setSpeed/stop`, a snapshot
`{ id, services, from, to, speed, cursor, status, progress, emitted, rows }`, frame/status/end
handlers. Sessions are dropped 60 s after ending. WS `watch`/`unwatch` binds a session to a
client; the client accumulates frames into its normal store.

---

## 3. Gaps

| Gap | Rubric effect | Fix |
| :--- | :--- | :--- |
| Alerts and events are replayed as raw rows but not surfaced as a timeline | Caps replay at 75 % | Add replay-scoped alert timeline and an event list bound to the cursor |
| No rewind control distinct from seek | "Rewind, fast forward and speed control" | Add `direction` and negative-rate stepping |
| Seek restarts the stream from scratch | Visible stall on a 2-hour window | Re-seek with a cursor reset and a rapid catch-up mode |
| Speed 64× still emits every sample | A 6-hour window at 64× would emit 20 M frames | Decimate scan samples by pixel budget at high speed |
| The image raster is rebuilt only for the *current* scan id | Scrubbing back across a scan boundary loses the earlier image | Keep a per-scan-id raster cache with an LRU |
| No "LIVE" affordance from replay | Design system asks for a LIVE pill | Add `LIVE` which stops the session and resumes the stream |
| Sessions are per-connection only | Two browsers cannot share a moment | Acceptable. Document it; do not add sharing |

---

## 4. Decomposition

### 4.1 Window subsystem

#### 4.1.1 Capture range

- **Responsibility.** Tell the researcher what can actually be replayed.
- **Contract.** `GET /api/replay/range?services=rta,mhe,opg` →
  `{ perService: { service, firstTs, lastTs, counts: { telemetry, state, event } }[], union: { firstTs, lastTs } }`.
- **Steps.** Use `timeRange()` from `04`. Show a disabled hint when a service has no rows in
  the requested window rather than an empty chart.
- **Acceptance.** With only RTA running, the range endpoint reports MHE and OPG as absent and
  the UI greys them out.

#### 4.1.2 Window selection

- **Responsibility.** Make the example in the handout trivial: "jump backwards and observe the
  temperature change over a three hour window".
- **Contract.** UI offers: quick ranges (5 min, 30 min, 3 h, 12 h, all), a relative jump
  ("around the newest alert"), and from/to sliders bounded by the capture range.
- **Steps.** Default to the last 10 minutes. Remember the last window in
  `sessionStorage`. When opened from an alert ("replay this"), prefill ±15 min around
  `raised_ts`.
- **Acceptance.** Clicking "replay this" on a storm alert opens a window from 15 minutes before
  to 15 minutes after, with the alert already ticked on the timeline.

### 4.2 Session subsystem

#### 4.2.1 Cursor and merge

- **Responsibility.** Emit rows in strict `(ts, id)` order, across three tables and N services.
- **Contract.** `next()` reads the next chunk from `04.replayChunk`, advances the cursor, and
  returns up to `MAX_ROWS_PER_TICK` rows whose `ts <= virtualNow`.
- **Steps.** Maintain `virtualNow = from + (elapsedWall × speed × direction)`, clamped to
  `[from, to]`. Emit a row only when its `ts <= virtualNow`, so a 64× run does not burst.
- **Acceptance.** A window containing interleaved telemetry, state and events replays in
  exactly the order the rows were written.

#### 4.2.2 Transport

- **Responsibility.** Six verbs, exactly as the design system lists them.
- **Contract.**
  | Verb | Route | Behaviour |
  | :--- | :--- | :--- |
  | play | `POST /api/replay/:id/play` | resumes from the cursor |
  | pause | `POST /api/replay/:id/pause` | freezes `virtualNow` |
  | seek | `POST /api/replay/:id/seek { ts }` | resets the cursor to the first row at/after `ts` |
  | speed | `POST /api/replay/:id/speed { speed }` | 0.1–64 |
  | rewind | `POST /api/replay/:id/seek { ts: virtualNow - step }` with `step = 30 s × speed^-1` | steps backwards, emits the last rows before the new time |
  | stop | `DELETE /api/replay/:id` | ends, client returns to live |
- **Steps.** Seeking backwards re-reads the chunk containing the target time and emits only
  rows after the cursor; the client resets its accumulators on `seek` so the raster and
  counters match the new time.
- **Acceptance.** Pause, seek back 2 minutes, play → the console shows the earlier state, the
  mosaic is rebuilt from the samples before that point, and the counter restarts.

#### 4.2.3 Decimation at speed

- **Responsibility.** Replay must stay smooth and must not lie.
- **Contract.** At `speed >= 10`, scan samples are decimated to at most one sample per dish per
  simulated second; at `speed >= 32`, to at most one per dish per 5 simulated seconds. The
  decimation factor is reported in `status.decimation`.
- **Steps.** Decimate by `(dishId hash + floor(ts / windowMs)) % factor === 0`, which keeps
  spatial coverage even. Never decimate state changes, events or alerts — those are the
  subject of the replay.
- **Acceptance.** Replaying 1 hour of scanning at 64× completes in under 60 s, the image is
  recognisable, and every alert in the window is still emitted.

### 4.3 Integration subsystem (the 100 % band)

#### 4.3.1 Replayed alert timeline

- **Responsibility.** Show alerts *in the context of* the replay.
- **Contract.** `GET /api/replay/:id/alerts` → every alert whose `raised_ts`, `cleared_ts`,
  `ack_ts` or `resolved_ts` falls in `[from, to]`, with all four timestamps. The client draws
  ticks on the scrubber and a list filtered to `ts <= virtualNow`.
- **Steps.** Also include platform alerts (`origin: 'platform'`) — a replay of a broker outage
  is instructive. Render each with its lifecycle state *as of the cursor*, not its final state:
  an alert acknowledged later must appear unacknowledged when scrubbing before the ack.
- **Acceptance.** Scrubbing to before an acknowledgement shows the alert as unacknowledged;
  scrubbing past it shows the acknowledgement. This is the single most convincing replay demo.

#### 4.3.2 Replayed event stream

- **Responsibility.** Scan lifecycle, surveys, EVAs and refuels are the narrative of an
  experiment; they must be visible.
- **Contract.** Events are emitted as normal `event` frames, ordered with everything else, and
  rendered in a replay event list with an icon per kind.
- **Steps.** Use the *started* scan event to recreate the raster geometry (as the live path
  does), never the catalogue.
- **Acceptance.** A replay containing a scan shows `started` → samples → `completed`, with the
  image appearing progressively.

#### 4.3.3 Derived measures in replay

- **Responsibility.** The comparison views used live must work while scrubbing.
- **Contract.** Derived measures are recomputed client-side from the replayed frames (they are
  accumulators), or fetched from `11` when they are server-side rollups.
- **Steps.** Keep the accumulator API identical to the live path so a single component renders
  both.
- **Acceptance.** The OPG energy-balance strip and the MHE 3-day wellbeing trend both render in
  replay, with the same code path as live.

---

## 5. Data contracts

```ts
interface ReplaySnapshot {
  id: string; services: string[]; from: number; to: number;
  speed: number; direction: 1 | -1;
  cursor: { ts: number; id: number } | null;
  virtualNow: number;
  status: 'idle' | 'playing' | 'paused' | 'ended';
  progress: number; emitted: number; rows: number;
  decimation: number;
}
```

Frames reuse the live WS shapes so the client store needs no parallel decoder.

---

## 6. Failure modes

| Failure | Behaviour |
| :--- | :--- |
| Window larger than `HARD_ROW_LIMIT` | 413 `window_too_large` with the suggested narrower window |
| Seek to a time with no rows | Cursor snaps to the next row after it; UI says "no data until 09:14:02" |
| Session outlives the range (new data captured) | Endpoint range is fixed at creation; new rows are not replayed |
| Two tabs on one session | Second watch replaces the first; the first receives an `ended` frame |
| Server restarts mid-replay | Client receives a WS close, shows "replay interrupted", offers "return to live" |
| Retention deletes rows inside an active window | Session stops with `ended` and reason `data_expired`; retention must skip hot windows |

---

## 7. Test plan

- Unit: cursor merge with interleaved fixtures (three tables, two services).
- Unit: `virtualNow` maths for speeds 0.1, 1, 10, 64 and both directions.
- Unit: decimation keeps alerts and state changes intact.
- Integration: create a session over a seeded DB, play, assert ordered frames and a final
  `ended`.
- Integration: seek backwards then play, assert exactly the rows after the new cursor.
- Integration: alert lifecycle state as-of-cursor (the §4.3.1 acceptance).
- Manual drill: replay across a real scan at 1× and at 32× (see `52`).

---

## 8. Open decisions

- **Server-side raster reconstruction?** No. The client already builds the mosaic from scan
  samples; duplicating it server-side would double the work and the memory.
- **Should replay be able to control the services?** No. Replay is read-only; that is what
  makes "return to live" safe. The control panel is disabled with a purple overlay while a
  session is active (design system §7).