# Astro-Research Laboratory (ARL) — UI/UX Design System & Style Guide

**Document Version:** 1.0.0  
**Context:** Carnarvon Astro-Research Facility, Karoo, Northern Cape  
**Target Platform:** Web Monitoring, Control, Annunciator & Replay Console  
**Target Services:** Radio Telescope Array (RTA), Mars Habitation Experiment (MHE), On-demand Power Generation (OPG)

---

## 1. Aesthetic Vision: "Karoo High-Tech Industrial Observatory"

The ARL platform is an **operator mission-control console**, not an e-commerce dashboard. The visual tone balances **deep-space scientific instrumentation** with the **rugged Karoo desert environment** (arid, low-dust, clear night skies, high-consequence scientific missions).

### Core Pillars
1. **Low-Glare Dark Mode (Karoo Night Sky):** Built for 24/7 control rooms and dark observatory environments. Deep obsidian backgrounds reduce optical strain while observing faint optical/radio signatures.
2. **High Information Density (Mission Critical):** Operators need dense, glanceable readouts. Minimal dead space, clear typographic hierarchy, micro-sparklines, and zero decorative fluff.
3. **Signal Clarity & Color Precision:** Colors convey status, never mere aesthetics. Nominal conditions stay quiet; warnings and critical faults command instant focus.
4. **Glanceable Annunciator Priority:** The alarm system is permanently visible, commanding operator priority without obstructing underlying telescope telemetry.

---

## 2. Color Palette & Functional Tokens

All UI components must adhere strictly to these color tokens (represented here as CSS / Tailwind classes):

### A. Surface & Background Scales (Obsidian & Regolith)
* **Canvas / Viewport Base:** `#0a0d14` (`bg-slate-950`) — Deep space void.
* **Surface Panel / Card:** `#111827` (`bg-gray-900`) — Instrument chassis.
* **Elevated Surface / Modal / Dock:** `#1a2234` (`bg-slate-800/80`) — Control trays & sticky bars.
* **Borders / Separators:** `#1f293d` (`border-slate-800`) — Subtle instrument panel seams.
* **Subtle Highlights / Hover:** `#283548` (`hover:bg-slate-700/50`)

### B. Functional Status & Alert Palette
* **Normal / Nominal (Telemetry OK):**
  * Hex: `#10b981` (Emerald 500)
  * Use: Operational dishes, pressurized airlock, solar charging nominal, normal crew vitals.
* **Warning / Awaiting Action (Attention Required):**
  * Hex: `#f59e0b` (Amber 500)
  * Use: Dish temperature caution, room $CO_2$ trending high, battery SOC $< 25\%$, unacknowledged warning alerts.
* **Critical / Alarm (Emergency Intervention):**
  * Hex: `#ef4444` (Crimson 500) | Glow: `0 0 12px rgba(239,68,68,0.5)`
  * Use: Annunciator active alarms, dish overheat $> 75^\circ\text{C}$, heart rate spikes, power deficit, airlock emergency.
* **Acknowledged / In-Hand:**
  * Hex: `#6366f1` (Indigo 500)
  * Use: Alert acknowledged by researcher code, investigation in progress.
* **Offline / Stowed / Inactive:**
  * Hex: `#475569` (Slate 600)
  * Use: Disabled dishes, dormant diesel generator, inactive sensors.

### C. Service Accent Hues
* **Radio Telescope Array (RTA):** `#38bdf8` (Cyan 400) — Represents radio spectrum, deep sky, signal waveforms.
* **Mars Habitation Experiment (MHE):** `#fb923c` (Mars Terracotta / Orange 400) — Represents Karoo regolith and Martian biosphere habitats.
* **On-demand Power Generation (OPG):** `#facc15` (Solar Amber / Yellow 400) — Represents electrical energy, solar irradiance, and battery reserves.
* **Replay Temporal Mode:** `#a855f7` (Cosmic Purple 500) — Clearly signals that the console is in historical replay mode rather than live streaming.

---

## 3. Typography & Numerical Readouts

### Font Stacks
* **Data & Readouts (Monospace):** `JetBrains Mono`, `Roboto Mono`, or `ui-monospace`.
  * *Rule:* All telemetry values, coordinates (`tgt-xxx`), coordinates $(\Delta x, \Delta y)$, frequencies, timestamps, and researcher codes **must** be rendered in monospace with tabular figures (`font-mono tabular-nums`).
* **Interface & Labels (Sans-Serif):** `Inter`, `system-ui`, or `sans-serif`.
  * Crisp, legible at small sizes (11px–13px) for dense parameter cards.

### Typographic Hierarchy
| Role | Size / Weight | Tracking | Color |
| :--- | :--- | :--- | :--- |
| **Section / Service Header** | 18px (`text-lg`), SemiBold | `tracking-tight` | `#f1f5f9` (Slate 100) |
| **Widget Title / Label** | 11px (`text-xs`), Medium, Uppercase | `tracking-wider` | `#94a3b8` (Slate 400) |
| **Primary Telemetry Readout** | 20px–24px (`text-xl`/`text-2xl`), Bold Mono | `tabular-nums` | `#ffffff` (Pure White) |
| **Secondary Metric / Unit** | 12px (`text-xs`), Mono | Normal | `#64748b` (Slate 500) |
| **Status Tag / Badge** | 10px (`text-[10px]`), Bold, Uppercase | `tracking-wide` | Status-specific |

---

## 4. Universal Layout Architecture

The screen layout is divided into four permanent zones:

```
+--------------------------------------------------------------------------------------------------+
| ZONE 1: TOP GLOBAL HEADER & REPLAY TIMELINE TRAY                                                 |
| [ARL Logo / Status: LIVE / REPLAY]  [<<  <  ||  >  >>  1x/2x/5x/10x]  [Scrub Bar: 2026-11-02 09:40] |
+--------------------------------------------------------------------------------------------------+
| ZONE 2: PERSISTENT ANNUNCIATOR BANNER (Collapsible Alarm Dock - Red/Amber Glowing Ticker)       |
| 🚨 [2 ACTIVE]  RTA: Dish 42 Overheat [ACK] | OPG: Batt <15% [RESOLVE]    (Total Logged: 14)       |
+--------------------------------------------------------------------------------------------------+
| ZONE 3: SERVICE NAVIGATION & RESEARCHER CONTEXT BAR                                              |
| Tabs: [ 📡 Radio Telescopes ]  [ 🪐 Mars Habitat ]  [ ⚡ Power Plant ]   Operator: [ RES-8821 (ARL) ] |
+--------------------------------------------------------------------------------------------------+
| ZONE 4: PRIMARY SERVICE WORKSPACE                                                                |
|                                                                                                  |
| [ Left Pane: Telemetry & Visual Matrix ]       | [ Right Pane: Controls, Safeguards & Log ]     |
| - 100-Dish Matrix / Habitat Floor / Power Flow | - Presets, Sliders, Safety Interlocks          |
| - 2D Radio Scan Canvas / Crew Biometrics       | - Target Selector, Load Shed Controls          |
|                                                |                                                |
+--------------------------------------------------------------------------------------------------+
```

---

## 5. Service-Specific Component Guidelines

### 5.1 Radio Telescope Array (RTA)
* **100-Dish Matrix Grid:**
  * Arranged in a clean $10 \times 10$ dense tile grid.
  * Individual dish size: $24\text{px} \times 24\text{px}$ or square aspect ratio.
  * Interactive: Hover shows tooltip (Dish ID, Subarray, Current Temp, Pointing offset). Click selects the dish into the control sidebar.
  * Status indicator: 
    * Green dot / border: In service ($N \ge 80$).
    * Amber pulsing: Stowed / High wind warning.
    * Red border: Overheated ($>75^\circ\text{C}$) or faulty.
    * Gray: Disabled.
* **2D Radio Signal Scan Canvas:**
  * Background: Pure black `#000000`.
  * Spatial rendering: Coordinates mapped on an $X/Y$ relative offset grid from target center $(\Delta x, \Delta y)$.
  * Color ramp (Radio Intensity): Viridis, Inferno, or a custom cyan-to-amber heat ramp (`#0f172a` $\rightarrow$ `#0284c7` $\rightarrow$ `#38bdf8` $\rightarrow$ `#f59e0b` $\rightarrow$ `#ffffff`).
  * Target Info HUD: Monospace overlay displaying Target ID (`tgt-xxx`), Frequency Band (GHz), and Scan Integration Time.

### 5.2 Mars Habitation Experiment (MHE)
* **Habitat Blueprint / Floorplan:**
  * Stylized top-down isometric or schematic layout showing the 9 hermetic compartments: `quarters-1` through `quarters-5`, `common`, `lab`, `hydroponics`, and `airlock`.
  * Room Card Attributes:
    * Oxygen ($O_2$) & Carbon Dioxide ($CO_2$ in ppm) with clear hazard threshold indicators ($CO_2 > 1200\text{ ppm}$ triggers amber/red status).
    * Ambient Temp ($^\circ\text{C}$) and current occupant count badge.
    * Airlock state pill: `PRESSURIZED` (Emerald) vs `DEPRESSURIZED` (Amber outline).
* **Crew Biometric & Survey Strip:**
  * 5 Crew Member cards: Avatar icon, Crew ID, Heart Rate (with an animated rhythm pulse line), and Body Temperature.
  * Daily survey metrics: 4-bar horizontal micro-meters for Mood, Stress, Fatigue, Sleep Quality ($1\text{ to }10$). Values $\ge 9$ flash caution.

### 5.3 On-demand Power Generation (OPG)
* **Live Energy Flow Diagram (Sankey / Circuit Flow):**
  * Dynamic animated nodes connecting generation sources to storage and the lab microgrid:
    $$\text{Solar PV Array} \longrightarrow \text{Inverter / Bus} \longleftrightarrow \text{Battery Banks} \longleftarrow \text{Diesel Generators}$$
    $$\Downarrow$$
    $$\text{Lab Science Load (RTA + MHE + Base)}$$
* **Battery State-of-Charge (SOC) Gauge:**
  * Segmented vertical or radial battery bar:
    * $>50\%$: Emerald.
    * $25\%–50\%$: Yellow/Amber.
    * $<15\%$: Blinking Crimson with projected time-to-depletion ($t_{\text{remaining}}$).
* **Power Margin HUD:**
  * Live derived calculation: $\Delta P = P_{\text{generation}} - P_{\text{load}}$.
  * Large digital readout: Green for surplus ($+42.5\text{ kW}$ charging), red for deficit ($-18.2\text{ kW}$ discharging).

---

## 6. Annunciator Panel (The Critical Alert System)

The Annunciator is modeled after nuclear power station and aerospace master alarm annunciator boards:

* **Visual Behavior:**
  * Unacknowledged alerts flash at $1.5\text{ Hz}$ in high-contrast red/amber with an audible notification option.
  * Clicking an alert triggers a **Researcher Action Modal**:
    * Prompt: Enter **Researcher Code** (verified against ARL API).
    * State 1: **Acknowledge** ("Operator on duty has acknowledged the hazard").
    * State 2: **Resolve** ("Requires explanation / resolution notes entered before clearing").
  * When resolved, the card cleanly transitions to the permanent historical audit table showing:
    * `Alert ID` | `Service` | `Cause` | `Raised At` | `Ack By (Timestamp)` | `Resolved By (Timestamp)` | `Notes`.

---

## 7. Replay Mode Visual Cues

To prevent operators from mistaking historical playback for live real-time Karoo lab conditions:

1. **Replay Watermark & Chromatic Shift:**
   * When scrubbing backwards, the global top bar changes from Deep Slate (`#0a0d14`) to **Cosmic Violet (`#2e1065` / `#581c87`)**.
   * A prominent badge displays: `HISTORICAL REPLAY — [PAUSED | 2x | 5x]`.
2. **Timeline Scrubber:**
   * Scrubber bar spans the entire bottom or top of the viewport.
   * Colored tick marks denote when alerts were triggered or resolved during that time window.
   * Speed selector pills: `[ << Rewind ]  [ 1x ]  [ 2x ]  [ 5x ]  [ 10x ]  [ LIVE ]`.
   * Live button immediately snaps the WebSocket stream back to current telemetry.

---

## 8. Micro-Interactions & State Styling

```css
/* Instrument Panel Base */
.arl-panel {
  background-color: #111827;
  border: 1px solid #1f293d;
  border-radius: 6px;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.4);
}

/* Operational LED Indicator */
.led-nominal {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: #10b981;
  box-shadow: 0 0 8px #10b981;
}

.led-alert {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background-color: #ef4444;
  box-shadow: 0 0 10px #ef4444;
  animation: pulse 1.2s infinite ease-in-out;
}

/* Monospace Readout */
.telemetry-readout {
  font-family: 'JetBrains Mono', monospace;
  font-feature-settings: 'tnum' on, 'zero' on;
}
```