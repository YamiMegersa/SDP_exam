# 22 — RTA Visualisation

**Service.** Radio Telescope Array.

**Component.** The three views the operator lives in: the 10×10 dish matrix, the scan image canvas
with its HUD, and the array-wide trend strip — plus the drill-down, comparison and correlation
views the top visualisation band requires.

**Owner files.** `web/src/pages/Rta.tsx`, `web/src/components/ScanCanvas.tsx`,
`web/src/lib/imaging.ts`, `web/src/components/charts.tsx` (consumed).

**Rubric.** Visualisation 30 % of the service score. Bands:
25 % tabular; 50 % basic graphical; 75 % *"graphical representation informed by service
structure"*; 100 % *"visualisation supports exploration and insight beyond a table, e.g. drill
down, comparison, correlation, derived views"*.

The 75 % band is the dish matrix laid out as the actual array and an image built from the actual
sample geometry — both are "informed by service structure", not generic charts. The 100 % band is
§5 below.

**Conformance.** What is *encoded* is decided here; how it is *drawn* is decided by
`DESIGN_SYSTEM.md` §5.1 and audited by `16`. That division matters for exactly three things in this
document: the grid is 10 × 10 with 24 px tiles, the scan ramp is the guide's five-stop cyan→amber
(already implemented verbatim in `imaging.ts`), and **stowed is the one state that animates** — the
guide says "amber pulsing" for stow and merely "red border" for overheat, so the animation budget is
spent on the state that means *the array is doing nothing*, and critical carries a static glow
instead. Every temperature and threshold named below is read from `GET /api/alert-limits/rta`
(`dish_temperature.warn_k` / `crit_k`), never written as a literal — `16` §4.6.

---

## 1. Workspace layout

```
┌────────────────────────────────────────────────────────────────────────────┐
│ RTA header: active dishes / scan state / wind stow / mean temp / derived strip │
├───────────────────────────────────────────┬────────────────────────────────┤
│  LEFT 60 %                                │  RIGHT 40 %                    │
│  ┌─────────────────────────────────────┐  │  Sub-array scan console (21)   │
│  │ Scan image canvas + HUD             │  │  ─ target / frequency / scan   │
│  │ (or "no scan in progress")          │  │  ─ transport / schedule        │
│  └─────────────────────────────────────┘  │  Presets                       │
│  ┌─────────────────────────────────────┐  │  Dish panel (selected dish)    │
│  │ 10×10 dish matrix (grouped by        │  │  ─ aim / thermal / power       │
│  │ sub-array)                          │  │  ─ dish controls               │
│  └─────────────────────────────────────┘  │  Bulk selection                │
│  ┌─────────────────────────────────────┐  │  Command log                   │
│  │ Trend strip: 3 linked charts        │  │                                │
│  └─────────────────────────────────────┘  │                                │
└───────────────────────────────────────────┴────────────────────────────────┘
```

The header strip carries the four derived numbers that answer "is the array healthy right now":
active dishes against the limit, mean and p95 temperature, mean SNR of the current scan, and the
count of dishes with a non-`none` fault code.

---

## 2. Header metrics ("is the array healthy?")

| Metric | Source | Presentation |
| :--- | :--- | :--- |
| Dishes in service | `global/state/active_dishes` | `87 / 80 min` with status token by comparison to `availability.min_active` |
| Wind stow | `global/state/wind_stow` | Amber chip when true, with the gust trend beneath |
| Mean / p95 dish temperature | `selectors.arrayMean/P95` | Two numbers plus a 20-minute sparkline, with warn/crit threshold lines |
| Current scan | `main/state/scan_state` + `scan_id` | Pill, progress %, projected finish |
| Image quality | `rta.image_quality` | coverage % and mean SNR dB |
| Faults | count of `fault_code != none` | A chip that filters the matrix to those dishes on click |

**Acceptance.** Every header metric is derived from live state or a measure, never hard-coded, and
every one has a tooltip naming its source topic.

---

## 3. The dish matrix (the 75 % band)

### 3.1 Structure follows the service

The spec says dishes are "10 rows of 10, numbered by row from the north-west", with `row`, `col`,
`lat`, `lon` in `$topology`. The matrix must therefore be laid out by `row`/`col`, not by array
index, and must be grouped by sub-array, because sub-arrays are the unit a researcher reasons
about.

```
main (79)                        auto-2 (21)
┌──────────────────────┐        ┌──────────────────────┐
│ ▪▪▪▪▪▪▪▪▪▪  row 0    │        │ ▪▪▪▪▪▪▪▪▪▪           │
│ ▪▪▪▪▪▪▪▪▪▪           │        │                      │
│ …                    │        │                      │
└──────────────────────┘        └──────────────────────┘
```

- Each cell is 24×24 px minimum with a 1 px border.
- A cell's fill encodes **status**, its border encodes **temperature band**, and a corner marker
  encodes **stowed**.
- Cells in a temporary sub-array are tinted with the sub-array's own accent (derived
  deterministically from the name) so `auto-2` is visually separable.

### 3.2 Encoding

| Aspect | Encoding | Rule |
| :--- | :--- | :--- |
| Fill | status token | ok = `--nominal`; stowed = `--caution`; fault = `--alarm` with `--crit-glow`; disabled = `--inert`; unknown = dashed outline, no fill |
| Border | temperature band | ok below `dish_temperature.warn_k` (333 K); warn from 333 K; crit at `crit_k` (343 K) — both from the API limits, never literals |
| Pulse | stowed | amber pulse at the guide's `led-caution` cadence, on stowed cells only. Overheat is static; two animated states in a 100-tile grid is a Christmas tree |
| Corner marker | stowed | a 4×4 px triangle in the top-right, so stow survives a greyscale screenshot |
| Label | id | last two digits, monospace, in the labelled layout only (cells ≥ 28 px). At the guide's 24 px the id is hover-only |

**Acceptance.** A dish at 344 K with `fault_code: overheat` is visually distinct from one at 344 K
with `fault_code: none`, because fault and heat are different problems — the first fills red and
glows, the second only borders red. A stowed dish pulses and a merely faulty one does not.

### 3.3 Interaction

| Action | Result |
| :--- | :--- |
| Hover | tooltip: id, sub-array, temperature with band, power, elevation/azimuth, fault code, minutes since calibration |
| Click | selects the dish (`#/rta/dish-042`), loads the dish panel |
| Shift-click | adds to a multi-selection for bulk operations |
| Drag | rectangle selection for bulk assignment (`21` §2.3) |
| Right-click | a small menu: stow/release, enable/disable, recalibrate, assign sub-array |
| `f` | filters the matrix to the selection |
| `Esc` | clears the selection |

**Acceptance.** Rectangular selection across the `main`/`auto-2` boundary is possible and the
selection count is shown.

### 3.4 Sort and arrange modes

- **By sub-array** (default) — mirrors the physical grouping.
- **By temperature** — a treemap-ish reflow so the hottest dishes are together, which is how a
  thermal engineer reads it.
- **By calibration age** — for the weekly maintenance sweep.
- **Geographic** — positioned by `lat`/`lon` from the geojson, which is what a site engineer
  expects.

**Acceptance.** Each mode is reachable from a segmented control and preserves the selection.

---

## 4. The scan image canvas (the centrepiece)

### 4.1 Canvas and HUD

```
┌─────────────────────────────────────────────────────────┐
│  ███ scan-0007  tgt-cen  Centaurus A       L band 1.42 GHz│  ← HUD line 1
│  grid 128² · overlap 3 · integration 04:12 / 09:00        │  ← HUD line 2
│  coverage 92 % · mean SNR 8.4 dB · rejected 1 208 (fault) │  ← HUD line 3
│                                                          │
│              (the image, pure black background)          │
│                                                          │
│  gain ▁▂▃▄▅  black ▁▂  ☐ fill holes   [raw] [cleaned]     │  ← controls
└─────────────────────────────────────────────────────────┘
```

- Background `#000000`.
- The target centre is a 1 px cross; a faint 8×8 graticule marks the grid.
- Holes are pure black **with a 1 px dim outline** so they are distinguishable from a genuinely
  dark pixel — this is a deliberate departure from the design system's pure black background,
  because "no data" and "no signal" are different facts.
- Hovering a pixel shows `(x, y)`, the mean signal, and `n` samples, which is the difference
  between a pretty picture and an instrument.

**Acceptance.** Hovering reports the sample count for that pixel, and a hole reports "no samples".

### 4.2 States the canvas must handle

| Situation | Rendering |
| :--- | :--- |
| `scan_state = running` | Progressive fill; HUD progress |
| `scan_state = paused` | Frozen image, `PAUSED` badge, progress holds |
| `scan_state = scheduled` | "Next scan in 12:40" with the target preview and no image |
| `idle` | Last completed image, dimmed, with `COMPLETE 04:12 ago` and the scan id |
| No scan ever | Empty state with "start a scan" and the presets |
| `failed` | The failure reason from the event (`target_set`, `wind`, `too_few_dishes`, …) and the last image |

**Acceptance.** All six states are visually distinct and none of them is a blank panel.

### 4.3 Cleaning toggle and its explanation

A two-way segmented control — **raw** and **cleaned** — plus a dropdown listing the rejected counts
by reason (`null`, `fault`, `low_snr`, `outlier`, `stale`). Switching must not re-render the
whole scan (the raster keeps both pipelines) and the HUD states which is displayed. This is how
the spec's warning about noisy data becomes a feature instead of a footnote.

**Acceptance.** Toggling to raw visibly degrades the image when a `receiver_fault` is injected, and
the rejected counts explain why.

### 4.4 Scan comparison

A "scans" drawer listing the last 8 scans (id, target, band, coverage, mean SNR, duration). Two
scan thumbnails can be pinned side by side with a difference view (absolute or signed), which is
how a researcher sees whether a source changed between bands. This is also the client-side half of
`rta.band_contrast`.

**Acceptance.** Two scans of `tgt-cen` at L and C band compare side by side and the difference view
highlights structure that is present in one and not the other.

---

## 5. Exploration, comparison, correlation, derived (the 100 % band)

Four named views, each answering a question a researcher actually asks:

### 5.1 Drill-down

| Path | From → to |
| :--- | :--- |
| Array → dish | Click a cell → dish panel with aim, thermal, calibration, power and controls |
| Array → sub-array | Click a sub-array header → all its dishes with aggregated temperature/power and the scan it is running |
| Scan → pixel | Hover/click a pixel → signal, sample count, and the list of contributing dishes with their individual values |
| Dish → scan participation | From the dish panel, the dish's `scan_progress` and its share of the image |

The scan → pixel → dish path is the one that matters: it explains *why* a pixel looks the way it
does.

### 5.2 Comparison

| Comparison | Presentation |
| :--- | :--- |
| Band L vs C vs K for the current target | Three thumbnails + per-band stats (mean, p95, dynamic range) + pixel-wise correlation |
| Dish vs array | In the dish panel, the dish's temperature/power series overlaid with the array mean and p95 |
| This scan vs the same target's previous scan | The comparison drawer's difference view |
| Sub-array vs sub-array | Grouped bars: active dishes, mean SNR, mean power, mean temperature |

### 5.3 Correlation

| Correlation | Axes | What it teaches |
| :--- | :--- | :--- |
| Temperature vs power draw | per dish, last 20 min | Slewing and scanning generate heat; an outlier with high power and low temperature is a sensor fault |
| Calibration age vs system temperature | per dish, now | Confirms the spec's claim that system temperature grows with calibration age, and justifies the recalibration preset |
| Elevation vs system temperature | per dish, last hour | Low elevation means more atmosphere; a dish dominated by this is not broken |
| SN R vs temperature | per dish, current scan | A hot dish is a noisy dish |

Each scatter shows Pearson r, `n`, and a one-line interpretation. That interpretation is the
"insight beyond a table".

### 5.4 Derived views

| View | Derived quantity |
| :--- | :--- |
| Image quality card | coverage %, mean SNR, rejected fraction, verdict |
| Thermal load strip | mean vs p95 temperature with the count above the warning |
| Health leaderboard | the worst 5 dishes by composite score, each with its reason |
| Pointing error strip | mean and max commanded-vs-reported error |
| Uptime strip | dishes in service over time against the 80-dish limit |

Every one is backed by a `11` measure, so it also works in replay and in the alert context.

---

## 6. Trend strip

Three linked charts sharing one time axis and one cursor:

1. **Array temperature** — mean, p95, and the count above the warn limit (secondary axis), with
   the warn/crit thresholds as horizontal lines.
2. **Dishes in service** — step chart against the 80-dish limit, with the offline dishes shaded.
3. **Scan activity** — a bar per minute showing samples received, so a wind pause is visible as a
   flatline with the `paused` event marked.

Markers on all three: scan `started`/`completed`/`paused`/`failed` and every RTA alert. Hovering a
marker links all three charts to that time.

**Acceptance.** Selecting a wind pause event moves all three cursors and shows the gust and the
temperature response.

---

## 7. Colour and legibility decisions

- The scan ramp is the design system's cyan→amber→white, not viridis, so the image reads as part
  of the console rather than as an imported plot.
- Radio intensity never uses red, because red means alarm in this console. The top of the ramp is
  white.
- The dish matrix never colours by value alone: fill is status, border is temperature. Two
  encodings, so a colour-blind operator still reads two dimensions.
- All numbers are monospace with tabular figures (`font-mono tabular-nums`), including the HUD, so
  digits do not jitter while updating at 10 Hz.

---

## 8. Failure modes

| Failure | Rendering |
| :--- | :--- |
| No `$topology` for RTA | Absence panel (`12` §4.3.2), not an empty grid |
| 100 dishes but no states yet | Grid drawn in `unknown` (dashed) tokens with "awaiting state" |
| Raster geometry unknown | Image suppressed; HUD says "waiting for scan start event" |
| `grid_size` > 512 | Rendered to an offscreen canvas at 512 and scaled, with a note |
| One dish reporting null temperatures | That cell shows `unknown`, and the array mean excludes it while stating `n` |

---

## 9. Test plan

- Component: matrix layout by `row`/`col` with a fixture topology; grouping by sub-array.
- Component: encoding matrix — 6 statuses × 3 temperature bands = 18 assertions.
- Component: canvas states (6 from §4.2) each rendered and asserted on HUD text.
- Unit: pixel hover reports the right `(x, y)` and `n`.
- Visual: `tgt-cen` L-band compared against the spec reference (§4.1 acceptance in `20`).
- Integration: replay a scan and assert the mosaic renders progressively.

---

## 10. Open decisions

- **Is the dish matrix a canvas or DOM?** DOM. 100 cells with tooltips, selection and keyboard
  access are far easier in DOM, and 100 elements is not a performance problem.
- **Does the image get an isometric view?** No. A tangent-plane image must be axis-aligned; an
  isometric projection would misrepresent offsets.