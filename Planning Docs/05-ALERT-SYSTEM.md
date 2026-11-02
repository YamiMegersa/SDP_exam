# 05 — Alert System

**Component.** The platform's treatment of alerts: intake from services, platform-generated
alerts, lifecycle and audit, the context pack that makes an alert actionable, and the API the
annunciator uses.

**Owner files.** `server/src/alerts/engine.ts`, `server/src/db/store.ts` (alert methods),
`server/src/http/app.ts` (alert routes), `web/src/components/Annunciator.tsx`,
`web/src/components/AlertAction.tsx`.

**Rubric.** Alert system 10 % (annunciator, acknowledge, resolve, persistent log with raised
ts, ack ts, ack user, resolve ts, resolve user, cause). Alerts 10 % per service (all alert
types supported, and *"alerts give the researcher the context to decide what to do"*).

**Depends on.** `03` (gap and silent detection), `04` (persistence), `10` (limits).

---

## 1. Boundary

In scope: deciding which alerts the platform owns, receiving service alerts unmodified,
lifecycle state machine, audit trail, context assembly, and the JSON the console renders.
Out of scope: the physical conditions that make a service raise an alert (owned by the
service and described in `23`/`33`/`43`).

The platform is a *follower* for service alerts. It must never invent, suppress, re-word or
downgrade a service alert. It is the *owner* only for transport-health alerts.

---

## 2. Current foundation

- Service alerts arrive on `arl/<svc>/events/alert` and are stored verbatim under the
  service's own `alert_id`; escalation under the same id increments `escalate_count`.
- Platform alerts use ids `platform/<service>/<type>`: `service_offline`, `broker_disconnected`,
  `ingest_gap` (info, or warning above 25 missed messages), `service_silent` (after
  `SERVICE_SILENCE_S`, default 180 s).
- `sweep()` every 10 s handles silence and gap recovery (120 s).
- Acknowledge requires a researcher code; `acknowledgeAlert` returns 409 when already
  acknowledged or resolved. Resolve requires a prior acknowledgement and a 3–500 character
  resolution, plus a cause.
- Open count = `status = raised` and `resolved_ts IS NULL`; cleared-but-unresolved is counted
  separately and shown on the Overview.

---

## 3. Gaps against the rubric

| Gap | Rubric effect | Fix |
| :--- | :--- | :--- |
| Alert rows show value/limit only | Caps the service Alerts criterion at 75 % ("all alerts supported") | Add the **context pack** (§4.3) |
| No link from an alert to the controls that address it | A researcher must guess what to do | Context pack carries `suggested_controls` |
| `service_silent` and `service_offline` are hard to tell apart in the UI | Ambiguous during fault drills | Distinguish `reason: 'will' | 'silent' | 'no_data'` in metadata and show it |
| Cleared-but-unacked alerts do not escalate visually | An operator can miss a transient | Keep them flashing until acknowledged, with an "auto-cleared" tag |
| No filter by severity or by "needs my service" | Fault-storm usability (UI/UX 100 % band) | Add severity/service/ack filters and grouping in the annunciator |
| No alert-count timeline for replay ticks | Replay integration band | Expose `GET /api/alerts/timeline` |
| Acknowledgement by an unverified code is accepted silently | Security: attribution must be honest | Store `ack_verified: 0` and render a "not in directory" mark |

---

## 4. Decomposition

### 4.1 Intake subsystem

#### 4.1.1 Service alert handler

- **Responsibility.** Persist exactly what the service said.
- **Contract.** `alertEngine.serviceAlert({ service, payload, recvTs, entityFromTopic })`.
  Required payload fields: `alert_id`, `type`, `severity ∈ {info,warning,critical}`,
  `state ∈ {raised,cleared}`. Optional: `value`, `limit`, `unit`, `message`, `metadata`,
  `entity`, `ts`.
- **Steps.**
  1. Reject a payload with a missing or non-string `alert_id` — log and count, do not invent an id.
  2. `entity` comes from the payload if present, else from the topic (dish/crew alerts are
     published on the dished topic only when the service says so).
  3. Store `ts` (simulator time) as `raised_ts` for a new raise and as `last_ts` always.
  4. Persist metadata as JSON, unmodified.
  5. Emit a bus `alert` event so WS clients update within one coalescing window.
- **Acceptance.** A `dish_temperature` warning with `value 335.2, limit 333, unit K,
  metadata{row,col,subarray,fault_code,scan_id}` is stored and rendered with every field.

#### 4.1.2 Platform alert ownership

- **Responsibility.** Cover the failures the services cannot report themselves.
- **Owned types.**
  | Type | Trigger | Severity | Clears |
  | :--- | :--- | :--- | :--- |
  | `service_offline` | retained `state/online = false`, or silence beyond `SERVICE_SILENCE_S` | warning | on any message, or `online = true` |
  | `broker_disconnected` | mqtt `close`/`offline` | critical | on `connect` |
  | `ingest_gap` | `seq` discontinuity | info, warning when `missed > 25` | when the same topic is gap-free for 120 s |
  | `service_silent` | no `recv_ts` for a service beyond `SERVICE_SILENCE_S` | warning | on any message |
  | `topology_invalid` | malformed `$topology` | info | on the next valid document |
  | `command_timeout` | aggregated: N commands timed out in 5 min | info | after 5 min quiet |
- **Steps.** All platform alerts use `origin: 'platform'` and ids
  `platform/<service>/<type>` so a re-raise is idempotent. They never share an id with a
  service alert.
- **Acceptance.** Killing the RTA container produces `service_offline` within 3 s (last will)
  and no duplicate `service_silent` after 180 s.

#### 4.1.3 Sweeper

- **Responsibility.** Periodically reconcile platform alerts with reality.
- **Contract.** Every 10 s: for each configured service, compare `lastRecvTs` and `online`
  against the thresholds; for each open gap alert, close it if the topic has been gap-free
  for 120 s.
- **Steps.** Use wall clock. Never close a *service* alert — only the service can clear it.
  Guard against closing a platform alert whose condition will re-fire immediately (hysteresis
  of one sweep).
- **Acceptance.** With a service paused, exactly one `service_offline` exists; resuming clears
  it and does not re-raise.

### 4.2 Lifecycle subsystem

#### 4.2.1 State machine

```
        raise            clear
  (none) ─────▶ raised ──────▶ cleared
                  │               │
                  │ ack           │ ack
                  ▼               ▼
             acknowledged    acknowledged ──resolve──▶ resolved
                  │                                     ▲
                  └──────────── resolve ────────────────┘
```

Rules enforced in the store, not the UI:

- Acknowledge is allowed in `raised` **and** `cleared` (an operator may notice a transient
  after it self-cleared). It is rejected with 409 if already acknowledged, and if resolved.
- Resolve requires `ack_ts IS NOT NULL`. Attempting to resolve an unacknowledged alert
  returns 409 with `code: 'not_acknowledged'` and the UI offers "acknowledge and resolve".
- Resolve requires `resolution` of 3–500 characters and a `cause` from a fixed vocabulary
  (§4.2.3). Both are attributed to the researcher code.
- Re-raise after resolve creates a **new** alert only if the service sends a new `alert_id`.
  A re-raise under the same id reopens the same row and records a transition
  (`reopened`), preserving the earlier acknowledgement as history.
- Nothing is ever deleted.

#### 4.2.2 Attribution

- **Responsibility.** Security rubric: *"alerts correctly attribute resolution and
  acknowledgement"*.
- **Contract.** `ack_by`, `resolved_by` are researcher codes exactly as supplied. `ack_verified`,
  `resolve_verified` booleans record whether the ARL API confirmed the code.
- **Steps.** Resolution requires a *verified* code (fail closed) because it closes an incident.
  Acknowledgement accepts a well-formed but unverified code, recorded as unverified, because
  in a real control room the person is physically present and the API may be down. Both are
  logged.
- **Acceptance.** Resolving with `zzz-000` (unknown to the API) returns 403 and does not
  change the row. Acknowledging with it succeeds with `ack_verified = 0` and a visible mark.

#### 4.2.3 Cause vocabulary

- **Responsibility.** Make the audit table analysable rather than free text.
- **Contract.** A fixed list, extended per service:
  `weather`, `equipment_fault`, `maintenance`, `operator_error`, `environmental`,
  `power_event`, `crew_health`, `false_alarm`, `other`.
- **Steps.** The UI offers these as a select; the API validates membership and rejects others
  with 400 `invalid_cause`.
- **Acceptance.** A resolution with `cause: 'gremlins'` is rejected naming the allowed set.

### 4.3 Context subsystem (the 100 % band)

#### 4.3.1 Context pack

- **Responsibility.** Tell the researcher, on the alert card, everything needed to decide.
- **Contract.** `GET /api/alerts/:id/context` →
  ```ts
  interface AlertContext {
    alert: AlertRecord;
    measured: { key: string; value: number; unit: string | null;
                limit: number | null; limitKey: string | null;
                direction: 'above' | 'below' | null }[];
    history: { ts: number; value: number }[];        // 30 min around raised_ts
    siblings: { entity: string; value: number; state: 'ok'|'warn'|'crit'|'unknown' }[];
    related: { service: string; type: string; alert_id: string; ts: number }[];
    suggested_controls: { service: string; entity: string; control: string;
                          label: string; value: unknown; rationale: string }[];
    narrative: string;                                // one paragraph, generated from the above
  }
  ```
- **Steps.**
  1. `measured` comes from the payload plus the matching limit key resolved through `10`.
  2. `history` is `series()` for the alert's entity and stream, 30 min window, 60 buckets.
  3. `siblings` is the latest value of the same measure for peer entities, so a researcher can
     see "dish-042 is 335 K while the array sits at 301 K".
  4. `related` is other alerts within ±5 min across the services, which is how the storm
     narrative appears: RTA wind stow + OPG solar underperformance + LWM high wind.
  5. `suggested_controls` is a static table per alert type (see `23`/`33`/`43`), filtered to
     controls that currently exist in `$topology` and whose `availability()` is enabled.
  6. `narrative` is assembled from templates, not free LLM text, so it is deterministic and
     testable.
- **Acceptance.** For `rta/dish_temperature` the card shows: 335.2 K against 333 K warn / 343 K
  crit; a 30-minute sparkline rising; dish-042 versus the array mean; a correlated
  `dish_power` alert; and two buttons — `stow_dish` for dish-042 and `request_recalibration`
  — each with the rationale why ("stowing removes solar load; recalibration resets the
  receiver drift"). All executable, all attributed.

#### 4.3.2 Narrative templates

- **Responsibility.** Consistent, accurate, service-aware one-liners.
- **Contract.** `narrative(alert, context): string`, e.g.
  *"Dish 042 is 2.2 K above the warning limit and 0.3 K/second rising; 11 of 100 dishes are
  above the array median. Stowing the dish stops the slew that is generating the heat."*
- **Steps.** Compose from: the delta to the limit, the rate of change from `history`, the
  sibling comparison, and the suggested control's rationale. Never claim a cause the data does
  not support; when the cause is unknown say so.
- **Acceptance.** Unit tests assert every alert type produces a non-empty narrative with no
  `undefined` and no double spaces.

### 4.4 Delivery subsystem

#### 4.4.1 Annunciator board contract

- **Responsibility.** A permanently visible board that survives fault storms.
- **Contract.** The board renders, in this priority order: critical unacknowledged (flashing
  1.5 Hz) → warning unacknowledged → info unacknowledged → acknowledged-not-resolved →
  cleared-not-resolved collapsed behind a counter. Resolved alerts leave the board and remain
  in the log.
- **Steps.** Cap the visible rows at 4 with a "+N more" that expands. Group by service when
  more than 6 alerts are open, so a storm does not push the workspace off screen. Never
  block the workspace: the board is a banner, not a modal.
- **Acceptance.** With 40 simultaneous alerts the workspace is still reachable, the board
  shows 4 grouped rows, and nothing scrolls the page.

#### 4.4.2 Alert log and timeline

- **Responsibility.** Auditable history, and replay ticks.
- **Contract.** `GET /api/alerts?status=&service=&severity=&from=&to=&limit=`;
  `GET /api/alerts/timeline?from=&to=&service=` → `{ ts, alert_id, kind: 'raised'|'cleared'|'ack'|'resolved' }[]`.
- **Steps.** The log page shows one row per alert with raised/ack/resolve timestamps and both
  actors, and an expandable audit trail of every transition.
- **Acceptance.** Every transition listed in `alert_transition` is visible and ordered.

---

## 5. Data contracts

Alert identity, severity, status and the audit row shapes are unchanged from `server/src/types.ts`
(`AlertRecord`, `AlertTransition`). Additions:

```ts
interface AlertRecord {           // additions only
  ack_verified: 0 | 1;
  resolve_verified: 0 | 1;
  context?: AlertContext;         // computed on request, never stored
}
type TransitionAction = 'raised' | 'escalated' | 'cleared' | 'acknowledged'
                      | 'resolved' | 'reopened' | 'auto_cleared_unseen';
```

---

## 6. Failure modes

| Failure | Behaviour |
| :--- | :--- |
| Alert event arrives with an unknown `type` | Stored and shown with the raw type; no narrative; logged once |
| Same `alert_id` cleared twice | Second is a no-op with a transition note |
| Resolve without ack | 409 `not_acknowledged`; UI offers a combined action |
| ARL API down during resolve | 503 `api_unavailable`; the alert stays open — fail closed |
| ARL API down during ack | Accepted, `ack_verified = 0`, marked in the UI |
| 500 alerts in one minute | Board groups; DB writes are batched with the ingest flush |
| A service restarts and re-raises old ids | Reopen, not duplicate; transitions make it visible |

---

## 7. Test plan

- Unit: state machine — 12 transition pairs, each asserting allowed/denied and the resulting row.
- Unit: narrative for every service alert type (fixture per type, ~20 fixtures).
- Integration: publish a raised warning, assert one row, one WS alert frame.
- Integration: acknowledge with a valid code, then resolve; assert both actors and 5 transitions.
- Integration: resolve without ack returns 409.
- Integration: kill a service, assert `service_offline` then clear on restart.
- Security: resolve with an unknown code returns 403 and leaves the row open.

---

## 8. Open decisions

- **Should cleared alerts auto-resolve?** No. The rubric requires a researcher to say how it
  was handled; auto-resolution would falsify the audit trail.
- **Should acknowledgement be allowed without any code?** No. It is the record of who
  responded.
- **Where is the cause vocabulary defined?** Shared constant in `server/src/types.ts`, mirrored
  in `web/src/lib/types.ts`, asserted equal by a test in `51`.