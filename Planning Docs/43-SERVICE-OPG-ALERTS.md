# 43 — OPG Alerts

**Service.** On-demand Power Generation.

**Component.** The seven alerts in `arl-opg-spec.pdf` §4, the context that makes each one
actionable, and OPG's own alert problem — which is neither volume (RTA) nor cascade (MHE) but
**anticipation**: every alert on this service can be predicted minutes to days before it raises.

**Owner files.** `server/src/alerts/engine.ts` (§ OPG context), `server/src/services/opg.ts`
(`OPG_SUGGESTIONS`), `server/src/alerts/relations.ts`, `web/src/components/Annunciator.tsx`,
`web/src/pages/Opg.tsx` (alert gutter + flow overlay).

**Rubric.** Alerts 10 % of the service score. 100 % band: *"alerts give the researcher the context
to decide what to do"*.

**Depends on.** `05` (lifecycle, `AlertContext`), `10` (limits), `40` (§ autonomy, burn,
performance ratio, reconciliation), `41` (controls), `42` (flow diagram, SOC trajectory).

---

## 1. Boundary

In scope: verbatim capture of the seven service alerts; OPG context including **projection**;
alert→control bindings filtered by guards; presentation on the flow diagram and the SOC line.

Out of scope: the plant's own decisions. Generation priority, automatic backup and curtailment are
the service's; the platform observes and explains them. It must never re-derive "the load cannot be
covered" — the service raises `supply_shortfall` and the platform reports it.

---

## 2. The seven alerts (authoritative)

**Every alert carries the current `supply_mode` in its metadata.**

| Alert | `type` | Level | Limit keys (default) | Raise / clear | Other metadata |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Supply shortfall | `supply_shortfall` | critical | none | The load cannot be covered by the available generation; clears after **5 min covered** | `unserved_w` |
| Backup active | `backup_active` | info | none | The diesel generators are supplying power; clears when they are off | — |
| Solar underperformance | `solar_underperformance` | warning | `opg.solar.min_ratio` (0.8) | Irradiance **> 200 W/m²** and output below the ratio of expected for **15 min**; clears above ratio **+ 0.05** for **15 min** | `expected_w`, `output_w` |
| Low battery | `low_battery` | warning / critical | `opg.battery.warn_pct` (30); **critical below the battery reserve** | SOC below the warning limit; **critical below the reserve**; clears **5 points above** the warning limit | `reserve_pct` |
| Battery temperature | `battery_temperature` | warning | `opg.battery.max_temp_k` (318 K) | Above the limit for **10 min**; clears **3 K below** | — |
| Low fuel | `low_fuel` | warning | `opg.fuel.min_pct` (25 %) | Fuel below the limit; clears when refuelled above it | — |
| Generator fault | `generator_fault` | critical | none | A start failed, or a running generator faulted; clears on the next **successful start** | — |

### 2.1 What is unusual about this set

- **`backup_active` is `info` on purpose.** Generators running during a cloudy night is the plant
  working correctly. An annunciator that treats it as an alarm teaches the operator to ignore the
  board.
- **`low_battery` escalates to critical against a *state* value** (`reserve_pct`), not a fixed limit.
  The threshold moves when a researcher moves it, so the card must show which reserve applied.
- **`solar_underperformance` cannot fire at night** (irradiance > 200 W/m²). A "no solar at 02:00"
  observation is not an alert and must never be raised by the platform.
- **`generator_fault` only clears on a successful start.** A repaired generator that is not restarted
  stays in fault by design, so nothing should "clear" it optimistically.
- **Four of the seven are predictable from `40`'s measures**: `low_battery` from `autonomy_hours`,
  `low_fuel` from `diesel_burn` days-to-empty, `solar_underperformance` from
  `performance_ratio`, and `supply_shortfall` from the margin projection. That is the entire design
  thesis of this document.

---

## 3. Whose decision is it?

| Alert | Who acts | What the researcher can actually do |
| :--- | :--- | :--- |
| `supply_shortfall` | operator, immediately | `start_generator`, `load_shed`. Lowering the reserve is a genuine last resort and must be offered as one |
| `backup_active` | nobody | Nothing. The card explains what the generators are covering and for how long the fuel lasts |
| `solar_underperformance` | maintenance | If disabled: `enable_solar_array`. If the inverter reports `fault`: nothing — it is a repair. If the ratio is drifting down: soiling, and there is no control for rain |
| `low_battery` | operator | `load_shed true` first (cheapest), then `start_generator`; or lower the reserve if it is the reserve that made this critical |
| `battery_temperature` | operator | Reduce throughput: `load_shed true`, and avoid a hard charge cycle by leaving the priority alone until it cools |
| `low_fuel` | logistics | `load_shed true` and `generation_priority 'solar_first'` to stop burning; wait for the 7-day delivery. The card must do the arithmetic of whether the fuel outlasts the gap |
| `generator_fault` | maintenance | `load_shed true` and cover from the bank/solar; retry `start_generator` only if fuel allows |

---

## 4. Current foundation

- Verbatim capture and the shared lifecycle are in place (`05` §2).
- The OPG page has no alert surface; it shows a `fuel < 20` coloured datum against a **hard-coded**
  threshold where the service limit is 25 % — part of D-10, fixed in `42` §2.
- No alert-to-visualisation link, so an alert never points at the flow diagram or the SOC line where
  its cause is visible.

---

## 5. Gaps

| Gap | Rubric effect | Fix |
| :--- | :--- | :--- |
| Value/limit only, no projection | Caps at 75 % | §6.3, where projection is the core of the context |
| Hard-coded fuel threshold (D-10) | The page and the service disagree about "low" | Read limits from `10` |
| `backup_active` shares the alarm styling | Operators learn to ignore the board | §6.5 |
| No link from an alert to the energy flow / SOC line | The cause is one click away and the click does not exist | §6.6 |
| A platform-raised "solar low at night" temptation | Would contradict the service | Explicit rule: the platform never raises energy alerts; §6.1 |
| No consequence view for `supply_shortfall` | "Critical" without "what is unserved and for how long" | §6.3.2 |
| Alerts absent from replay | Replay 100 % band | §6.7 |

---

## 6. Decomposition

### 6.1 Intake (with an extra restraint)

- Verbatim shape-only validation, `alert_id` identity, escalation by re-raise — as in `23` §6.1.
- **The platform raises no OPG condition alerts of its own.** It may add *informational* context
  rows (e.g. "SOC will reach the reserve in 41 min") as **advisories**, which are not alerts and do
  not enter the alert table. The distinction keeps the audit trail faithful to the service.
- Metadata handling is stricter than elsewhere because `supply_mode` is on every OPG alert: it is
  stored and rendered on the card, since "the load was uncovered *while in diesel mode*" means
  something different from the same number in solar mode.

### 6.2 Anticipation: the projection block

- **Responsibility.** State, on the card, what the alert is *about to become*.
- **Contract.** `projection` on the context pack, computed per alert type:

  | Alert | Projection |
  | :--- | :--- |
  | `low_battery` | minutes to the reserve at the current net draw; the generator start it will trigger; the autonomy remaining afterwards |
  | `low_fuel` | hours of running at the current output; days to empty at the 7-day mean burn; the next scheduled delivery and how much it adds |
  | `solar_underperformance` | the ratio trend over 24 h and 7 days, and whether it is a step (fault) or a drift (soiling) |
  | `supply_shortfall` | unserved kWh so far this episode, and the time to coverage if `start_generator` were issued now |
  | `backup_active` | litres burned so far this episode and the fuel remaining afterwards |
  | `battery_temperature` | K/hour slope and the estimated time back inside the limit at the current throughput |
  | `generator_fault` | whether a retry is possible now (fuel, not already starting) and what the bank can cover meanwhile |

- **Steps.** Every projection is a closed-form calculation over `40`'s measures plus live state; if
  an input is missing the projection is omitted with `reason: 'insufficient_data'` rather than
  estimated from a default.
- **Acceptance.** A `low_battery` card during a night drain states the minutes to the reserve within
  ±15 % of the actual time the generators started.

### 6.3 Context subsystem (the 100 % band)

#### 6.3.1 The OPG context pack

| `AlertContext` field | OPG source |
| :--- | :--- |
| `measured` | the alert's own value/limit plus the quantities that explain it: SOC **with `reserve_pct` and the warn limit**; fuel **with litres and hours at the current output**; ratio **with `expected_w` and `output_w`**; battery temperature **with `battery_power_w` (the throughput that heats it)** |
| `history` | 2 hours for SOC/fuel/temperature (the sawtooth needs the longer window), 24 h for the ratio |
| `siblings` | the other sources' contribution for comparison — "solar 210 kW of a 640 kW load, diesel 0, battery −430 kW" |
| `related` | co-occurring alerts (§6.3.3) |
| `suggested_controls` | §6.3.4 |
| `narrative` | §6.3.2 |

#### 6.3.2 Narrative templates

| Type | Template |
| :--- | :--- |
| `supply_shortfall` | "{unserved} W uncovered in {mode} mode; the bank is at {soc} % with a {reserve} % reserve, solar is {solar} W and the generators are {gen}. Unserved so far this episode: {kwh} kWh." |
| `backup_active` | "Generators supplying {w} W for {t}; {litres} L burned, {fuel} % left ≈ {h} h at this output. The bank is {soc} % and {direction}." |
| `solar_underperformance` | "Solar delivers {out} W against an expected {exp} W ({ratio} of expectation) at {irr} W/m²; the array has averaged {ratio7} over 7 days and the inverter reports {inv}. {trend}" |
| `low_battery` | "State of charge is {soc} % against a {warn} % warning and a {reserve} % reserve; at the current {net} W draw it reaches the reserve in ≈ {t} and the generators will start." |
| `battery_temperature` | "The bank is {temp} K against a {limit} K limit, at {thr} W throughput; it has risen {rate} K/h and returns inside the limit in ≈ {t} at this throughput." |
| `low_fuel` | "Fuel is {pct} % ({litres} L) against a {limit} % limit; at the 7-day mean burn of {lpd} L/day that is {days} days. The next delivery is {when} and adds up to {l} L." |
| `generator_fault` | "The generators {what}. {ow} W of load is currently covered by {source}; the bank can carry it for ≈ {t}. A retry is {possible/blocked: reason}." |

Rules as elsewhere: no invented cause, no `undefined`, drop a clause rather than guess.

#### 6.3.3 Cross-signal relations

| Relation | Rendering |
| :--- | :--- |
| `low_battery` then `backup_active` | One incident: "the bank reached the reserve and the automation started the generators" — the expected sequence, so the card says "expected behaviour", not "second fault" |
| `low_fuel` + `backup_active` | The dangerous pair: burning the last fuel to cover a load. The card states the hours of overlap before the tank is empty |
| `solar_underperformance` + `battery_temperature` | Charging hard into a hot bank is not the cause of low solar, but the pair explains a rise in temperature |
| `supply_shortfall` + `mhe/habitat_fault(power_distribution)` | Cross-service: the habitat lost power distribution at the same time. `41` §5 already asserts the shed→water link; this is the observation |
| `backup_active` + `lwm/high_wind` or `rta/wind_stow` | The storm narrative: one weather event behind three services |

**Acceptance.** During the example scenario's storm, the `backup_active` card lists `rta/wind_stow`
and `lwm/high_wind` as co-occurring, and the `low_fuel` card states the hours of fuel left at the
current output.

#### 6.3.4 Suggested controls, per type

| Type | Suggested controls | Rationale |
| :--- | :--- | :--- |
| `supply_shortfall` | `start_generator true`; `load_shed true`; `battery_reserve` lowered — **labelled last resort** | Start is fastest; shedding reduces the deficit; lowering the reserve releases stored energy at the cost of the emergency margin |
| `backup_active` | **none**, and `stop_generator` shown as suppressed with "the generators are covering the load" | Offering a stop here invites a self-inflicted shortfall |
| `solar_underperformance` | `enable_solar_array true` **only if** `enabled == false`; otherwise none | A fault or soiling is not a control; saying "nothing to do" is the correct answer |
| `low_battery` | `load_shed true`; `start_generator true` (if fuel); `battery_reserve` lowered with the trade stated | Shedding is free, starting costs fuel, lowering the reserve costs margin |
| `battery_temperature` | `load_shed true`; nothing that increases throughput | Heat is throughput; reducing load reduces both charge and discharge |
| `low_fuel` | `load_shed true`; `generation_priority 'solar_first'`; **never** `start_generator` | Burning fuel you do not have is the one unrecoverable action |
| `generator_fault` | `load_shed true`; `start_generator true` **if** retry is possible; `battery_reserve` lowered as last resort | Cover the load first, then retry |

**Acceptance.** For `low_fuel`, `start_generator` is **absent** from the suggestions, and for
`backup_active` `stop_generator` appears only as a suppressed entry with its reason.

#### 6.3.5 Guard awareness

The suggestions run through `41` §5's guards, which matters most here:

- `start_generator` below 2 % fuel is blocked → the card shows the blocked action with `low_fuel` as
  the reason from the *other* alert, which is a genuinely useful cross-reference.
- `battery_reserve` above SOC with load uncovered is blocked → the "lower the reserve" suggestion is
  only valid in the downward direction, and the card must clamp its proposed value accordingly.
- `enable_solar_array false` is blocked while solar carries the load → the card never offers it.

### 6.4 The consequence view (what makes this service different)

- **Responsibility.** For every OPG alert, answer "and then what?".
- **Contract.** A compact chain drawn under the narrative:

  ```
  SOC 24 % ──(41 min)──▶ reserve 20 % ──▶ generators auto-start ──(30 s)──▶ backup_active
           └─▶ at 190 L/day, tank empty in 2.4 days ──(refuel in 5 days)──▶ shortfall
  ```

- **Steps.** Built from the §6.2 projections; each node carries its basis (`opg.autonomy_hours`,
  `opg.diesel_burn`). Only rendered for the four predictable types; the others show a single step.
- **Acceptance.** A `low_battery` card in a night drain shows the full chain, and the timing in it
  matches what actually happens when the generator starts.

### 6.5 Quiet alerts and the board

- `backup_active` never flashes and never appears in the critical section. It is an `info` row with
  a "routine" tag and a fuel readout, because it is the single most common row during a cloudy night
  and it will dominate the board if allowed.
- `low_fuel` and `low_battery` are the two that deserve attention *before* they escalate; both
  surface as amber chips in the OPG header so they are visible without opening the annunciator.

### 6.6 Alert rendering on the flow diagram

- **Responsibility.** Point the alert at the picture of its cause.
- **Contract.** Each alert type highlights its node:

  | Type | Diagram |
  | :--- | :--- |
  | `supply_shortfall` | load node red with the `unserved_w` branch drawn |
  | `solar_underperformance` | solar node outlined with the gap between delivered and expected drawn as a ghost arrow |
  | `low_battery` / `battery_temperature` | battery node ring, and the SOC bar's distance to the reserve highlighted |
  | `low_fuel` / `generator_fault` | diesel node ring with the status verbatim |
  | `backup_active` | diesel link drawn at full weight with a "routine" tag |

- **Acceptance.** Hovering the `solar_underperformance` ring shows the expected-vs-delivered arrow and
  the ratio trend.

### 6.7 Alerts inside replay

- `alertsAsOf(cursor)` as in `07` §4.5, with the OPG-specific obligation that the **flow diagram and
  SOC line must show the reconstructed state at the cursor**, and the diagram labelled
  `RECONSTRUCTED` because a live flow is animated from the newest frame while a replayed one is
  computed from the series.
- **Acceptance.** Replaying the storm shows `solar_underperformance` before `low_battery` before
  `backup_active`, in the order they happened, with the diagram following.

---

## 7. Data contracts

```ts
interface OpgAlertContext extends AlertContext {
  context_quality: 'full' | 'partial' | 'generic';
  supply_mode: string | null;                    // from metadata, always rendered
  projection: {
    kind: 'to_reserve' | 'to_empty' | 'to_covered' | 'to_limit' | 'to_retry';
    eta_ms: number | null;
    basis: string;                               // measure key + sample size
    consequence: string;                         // "generators auto-start"
  }[];
  consequence_chain: { step: string; eta_ms: number | null; basis: string }[];
  limits_used: { key: string; value: number; source: 'payload' | 'api' | 'cache' | 'default' }[];
}
```

`supply_mode` is duplicated from `metadata` to the top level because every OPG surface needs it and
no card should have to dig for it.

---

## 8. Failure modes

| Failure | Symptom | Handling |
| :--- | :--- | :--- |
| `reserve_pct` changed since the alert | Card compares against the wrong threshold | `limits_used` records the source and the value; the card shows the reserve in force at `raised_ts` |
| Refuel event lost | Fuel projection says "empty in 0 days" while the tank refilled | Reconcile with `fuel_level_pct` jumps; a jump without a `refuel` event is a `data_quality` row (`40` §7) |
| Ratio projected from a single sample | Confident, wrong soiling claim | Require ≥ 10 operating minutes above 200 W/m² before projecting; otherwise omit |
| `supply_shortfall` with no `unserved_w` | Critical alert with no size | State "unserved power not reported" and use the margin from reconciliation as a bound |
| Long `backup_active` episode | The card's "hours at this output" drifts | Recompute from the live burn rate, and label it as "at the current output" |
| Replay of a day with no diesel | Chain shows an impossible auto-start | Suppress the chain when the day's `generator_status` history never left `off` |
| Platform tempted to raise "solar low at night" | Contradicts the service | Not implemented; §6.1's rule is absolute |

---

## 9. Test plan

| # | Test | Type |
| :--- | :--- | :--- |
| 1 | All seven types round-trip with `supply_mode` preserved | unit |
| 2 | `narrative()` snapshot for all seven plus the missing-metadata variants | unit |
| 3 | `low_battery` projection is within 15 % of the actual time to the generator start | integration |
| 4 | `low_fuel` days-to-empty matches the integrated burn and the next delivery date | unit |
| 5 | `start_generator` is absent from `low_fuel` suggestions; `stop_generator` is suppressed for `backup_active` | unit |
| 6 | `solar_underperformance` projection refuses below 10 operating minutes | unit |
| 7 | `low_battery` → `backup_active` forms one "expected behaviour" incident | unit |
| 8 | Storm scenario: `backup_active` lists `rta/wind_stow` and `lwm/high_wind` as co-occurring | end-to-end |
| 9 | Replay reproduces the alert order and marks the diagram `RECONSTRUCTED` | integration |
| 10 | Fuel colour follows the API limit (25 %), not the removed hard-coded 20 (regression for D-10) | unit |

---

## 10. Open decisions

| # | Decision | Recommendation |
| :--- | :--- | :--- |
| 1 | Should the projection appear before the alert raises, as an advisory? | Yes, as a non-alert advisory chip in the header; alert rows stay the service's |
| 2 | Offer "lower the reserve" as a real suggestion? | Yes, explicitly labelled last resort — it is what an operator would actually do, and hiding it makes the platform appear to know less than the operator |
| 3 | How long is the `backup_active` episode measured over? | Since the generators started, from state history, not from the alert's `raised_ts`, which can lag |
| 4 | Should `generator_fault` suggest a retry? | Only when fuel ≥ 2 % and nothing is starting; otherwise the retry is guaranteed to fail |
| 5 | Carbon reporting on the card | One line (`opg.carbon` for the episode); it is cheap and it turns a maintenance alert into a research fact |