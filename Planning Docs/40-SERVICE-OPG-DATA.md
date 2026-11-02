# 40 — OPG Data

**Service.** On-demand Power Generation: one solar array, one battery bank, one diesel pair, four
entities, one telemetry stream — and the energy accounting that turns four numbers a minute into
"is this plant actually reliable?".

**Component.** Capture of the `power` stream, the source-reconciliation identity, the energy
integrals that no single message contains, and the derived measures that answer a plant
researcher's questions.

**Owner files.** `server/src/services/opg.ts`, `server/src/db/queries.ts` (§ minute integrals),
`web/src/lib/live.ts` (§ flow accumulation), `web/src/pages/Opg.tsx` (data half).

**Rubric.** Data 30 % of the service score. 100 % band: *"the data is used to answer a question a
researcher would actually ask"*.

**Depends on.** `02`, `03`, `04`, `10`, `11`.

---

## 1. The authoritative data model

From `arl-opg-spec.pdf` §1–§2.

### 1.1 Entities

| Id | Kind | Plant |
| :--- | :--- | :--- |
| `global` | service | Total generation, total load, supply mode, priority, load shedding |
| `solar` | array | 1200 kWp array, central inverter up to **1000 kW AC** |
| `batteries` | bank | 4000 kWh lithium, **±800 kW** charge or discharge |
| `diesel` | generators | **Two 250 kW** generators reported as **one entity**, 20 000 L tank |

Four entities, four messages a minute. This is the smallest dataset of the three services — which
is exactly why the Data criterion here cannot be satisfied by storage. It is satisfied by
*accounting*.

### 1.2 Telemetry — `arl/opg/<entity>/telemetry/power`, every 60 s

| Entity | Field | Unit | Meaning |
| :--- | :--- | :--- | :--- |
| `global` | `total_generation_w` | W | Power produced by all sources together |
| `global` | `total_load_w` | W | Power demanded by the laboratory |
| `global` | `supply_mode` | enum | `solar`, `battery`, `diesel` when one source supplies **more than 90 %** of the load, else `mixed` |
| `solar` | `power_output_w` | W | AC power delivered |
| `solar` | `irradiance_wm2` | W/m² | Radiation on the array |
| `solar` | `panel_temperature_k` | K | Hot panels produce a little less |
| `solar` | `inverter_status` | enum | `online`, `offline` (array disabled), `fault` |
| `batteries` | `state_of_charge_pct` | % | Energy stored |
| `batteries` | `battery_power_w` | W | **Positive = charging, negative = discharging** |
| `batteries` | `battery_temperature_k` | K | Rises with heavy charge or discharge |
| `batteries` | `battery_health_pct` | % | Remaining capacity relative to new |
| `diesel` | `fuel_level_pct` | % | Of 20 000 L |
| `diesel` | `power_output_w` | W | Delivered by the generators |
| `diesel` | `generator_status` | enum | `off`, `starting`, `running`, `fault` |
| `diesel` | `runtime_h` | h | Total running hours |

### 1.3 Retained state — four items

| Topic | Type |
| :--- | :--- |
| `global/state/generation_priority` | `solar_first` \| `battery_first` \| `diesel_first` |
| `global/state/load_shed` | boolean |
| `solar/state/enabled` | boolean |
| `batteries/state/reserve_pct` | float % |
| `global/state/online`, `global/state/active_alerts` | mandatory |

### 1.4 Events

**`arl/opg/events/refuel`** — `{litres, fuel_level_pct}`. A delivery of up to 15 000 L arrives every
7 days at 10:00 local, capped at the tank.

**`arl/opg/events/alert`** — see `43`. **Every alert carries the current `supply_mode` in its
metadata** — a platform that drops metadata cannot explain a shortfall.

### 1.5 Machine facts that shape the design

| Fact | Consequence |
| :--- | :--- |
| One message per entity per minute | Any rate-based quantity (kWh, litres per hour, cycles) must be **integrated**, not sampled |
| `supply_mode` is a 90 % discretisation | It is a *label*, not a breakdown. The mix must be derived from the three source powers, because `solar` mode can still be charging the battery from surplus |
| `battery_power_w` is signed | Treating it as a magnitude inverts charge and discharge. Most naive bug in the service |
| Generators are two units behind one entity | 250 kW each, so `power_output_w = 500 000` means both. Efficiency and burn must not be computed per generator |
| Inverter caps at 1000 kW AC while the array is 1200 kWp | Curtailment is normal at midday. `solar_underperformance` compares against *expected*, not against nameplate |
| Refuel is periodic and capped | `fuel_level_pct` is a sawtooth; a naive "days to empty" from two samples is wrong |
| `battery_health_pct` falls slowly with use | A meaningful trend needs days of data and equivalent-full-cycle accounting, not a two-point slope |
| Demand follows time of day, weather, other services and shedding | Load is not a free variable; it must be explained by hour-of-day and by the other two services' activity |
| Array coordinates are −31.2298, 21.6889 (the Karoo) | Irradiance is seasonally real; a "night-time solar underperformance" alert cannot occur, which is a useful sanity check |

---

## 2. Capture requirements (Data criterion)

### 2.1 Completeness checklist

| Requirement | Where |
| :--- | :--- |
| All four entities' `power` streams, every field | `03` wildcard + null preservation |
| All four state items | `03` §4.3 |
| `refuel` events with litres and resulting level | `03` |
| Alert metadata including `supply_mode`, `unserved_w`, `expected_w`, `output_w`, `reserve_pct` | `05` §4.1.1 |
| Signed `battery_power_w` preserved | `04` (numeric, never `abs`) |
| 500× survival | `03` §4.4 |
| A derivable `local_hour` for every row | §3.1 |

### 2.2 The 500× case

At 500× the plant emits ~33 msg/s — trivial for the ingest path, but a wall-clock minute becomes
0.12 s of simulator time. Two consequences:

1. **Integrals must use simulator time.** `energy_wh += power_w × (ts − prev_ts)/3_600_000`. Using
   wall time under-reports energy by 500×.
2. **Day boundaries are simulated.** A "daily" total is a simulated local day, so `local_hour` must
   be derived from the sim clock plus the array's longitude (`UTC+2` for the Karoo), never from
   `Date.now()`.

**Acceptance.** A 24-hour simulated period at 500× produces 24 hourly energy buckets whose sum
equals `Σ power × Δt` to within 0.1 %.

---

## 3. Normalisation pipeline

### 3.1 Simulated local time

- **Responsibility.** Make "10:00 local" and "hour of day" first-class, because refuels, demand and
  solar all key on them.
- **Contract.** Every OPG row carries `local_hour` (0–23) and `sim_day` (integer day index from the
  service's `ARL_START_TIME`), both derived from the envelope `ts` and the plant's timezone.
- **Steps.** Timezone is a configuration constant (`Africa/Johannesburg`, UTC+2) derived from the
  array coordinates in the spec §5; it is not read from the browser.
- **Acceptance.** A `refuel` event always lands on `local_hour = 10`, and the daily energy rollup
  boundary is midnight local, not midnight UTC.

### 3.2 Source reconciliation (the identity that makes the data trustworthy)

- **Responsibility.** Prove the four streams agree, and record it when they do not.
- **Contract.**
  ```
  delivered = solar.power_output_w + diesel.power_output_w + max(0, −battery_power_w)
  absorbed  = solar.power_output_w + diesel.power_output_w + max(0,  battery_power_w)
  expect total_generation_w ≈ delivered   and   total_load_w ≈ absorbed
  ```
- **Steps.** Evaluated once per minute per stamped `ts`; a residual above 5 % of load (or 10 kW,
  whichever is larger) is written to `data_quality` with the four values. Never silently corrected.
- **Acceptance.** A synthetic minute with battery charging at −100 kW reconciles; a corrupted
  `total_generation_w` produces one `data_quality` row and the panel shows a "reconciliation gap"
  badge rather than a false margin.

This identity is the difference between four numbers and a model. It is also the cheapest possible
demonstration that the platform validates its own capture.

### 3.3 Integrating power into energy

- **Responsibility.** Turn a stream of instantaneous watts into the kWh a researcher reasons about.
- **Contract.** `Wh_i = power_w × Δt_ms / 3_600_000`, trapezoidal between consecutive samples of
  the same entity, with `Δt` capped at 180 s so a gap does not become a spike.
- **Steps.** Written per entity per hour by the rollup writer (`11`), and recomputed from raw on
  backfill. `battery_power_w` integrates **signed** to give net energy in/out.
- **Acceptance.** A flat 400 kW solar hour yields 400 kWh; a 5-minute gap with no samples
  contributes zero, not an interpolation across the hole.

---

## 4. Derived measures and the questions they answer

### 4.1 The measure table

| Measure | Question | Definition | Window |
| :--- | :--- | :--- | :--- |
| `opg.energy_mix` | *Where did today's energy come from, and how much of it was diesel?* | kWh per source from §3.3, plus the delivered-vs-absorbed split, as percentages | per sim day |
| `opg.performance_ratio` | *Is the array dirty, or is something broken?* | `output / expected` where expected is normalised for irradiance and panel temperature; trend against soiling | rolling 60 min + 7-day |
| `opg.diesel_burn` | *How many litres per day are we burning, how efficient is it, and when do we next run dry?* | `Δ fuel_level_pct × 200 L` per day; `L/kWh` over the day; days-to-empty from the 7-day mean; observed refuel sizes | 7-day |
| `opg.battery_cycles` | *How hard is the bank working, and is its health falling faster than our cycles explain?* | Equivalent full cycles = `∫|P| dt / (2 × 4000 kWh)`; health delta per 100 cycles | per sim day, 30-day trend |
| `opg.autonomy_hours` | *If solar died now, how long can we run?* | `SOC available above reserve × 4000 kWh / mean load` — the number an operator wants on screen | instant |
| `opg.load_profile` | *When is the base expensive to run, and how much does each service contribute?* | Mean and p95 load by `local_hour`; correlation of load against RTA scan activity and MHE habitat draw | 7-day |
| `opg.load_shed_effect` | *Did shedding actually help?* | Load delta across `load_shed` transitions, and MW·min shed | per event |
| `opg.shortfall_minutes` | *How reliable was the plant today, in the only unit that matters?* | Minutes with `supply_shortfall` open, and total `unserved_w`-minutes | per sim day |
| `opg.carbon` | *What did the diesel cost us in CO₂?* | Litres × 2.68 kg CO₂/L, per day and cumulative | per sim day |

Three of these are the ones to demo: `performance_ratio` (dirty vs broken), `autonomy_hours` (a
number with an immediate operational meaning), and `shortfall_minutes` (the honest reliability
figure that a table of watts can never give).

### 4.2 Solar expected output — the model

`performance_ratio` needs an expectation, and the service already tells us its own when an alert
fires (`metadata.expected_w`). For the *continuous* measure the platform must model it:

```
expected_w = P_stc × (G / 1000) × (1 + γ (T_cell − 25 °C))       γ ≈ −0.004 /K
T_cell     ≈ panel_temperature_k − 273.15
P_stc      = 1200 kWp, capped at the 1000 kW inverter limit
```

- The model is deliberately simple and its parameters are **calibrated from the data**: take the top
  decile of operating minutes and fit the ratio, rather than asserting a datasheet number.
- **Below 200 W/m² the ratio is meaningless** and the measure returns `null` with the reason, exactly
  as the service's own alert only applies above 200 W/m². Night is not underperformance.
- When an `solar_underperformance` alert carries `expected_w`, the platform stores it and shows its
  own model beside the service's figure. A disagreement is worth seeing.

**Acceptance.** With `soiling(ratio 0.85)` injected, the 60-minute ratio settles near 0.85 ± 0.03
while the model's expectation is unchanged; at night the measure is `null`, not zero.

### 4.3 What must not be done

| Temptation | Why it is wrong |
| :--- | :--- |
| Splitting the load by `supply_mode` | It is a 90 % label; "solar" mode routinely includes a charging battery |
| `Math.abs(battery_power_w)` | Erases charge vs discharge, which flips the sign of the whole energy balance |
| Days-to-empty from two fuel samples | The refuel sawtooth makes any two-point slope nonsense |
| Treating a 1000 kW solar reading as 1200 kWp output | The inverter caps AC output; nameplate is DC |
| Computing battery degradation from `battery_health_pct` alone | Health also falls with calendar age; pair it with equivalent cycles |
| Averaging generation and load separately across a day | Their difference is what matters, and it is not the average of differences when sampling is uneven |

---

## 5. Cross-service data (the integration point)

OPG is where the other two services' data becomes physically meaningful:

| Cross-measure | Question | Inputs |
| :--- | :--- | :--- |
| `x.rta_scan_cost` | *What does an observation cost in kWh?* | Load delta across `main` `scan_state` transitions, attributed to RTA scan windows |
| `x.habitat_draw` | *What share of the load is the habitat, and does it move with occupancy?* | `mhe/global/telemetry/habitat power_w` against OPG `total_load_w`; occupancy from `crew_count` |
| `x.storm_impact` | *During the storm, what did the base actually lose?* | OPG solar collapse + RTA wind stow + LWM wind, on one timeline |

`x.rta_scan_cost` is the single most persuasive Data-criterion artefact in the project: it answers a
question no single service can answer, from data the platform captured itself.

**Acceptance.** A scan of `tgt-cen` at L band shows a load step of the expected magnitude in the
OPG load profile, and the measure reports kWh per scan with an n.

---

## 6. Persistence and replay specifics

| Concern | Decision |
| :--- | :--- |
| Volume | ~33 msg/s at 500× — negligible. Keep raw indefinitely at the default retention |
| Rollups | Hourly and daily `energy` rows are the primary artefact; they are cheap and they are what every measure reads |
| `refuel` | Event table; a `refuel` with no corresponding rise in `fuel_level_pct` is a data-quality row |
| Reconciliation gaps | Own table (`data_quality`), surfaced as a badge, never silently repaired |
| Replay | At 500× a simulated day replays in 173 s; the flow animation is driven by `alertsAsOf` + `series` at the cursor |
| Derived in replay | `energy_mix` and `autonomy_hours` are recomputed at the cursor, never read from today's cached value |
| Restart | The integrator's last `(ts, power)` per entity is persisted so no energy is lost across a restart |

---

## 7. Failure modes

| Failure | Symptom | Handling |
| :--- | :--- | :--- |
| Sample gap | Energy under-reported | Hard cap `Δt ≤ 180 s`; a longer gap contributes nothing and raises `ingest_gap` |
| Speedup change mid-run | Non-uniform `Δt` | Integrate on sim time only; wall time is irrelevant by construction |
| `supply_mode` present, sources missing | Cannot split the mix | Show `supply_mode` as a label and mark the mix as unavailable — never infer shares from it |
| `fuel_level_pct` jumps up without a `refuel` event | Unexplained fuel | `data_quality` row; the burn measure excludes that interval |
| `battery_power_w` = 0 at the reserve | Ambiguous idle vs clamped | Report "at reserve, neither charging nor discharging" only when SOC is within 0.5 points of `reserve_pct` |
| Timezone assumption wrong | Refuels land at the wrong hour | Timezone is configuration, not derived from the browser locale |
| Replay of a day with a low-speedup segment | Uneven bucket populations | Decimation at the cursor (`07` §4.3) and a note of the achieved `bucketMs` |

---

## 8. Test plan

| # | Test | Type |
| :--- | :--- | :--- |
| 1 | Reconciliation identity holds on a synthetic charging minute and flags a corrupted total | unit |
| 2 | Signed battery power integrates to net energy in and out correctly | unit |
| 3 | `Δt` cap prevents a gap producing a spike | unit |
| 4 | Energy integrals use sim time: a 500× run matches the analytical kWh | integration |
| 5 | `local_hour` is 10 for every `refuel` event | integration |
| 6 | `performance_ratio` returns `null` below 200 W/m² and near 0.85 under `soiling(ratio 0.85)` | unit |
| 7 | `autonomy_hours` = available kWh / mean load, and is 0 at reserve | unit |
| 8 | `x.rta_scan_cost` detects a load step across a scan window | integration |
| 9 | Hours and days always sum to the raw integral within 0.1 % | integration |

---

## 9. Open decisions

| # | Decision | Recommendation |
| :--- | :--- | :--- |
| 1 | Model-based expectation vs the service's `expected_w`? | Both, shown side by side; disagreement is information |
| 2 | Timezone | Configure it once (`Africa/Johannesburg`); never infer from the browser |
| 3 | Carbon accounting | Include it — two lines of arithmetic and it gives the plant a research purpose beyond uptime |
| 4 | Raw retention | Keep indefinitely; OPG is 0.5 % of RTA's volume |
| 5 | Should `data_quality` gaps be visible to the researcher? | Yes, as a badge with a tooltip. Hiding a reconciliation failure is the one thing that would make every other number untrustworthy |