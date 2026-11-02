# 31 — MHE Controls

**Service.** Mars Habitation Experiment.

**Component.** The nine controls in `arl-mhe-spec.pdf` §3, presented as the two consoles a habitat
researcher actually works in — the environmental console for a room, and the crew console for a
person — plus presets, daily routines and the guards that keep a sealed room from becoming a CO₂
incident.

**Owner files.** `web/src/pages/Mhe.tsx` (controls panes), `server/src/services/mhe.ts` (guards),
`web/src/lib/presets.ts` (MHE section), `web/src/lib/guards.ts`.

**Rubric.** Control 30 % of the service score. 100 % band: *"controls are designed around how a
researcher works, e.g. presets, schedules, safeguards against unsafe commands"*.

**Depends on.** `06` (dispatch, guard table), `15` (presets), `14` (`ControlForm`), `30` (§ mission
clock, § air exchange).

---

## 1. The control inventory (authoritative)

Nine controls: six room-level, one airlock, one hydroponics, one crew.

| Control | Level | Value | Service rules that matter to the UI |
| :--- | :--- | :--- | :--- |
| `adjust_temperature` | Room | float K, 285–300 | Sets the **set point**. The room approaches it over ≈ 30 min — completion is not effect |
| `adjust_humidity` | Room | float %, 20–80 | Sets the humidity set point |
| `lighting_schedule` | Room | `{start "HH:MM", end "HH:MM", level_lux}` | 0–1000 lx generally, **0–30000 lx in hydroponics**. The window **may wrap past midnight**. Quarters lighting affects that crew member's sleep |
| `ventilation` | Room | float m³/h, 0–400 | Sets the ventilation set point. 0 is legal and is not the same as sealed |
| `environmental_systems` | Room | boolean | Off stops heating, humidity control **and** ventilation, so CO₂ builds up if occupied |
| `seal_room` | Room | boolean | A sealed room exchanges no air. **The airlock cannot be unsealed while not pressurised** |
| `crew_wellness_check` | Crew | boolean, must be `true` | `in_progress` until they respond — **minutes when awake, longer when asleep, longer still when outside on an EVA** — then `completed` with detail `ok` or `needs_support` |
| `cycle_airlock` | Airlock | enum `pressurise` \| `depressurise` | 10 min `in_progress`. Rejected while a door is open, during an EVA, or when already in that state |
| `irrigation_schedule` | Hydroponics | `{start, end, volume_l}` | Volume 0–120 L per day into a 400 L reservoir that drains by evaporation and crop use |

Two of these are **schedules disguised as controls** (`lighting_schedule`, `irrigation_schedule`),
which is why §4 treats them as the service-native schedule mechanism rather than one-off settings.

---

## 2. Control surfaces

### 2.1 Room console — the environmental panel

**Layout.** Selected from the habitat plan (`32` §3) or a room list. Header with the room id its
volume and current occupancy, then four blocks:

| Block | Contents |
| :--- | :--- |
| Set points | temperature / humidity / ventilation, each as **measured · set point · about to send** |
| Lighting | current `lighting_lux`, the schedule window with its duration, and the level |
| Systems | `environmental_systems` and `sealed` as state-reflecting toggles, with the resulting air exchange (`ventilation_m3h`, or `0` with the reason) |
| Trend | 30-minute sparklines for temperature, humidity and CO₂ against their limits |

**Measured versus target, made literal.** Temperature is the best display of the Control criterion
in the whole project, because the spec gives a 30-minute approach:

```
temperature   291.4 K  →  295.0 K      commanded 1 min ago, ≈ 24 min remaining
              ▲ measured   ▲ set point
```

Three numbers, never a single one: what the room is, what it is being held to, and whether the gap
is closing. The remaining-time estimate is `(setpoint − measured) / observed_rate`, where the rate
comes from the last 10 minutes of the room's own series — not from an assumed constant.

**Acceptance.** Commanding 295 K from 291 K leaves the command `completed` immediately (the set
point was set) while the panel shows the approach for ~30 further minutes. The two facts are
labelled differently so they are not confused.

### 2.2 Lighting editor

- Two time fields and a level slider, with the duration computed and displayed: "21:30 → 06:00,
  8.5 h at 20 lx".
- **Wrap past midnight is legal and must be shown as such**, not corrected. A start later than the
  end means the window crosses midnight; start equal to end is rejected client-side with "a window
  of zero length".
- The level slider's maximum depends on the room: 1000 lx everywhere, **30000 lx in hydroponics**,
  with the track labelled in lux rather than percent.
- For `quarters-n`, the panel states the consequence: "this is crew-n's sleeping room; the current
  7-day mean sleep quality is 6.2." That single line connects a control to a derived measure and is
  worth more than any amount of help text.

**Acceptance.** Setting `quarters-3` to 21:30 → 06:00 is accepted, displays "8.5 h", and the
`lighting_schedule` state echoes the same window; setting start = end is blocked with the reason.

### 2.3 Airlock console

The airlock is a state machine and should be drawn as one.

```
pressurised ──depressurise (10 min)──▶ cycling ──▶ depressurised
     ▲                                              │
     └──────────── pressurise (10 min) ─────────────┘
```

| `airlock_state` | pressurise button | depressurise button | Reason shown |
| :--- | :--- | :--- | :--- |
| `pressurised` | disabled | enabled | — |
| `cycling` | disabled | disabled | "cycle in progress, 6:20 remaining" |
| `depressurised` | enabled | disabled | — |

Alongside: `inner_door`, `outer_door`, `eva_in_progress`, `pressure_kpa`, and the `seal_room`
toggle with its guard ("cannot unseal while depressurised"). The EVA crew list from the last `eva`
event is shown, because "who is outside" is the question that decides whether the airlock is free.

**Acceptance.** With `eva_in_progress` true, both buttons are disabled with "EVA under way"; forcing
through the API returns `busy`.

### 2.4 Hydroponics console

- Current `water_level_l` against the 400 L reservoir, `nutrient_ec_mscm`, `water_ph`,
  `growth_stage`, `estimated_yield_kg`.
- The irrigation schedule editor, with a **projection**: at the configured volume and the observed
  drain rate, "the reservoir reaches 20 % in 9 days".
- A stage timeline, since `growth_stage` is the clock the crop runs on and `harvest` is the deadline
  that matters.
- The panel is the only place a researcher can act on the `crop_projection` measure (`30` §4.2).

**Acceptance.** Setting 40 L/day with a draw of 55 L/day shows a declining reservoir projection and
an advisory naming the shortfall.

### 2.5 Crew console

- A row per crew member: vitals with their limits, `location`, `movement`, last-heard age, and the
  latest survey scores.
- `crew_wellness_check` is a **request**, not a setting: one button per crew member plus "all five",
  which is five separate commands with one `request_id`.
- While in progress the row shows a live "waiting for crew-3…" state with the expected wait for that
  person's condition (§5, first safeguard).
- On completion the detail is rendered as a fact, not a status: `ok` is neutral, `needs_support` is
  a warning chip with a link to the `crew_health`/`survey_wellbeing` alerts for that person.

**Acceptance.** A check sent to a sleeping crew member stays `in_progress` far longer than one sent
to an awake member and does not time out at the generic 60 s (`06` §4.2 timeout table is
overridden for this control).

---

## 3. Presets

Defined in `15` §2.2: **Morning routine**, **Ventilate and recover**, **Hydroponics top-up**,
**EVA departure**, **EVA return**, **Crew check-in**. Each dispatches one batch with one
`request_id` and appears grouped in the command log.

Two notes specific to MHE:

- **Morning routine** touches nine rooms. It is the argument for the batch endpoint: done by hand it
  is nine forms; as a preset it is one decision that either applies or does not.
- **EVA departure/return** are single commands but are still presets, because the *decision* is
  "we are doing the EVA" and the command is only its last step.

**Acceptance.** "Ventilate and recover" on `common` restores `environmental_systems`, opens the seal
and raises ventilation in one batch; the log shows three completed commands under one preset name.

---

## 4. Schedules

### 4.1 Service-native: the daily windows

`lighting_schedule` and `irrigation_schedule` *are* schedules — the service executes them every
mission day. The UI must present them as such:

| Surface | Behaviour |
| :--- | :--- |
| Lighting | A day-wheel showing the on window for the selected room, with start/end handles and the level |
| Irrigation | The same wheel for hydroponics, with the volume as the spoke width |
| Comparison | A "all rooms" overlay of the nine lighting windows, which is how a researcher sees that two crew members have a 2-hour-shorter night than the rest |

The overlay is not decoration: it is the input to `mhe.sleep_debt`, and it is the only way to spot
that a lighting change made in week 3 correlates with a mood decline in week 4.

**Acceptance.** Changing `quarters-4` to a 06:00–22:00 window shows up immediately in the overlay
and is visible in the 7-day sleep-quality trend for `crew-4`.

### 4.2 Platform: mission plan

A queued list of day-numbered steps, the MHE counterpart of RTA's observation plan (`21` §4.2):

```
{ day: 41, at: "07:00", actions: [{ entity: 'hydroponics', control: 'irrigation_schedule', value: {...} }] }
{ day: 41, at: "13:30", actions: [{ entity: 'airlock', control: 'cycle_airlock', value: 'depressurise' }] }
{ day: 41, at: "16:30", actions: [{ entity: 'airlock', control: 'cycle_airlock', value: 'pressurise' }] }
{ day: 41, at: "20:00", actions: [{ entity: 'crew-1..5', control: 'crew_wellness_check', value: true }] }
```

- Steps fire on **mission day and local time**, evaluated against the sim clock, so a 2000× run
  executes a day's plan in 43 seconds in the right order.
- A step whose guard fails is skipped with its reason and the plan continues (an EVA cannot be
  cycled if the airlock is already cycling, and that must not stall the day).
- The plan is bounded by `mission_state == complete`; after day 90 it stops with "mission complete".

**Acceptance.** A plan whose step 3 fails for `busy` still runs steps 4 and 5, and the plan view
shows step 3 skipped with the reason verbatim.

---

## 5. Safeguards

Server guards are in `06` §4.3.2 (MHE table). These are the additional, *explanatory* safeguards —
the ones that stop a researcher creating a hazard through a legal command.

| Safeguard | Trigger | Message |
| :--- | :--- | :--- |
| **Sealing an occupied room** | `seal_room true` and `crew_count > 0` | "3 crew in `common` (90 m³). With no air exchange CO₂ reaches ~1 500 ppm in about 2 h 50 m." The rate is fitted from `mhe.air_exchange` history, not assumed |
| **Disabling ECS while occupied** | `environmental_systems false` and `crew_count > 0` | The same projection, with the note that ventilation stops too |
| **Ventilation 0 while occupied** | `ventilation 0` and `crew_count > 0` | "Equivalent to sealing this room for CO₂ purposes" |
| **Quarters lighting change** | editing `quarters-n` | "crew-n's 7-day mean sleep quality is 6.2; a longer or brighter window historically precedes a lower score" |
| **Irrigation below draw** | `volume_l` < observed daily drain | "At 40 L/day against a 55 L/day draw, the reservoir reaches 20 % in 9 days" |
| **Airlock during EVA** | `eva_in_progress` | "EVA under way with crew-2, crew-4 outside; the airlock is in use" |
| **Wellness timeout expectation** | sending `crew_wellness_check` | "crew-5 is asleep (21:30–06:00, quarters-5); expect up to 30 minutes" |
| **Mission complete** | `mission_state == complete` | All room controls disabled with "mission complete — day 90" |

Each of these is an advisory, not a block, except where `06` already blocks. The rationale is that
a habitat researcher legitimately *does* seal an occupied room (that is what the control is for);
the platform's job is to state the consequence, not to prevent the experiment.

**Acceptance.** Sealing an occupied room raises the projection with a number computed from the
room's own history; sealing an empty room shows no advisory.

---

## 6. Failure and completion reporting

| Control | Intermediate | Success | Failure reasons to render verbatim |
| :--- | :--- | :--- | :--- |
| `adjust_temperature` / `adjust_humidity` / `ventilation` | — | `completed` (set point stored) | `invalid_value`, `precondition_failed` (mission complete), `fault` |
| `lighting_schedule` | — | `completed` | `invalid_value` (level > room max, zero-length window), `precondition_failed` |
| `environmental_systems` | — | `completed` | `precondition_failed`, `fault` |
| `seal_room` | — | `completed` | `precondition_failed` (airlock not pressurised) |
| `crew_wellness_check` | `in_progress` with expected wait | `completed`, detail `ok` \| `needs_support` | `timeout`, `fault` |
| `cycle_airlock` | `in_progress`, progress `0→1` over 10 min | `completed` | `busy` (EVA), `precondition_failed` (door open / already in that state), `fault` |
| `irrigation_schedule` | — | `completed` | `invalid_value` (volume > 120 L) |

Two rules for rendering:

- **Completion is not effect.** For the three set-point controls the ack completes when the value is
  stored; the approach is a telemetry story shown in the panel (`32` §4). Labelling a completed
  set-point command "done" without the approach is misleading, so the panel pairs them.
- **`needs_support` is not a failure.** The command completed; it returned a fact about a person.
  Rendering it as an error is a data-interpretation bug that would be visible to an examiner.

---

## 7. Test plan

| # | Test | Type |
| :--- | :--- | :--- |
| 1 | Every control's bounds are enforced client-side and server-side with the same reason | unit |
| 2 | A zero-length lighting window is rejected; a wrapping window is accepted and its duration is correct | unit |
| 3 | Hydroponics accepts 30 000 lx while `common` rejects it | unit |
| 4 | `adjust_temperature` completes immediately and the approach shows ~30 min at the observed rate | integration |
| 5 | Crew check to a sleeping member does not hit the generic 60 s timeout | integration |
| 6 | `cycle_airlock` is rejected with `busy` during an EVA and `precondition_failed` with a door open | integration |
| 7 | `seal_room false` on a depressurised airlock is rejected with the spec's reason | integration |
| 8 | All six presets run end to end; "Morning routine" produces 9 completed commands under one `request_id` | end-to-end |
| 9 | A mission plan step failing for `busy` does not stall the remaining steps | unit |
| 10 | Mission `complete` disables every room control with the stated reason | integration |

---

## 8. Open decisions

| # | Decision | Recommendation |
| :--- | :--- | :--- |
| 1 | Is `movement` a legitimate input for "asleep"? | Yes as a *hint* only; the lighting window plus `location == quarters-n` is the stated basis, and the advisory says "asleep" only when all three agree |
| 2 | Should sealing an occupied room be confirmable rather than merely advised? | Yes — a single confirm dialog, because the consequence is a habitability incident and the action is trivially reversible |
| 3 | Does `environmental_systems false` also stop lighting? | No. The spec scopes it to heating, humidity control and ventilation; the panel must say so, or a researcher will expect dark rooms |
| 4 | Should the mission plan persist across restarts? | Yes, stored server-side like every other schedule; a restart must not silently drop day 42 |
| 5 | How long is the wellness timeout for an EVA? | Until `eva_in_progress` ends; the spec says "longer … after the EVA when outside", so a fixed number is wrong |