# 15 — Operator Flows: Presets, Schedules, Safeguards

**Component.** The researcher's working pattern, as opposed to the researcher's buttons. This is
the component that turns "all controls are implemented" into *"controls are designed around how a
researcher works"* — the 100 % band of the Control criterion for every service.

**Owner files (new).** `web/src/lib/presets.ts`, `web/src/lib/schedules.ts`,
`web/src/lib/guards.ts`, `web/src/components/PresetMenu.tsx`,
`web/src/components/SchedulePanel.tsx`, `web/src/components/GuardNotice.tsx`.

**Rubric.** Control 30 % per service, 100 % band: *"presets, schedules, safeguards against unsafe
commands"*. Also Data 100 % (a preset is how a researcher asks a repeatable question) and UI/UX
100 % (*"design shows clear decisions about the researcher's tasks"*).

**Depends on.** `06` (guards, batch), `13` (store), `14` (controls), `16` (appearance).

---

## 1. Boundary

In scope: named multi-command intents, time-based intent, and the client-side duplicate of the
server's guards for instant feedback. Out of scope: authorisation (server), dispatch (server),
and the service's own acceptance (the service).

Guards exist in **two places on purpose**: the client copy prevents an obviously futile click and
explains why; the server copy is authoritative. A test asserts they agree (`51` §4.3).

---

## 2. Presets

A preset is a named set of commands a researcher would issue together, with a rationale. Presets
are dispatched through `POST /api/commands/batch` (`06` §4.4.1) so they either apply fully or not
at all.

### 2.1 RTA presets

| Preset | Commands | When a researcher uses it | Rationale shown in the UI |
| :--- | :--- | :--- | :--- |
| **Survey Centaurus A (L band)** | `main`: `set_target 'tgt-cen'` → `set_observation_frequency 1.42e9` → `start_scan true` | A calibration-grade image of a bright, well-known source at the default band | "The brightest calibrator in the catalogue; use it to confirm the array is healthy before a long observation." |
| **Night deep field (C band)** | `set_target 'tgt-lmc'` → `set_observation_frequency 5.0e9` → `start_scan true` | Comparing structure against the L-band reference | "LMC's C-band morphology differs sharply from L; running both bands on the same night makes the comparison fair." |
| **Wind-safe standby** | every dish: `stow_dish true`; `main`: `cancel_scan true` | A gust front has been forecast or `wind_stow` is imminent | "Stowing before the 15 m/s trigger avoids an interrupted scan and removes solar load from the drives." |
| **Recover from stow** | every dish: `stow_dish false`; `main`: `start_scan true` | The gust has released | "Releases the stow and resumes the paused scan; fails if the target has set." |
| **Maintenance sweep** | `dish-0xx`: `request_recalibration true` for the 10 dishes with the oldest `last_calibration` | Weekly maintenance | "Calibrates the dishes closest to the 168 h limit before they raise `dish_calibration`." |

### 2.2 MHE presets

| Preset | Commands | Rationale |
| :--- | :--- | :--- |
| **Morning routine** | `common`,`lab`: `lighting_schedule {start:'06:30', end:'21:00', level_lux:400}`; `quarters-1..5`: `{start:'21:30', end:'06:00', level_lux:20}` | "Matches the crew's published routine so sleep quality is not confounded by light." |
| **Ventilate and recover** | the affected room: `seal_room false` → `environmental_systems true` → `ventilation 300` | "Reverses the CO₂ build-up caused by a seal or a ventilation fault." |
| **Hydroponics top-up** | `hydroponics`: `irrigation_schedule {start:'07:00', end:'07:30', volume_l:120}` | "Refills the reservoir in one daily window; 120 L is the documented maximum." |
| **EVA departure** | `airlock`: `cycle_airlock 'depressurise'` | "Depressurises for an EVA; rejected while a door is open or an EVA is already under way." |
| **EVA return** | `airlock`: `cycle_airlock 'pressurise'` | "Repressurises after the crew returns." |
| **Crew check-in** | `crew-1..5`: `crew_wellness_check true` | "Asks every crew member to check in after a `crew_health` or `survey_missed` alert." |

### 2.3 OPG presets

| Preset | Commands | Rationale |
| :--- | :--- | :--- |
| **Conserve for the night** | `global`: `load_shed true`; `batteries`: `battery_reserve 40` | "Sheds non-critical load early so the reserve is not reached at 03:00." |
| **Bring the diesels up** | `diesel`: `start_generator true`; `global`: `generation_priority 'diesel_first'` | "Covers the load immediately and stops deep discharge, which is what damages the bank." |
| **Return to solar** | `global`: `generation_priority 'solar_first'`; `diesel`: `stop_generator true` | "Hands the load back to solar and cools the generators down for 60 s." |
| **Cycle the battery** | `global`: `generation_priority 'battery_first'`; `batteries`: `battery_reserve 20` | "Deliberately exercises the bank, which the health model needs; only safe with daylight ahead." |
| **Storm posture** | `global`: `load_shed true`; `batteries`: `battery_reserve 50` | "A dust storm cuts solar for hours; hoarding charge and shedding load is the only lever before diesel." |

### 2.4 Preset behaviour

- **Display.** A menu in the workspace header, grouped by service, each entry showing the command
  count and the rationale on hover.
- **Pre-flight.** Before dispatch, every command is run through the client guards. Any failing
  command is listed with its reason and the whole preset is blocked, with an option to "send the
  valid subset" — which sends a batch of only the valid ones and says so in the log.
- **Confirmation.** Presets that stop or disable something require an explicit confirm with the
  researcher code visible.
- **Recording.** The batch shares one `request_id`, and the command log groups the results under
  the preset name so the audit trail reads "Night deep field — 3 commands, 3 completed".

**Acceptance.** Each preset is exercised once in `52`; a preset containing one invalid command is
blocked and names the failing command and reason.

---

## 3. Schedules

A schedule is a researcher intent bound to time. Three kinds, because the services offer three
different notions of time:

### 3.1 Service-native schedules (preferred)

| Service | Native mechanism | UI |
| :--- | :--- | :--- |
| RTA | `schedule_scan <timestamp>` sets `next_scan` | A datetime picker plus "in 30 min / 1 h / 2 h" quick buttons; shows the service's current `next_scan` and `scan_state = scheduled` |
| MHE | `lighting_schedule` and `irrigation_schedule` carry `{start, end}` wall-clock windows | Two time inputs plus a level/volume; renders the current window on a 24 h dial |
| OPG | none — the plant is continuously controlled | Not offered as native |

Native schedules are the only kind that survive a platform restart, because the service owns
them. The UI must say so.

### 3.2 Platform schedules (client-orchestrated, opt-in)

For RTA scan chains and OPG posture changes at a time the service cannot express:

- **Contract.** `web/src/lib/schedules.ts` keeps `{ id, service, at, batch, label, createdBy,
  platform: true }` in `localStorage`. A single `setInterval` (10 s) fires due entries by
  dispatching their batch through the normal endpoint, so authorisation, guards and audit all
  still apply.
- **Rules.** A platform schedule fires only while the console tab is open; the panel states
  this in red. It is never described as a service schedule. Firing results are logged as normal
  commands with `schedule_id` in the log grouping.
- **Acceptance.** A 2-minute-out platform schedule fires, produces a command row, and, if the tab
  was closed at the time, is shown as `missed` when the tab reopens.

### 3.3 Recurring observation plan (RTA only)

- **Intent.** "Scan these three targets in sequence, one after another, tonight."
- **Contract.** A queue of `{ target, bandHz, dwellS }` steps converted to commands:
  `set_target` → `set_observation_frequency` → `start_scan`, waiting for `scan_state` to return to
  `idle` or `complete` before the next step.
- **Steps.** The runner is a small state machine on the client that reacts to `scan_state` state
  changes; it never polls.
- **Acceptance.** A three-target plan runs to completion and the log shows three scans with their
  ids.

---

## 4. Safeguards

### 4.1 Client guard mirror

- **Responsibility.** Instant, explanatory refusal before a round trip.
- **Contract.** `checkClient(def, value, ctx)` returns the same `{ ok } | { ok:false, reason, hint }`
  as the server's guard table (`06` §4.3.2). Implemented as pure functions over the store.
- **Steps.** A guard failure renders inline on the control (red hint under the input) and disables
  the send button, rather than failing after the click.
- **Acceptance.** A shared test vector file (`server/test/guards/*.json`) is executed by both the
  server suite and the client suite, so a divergence fails a test.

### 4.2 Dangerous-command confirmation

- **Responsibility.** Make irreversible or disruptive actions deliberate.
- **Contract.** A confirmation is required for: `stow_dish`, `enable_dish false`,
  `cancel_scan`, `seal_room true`, `cycle_airlock depressurise`, `stop_generator`, `load_shed true`,
  `enable_solar_array false`, and any `battery_reserve` change above 50.
- **Steps.** The dialog states the command, the entity, the current value, the new value, the
  predicted immediate effect (from the guard's model, e.g. "44 dishes leave the scan"), and the
  researcher code. Confirm is a two-step press-and-hold for `stow_dish` and `stop_generator`.
- **Appearance.** The design system has exactly one modal idiom — the Researcher Action Modal of
  its §6 — and a second, differently-shaped dialog for commands would double the vocabulary an
  operator has to learn at 3 a.m. Reuse that component (`16` §4.4.2): same size, same field order,
  same "the API's rejection reason, verbatim" footer. A confirmation is a cheap way to be forgiven a
  mistake; it is not a different kind of conversation.
- **Acceptance.** No dangerous control can be fired with a single click, and the confirmation
  text names the actual effect.

### 4.3 Rate and conflict guards

- **Responsibility.** Protect the services and the researcher.
- **Contract.** Any control on one entity is blocked for 1.5 s after dispatch (per-entity
  mutex), and the UI shows "in flight" on that entity. A second command to the same entity while
  another is `in_progress` requires confirmation.
- **Steps.** Track per `(service, entity)` in the store. Never queue commands silently.
- **Acceptance.** Rapid double-clicking `adjust_azimuth` produces one command and a visible
  "in flight" state.

### 4.4 Sensible-default advisory

- **Responsibility.** Say when a value is legal but unwise.
- **Contract.** Advisory (amber, non-blocking) when: `battery_reserve > soc`,
  `observation frequency` outside 1–2 GHz for a catalogue target with a known L-band reference,
  `ventilation 0` in an occupied room, `load_shed true` while `total_generation_w > total_load_w`,
  `seal_room true` while `crew_count > 0` and CO₂ rising.
- **Acceptance.** Each advisory is listed in the UI with the reason and never prevents dispatch.

---

## 5. Cross-service working pattern

The reason the platform is bespoke (handout §3.1 question 6) is that one physical event touches
three services. The console must support that, so this component owns one cross-service flow:

### 5.1 Storm response flow

- **Trigger.** An LWM or RTA wind alert, or an OPG solar-underperformance alert.
- **Contract.** A single "Storm response" panel that shows, in one place: current gust and
  `wind_stow`, solar output against expected, SOC and margin, diesel status, and open alerts in
  the last 10 minutes.
- **Actions offered.** the RTA "Wind-safe standby" preset, the OPG "Storm posture" preset, and a
  link to replay the previous storm.
- **Steps.** Composes existing components; no new server work beyond `11`'s
  `platform.event_impact`.
- **Acceptance.** During a scripted storm (`52` §4) the panel appears with live values for all
  three services, and both presets are one click from it.

---

## 6. Failure modes

| Failure | Behaviour |
| :--- | :--- |
| Preset contains a command the service no longer declares | Blocked pre-flight with `unknown_control` and the offending control named |
| Platform schedule fires while replay is active | Suppressed, marked `deferred_until_live`, and fired on return to live |
| Two presets dispatched together | Second is blocked by the per-entity mutex |
| Client guard and server guard disagree | The server wins and its reason is shown; the shared vector test fails loudly in CI |
| Storage disabled | Presets still work (they are static); platform schedules are disabled with an explanation |

---

## 7. Test plan

- Unit: every preset expands to a batch whose commands all validate against the three `$topology`
  fixtures.
- Unit: guard vector parity between `web/src/lib/guards.ts` and `server/src/services/*.ts`.
- Unit: schedule runner fires only due entries and only with a researcher code present.
- Component: confirmation dialogs for each dangerous control.
- Integration: dispatch a preset against the live simulator and assert three command rows and
  three acks.

---

## 8. Open decisions

- **Server-side preset storage?** No. Presets are intent, not state; keeping them in the client
  means a reviewer can read them in one file and they cannot drift from the guards.
- **Cron-style schedules?** No. A single-shot platform schedule plus the service-native windows
  covers every real case; a cron implementation would be untested complexity.