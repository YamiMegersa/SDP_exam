# 14 — Web Shared Visuals and Shared Controls

**Component.** The reusable presentation layer: chart primitives, status chips, the annunciator,
the alert action modal, command widgets, and the scan raster renderer. Every service page is
assembled from these; none of them contains service logic.

**Owner files.** `web/src/components/ui.tsx`, `web/src/components/charts.tsx`,
`web/src/components/Annunciator.tsx`, `web/src/components/AlertAction.tsx`,
`web/src/components/commands.tsx`, `web/src/components/ScanCanvas.tsx`,
`web/src/lib/imaging.ts`.

**Rubric.** Visualisation 30 % per service (the primitives are how the top band is reached);
Alert system 10 %; UI/UX 2.5 %.

**Depends on.** `13`, design system, `16` (the conformance contract these primitives are audited
against).

---

## 1. Boundary

In scope: anything that renders data without knowing which service it came from. Out of scope:
layout and page composition (`12`, `22`, `32`, `42`).

The test: a component in this file may take `series`, `value`, `unit`, `status` — but never
`service === 'rta'`.

---

## 2. Current foundation

`charts.tsx`: sparkline and rolling-line primitives drawn on `<canvas>` from a `Ring`.
`ui.tsx`: panel, LED, status chip, key-value readout, section header, empty state, segmented bar.
`Annunciator.tsx`: permanently visible, unacknowledged alerts flash at 1.5 Hz, inline
acknowledge, cleared alerts remain, resolved alerts leave the board, collapse toggle.
`AlertAction.tsx`: researcher code lookup with a "not in directory" warning that still records,
cause select, note/resolution (3–500 chars). `commands.tsx`: `useCommand()` posting to
`/api/commands`, service reasons shown verbatim, `CommandStatePill`/`CommandStateIcon`,
`CommandLog`. `imaging.ts`: `ScanRaster` with running mean per pixel, `coverage`, `meanAt`,
`pixels`, `render()` with the cyan→amber ramp and sqrt gamma. `ScanCanvas.tsx`: canvas blit.

---

## 3. Gaps

| Gap | Rubric effect | Fix |
| :--- | :--- | :--- |
| Raster renders raw means with sqrt gamma only | Grainy patches (D-5) | Add robust normalisation, sparse-pixel inpainting, and a gain/contrast control |
| No chart with axes, cursors or two series | Caps visualisation at "basic graphical" | Add `TrendChart` with axes, a hover cursor, thresholds, and up to three series |
| No comparison primitives | The 100 % band names comparison | Add `ComparisonPanels`, `DeltaStrip`, `CorrelationScatter` |
| Alert card has no context | Caps Alerts at 75 % | Add the context pack renderer (`05` §4.3) |
| No command progress for long-running controls | Control band wants failure/completion info | Add `CommandProgress` with a determinate bar and a timeout countdown |
| No preset control surface | Control 100 % | Add `PresetMenu` (`15`) |
| Status colours duplicated per page | Inconsistency | One `statusToken()` function |

---

## 4. Decomposition

### 4.1 Chart primitives subsystem

#### 4.1.1 Sparkline

- **Responsibility.** 120×24 px trend with no axes, for card headings.
- **Contract.** `<Sparkline ring={ring} colour={token} threshold?={number} height?={24} />`.
- **Steps.** Draw on a `<canvas>` at device pixel ratio; cache the path per `ring.version`; draw
  the threshold as a 1 px dashed line in the token's warn colour.
- **Acceptance.** Redraws at most 10 times/s and leaves a visible threshold crossing.

#### 4.1.2 TrendChart

- **Responsibility.** The workhorse: one to three series, a real time axis, thresholds, and a
  hover cursor.
- **Contract.**
  ```tsx
  <TrendChart
    series={[{ label, ring, colour, unit, kind: 'line'|'area'|'step' }]}
    thresholds={[{ value, label, severity }]}
    windowMs={3_600_000}
    yDomain={'auto' | 'unit' | [min, max]}
    onCursor={(ts) => void}
    markers={[{ ts, severity, label }]}    // alerts and events
  />
  ```
- **Steps.** 1 px gridlines in `--border`; never a filled background. Tick labels in monospace
  with tabular figures. `null` values break the line rather than plotting zero — draw a gap and a
  thin "no data" hatch. Auto y-domain pads 8 % and snaps to a round step.
- **Acceptance.** A 3-hour temperature chart with a gap shows the gap; hovering shows a vertical
  cursor with the value at that time; an alert marker at a timestamp aligns with the scrubber.

#### 4.1.3 Seaborn/heat tiles

- **Responsibility.** Compact multi-entity views (dish temperatures, room CO₂).
- **Contract.** `<HeatTiles cells={[{ id, value, unit, status, label }]} columns={10} />`.
- **Steps.** Colour by `statusToken`, not by value, so a 301 K cell is not red merely for being
  warm. Show the value on hover.
- **Acceptance.** The 100-dish matrix remains readable at 1280 px and its colours match the
  legends.

#### 4.1.4 Correlation scatter

- **Responsibility.** The correlation view the 100 % visualisation band asks for.
- **Contract.** `<CorrelationScatter points={[{x,y,label?}]} xLabel yLabel r? />` with a fitted
  regression line and the Pearson r printed.
- **Steps.** Compute r in the caller; the component only draws. Degrade to a text `n` and r when
  `n < 3`.
- **Acceptance.** RTA dish temperature vs power draw shows a visible positive trend and a printed
  r; OPG irradiance vs solar output shows the expected nonlinearity, explained in the caption.

### 4.2 Status and readout subsystem

#### 4.2.1 Status tokens

- **Responsibility.** One mapping from meaning to colour and animation.
- **Contract.** `statusToken(status: 'ok'|'warn'|'crit'|'ack'|'inert'|'unknown') →
  { fg, bg, border, glow?, pulse? }`.
- **Steps.** Mirror the design system exactly; the only consumer of raw CSS variables. Add
  `unknown` (slate, dashed border) so a missing measurement is never coloured like a healthy one.
- **The tokens mirror the guide; the bands do not.** `statusToken` decides what `crit` *looks like*.
  What *counts* as crit is a limit from `GET /api/alert-limits/<service>`, resolved through the
  `useLimits` hook — never a number passed by a page. The guide's example figures (CO₂ 1 200 ppm,
  75 °C, SOC 15 %) disagree with every one of the service limits and are illustrations of the colour
  rule, not the rule (`16` §4.6). A caller may pass a `status`; it may not pass a threshold.
- **Names.** The guide spells the alarm LED `.led-alert`; `index.css` spells it `.led-alarm`. Keep
  both until the alias period in `16` §4.1.3 ends, then keep only the guide's.
- **Acceptance.** A grep for `--ok|--warn|--crit` in page files returns only `statusToken` usage.

#### 4.2.2 Readout

- **Responsibility.** The monospace number block used everywhere.
- **Contract.** `<Readout label value unit status? against?={{ value, limitKey, limit }} delta? />`
  where `against` renders the value-vs-limit pair and a direction arrow.
- **Steps.** Tabular figures, 20–24 px for primary values, 12 px unit. `—` for null with a
  tooltip "no measurement". When `against` is present and the value is over the limit, the number
  takes the crit token and the delta shows `+2.2 K over`.
- **Acceptance.** Every service page headline metric uses `Readout`; no page formats a number
  inline.

#### 4.2.3 Segmented gauge

- **Responsibility.** SOC, coverage, reservoir level.
- **Contract.** `<SegmentedGauge value min max bands={[{to, token, label}]} label unit />`.
- **Steps.** 20 segments; bands evaluated in order. Below the lowest band, pulse at 1.2 s.
- **Bands come from limits, not from the guide.** The design system's SOC bands (50 / 25 / 15) leave
  15–25 % undefined and contradict `battery.warn_pct`; build the gauge so the caller supplies the
  breaks, and let `42` §4.1 supply `battery.warn_pct` and `reserve_pct`.
- **Acceptance.** SOC 12 % pulses crit and shows the band label "below reserve".

### 4.3 Scan imaging subsystem

#### 4.3.1 Raster

- **Responsibility.** Turn samples into an image honestly.
- **Contract.**
  ```ts
  class ScanRaster {
    constructor(gridSize: number)
    add(x: number, y: number, signal: number): void
    coverage(): number                     // filled / total
    meanAt(x, y): number | null
    percentile(p: number): number | null
    render(opts: { gain: number; gamma: number; black: number; white: number }): ImageData
    reset(): void
  }
  ```
- **Steps.**
  1. Store a running mean and a count per pixel (already implemented).
  2. Track a global histogram of accepted sample values so `percentile()` is O(1)-ish.
  3. `render` normalises using the 2nd and 99.5th percentile (robust against hot pixels), applies
     `gain`, then `gamma`, then maps through the design system's ramp.
  4. Pixels with count 0 are `#000000` and are *not* interpolated in the main view; an optional
     "fill holes" mode does a 3×3 mean over neighbours with a visible `interpolated` badge.
- **Acceptance.** Rendering a scan with five faulty dishes produces a recognisable image whose
  structure matches the reference for the target; coverage and the rejected count are displayed.

#### 4.3.2 ScanCanvas

- **Responsibility.** Draw the raster at the right size with an overlay.
- **Contract.** `<ScanCanvas raster={} geometry={} gain gamma showGrid? showHoles? overlay? />`.
- **Steps.** `imageSmoothingEnabled = false` so pixels stay square; draw a faint 8×8 graticule;
  draw the target centre as a 1 px cross; draw the HUD (target label, band, integration, grid
  size, coverage, rejected samples) in a corner with a translucent backing.
- **Acceptance.** The canvas scales to its container without blurring, and the graticule aligns
  with pixel boundaries at every power-of-two scale.

#### 4.3.3 Cleaning pipeline

- **Responsibility.** The spec is explicit: *"do not assume your first image is correct"*.
- **Contract.** `cleanSample(sample, ctx) → { keep: boolean; reason?: 'null'|'fault'|'low_snr'|'outlier'|'stale' }`.
- **Steps.** Reject: null offsets/signal; dish `fault_code != 'none'`; `snr_db < scan.min_snr_db`
  when provided; samples more than `k × MAD` from the dish's own median for this scan
  (`k = 5`); samples whose `scan_id` differs from the current one.
- **Acceptance.** The rejected counts are exposed per reason, the image improves measurably
  (contrast ratio increases) versus the raw path, and the unit tests cover each reason.

### 4.4 Alert presentation subsystem

#### 4.4.1 Annunciator board

- **Responsibility.** Always visible, always honest.
- **Contract.** Renders a list of `AlertRecord`; emits `onAck(id)`, `onResolve(id)`,
  `onOpenContext(id)`, `onReplay(id)`.
- **Steps.** Flash unacknowledged non-info alerts at 1.5 Hz via a CSS animation (never a JS
  timer). Show severity, service, entity, a one-line message, the value against the limit, and
  the age. When `ack_verified === 0`, show a small "unverified code" mark. Keep cleared alerts
  with an "auto-cleared" tag until acknowledged.
- **Acceptance.** With a mix of states the board renders each distinctly, and `prefers-reduced-motion`
  replaces flashing with a static crit border plus a bold `UNACKNOWLEDGED` chip.

#### 4.4.2 Alert action modal

- **Responsibility.** Two states, both attributed.
- **Contract.** Acknowledge: `{ researcher, note? }`. Resolve: `{ researcher, cause, resolution }`
  with `resolution` 3–500 characters and `cause` from the vocabulary.
- **Steps.** Validate before sending; show the API's error verbatim; after success, keep the modal
  open for 600 ms showing the recorded attribution so the operator sees what was written to the
  audit trail.
- **Acceptance.** Resolving with an unknown code shows the 403 reason and leaves the alert open.

#### 4.4.3 Context renderer

- **Responsibility.** The 100 % alerts band.
- **Contract.** `<AlertContextPanel ctx={AlertContext} onCommand={...} />` with five sections:
  measured vs limit, history sparkline, sibling comparison, related alerts across services, and
  suggested controls as buttons with rationales.
- **Steps.** Fetch on expand, cache per alert id for 60 s. Each suggested control button opens the
  normal command confirmation, pre-filled, so guards still apply.
- **Acceptance.** Every service alert type renders all five sections, with "no peer data" shown
  rather than an empty area.

### 4.5 Command presentation subsystem

#### 4.5.1 Command form

- **Responsibility.** Generate a control from the topology, not from hand-written JSX.
- **Contract.** `<ControlForm def={ControlDef} entity={string} state={...} onSend={(value) => ...} />`
  switching on `def.value.type`: bool → switch; enum → segmented buttons; float/integer →
  numeric input with min/max, step, and a slider when the range is bounded; timestamp → datetime
  input; object → field group from `def.value.fields`.
- **Steps.** Show the *current* value and the *target* value side by side for state-backed
  controls (`commanded`, `setpoints`, `generation_priority`). Disable with a hint when
  `availability()` says so. Confirm any command whose effect is not instantly reversible (stow,
  disable, load shed, generator start).
- **Acceptance.** All 14 RTA, 9 MHE and 6 OPG controls render correctly from topology alone,
  including the object-valued `lighting_schedule`, `irrigation_schedule` and `set_target`.

#### 4.5.2 Command state and progress

- **Responsibility.** Report completion and failure, which the rubric names explicitly.
- **Contract.** `<CommandStatePill state reason detail progress timeoutAt />` and
  `<CommandProgress command />`.
- **Steps.** Determinate bar from `progress` while `in_progress`; a countdown ring from
  `timeoutAt − now` (the client's *wall* clock, because timeouts are wall clock); reason rendered
  in monospace verbatim.
- **Acceptance.** `request_recalibration` shows a 120 s countdown and then either `completed` or
  the service's `failed` detail.

#### 4.5.3 Command log

- **Responsibility.** Auditable history per service.
- **Contract.** `<CommandLog service />` reading `live.commands` plus `/api/commands`.
- **Steps.** Columns: time, control, entity, value, researcher, state, reason. Filter by state.
  Link a rejected row to the guard that produced it, if any.
- **Acceptance.** The log survives a page change and shows commands from before the page opened
  (via the REST backfill).

---

## 5. Failure modes

| Failure | Behaviour |
| :--- | :--- |
| Ring has one point | Sparkline draws a dot; `TrendChart` says "not enough data yet" |
| All values null in the window | Chart shows the "no data" hatch; no y-domain crash |
| Raster with zero samples | Canvas black with "awaiting first sample" and the scan id |
| Very large images (grid 1024) | Render to an offscreen canvas and blit scaled; warn above 512 |
| Alert action while API down | Acknowledge is allowed, resolve is blocked with the 503 reason |
| Command sent twice | Idempotency (`06` §4.2.2) means the UI shows one row |

---

## 6. Test plan

- Unit: `ScanRaster` — pixel mapping matches the spec formula for 5 offsets; means accumulate;
  percentiles are correct on a synthetic ramp.
- Unit: `cleanSample` — one test per rejection reason.
- Unit: `statusToken` completeness.
- Component: `TrendChart` with a `null` gap, a threshold and a marker.
- Component: `ControlForm` for every control type in all three `$topology` fixtures.
- Visual check: the mosaic for `tgt-cen` at L band looks like the reference shape (`52`).

---

## 7. Open decisions

- **Canvas or SVG for charts?** Canvas for the mosaic and sparklines (density), SVG for
  `TrendChart` (hit testing and accessibility). Both are used deliberately, not accidentally.
- **Do we ship a charting library?** No. A dependency here would be a build risk and would
  constrain the threshold/marker model this console needs.