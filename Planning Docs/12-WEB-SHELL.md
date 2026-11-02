# 12 — Web Shell

**Component.** The application frame: routing, the four permanent zones, the replay tray, the
annunciator mount, navigation with per-service status, and the persistent operator identity.

**Owner files.** `web/src/main.tsx`, `web/src/App.tsx`, `web/src/index.css`,
`web/src/components/Shell.tsx`, `web/src/components/Annunciator.tsx` (mount only).

**Rubric.** UI/UX 2.5 % — *"consistent layout and navigation across services, without sign in"*,
*"information prioritised for an operator, with alerts always visible"*, *"stays usable under
fault conditions, e.g. many alerts or services offline"*.

**Depends on.** `13` (store), `08`, `14`.

---

## 1. Boundary

In scope: the frame, the chrome, global layout decisions, and the policy for what is always
visible. Out of scope: anything a service page draws (`22`/`32`/`42`) and the internals of the
alert components (`14`).

---

## 2. Current foundation

Hash routing over `['overview','rta','mhe','opg','alerts','replay']`. Header carries the
live/historical pill, WS link, broker and ARL API LEDs, ingest counters, the researcher code
input, and the simulator clock. The annunciator is always mounted. Navigation shows a per-service
LED for `rta`/`mhe`/`opg` and an alert badge. The workspace is a single main region. The footer
shows sample and gap counts.

---

## 3. Gaps against the UI/UX rubric

| Gap | Effect | Fix |
| :--- | :--- | :--- |
| No global replay tray | Replay is a page, not a mode; the design system asks for a top-of-screen transport | Add a tray that appears whenever a session is active, on every page |
| Controls remain enabled during replay | A researcher could send a command while looking at history — the most dangerous UI mistake available | Disable all control surfaces and overlay them with a purple "historical" wash |
| No global "services offline" banner | With a service down, pages show empty charts without explanation | Add a per-page absence panel with the reason (offline / silent / no data in window) |
| Header is dense and unprioritised | At 1024 px the ingest counters wrap | Collapse counters behind an expander; keep LEDs, clock, operator and alert badge always visible |
| No keyboard access | Operators work at speed | `1`–`6` switch pages, `a` focuses the annunciator, `Esc` closes modals, `/` focuses search |
| No fault-storm mode | 40 alerts push the workspace away | Group the annunciator by service above 6 open alerts |

---

## 4. Decomposition

### 4.1 Frame subsystem

#### 4.1.1 Zone layout

- **Responsibility.** The four permanent zones of the design system, never rearranged per page.
- **Contract.**
  ```
  Zone 1  header (+ replay tray when active)      fixed, 48 px, never scrolls
  Zone 2  annunciator                            collapsible, max 4 rows collapsed
  Zone 3  service nav + operator context         44 px, page tabs + researcher code
  Zone 4  workspace                               flex, contains a left pane and a right pane
  footer  capture health counters                24 px
  ```
- **Steps.** `grid-template-rows: auto auto auto 1fr auto` on a 100vh grid; Zone 4 is the only
  region that scrolls. Pages receive `left` and `right` slots so every service page has the same
  shape (telemetry left, controls right), which is what "consistent layout" means here.
- **Acceptance.** At 1280×720, 1024×768 and 1920×1080 the four zones are all present, Zone 4
  scrolls internally, and the annunciator is always on screen.

#### 4.1.2 Theme and tokens

- **Responsibility.** One source for every colour, so status colour means status.
- **Contract.** CSS custom properties in `index.css` from the design system: `--bg`, `--panel`,
  `--elev`, `--border`, `--hover`, `--ok`, `--warn`, `--crit`, `--ack`, `--inert`, and accents
  `--rta`, `--mhe`, `--opg`, `--replay`. Tailwind consumes them via `theme.extend.colors`.
- **Steps.** Never use a raw hex in a component. Add `--crit-glow: 0 0 12px rgba(239,68,68,.5)`
  and the `.arl-panel`, `.led-nominal`, `.led-alert`, `.telemetry-readout` utility classes from
  the design system's §8.
- **Acceptance.** A grep for `#` in `web/src/components` and `web/src/pages` finds no colour
  literal outside `index.css`.

### 4.2 Header subsystem

#### 4.2.1 Status cluster

- **Responsibility.** Answer "is the platform healthy?" in one glance.
- **Contract.** LEDs, in priority order: broker, ARL API, per-service online (compact), WS.
  Each LED has three states: ok, warn, crit, and a tooltip carrying the reason and last-change
  time.
- **Steps.** Broker and API come from `hello`/`frames`; per-service online comes from
  `service.online` plus the age of `lastTs`. A service is "stale" (amber) when its last message
  is older than twice its slowest stream period, and "offline" (grey) when `online === false`.
- **Acceptance.** Stopping MHE turns its LED grey within 3 s and the tooltip reads
  "offline — last message 12 s ago".

#### 4.2.2 Clock and mode pill

- **Responsibility.** Say *when* the numbers are from.
- **Contract.** The pill reads `LIVE` (slate) or `HISTORICAL REPLAY — 2x (PAUSED)` (purple);
  the clock shows simulator time with the service it is tracking when the services disagree.
- **Steps.** In replay the clock shows `virtualNow`, not the live clock, and gains a purple
  underline.
- **Acceptance.** Entering replay changes the pill and the clock in the same frame; leaving
  restores both with no flicker.

#### 4.2.3 Operator identity

- **Responsibility.** One place to set the researcher code, persisted.
- **Contract.** `useResearcher()` with `localStorage` key `arl.console.researcher`. Shows the
  code plus, once resolved, the name and the permitted services. Amber when the code is not in
  the directory, red when the API rejects it for the current service.
- **Steps.** Debounce lookup by 400 ms. Never block navigation on the lookup. The value is
  passed into every command and every alert action, so a page cannot invent its own.
- **Acceptance.** Changing the code on the Overview changes the code used by a command sent from
  the RTA page without a reload.

### 4.3 Navigation subsystem

#### 4.3.1 Tabs

- **Responsibility.** Move between the six views without losing state.
- **Contract.** `#/overview`, `#/rta`, `#/mhe`, `#/opg`, `#/alerts`, `#/replay`, plus
  `#/rta/<entity>` for a deep link to a selected element.
- **Steps.** Parse the hash into `{ page, entity }`; a page reads `entity` to preselect. Keyboard
  `1`–`6`. Each tab shows a status dot derived from open alerts for that service (crit > warn >
  none).
- **Acceptance.** `#/mhe/quarters-3` opens the MHE page with quarters-3 selected, and the URL is
  shareable.

#### 4.3.2 Absence handling

- **Responsibility.** Never show an empty page without an explanation.
- **Contract.** If a service has no topology, render a panel with: the service name, the reason
  (`offline`, `no topology received`, `no data in this window`), the last successful message
  time, and the exact command to start it (`docker compose -f arl-test.yaml up -d rta`).
- **Steps.** Distinguish "never seen" from "was seen, now silent". Link to the Alerts page
  filtered to that service.
- **Acceptance.** With RTA stopped, the RTA page explains why and does not render an empty dish
  matrix.

### 4.4 Replay tray subsystem

#### 4.4.1 Tray

- **Responsibility.** Make the time machine reachable from anywhere, which is what the design
  system's Zone 1 asks for.
- **Contract.** Visible only while a session is active. Contains: rewind, step-back, play/pause,
  step-forward, speed pills `1x 2x 5x 10x 32x`, a scrubber with alert ticks, the window label,
  and a `LIVE` button.
- **Steps.** The scrubber is a range input over `[from, to]`; dragging seeks (throttled to 4 Hz)
  and shows the target time in a floating label. Alert ticks are coloured by the highest severity
  of the alerts at that timestamp.
- **Acceptance.** Dragging the scrubber across a storm shows the alert ticks approach, the pill
  reads the target time while dragging, and releasing seeks without leaving the tray.

#### 4.4.2 Global replay discipline

- **Responsibility.** Make it impossible to mistake history for live, or to act on it.
- **Contract.** While a session is active: every control surface is disabled and washed purple
  with a `HISTORICAL` label; the annunciator shows as-of-cursor alerts and its acknowledge
  buttons are disabled; the nav LEDs show the replay timeline's state at the cursor for the
  service level; the `LIVE` button is always reachable.
- **Steps.** Implement as a single `replayMode` flag on the store that all control components
  read, rather than each page checking. Assert with a test that every `<button data-control>`
  is disabled in replay mode.
- **Acceptance.** In replay no command can be issued from any page, and returning to LIVE
  re-enables everything without a reload.

### 4.5 Fault-storm subsystem

#### 4.5.1 Degraded layout

- **Responsibility.** Stay usable with many alerts and services offline.
- **Contract.** Above 6 open alerts the annunciator groups by service and collapses to one row
  per service with a count. Above 12, it collapses to a single summary row with a severity
  histogram and an "open board" button into the Alerts page.
- **Steps.** Never let the annunciator exceed 40 % of the viewport height. The workspace keeps
  its minimum usable height (360 px) by shrinking the annunciator first.
- **Acceptance.** Injecting 30 alerts leaves the workspace interactive and the summary accurate.

#### 4.5.2 Global offline banner

- **Responsibility.** One honest statement when everything is down.
- **Contract.** If the broker is down or all three services are offline, show a single banner
  under the header ("No live data — broker unreachable; showing captured data") and keep the
  console navigable, with charts showing the last captured window and a "captured" watermark.
- **Acceptance.** Stopping the broker does not blank the console; the last data remains visible
  and clearly labelled.

---

## 5. Layout contract per page

Every service page and the Overview use the same two-pane shape:

```
left  (60 %): telemetry visualisation, drill-down target, derived strip
right (40 %): controls, presets, guards, command log
```

At widths below 1100 px the panes stack with the visualisation first, and the controls become a
right-hand drawer toggled by a persistent "Controls" button. That is the one responsive rule;
layouts do not otherwise rearrange.

---

## 6. Failure modes

| Failure | Behaviour |
| :--- | :--- |
| WS disconnected | Header shows "reconnecting"; the store retries with backoff; charts freeze but do not clear |
| No services configured | Overview shows "no services in ARL_SERVICES" and how to configure them |
| Malformed hash | Falls back to `#/overview` and rewrites the hash |
| `localStorage` unavailable | Researcher code stays in memory only; a small note appears in the operator bar |
| Window narrower than 720 px | A single "desktop console" notice, since this is a control room display |

---

## 7. Test plan

- Component: zone render at three widths (snapshot-free assertions on presence).
- Component: annunciator grouping thresholds at 0, 6 and 12 alerts.
- Component: every control is disabled in replay mode (data-attribute sweep).
- Integration: hash routing round-trip including a deep link with an entity.
- Manual: keyboard shortcuts, and the tray across a 3-hour window.

---

## 8. Open decisions

- **Router library?** None. Hash routing is 30 lines and avoids a dependency and a build risk.
- **Modal-heavy alert actions?** No, keep the annunciator inline-first and use the modal only for
  the code and resolution text, because a modal during a storm is hostile.