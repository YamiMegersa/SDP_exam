# 33 — MHE Alerts

**Service.** Mars Habitation Experiment.

**Component.** The seven alerts in `arl-mhe-spec.pdf` §4, the context that makes each one
actionable, and the **cascade** model — because MHE's alert problem is not volume, it is causation:
one failed fan produces six alerts and the researcher has to know which one to act on.

**Owner files.** `server/src/alerts/engine.ts` (§ MHE context), `server/src/services/mhe.ts`
(`alertContext`, `MHE_SUGGESTIONS`), `server/src/alerts/relations.ts` (cascade rules),
`web/src/components/Annunciator.tsx`, `web/src/pages/Mhe.tsx` (alert gutter + plan overlay).

**Rubric.** Alerts 10 % of the service score. 100 % band: *"alerts give the researcher the context
to decide what to do"*.

**Depends on.** `05` (lifecycle, `AlertContext`), `10` (limits), `04` (history), `30` (mission day,
air exchange), `31` (controls), `32` (plan, survey grid).

---

## 1. Boundary

In scope: receiving the seven service alerts verbatim; MHE-specific context; cascade grouping;
alert→control bindings filtered by guards; alerts in replay.

Out of scope: the thresholds. The service decides when body temperature is too high; the platform
never re-derives it. The platform's own value is entirely in the *context* layer and the *cascade*
layer.

---

## 2. The seven alerts (authoritative)

| Alert | `type` | Level | Limit keys (default) | Raise / clear | `metadata` |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Crew health | `crew_health` | warning / critical | `mhe.crew.hr_min` (40 bpm), `hr_max` (150), `temp_max_k` (311.15 K), `resp_max` (30/min), `spo2_min` (92 %) | Any vital outside its limit for **3 min**; **critical** when two or more are. Clears when all are inside for **5 min** | `vital, count, location` |
| Crew status | `crew_status` | warning | none | No vitals from the wearable for **5 min**; clears on the next vitals message | `reason: wearable_offline` |
| Survey missed | `survey_missed` | info | none | A survey not completed by its deadline (**09:00** or **23:30**); clears on the next completed survey | — |
| Survey wellbeing | `survey_wellbeing` | warning | `mhe.survey.min_mood` (4), `max_stress` (7), `max_decline` (2) | Judged **daily at 23:30**: 3-day mean mood below the limit, 3-day mean stress above it, or mood down by more than the decline limit versus a week earlier. Clears when all are back inside | — |
| Room condition | `room_condition` | warning | `mhe.room.temp_min_k` (290), `temp_max_k` (298), `humidity_min` (25 %), `humidity_max` (75 %), `humidity_max_hydroponics` (85 %) | Temperature or humidity outside the limits for **15 min** (hydroponics uses its own upper humidity limit). Clears **0.5 K and 3 %** inside the limits | — |
| Air concentration | `air_concentration` | warning / critical | `mhe.air.o2_min_ppm` (195 000), `co2_warn_ppm` (1500), `co2_crit_ppm` (2500) | O₂ below or CO₂ above the limits for **10 min**; **critical** above the second CO₂ level. Clears inside the limits for **5 min** | `crew_count, sealed` |
| Habitat fault | `habitat_fault` | critical | none | A habitat subsystem is in **fault**; clears when every subsystem is `ok` or `degraded` | `subsystems` (the list in fault) |

**The airlock is not judged for `room_condition` or `air_concentration` while cycling or
depressurised.** Those absences are correct and must not be rendered as "no data".

### 2.1 The severity asymmetry

Six of the seven are `warning` or `info`. Only `habitat_fault` and a two-vital `crew_health` or a
2500 ppm `air_concentration` reach `critical`. This is deliberate: a habitat alert is usually an
*early* signal, and the platform should not scream about a 291 K room. It also means the
annunciator's ranking must be driven by the cascade (§6.2), not by severity alone, or the root
cause will sit below its own symptoms.

---

## 3. Whose decision is it?

| Alert | Who acts | What the researcher can actually do |
| :--- | :--- | :--- |
| `crew_health` | medical, immediately | `crew_wellness_check` on that person; if the vital is `spo2` and their room has an `air_concentration` alert, **fix the room** (§6.3.3) |
| `crew_status` | operations | `crew_wellness_check`; the wearable is a symptom, the person is the subject |
| `survey_missed` | research | Nothing to command — a missed survey is data about compliance. Ask via a wellness check, and record it |
| `survey_wellbeing` | research | A conversation, then a hypothesis: lighting window, workload, EVA timing. The platform must not present an environmental change as a treatment |
| `room_condition` | operations | `adjust_temperature` / `adjust_humidity` / `ventilation`, **unless the actuator itself is faulted** (§6.3.5) |
| `air_concentration` | operations, urgently | `seal_room false`, `ventilation`, `environmental_systems true` — in that order of effect |
| `habitat_fault` | maintenance | Nothing direct; the platform's job is to name the affected rooms and the alerts it will cause |

---

## 4. Current foundation

- Verbatim capture, lifecycle, attribution and the audit columns are shared with every service and
  already implemented (`05` §2, `23` §4).
- The MHE page renders no alert affordance at all; it relies on the global annunciator.
- The plan colours rooms by **hard-coded** CO₂ thresholds (1000 / 1200) that disagree with the API
  defaults (1500 / 2500) — recorded as D-10 and fixed in `32` §3.2.
- The crew strip uses hard-coded clinical thresholds (`hr > 110 || hr < 50`, `temp > 310.15`,
  `spo2 < 94`) with no 3-minute sustain, no two-vital escalation and no relation to the service's
  limits. This is the second half of D-10 and it is dangerous in a demonstration: the page can show
  a crew member as "critical" while the service has raised nothing, and vice versa.

---

## 5. Gaps against the rubric

| Gap | Rubric effect | Fix |
| :--- | :--- | :--- |
| No context beyond value/limit | Caps at 75 % | §6.3 |
| Two hard-coded threshold sets that contradict the service (D-10) | Undermines every alert claim on the page | Read limits from `10`, delete the constants |
| Alerts are a flat list of seven types | The cause is invisible: `habitat_fault` ranks *below* the six symptoms it produced | Cascade model §6.2 |
| No alert → control binding | The obvious action (`crew_wellness_check`, `seal_room false`) must be found manually | §6.3.4, guard-aware |
| `room_condition` on a room whose heater is faulted still suggests a set point | A confident, futile recommendation | Actuator-fault detection §6.3.5 |
| No alert presence on the plan | The floor plan is the service's structure and carries no alert state | Plan overlay §6.6 |
| Airlock exemption is invisible | Looks like missing alerts | Explicit "not judged while depressurised" note in metadata and UI |
| Alerts absent from replay | Replay 100 % band | §6.7 |

---

## 6. Decomposition

### 6.1 Intake

- Unchanged from `23` §6.1: verbatim shape-only validation, limit resolution from the payload first
  and `limit_meta` second.
- MHE-specific: **`metadata.location` on `crew_health` is a room id** and is the join key between a
  person alert and a room alert. If it is missing, fall back to the crew member's current vitals
  `location`, and if that is also missing, do not invent one — §6.3.3 simply has nothing to say.
- **`metadata.crew_count` and `metadata.sealed` on `air_concentration`** are the two facts that make
  the alert interpretable, so the card must never render without them; if absent, show "not
  reported" rather than implying zero occupancy.

### 6.2 The cascade model

#### 6.2.1 Incident grouping

- **Responsibility.** Present one failed subsystem as one incident with a root, instead of N alerts
  with equal weight.
- **Contract.** An `incident` is a set of alerts joined by a causal edge within a 30-minute window:

  ```
  habitat_fault(subsystem ∈ {ventilation, heating})
        └─▶ air_concentration(room)  or  room_condition(room)
                  └─▶ crew_health(crew whose location == room, vital == spo2)
  habitat_fault(hydroponics)
        └─▶ (crop_projection measure degradation, no alert)
  airlock_door_fault → habitat_fault(airlock)
        └─▶ cycle_airlock rejections (not an alert — an event)
  ```

  Edges are declared statically in `server/src/alerts/relations.ts` as
  `{from: {type, metaMatch}, to: {type, entityFrom: 'metadata.location' | 'same-entity'}}` and
  matched against *identity*, never against simulated values.
- **Steps.** On each alert raise, attempt to attach it to an open incident; if none matches within
  30 minutes, start a new one rooted at this alert. An incident's severity is its root's severity
  and its badge count is its members.
- **Acceptance.** Injecting `ventilation_fault` on `common` for two hours yields one incident:
  root `habitat_fault(ventilation)` → `air_concentration(common)` → `crew_health(crew-3, spo2)`.
  The board shows one row, expanded to three, with the root first.

#### 6.2.2 Ordering within an incident

Root first, then breadth-first by causal depth, then by `raised_ts`. The whole point is that the
researcher reads the fan, not the fever.

**Acceptance.** With all three raised, the incident row's headline reads
"Ventilation fault → Common CO₂ 2 100 ppm → crew-3 SpO₂ 90 %", in that order.

### 6.3 Context subsystem (the 100 % band)

#### 6.3.1 The MHE context pack

| `AlertContext` field | MHE source |
| :--- | :--- |
| `measured` | the alert's own value/limit plus its companions: for `crew_health` **all five** vitals with their own limits and which one tripped; for `air_concentration` O₂ *and* CO₂ *and* `crew_count`/`sealed`; for `room_condition` temperature and humidity against both ends of the range |
| `history` | 30 min of the triggering quantity for that entity (per room), or for `crew_health` a 2-hour vitals window so a slow drift is visible |
| `siblings` | the same measure across the other 8 rooms or the other 4 crew — "common at 2 100 ppm while the other rooms sit at 480" |
| `related` | the cascade (§6.2) plus cross-service (§6.3.3) |
| `suggested_controls` | §6.3.4 |
| `narrative` | §6.3.2 |

#### 6.3.2 Narrative templates

| Type | Template |
| :--- | :--- |
| `crew_health` | "crew-3's SpO₂ is 90 % against a 92 % limit and has fallen 3 % in 20 minutes. They are in common, where CO₂ is 2 100 ppm and rising. The other four crew are inside limits." |
| `crew_status` | "No vitals from crew-5 for 7 minutes; their last reading was 68 bpm in quarters-5, asleep. The wearable reports offline." |
| `survey_missed` | "crew-2 did not complete the end-of-day survey by 23:30 on day 41. This is their {n}th miss; the last completed end-of-day mood was 5." |
| `survey_wellbeing` | "crew-4's 3-day mean mood is 3.7 against a 4.0 limit, down 2.3 from a week ago; mean stress is 7.4 against 7. Their sleep quality has averaged 4.9 while their quarters were lit 17 h a day." |
| `room_condition` | "{room} is 301.2 K against a 298 K limit and has been out of range for 24 minutes; humidity is inside range. The set point is 296 K and the heater is reporting {state}." |
| `air_concentration` | "CO₂ in {room} is 2 100 ppm against a 1 500 ppm warning and 2 500 ppm critical limit, with {n} crew present and the room {sealed/ventilated at X m³/h}. The ventilation subsystem is {state}; it has risen 620 ppm in 30 minutes." |
| `habitat_fault` | "{subsystems} in fault. {rooms} are affected: {room} is sealed/under-ventilated and 2 crew are inside. Expect CO₂ to reach the warning limit in about {t}." |

Rules as in `23` §6.3.2: no invented cause, no `undefined`, no double spaces; drop a clause rather
than guess when the data is missing.

#### 6.3.3 Cross-signal relations (the compound incident)

Two relations matter more than the rest and must be first-class:

| Relation | Why it matters |
| :--- | :--- |
| `crew_health(vital = spo2)` near an `air_concentration` alert in **the crew member's own room** | The spec says SpO₂ drops in rooms with high CO₂. A single alert each is nearly meaningless; together they are a life-support incident |
| `room_condition` in a room whose `subsystems.<relevant>` is not `ok` | The room is a symptom; the subsystem is the cause |

Both are computed on identity (room id, crew location) and a ±30 min window, and both are rendered
as an explicit sentence on the card — "CO₂ in common rose 40 minutes before crew-3's SpO₂ fell" —
never only as a link list.

**Acceptance.** With the CO₂ incident above, the `crew_health` card states the time ordering of the
two raises, and the `air_concentration` card names the crew inside.

#### 6.3.4 Suggested controls, per type

| Type | Suggested controls | Rationale |
| :--- | :--- | :--- |
| `crew_health` | `crew_wellness_check true` on that person; `crew_wellness_check true` on the others; **room controls if the vital is `spo2` and their room is alerting** | "Ask the person" is the first action in every medical protocol; the environmental action is second and only if the room supports it |
| `crew_status` | `crew_wellness_check true` | The wearable is the problem; the person may not be. A check-in distinguishes them |
| `survey_missed` | `crew_wellness_check true` (once, not repeatedly) | A miss is a compliance fact; repeated prompts are harassment, so the button is offered once per deadline |
| `survey_wellbeing` | `crew_wellness_check true`; lighting window edit for their quarters (as a **hypothesis**, labelled) | The only levers a researcher legitimately has; the platform must not imply it knows the cause |
| `room_condition` | `adjust_temperature` / `adjust_humidity` **only if the actuator is healthy**; `environmental_systems true`; `ventilation`; `seal_room false` | A set point on a faulted heater is theatre (§6.3.5) |
| `air_concentration` | `seal_room false`; `ventilation 300`; `environmental_systems true`; `adjust_temperature` never (it does not move air) | Ordered by effect: unsealing is instant, ventilation takes minutes, ECS is the fallback repair |
| `habitat_fault` | none direct; links to the affected rooms' `room_condition` alerts and a "watch" chip | The repair is not a platform control; pretending otherwise wastes the researcher's time |

**Acceptance.** For a `room_condition` alert in a room with `subsystems.heating == 'fault'`, the
card offers **no** `adjust_temperature`, and instead says "set points have no effect while heating
is in fault — see habitat fault". The dispatch path would otherwise return a spurious `completed`.

#### 6.3.5 Actuator-fault detection

- **Responsibility.** Never recommend a control whose actuator is known to be broken.
- **Contract.** `actuatorHealthy(room, control)` reads `global/state/subsystems` and the room's
  `environmental_systems`/`sealed` flags:

  | Control | Blocked when |
  | :--- | :--- |
  | `adjust_temperature` | `subsystems.heating != ok`, or `environmental_systems == false` |
  | `adjust_humidity` | `subsystems.heating != ok` (shared humidity control), or ECS off |
  | `ventilation` | `subsystems.ventilation != ok`, or ECS off |
  | `seal_room false` | never blocked (it is itself the repair) |

- **Steps.** Suppression is *displayed*, never silent: the card shows the suppressed control with
  the reason, so the researcher learns why the obvious answer is unavailable.
- **Acceptance.** `heater_fault` on `lab` produces a `room_condition` card that lists
  `adjust_temperature` as suppressed with "heating subsystem in fault", and dispatching it manually
  is prevented client-side while the server still accepts it (the service, not the platform, is
  authoritative).

### 6.4 Alert rendering on the plan

- **Responsibility.** Put the alert where the room is.
- **Contract.** A room with an open alert carries a badge with the worst severity and the count;
  the badge opens the incident. A room under a cascade root is outlined, not filled, so cause and
  symptom are visually distinct — matching §6.2.2's ordering.
- **Steps.** Suspend the badge for the airlock while cycling/depressurised, with a tooltip saying
  why (the spec exemption).
- **Acceptance.** The `common` CO₂ incident shows `common` with a filled red badge and, if the root
  is `habitat_fault`, **every** affected room outlined with a smaller badge.

### 6.5 Cohort and quiet alerts

- `survey_missed` is `info` and repeats twice a day per person. It never enters the flashing board;
  it appears as a counted chip per mission day (§6.5 of `23` applies unchanged, with `crew` as the
  group key).
- `survey_wellbeing` is judged at 23:30, so it is a nightly event; its card must show the 3-day and
  7-day evidence, because a single bad night is not a wellbeing alert.

### 6.6 Clearing and attribution

Identical to `23` §6.6, with one MHE-specific rule: a `crew_health` alert that clears because the
crew member left the room is **cleared, not resolved**, and the resolution prompt defaults to cause
`environmental` only when a room alert was open at the same time. Attribution must reflect what
happened, not what is convenient.

### 6.7 Alerts inside replay

- `alertsAsOf(cursor)` as in `07` §4.5, plus two MHE-specific obligations:
  1. The **survey grid** must reflect the alerts as of the cursor — a day scored as "missed" during
     the replay must not show today's completed survey.
  2. The **incident** must be recomputed at the cursor, so a replay of the ventilation fault shows
     the cascade appearing in the same order it did live.
- **Acceptance.** Replaying the ventilation fault at 200× shows `habitat_fault`, then
  `air_concentration` ~10 minutes later, then `crew_health` ~3 minutes after that, in that order on
  the timeline.

---

## 7. Data contracts

```ts
interface MheAlertContext extends AlertContext {
  context_quality: 'full' | 'partial' | 'generic';
  incident: {
    id: string;
    root: { alert_id: string; type: string; entity: string };
    depth: number;                       // 0 = root
    members: { alert_id: string; type: string; entity: string; depth: number }[];
    headline: string;                    // "Ventilation fault → Common CO₂ 2 100 ppm → crew-3 SpO₂ 90 %"
  } | null;
  actuator: { control: string; healthy: boolean; why: string | null }[];
  judged: boolean;                       // false for the airlock while cycling/depressurised
  vitals?: Record<string, { value: number | null; limit: number | null; tripped: boolean }>;
}
```

`judged: false` exists so the UI can say "not judged while depressurised" instead of showing an
empty card — the exemption is a fact about the service and deserves to be visible.

---

## 8. Failure modes

| Failure | Symptom | Handling |
| :--- | :--- | :--- |
| `metadata.location` missing | Cannot tie a person to a room | Fall back to vitals `location`; if that is absent, render the card without the room clause rather than guessing |
| Cascade over-matches | Two unrelated alerts joined | Edges require the entity relationship (same room, or crew location == room) **and** a 30-minute window; otherwise separate incidents |
| Root alert cleared before the symptoms | An incident with no root | Keep the incident open with the root marked `cleared`; do not re-root it, because the history is the point |
| Limits unavailable | The card cannot judge "against what?" | Show the stored payload `limit`; if absent, `--unknown` and no verdict |
| `air_concentration` without `crew_count` | Occupancy unknown, advice unsafe | Say "occupancy not reported" and prefer `seal_room false` + ventilation, which are safe regardless |
| Wellness check to a sleeping crew member | `in_progress` for 30 minutes looks stuck | Show the expected wait (`31` §2.5) and never auto-fail |
| 2000× run | Nightly alerts fire every ~2 s | The annunciator groups by incident and the board is rate-independent; alerts are never dropped, only coalesced visually |

---

## 9. Test plan

| # | Test | Type |
| :--- | :--- | :--- |
| 1 | All seven types round-trip raise → escalate → clear into one row each | unit |
| 2 | `narrative()` snapshot for all seven, plus the missing-metadata variants | unit |
| 3 | Cascade: `ventilation_fault` → `air_concentration` → `crew_health(spo2)` forms one incident with depth 0/1/2 | unit |
| 4 | Two unrelated `room_condition` alerts in different rooms form two incidents | unit |
| 5 | `adjust_temperature` is suppressed with a reason when `subsystems.heating == 'fault'` | unit |
| 6 | Airlock alerts render `judged: false` while depressurised, with the note | unit |
| 7 | Plan badge severity equals the max severity of the room's open alerts (regression for D-10) | integration |
| 8 | Replaying the ventilation fault reproduces the cascade order | integration |
| 9 | Survey grid under replay shows the cursor day's survey state, not today's | integration |
| 10 | End-to-end: `scenarios/example.toml`'s `common` ventilation fault for 2 h produces one incident with a readable headline | end-to-end |

---

## 10. Open decisions

| # | Decision | Recommendation |
| :--- | :--- | :--- |
| 1 | Should the cascade be automatic or researcher-confirmed? | Automatic for display, with a "split incident" action — automatic linkage is the value, but a wrong join must be correctable |
| 2 | Does `survey_missed` deserve an ack at all? | Yes, but only as a compliance record; it must never flash |
| 3 | How long is an incident open? | Until every member is cleared **or** resolved, not a fixed timeout; a cascade that outlives its root is still one incident |
| 4 | Should the platform ever claim a cause? | Only when the service stated it (`fault_code`, `subsystems`) or when two alerts share an entity relationship. Otherwise the card says "cause not established" |
| 5 | Cross-service edge for `power_w` | `habitat_fault(power_distribution)` ↔ `opg/supply_shortfall`; worth one edge, because it is the clearest demonstration that the platform spans services |