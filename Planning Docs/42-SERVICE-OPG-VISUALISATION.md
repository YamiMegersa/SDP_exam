# 42 — OPG Visualisation

**Service.** On-demand Power Generation.

**Component.** The energy flow diagram, the state-of-charge trajectory, the 24-hour mix, the load
profile heatmap and the solar performance scatter — the five views that make a plant with four
entities legible.

**Owner files.** `web/src/pages/Opg.tsx` (`EnergyFlow`, `MarginHud`, `SocGauge`, `TrendGrid`),
`web/src/components/charts.tsx` (consumed), `web/src/lib/format.ts` (`watts`, `signed`, `pct`).

**Rubric.** Visualisation 30 % of the service score. 75 % band: *"graphical representation informed
by service structure"*; 100 % band: *"drill down, comparison, correlation, derived views"*.

The floor plan is MHE's structural view; **the energy flow diagram is OPG's**. It is the plant's
actual topology — solar in from the array, diesel in from the generators, a bidirectional battery
branch, one bus, one load — and it is already the best thing on the existing page.

---

## 1. Workspace layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ OPG header: generation · load · margin · supply mode · SOC · fuel · alerts     │
├───────────────────────────────────────────────┬──────────────────────────────┤
│  LEFT                                          │  RIGHT                       │
│  ┌─────────────────────────────────────────┐  │  Plant controls (41)         │
│  │ Energy flow diagram                     │  │  ─ mode strip / priority     │
│  │  solar ─┐                               │  │  ─ load shed / reserve       │
│  │  diesel ─┼─▶ BUS ─▶ load                │  │  ─ generator start/stop      │
│  │  battery ┘  ◀─ surplus                  │  │                              │
│  └─────────────────────────────────────────┘  │  Presets                     │
│  ┌────────────────────┬────────────────────┐  │  Schedules (armed rules)     │
│  │ SOC trajectory (3) │ 24-h mix (4)      │  │  Command log                 │
│  └────────────────────┴────────────────────┘  │                              │
│  ┌─────────────────────────────────────────┐  │                              │
│  │ Load profile heatmap (5) · performance (6)│ │                              │
│  └─────────────────────────────────────────┘  │                              │
└───────────────────────────────────────────────┴──────────────────────────────┘
```

---

## 2. Header metrics ("is the plant covering the load?")

| Metric | Source | Presentation |
| :--- | :--- | :--- |
| Generation / load | `global` power stream | Two numbers and a one-word verdict: `SURPLUS`, `BALANCED`, `DEFICIT` |
| Margin | `total_generation_w − total_load_w` | Signed, with a 60-minute sparkline and the zero line marked |
| Supply mode | `supply_mode` | Pill; `mixed` is the normal state and must not be styled as a warning |
| Autonomy | `opg.autonomy_hours` | "7.3 h at the current 280 kW" — with the reserve already deducted |
| Fuel | `fuel_level_pct` | Percentage **and** the derived run-hours at the current load |
| Alerts | open counts | Chip that filters the alert gutter |

**Acceptance.** Every header number derives from a measure or live state and carries a tooltip
naming its source; nothing is hard-coded (the existing `fuel < 20` constant is the counter-example
and must go, D-10).

---

## 3. The energy flow diagram (the 75 % band)

### 3.1 Structure follows the service

```
                        ┌──────────────┐
   ☀ solar  ───────────▶│              │
   1 200 kWp            │     BUS      │───────────▶  base load
   inverter 1 000 kW    │              │              (housing, lab,
                        │              │               water treatment)
   ⛽ diesel ───────────▶│              │
   2 × 250 kW           └──────┬───────┘
                               │
                        ┌──────▼───────┐
                        │  batteries   │  4 000 kWh · ±800 kW
                        │  ▓▓▓▓▓░░░░░  │  SOC with the reserve band marked
                        └──────────────┘
```

- Node positions mirror the plant description (solar south of the lab, generators as a pair reported
  as one entity, the bank as a bidirectional branch).
- Link animation speed is proportional to that link's power and **capped**, so 900 kW does not
  strobe; direction reverses for a charging battery.
- The battery node carries an inline SOC bar **with the reserve band shaded**, so "we are 4 points
  above the reserve" is a shape, not a subtraction.
- A **curtailment stub** leaves the solar node towards nothing when expected output exceeds the
  inverter cap or the array's accepted output. Curtailment is otherwise invisible and is the reason
  a 1200 kWp array never shows 1200 kW.
- Every node shows `stale` explicitly: if the last sample is older than 2.5× the 60 s period, the
  animation stops and a `STALE · 4 min` label appears. **An animation that keeps flowing on stale
  data is a lie**, and it is the most likely way this diagram misleads.

### 3.2 States the diagram must handle

| Situation | Rendering |
| :--- | :--- |
| `inverter_status = offline` | Solar node dimmed with "array disabled", no flow |
| `inverter_status = fault` | Solar node red, no flow, fault badge |
| `generator_status = starting` | Diesel node pulsing with a 30 s countdown |
| `generator_status = fault` | Diesel node red with "start failed" or "tripped" |
| `supply_mode = diesel` | Diesel link at full weight, others thin |
| `supply_shortfall` open | The load node red with `unserved_w` drawn as a clipped branch |
| Offline service | All nodes `--inert`, one banner, no animation |

**Acceptance.** A `generator_trip` injection turns the diesel link off within one frame, marks the
node red, and the load node immediately shows the uncovered portion.

### 3.3 Interaction

| Action | Result |
| :--- | :--- |
| Hover a node | Tooltip: entity, its raw fields, last `ts`, and the field's unit and limit |
| Click a node | Selects that entity → its detail panel (`solar`, `batteries`, `diesel`, `global`) |
| Click the load | Switches the lower-left panel to the load composition view (RTA/MHE/base) |
| Click the battery | Opens the SOC trajectory (§4) focused on the reserve line |

---

## 4. SOC trajectory

The line that matters is not the SOC itself but the **distance to the reserve**, because the reserve
is where the generators start.

```
 100 %
      ▁▂▃▄▅▆▇█▇▆▅▄▃▂▁▂▃▄▅▆▇█▇▆▅▄▃▂      ← 48 h, 5-min buckets
  45 % ┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈    reserve_pct (dashed, changes are marked on the line)
  20 % ─────────────────────────────────
   0 %
        ▲ night              ▲ refuel-generated reserve change
   projected: ─ ─ ─ ─▶ hits the reserve at 03:40
```

- The reserve line is drawn **as it changed over time**, from the state history, so a researcher can
  see that the bank hit the reserve because the reserve was raised.
- The projection is `opg.autonomy_hours` applied forward at the current net draw, dashed, and it
  stops at the reserve line rather than continuing through it.
- Charge/discharge is encoded by the fill under the curve (charging above, discharging below), so
  the shape carries the sign of `battery_power_w` even though the y-axis is SOC.

**Acceptance.** During a night-time drain the projection reaches the reserve line within a bucket of
the actual generator start; a reserve change mid-window appears as a step in the dashed line.

---

## 5. The 24-hour energy mix

A stacked area over the simulated day, x = `local_hour`, y = kW:

- Positive stack: solar, diesel, battery discharge.
- Negative: battery charge, curtailment.
- A second panel beside it: the same day as **kWh shares** (`opg.energy_mix`), with the diesel share
  called out as a percentage, because that is the number a researcher quotes.
- The stack is computed from the three source powers, **never from `supply_mode`** (`40` §4.3).
- Yesterday is drawn behind today as a thin grey outline — the cheapest useful comparison available.

**Acceptance.** The stack's total at any hour equals `total_load_w` within the reconciliation
tolerance; a day with no diesel shows no diesel band at all rather than a zero-width artefact.

---

## 6. Load profile heatmap and solar performance

### 6.1 Load profile

7 days × 24 hours, cell colour = mean load in kW, with `local_hour` on the x-axis and the sim day on
the y. Two derived annotations:

- The **peak hour** of the week, labelled.
- The **scan-contribution overlay**: cells whose hour overlaps an RTA scan window get a small dot,
  so the correlation between observing and power draw is visible without a second chart.

This is the view that answers "when is the base expensive to run", and it is also the input to the
`x.rta_scan_cost` measure (`40` §5).

### 6.2 Solar performance scatter

| Axis / encoding | Value |
| :--- | :--- |
| x | `irradiance_wm2` |
| y | `power_output_w` |
| Colour | sim day (older = lighter) |
| Line | the calibrated expectation (`40` §4.2) |
| Point size | sample count in the bucket |

- The current operating point is marked and labelled.
- Points below the line on recent days = soiling or a string failure. Points below the line with a
  `inverter_fault` alert = a fault. **That is the drill-down the "dirty or broken" question needs.**
- Below 200 W/m² the region is shaded `not judged`, matching the service's own alert condition.

**Acceptance.** Injecting `soiling(ratio 0.85)` moves the recent points to ~0.85 of the line while
older points stay on it; injecting `string_failure` moves them further and raises the alert.

---

## 7. Exploration, comparison, correlation, derived (the 100 % band)

### 7.1 Drill-down paths

| Path | From → to |
| :--- | :--- |
| Plant → source | Flow node → that entity's panel with its raw fields and limits |
| Source → history | Panel → the source's own 24-h curve at that entity's resolution |
| Plant → load | Load node → the composition view (base, RTA scan, MHE habitat) |
| Day → hour | Mix chart → click an hour → that hour's bucket detail and the events in it |
| Alert → cause | A `solar_underperformance` alert → the performance scatter focused on its window |
| Fuel → delivery | The fuel sawtooth → the `refuel` event that caused the step |

### 7.2 Comparison

| Comparison | Presentation |
| :--- | :--- |
| Today vs yesterday | Overlay on the mix chart; delta kWh and delta diesel share |
| Week vs week | Two load-profile heatmaps side by side |
| Priority effect | The days before and after a `generation_priority` change, with diesel kWh per day |
| Reserve setting | Diesel kWh and shortfall minutes against the reserve value in force that day |

### 7.3 Correlation

- **Irradiance vs output** (§6.2) — the physics.
- **Load vs hour** (§6.1) — the demand.
- **SOC vs hour-of-day**, per day, as thin lines: the "does the bank survive the night" question,
  answered visually by how often the lines touch the reserve.
- **Diesel burn vs load**: litres per hour against delivered kW, which exposes a generator running
  at low load (inefficient and the classic real-world finding).

### 7.4 Derived views

| View | Content |
| :--- | :--- |
| **Reliability calendar** | One cell per sim day for 30 days, coloured by `opg.shortfall_minutes` and annotated with unserved kWh; the honest answer to "how reliable is this plant" |
| **Energy budget** | Generated vs consumed vs stored, per day, as a waterfall — where the kWh went |
| **Carbon counter** | kg CO₂ per day from diesel (`opg.carbon`), cumulative for the capture window |
| **Autonomy gauge** | Hours of load coverable now, with the reserve already deducted, against a target of "overnight + 2 h" |
| **Curtailment summary** | kWh thrown away because the inverter was full, which is the argument for more storage |

**Acceptance.** For each view, a researcher can state its question without reading documentation.

### 7.5 States

| Situation | Rendering |
| :--- | :--- |
| No topology | "waiting for the OPG topology" |
| Service offline | Inert overlay, banner, animation stopped |
| Replay | Purple chrome, `HISTORICAL REPLAY` badge, flow diagram and SOC line following the cursor, and a "reconstructed" note because the flow is derived, not measured |
| 500× live | Aggregates refreshed at most 1 Hz; the flow diagram never animates faster than its cap |

---

## 8. Failure modes

| Failure | Symptom | Handling |
| :--- | :--- | :--- |
| Stale sample | A flowing diagram over old numbers | `STALE` label at >2.5 periods, animation halted |
| Reconciliation gap | The stack does not sum to the load | Draw the residual as a hatched band labelled `unreconciled` and badge the header (D-10 successor) |
| Missing `irradiance_wm2` | Scatter collapses | Hide the scatter and say the field was not reported; never plot against zero |
| Very large `power_output_w` | Diagram scale saturates | Scale link widths by `log1p`, and label absolute values |
| Replay of a partially captured day | Gaps in the stack | Hatch the gaps, keep the axis, and note the achieved bucket size |
| Reservoir of alerts during a storm | Header chips overflow | Chips collapse to "+3 more" and open the gutter |

---

## 9. Test plan

| # | Test | Type |
| :--- | :--- | :--- |
| 1 | Flow node direction and weight match signed `battery_power_w` | unit |
| 2 | Solar node shows curtailment when expected > delivered and inverter is at cap | unit |
| 3 | Stale detection stops animation and shows the age | unit |
| 4 | SOC projection stops at the reserve line and does not continue through it | unit |
| 5 | Mix stack totals to `total_load_w` within tolerance, and shows `unreconciled` when it does not | integration |
| 6 | `fuel < 20` hard-coded threshold is gone; fuel colour follows the API limit (regression for D-10) | unit |
| 7 | Performance scatter rejects below 200 W/m² and follows `soiling(ratio 0.85)` | integration |
| 8 | Reliability calendar shows the shortfall minutes for each simulated day | integration |
| 9 | Replay follows the cursor and renders the reconstructed note | integration |

---

## 10. Open decisions

| # | Decision | Recommendation |
| :--- | :--- | :--- |
| 1 | Is the flow diagram worth its complexity? | Yes — it is the only view that shows the plant as a plant, and it is the cheapest 75 %-band evidence in the project |
| 2 | Animation cap | Cap at ~1.5 Hz of visual motion regardless of power; a fast-moving diagram is unreadable and dishonest at 500× |
| 3 | Curtailment: show or omit? | Show. It explains why 1200 kWp never yields 1200 kW and it is a genuine researcher question about storage sizing |
| 4 | Reliability calendar vs a shortfall trend line | Calendar; a trend line hides the clustering that matters operationally |
| 5 | Carbon counter | Keep — it is two lines of arithmetic and it makes the plant a subject of research rather than a utility |