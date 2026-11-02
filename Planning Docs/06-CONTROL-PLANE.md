# 06 — Control Plane

**Component.** Everything between a researcher pressing a button and a service acknowledging:
authorisation, validation, dispatch, acknowledgement tracking, and the audit trail.

**Owner files.** `server/src/commands/service.ts`, `server/src/arlApi/client.ts` (verify),
`server/src/http/app.ts` (command routes), `web/src/components/commands.tsx`,
`web/src/lib/api.ts`.

**Rubric.** Control 30 % per service (all control surfaces; failure/completion information;
current and target state); Security 5 % (*"researcher codes resolve correctly, services are
access protected"*).

**Depends on.** `02` (control schema), `03` (publish), `04` (rows), `10` (verification).

---

## 1. Boundary

In scope: the platform's guarantee that a command is well-formed, authorised, dispatched once,
and its outcome recorded. Out of scope: whether the *service* accepts it (that is the
service's judgement and its reason codes are passed through verbatim), and the physical
preconditions a *client* can check before sending (that is `15`, guards).

---

## 2. Current foundation

`send()` order of checks, all returning a specific HTTP code:

| Step | Failure | HTTP | Code |
| :--- | :--- | :--- | :--- |
| 1 | unknown service | 404 | `unknown_service` |
| 2 | missing entity or control in body | 400 | `bad_request` |
| 3 | entity not in topology | 422 | `unknown_target` |
| 4 | control not declared for that entity kind | 422 | `unknown_control` |
| 5 | value fails schema | 400 | `invalid_value` |
| 6 | malformed researcher code | 400 | `invalid_researcher` |
| 7 | ARL API unreachable | 503 | `api_unavailable` |
| 8 | API says not permitted | 403 | API reason (`unknown_researcher`, `researcher_defunct`, `researcher_not_permitted`) |
| 9 | broker down when publishing | 503 | `platform_publish_failed` |

On success: a `randomUUID()` command id, topic `arl/<svc>/cmd/<entity>/<control>`, a row
inserted before publishing, exactly `{ command_id, researcher, value }` published at QoS 1,
and a 202 carrying the row. `receiveAck()` validates the ack state, applies it, emits a bus
event and logs terminal states. `expire()` settles timeouts after 45 s.

---

## 3. Gaps

| Gap | Rubric effect | Fix |
| :--- | :--- | :--- |
| No pre-flight simulation of the command's effect | Control 100 % wants "safeguards against unsafe commands" | Add server-side **guards** (§4.3) that reject known-unsafe values with a reason |
| Current vs target state is only shown where the page author remembered | Criterion explicitly asks for both | Standardise a `TargetState` contract per control (§4.2) |
| No dispatch idempotency | A double-click sends two commands | Client `request_id` + server dedupe window |
| 45 s timeout is fixed | A 10-minute airlock cycle or a 30 s generator start behave differently | Per-control timeout table |
| No batch/preset dispatch | Presets (Control 100 %) need several commands applied together | `POST /api/commands/batch` with all-or-nothing pre-validation |
| Command rows do not record which guard rejected | Audit weak | `guard` column on the rejection reason |
| No retry of an interrupted dispatch | `interrupted` reason never observable | Optional single retry with the same id |

---

## 4. Decomposition

### 4.1 Authorisation subsystem

#### 4.1.1 Code syntax gate

- **Responsibility.** Reject obviously invalid input before an HTTP round trip to the API.
- **Contract.** `RESEARCHER_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{2,31}$/i`; a failure returns
  400 `invalid_researcher` with the pattern in `detail`.
- **Steps.** Keep it deliberately loose (the API is the authority). Trim whitespace; reject
  anything with a space or a slash so it cannot corrupt a log line or a CSV.
- **Acceptance.** `" arl-as3 "` is trimmed and accepted; `"arl as3"` is rejected.

#### 4.1.2 Service permission

- **Responsibility.** Enforce per-service access.
- **Contract.** `api.verify(code, service)` → `{ valid, reason, researcher }`. Cache the
  result for `RESEARCHER_CACHE_TTL_S` (60 s) keyed by `code|service`, including negatives, so
  a defunct researcher cannot hammer the API.
- **Two endpoints, one of which is the gate.** The ARL API offers both of these, and they are not
  interchangeable:

  | API call | Answers | May it gate a command? |
  | :--- | :--- | :--- |
  | `POST /v1/researchers/verify` with `{code, service}` | *May this code control this service?*, with `reason` = `unknown` / `defunct` / `not_permitted` | **Yes — this is the only gate** |
  | `GET /v1/researchers/{code}` | *Who is this code?* (name, experiments, status) — no service argument | **No.** It cannot answer `not_permitted` for a specific service |

  Using the lookup as the gate is the specific mistake that costs the Security criterion its 75 %
  band: the researcher resolves correctly (≤ 50 % "codes resolve correctly via the ARL API") but
  service scoping is never checked, so "services are access protected" is unearned. `client.ts`
  keeps the lookup for display and for attributing an acknowledgement to a name, and uses `verify`
  for every dispatch.
- **Steps.** Fail closed: a transport error is 503, never "allow". Persist the researcher
  record on success so the UI can show a name.
- **Acceptance.** `arl-as3` (rta+mhe+opg) can command all three; a code scoped only to `lwm`
  gets 403 `researcher_not_permitted` on an RTA command, with the API's reason verbatim.

#### 4.1.3 Offline behaviour

- **Responsibility.** Be honest about a degraded authorisation path.
- **Contract.** When the API is unreachable: controls return 503 `api_unavailable`; the UI
  disables the send button and shows "ARL API unreachable — controls locked"; alerts remain
  usable per `05`.
- **Acceptance.** With the API stopped, pressing a control shows the locked state without
  sending anything.

### 4.2 Dispatch subsystem

#### 4.2.1 Command construction

- **Responsibility.** One topic, one payload shape, one id.
- **Contract.**
  ```ts
  topic   = `arl/${service}/cmd/${entity}/${control}`
  payload = { command_id, researcher, value }
  ```
- **Steps.** Coerce `value` through `validateControlValue` and send the **coerced** value
  (numbers as numbers, ISO timestamps as ms). Never add helper fields. Insert the row before
  publishing so an ack that arrives in the same tick finds the row.
- **Acceptance.** An ack arriving 4 ms after publish is applied, not dropped as unknown.

#### 4.2.2 Idempotency

- **Responsibility.** A double-click is one command.
- **Contract.** Client sends `request_id` (a UUID generated at click); the server keeps a
  60 s in-memory map `request_id → command_id` and returns the existing row on a repeat.
- **Steps.** Also catch accidental duplicates by hashing `(service, entity, control, value)`
  within 1 s and returning the first command with `deduplicated: true`.
- **Acceptance.** Two clicks in 200 ms produce one command row and one ack.

#### 4.2.3 Per-control timeout

- **Responsibility.** Wait as long as the physics says.
- **Contract.** Timeout table by control name, defaulting to 45 s:
  | Control | Timeout |
  | :--- | :--- |
  | `start_scan`, `pause_scan`, `cancel_scan`, `set_target`, `set_observation_frequency`, `assign_subarray`, `enable_dish`, `stow_dish` | 45 s |
  | `adjust_azimuth`, `adjust_elevation` | 120 s (slew time plus 1.5× margin) |
  | `request_recalibration` | 150 s (120 s calibration plus margin) |
  | `cycle_airlock` | 660 s (10 min plus margin) |
  | `crew_wellness_check` | 1800 s (a sleeping crew member may take 30 min) |
  | `start_generator` | 60 s (30 s start plus margin) |
  | `stop_generator` | 90 s (60 s cool-down plus margin) |
  | `generation_priority`, `load_shed`, `enable_solar_array`, `battery_reserve`, `adjust_temperature`, `adjust_humidity`, `ventilation`, `environmental_systems`, `seal_room`, `lighting_schedule`, `irrigation_schedule` | 45 s |
- **Steps.** `expire()` uses the table; a timeout writes a synthetic ack with
  `state: 'timeout'`, `reason: 'no_ack'`.
- **Acceptance.** `cycle_airlock` is not marked timed out at 45 s; it settles at ~600 s.

#### 4.2.4 Acknowledgement intake

- **Responsibility.** Apply every ack faithfully and never invent progress.
- **Contract.** `receiveAck(ack)` on `arl/<svc>/ack/<command_id>`. Accepted states:
  `accepted | rejected | in_progress | completed | failed`. Unknown command ids are logged and
  counted but not stored (they are not ours).
- **Steps.** Intermediate `in_progress` acks update `progress` and are appended to
  `command_ack` for the trail but do not settle the row. Rejection and failure reasons are
  stored byte-for-byte and rendered verbatim in the UI.
- **Acceptance.** A `rejected / precondition_failed / "target below horizon"` ack appears in
  the console exactly as written.

### 4.3 Guard subsystem (the 100 % band)

#### 4.3.1 Guard model

- **Responsibility.** Refuse a command the platform can prove is unsafe or futile, with the
  same vocabulary the service uses, so the operator learns one set of reasons.
- **Contract.** `guards: GuardDef[]` evaluated in order before dispatch:
  ```ts
  interface GuardDef {
    control: string; entityKinds: string[];
    check(ctx: GuardContext): { ok: true } | { ok: false; reason: string; detail: string; hint?: string };
  }
  ```
  `reason` uses the service vocabulary (`precondition_failed`, `invalid_value`, `busy`,
  `fault`, `unknown_target`).
- **Steps.** `GuardContext` exposes: current states for the entity, the adapter's capability
  view, live limits from `10`, and the latest telemetry.
- **Acceptance.** A guard rejection appears in the UI with the hint before anything is
  published, and the same command sent with the guard bypassed (`?force=1`, only for
  `SUPERVISOR` builds) is still rejected by the service — proving the guard mirrors reality.

#### 4.3.2 Concrete guards, per service

**RTA** (`server/src/services/rta.ts`)

| Guard | Condition | Reason / hint |
| :--- | :--- | :--- |
| `start_scan` target elevation | `set_target` never called → `target == null` | `no_target` / "choose a target first" |
| `start_scan` dishes | `active_dishes < 3` | `precondition_failed` / "fewer than 3 dishes in service" |
| `start_scan` wind | `wind_stow == true` | `precondition_failed` / "wind stow engaged" |
| `start_scan` running | `scan_state == running` | `busy` |
| `set_target` while scanning | `scan_state ∈ {running, paused}` | `precondition_failed` / "not while scanning" |
| `set_observation_frequency` while scanning | same | same |
| `adjust_azimuth` / `adjust_elevation` on a stowed dish | `stowed == true` | `precondition_failed` / "dish is stowed" |
| `adjust_*` on a disabled dish | `enabled == false` | `precondition_failed` |
| `adjust_elevation` out of band | `value < 0.0873 || value > 1.5708` | `invalid_value` / "5° to 90°" |
| `assign_subarray` during a scan | dish `subarray == main` and `scan_state == running` | `busy` |
| `stow_dish false` during wind stow | `wind_stow == true` | `precondition_failed` |

**MHE** (`server/src/services/mhe.ts`)

| Guard | Condition | Reason / hint |
| :--- | :--- | :--- |
| `seal_room` on the airlock while depressurised | `airlock_state != pressurised` | `precondition_failed` |
| `cycle_airlock` during an EVA | `eva_in_progress == true` | `busy` |
| `cycle_airlock` to the current state | `airlock_state` equals target | `precondition_failed` |
| `cycle_airlock` with a door open | `inner_door == open || outer_door == open` | `precondition_failed` |
| `adjust_temperature` outside 285–300 K | range | `invalid_value` |
| `adjust_humidity` outside 20–80 % | range | `invalid_value` |
| `ventilation` outside 0–400 m³/h | range | `invalid_value` |
| `lighting_schedule` level > 1000 lx (30000 in hydroponics) | range by room | `invalid_value` |
| `irrigation_schedule` volume > 120 L | range | `invalid_value` |
| any room control when `mission_state == complete` | surveys stopped | `precondition_failed` / "mission complete" |

**OPG** (`server/src/services/opg.ts`)

| Guard | Condition | Reason / hint |
| :--- | :--- | :--- |
| `start_generator` with fuel < 2 % | `fuel_level_pct < 2` | `precondition_failed` / "low_fuel" |
| `start_generator` already running/starting | `generator_status ∈ {running, starting}` | `busy` |
| `stop_generator` not running | `generator_status != running` | `precondition_failed` |
| `battery_reserve` outside 10–80 % | range | `invalid_value` |
| `battery_reserve` above current SOC with load uncovered | `reserve > soc` and `supply_mode != solar` | `precondition_failed` / "would strand the load" |
| `enable_solar_array false` while solar is the only source | `supply_mode == solar` and batteries below reserve | `precondition_failed` / "would cause a shortfall" |

- **Acceptance per service.** Each guard has a unit test with a recorded state fixture, and a
  manual fault drill in `52` that triggers it.

### 4.4 Batch and preset dispatch

#### 4.4.1 Batch endpoint

- **Responsibility.** Apply a preset (several related controls) atomically from the
  researcher's point of view.
- **Contract.** `POST /api/commands/batch` with `{ service, researcher, commands: [{entity, control, value}] }`
  → `{ accepted: CommandRow[], rejected: {index, code, detail}[] }`. Returns 409 unless every
  command passes validation and guards; nothing is published on failure.
- **Steps.** Validate all first, then publish in order, then return. If a publish fails
  mid-way, mark the published ones `partial` in the response and record why.
- **Acceptance.** The "Night observing" preset for RTA (set target, set frequency, start scan)
  either applies all three or none, and the log shows them as one group.

#### 4.4.2 Presets

- **Responsibility.** Named, researcher-shaped starting points.
- **Contract.** Presets are client-side data (`web/src/lib/presets.ts`) with a stable schema;
  the server only sees the resulting batch.
- **Steps.** Each preset declares service, label, rationale, and the commands. Stored in the
  live store so replay does not need them.
- **Acceptance.** Three presets per service exist and are reachable from the workspace header
  (see `15` §2).

### 4.5 Audit subsystem

- **Responsibility.** Answer "who asked for what, when, and what happened".
- **Contract.** `GET /api/commands?service=&state=&from=&limit=` returns rows with the
  researcher code, the coerced value, and every ack in `GET /api/commands/:id/acks`.
- **Steps.** Render a per-service command log panel with: control, value, target, researcher,
  state pill, service reason (verbatim), progress bar while `in_progress`.
- **Acceptance.** A rejected command is still in the log with its reason; a timed-out command
  shows `timeout` and a synthetic `no_ack` ack.

---

## 5. Data contracts

```ts
// Reconcile the client mirror (D-2 in 00): value is parsed JSON, settled_ts replaces ack_ts/completed_ts.
interface CommandRow {
  command_id: string; service: string; entity: string; control: string;
  value: unknown; researcher: string; topic: string;
  sent_ts: number; sent_wall_ts: number;
  state: 'pending' | 'accepted' | 'in_progress' | 'completed' | 'rejected' | 'failed' | 'timeout';
  progress: number | null; reason: string | null; detail: string | null;
  settled_ts: number | null;
  guard: string | null;                 // new: which guard rejected, if any
  request_id: string | null;            // new: idempotency
}
```

---

## 6. Failure modes

| Failure | Behaviour |
| :--- | :--- |
| Broker down at send | 503 `platform_publish_failed`; row marked failed, not left pending |
| Service stops after accept | Per-control timeout settles it as `timeout` |
| Duplicate ack with a lower state | Ignored; state transitions are monotonic |
| Ack for an unknown id | Counted, logged, not stored |
| API slow (> 5 s) | Timeout → 503 `api_unavailable`; nothing published |
| Researcher becomes defunct mid-session | Next command rejected 403; cached entry invalidated on 403 |

---

## 7. Test plan

- Unit: the nine check steps, one test each, asserting code and message.
- Unit: every guard, with a passing and a failing fixture.
- Unit: value coercion (string numbers, ISO timestamps, enum membership).
- Integration: dispatch → ack completed → row settled with `settled_ts`.
- Integration: dispatch → no ack → timeout at the per-control deadline.
- Integration (real broker + real service): `set_target` then `start_scan`, assert `scan-0001`
  in the ack detail; then `start_scan` again, assert `busy`.
- Security: unknown code → 403; API down → 503; malformed code → 400.

---

## 8. Open decisions

- **Server-side guards vs client-side only.** Server-side, because the rubric asks for
  safeguards and because a guard that lives only in the browser is not a safeguard. The client
  duplicates the cheap ones for instant feedback (`15`), and a test asserts both agree.
- **Do we expose `?force=1`?** Behind `SUPERVISOR=1` only, for demonstrating that the service
  is the final authority. Never in a normal run.