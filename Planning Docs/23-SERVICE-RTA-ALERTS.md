# 23 — RTA Alerts

**Service.** Radio Telescope Array.

**Component.** The eight alerts `arl-rta-spec.pdf` §5 defines, the RTA-specific context that turns
each one into a decision, and the grouping that keeps an array of 100 dishes readable during a
fault drill.

**Owner files.** `server/src/alerts/engine.ts` (§ RTA context), `server/src/services/rta.ts`
(`alertContext`, `suggestedControls`), `web/src/components/Annunciator.tsx`,
`web/src/components/AlertAction.tsx`, `web/src/pages/Rta.tsx` (alert gutter + overlay).

**Rubric.** Alerts 10 % of the service score. 100 % band: *"alerts give the researcher the context
to decide what to do"*. 75 % is "all alert types supported" — that is the floor, not the target.

**Depends on.** `05` (lifecycle, `AlertContext`, attribution), `10` (limit keys and values),
`04` (history series), `21` (the controls the context proposes), `20` §4 (image quality).

---

## 1. Boundary

In scope: receiving the eight service alerts verbatim; assembling RTA-specific context; grouping
and prioritising them for a 100-dish array; binding each alert type to the controls that address
it and filtering those bindings by current guards; presenting alerts inside replay.

Out of scope: deciding *when* a dish is too hot, a scan has degraded, or the wind has risen. The
service owns those thresholds and the platform must never re-derive, soften or suppress them
(`05` §1). The platform is a follower for these alerts and an owner only of transport-health
alerts.

---

## 2. The eight alerts (authoritative)

Everything in this table comes from `arl-rta-spec.pdf` §5. The platform stores `type` as sent and
must not translate it.

| Alert | `type` | Level | Limit keys (default) | Raise / clear | `metadata` |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Availability | `availability` | critical | `rta.availability.min_active` (80 dishes) | Fewer dishes in service than the minimum for **60 s**; clears at or above it for 60 s | — |
| Wind stow | `wind_stow` | warning | `rta.wind_stow.gust_ms` (15 m/s), `rta.wind_stow.release_ms` (10 m/s) | Gust above 15 m/s for 60 s; clears when gust below 10 m/s for **10 min** | — |
| Dish offline | `dish_offline` | warning | none | Dish stopped communicating or lost power; clears when it recovers | `subarray, fault_code, row, col, scan_id?` |
| Dish temperature | `dish_temperature` | warning / critical | `warn_k` (333 K), `crit_k` (343 K) | Above the limit for **120 s**; clears **5 K below** the warning limit | `subarray, fault_code, row, col, scan_id?` |
| Dish power | `dish_power` | warning | `rta.dish_power.max_w` (5000 W) | Above the limit for **120 s**; clears below it | `subarray, fault_code, row, col, scan_id?` |
| Dish movement | `dish_movement` | warning | none | A slew timed out or the drive stalled; clears on the **next successful slew** | `subarray, fault_code, row, col, scan_id?` |
| Dish calibration | `dish_calibration` | info / warning | `rta.calibration.max_age_h` (168 h) | Info when the last calibration is older than the limit (`metadata.last_calibration`); **warning** when a calibration failed; clears on a successful calibration | `subarray, fault_code, row, col, scan_id?, last_calibration` |
| Dish scan | `dish_scan` | warning | `rta.scan.min_snr_db` (3 dB) | During a scan: the dish left the scan, has a fault, sent no samples for **30 s**, or its **mean SNR over 60 s** is below the limit. Also raised for a minute after a scan fails because its target set. Clears when the scan ends or the dish recovers | `subarray, fault_code, row, col, scan_id` |

Wire shape (`arl/rta/events/alert`): `{ alert_id, type, severity, state: raised|cleared, value,
limit, unit, message, metadata }`. Escalation is a re-raise of the **same** `alert_id` at a higher
severity (`05` §4.2.1), which is how `dish_temperature` and `dish_calibration` move band and how
`availability` behaves if the array degrades further.

**Two of the eight are array-level and six are per-dish.** That asymmetry is the whole design
problem: one `wind_stow` is a single row, while a scenario fault plus a heatwave can raise
`dish_temperature` on forty dishes at once.

---

## 3. Whose decision is it?

The context pack exists to answer "what should I do?", and the honest answer differs per type. This
classification drives §6.3.

| Alert | Who acts | What the researcher can actually do |
| :--- | :--- | :--- |
| `wind_stow` | nobody — the array protects itself | Wait. `stow_dish false` is rejected during wind stow, and a scan cannot start. The useful information is *how long*: the gust trend against 15 m/s, and the 10-minute-below-10 m/s release condition |
| `availability` | research/operations | Bring dishes back: `enable_dish`, `request_recalibration`, fix faults in the simulator |
| `dish_offline` | maintenance | Diagnose; `enable_dish` after recovery. Usually the platform's `service_silent` is the faster signal |
| `dish_temperature` | operations, urgently | `stow_dish` (removes slew and solar load), `request_recalibration` if the receiver is drifting, or `assign_subarray` to pull it out of the scan |
| `dish_power` | operations | `stow_dish` or `enable_dish false` to drop the draw |
| `dish_movement` | maintenance | `request_recalibration` once the drive recovers; `enable_dish false` if it is stuck |
| `dish_calibration` | maintenance, scheduled | `request_recalibration` — and it is the *cheapest* fix in the system, so it should be one click from a grouped row of twelve |
| `dish_scan` | depends on the cause | If `fault_code` is set: `enable_dish false`/`assign_subarray` to remove it. If SNR alone: `request_recalibration`. If the whole scan is bad: `cancel_scan` |

---

## 4. Current foundation

- Alerts arrive on `arl/rta/events/alert`, are stored verbatim keyed by the service `alert_id`, and
  escalation increments `escalate_count` (`05` §2).
- The `alert` table already carries `raised_ts, cleared_ts, ack_ts, ack_by, resolved_ts,
  resolved_by, resolution, cause, origin, last_ts, escalate_count` — the full audit columns the
  alert-system rubric names.
- `GET /api/alerts`, `POST /api/alerts/:id/ack`, `POST /api/alerts/:id/resolve` exist.
- `Annunciator.tsx` renders unacked alerts with the 1.5 Hz flash; `AlertAction.tsx` is the
  acknowledge/resolve modal.
- The RTA page shows nothing about alerts beyond whatever the global annunciator displays.

---

## 5. Gaps against the rubric

| Gap | Rubric effect | Fix |
| :--- | :--- | :--- |
| Alert card shows value and limit only | Caps at 75 % — "all alerts supported" | `AlertContext` per type (§6.3) |
| No RTA alert knowledge on the RTA page | 40 temperature alerts look like 40 unrelated rows | Array-level grouping with worst-case and count (§6.5) |
| No alert → control binding, and no guard awareness | A researcher is told nothing, or told to `stow_dish` during wind stow, which fails | Bindings filtered through `06` §4.3.2 guards (§6.4) |
| `dish_scan` is on/off per dish, but the interesting question is *whether the image is usable* | Alert does not connect to the visualisation | Bind to `rta.image_quality` and the canvas HUD (`22` §2) |
| `dish_calibration` info alerts are the most numerous and the least urgent | Annunciator drowns | Collapse info-level dish alerts behind a counter, never on the flashing board |
| Alerts are invisible in replay | Replay 100 % band explicitly requires "alerts and events shown in the context of the replay" | `23` §6.7 plus `07` §4.5 |
| Alert rows are not marked when the clearing was automatic | Ambiguous audit | `origin: 'service'` plus an "auto-cleared" tag in the row |

---

## 6. Decomposition

### 6.1 Intake and identity

#### 6.1.1 Verbatim capture

- **Responsibility.** Store exactly what the service sent, and nothing the platform imagined.
- **Contract.** `AlertEvent` is validated for shape only (`type` is a string, `severity ∈
  {info, warning, critical}`, `state ∈ {raised, cleared}`); an unknown `type` is accepted and
  stored, rendered generically, with `context_quality: 'generic'`.
- **Steps.** On `raised`: upsert by `alert_id`; if the row exists and is resolved, reopen it and log
  a `reopened` transition (`05` §4.2.1). On `cleared`: set `cleared_ts` and `last_ts`; never delete.
  Copy `value, limit, unit, message, metadata` into the row.
- **Acceptance.** A `dish_temperature` raised, escalated, then cleared produces one row with
  `escalate_count = 1`, `raised_ts` < `cleared_ts`, and `severity = 'critical'`.

#### 6.1.2 Limit resolution

- **Responsibility.** Show the limit as the *service* knew it, not as the platform guessed.
- **Contract.** `limit_meta` rows from `GET /v1/alert-limits/rta`, normalised to both short
  (`dish_temperature.warn_k`) and prefixed (`rta.dish_temperature.warn_k`) keys (`10` §4).
- **Steps.** Prefer the `limit` value on the alert payload. When it is null (types that carry no
  limit), fall back to `limit_meta` and then to the service config defaults in §2. Record which
  source was used in `measured[].limitSource`, because a stale limit is a real failure mode during
  an API outage.
- **Acceptance.** With the API unreachable at boot, a `dish_temperature` alert still renders
  "333 K (from cache, 14 min old)".

### 6.2 Grouping model

#### 6.2.1 The grouping key

- **Responsibility.** Reduce 100 dishes × 6 types into rows a human can act on.
- **Contract.** `groupKey = type + ':' + (metadata.subarray ?? '*')` for dish alerts; `type` alone
  for the two array alerts.
- **Steps.** The annunciator shows one row per `groupKey` with `count`, `worstSeverity`, the
  worst-affected entity, and `firstRaised`. Expanding a row lists the member alerts, each of which
  keeps its own lifecycle and its own `alert_id`. Acknowledging a group acknowledges every member;
  resolving a group requires a per-member cause unless all members share one.
- **Acceptance.** Injecting `power_fault peak_w 7000` across `main` produces a single
  "Dish power · 18 dishes · main" row; expanding shows 18 rows; acknowledging the group records 18
  acknowledgements attributed to the same researcher and one `ack_group_id`.

#### 6.2.2 Ordering

- **Responsibility.** Priority that matches consequence, not arrival time.
- **Contract.** Fixed rank: `availability` > `wind_stow` > `dish_temperature(critical)` >
  `dish_offline` > `dish_power` > `dish_movement` > `dish_scan` > `dish_temperature(warning)` >
  `dish_calibration(warning)` > `dish_calibration(info)`.
- **Steps.** `wind_stow` sits second because it invalidates controls the other rows suggest. Within
  a rank, order by count then by `raised_ts`.
- **Acceptance.** During the example scenario, the board order is `wind_stow`, then the grouped
  `dish_temperature` for dish-042's sub-array, then everything else.

### 6.3 Context subsystem (the 100 % band)

#### 6.3.1 The RTA context pack

- **Responsibility.** Fill `AlertContext` (`05` §4.3.1) with RTA-specific, verifiable content.
- **Contract.** The same interface for every type; the *fields populated* differ by type, and
  `context_quality` states which parts are meaningful.

| `AlertContext` field | RTA source |
| :--- | :--- |
| `measured` | the alert's own `value`/`limit`/`unit`, plus the two companions that make it interpretable: for `dish_temperature` the `system_temperature_k`; for `dish_scan` the `snr_db` and `scan_progress`; for `dish_power` the `elevation_rad` |
| `history` | `series('rta', entity, 'telemetry', key, raised_ts − 30 min, raised_ts)` — 60 buckets (`04` §4.6) |
| `siblings` | for dish alerts, the current value of the same measure across all 100 dishes with band classification; for array alerts, the previous 6 hours of the same measure |
| `related` | other alerts within ±5 min, cross-service included (§6.3.3) |
| `suggested_controls` | §6.3.4 |
| `narrative` | §6.3.2 |

- **Steps.** Assemble lazily on request (`GET /api/alerts/:id/context`), cache for 15 s, and
  invalidate on any telemetry frame for the same entity. Degrade field by field: if `series()`
  times out, return the pack without `history` and set `context_quality: 'partial'` rather than
  failing the request.
- **Acceptance.** Every one of the eight types returns a pack with a non-empty `measured`,
  `siblings`, `suggested_controls` and `narrative` within 150 ms on a 5-day database.

#### 6.3.2 Narrative templates, per type

- **Responsibility.** One paragraph that states the fact, the comparison, and the reason for the
  recommendation — with no invented cause.
- **Contract.** `narrative(alert, ctx)` composed from fixed clauses. Eight templates:

| Type | Template |
| :--- | :--- |
| `availability` | "{active} of {min} dishes required are in service, down {delta} in the last 30 min. {n} are disabled and {m} report a fault code." |
| `wind_stow` | "Gusts are {gust} m/s against 15 m/s; the array stowed itself. It releases after gusts stay under 10 m/s for 10 minutes — {(t)} if the trend holds. Scans cannot start while stowed." |
| `dish_offline` | "{entity} has not reported for {t}. Its last value was {v}. {k} other dishes are also offline." |
| `dish_temperature` | "{entity} is {delta} K above the {band} limit and {rate} K/min {direction}; {n} of 100 dishes are above the array median. It is drawing {w} W at {el}° elevation." |
| `dish_power` | "{entity} is drawing {w} W against a {limit} W limit while slewing; the array median is {med} W." |
| `dish_movement` | "{entity} failed to reach its commanded position: {err}° remaining after {t}. The drive reports {fault}." |
| `dish_calibration` | "{entity} was last calibrated {h} h ago against a {limit} h limit. {n} dishes are in the same state." |
| `dish_scan` | "During {scan}, {entity} {reason}. Mean SNR is {snr} dB against a {limit} dB limit; the image is currently {coverage}% covered." |

- **Steps.** Format numbers with units; never emit `undefined`, `NaN`, or a doubled space
  (`05` §4.3.2 acceptance applies verbatim). When `history` is missing, drop the rate clause
  rather than guess.
- **Acceptance.** Snapshot test per type against fixture packs; a pack with `history: []` still
  yields a grammatical sentence.

#### 6.3.3 Cross-service relations

- **Responsibility.** Show that one physical event is behind several services' alerts.
- **Contract.** `related` is computed over a ±5 min window and keyed by a shared *cause hint*:
  `env.storm → {rta.wind_stow, lwm.high_wind, opg.solar_underperformance}`,
  `env.heatwave → {rta.dish_temperature, mhe.room_condition, opg.battery_temperature}`,
  `power.* → {rta.dish_power, mhe.habitat_fault, opg.supply_shortfall}`.
- **Steps.** Cause hints are a static table in `server/src/alerts/relations.ts`, matched on
  `type` + service only — never on simulated value. Each related entry renders as a link that
  switches service and selects the alert.
- **Acceptance.** Loading `scenarios/example.toml` raises `wind_stow`, `lwm/high_wind` and
  `opg/solar_underperformance` within minutes of each other, and each card lists the other two.

#### 6.3.4 Suggested controls, per type

Rendered as buttons that dispatch through `06`; each carries a `rationale` string shown on hover,
and each is filtered twice: it must exist in `$topology`, and its guard must currently pass
(`06` §4.3.2).

| Type | Suggested controls (value) | Rationale |
| :--- | :--- | :--- |
| `availability` | `enable_dish true` × faulty-off; `request_recalibration true` × stale; `stow_dish true` × mechanically suspect | "In service" is the measure; each button addresses one of its three causes |
| `wind_stow` | `cancel_scan true` (if `running`), `pause_scan true`, nothing that moves a dish | Stowing is latched by the service; the only useful action is to stop work that will fail |
| `dish_offline` | `enable_dish false` then `true`; `request_recalibration true` | Reset the enabled path, then recalibrate on return |
| `dish_temperature` | `stow_dish true`; `request_recalibration true`; `assign_subarray` to `maintenance` | Stowing removes the slew and solar load; recalibration resets receiver drift |
| `dish_power` | `stow_dish true`; `enable_dish false` | Both drop the draw; stow is reversible without re-enabling |
| `dish_movement` | `enable_dish false`; `request_recalibration true` | Take the dish out of service; recalibrate once the drive recovers |
| `dish_calibration` | `request_recalibration true` (grouped, one batch) | Cheapest fix in the system; 120 s each, and a batch resolves twelve at once |
| `dish_scan` | conditional — see §6.3.5 | The right control depends on why the dish is failing |

- **Acceptance.** A `dish_temperature` alert for a stowed dish during wind stow offers **no**
  `stow_dish` button (guard `precondition_failed`) and instead shows "stowed by wind stow; the
  array will release it".

#### 6.3.5 `dish_scan` cause discrimination

- **Responsibility.** `dish_scan` is one alert type standing for four different faults; the card
  must say which.
- **Contract.** `cause_hint ∈ {left_scan, fault, silent, low_snr, target_set}` derived from the
  payload `< 5 min` history of that dish and the scan state.
- **Steps.** Priority: `fault_code != none` → `fault`; `lat(last telemetry)` older than 30 s →
  `silent`; dish not in `subarray/members` → `left_scan`; otherwise → `low_snr`. The
  `target_set` case comes from the scan `failed` event, not from the telemetry.
- **Acceptance.** With `receiver_fault` injected mid-scan, the card says `fault` and offers
  `enable_dish false`; with a rising `system_temperature_k` and no fault code it says `low_snr`
  and offers `request_recalibration`.

### 6.4 Alert-to-control binding

- **Responsibility.** Turn §6.3.4 into a testable table instead of strings in JSX.
- **Contract.**
  ```ts
  interface ControlSuggestion {
    service: 'rta'; entity: string; control: string;
    value: unknown; label: string; rationale: string;
    guard: (ctx: RtaSnapshot) => { ok: true } | { ok: false; why: string };
  }
  ```
  Declared in `server/src/services/rta.ts` as `RTA_SUGGESTIONS`, keyed by `type`.
- **Steps.** Server-side, because the guard needs the live snapshot and the topology; the client
  receives only suggestions that already passed. Each suppressed suggestion is returned with
  `ok: false` and `why`, so the card can explain itself ("stow unavailable: dish is stowed").
- **Acceptance.** Unit test per entry: a passing snapshot yields the suggestion; a failing one
  yields `ok: false` with a non-empty `why`, and the endpoint never emits a suggestion the
  dispatch path would reject with `precondition_failed`.

### 6.5 Array-level presentation

#### 6.5.1 The RTA alert gutter

- **Responsibility.** Keep the array-level state visible on the page where the affected dishes are.
- **Contract.** A fixed strip under the RTA header showing: `availability` progress
  (`87 / 80`), `wind_stow` state with a gust sparkline against the 15 m/s line, and the count of
  dish alerts by type as clickable chips.
- **Steps.** Clicking a chip filters the dish matrix (`22` §3.3 `f` key) and scrolls the annunciator
  to that group. The gutter is part of the workspace, not the global annunciator, because array
  health is a property of this service's page.
- **Acceptance.** During a wind stow the gutter shows the gust trend and the §6.3.2 release
  estimate; clicking the 12-dish calibration chip selects exactly those 12 cells.

#### 6.5.2 Canvas overlay

- **Responsibility.** Connect an alert to the thing it damages.
- **Contract.** `dish_scan` and `dish_temperature` alerts mark the affected dishes in the matrix,
  and `dish_scan` additionally draws a "degraded" badge on the scan canvas HUD naming the count of
  contributing dishes under alert.
- **Steps.** The HUD badge links to the grouped alert. No overlay if no scan is running.
- **Acceptance.** Injecting `receiver_fault` on 5 dishes mid-scan puts "5 dishes degraded" on the
  HUD within one telemetry frame of the first `dish_scan`.

### 6.6 Clearing, acknowledgement and audit

- **Responsibility.** The rubric's audit columns must be honest even when the service clears the
  condition before anyone looks.
- **Contract.** Service-cleared alerts keep `cleared_ts` and stay `acknowledged`-or-`raised` until
  a human acts; `status` is derived, never overwritten (`05` §4.2.1).
- **Steps.** An auto-cleared, unacknowledged alert stays on the board with an `AUTO-CLEARED` tag and
  a dimmed flash. It is still resolvable, and the resolution prompt pre-fills
  `cause: 'equipment_fault'` only when the `fault_code` supports it.
- **Acceptance.** A `dish_temperature` that clears on its own 3 minutes after raising remains on the
  board, is acknowledged 10 minutes later, and the log shows `raised_ts` < `cleared_ts` < `ack_ts`
  < `resolved_ts` with both researchers attributed.

### 6.7 Alerts inside replay (D-8)

- **Responsibility.** Satisfy *"alerts and events shown in the context of the replay"* for this
  service.
- **Contract.** During a replay watch of `rta`, the annunciator renders alerts whose `raised_ts` is
  at or before `virtualNow` and whose `cleared_ts` is null or after it — i.e. exactly the set an
  operator would have seen at that moment. A tick lane under the scrubber plots raises and clears.
- **Steps.** Purely `07` §4.5's `alertsAsOf(cursor)`; the RTA-specific part is that grouped rows
  must recompute their `count` at the cursor rather than showing the present-day total.
- **Acceptance.** Scrubbing to the middle of the wind stow shows the `wind_stow` row as raised;
  scrubbing to 15 minutes later shows it cleared and the scan `failed` event in the event lane.

---

## 7. Data contracts

```ts
// GET /api/alerts/:id/context  → AlertContext (05 §4.3.1) plus, for rta:
interface RtaAlertContext extends AlertContext {
  context_quality: 'full' | 'partial' | 'generic';
  cause_hint: 'left_scan' | 'fault' | 'silent' | 'low_snr' | 'target_set'
            | 'wind' | 'not_applicable';
  group: { key: string; count: number; worstSeverity: AlertSeverity;
           ackedCount: number; resolvedCount: number } | null;
  limits_used: { key: string; value: number; source: 'payload' | 'api' | 'cache' | 'default' }[];
}
```

`measured[].limitSource` and `limits_used` exist for one reason: during an API outage the card must
say which limit it is comparing against, because a wrong limit produces confident wrong advice.

---

## 8. Failure modes

| Failure | Symptom | Handling |
| :--- | :--- | :--- |
| Alert arrives before `$topology` | No sub-array or dish meta to group by | Group under `*`; backfill the group when topology lands within 60 s |
| `alert_id` reused for a different condition | Audit row contaminated | Detected when `type` differs on re-raise; log a `identity_conflict` and open a new row |
| Clearing event lost (broker gap) | Alert stuck raised forever | `05`'s gap sweep reconciles against `global/state/active_alerts`, which is the authoritative raised set |
| 100 `dish_calibration` info alerts at once | Annunciator unusable | Info dish alerts never enter the flashing board; they appear as a counted chip (§6.5.1) |
| Limit changed mid-alert | Card compares against a different number than the service used | `limits_used` records the source and timestamp; card shows both when they differ |
| `related` produces a false correlation | Researcher chases a phantom | Relations match type + service only; the card words it as "co-occurring", never "caused by" |
| Suggestion dispatches after the guard changes | `precondition_failed` on a button the card offered | Re-check the guard in the dispatch path; the failure is rendered in place with the reason |
| Context endpoint slow on a large DB | Alert modal stalls | Per-field timeouts, `context_quality: 'partial'`, and the alert row itself always renders from the stored columns alone |

---

## 9. Test plan

| # | Test | Type |
| :--- | :--- | :--- |
| 1 | Each of the eight types round-trips raise → escalate → clear into one row with correct `escalate_count` | unit (`engine`) |
| 2 | `narrative()` snapshot for all eight types, plus the no-history variant | unit |
| 3 | Every `RTA_SUGGESTIONS` entry produces a dispatchable command against a fixture snapshot | unit |
| 4 | A suggestion whose guard fails returns `ok: false` with a `why` and is never dispatched | unit |
| 5 | Grouping: 18 `dish_power` alerts in `main` collapse to one row of count 18 | unit |
| 6 | Ordering rank is respected when all eight types are raised | unit |
| 7 | `cause_hint` discrimination across the four `dish_scan` situations | unit |
| 8 | Context endpoint returns `full` quality for a seeded DB and `partial` with `series()` stubbed to reject | integration |
| 9 | `alertsAsOf(cursor)` reconstructs the mid-storm state during a replay watch | integration |
| 10 | Scenario drill: `example.toml` raises `wind_stow` + `lwm/high_wind` + `opg/solar_underperformance` and each card lists the other two | end-to-end |
| 11 | Group acknowledge is atomic: 18 members, one `ack_group_id`, all attributed | integration |
| 12 | Auto-cleared-but-unacked alert stays on the board and is resolvable | integration |

---

## 10. Open decisions

| # | Decision | Recommendation |
| :--- | :--- | :--- |
| 1 | Group acknowledge: one row per member, or a parent row? | Members only, plus `ack_group_id` — the audit table stays per-alert, which is what the rubric inspects |
| 2 | Should `dish_calibration` info alerts be acknowledged at all? | Yes, but only from the chip, so the flashing board stays honest |
| 3 | Where does the cause-vocabulary pre-fill come from? | `fault_code` when present, otherwise no pre-fill; guessing a cause defeats the audit |
| 4 | Are cross-service relations worth the false positives? | Yes — it is the strongest available demonstration of platform-wide context, provided the wording stays "co-occurring" |
| 5 | Alert retention | Never delete; the resolved log is evidence for the architecture and alert-system marks |