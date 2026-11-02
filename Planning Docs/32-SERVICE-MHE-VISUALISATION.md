# 32 — MHE Visualisation

**Service.** Mars Habitation Experiment.

**Component.** The habitat plan, the crew matrix, the survey grid and the correlation views — the
four surfaces that turn 90 days of habitation data into "which room, which person, which week".

**Owner files.** `web/src/pages/Mhe.tsx`, `web/src/lib/imaging.ts` (room geometry),
`web/src/components/charts.tsx` (consumed), `web/public/resources/mars-habitation-experiment-room-layout.svg`
(the authority for the floor plan).

**Rubric.** Visualisation 30 % of the service score. 25 % tabular; 50 % basic graphical; 75 %
*"graphical representation informed by service structure"*; 100 % *"supports exploration and insight
beyond a table, e.g. drill down, comparison, correlation, derived views"*.

The 75 % band is the floor plan drawn from the facility's own drawing and coloured by a hazard
derived from the service's own limits. §5 is the 100 % band.

---

## 1. Workspace layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ MHE header: mission day 41/90 · habitability 7/9 · crew 5/5 · alerts · power   │
├───────────────────────────────────────────────┬──────────────────────────────┤
│  LEFT                                          │  RIGHT                       │
│  ┌─────────────────────────────────────────┐  │  Room console (31 §2.1)      │
│  │ Habitat plan (floor plan, hazard fill)   │  │  ─ setpoints vs measured     │
│  │  Q1 Q2 Q3 Q4 Q5                          │  │  ─ lighting window           │
│  │  ├── common ──┤ ├── lab ──┤              │  │  ─ systems / seal            │
│  │  └──── hydroponics ────┘ [airlock]       │  │  §30-min trends              │
│  └─────────────────────────────────────────┘  │                              │
│  ┌────────────────────┬────────────────────┐  │  Crew console (31 §2.5)      │
│  │ Room detail (3)    │ Crew matrix (4)    │  │  Presets                     │
│  └────────────────────┴────────────────────┘  │  Command log                 │
│  ┌─────────────────────────────────────────┐  │                              │
│  │ Survey grid, 90 mission days × 5 crew   │  │                              │
│  └─────────────────────────────────────────┘  │                              │
└───────────────────────────────────────────────┴──────────────────────────────┘
```

The header answers "is the habitat habitable right now" in four numbers: rooms inside all limits,
habitat power, crew heard-from in the last 15 minutes, and open alert count by severity.

---

## 2. Mission-day navigation

The mission is the dataset, so the mission day is the navigation control, not the wall clock.

- A 90-cell mission scrubber across the top of the workspace; captured days are bright, the pre-join
  days (1–39 on the live deployment) are hatched and labelled `NOT CAPTURED` (`30` §5).
- Selecting a day filters every panel below it to that day; "live" jumps to today.
- The scrubber doubles as a heat strip: cell colour is that day's mean mood, so a bad week is
  visible before any panel is opened.
- Playback across days reuses the replay engine (`07`) with `bucketMs = one mission day`, at any
  speed from 1× to 2000×, so a 90-day sweep takes 65 seconds.

**Acceptance.** Selecting day 41 filters the plan, crew matrix and survey grid to day 41, and the
header numbers are computed for day 41 rather than "now".

---

## 3. The habitat plan (the 75 % band)

### 3.1 Structure follows the service

The room geometry comes **verbatim** from `mars-habitation-experiment-room-layout.svg` — the
archived facility drawing — not from a generic grid. Room area on screen is proportional to floor
area, and the 12 m³ airlock is visibly the smallest compartment, which is the point: the plan is a
map of a real place.

| Room | Volume | Adjacency shown |
| :--- | :--- | :--- |
| `quarters-1…5` | 20 m³ each | a row along the north wall |
| `common` | 90 m³ | the largest interior space |
| `lab` | 60 m³ | adjacent to common |
| `hydroponics` | 50 m³ | the wide southern bay |
| `airlock` | 12 m³ | attached to hydroponics, at the edge (it is the door to outside) |

### 3.2 What the fill encodes

The current implementation colours by CO₂ against **hard-coded** thresholds (1000 / 1200 ppm) that
contradict the API's own defaults (1500 warn / 2500 crit, `33` §2). That is a defect (D-10), and it
is also a missed opportunity, because one number cannot answer "which room is the problem".

Fill = **worst criterion severity**, normalised across every limit that applies to that room:

```
severity = max over criteria of  frac deviation
  temperature: |t − nearest limit| / limit span,      span = warn − min for low, max − warn for high
  humidity:    same, with the hydroponics 85 % upper limit
  co2:         (ppm − warn) / (crit − warn), clamped at 1
  o2:          (min − ppm) / min
  sealed/unoccupied rules applied: occupancy 0 ⇒ no CO₂ criterion
```

- Fill below 0 → `--ok`; 0–1 → `--warn` interpolated; ≥ 1 → `--crit` with the 12 px glow.
- The plan therefore degrades exactly as the service's own alerts do, because both read the same
  limit values from `10`.
- A room out of spec only because it is *empty and cold* still lights up — correctly, since
  `room_condition` fires on any occupant count.

**Acceptance.** With the API limits in place, a room at 1600 ppm shows amber and at 2600 ppm red;
the plan never disagrees with the `room_condition`/`air_concentration` alerts for the same room.

### 3.3 Overlays

| Overlay | Encoding | Why |
| :--- | :--- | :--- |
| Occupancy | one dot per crew member, at the room's centroid | CO₂ with people is a different fact from CO₂ without |
| Sealed | a diagonal hatch across the room | Explains a CO₂ rise without reading the console |
| Ventilation | a small arrow whose length is `ventilation_m3h` / 400 | Shows the scrubber working |
| EVA | hatch on the airlock plus a door icon on the outside edge | "someone is outside" must be unmissable |
| Lighting | room outline brightness from `lighting_lux` | Shows nights and days at a glance |
| Subsystem fault | a corner badge from `global/state/subsystems` | Explains a room problem that is not the room's fault |

**Acceptance.** Sealing an occupied `common` shows hatch + dots + a zero-length ventilation arrow,
and the fill climbs over the following minutes.

### 3.4 Interaction

| Action | Result |
| :--- | :--- |
| Hover | tooltip: room, volume, occupancy, the three environmental values against their limits, ventilation, sealed, and the worst criterion by name |
| Click | selects the room → room detail (§3.5) and the room console (`31` §2.1) |
| Click a dot | selects that crew member → crew console (`31` §2.5) |
| `1`–`9` | jump to a room by index |
| `c` / `s` | toggle the crew and sealed overlays |

### 3.5 Room detail

Under the plan, for the selected room: a 30-minute triple chart (temperature, humidity, CO₂ with
limit bands), the set-point line drawn on each, and a small table of the room's own state
(`setpoints`, `lighting_schedule`, `environmental_systems`, `sealed`). The set-point line is the
answer to "is this bad?": 24 % humidity is alarming in a quarters room and normal in a lab that is
being dried out.

---

## 4. The crew matrix

Five rows, one per crew member, four columns: mood, stress, fatigue, sleep. Every cell is the latest
survey value, coloured on a shared 1–10 ramp **per column** (because high mood is good and high
stress is bad), with the 7-day mean beneath and a sparkline.

- **Absent** is not blank: a missed survey shows a dashed cell with the deadline that was missed,
  which is what `survey_missed` reports.
- **Stale vitals** show a "last heard 3 min ago" badge on the row, never a frozen number (`30`
  §3.3).
- Clicking a row opens that person's detail: vitals trend, their quarters' lighting window, their
  survey history, and the `crew_health` / `survey_wellbeing` alerts they have attracted.

**Acceptance.** A crew member whose wearable stops shows a stale badge within 2 minutes and a
`crew_status` warning at 5, and their survey cells remain readable.

---

## 5. Exploration, comparison, correlation, derived (the 100 % band)

### 5.1 The survey grid — the signature view

90 mission days on the x-axis, 5 crew on the y-axis, two surveys per cell (morning above the
diagonal, evening below):

```
        day 38  39  40  41  42  43 … 90
crew-1    ◐◑     ◐◑  ◐◑  ◐◑  ◑◐  ▨▨      ← ▨ = missed deadline
crew-2    ◐◐     ◑◐  ◐◑  ◐◐  ◐◑
crew-3    …
```

- Cell colour is `mood` on the 1–10 ramp; a small triangle in the corner encodes `stress` above
  its limit.
- Gaps are visible as gaps, including the three-day window before `survey_wellbeing` can fire — so
  the researcher sees the evidence accumulating before the alert does.
- The whole mission fits on one screen, which no chart of 900 individual points can achieve.

**Acceptance.** A missed end-of-day survey for `crew-4` on day 41 appears as a hatched half-cell and
the day-41 column shows four complete cells, not five.

### 5.2 Drill-down paths

| Path | From → to |
| :--- | :--- |
| Habitat → room | Plan cell → room detail + console |
| Habitat → person | Occupancy dot → crew row → crew detail |
| Person → room | Crew detail → their quarters → lighting window |
| Person → survey | Crew row → the survey grid filtered to that person |
| Day → everything | Mission scrubber → all panels filtered to that day |
| Alert → cause | A `room_condition` alert → the room's 30-minute chart with the limit line |

### 5.3 Comparison

| Comparison | Presentation |
| :--- | :--- |
| Room vs room | All nine rooms' CO₂ on one chart, each labelled, with the sealed ones dashed |
| Crew vs crew | Five small-multiple mood/stress sparklines on a shared y-axis |
| Day vs baseline | The selected day against the mean of the first captured week, as a delta column per metric |
| Mission thirds | Days 40–57 vs 58–74 vs 75–90 side by side: the "third-quarter effect" question, answered from captured data |

### 5.4 Correlation

Two scatters, each with a fitted trend and a stated n:

| Scatter | x | y | Colour | Question |
| :--- | :--- | :--- | :--- | :--- |
| Sleep vs light | lighting window length (h) in that person's quarters | that night's `sleep_quality` | crew | *Is the lighting stealing sleep?* |
| CO₂ vs occupancy | `co2_ppm` | `crew_count` | sealed (yes/no) | *Is the CO₂ an occupancy fact or a ventilation failure?* |

Both are computed from the captured series through `GET /api/series/……?aggregate=…` (`04` §4.6,
`08` §3). The scatter is honest about n and refuses to fit below 10 points, saying so.

### 5.5 Derived views

| View | Content |
| :--- | :--- |
| Habitability strip | Per mission day: hours each room spent out of spec, stacked, so a chronic offender separates from a one-day upset |
| Exposure ranking | `mhe.co2_exposure` per crew member per week, ranked, with the room that contributed most |
| EVA readiness | The five crew scored against the 3-day vitals trend, with the proposed pair |
| Crop projection | `estimated_yield_kg` trajectory against the harvest date, with the water/nutrient excursions marked |
| Mission clock | Day, state, days remaining, and a count of missed surveys to date |

**Acceptance.** For each view, a researcher can state the question it answers without reading the
documentation — that is the acceptance test for the Data and Visualisation bands together.

### 5.6 States the workspace must handle

| Situation | Rendering |
| :--- | :--- |
| No topology yet | "waiting for the MHE topology" |
| Pre-join days selected | Hatched cells, `NOT CAPTURED` badge, backlog reference offered (`30` §5) |
| `mission_state == complete` | Everything read-only, "mission complete — 90 days" badge, derived views frozen at day 90 |
| Service offline | `--inert` overlay and a banner; last known values retained but marked stale |
| Replay active | Purple chrome, `HISTORICAL REPLAY` badge, mission scrubber following the cursor |

---

## 6. Failure modes

| Failure | Symptom | Handling |
| :--- | :--- | :--- |
| Limits not yet fetched | No basis for severity colouring | Render in `--unknown` grey with "limits pending" and never invent thresholds (D-10) |
| Room geometry and topology disagree | A room in `$topology` with no plan box | Render it in an "unplaced" strip below the plan rather than dropping it |
| 2000× live feed | Panels re-render faster than a human reads | Panels read from aggregate/rollup values, not raw samples (`13` §4.4) |
| Survey grid with 900 cells | Layout thrash on the scrubber | Canvas-rendered grid with a static hit map |
| Missing `crew_count` for a room | Occupancy overlay empty | Derive occupancy from vitals `location` and mark it "inferred" |
| A day with no captured data mid-run | Silent gap in the matrix | Render as a hatched column labelled `no capture`, distinct from `missed survey` |

---

## 7. Test plan

| # | Test | Type |
| :--- | :--- | :--- |
| 1 | Plan fill matches the max normalised criterion for each room against API limits | unit |
| 2 | A room at 1600 ppm is amber and 2600 ppm red with default limits (regression for D-10) | unit |
| 3 | Pre-join days are hatched and cannot be selected as captured | unit |
| 4 | Survey grid renders 90 × 5 × 2 cells with missed surveys as hatched halves | snapshot |
| 5 | Stale vitals badge appears at >2 min and the value is not carried forward | integration |
| 6 | Mission scrubber filters all panels to the selected day | integration |
| 7 | Scatter refuses to fit below n = 10 and states the reason | unit |
| 8 | Replay renders purple chrome and follows the cursor | integration |
| 9 | `mission_state == complete` puts the workspace in read-only mode | integration |

---

## 8. Open decisions

| # | Decision | Recommendation |
| :--- | :--- | :--- |
| 1 | One hazard fill, or a selectable metric (temperature / humidity / CO₂)? | Worst-criterion by default with a segmented override; the default must never require the researcher to pick a metric before seeing a problem |
| 2 | Is the survey grid worth the implementation cost? | Yes — it is the single clearest "insight beyond a table" artefact in the project and it makes missed surveys self-evident |
| 3 | Canvas or SVG for the plan? | SVG, because it is nine interactive elements, not a pixel field; canvas only for the survey grid |
| 4 | Should the mission scrubber be visible on other services' pages? | No, but the mission day should be in the global header so an RTA alert can be read against mission day |
| 5 | Correlation honesty | Always show n and the fitted line's slope with its uncertainty; a scatter without n is a false claim |