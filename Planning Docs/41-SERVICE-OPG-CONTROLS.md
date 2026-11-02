# 41 — OPG Controls

**Service.** On-demand Power Generation.

**Component.** The six controls in `arl-opg-spec.pdf` §3, presented as the one thing a plant
operator actually needs: *who is in charge right now, what will the automation do next, and what
does this command cost me in autonomy?*

**Owner files.** `web/src/pages/Opg.tsx` (`PowerControls`), `server/src/services/opg.ts` (guards),
`web/src/lib/presets.ts` (OPG section), `web/src/lib/guards.ts`.

**Rubric.** Control 30 % of the service score. 100 % band: *"controls are designed around how a
researcher works, e.g. presets, schedules, safeguards against unsafe commands"*.

**Depends on.** `06` (dispatch, guard table), `15` (presets), `14` (`ControlForm`), `40`
(§ reconciliation, § autonomy, § burn).

---

## 1. The control inventory (authoritative)

Six controls, and not one of them acts instantly on the physical plant. That is the defining
property of this service.

| Control | Level | Value | Service rules that matter to the UI |
| :--- | :--- | :--- | :--- |
| `generation_priority` | Global | `solar_first` \| `battery_first` \| `diesel_first` | "Applies from the **next minute**". `diesel_first` loads the **running** generators first, so it does nothing while they are off |
| `load_shed` | Global | boolean | Sheds non-critical load: **part of the housing and lab load and the water treatment plant** |
| `enable_solar_array` | Solar | boolean | Disabled ⇒ inverter `offline`, array produces nothing |
| `battery_reserve` | Batteries | float %, **10–80** | Minimum SOC kept for emergencies; raising it above the current SOC is refused when the load is uncovered |
| `start_generator` | Diesel | boolean, must be `true` | `in_progress` for **30 s** while starting, `completed` when running, `failed` with `start_failed` if the start fails. Rejected below **2 %** fuel (`low_fuel`) or if already running |
| `stop_generator` | Diesel | boolean, must be `true` | **60 s unloaded cool-down**, then stopped. Only while running. **Accepted even if it leaves the load uncovered** |

The plant also acts on its own, and the operator must be able to see that:

- Generators **auto-start** when the batteries reach the reserve with load uncovered, and
  **auto-stop** once the bank recovers and solar covers the load.
- A manual start or stop **holds until the next automatic trigger**.
- Solar surplus charges the bank; beyond that, curtailment.

---

## 2. Control surfaces

### 2.1 The plant mode strip (the most important readout in the service)

Before any button, the operator needs to know who is driving.

```
┌──────────────────────────────────────────────────────────────────────────┐
│  AUTOMATIC  ·  solar_first  ·  reserve 20 %  ·  next auto action: none    │
│  ── or ──                                                                │
│  MANUAL HOLD since 14:22 by arl-as3  ·  automation resumes at the next    │
│  trigger (reserve reached or solar covering load)                        │
└──────────────────────────────────────────────────────────────────────────┘
```

| Mode | Derived from | Meaning |
| :--- | :--- | :--- |
| `automatic` | `generator_status == off` and no manual hold recorded | The plant covers load by priority alone |
| `manual-hold` | the last `start_generator`/`stop_generator` completed and no automatic trigger has fired since | A human is in charge until the automation reclaims it |
| `backup` | `generator_status == running` after an automatic trigger | The automation is executing backup |
| `shedding` | `load_shed == true` | Load has been dropped |

- **Responsibility.** Make the automation's next decision predictable.
- **Contract.** The strip shows the current mode, the pending priority if it differs from the
  active one, and the *next automatic action* with its trigger and, where computable, its ETA —
  "battery reaches reserve in ≈ 47 min at the current 210 kW deficit".
- **Steps.** The ETA comes from `opg.autonomy_hours` (`40` §4.1), not from a hard-coded rate.
- **Acceptance.** After a manual `start_generator`, the strip reads `MANUAL HOLD since …`; when the
  bank recovers and solar covers load, the automation stops the generator and the strip returns to
  `automatic`.

### 2.2 Priority selector

- Three segments, with the *active* value from state and the *pending* value distinct: "applies
  from 14:32" with a countdown.
- Each option carries its rationale in one line: `solar_first` "use solar, then batteries, then
  diesel"; `battery_first` "draw on the bank first — this cycles it"; `diesel_first` "load the
  running generators first — for generator testing".
- **`diesel_first` while the generators are off is inert**, and the panel says so: "no effect until
  the generators are running" with a `start_generator` shortcut beside it. Nothing is more
  frustrating than a control that silently does nothing.
- Selecting `battery_first` shows the consequence before sending: the autonomy after the change and
  the SOC at which the generators will take over.

**Acceptance.** Selecting `diesel_first` with `generator_status = off` shows the inert notice and
the shortcut, and the command still succeeds (the service accepts it).

### 2.3 Load shedding

- A single toggle with a mandatory consequence panel listing what is actually shed: part of the
  housing load, part of the lab load, and the **water treatment plant**.
- The expected saving is not invented: it is `opg.load_shed_effect` (`40` §4.1) in kW and %, from
  the last shedding episode at a comparable `local_hour`.
- The cross-service consequence is stated: cutting the water treatment plant can push the habitat's
  water subsystem (`mhe/global/state/subsystems.water`) out of `ok`.
- Un-shedding shows the reverse estimate and the risk that the restored load triggers a shortfall.

**Acceptance.** Toggling shedding shows a predicted saving with its sample size ("−184 kW mean over
3 episodes at this hour") and names the water treatment plant; the MHE warning appears.

### 2.4 Battery reserve

- A slider 10–80 % with the current SOC marked on the same track, so the relationship is spatial:
  raising the reserve above the SOC is visibly impossible.
- The panel shows the trade: reserve high ⇒ more emergencies covered and **less autonomy**, because
  the last N % is untouchable. Two numbers update together:

```
reserve 20 %  → usable 2 640 kWh  → autonomy 7.3 h
reserve 45 %  → usable 1 760 kWh  → autonomy 4.9 h
```

- It also states the trigger consequence: the generators auto-start when the SOC **reaches the
  reserve with load uncovered**, so raising the reserve brings the generators on sooner.

**Acceptance.** Dragging the reserve above the current SOC disables the send with "would strand the
load" before the server is asked; forcing it returns the service's `precondition_failed`.

### 2.5 Generator control

Two buttons that are deliberately asymmetric:

| | Start | Stop |
| :--- | :--- | :--- |
| Enabled when | `generator_status == off`, fuel ≥ 2 % | `generator_status == running` |
| Progress | `in_progress` with a 30 s countdown, then `completed` (running) | `in_progress` with a 60 s cool-down, then `completed` (off) |
| Failure | `failed` / `start_failed` — and a `generator_fault` alert follows | `fault`, `timeout` |
| Refusals | `low_fuel` (< 2 %), `busy` (already starting/running) | `precondition_failed` (not running) |

Additional readouts that make the buttons safe to press:

- **Runtime cost**: at the current load, litres per hour and hours remaining in the tank
  (`fuel_level_pct × 200 L` ÷ `opg.diesel_burn`), plus the next scheduled delivery (every 7 days at
  10:00 local, up to 15 000 L).
- **Stop consequence**: the autonomy after the stop and the predicted time to the `supply_shortfall`
  threshold. Because the service **accepts a stop that leaves the load uncovered**, the platform's
  job is to make that consequence unmistakable rather than to prevent it.

**Acceptance.** Pressing Stop with the bank at 24 % requires a confirmation naming the predicted
26 minutes to a shortfall; proceeding sends the command and the shortfall alert arrives later as
predicted.

### 2.6 Energy flow panel linkage

The flow diagram (`42` §3) is a control surface as much as a visualisation: each source node is a
link to that entity's panel, and the flow speed is proportional to that source's power, so a
stalled diesel generator is *visibly* idle rather than merely numerically zero. The existing
implementation already does this and it should be preserved.

---

## 3. Presets

Defined in `15` §2.3: **Conserve for the night**, **Bring the diesels up**, **Return to solar**,
**Cycle the battery**, **Storm posture**.

OPG-specific notes:

- **Bring the diesels up** is a two-command batch (`start_generator` → `generation_priority
  'diesel_first'`) that is *ordered*: the priority only matters once they run. A batch endpoint that
  dispatches in parallel would make half of this preset inert, so the batch must execute in order
  (`06` §4.4.1).
- **Cycle the battery** is the only preset whose purpose is deliberately to *use up* reserve. It must
  therefore carry the strongest confirmation: "this draws the bank down to 20 % on purpose".
- **Storm posture** pairs with the LWM storm alerts (§4.3), which is the clearest example of a
  preset that a researcher would otherwise have to remember under pressure.

**Acceptance.** Each preset runs end to end; "Bring the diesels up" produces a `starting` phase
followed by `running`, and the priority change is visible taking effect at the next minute.

---

## 4. Schedules

OPG has **no service-native schedule**. Everything is platform-side, which makes this section the
honest test of whether the platform adds value.

### 4.1 Shift schedules

| Schedule | Definition | Why it exists |
| :--- | :--- | :--- |
| **Night reserve** | At 17:30 local: `battery_reserve 45`. At 07:00: `battery_reserve 20` | Reserve is a night-time insurance policy; keeping it high all day wastes autonomy |
| **Generator exercise** | Sundays 10:00 local: `start_generator` → run 10 min → `stop_generator` | Real plants are exercised to prove they start; it also produces the only routine evidence that a start works |
| **Pre-refuel charge** | Day N−1 at 22:00: `battery_reserve 20`; the refuel arrives at 10:00 | Do not hoard reserve empty when a delivery is coming |

### 4.2 Event-triggered schedules

A schedule whose trigger is an *alert* rather than a time — the cross-service capability that no
single service offers:

```
on lwm/storm (warning|critical), and
   opg/solar_underperformance raised, or irradiance < 200 W/m² for 20 min
then load_shed true; battery_reserve 45      (i.e. "Storm posture")
and on the storm clearing for 30 min, reverse both
```

- Rules are evaluated server-side against the alert stream (`05`), never in the browser, so a
  scheduled response happens even if nobody is watching the OPG page.
- Every automated dispatch is logged as `origin: 'schedule'` with the rule id, so the audit shows a
  machine, not a researcher. Attribution must never claim a person did it.
- A rule can be armed/disarmed from the console and has a visible last-fired timestamp.

**Acceptance.** With the rule armed, running `scenarios/example.toml`'s storm results in
`load_shed true` and `battery_reserve 45` within the automation's own reaction window, logged with
the rule id and `origin: 'schedule'`.

### 4.3 Forecast-based schedules (stretch)

Given `opg.autonomy_hours` and a simple irradiance forecast from the previous day's profile, a
planner can answer "will tomorrow morning need diesel?" and pre-emptively schedule a reserve raise.
If time is short, drop this and keep §4.1 and §4.2, which carry the rubric weight.

---

## 5. Safeguards

Server guards are in `06` §4.3.2 (OPG table). These are the explanatory ones.

| Safeguard | Trigger | Message |
| :--- | :--- | :--- |
| **Stop with load uncovered** | `stop_generator` and predicted margin < 0 | "Stopping leaves ~210 kW uncovered; at the current 24 % SOC a shortfall starts in ≈ 26 min. This command is accepted — the service does not prevent it." Requires an explicit confirm |
| **Reserve above SOC** | `battery_reserve` > SOC and `supply_mode != solar` | Blocked client-side with "would strand the load"; the server returns `precondition_failed` |
| **Disabling solar while it carries the load** | `enable_solar_array false`, `supply_mode == solar`, bank below reserve | Blocked with the shortfall prediction |
| **`battery_first` at night** | priority change, irradiance < 50 W/m², SOC < 40 % | Advisory: "the bank will reach the reserve in ≈ 41 min and the generators will start" |
| **`diesel_first` with generators off** | `generator_status == off` | Inert notice plus a `start_generator` shortcut |
| **Start below 2 % fuel** | `fuel_level_pct < 2` | Blocked with the next delivery time |
| **Start with low fuel** | 2 % ≤ fuel < 10 % | Advisory: "≈ N min of running at this load; next delivery {when}" |
| **Load shedding and the habitat** | `load_shed true` | "The water treatment plant is shed; the habitat's water subsystem may degrade" |
| **Shedding while already short** | `supply_shortfall` open | "A shortfall is already active with shedding on; extra shedding cannot recover an uncovered load" |

The asymmetry at the top of this table is deliberate and important: the platform blocks what the
*service* blocks, and merely explains what the service allows. Adding a platform-only refusal would
mean the console and the simulator disagree about what is legal — a certain way to lose marks for
both Control and correctness.

**Acceptance.** Each chosen safeguard is exercised once in `52`; the two blocking ones return the
service's own reason verbatim.

---

## 6. Failure and completion reporting

| Control | Intermediate | Success | Failure reasons to render verbatim |
| :--- | :--- | :--- | :--- |
| `generation_priority` | — | `completed`, applied next minute | `invalid_value`, `precondition_failed` |
| `load_shed` | — | `completed` | `precondition_failed`, `fault` |
| `enable_solar_array` | — | `completed` | `precondition_failed` (would shortfall) |
| `battery_reserve` | — | `completed` | `invalid_value` (outside 10–80), `precondition_failed` (would strand the load) |
| `start_generator` | `in_progress` 0→1 over 30 s | `completed` (running) | `low_fuel`, `busy`, `failed` (`start_failed`), `fault`, `timeout` |
| `stop_generator` | `in_progress` during the 60 s cool-down | `completed` (off) | `precondition_failed` (not running), `fault`, `timeout` |

Two rendering rules specific to this service:

- **A 30-second start is not instant.** Show the countdown, disable both buttons, and let the
  `starting` status be visible on the flow diagram, or the operator will press again and get `busy`.
- **`completed` for `generation_priority` means "scheduled", not "in effect".** The panel must show
  the pending value until the next minute's telemetry confirms the new order, so the ack and the
  effect are not conflated.

---

## 7. Test plan

| # | Test | Type |
| :--- | :--- | :--- |
| 1 | Every control's bounds are enforced client-side and server-side with the same reason | unit |
| 2 | `battery_reserve` above SOC with load uncovered is refused with the spec's reason | integration |
| 3 | `start_generator` with 1.5 % fuel is refused with `low_fuel` | integration |
| 4 | A 30 s start shows `in_progress` progress and a second press returns `busy` | integration |
| 5 | `stop_generator` while off is refused; while running it cools down for 60 s | integration |
| 6 | Plant mode strip reports `manual-hold` after a manual start and returns to `automatic` after auto-stop | integration |
| 7 | Priority shows pending until telemetry confirms it at the next minute | integration |
| 8 | Load-shed consequence names the water treatment plant and the predicted saving | unit |
| 9 | Event-triggered rule fires on the storm scenario, logged with `origin: 'schedule'` | end-to-end |
| 10 | All five presets run end to end; "Bring the diesels up" executes in order | end-to-end |

---

## 8. Open decisions

| # | Decision | Recommendation |
| :--- | :--- | :--- |
| 1 | Should the platform ever refuse a command the service accepts? | No — explain, never override. The one exception is a UI confirmation, which is not a refusal |
| 2 | Is a "manual hold" a state the platform invents? | It is derived from the last manual command plus the absence of an automatic trigger since; label it as derived, and never persist it as truth |
| 3 | Generator exercise schedule | Include it — it is real practice, it exercises the start/stop lifecycle, and it generates routine evidence for the Control criterion |
| 4 | Event-triggered automation vs manual response during the storm drill | Automation, with a visible last-fired log; a researcher watching a storm cannot act in 200 ms, and the rubric rewards schedules |
| 5 | Where does the water-treatment consequence live? | In the OPG advisory with a cross-link to MHE's `subsystems.water`; the reverse link belongs in `33` §6.3.3 |