# 21 — RTA Controls

**Service.** Radio Telescope Array.

**Component.** Every control surface in `arl-rta-spec.pdf` §4, the presets and schedules a
researcher actually uses, the guards that stop unsafe commands, and the readouts that show current
versus target state.

**Owner files.** `web/src/pages/Rta.tsx` (controls pane), `server/src/services/rta.ts` (guards,
adapter), `web/src/lib/presets.ts` (RTA section), `web/src/lib/guards.ts`.

**Rubric.** Control 30 % of the service score. 100 % band: *"controls are designed around how a
researcher works, e.g. presets, schedules, safeguards against unsafe commands"*.

**Depends on.** `06` (dispatch, guards), `15` (presets, confirmation), `14` (`ControlForm`).

---

## 1. The control inventory (authoritative)

Ten controls. Four are sub-array level, six are dish level. Every one must be reachable from the
console.

| Control | Level | Value | Service rules that matter to the UI |
| :--- | :--- | :--- | :--- |
| `start_scan` | Sub-array | boolean, must be `true` | Needs a target ≥ 15° above the horizon, ≥ 3 dishes in service, no wind stow. Completes once started; the ack **detail is the scan id**. Also resumes a paused scan |
| `schedule_scan` | Sub-array | timestamp ms (`0` clears) | Must be in the future; not while scanning. At that time it behaves as `start_scan`; a scan that cannot start then ends `failed` |
| `pause_scan` | Sub-array | boolean, must be `true` | Dishes keep reporting with unchanged `scan_progress` |
| `cancel_scan` | Sub-array | boolean, must be `true` | Works on running, paused **or scheduled** |
| `set_target` | Sub-array | catalogue id (string) or `{ra_rad 0–2π, dec_rad −π/2–π/2, fov_rad 0.0005–0.05}` | Unknown ids rejected. **Not while scanning** |
| `set_observation_frequency` | Sub-array | float Hz, `0.5e9`–`50e9` | **Not while scanning** |
| `assign_subarray` | Dish | string sub-array name | New name creates the sub-array (max 4 total, else `limit_reached`). A non-`main` sub-array that empties is removed. Not while the dish is scanning |
| `adjust_azimuth` | Dish | float rad, `0–2π` | Slews at 2°/s, `in_progress` until arrival. Not while scanning or stowed. Fails on a stalled drive; times out at 1.5× the expected slew |
| `adjust_elevation` | Dish | float rad, `0.0873–1.5708` (5°–90°) | Slews at 1°/s; otherwise as azimuth |
| `enable_dish` | Dish | boolean | Disabling a scanning dish removes it from the scan |
| `stow_dish` | Dish | boolean | `true` points straight up and holds; `false` releases — **rejected during wind stow**. A dish stowed by command leaves any scan |
| `request_recalibration` | Dish | boolean, must be `true` | 120 s `in_progress`, resets system-temperature drift. Not while scanning. May end `failed` with `calibration_failed` |

That is 13 rows; the spec groups `enable`/`stow`/`recalibrate` and the two `adjust_*` under the
dish, giving 6 dish-level and 6 sub-array-level controls plus `assign_subarray` = 13 distinct
controls.

---

## 2. Control surfaces (how each is presented)

### 2.1 Sub-array panel — the scan console

**Layout.** A header strip with the sub-array selector (`main`, plus any temporary ones), then
four grouped blocks:

| Block | Contents |
| :--- | :--- |
| Target | current target label (resolved through the catalogue, `catalogue.ts`), RA/DEC, FOV, elevation now, and above/below the 15° horizon gate |
| Observation | current `observation_frequency` in GHz with the band it falls in (L 1–2, C 4–8, K 18–26, else "off-band") |
| Scan | `scan_state` pill, current `scan_id`, progress bar, elapsed vs `expected_duration_s`, and the four transport buttons |
| Schedule | current `next_scan` as absolute + relative time, with a clear (0) action |

**Transport buttons** map to the four controls, with state-dependent enablement:

| `scan_state` | start | pause | cancel | set_target | set_freq |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `idle` | enabled (if guards pass) | disabled | disabled | enabled | enabled |
| `scheduled` | enabled | disabled | enabled | enabled | enabled |
| `running` | disabled | enabled | enabled | **disabled** | **disabled** |
| `paused` | enabled (resumes) | disabled | enabled | disabled | disabled |
| `complete` / `cancelled` | enabled | disabled | disabled | enabled | enabled |

The disabled reason is shown, not just greyed: "not while scanning" comes from the spec's own
wording.

**Target selection.** A searchable list from `GET /api/targets` showing id, name, category, RA/DEC
and FOV, plus an "custom position" tab with three numeric fields (RA in degrees **and** radians,
DEC, FOV) that convert on input. Selecting a target does not send `set_target`; an explicit
"Set target" button does, so the researcher can review. The FOV shown is the catalogue FOV, and
the panel notes that the scan's grid and overlap come from the scan itself (README D8).

**Frequency input.** A slider over the useful range with snap points at the L/C/K band centres,
plus a numeric field in GHz, validated `0.5–50`. Shows which reference band the choice maps to,
because a researcher choosing 5 GHz wants the C-band image.

**Acceptance.** Every state combination above behaves as tabulated; forcing a disabled action
through the API returns the service's own `precondition_failed`.

### 2.2 Dish panel — the maintenance console

Selected by clicking a dish in the matrix (`22` §4.1) or by deep link `#/rta/dish-042`.

| Block | Contents |
| :--- | :--- |
| Identity | dish id, sub-array, row/col, enabled, stowed, lat/lon |
| Aim | reported azimuth/elevation, **commanded** azimuth/elevation, and the angular error; a note when slewing |
| Thermal | `temperature_k` against warn/crit limits, `system_temperature_k`, minutes since `last_calibration` against the 168 h limit |
| Power | `power_w` against `dish_power.max_w` |
| Fault | `fault_code`, plus the scenario fault in force if known |
| Controls | `adjust_azimuth` (slider 0–360° with a numeric rad field), `adjust_elevation` (slider 5–90°), `enable_dish`, `stow_dish`, `assign_subarray` (text with the existing names as suggestions), `request_recalibration` |

**Current versus target state.** For both `adjust_*` controls the panel shows three numbers: the
current reported value, the commanded value, and the value the researcher is about to command. On
send, the commanded value changes immediately (state is retained) while the reported value moves
over the slew, which is exactly the behaviour the Control rubric asks to be visible. A slew
progress indicator shows `|current − commanded| / slew_rate` as remaining seconds.

**Acceptance.** Commanding azimuth 180° from 90° shows commanded 180° at once, the reported value
climbing at 2°/s, and the command `completed` when the dish arrives.

### 2.3 Bulk operations

Operating 100 dishes one at a time is not how a researcher works, so three bulk surfaces exist.
All of them dispatch a normal batch (`06` §4.4.1):

| Surface | Selection | Commands |
| :--- | :--- | :--- |
| Select by predicate | "all dishes with `fault_code != none`", "all above the warn temperature", "all with `last_calibration` older than 150 h", "all stowed", "all in sub-array `auto-2`" | `enable_dish`, `stow_dish`, `request_recalibration`, `assign_subarray` |
| Select by rectangle | drag a rectangle over the dish matrix | `assign_subarray` (e.g. carve out `auto-2`) |
| Select by list | multi-select with shift-click | any dish control |

Bulk sends show a pre-flight summary: "12 dishes · `request_recalibration true` · 3 will fail
(scanning)". The failing ones are excluded if the researcher chooses, and the batch endpoint's
all-or-nothing behaviour is bypassed by splitting into valid groups — stated explicitly in the
confirmation.

**Acceptance.** Selecting 20 dishes by rectangle and assigning them to a new sub-array creates it
and the dish matrix regroups within one frame.

---

## 3. Presets

Defined in `15` §2.1; the RTA set is: **Survey Centaurus A (L band)**, **Night deep field
(C band)**, **Wind-safe standby**, **Recover from stow**, **Maintenance sweep**.

Each is dispatched as a batch with one `request_id` and appears in the command log grouped under
the preset name.

**Acceptance.** Each preset runs end to end against the simulator; "Night deep field" produces one
completed scan whose `scan_id` appears in the `start_scan` ack detail.

---

## 4. Schedules

### 4.1 Native: `schedule_scan`

- The panel exposes a datetime input plus quick offsets (in 15 min, 30 min, 1 h, 2 h).
- It shows the service's own `next_scan`, so the researcher sees the *scheduled autonomous* scan
  (every 45–90 min) as well as their own.
- Clearing sends `0`.
- A scheduled scan cannot be moved while scanning; the UI disables the input and says why.

**Acceptance.** Scheduling 2 minutes ahead results in `scan_state = scheduled`, then `running`
with `origin: "schedule"` **only if the plan was platform-driven** — a `schedule_scan` command
produces `origin: "command"`. The UI labels the origin on the scan card, because a researcher
needs to know whether a scan was theirs or the array's.

### 4.2 Platform: observation plan

Defined in `15` §3.3. A queue of `{target, bandHz, dwellS}` steps driven by `scan_state`
transitions:

```
idle ──set_target──▶ (state target changed) ──set_frequency──▶ (state changed)
     ──start_scan──▶ running ──(scan completes)──▶ next step
```

- Horizontal gate before `start_scan`: compute the target's elevation from the catalogue RA/DEC
  and the current simulated time; if below 15°, the plan pauses with "target below horizon,
  waiting" and retries every 10 minutes of simulator time.
- A scan that fails (`target_set`, `too_few_dishes`, `wind`, `no_target`, `unknown_target`) pauses
  the plan and surfaces the reason.
- The plan is visible as a list with the current step highlighted and a stop button.

**Acceptance.** A two-step plan runs both scans and then stops at `idle`.

---

## 5. Safeguards

Server guards are listed in `06` §4.3.2 (RTA table). The client mirrors them for instant
feedback. Beyond validation, the panel adds three *informational* safeguards that a researcher
would otherwise learn the hard way:

| Safeguard | Trigger | Message |
| :--- | :--- | :--- |
| Wind stow imminent | `global/state/wind_stow` true, or an RTA/LWM wind alert within 10 min | "Wind stow engaged — scans are paused and stows are latched. Check before starting a scan." |
| Below horizon | Computed target elevation < 15° | "Target is 8.2° above the horizon; a scan needs 15°. Earliest usable: 04:12." |
| Too few dishes | `active_dishes < 3` | "Only 2 dishes in service; a scan needs 3." |
| Sub-array limit | 4 sub-arrays exist and a new name is typed | "4 of 4 sub-arrays in use; assigning a new name will be rejected." |
| Calibration debt | > 5 dishes beyond 150 h | Warning chip in the maintenance block: "5 dishes near the 168 h calibration limit." |

---

## 6. Failure and completion reporting

The rubric asks for failure/completion information. For RTA that means:

| Control | Intermediate | Success | Failure reasons to render verbatim |
| :--- | :--- | :--- | :--- |
| `start_scan` | — | `completed`, detail = scan id | `precondition_failed`, `no_target`, `unknown_target`, `too_few_dishes`, `wind`, `busy`, `fault` |
| `schedule_scan` | — | `accepted` | `precondition_failed` (past time), `busy` |
| `pause_scan` / `cancel_scan` | — | `completed` | `precondition_failed` |
| `set_target` | — | `completed` | `unknown_target`, `invalid_value`, `precondition_failed` (while scanning) |
| `set_observation_frequency` | — | `completed` | `invalid_value`, `precondition_failed` |
| `adjust_azimuth` / `adjust_elevation` | `in_progress` with `progress` | `completed` on arrival | `precondition_failed` (scanning/stowed), `fault` (drive stall), `timeout` |
| `enable_dish` | — | `completed` | `precondition_failed` |
| `stow_dish` | — | `completed` | `precondition_failed` (wind stow) |
| `request_recalibration` | `in_progress`, 120 s | `completed` | `precondition_failed` (scanning), `failed` with `calibration_failed` |
| `assign_subarray` | — | `completed` | `limit_reached`, `precondition_failed` (scanning), `invalid_value` (bad name) |

Platform-side: every command shows a countdown derived from the per-control timeout (`06` §4.2.3),
so an undelivered `request_recalibration` is visibly timing out rather than silently pending.

**Acceptance.** A drive-stall scenario produces `failed` with `fault` on an `adjust_azimuth`, and
the panel shows the fault code and the guidance "clear the stall with a repair, then rescale".

---

## 7. Failure modes

| Failure | Behaviour |
| :--- | :--- |
| `scan_state` missing from state (retained cleared) | Treated as `idle` with a warning chip; all scan actions require a fresh `start_scan` |
| Command accepted but no state change within 10 s | Panel shows "accepted, awaiting state change" and keeps the countdown |
| Two researchers command the same dish | Last write wins at the service; the log shows both, and the loser's ack explains the rejection |
| Sub-array disappears while selected | Selection falls back to `main`; the log records the disappearance |
| Control sent during replay | Blocked by `12` §4.4.2 |

---

## 8. Test plan

- Component: the state × control enablement matrix (§2.1) — 5 states × 5 controls = 25 assertions.
- Component: `ControlForm` for the object-valued `set_target` and the bounded numeric controls.
- Unit: client guards against the shared vector file; parity with the server (`15` §4.1).
- Integration against the simulator: set target → start scan → assert scan id in the ack →
  pause → resume → cancel.
- Integration: `stow_dish false` during an injected wind stow → `precondition_failed`.
- Integration: `adjust_elevation 1.7` → guard rejects with the 5°–90° range before dispatch.
- Integration: `assign_subarray` to a fifth name → `limit_reached`.

---

## 9. Open decisions

- **One dish panel or a table?** A panel for the selected dish plus a table for bulk selection. A
  100-row table of controls is not operable.
- **Show the autonomous schedule's next scan?** Yes, read-only. Hiding it would make the array
  look idle when it is about to scan on its own.