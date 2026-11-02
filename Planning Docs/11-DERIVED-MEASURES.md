# 11 — Derived Measures and Service Adapters

**Component.** The layer that turns raw telemetry into answers. It owns the `ServiceAdapter`
registration, the named measures each service exposes, and the rollup writer that keeps them
cheap.

**Owner files (new).** `server/src/services/index.ts`, `server/src/services/rta.ts`,
`server/src/services/mhe.ts`, `server/src/services/opg.ts`, `server/src/services/limits.ts`,
`server/src/services/measures.ts`.

**Rubric.** Data 30 % — the 100 % band is *"the data is used to answer a question a researcher
would actually ask of the service"*, and the 75 % band already requires *"at least one derived
or aggregated measure"*. Architecture 5 % (the plug point for a service).

**Depends on.** `02` (topology), `04` (store), `10` (limits).

---

## 1. Boundary

In scope: measures, their definitions, their storage, their authorship. Out of scope: rendering
(`22`/`32`/`42`) and the alert rules themselves (`05` owns the lifecycle; the service owns the
threshold condition).

A measure is a **named question with a typed answer**, not an ad-hoc SQL string in a route
handler. Every measure is declared once, documented here, and reachable at
`GET /api/measure/:service/:key`.

---

## 2. Why this component exists

Re-reading one raw sample tells a researcher nothing they cannot see on the chart. The rubric's
top data band asks for questions. The questions an ARL researcher actually asks are:

| Service | The question |
| :--- | :--- |
| RTA | "Is this image as deep as it should be for the integration time, and where is it noisy?" |
| RTA | "Which dishes are degrading the array, and is it heat or calibration?" |
| RTA | "How different is this source between L and C band?" |
| MHE | "Is the crew's mood actually declining, or is that one bad day?" |
| MHE | "How long was this room above the CO₂ warning in the last 24 hours?" |
| MHE | "Is the habitat losing air, or is the CO₂ rise explained by occupancy?" |
| OPG | "What is the energy balance over the last 24 hours, and where did it come from?" |
| OPG | "At this rate, how long until the batteries hit the reserve?" |
| OPG | "Did the storm cost us solar, and how much diesel did it cost to cover?" |

Every measure below answers one of those.

---

## 3. Decomposition

### 3.0 What already runs

`server/src/derived/measures.ts` implements seven measures today, and they are the spine of the
researcher story — not a sketch. The rest of this document extends them; nothing here replaces them.

| Implemented key | The question it answers | Planned successor |
| :--- | :--- | :--- |
| RTA `active_ratio` | How much of the array is usable right now (`N_active / N_total`, taken from topology, not the literal 100) | `rta.uptime` (§3.3) |
| RTA pointing distance | Is the array actually on target (commanded vs reported az/el)? | `rta.pointing_error` |
| RTA `scan_progress` | Will this scan finish? | `rta.scan_progress` |
| MHE headcount vs rated crew | Is anyone unaccounted for (`Σ room crew_count` vs `crew_size`)? | `mhe.headcount` (§3.4) — keep as-is and name it |
| MHE mean heart rate at a CO₂ level | How stressed is the crew, and at what air? | `mhe.stress_vs_co2` (§3.4) |
| OPG `P_solar + P_diesel − P_load` | Is the plant covering its load? | `opg.margin` (§3.5) — this is the design system's ΔP HUD |
| OPG hours above reserve at current draw | How long until the batteries reach the reserve? | `opg.time_to_reserve` |

Two properties of the existing implementation are worth preserving deliberately, because they are
what makes these measures trustworthy:

- **Every measure reports its `inputs`**, so the arithmetic can be checked by eye on the card
  rather than trusted. A measure that cannot list its inputs is a black box and should not ship.
- **Verdicts lean on the service's own limits** (`GET /v1/alert-limits/:service`) and degrade to
  `unknown` when a limit is missing, rather than inventing a threshold. This is convention 9 in `00`
  applied at the point where it matters most.

### 3.1 Adapter registry

#### 3.1.1 Registration

- **Responsibility.** Make a service's capabilities a first-class object.
- **Contract.** `registerAdapter(adapter)`; `getAdapter(code)`; `listAdapters()`.
- **Steps.** Register `rta`, `mhe`, `opg` at boot. Unknown services (e.g. `lwm` if someone
  starts it) get `null` and are ingested without a workspace page.
- **Acceptance.** `/api/capabilities/rta` returns focal entities (`main` + all dishes), the
  measure list, and the accent colour.

#### 3.1.2 Adapter contract

```ts
interface ServiceAdapter {
  code: string;
  label: string;
  accent: string;
  focalEntities(t: ServiceTopology): string[];
  expectedPeriodic(t: ServiceTopology): { entity: string; stream: string; periodS: number }[];
  measures: MeasureDef[];
  limits: LimitMeta[];          // static table, values come from 10
  guards: GuardDef[];           // see 06 §4.3
  presets: PresetDef[];         // see 15 §2
  alertContext: Record<string, AlertContextSpec>;  // see 05 §4.3
}
```

### 3.2 Measure framework

#### 3.2.1 Definition

- **Responsibility.** One declaration per question.
- **Contract.**
  ```ts
  interface MeasureDef {
    key: string;                      // 'rta.image_quality'
    label: string;                    // 'Image depth and noise'
    question: string;                 // 'Is this image as deep as it should be?'
    unit: string | null;
    kind: 'series' | 'scalar' | 'breakdown';
    window: { min: number; max: number; default: number };   // ms
    entityScope: 'service' | 'focal' | 'any';
    compute(ctx: MeasureContext): Promise<MeasureResult>;
    rollupKey?: string;               // when precomputed
  }
  type MeasureResult =
    | { kind: 'series'; points: { ts: number; value: number | null }[]; summary: Record<string, number> }
    | { kind: 'scalar'; value: number | null; unit: string | null; verdict: 'ok'|'warn'|'crit'|'unknown'; against?: { limit: number; limitKey: string } }
    | { kind: 'breakdown'; rows: { key: string; value: number; unit?: string; flag?: 'ok'|'warn'|'crit' }[] };
  ```
- **Steps.** `MeasureContext` gives `store`, `limits`, `topology`, `now`, `from`, `to`, and a
  small `summarise()` helper. Measures never write; the rollup writer does.
- **Acceptance.** Every measure returns within 300 ms for its default window on a 6-hour-old
  database.

#### 3.2.2 Rollup writer

- **Responsibility.** Keep the expensive measures cheap.
- **Contract.** Subscribes to the bus; on a 30 s boundary, folds the last window into `rollup`.
- **Steps.** Only measures with `rollupKey` are precomputed. Upsert with
  `ON CONFLICT DO UPDATE`. One transaction per bucket per service.
- **Acceptance.** The OPG balance measure answers from `rollup` for windows ≥ 1 h, verified by
  a query-plan test asserting no `SCAN telemetry`.

### 3.3 RTA measures

| Key | Kind | Answers | Computation |
| :--- | :--- | :--- | :--- |
| `rta.image_quality` | scalar | Is this image as deep as it should be? | For the current `scan_id`: `coverage = filledPixels / N²`, `meanSnr` over samples with non-null `snr_db`, `outlierFraction` (samples beyond 3σ of the dish median), `rejectedSamples` count. Verdict: warn when `coverage < 0.85` or `meanSnr < limit scan.min_snr_db`; crit when `coverage < 0.6`. |
| `rta.scan_progress` | series | Will this scan finish in time? | Per-minute mean `scan_progress` across participating dishes plus `expected_duration_s` from the started event; projects a completion time. |
| `rta.dish_health` | breakdown | Which dishes are degrading the array? | Per dish: latest `status`, `fault_code`, `system_temperature_k`, `power_w`, minutes since `last_calibration`, and a composite score. Sorted worst first, flagged by the same logic the alerts use. |
| `rta.array_thermal` | series | Is it heat or calibration? | Array mean and p95 `temperature_k` per 30 s, overlayed with the count of dishes above the warning limit; the gap between mean and p95 separates "hot day" from "one hot dish". |
| `rta.band_contrast` | breakdown | How different is this source between bands? | For the current target, per band with captured data: mean, p95, dynamic range, and the pixel-wise correlation between bands on the shared grid. |
| `rta.pointing_error` | scalar | Is the array actually on target? | Mean angular distance between `commanded` and the reported `azimuth_rad`/`elevation_rad` across dishes, plus the max, so a stuck dish is separable from a slow slew. |
| `rta.uptime` | series | Are we holding ≥ 80 dishes? | Count of dishes with `status = true` per 30 s, against `availability.min_active`. |

### 3.4 MHE measures

| Key | Kind | Answers | Computation |
| :--- | :--- | :--- | :--- |
| `mhe.wellbeing_trend` | series | Is mood declining or was that one bad day? | Per crew: 3-day rolling mean of `mood`, `stress`, `fatigue`, `sleep_quality` from survey events, plotted against `survey.min_mood`, `survey.max_stress` and the 7-day decline rule. |
| `mhe.co2_exposure` | scalar | How long was this room above the warning? | Integral of minutes above `air.co2_warn_ppm` in the window, plus peak ppm, crew count at the peak, and whether the room was sealed. Verdict by the spec's 10-minute rule. |
| `mhe.air_balance` | series | Is the habitat losing air? | Per room, `pressure_kpa`, `oxygen_ppm` and `ventilation_m3h`; a room whose pressure falls while ventilation is 0 and no door is open is a leak candidate. Excludes the airlock while cycling or depressurised, per spec. |
| `mhe.thermal_compliance` | breakdown | Which rooms are outside their set points? | Per room: mean deviation from `setpoints.temperature_k`, minutes outside `room.temp_min_k`/`room.temp_max_k`, and the same for humidity with the hydroponics override. |
| `mhe.crew_health` | breakdown | Who needs attention now? | Per crew: latest vitals, count of limits breached, minutes since the last vitals, current `location`, and whether a wellness check is in flight. |
| `mhe.hydroponics_yield` | series | Will the crop make it? | `estimated_yield_kg` per day against the growth stage, with reservoir `water_level_l`, `nutrient_ec_mscm` and `water_ph` plotted as the driving variables. |
| `mhe.survey_compliance` | scalar | Are we getting the data the experiment needs? | Completed surveys over expected (2 per crew per day) for the window, plus per-crew missed counts. |
| `mhe.headcount` | scalar | Is anyone unaccounted for? | `Σ rooms.crew_count` against rated crew from config (`crew_size`, default 5 — never a literal). Verdict crit when the sum is below the rated crew and no crew member is `outside`; warn when it disagrees with the sum of per-crew `location` values. `inputs`: the per-room counts and the outside count, so a discrepancy is traceable to a room rather than reported as a number. |
| `mhe.stress_vs_co2` | breakdown | Is the crew's stress explained by the air? | Per room: the mean of each occupant's latest `heart_rate_bpm` (normalised against the crew's own 7-day baseline) plotted against the room's ambient `co2_ppm` over the same window, with n per cell. Reports the Pearson correlation and **refuses to state one below n = 10 pairs** — at a 5-minute room cadence and a 1-minute vitals cadence a correlation over a short window is noise. This is the measure behind `32`'s scatter and `33`'s cross-signal relation. |

### 3.5 OPG measures

| Key | Kind | Answers | Computation |
| :--- | :--- | :--- | :--- |
| `opg.margin` | scalar | Is the plant covering its load right now? | `P_solar + P_diesel − P_load` at the latest sample, in kW, signed: positive = charging the bank, negative = discharging. This is the ΔP HUD in `DESIGN_SYSTEM.md` §5.3 and the same figure the flow diagram animates, so it is defined once (`00` convention 8). Verdict: `ok` when ≥ 0, `warn` when negative but the bank is above the reserve, `crit` when negative and below it. `inputs`: the three powers and the SOC. |
| `opg.energy_balance` | series | Where did the energy come from? | Per bucket, kWh in and out per source: `solar/1e3 × dt`, `diesel/1e3 × dt`, battery signed, load. Stacked. Summary: total kWh, renewable fraction, diesel litres (from `runtime_h` delta × consumption) . |
| `opg.time_to_reserve` | scalar | How long until the batteries hit the reserve? | From the last 15 minutes of `battery_power_w`, the net discharge rate, and `(soc − reserve)/100 × battery_kwh`. Returns `null` with verdict `ok` when charging. Verdict warn under 60 min, crit under 15 min. |
| `opg.storm_cost` | scalar | What did the storm cost? | Correlates an LWM storm window (if present) with the solar deficit against `opg.solar.min_ratio` and the diesel kWh generated in the same window. Without LWM, uses the OPG `solar_underperformance` alerts as the window. |
| `opg.generator_duty` | breakdown | Are the generators being cycled sanely? | Per generator state history in the window: hours running, starts, failed starts, fuel consumed, average output as a fraction of rating. |
| `opg.forecast_margin` | series | Will we cover the load tonight? | Projected load from the last 60 minutes, projected solar from the irradiance curve, and the resulting margin, drawn against zero. |
| `opg.battery_health` | scalar | Is the bank ageing? | `battery_health_pct` trend slope over the window plus cycle count inferred from charge throughput. |

### 3.6 Cross-service measures

| Key | Answers | Computation |
| :--- | :--- | :--- |
| `platform.event_impact` | "What else happened when this happened?" | Given a time window, lists correlated alerts and events across all services with a 2-minute clustering window, and returns the clusters. Used by `05`'s `related` field and by the Overview. |
| `platform.service_health` | "Which service is the weak link right now?" | Per service: messages/min, gap count, last-ts age, offline minutes, open alerts by severity. |

---

## 4. Data contracts

```ts
interface MeasureResultSummary { [k: string]: number }
interface MeasureContext {
  store: Store; limits: Limits; topology: TopologyRegistry;
  now: number; from: number; to: number; service: string;
}
```

---

## 5. Failure modes

| Failure | Behaviour |
| :--- | :--- |
| Measure needs data the service never sent | Returns `value: null`, `verdict: 'unknown'`, and a `reason` string |
| Measure over a window with no rows | Empty series, `summary.n = 0`; the UI shows "no data in this window" |
| Rollup writer lags | Measures fall back to the raw path and log once |
| A limit key is missing from the API | Verdict uses `unknown` and says which limit is missing |
| Two services, one measure name | Namespaced by service key; `platform.*` is reserved |

---

## 6. Test plan

- Unit per measure: a seeded fixture with a known answer, asserted exactly.
- Unit: verdict boundaries at the limit, one epsilon either side.
- Unit: null handling — a measure with 50 % nulls reports `n` correctly and never treats null as 0.
- Integration: each measure over HTTP within its default window, asserting shape and < 300 ms.
- Property: `opg.time_to_reserve` is monotonic in SOC for a fixed discharge rate.

---

## 7. Open decisions

- **Do measures run on the server or the client?** Long-window and multi-entity measures run on
  the server (they need the store). Instant accumulators (the scan mosaic, the last-60-second
  rate) stay on the client (`13`). A measure that needs live data faster than an HTTP round trip
  must still have a server definition, because replay and the alert context use it.
- **Is the rollup a cache or a source of truth?** A cache. It can be rebuilt from `telemetry`
  with a single command documented in `53`.