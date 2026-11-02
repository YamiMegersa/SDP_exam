# 54 — Implementation Queue

**Component.** The order in which the 32 executable plans get built, derived from the marking rubric
rather than from preference, taste, or the order the documents were written.

**Owner.** Nothing. This document is a schedule, not a component — it owns no files and no tests. It
is the answer to "we have a week, where do we start?" and it is allowed to change as the queue
advances (§9).

**Rubric.** All of it. The whole point is that the rubric is a set of banded ladders, so the order of
work is an arithmetic question.

**Depends on.** `00` (the map), and the band wording in `exam_handout.md` §3.4.

---

## 1. What this document is

Every plan in the set is worth building *eventually*; the question here is what is worth building
*first*, and the honest answer is not the same for all of them. Two facts make the ordering
deterministic:

1. **Each criterion is a ladder in 25-point bands**, so work that moves a criterion up one band is
   worth a fixed number of exam marks — and a criterion that falls one band costs the same.
2. **The bands sum to 100 % across ten criteria**, nine of which belong to services.

So "importance" is measurable: a plan is important in proportion to the band steps it unlocks, divided
by the work it takes. Everything below follows from that division.

All 33 documents are covered. `00` governs rather than executes (it contains no build work except the
`ServiceAdapter` contract its §2.1 defines), so it appears in §3 as a prerequisite rather than in the
queue.

---

## 2. The arithmetic

Weight in the exam, and what one band step (25 points) on each criterion is actually worth:

| Criterion | Weight | One band step = |
| :--- | :--- | :--- |
| **RTA** Data / Control / Visualisation — each | 9.0 % | **2.25 %** |
| **MHE** Data / Control / Visualisation — each | 5.25 % | **1.31 %** |
| **OPG** Data / Control / Visualisation — each | 5.25 % | **1.31 %** |
| Service-level Alerts (10 % of each service) | 6.5 % | 1.63 % |
| **Alert System** (exam-level) | 10.0 % | **2.50 %** |
| **Replay** | 10.0 % | **2.50 %** |
| Architecture | 5.0 % | 1.25 % |
| Security | 5.0 % | 1.25 % |
| UI / UX | 2.5 % | 0.63 % |
| Testing | 2.5 % | 0.63 % |

Five conclusions follow, and they are the whole basis for the queue:

**(a) The nine service criteria are 58.5 % of the exam** — Data, Control and Visualisation, three
services over. Add the 6.5 % of service-level alerts and the three services are 65 %. Any hour spent
elsewhere before those are at 75 % is an hour spent on the smaller half of the rubric.

**(b) Replay and the Alert System are the best value per band in the exam.** Each is 10 % — 2.5 % per
band step — which beats an MHE or OPG criterion step (1.31 %) and an RTA step (2.25 %). They are also
*single systems*, not three parallel builds, so the work per band is the cheapest anywhere.

**(c) One feature earns two criteria.** The Alert System's 100 % band is "logged and persistent:
raised timestamp, acknowledgement timestamp, acknowledgement user, resolution timestamp, resolution
user, cause". Security's 75 % band is "alerts correctly attribute resolution and acknowledgement". The
same audit columns satisfy both: **3.75 % for one piece of work.** This is the single most efficient
item in the queue and it is routinely skipped because it looks like plumbing.

**(d) The floor is worth more than the ceiling.** Losing one RTA criterion band (75 % → 50 %) costs
2.25 % — the same as gaining the whole of Replay 75 % → 100 %. Time pressure pushes teams toward
ceilings because ceilings are interesting; the rubric charges more for floors.

**(e) UI/UX and Testing together are 5 %.** Perfect scores on both are worth less than two band steps on
one service criterion. They still matter — Testing's 100 % band is the only place the word "justified"
appears, and Architecture's credibility rides on the README — but neither justifies a day early on.

---

## 3. Tier 0 — non-negotiable

These are not "high priority"; they are the conditions under which the rest of the marks exist at all.
Every one has a criterion band that reads *absent* rather than *weak* if it is skipped.

| Plan | Band it protects | What breaks if it is skipped |
| :--- | :--- | :--- |
| `53` Submission & README | Architecture **0 %** — "does not start from the README" | The platform cannot be run by the marker. Architecture starts at zero and the credibility of every other claim collapses |
| `01` Platform runtime | Architecture 25 % (env-only config, no hard-coded credentials); Security 100 % (secrets) | Nothing boots. Credentials in source is the one explicit "lab weakened" example |
| `02` Topology registry | Architecture 75 % — "driven by the topic structure each service publishes" | No discovery, so no entities, so no data, no controls and no pages for all three services |
| `03` MQTT ingest | Data **0 %** — "no data being captured" | The entire Data criterion (58.5 % of the exam across nine criteria) has nothing to score |
| `04` Persistence | Data 50 % — "all fields captured but data is lost or not persisted" | Data is capped at 25 %, and Replay is capped at 25 % because replay must use *your* captured data |
| `08` REST transport | Everything in the UI | The console is empty. No backfill, no alerts, no replay |
| `09` WebSocket transport | UI/UX, and every live readout | The console only updates on reload; a mission-control console that does this scores 25 % on UI/UX at best |
| `13` Live store | Every page | Pages render `—` forever |
| `05` Alert system | Alert System **0 %** — "no alert system"; and Security 75 % cannot be reached | 10 % of the exam, plus the 1.25 % that shares its work |
| `06` Control plane | Control 30 % per service (19.5 % of the exam) | No controls at all. Also the only path to Security 50 % |
| `10` ARL API integration | Security 25 % — "codes resolve correctly via the ARL API"; Data/Vis verdicts | Commands cannot be authorised, and no limit-driven verdict is possible, so D-10 cannot be fixed |
| `00` §2.1 ServiceAdapter contract | Architecture 50 % — "shared shell, persistence layer and alert system reused" | Without it the three services become three codebases and Architecture stops at 25 % |

**The Tier 0 test.** Unplug any row from the running system and ask whether the rubric sentence it
protects would still be true. If the answer is no, that row is non-negotiable and it goes in the queue
before anything in Tier 1.

---

## 4. The queue

Order respects dependencies first, value second. Each phase ends at a rubric sentence that can be
demonstrated live, which is the only definition of "done" that survives contact with a marker.

### Phase 0 — Prove it runs (Architecture 25 %, Testing 25 %)

| Plans | Work | Exit criterion |
| :--- | :--- | :--- |
| `53`, `01`, `50` | Make the README's commands true; move every secret to `.env`; one test that runs | `git clone && cp .env.example .env && npm install && npm run build && npm start` serves the console, and `npm test` exits 0 |

**Why first.** Architecture's bottom band is not about code quality, it is about whether the thing
starts. One day here converts Architecture from 0 % to 25 % and removes the single largest risk in the
submission: a marker who cannot run it.

**Do not** write the full test suite here. One test, so the documented command is honest.

### Phase 1 — The data spine, all three services (Data to 50 %)

| Plans | Work | Exit criterion |
| :--- | :--- | :--- |
| `02`, `03`, `04`, `08`, `09`, `13` | Complete field coverage per service against `$topology`; typed nulls; batch writer; aggregate query; backfill | Every stream, state item and event for all three services is persisted, including at `ARL_SPEEDUP` > 1, with no gaps |

**Why here.** Data is 30 % of each service. The 50 % band requires *all* fields and *persistence* —
"some fields and devices" is only 25 %, which is the trap: partial coverage feels like progress and
scores as half of it. This phase is where `04`'s transactional batching earns its keep, because the
75 % band explicitly names running the service at higher speed.

### Phase 2 — The derived measure (Data 50 % → 75 %, all three at once)

| Plans | Work | Exit criterion |
| :--- | :--- | :--- |
| `11`, then `20`/`30`/`40` | Seven measures are already implemented; finish the verdicts, expose `/api/derived`, and state the researcher question each one answers | "All data captured and persisted, including at higher speed, with at least one derived or aggregated measure" |

**Why so early.** This is the highest-yield single item in the queue: one system, **4.87 %** across
three services (2.25 + 1.31 + 1.31), because the same measure set counts for every service. The
foundation already has seven measures in `measures.ts`, so most of this phase is wiring and
argument rather than code.

### Phase 3 — The control plane (Control to 75 %, Security 50 %)

| Plans | Work | Exit criterion |
| :--- | :--- | :--- |
| `06`, `10`, `21`/`31`/`41`, `14` (command widgets) | Every control generated from topology; state-vs-target display; ack tracking; completion and failure information; verify against `POST /v1/researchers/verify` | All control surfaces implemented, with failure/completion information and current and target state shown; a bad code returns 403 naming the reason |

**Value: ~15.9 %** (three Control criteria to 75 % = 14.63 %, plus Security 25 → 50 %).

**The one thing not to get wrong.** The gate is `POST /v1/researchers/verify` with the service, not
`GET /v1/researchers/:code`. Using the lookup earns Security's 25 % band and blocks the 50 % band,
because per-service authorisation is never checked (`06` §4.1.2).

### Phase 4 — Alerts that pay twice (Alert System to 100 %, Security to 75 %)

| Plans | Work | Exit criterion |
| :--- | :--- | :--- |
| `05`, `23`/`33`/`43`, `14` (modal), `15` (modal idiom) | All service alert types raised from the service's own limits; annunciator; acknowledge; resolve with notes; the audit table of `16` §4.4.3 | Every service alert is supported, resolution is implemented, and every transition is persisted with raised/ack/resolve timestamps **and users** and a cause |

**Value: ~7.9 %** (Alert System 50 → 100 % = 5 %, service alerts 50 → 75 % = 1.63 %, Security 50 → 75 %
= 1.25 %).

**Why the audit table is the whole phase.** Acknowledge-only is the 50 % band. Resolution is 75 %. The
100 % band is the *attribution*, and it is the same columns that earn Security's top reachable band.
The seven columns of `16` §4.4.3 are the cheapest 3.75 % in the submission. Do not ship the live
alert list and call the audit table "later" — that is exactly the gap the rubric charges for.

### Phase 5 — Visualisation to 75 % (structure-informed graphics)

| Plans | Work | Exit criterion |
| :--- | :--- | :--- |
| `14` (TrendChart, raster cleaning), `22`/`32`/`42`, parts of `16` | 10 × 10 dish matrix and cleaned scan; floor plan; energy-flow diagram; plus the shared chart primitives they all need | "Graphical representation informed by service structure" for all three |

**Value: 4.87 %.** The 75 % band is *not* about beauty; it is about whether the graphic is shaped by the
service (a dish grid in array order, a floor plan from the facility drawing, a Sankey of the actual
plant topology). `16`'s state-colour rules belong here, not in Phase 9, because colour *is* the
encoding.

### Phase 6 — Replay (10 % of the exam)

| Plans | Work | Exit criterion |
| :--- | :--- | :--- |
| `07`, `12` (tray), parts of `16` (§4.5) | Play/pause, rewind, fast-forward, speed across all services, from captured data only; then the replay context | Replay reaches its 100 % band: alerts and events shown in the context of the replay |

**Value: 10 % at 2.5 % per band** — the joint-best rate in the exam. Sequence it *after* Phase 4
because the 100 % band ("integrated with the rest of the platform, e.g. alerts and events shown in the
context of the replay") is impossible while alerts are not yet surfaced in replay (D-8).

### Phase 7 — The ceilings (Data / Control / Visualisation to 100 %)

| Plans | Work | Exit criterion |
| :--- | :--- | :--- |
| `20`/`30`/`40` (researcher question), `15` (presets, schedules, safeguards), `22` §5 / `32` §5 / `42` §7 | Drill-down, comparison, correlation, derived views; presets; schedules; unsafe-command safeguards | Data: the data answers a question a researcher would actually ask. Control: controls designed around how a researcher works. Visualisation: exploration and insight beyond a table |

**Value: ~14.6 %** — but this is the expensive 14.6 %, because the 100 % bands ask for *design
thinking*, not more widgets. Take these in the order shown: Data's 100 % band is mostly an argument
plus a derived measure and is the cheapest of the three.

### Phase 8 — Test evidence (Testing to 100 %)

| Plans | Work | Exit criterion |
| :--- | :--- | :--- |
| `51`, `52` (one drill, not eight) | Unit tests on parsing and alert rules; one integration test on persistence; one drill file against the test broker with controls enabled | "The testing strategy is justified, e.g. against the test broker with controls enabled or simulated faults" |

**Value: 0.63 → 2.5 %.** Cheap but small; run it here because Phase 7 has produced the behaviours
worth testing. Do not build `52`'s full drill catalogue — the rubric asks for a *justified strategy*,
and one drill plus a table of what each drill would prove satisfies it.

### Phase 9 — Polish (UI/UX to 100 %)

| Plans | Work | Exit criterion |
| :--- | :--- | :--- |
| `16` (remaining clauses), `12` (fault-storm, offline banner) | The 20 deviations in `16` §5 (18 `FIX`, 2 `GAP`) that are not already closed by Phases 4–6; annunciator grouping; global offline banner | "Design shows clear decisions about the researcher's tasks and stays usable under fault conditions" |

**Value: 2.5 % total, this phase perhaps 1.9 %.** Last, deliberately. It is the smallest criterion and
the one most likely to consume a day.

---

## 5. The ranking, all documents

Rank is queue position, and queue position is decided by three things in order: **dependencies**
first (nothing can precede the store), then **rubric value per unit of effort**, then **service weight**.
That is why a 4.87 % plan can rank below a 1.25 % one — `15` is high-effort and last-band, `50` is cheap
and closes a whole ladder. "Tier 0" means the band it protects reads *absent* if skipped.

| # | Plan | Tier | Phase | Why it sits here | Effort |
| :--- | :--- | :--- | :--- | :--- | :--- |
| 1 | `53` Submission & README | 0 | 0 | Architecture's 0 % band; the marker's only entry point | Low |
| 2 | `01` Platform runtime | 0 | 0 | Nothing runs without it; env-only config is an explicit band | Low |
| 3 | `02` Topology registry | 0 | 1 | Discovery for all three services; also Architecture's 75 % band | Medium |
| 4 | `03` MQTT ingest | 0 | 1 | Data's 0 % band | Medium |
| 5 | `04` Persistence | 0 | 1 | Data 50 % and Replay's 50 % both require it | Medium |
| 6 | `08` REST transport | 0 | 1 | The UI's only source of history | Low |
| 7 | `09` WebSocket transport | 0 | 1 | Live console; the UI/UX floor | Low |
| 8 | `13` Live store | 0 | 1 | Every page reads it | Low |
| 9 | `11` Derived measures | 0 | 2 | **4.87 %** from one system; Data's 75 % band names it | Low |
| 10 | `20` RTA data | 1 | 2 | Field completeness for the 30 % service | Medium |
| 11 | `30` MHE data | 1 | 2 | Field completeness | Medium |
| 12 | `40` OPG data | 1 | 2 | Field completeness | Low |
| 13 | `06` Control plane | 0 | 3 | 19.5 % of the exam across three services | Medium |
| 14 | `10` ARL API integration | 0 | 3 | Security's 25 % band; the limit source that fixes D-10 | Low |
| 15 | `21` RTA controls | 1 | 3 | 14 control surfaces, the required service | High |
| 16 | `31` MHE controls | 1 | 3 | 9 surfaces incl. object-valued schedules | Medium |
| 17 | `41` OPG controls | 1 | 3 | Priority, shed, reserve, generator sequencing | Medium |
| 18 | `05` Alert system | 0 | 4 | 10 % of the exam, and the shared 3.75 % | High |
| 19 | `23` RTA alerts | 1 | 4 | All 8 alert types, with decision context | Medium |
| 20 | `33` MHE alerts | 1 | 4 | 7 types, one needing a 3-day wellbeing judgement | Medium |
| 21 | `43` OPG alerts | 1 | 4 | 7 types, shortfall reasoning | Low |
| 22 | `14` Shared visuals | 1 | 3–5 | Primitives all three visualisations are built from | High |
| 23 | `22` RTA visualisation | 1 | 5 | The 75 % band, on the service an examiner looks at first | High |
| 24 | `32` MHE visualisation | 1 | 5 | Floor plan and crew strip | High |
| 25 | `42` OPG visualisation | 1 | 5 | Energy flow, SOC gauge, margin HUD | Medium |
| 26 | `07` Replay | 1 | 6 | 10 % of the exam at 2.5 % per band | High |
| 27 | `12` Web shell | 1 | 6 | Four zones, tray, annunciator mount | Medium |
| 28 | `50` Security | 1 | 3–4 | 5 %, and cheap: `06` and `05` do the actual work | Low |
| 29 | `15` Operator flows | 1 | 7 | Control's 100 % band only — real value, high effort | High |
| 30 | `16` Design conformance | 2 | 5, 9 | UI/UX 2.5 %, plus the colour semantics Phase 5 needs | Medium |
| 31 | `51` Testing | 2 | 8 | 2.5 % | Medium |
| 32 | `52` Simulator harness | 2 | 8 | Testing's 100 % band; one drill suffices | High |
| — | `00` Index & blueprint | governs | — | Not build work, except §2.1's adapter contract, which is Tier 0 | — |

**The two shapes in this table.** Ranks 1–9 are *value-dense and cheap*: platform work that unlocks
three services at once. Ranks 29–32 are *value-sparse or expensive*: a high-effort ceiling (`15`), a
2.5 % polish criterion (`16`), and testing, whose whole budget is 2.5 %. Between them sit the three
service lanes, which are equal in kind and ordered only by weight.

**On the three lanes.** Ranks 10–12 and 15–17 and 19–21 are lane-local: if two or three people work in
parallel (§7) they run concurrently, and only their *first* member needs the platform plane finished.

---

## 6. The cut list

When time runs out, cut from the bottom. The cost column is what the rubric actually charges.

| Cut | Cost | Why it is survivable |
| :--- | :--- | :--- |
| `52`'s drill catalogue → one drill | Testing 100 % → 75 %; **0.63 %** | "Justified strategy" is one drill plus a rationale, not eight |
| `16`'s remaining deviations (18 `FIX` + 2 `GAP`; both `GAP`s are replay cues, already Phase 6) → the half that carries meaning | UI/UX 100 % → 75 %; **0.63 %** | The gauge, grid and replay cues are meaning; the 11 px label is not |
| `15` schedules (keep presets and guards) | Control 100 % → 75 %; **1.31 % per service** | "Presets, schedules, safeguards" is a list of examples, not a conjunction |
| `32`/`42` 100 % band views (keep 75 % band) | Visualisation 100 % → 75 %; **1.31 % each** | Correlation is the most expensive view and the least demonstrated |
| MHE or OPG entirely | **17.5 %** | Not survivable. Both are in the rubric as "best of" pairs and we chose one of each |
| `07` replay integration (keep play/pause/seek) | Replay 100 % → 75 %; **2.5 %** | The most expensive 2.5 % to skip, which is why it is Phase 6 and not Phase 9 |

**Never cut, at any cost:** `04` persistence, `02` discovery, the alert audit columns, `06`'s verify
call, and a README that runs. Each is a band *floor*, and floors are charged at the same rate as
ceilings.

---

## 7. Three lanes

The queue is sequential because the platform plane blocks everything. Once Phase 4 lands, the three
service planes are independent and should run in parallel:

```
        Phases 0-4 (one lane, or two: platform + alerts)
        ────────────────────────────────────────────────┬──────────┬──────────┐
                                                        │          │          │
                                              RTA lane  │ MHE lane │ OPG lane │
                                              (30 %)    │ (17.5 %) │ (17.5 %) │
                                              Phases 5-7 for that service
                                                        │          │          │
                                                        └──────────┴──────────┘
                                                                 │
                                                     Phase 6 replay (shared)
                                                     Phase 8-9 assurance (shared)
```

Two rules for the lanes. **RTA goes first and hardest** — it is 30 % against 17.5 %, it is the required
service, and its visualisation (the scan canvas) is the one an examiner is most likely to look at.
**Each lane owns its own service's alerts**, because "all service alerts are supported" is a
service-level band, and it is the lane that knows what the alerts mean.

Do not run three lanes before Phase 4. Three half-migrations against a moving store produce three
divergent schemas, which costs Architecture's 50 % band ("shared persistence layer reused").

---

## 8. Traps

Work that feels productive and earns almost nothing, in the order teams fall into them:

1. **Polishing a small criterion above its 75 % band while a large one sits at 50 %.** The ceiling of
   UI/UX is 0.63 %; the floor of RTA Data is 2.25 %.
2. **Building the eight drill files before the first test exists.** Testing's 25 % band only needs
   "some tests exist and can be run"; its 100 % band needs one justified drill.
3. **Reading "all service alerts are supported" as "the alerts we have are supported".** It is
   completeness, and it is checked against the service's own alert list (`23`/`33`/`43` each enumerate
   them).
4. **Treating the audit table as plumbing.** It is 3.75 % across two criteria (Phase 4).
5. **Chasing the 100 % visualisation band before the 75 % one.** Correlation plots on a floor plan that
   is a generic grid score worse than a good floor plan with no correlation at all.
6. **Skipping `11` because the pages already look quantitative.** The derived measure is written into
   the Data criterion's 75 % band; a console full of numbers with no aggregate is capped at 50 %.
7. **Beautiful, and empty.** A design-system-perfect shell with no persistence is worth less than a
   plain one with data. `16` is Phase 9 for that reason.

---

## 9. Re-ranking triggers

This queue is wrong the moment one of these becomes true, and should be rewritten rather than defended:

- **A service plane slips past Phase 7 while another is not started.** The "best of" pairs do not
  substitute within a service, so an unfinished MHE costs 17.5 % regardless of OPG's quality.
- **Persistence proves unable to hold `ARL_SPEEDUP` > 1.** Then Data is capped at 50 % for all three
  services and everything else must be re-planned around a 14.6 % loss, not a 4.87 % one.
- **The alert audit columns turn out to be already implemented.** Then Phase 4 shrinks to the
  annunciator and the queue advances a day.
- **Fewer than three days remain.** Collapse to: Phase 0, Phase 1, Phase 2, Phase 4, then one
  visualisation (RTA). That is the maximum rubric value reachable in the time, and it deliberately
  leaves the ceilings unclaimed.