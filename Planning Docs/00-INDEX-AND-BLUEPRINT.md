# ARL Mission Console — Component Blueprint and Index

**Purpose of this document set.** The project is dismantled here into its components.
Each component has exactly one planning document in this folder. Inside that document
the component is dismantled again into subsystems, and each subsystem into
subcomponents, down to the level of "this function, this file, this shape of data,
this acceptance test". Nothing in this set is a wish list: every subcomponent names the
file it lands in and the observable behaviour that proves it works.

**Baseline.** `server/` and `web/` as they stand today are a *foundation*: a generic,
topology-driven platform shell that already ingests, persists, alerts, commands and
replays. The service documents describe what turns that shell into three graded
services. Treat the foundation as fixed scaffolding and extend it; do not rewrite it.

---

## 1. How to read this set

| Layer | Documents | Question it answers |
| :--- | :--- | :--- |
| Orientation | `00` (this file) | What exists, what is missing, what order to build in |
| Platform plane | `01`–`11` | How data becomes knowledge, and how the shell runs |
| Presentation plane | `12`–`15` | How the operator sees and drives it |
| Service plane | `20`–`23` (RTA), `30`–`33` (MHE), `40`–`43` (OPG) | What each service must do, per rubric criterion |
| Assurance plane | `50`–`53` | Security, tests, simulator harness, submission |

Every service document follows the same four-way split because the service rubric is
marked in four columns: **Data (30 %)**, **Control (30 %)**, **Visualisation (30 %)**,
**Alerts (10 %)**. Working a service means working those four documents in that order.

### 1.1 File map

**Orientation**

- `00-INDEX-AND-BLUEPRINT.md` — this file.

**Platform plane (server)**

| File | Component | Status today |
| :--- | :--- | :--- |
| `01-PLATFORM-RUNTIME.md` | Config, boot order, sim clock, event bus, logging, health, shutdown | Working; needs hardening |
| `02-TOPOLOGY-REGISTRY.md` | `$topology` parsing, indexing, control-value validation, change detection | Working; needs service adapters |
| `03-MQTT-INGEST.md` | Subscriptions, envelope normalisation, gaps, de-duplication, batching, reconnect | Working; needs null/typed handling |
| `04-PERSISTENCE-STORE.md` | Schema, transactional batches, queries, retention, migrations | Working; needs aggregate queries |
| `05-ALERT-SYSTEM.md` | Service alert intake, platform alerts, lifecycle, audit, escalation | Working; needs limit-aware context |
| `06-CONTROL-PLANE.md` | Verification, validation, dispatch, ack tracking, timeout, audit | Working; needs pre-flight safeguards |
| `07-REPLAY-SYSTEM.md` | Session, merged cursor, transport, speed, seek | Working; needs alert/event framing |
| `08-TRANSPORT-REST.md` | REST surface, error contract, static serving | Working; needs new endpoints |
| `09-TRANSPORT-WEBSOCKET.md` | Hello snapshot, coalesced frames, replay watch, backpressure | Working |
| `10-ARL-API-INTEGRATION.md` | Researchers, verify, limits, targets, health, caching | Working; needs limit caching for UI |
| `11-DERIVED-MEASURES.md` | Server-side aggregates, rollups, cross-service correlation | **Missing** |

**Presentation plane (web)**

| File | Component | Status today |
| :--- | :--- | :--- |
| `12-WEB-SHELL.md` | Routing, header, nav, annunciator mount, operator identity | Working; needs replay tray |
| `13-WEB-LIVE-STORE.md` | Client store, rings, replay injection, reconnect | Working; needs derived selectors |
| `14-WEB-SHARED-VISUALS.md` | Charts, primitives, scan imaging, alert action modal, command widgets | Working; needs presets |
| `15-WEB-OPERATOR-FLOWS.md` | Presets, schedules, safe-command guards, comparison views | **Missing** |

**Service plane**

| File | Component | Status today |
| :--- | :--- | :--- |
| `20-SERVICE-RTA-DATA.md` | Dish/scan telemetry, state, events, image reconstruction | Partial |
| `21-SERVICE-RTA-CONTROLS.md` | Sub-array and dish control surfaces, presets, safeguards | Partial |
| `22-SERVICE-RTA-VISUALISATION.md` | Dish matrix, scan canvas, drill-down, band comparison | Partial |
| `23-SERVICE-RTA-ALERTS.md` | 8 alert types, thresholds, decision context | Partial |
| `30-SERVICE-MHE-DATA.md` | Room, hydroponics, airlock, lab, vitals, habitat, surveys | Partial |
| `31-SERVICE-MHE-CONTROLS.md` | Room, airlock, irrigation, wellness controls, presets | Partial |
| `32-SERVICE-MHE-VISUALISATION.md` | Habitat plan, crew strip, survey trends, drill-down | Partial |
| `33-SERVICE-MHE-ALERTS.md` | 7 alert types, incl. 3-day wellbeing judgement | Partial |
| `40-SERVICE-OPG-DATA.md` | Plant telemetry, state, refuel events, capacity model | Partial |
| `41-SERVICE-OPG-CONTROLS.md` | Priority, load shed, solar, reserve, generator sequencing | Partial |
| `42-SERVICE-OPG-VISUALISATION.md` | Energy-flow diagram, SOC gauge, margin HUD, drill-down | Partial |
| `43-SERVICE-OPG-ALERTS.md` | 7 alert types, shortfall reasoning | Partial |

**Assurance plane**

| File | Component | Status today |
| :--- | :--- | :--- |
| `50-CROSS-CUTTING-SECURITY.md` | Access control, fail-closed, input handling, secrets, audit | Working; needs hardening |
| `51-CROSS-CUTTING-TESTING.md` | Unit, integration, fault-injection, README-runnable suite | **Missing** |
| `52-SIMULATOR-HARNESS.md` | Podman compose, scenarios, speedup, fault drills | Manual only |
| `53-DOCS-AND-SUBMISSION.md` | README discipline, repo hygiene, submission checkpoints | Working |

---

## 2. The system in one page

```
                     ┌──────────────────────────────────────────────┐
  ARL API  ─────────▶│ 10 ARL API client (researchers, limits, targets)
  :8080              └───────────────┬──────────────────────────────┘
                                     │ verify / limits / catalogue
  MQTT broker  ──────────────────────┼──────────────────────────────┐
  :1883  arl/{svc}/#                 │                              │
                     ┌───────────────▼──────────┐        ┌──────────▼─────────┐
                     │ 03 MQTT ingest           │        │ 06 control plane   │
                     │  envelopes, gaps, dedupe │        │  validate+dispatch │
                     └───────┬──────────┬───────┘        └──────────┬─────────┘
                             │          │                           │ arl/…/cmd/…
                     ┌───────▼───┐  ┌───▼──────────────┐            │
                     │ 02 topo   │  │ 04 persistence   │            │
                     │ registry  │  │ SQLite WAL batch │            │
                     └───────────┘  └───┬──────┬───────┘            │
                                        │      │                    │
                             ┌──────────▼──┐ ┌─▼───────────┐        │
                             │ 05 alerts   │ │ 07 replay   │        │
                             │ + audit     │ │ sessions    │        │
                             └──────────┬──┘ └─────┬───────┘        │
                                        │          │                │
                             ┌──────────▼──────────▼────┐           │
                             │ 08 REST   │ 09 WebSocket │           │
                             └───────────┴──────┬───────┘           │
                                                │                    │
                     ┌──────────────────────────▼────────────────────▼──┐
                     │ 13 live store  (outside React, 10 Hz notify)      │
                     │ 12 shell · 14 visuals · 15 flows · 20–43 services │
                     └───────────────────────────────────────────────────┘
```

Two clocks, never mixed:

- **Simulator time (`ts` in the envelope)** — the only clock for ordering, charting,
  replay and display of history. At `ARL_SPEEDUP=500` wall clock is meaningless.
- **Wall clock (`recv_ts`)** — used only for ingestion health: silence detection, gap
  recovery, command timeout.

---

## 3. Rubric mapping (what earns what)

| Rubric row | Weight | Primary documents |
| :--- | :--- | :--- |
| RTA (required), service rubric | 30 % | `20`–`23` |
| MHE *or* LWM, service rubric | 17.5 % | `30`–`33` |
| OPG *or* OWT, service rubric | 17.5 % | `40`–`43` |
| Alert system | 10 % | `05`, `14` (§ annunciator), `23`/`33`/`43` |
| Replay system | 10 % | `07`, `12` (§ tray), `13` (§ replay injection) |
| Architecture | 5 % | `01`–`11` |
| Security | 5 % | `50` |
| UI / UX | 2.5 % | `12`, `14`, `15` |
| Testing | 2.5 % | `51` |

### 3.1 Where the top band of each service criterion is earned

The rubric's 100 % column is specific. These are the named deliverables that reach it:

- **Data 100 %** — *"the data is used to answer a question a researcher would actually
  ask."* Dedicated derived measures per service, computed from the platform's own store:
  RTA image fidelity/coverage/SNR map and band comparison; MHE 3-day wellbeing trend and
  CO₂ exposure integral; OPG energy balance over a window and time-to-depletion. → `11`,
  and the `§ Derived measures` section of each service DATA doc.
- **Control 100 %** — *"designed around how a researcher works: presets, schedules,
  safeguards against unsafe commands."* Every service gets a named preset set, a schedule
  surface, and a client-side guard that refuses or annotates commands that would break a
  physical precondition. → `15`, and `§ Presets / schedules / safeguards` in each CONTROL doc.
- **Visualisation 100 %** — *"drill down, comparison, correlation, derived views."*
  Each service must support: element → detail drill-down, at least one comparison view,
  at least one correlation view across two measures, and one view of a derived quantity.
- **Alerts 100 %** — *"alerts give the researcher the context to decide what to do."*
  Every alert row must carry: what changed, the measured value against the limit, the
  entity and its neighbours, the plausible causes, and the controls that would address it.
  → `05` (§ context pack) and each `*-ALERTS.md`.

---

## 4. Delivery order

The exam is time-boxed. This order front-loads the rubric weight and keeps the platform
runnable at every checkpoint.

| Block | Work | Checkpoint behaviour |
| :--- | :--- | :--- |
| **A** | `51` (test rig + first suites), `01`, `04` migrations, `11` skeleton | `npm test` green; platform runs |
| **B** | `20`–`23` RTA complete (image cleaning, band compare, presets) | RTA reachable at 100 % of data/vis |
| **C** | `40`–`43` OPG complete (fast to finish; 1-minute cadence) | Second service graded |
| **D** | `30`–`33` MHE complete (slowest: 5-minute cadence) | Third service graded |
| **E** | `07` replay integration, `05` alert context, `15` flows | Replay + alert bands to 100 % |
| **F** | `50` security review, `53` README + submission | Repo clean, README runnable |

Do not start a later block by breaking an earlier one. The platform must stay runnable
after every merged change, because the grader may clone at lunch.

---

## 5. Non-negotiable conventions

These apply to every document below; they are stated once here so they are not repeated.

1. **Topic grammar.** `arl/<svc>/$topology`, `arl/<svc>/<entity>/telemetry/<stream>`,
   `arl/<svc>/<entity>/state/<item>`, `arl/<svc>/events/<kind>`, `arl/<svc>/cmd/<entity>/<control>`,
   `arl/<svc>/ack/<command_id>`. Never hard-code a service's entity list: read it from
   `$topology`.
2. **Envelope.** `{ v, ts, seq, entity }` plus measurement fields. `null` means *could not
   be measured* — never coerce to `0`, never interpolate silently, always render as "—"
   and exclude from means unless the view says otherwise.
3. **`seq` gaps are recorded, not repaired.** A gap raises `ingest_gap` and is visible in
   the footer counters. Do not fetch the ARL backlog to fill gaps: replay must use the
   platform's own captured data.
4. **Retained state is the truth for "now".** `state/<item>` is retained, so a late joiner
   is correct immediately. Never derive current state from the last telemetry message.
5. **Commands carry `{command_id, researcher, value}` only.** Everything else is inferred
   from the topic. Never add fields to the command payload "for convenience".
6. **Verification is fail-closed.** No researcher code resolution → no command. Alerts are
   different: a well-formed but unverified code may record an acknowledgement (see `05`).
7. **Simulator time is the display clock.** Never render `Date.now()` where a `ts` exists.
8. **One derived value, one definition.** If a number appears in two places, it is computed
   in one place (`11` for server-side, `13` for client-side) and imported.

---

## 6. Known defects in the foundation (fix during the referenced block)

| # | Defect | Where | Fixed in |
| :--- | :--- | :--- | :--- |
| D-1 | No test suite exists although `vitest`/`supertest` are installed and the README claims `npm test` runs tests | `server/`, `package.json` | `51` |
| D-2 | Client `CommandRow` declares `value: string`, `ack_ts`, `completed_ts`; server sends parsed JSON `value` and `settled_ts` | `web/src/lib/types.ts`, `server/src/db/store.ts` | `13`, `51` |
| D-3 | Client types alert limits as `Record<string, {type,severity,warn,crit}>`; server returns `AlertLimit[] = {key,value,unit}` | `web/src/lib/types.ts`, `server/src/arlApi/client.ts` | `10`, `11` |
| D-4 | `zod` is a dependency but unused; validation is hand-rolled and partial | `server/src/topology/registry.ts` | `02` |
| D-5 | `ScanRaster` means each pixel without cleaning; outliers from faulty dishes poison the image | `web/src/lib/imaging.ts` | `20` |
| D-6 | Alert rows show value/limit but not neighbours, causes or remedial controls | `web/src/components/Annunciator.tsx` | `05`, `23`/`33`/`43` |
| D-7 | No aggregate/derived series endpoint; the chart backfill path skips `entity === '*'` | `server/src/db/queries.ts`, `web/src/lib/hooks.ts` | `04`, `11` |
| D-8 | Replay does not surface the alert and event stream inside the replay context | `server/src/replay/session.ts`, `web/src/pages/Replay.tsx` | `07` |

---

## 7. Planning questions cross-check (§3.1 of the handout)

The handout asks the candidate to answer seven planning questions **without AI** before
work begins. They are not marked, but they set the direction. The project's answers, as
already embodied in the README decision register, are:

1. **Tech stack** — Node 18 + TypeScript (CommonJS, strict) server; express, mqtt.js,
   better-sqlite3, ws; React 18 + Vite + Tailwind client. Chosen for one language across
   both planes and synchronous SQLite writes that fit an 8-hour build.
2. **What is MQTT / how it works** — publish/subscribe over TCP with a broker; topics form
   a tree; QoS 1 gives at-least-once; retained messages give late joiners the current
   state; last-will gives crash detection. The platform subscribes with wildcards and is
   driven by each service's retained `$topology`.
3. **Broker connection and storage** — one `mqtt` client with QoS 1 subscriptions, a
   bounded in-memory queue, and a 250 ms / 1000-row batched write into SQLite in WAL mode.
4. **Initial architecture** — the two planes in §2: a topology-driven ingest + persistence
   core, with alerting, control and replay as sibling subsystems on a shared event bus.
5. **Which services and in what order** — RTA (required) → OPG → MHE. RTA first because it
   carries the largest weight and the only image problem; OPG second because its cadence
   is one minute; MHE last because five-minute cadence makes each experiment slow.
6. **Why bespoke** — the research question is not "display data", it is *"compare a
   measurement against a limit, across services that share a physical plant, and explain
   what to do"*. Off-the-shelf dashboards cannot join RTA wind stow to OPG solar
   underperformance to the same weather event, and cannot produce a two-dimensional image
   from per-dish pointing offsets.
7. **What it should look like** — see `Front-end components/DESIGN_SYSTEM.md`: a
   low-glare mission-control console with four permanent zones (header/replay tray,
   annunciator, service nav + operator, workspace split telemetry | controls).

---

## 8. Definition of done for the whole set

- All three services produce data at 100 % of their documented fields, at normal and at
  elevated speedup, with zero unrecorded loss.
- Every control in each spec is reachable from the console, shows current and target
  state, and reports the service's own rejection reason verbatim.
- Every alert type in each spec appears in the annunciator with acknowledge, resolve and
  a complete audit trail.
- Replay reconstructs any captured window, including the scan image and the alert stream.
- `npm test` runs a suite that covers parsing, alert rules, persistence and one
  end-to-end fault drill, from a clean clone following only the README.