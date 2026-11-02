# 30 — MHE Data

**Service.** Mars Habitation Experiment: nine compartments, five crew, a 90-day mission, and a
90-day-long dataset that the platform joins on day 40.

**Component.** Everything from the wire to a research answer: the six telemetry streams, the seven
state items, the three event kinds, the mission clock that makes 90 days legible at 2000×, and the
derived measures that turn "the crew are fine" into a question with an answer.

**Owner files.** `server/src/services/mhe.ts`, `server/src/db/queries.ts` (mission-day bucketing),
`web/src/lib/live.ts` (§ survey and vitals accumulation), `web/src/pages/Mhe.tsx` (data half).

**Rubric.** Data 30 % of the service score. 100 % band: *"the data is used to answer a question a
researcher would actually ask"*, with the 75 % band already requiring *"at least one derived or
aggregated measure"*.

**Depends on.** `02` (topology), `03` (ingest), `04` (store), `10` (limits), `11` (measure layer).

---

## 1. The authoritative data model

From `arl-mhe-spec.pdf` §1–§2. Nothing below may be invented.

### 1.1 Entities

| Kind | Ids | Notes |
| :--- | :--- | :--- |
| `room` | `quarters-1` … `quarters-5`, `common`, `lab`, `hydroponics`, `airlock` | Ids match the habitat plan SVG. **`quarters-n` is crew-n's private room.** Volumes: quarters 20 m³, common 90, lab 60, hydroponics 50, airlock 12 |
| `crew` | `crew-1` … `crew-5` | Five people, each with a wearable |
| `service` | `global` | Mission clock, power, subsystems, alert summary |

The quarters/crew pairing is not decoration: it is what lets a room-level CO₂ problem be attributed
to a person and a person's sleep quality be attributed to a room's lighting window.

### 1.2 Telemetry — six streams

**`arl/mhe/<room>/telemetry/environment` every 300 s**

| Key | Unit | Meaning |
| :--- | :--- | :--- |
| `temperature_k` | K | Air temperature |
| `humidity_pct` | % RH | Relative humidity |
| `oxygen_ppm` | ppm | ≈ 209 000 normally |
| `co2_ppm` | ppm | ≈ 420 in an empty, ventilated room |
| `pressure_kpa` | kPa | 101.3, or ≈ 0.7 for a depressurised airlock |
| `lighting_lux` | lux | Current light level |
| `ventilation_m3h` | m³/h | **0 when sealed, disabled or failed** |
| `crew_count` | count | Occupancy now |

**`arl/mhe/hydroponics/telemetry/hydroponics` every 300 s** — `water_level_l` (400 L reservoir),
`nutrient_ec_mscm` (≈1.2–2.4, rises as water evaporates), `water_ph` (≈5.5–6.5), `growth_stage`
(`germination|vegetative|flowering|harvest`), `estimated_yield_kg`.

**`arl/mhe/airlock/telemetry/airlock` every 300 s** — `airlock_state`
(`pressurised|cycling|depressurised`), `inner_door`, `outer_door`, `eva_in_progress`.

**`arl/mhe/lab/telemetry/equipment` every 300 s** — `equipment_status`
(`ok|degraded|fault`).

**`arl/mhe/<crew>/telemetry/vitals` every 60 s** — `heart_rate_bpm`, `body_temperature_k` (≈310),
`respiratory_rate_bpm`, `spo2_pct`, `movement` (0–1), `location` (a room id, or `outside`).

**`arl/mhe/global/telemetry/habitat` every 300 s** — `mission_day` (1–90), `power_w`.

### 1.3 Retained state — seven items

| Topic | Type |
| :--- | :--- |
| `<room>/state/setpoints` | `{temperature_k, humidity_pct, ventilation_m3h}` |
| `<room>/state/lighting_schedule` | `{start "HH:MM", end "HH:MM", level_lux}` |
| `<room>/state/environmental_systems` | boolean |
| `<room>/state/sealed` | boolean |
| `hydroponics/state/irrigation_schedule` | `{start "HH:MM", end "HH:MM", volume_l}` |
| `global/state/subsystems` | `{ventilation, heating, water, hydroponics, airlock, power_distribution, comms}` each `ok|degraded|fault` |
| `global/state/mission_state` | `running|complete` |
| `global/state/online`, `global/state/active_alerts` | mandatory for every service |

`setpoints` is the single most valuable state item in this service: without it a temperature reading
is a number with no judgement attached (`32` §3).

### 1.4 Events — three kinds

**`arl/mhe/events/survey`** — one per crew member, per survey: `{survey_type:
start_of_day|end_of_day, mission_day, mood, stress, fatigue, sleep_quality}`. All scores 1–10,
higher is more (high stress and fatigue are bad). `sleep_quality` **only** in the start-of-day
survey. **A missed survey produces no event.**

**`arl/mhe/events/eva`** — `{event, crew[]}` from the airlock; start and end.

**`arl/mhe/events/alert`** — see `33`.

### 1.5 Machine facts that shape the design

| Fact | Consequence |
| :--- | :--- |
| 90-day mission; the live deployment joins **on day 40** | Everything before the join exists only in the API backlog, which the platform must not present as its own capture |
| Mission time, not wall time, is the only clock | Buckets are mission days (`mission_day` from the habitat stream), never wall-clock dates |
| Vitals every 60 s × 5 crew + 13 room/habitat streams every 300 s | ≈ 0.1 msg/s at 1× — the *lowest* rate of the three services |
| `max_speedup` is **2000** | At 2000× the whole mission is ≈ 65 minutes and the service emits ≈ 250 msg/s. This is the highest *compression ratio*, so wall-clock reasoning breaks completely |
| A survey is due twice per mission day; at 2000× that is one every ≈ 2.2 wall seconds | Survey handling must be streaming, not "load the day's surveys" |
| `mission_state` becomes `complete` after day 90; surveys stop | The console must handle a finished mission without looking broken |
| Vitals **stop** when a wearable is off; the field is not null, the message is absent | Absence is the signal (`crew_status`), so the store must distinguish "no message" from "null field" |
| The airlock is exempt from `room_condition` and `air_concentration` while cycling or depressurised | Missing airlock alerts in that window are correct, not a bug |
| `ventilation_m3h = 0` means sealed, disabled **or** failed — three different causes | The cause must come from `sealed`, `environmental_systems` and `subsystems`, never from the flow reading |

---

## 2. Capture requirements (Data criterion)

### 2.1 Completeness checklist

| Requirement | Where it is satisfied |
| :--- | :--- |
| All six telemetry streams, all fields, including nulls | `03` §4.2 wildcards + null preservation |
| All seven state items, de-duplicated | `03` §4.3 |
| Every survey event, attributed to its crew member | `03` (§ event `entity`) — currently **broken**, see §4.1 |
| Every EVA start/end with the crew list | `03` |
| Alerts with `vital`, `count`, `location`, `reason`, `crew_count`, `sealed`, `subsystems` metadata | `05` §4.1.1 |
| Mission day on every row | §4.2 below |
| Survives 2000× | `03` §4.4 back pressure, `04` batched transaction |
| No unrecorded loss | `seq` gap detection per topic |

### 2.2 The high-compression case

RTA stresses throughput; MHE stresses **compression**. At 2000×:

1. A mission day is 43 wall seconds. A 3-day wellbeing mean must be computed over 2.1 wall
   seconds of data, so it cannot be computed on a timer that assumes human pacing.
2. The survey cadence is ~2.2 s apart, which is faster than a human can read a card. The UI must
   aggregate rather than append, and the survey timeline (`32` §5) is the only honest presentation.
3. Query windows expressed in wall-clock minutes are meaningless. Every window in `04` and `07`
   takes simulator milliseconds, and every bucket is a mission-day fraction.

**Acceptance.** A 2000× run from mission day 40 to day 42 produces 2 full days of surveys with no
dropped messages, and the wellbeing panel shows a 3-point mean rather than 90 individual cards.

---

## 3. Normalisation pipeline

```
wire → classify → decode → gap check → batch → SQLite (with sim_day + mission_day)
                                    └→ bus → WS → live store → selectors → panels
```

### 3.1 Mission day as a first-class dimension

- **Responsibility.** Make "day 41" a queryable fact rather than a derived guess from `ts`.
- **Contract.** Every MHE row carries `mission_day` (from the last `global/telemetry/habitat`
  message, forward-filled) and `day_fraction` (`0..1`, from `ts` within the day).
- **Steps.** On ingest, keep the latest `mission_day` per service in memory; stamp it on all MHE
  rows. Rows that arrive before the first habitat message get `mission_day = null` and are
  reconciled by a sweep once the first one lands. `series()` and `aggregate()` gain an optional
  `by: 'mission_day'` bucket mode (`04` §4.6).
- **Acceptance.** A 40→42 run returns exactly three distinct `mission_day` values, and a query for
  day 41 returns the same rows regardless of `ARL_START_TIME`.

### 3.2 Occupancy-weighted exposure (the reason to store `crew_count`)

- **Responsibility.** Turn two streams into a number that has physical meaning.
- **Contract.** `co2_exposure = Σ_rooms Σ_t co2_ppm × crew_count × Δt / 3 600` in ppm·crew·h, per
  mission day, per room and per crew member (via `location`).
- **Steps.** Computed in `11`'s measure layer over 5-minute buckets, persisted to `rollup`, and
  recomputed on backfill. `crew_count` comes from the room stream; attribution to a person uses
  the vitals `location` at the same bucket.
- **Acceptance.** Sealing `common` with three crew for one mission hour raises that room's
  exposure by ≈ 3 × baseline and leaves the other rooms flat.

### 3.3 Nulls and absences

- A null field is stored as null and rendered as `—` with the tooltip naming the field.
- **Absent vitals** are not nulls: they mean the wearable stopped, and after 5 minutes the service
  raises `crew_status`. The live store keeps `lastSeen[crew]` so `32` can show "last heard 3 min
  ago" instead of a frozen number that silently ages.
- A **missed survey** produces no event, so "no survey today" must be derived from the absence of
  `survey_type = end_of_day` for that `mission_day`, not from a null field.

---

## 4. Derived measures and the questions they answer

### 4.1 Fixing survey attribution first (D-9)

The current client reads `service.events.find(e => e.name === 'survey')` and treats
`payload.surveys ?? payload` as a map keyed by crew id. Survey events are **per crew member** and
carry flat scores, so this shows one person's mood on every card, and because `LiveEvent` drops the
envelope `entity`, the crew member cannot be recovered client-side. Fix in `13` §4.4: keep `entity`
on `LiveEvent` and key surveys by `(crew, mission_day, survey_type)`. Nothing below is valid until
this is fixed.

### 4.2 The measure table

Every row is a question a researcher would actually ask. `11` defines the container; this is the
MHE content.

| Measure | Question it answers | Definition | Window |
| :--- | :--- | :--- | :--- |
| `mhe.wellness_trend` | *Is the crew's mood falling faster than their stress is rising, and is it the same people each time?* | Per crew and for the crew mean: 3-day means of `mood`, `stress`, `fatigue`, plus 7-day mood decline, each against its limit | rolling 3 / 7 mission days |
| `mhe.sleep_debt` | *Is the lighting window in the quarters stealing sleep?* | `sleep_quality` mean per crew against the lighting window length and level in their own room | per mission day, 7-day trend |
| `mhe.co2_exposure` | *Which room is the CO₂ problem actually in — and is it because it is sealed or because it is occupied?* | §3.2, split by `sealed` true/false | per mission day per room |
| `mhe.air_exchange` | *Is the scrubber doing anything, or is the room just empty?* | Δ`co2_ppm`/h against `ventilation_m3h` and `crew_count`, so "CO₂ rose 400 ppm with 3 people and 120 m³/h" is distinguishable from the same rise sealed | 30 min |
| `mhe.habitability` | *Of the nine rooms, which are inside spec right now and which are not, and for how long today?* | Fraction of rooms inside all `room_condition` limits, plus the worst room and the hours out of spec per room per day | per mission day |
| `mhe.eva_readiness` | *Can we run the EVA on Thursday, and who should go?* | `spo2`, resting heart rate trend and `sleep_quality` over the last 3 days per crew, against the crew-health limits | 3 mission days |
| `mhe.crop_projection` | *Will this crop make its yield, given the water and nutrient history?* | `estimated_yield_kg` trend against `water_level_l` minima, `nutrient_ec_mscm` and `water_ph` excursions, and days to `harvest` | per crop cycle (30 days) |
| `mhe.mission_progress` | *Where are we in the mission, and what is still ahead?* | `mission_day / mission_days`, `mission_state`, and days since the last missed survey | whole mission |

Two of these (`wellness_trend`, `co2_exposure`) are the ones to demo: they are the strongest
evidence that the data layer is doing research work rather than relaying numbers.

### 4.3 What must *not* be done with the data

| Temptation | Why it is wrong |
| :--- | :--- |
| Backfilling days 1–39 from the API backlog into the platform's own history | The backlog is a different instrument. It may be *cited* (§5) but never merged into captured series |
| Interpolating missing vitals | A flat line implies a healthy crew member; the truth is a dead wearable |
| Computing 3-day means from 1 day of data | It produces a confident number with no variance. Return `insufficient_history` and say how many days are needed |
| Treating `ventilation_m3h = 0` as a fault | It is also what sealing a room correctly does |
| Averaging rooms of different volumes equally | `common` is 90 m³ and `airlock` is 12 m³; the volume is in `$topology` metadata and must weight any habitat-wide mean |

---

## 5. The mission clock and the backlog boundary

- Mission day 1 is the service's `start_day` (`1` by default, 40 on the live deployment). The
  platform records the join point as `mission_joined_day` on first contact and marks everything
  before it as **out of scope** in the UI.
- The API backlog (`10` §3) may be used for exactly one thing: *reference* — e.g. the researcher
  clicks "show days 1–39 from the ARL backlog" and the panel renders a clearly labelled, visually
  distinct band with a `BACKLOG` tag. It is never written to the local store.
- Replay (`07`) is bounded by the platform's capture window, which starts at the join. The replay
  scrubber labels the join point explicitly so nobody mistakes "day 40" for "the start".

**Acceptance.** On a fresh database the mission panel shows "joined day 40 of 90" and any backlog
request is either disabled with a reason or rendered with a `BACKLOG` tag; no backlog row ever
appears in a captured series.

---

## 6. Persistence and replay specifics

| Concern | Decision |
| :--- | :--- |
| Volume | ~250 msg/s at 2000×; ~1 M rows per real minute of high-speed run. Retention (`04` §8) must be configurable and must never drop alert or command rows |
| Survey storage | `event` table, `kind = 'survey'`, `entity = crew-n`, indexed on `(service, kind, ts)` so a per-crew series is one scan |
| Vitals retention | Telemetry is the bulk. Keep raw vitals for 7 days and roll 1-minute means forever (`11` writer) |
| Replay | 2000× replay of one mission day ≈ 43 s wall; the replay engine decimates on `bucketMs` so the vitals chart keeps its shape (`07` §4.3) |
| Derived in replay | `wellness_trend` and `co2_exposure` are recomputed from `rollup` at the cursor, never from a present-day cached value |
| Restart | `mission_day` forward-fill is rebuilt from the last habitat row on boot so there is no null-day hole across a restart |

---

## 7. Failure modes

| Failure | Symptom | Handling |
| :--- | :--- | :--- |
| Habitat stream silent at boot | `mission_day` null on early rows | Forward-fill from the last stored value; reconcile on first habitat message |
| Speedup changed mid-session | Day boundaries become uneven | Buckets are mission-day based; the uneven wall spacing is invisible by design |
| Survey arrives before its crew entity is known | Attribution lost | `entity` comes from the envelope and is never inferred from payload |
| Two surveys of the same type in one day | Double count in a mean | Key by `(crew, mission_day, survey_type)`; keep the later one and log a `duplicate_survey` |
| Wearable off for a whole day | Crew health panel empty rather than stale | Show "no vitals since …" and the `crew_status` alert, never the last known value alone |
| Mission reaches day 90 | Surveys stop; `mission_state = complete` | Freeze derived measures at the last day and label the mission complete; do not render "0 surveys today" as a failure |
| Backlog fetch times out | Panel stuck loading | Circuit breaker (`10` §5) and a retry button; capture continues regardless |

---

## 8. Test plan

| # | Test | Type |
| :--- | :--- | :--- |
| 1 | Survey events attribute to the correct crew member and render per crew (regression for D-9) | unit |
| 2 | `mission_day` is stamped on every MHE row and survives a restart | integration |
| 3 | `co2_exposure` rises ≈ 3× when three crew are sealed in `common` for an hour | unit (fixture series) |
| 4 | `wellness_trend` returns `insufficient_history` with fewer than 3 days | unit |
| 5 | Absent vitals render as "last heard" and never as a carried-forward value | integration |
| 6 | Missed survey is derived from absence of the `end_of_day` event, not from a null | unit |
| 7 | 40→42 at 2000× yields three mission days and zero dropped messages | end-to-end |
| 8 | Backlog data never enters a captured series (assert row provenance) | integration |
| 9 | Airlock `room_condition` / `air_concentration` are correctly absent while depressurised | unit |

---

## 9. Open decisions

| # | Decision | Recommendation |
| :--- | :--- | :--- |
| 1 | Store `mission_day` denormalised, or derive from `ts` + `start_day`? | Denormalise — `start_day` is not visible in-band after boot |
| 2 | Raw vitals retention | 7 days raw, 1-minute rollups forever; the rollups are what a 90-day view needs |
| 3 | Should the platform offer the backlog at all? | Read-only, visibly tagged, and only for pre-join reference; it is a strong Data-criterion talking point if framed as *reference*, a fatal ambiguity if framed as capture |
| 4 | Hydroponics depth | One measure (`crop_projection`) plus a panel; a full agronomy model is out of scope |
| 5 | `crew_count` from the room stream or from vitals `location`? | Both: room stream for room attribution, `location` for person attribution; disagreement is itself a data-quality signal worth showing |