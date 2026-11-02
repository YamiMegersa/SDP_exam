# 16 — Web Design Conformance

**Component.** The binding between `Front-end components/DESIGN_SYSTEM.md` and the code: the token
layer, the four-zone frame, the per-service instruments, the annunciator's presentation, replay's
chromatic cues, and the one rule that stops a style guide's illustrative figures becoming
hard-coded thresholds.

**Owner files.** `web/tailwind.config.js`, `web/src/index.css`. Everything under
`web/src/components` and `web/src/pages` is an *audited subject* of this document rather than an
owner: it does not define the look, it is checked against it.

**Rubric.** UI/UX 2.5 % — *"consistent layout and navigation across services"*, *"information
prioritised for an operator, with alerts always visible"*. But also every service's Visualisation
30 %, because this is where "what a dish tile looks like" is actually decided, and the exam asks
for a *visualisation*, not a table of numbers with colour on it.

**Depends on.** `12` (shell), `14` (shared visuals), `15` (operator flows), `22` / `32` / `42`
(service visualisation), `05` (alert semantics), `07` (replay).

---

## 1. Boundary

In scope: whether the presentation layer says what the design system says it says, and the rule for
resolving the places where the design system and the service specifications disagree.

Out of scope: inventing visual idioms. **The design system is closed.** If a widget does not appear
in it, we do not build it, and if we think we need one we write down why in §8 first. Also out of
scope: the data behind the widgets (`20`/`30`/`40`), and the semantics of operating a control
(`21`/`31`/`41`).

---

## 2. Current foundation

More of the design system is already implemented than is usually assumed, and the parts that are
implemented are implemented exactly — which is why the deviations below are worth naming
precisely rather than being fixed by a general restyle.

| Clause | Where | Verdict |
| :--- | :--- | :--- |
| All 13 colour tokens (§2 A/B/C) | `tailwind.config.js` `theme.extend.colors`, `index.css` `:root` | Exact — every hex matches |
| `.arl-panel`, `.telemetry-readout` (§8) | `index.css:94–105` | Exact, typography rule included (`tnum`, `zero`) |
| Cyan→amber scan ramp (§5.1) | `imaging.ts:39–43` | Exact, all five stops, plus the white top |
| 10 × 10 dish grid (§5.1) | `Rta.tsx:249` `grid-cols-10` | Exact topology, tile size unconstrained |
| 1.5 Hz annunciator flash (§6) | `index.css:138–140`, `0.66s steps(1,end)` | Exact — 1/0.66 = 1.515 Hz |
| 4-bar micro-meters, caution at ≥ 9 (§5.2) | `charts.tsx:187–192` `MicroMeter({ caution = 9 })` | Exact |
| Sankey node roles (§5.3) | `Opg.tsx` `EnergyFlow`, solar/diesel/battery/load | Exact, with moving-dash direction cues |
| Reduced-motion escape (§8, by implication) | `index.css:222–228` | Exceeds the guide — keep |

Two additions the guide does not ask for and that should stay: `prefers-reduced-motion` disables the
blinking (§8 has no accessibility clause at all, and a console that cannot be made to stop flashing
is a hazard), and the moving-dash flow lines, which carry magnitude through animation *duration*
rather than through a second number.

---

## 3. Gaps

| Gap | Effect | Fix |
| :--- | :--- | :--- |
| `.led-alert` was implemented as `.led-alarm` | Anyone reading the guide and grepping the class finds nothing; the guide's name is silently unmet | Rename to `.led-alert` with `.led-alarm` kept as an alias for one commit (§4.1.3) |
| No replay chromatic shift and no badge (§7) | The single most dangerous confusion available — reading history as live — has no defence anywhere in the code: `grep HISTORICAL web/src` returns nothing | §4.5: violet top bar, the badge, and the mode pill in the same frame |
| Speed pills are `1x 2x 5x 10x 32x` | The guide specifies `[<< Rewind][1x][2x][5x][10x][LIVE]`; 32x is invented, `Rewind` and `LIVE` are missing from the set | §4.5.3: the guide's exact set, no more |
| Dish tiles have no fixed size | "24 × 24 px or square aspect ratio" is unhonoured; the grid floats with content | §4.3.1: `24px` fixed cells at ≥ 1280 px, `28px` never |
| Stowed dishes are amber but do not pulse | The stow state — the one the operator must notice during a storm — reads as a static warning | §4.3.1: `led-caution`-style pulse on stow only |
| Airlock state is lowercase text and a legend swatch | The guide asks for a `PRESSURIZED` / `DEPRESSURIZED` pill | §4.3.3 |
| Alerts table columns are severity / service / source / message / raised / status / by | The guide's audit table is `Alert ID / Service / Cause / Raised At / Ack By (Timestamp) / Resolved By (Timestamp) / Notes` — the two attribution columns, which the Security criterion grades, are absent | §4.4.3 |
| Scan HUD shows band and mosaic size, not the target | "Target ID, Frequency Band, Integration Time" as an overlay | §4.3.2 |
| Three hard-coded thresholds (D-10) | The UI colours a real CO₂ of 1 600 ppm as nominal, and a real dish at 340 K as fine | §4.6, the central section of this document |

---

## 4. Decomposition

### 4.1 Token layer

#### 4.1.1 Colour tokens

- **Responsibility.** One source for every colour, so that a colour can be trusted to mean something.
- **Contract.** Two representations of the same 13 values, and no third:
  ```css
  /* index.css :root — for CSS and inline styles */
  --void --panel --panel-edge --elev --hover
  --nominal --caution --alarm --in-hand --inert
  --rta --mhe --opg --replay
  ```
  and `theme.extend.colors` in `tailwind.config.js` for utility classes.
- **Steps.** The current `:root` predates the design system's vocabulary and is missing `--elev`,
  `--hover`, `--bg`/`--void` naming drift, and `--crit-glow`. Add them as aliases so that no
  component file changes. `--ack` is `--in-hand` and `--ok` is `--nominal`; the design system uses
  both names for the same colours, so both exist.
- **Acceptance.** A grep for `#` under `web/src/components` and `web/src/pages` returns only comments
  and named-token definitions. `index.css` and `tailwind.config.js` are the only two files that may
  contain a hex literal.

#### 4.1.2 Typographic hierarchy

- **Responsibility.** Make size and weight carry rank, so an operator's eye lands on the primary
  readout before the label.
- **Contract.** The guide's five roles, mapped to the project's scale:

  | Role | Guide | Implementation |
  | :--- | :--- | :--- |
  | Section header | 18 px, semibold, `tracking-tight`, `#f1f5f9` | `text-lg font-semibold tracking-tight text-ink-100` |
  | Widget label | 11 px, medium, uppercase, `tracking-wider`, `#94a3b8` | `text-2xs uppercase tracking-wider text-ink-300` |
  | Primary readout | 20–24 px, bold mono, `#ffffff` | `telemetry-readout text-2xl font-bold text-white` |
  | Secondary / unit | 12 px, mono, `#64748b` | `telemetry-readout text-xs text-ink-400` |
  | Status badge | 10 px, bold, uppercase, `tracking-wide` | `text-2xs font-bold uppercase tracking-wide` |

- **Steps.** The only deviation is the widget label: the guide says 11 px, `text-2xs` is 10 px,
  `text-xs` is 12 px. Add `fontSize.xs2: ['0.6875rem', …]` (11 px) and use it for widget titles,
  keeping `text-2xs` for badges. A 1 px difference between a label and a badge is the difference
  between a hierarchy and a texture.
- **Acceptance.** No page uses a bare `text-sm`/`text-base` for telemetry. Every number an operator
  might quote out loud is `telemetry-readout` and therefore tabular.

#### 4.1.3 Utility classes

- **Responsibility.** The guide's §8 block exists verbatim in the codebase, under the guide's names.
- **Contract.** `.arl-panel`, `.led-nominal`, `.led-alert`, `.telemetry-readout` — exactly those
  four selectors, exactly those four bodies.
- **Steps.** `index.css` already has `.arl-panel` and `.telemetry-readout` verbatim and `.led-nominal`
  verbatim. Rename `.led-alarm` → `.led-alert`, keep
  `.led-alarm { @apply led-alert; }` for one commit, then delete. `.led-caution` and `.led-inert` are
  additions with no guide equivalent; they exist because status has four states, not two, and
  removing them would produce amber LEDs implemented three different ways.
  **`.arl-panel` is used once.** Every service page builds its own panel chrome instead. That is the
  larger fix: `Panel` in `ui.tsx` should emit `.arl-panel` and stop re-declaring the same three
  utilities at each call site.
- **Acceptance.** `grep -c "arl-panel" web/src` is at least one per page; `grep "led-alert"` finds the
  guide's name.

### 4.2 Zone conformance

- **Responsibility.** The four zones of the guide's §4, permanently, on every page — which is what
  "consistent layout and navigation across services" means when it is graded.
- **Contract.** Zone 1 header and replay tray; Zone 2 annunciator; Zone 3 navigation and operator;
  Zone 4 workspace split into a telemetry-left pane and a controls-right pane. The zone boundaries
  are `12` §4.1.1's grid; this document only asserts that the *content* of each zone matches the
  guide's description of it.
- **Steps.** Zone 1 must contain: the live/replay state, the transport, and the scrub bar with the
  window's start time — in that left-to-right order, as drawn. Zone 3 must contain the three service
  tabs *and* the operator identity; the guide puts the code in the nav bar, not in the header, and
  the current shell has it in the header. Move it, because Zone 3 is "service navigation **and
  researcher context**" and a researcher code floating in a header of ingest counters reads as a
  debug field.
- **Acceptance.** At 1280 × 720 all four zones are present; the operator code is in Zone 3; Zone 4 is
  the only scrolling region.

### 4.3 Service instruments

#### 4.3.1 RTA dish matrix

- **Responsibility.** 100 dishes readable at a glance, six states distinguishable without a legend.
- **Contract.** 10 × 10 grid; 24 × 24 px cells; hover tooltip carrying dish id, sub-array, current
  temperature and pointing offset; click selects into the controls pane; and the guide's four
  treatments — green in service (`N ≥ 80`), amber pulsing stowed, red overheated or faulty, grey
  disabled.
- **Steps.** Fix the cell box (`w-6 h-6` at ≥ 1280 px) so the matrix is a square of squares rather
  than a grid of text sizes. Derive `hot` from `dish_temperature.crit_k` (§4.6), not `348.15`.
  Pulse stow only — four pulsing states in a 100-tile grid is a Christmas tree, and the guide names
  exactly one state as pulsing.
- **Acceptance.** At 1280 px the matrix occupies a 240 px square plus gutters; hovering any tile
  shows four facts; a stowed dish pulses; a dish at 344 K is red and one at 330 K is green.

#### 4.3.2 Scan canvas

- **Responsibility.** The scan is the RTA's visualisation, not a decoration on it.
- **Contract.** Pure black canvas; Δx/Δy relative offset grid from target centre; the five-stop ramp
  (already exact); and a monospace HUD overlay carrying target id, band in GHz, and integration time.
- **Steps.** Add the HUD as an absolutely-positioned `.telemetry-readout` overlay inside the canvas
  frame — not as `Datum` rows beside it, which is the current arrangement and puts the facts where
  the eye is not. Show `—` for the target when the array is stowed or no target is commanded, and
  say `STOWED` in the HUD rather than showing a black rectangle with no explanation.
- **Acceptance.** A screenshot of the canvas alone identifies target, band, integration time, and
  whether the array is scanning.

#### 4.3.3 MHE compartments

- **Responsibility.** Nine rooms, each answering "is this room safe right now?" without navigation.
- **Contract.** The nine hermetic compartments, named as the guide names them — `quarters-1` … ,
  `common`, `lab`, `hydroponics`, `airlock`; per room O₂ and CO₂ in ppm with the hazard thresholds,
  ambient temperature and an occupancy badge; and the airlock pill `PRESSURIZED` (emerald) /
  `DEPRESSURIZED` (amber outline).
- **Steps.** Replace the legend swatch and lowercase text with the guide's pill, uppercase, emerald
  fill or amber outline. Add the occupancy badge — the headcount is a derived measure (`11`
  `mhe.headcount`) and belongs on the room, not only in the summary strip.
- **Acceptance.** The nine ids match the topology exactly; the airlock reads `PRESSURIZED` or
  `DEPRESSURIZED` in caps; no room shows a hazard colour derived from a literal (§4.6).

#### 4.3.4 Crew strip

- **Responsibility.** Five people, each with a heartbeat and a mental state.
- **Contract.** Five cards: avatar, crew id, heart rate with an animated pulse line, body
  temperature, and four micro-meters for mood, stress, fatigue and sleep quality on a 1–10 scale
  where ≥ 9 flashes caution.
- **Steps.** `MicroMeter` already flashes at 9. The pulse line must be driven by the *sampled* rate,
  not a CSS animation with a fixed period — a 48 bpm crew member and a 140 bpm one must look
  different, because that is the whole point of drawing it. Fix D-9 first: one crew member's survey
  currently appears on all five cards, which makes the four meters decorative.
- **Acceptance.** Raising one crew member's heart rate changes only that card's pulse period; a
  survey value of 9 or 10 flashes on that card alone.

#### 4.3.5 OPG energy flow

- **Responsibility.** Where the power is coming from and going, in one picture.
- **Contract.** Solar PV → Inverter/Bus ↔ Battery ← Diesel, with the bus feeding the lab load; animated
  edges whose direction shows flow sign and whose speed shows magnitude.
- **Steps.** Already implemented. Two additions: label the edges with their kW so the diagram is
  readable without hovering, and grey the diesel node when it is dormant rather than drawing a zero
  — the guide's `inert` token exists for exactly this.
- **Acceptance.** At a glance, an operator can say whether the batteries are charging, discharging, or
  idle.

#### 4.3.6 SOC gauge

- **Responsibility.** Answer "how long have I got?" in one widget.
- **Contract.** Segmented bar; `> 50 %` emerald, `25–50 %` amber, `< 15 %` blinking crimson with
  projected time-to-depletion.
- **Steps.** The bands are figures, not colour rules — see §4.6. Implement the *segments* (the guide
  asks for segmented, and ten segments read as a quantity while a smooth bar reads as a percentage),
  keep the three-colour progression, but place its breaks at `battery.warn_pct` and
  `reserve_pct`. Show `t_remaining` at every band, not only the lowest: an operator deciding whether
  to shed load needs it above 50 % too.
- **Acceptance.** Changing the reserve in the simulator moves the crimson boundary in the same
  refresh.

#### 4.3.7 Margin HUD

- **Responsibility.** The derived number the whole service exists to answer.
- **Contract.** ΔP = P_generation − P_load, as a large readout, green for surplus with the word
  *charging*, red for deficit with *discharging*, signed.
- **Steps.** Implemented at `Opg.tsx:231`. Keep the sign and the unit. Do not colour by magnitude —
  −0.5 kW and −50 kW are both deficits.
- **Acceptance.** Sign, colour and word never disagree.

### 4.4 Annunciator presentation

#### 4.4.1 Flash discipline

- **Responsibility.** Unacknowledged alarms command attention at 1.5 Hz and stop commanding it once
  acknowledged.
- **Contract.** Unacknowledged flash; acknowledged are static indigo; resolved leave the banner for
  the table. Acknowledge is never implied by hover, focus, or visiting a page.
- **Steps.** Already at 1.515 Hz; keep the period and the `steps(1,end)` timing, which is what makes it
  read as a lamp rather than a fade.
- **Acceptance.** With three alerts, two flash and one is indigo; acking the third makes it indigo
  without a repaint of the other two.

#### 4.4.2 Researcher Action Modal

- **Responsibility.** Capture who acted, and why, at the moment of acting.
- **Contract.** Two states. *Acknowledge*: researcher code, verified against the ARL API. *Resolve*:
  researcher code **plus** resolution notes, not submitable without them.
- **Steps.** The code check must call the same path the control plane uses (`06` §4.1.2 —
  `POST /v1/researchers/verify` with the service), so that an ack and a command cannot disagree about
  who is allowed to act. The modal shows the ARL API's rejection reason verbatim
  (`unknown` / `defunct` / `not_permitted`); "invalid code" hides which of the three it was, and the
  three need different operator responses.
- **Acceptance.** Resolving with an empty note is impossible; a defunct code produces a different
  message from a permitted-but-wrong-service code.

#### 4.4.3 Audit table

- **Responsibility.** The permanent record an examiner can read to check that attribution is real.
- **Contract.** The guide's seven columns, in its order:
  `Alert ID | Service | Cause | Raised At | Ack By (Timestamp) | Resolved By (Timestamp) | Notes`.
- **Steps.** The current table (severity / service / source / message / raised / status / by) is a
  *live* alert list, not an audit trail. Keep it as the live list and add the audit table behind the
  resolved filter, because merging the two loses the columns that matter. `Ack By` prints the code
  **and** the timestamp in one cell — that is what the guide's parenthesis means, and it is exactly
  the evidence the Security criterion looks for.
- **Acceptance.** A resolved alert yields one row with both codes, both timestamps, and non-empty
  notes.

### 4.5 Replay cues

#### 4.5.1 Chromatic shift

- **Responsibility.** Make history unmistakable before it is read.
- **Contract.** On entering replay the top bar moves to `#2e1065` on `#581c87`; on returning to live it
  returns to `#0a0d14`.
- **Steps.** Implement as a `data-mode="replay"` attribute on the shell root plus token overrides, not
  as conditional classes threaded through three components — the washes and the badge must be
  impossible to forget in a new page.
- **Acceptance.** `grep HISTORICAL web/src` is non-empty; the top bar's computed background differs
  between modes.

#### 4.5.2 Badge and scrubber

- **Responsibility.** Say which mode and which rate, and put the alerts on the timeline.
- **Contract.** Badge text `HISTORICAL REPLAY — [PAUSED | 2x | 5x]`; a scrubber spanning the viewport
  with tick marks at every alert raise and resolve, coloured by severity; the `LIVE` button snapping
  the socket back.
- **Steps.** The ticks depend on D-8: replay must surface the alert stream in the replay context, or
  the ticks are drawn from a list that does not exist. Sequence `07` before this.
- **Acceptance.** Scrubbing across the storm shows ticks arriving at the storm's timestamps and each
  tick names its alert on hover.

#### 4.5.3 Speed pills

- **Responsibility.** Offer the same transport the guide offers.
- **Contract.** Exactly `[ << Rewind ] [ 1x ] [ 2x ] [ 5x ] [ 10x ] [ LIVE ]`.
- **Steps.** Drop `32x`. The transport clamps to 0.1–64 (`clampSpeed()`), so 32 is legal, but the
  guide is the contract for what is *offered*, and a fifth pill invites the operator to wonder why
  there are not six. `LIVE` is not a speed: it is the exit, and it must be visually distinct from the
  four rate pills.
- **Acceptance.** Five pills plus the exit; no `32x` string in the codebase.

### 4.6 The threshold rule

- **Responsibility.** Stop the style guide's example figures from becoming the console's thresholds.
  This is the most consequential section of this document, because getting it wrong is invisible:
  the console still looks right, and quietly mis-colours the two states that matter.
- **Contract.** *Colour semantics and banding come from `DESIGN_SYSTEM.md`. Numeric limits come from
  `GET /v1/alert-limits/<service>`, exposed to the browser as `GET /api/alert-limits/<service>`.*
  When the two disagree, the API wins and the guide's figure is treated as an illustration.
- **Why this is not a judgement call.** The guide is a *style* document. It writes "CO₂ > 1200 ppm
  triggers amber/red" as an example of a colour rule, in the same sentence pattern as "battery
  SOC < 25 %". The service specifications are *contracts*: they name the limits, the keys, the
  dwell times and the clearing margins, and the simulator raises its alerts from them. A console
  that colours at 1 200 ppm shows an amber room while the backend — correctly — has raised nothing,
  and an examiner comparing the two finds the UI wrong.

  The guide's own SOC bands do not even tile: `> 50 %` emerald, `25–50 %` amber, `< 15 %` crimson
  leaves **15–25 % with no colour at all**. That gap is only possible in figures written as
  illustrations and never read back for consistency, which is the clearest available evidence that
  they were never meant to be the thresholds.

  | Guide's illustration | Service limit | Limit key |
  | :--- | :--- | :--- |
  | CO₂ > 1 200 ppm amber/red | warn 1 500 ppm, crit 2 500 ppm | `air.co2_warn_ppm`, `air.co2_crit_ppm` |
  | Dish overheat > 75 °C (348.15 K) | warn 333 K, crit 343 K | `dish_temperature.warn_k`, `dish_temperature.crit_k` |
  | SOC < 15 % crimson; 25–50 % amber | warn below 30 %, crit below the reserve | `battery.warn_pct` + reserve |
  | — (guide silent) | O₂ min 195 000 ppm | `air.o2_min_ppm` |
  | — (guide silent) | fuel min 25 % | `fuel.min_pct` |
  | — (guide silent) | crew HR max 150 bpm, crew temp max 311.15 K | `crew.hr_max`, `crew.temp_max_k` |

- **Steps.** The path already exists end to end and is unused: `client.ts` caches
  `GET /v1/alert-limits/{service}` for 300 s, `app.ts:181` re-exposes it, `measures.ts` resolves by
  unprefixed key (`air.co2_warn_ppm`, `battery.warn_pct`, `availability.min_active`) and already
  returns limit-driven verdicts. Only the browser does not ask. So: fix the web client's declared
  shape (D-3 — it declares `Record<string, {type, severity, warn, crit}>` where the wire is
  `AlertLimit[] = {key, value, unit}`), add a `useLimits(service)` hook cached for 300 s to mirror
  the server, and replace the three live literals:
  - `Mhe.tsx:21–22` `CO2_WARN = 1000` / `CO2_CRIT = 1200`
  - `Rta.tsx:37` `HOT_K = 348.15` — the comment says "the design system's overheat threshold", which
    is the defect stating its own provenance
  - `Opg.tsx:256` `value < 15 ? 'crit' : value < 25 ? 'warn'` and the `fuel < 20` beside it
- **Fallback rule.** If the limits call fails, do **not** fall back to a guide figure. Render the
  value in `inert` with the band suppressed and a tooltip saying the limits are unavailable. A
  console that guesses a threshold is worse than one that admits it cannot colour the number.
- **Acceptance.** With the API returning warn 1 500 / crit 2 500, a room at 1 600 ppm is amber and a
  room at 1 200 ppm is nominal. Restarting the API with different limits changes the colours without
  a code change. `grep -rn "1200\|348.15\|< 15\b" web/src/pages` is empty.

### 4.7 Enforcement

- **Responsibility.** Keep conformance after this document is written, by making deviations fail
  something other than a review.
- **Contract.** Three cheap checks, all runnable from the README:
  1. `grep -rn "#[0-9a-fA-F]\{3,6\}" web/src/components web/src/pages` → no output.
  2. `grep -rn "< 15\|< 20\|1200\|348\.15\|1000" web/src/pages` → no threshold literals.
  3. A review checklist item: *does this new widget appear in `DESIGN_SYSTEM.md`? if not, `16` §8
     first.*
- **Steps.** Add checks 1 and 2 to the `51` test plan as text assertions (they need no rendering and
  no browser). They are the two failure modes that no component test would ever catch.
- **Acceptance.** Deliberately adding `#ff0000` to a page fails a test.

---

## 5. Clause register

Every clause of the guide, and where it stands. `OK` = implemented and matching. `FIX` = deviation
with a section above. `GAP` = absent. `N/A` = no current surface.

| Guide | Clause | Implementation | Status |
| :--- | :--- | :--- | :--- |
| §1 | Four aesthetic pillars | All four are layout/token consequences | OK |
| §2 A | 5 surface tokens | `tailwind.config.js` `base.*` | OK |
| §2 B | 5 status tokens + crit glow | `ok/warn/crit/inhand/inert`, `shadow.alarm` | OK |
| §2 C | 4 accent hues | `rta/mhe/opg/replay` | OK |
| §3 | Mono + tabular for telemetry | `.telemetry-readout`, `tnum`/`zero` | OK |
| §3 | 11 px widget label | `text-2xs` is 10 px | FIX §4.1.2 |
| §3 | 20–24 px primary readout | `text-2xl` on the margin, SOC and scan readouts | OK |
| §4 | Zone 1 header + tray | `Shell.tsx`; tray is `12` §4.4.1 | FIX §4.2 |
| §4 | Zone 2 annunciator | `Annunciator.tsx`, always mounted | OK |
| §4 | Zone 3 nav + operator | Operator code currently in Zone 1 | FIX §4.2 |
| §4 | Zone 4 split | `12` §5 two-pane contract | OK |
| §5.1 | 10 × 10 grid | `Rta.tsx:249` | OK |
| §5.1 | 24 × 24 px tiles | unconstrained | FIX §4.3.1 |
| §5.1 | Hover tooltip: id, sub-array, temp, offset | partial | FIX §4.3.1 |
| §5.1 | Green ≥ 80 in service | palette by state | OK |
| §5.1 | Amber **pulsing** stowed | amber, static | FIX §4.3.1 |
| §5.1 | Red overheated or faulty | `HOT_K` literal | FIX §4.6 |
| §5.1 | Grey disabled | `inert` palette | OK |
| §5.1 | Black canvas, Δx/Δy | `ScanCanvas.tsx` | OK |
| §5.1 | Five-stop ramp | `imaging.ts:39–43` | OK |
| §5.1 | HUD: target, band, integration | band only | FIX §4.3.2 |
| §5.2 | 9 named compartments | `ROOMS`, ids from topology | OK |
| §5.2 | O₂ / CO₂ ppm + hazard | `CO2_WARN`/`CO2_CRIT` literals | FIX §4.6 |
| §5.2 | Temp + occupancy badge | temp yes, badge absent | FIX §4.3.3 |
| §5.2 | Airlock pill | lowercase text + legend | FIX §4.3.3 |
| §5.2 | 5 crew cards, pulse line, temp | `CrewStrip`, fixed-period pulse | FIX §4.3.4 |
| §5.2 | 4-bar meters, ≥ 9 flashes | `MicroMeter({ caution: 9 })` | OK |
| §5.3 | Sankey node roles | `EnergyFlow` | OK |
| §5.3 | SOC segmented, 3 bands | smooth bar, literal breaks | FIX §4.3.6 |
| §5.3 | ΔP HUD, signed and coloured | `Opg.tsx:231` | OK |
| §6 | 1.5 Hz flash | `0.66s steps(1,end)` | OK |
| §6 | Researcher Action Modal, 2 states | `AlertAction.tsx` | OK |
| §6 | Resolve requires notes | enforced | OK |
| §6 | 7-column audit table | 7 different columns | FIX §4.4.3 |
| §7 | Violet chromatic shift | absent | GAP §4.5.1 |
| §7 | `HISTORICAL REPLAY — […]` badge | absent | GAP §4.5.2 |
| §7 | Scrubber + alert ticks | scrubber yes, ticks blocked by D-8 | FIX §4.5.2 |
| §7 | 5 speed pills + LIVE | 5 pills but `32x`, no `LIVE` | FIX §4.5.3 |
| §8 | `.arl-panel` | verbatim, used once | FIX §4.1.3 |
| §8 | `.led-nominal` | verbatim | OK |
| §8 | `.led-alert` | renamed `.led-alarm` | FIX §4.1.3 |
| §8 | `.telemetry-readout` | verbatim + `font-variant-numeric` | OK |

---

## 6. Failure modes

| Failure | Behaviour |
| :--- | :--- |
| Limits endpoint unreachable | Values render in `inert`, bands suppressed, tooltip explains; never a guide figure (§4.6) |
| A limit key is absent from the response | That one band is suppressed; the others still colour |
| A new service ships entities the guide never described | Fall back to the generic panel from `14`; do not invent a bespoke widget |
| Replay entered while the modal is open | Modal closes, and the notice says why — an action taken against history is the failure this whole section exists to prevent |
| New page added without zones | Fails `12` §4.1.1's presence test, not this document |

---

## 7. Test plan

- Text assertion: no hex literal and no threshold literal under `components`/`pages` (§4.7).
- Text assertion: `.led-nominal` and `.led-alert` exist in `index.css` under the guide's names.
- Component: `useLimits` — cached 300 s, one request per service, suppressed band on failure.
- Component: RTA tile colour at 330 K / 344 K, stowed pulse on, disabled grey.
- Component: airlock pill text is uppercase `PRESSURIZED`/`DEPRESSURIZED`.
- Component: audit row prints both codes with both timestamps.
- Component: replay badge text and top-bar background differ per mode.
- Manual: the guide's §4 diagram against the running console, at three widths.

---

## 8. Open decisions

- **Does the guide's 24 px tile survive at 1024 px?** A 10 × 10 grid of 24 px tiles is 240 px plus
  gutters, which fits. Keep 24 px at every width and let the surrounding panel breathe; do not scale
  the tiles, because a 20 px tile stops being clickable.
- **Do we keep `.led-caution` and `.led-inert`?** Yes. The guide names two LED states and the
  platform has four; the alternative is three ad-hoc amber implementations, which is how the
  current code got here.
- **Is `32x` gone for good?** Yes, from the UI. The transport still accepts it, because the API is not
  the style guide's business.
- **Should the guide's §5.1 "≥ 80 dishes" become a limit lookup rather than a UI constant?** It is
  `availability.min_active`, so yes, by the same rule as §4.6 — but it is one number in one place and
  carries no colour, so it is the lowest priority of the three.