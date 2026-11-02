# 53 — Submission, README and the Evidence Trail

**Component.** The artefacts a marker actually touches: the README they start from, the planning set
this document closes, the repository that is detected and marked, and the rubric-by-rubric audit that
says where each claim is evidenced.

**Owner files.** `README.md`, `Planning Docs/**`, `.gitignore`, `.env.example`, the repository itself.

**Rubric.** Architecture 5 %, and specifically its **0 % band: "does not start from the README"**. The
25 % band is `Starts from the README, configured through the provided environment variables with no
hard-coded credentials, with the code separated into modules`. Testing's 75 % band is `tests ... are
run from the README`. This document therefore protects 5 % directly and gates another 2.5 %.

**Depends on.** Every other document in the set. It is the index and the audit, not new work.

---

## 1. Boundary

The handout makes the README an **assessment criterion**, not a convenience:

| Band | Wording | What it means |
| :--- | :--- | :--- |
| 0 % | "Does not start from the README" | A marker cannot run it |
| ≤ 25 % | "Starts from the README, configured through the provided environment variables with no hard-coded credentials, with the code separated into modules" | Three commands work, `.env` supplies everything, no secret in the tree |

So a README that is beautiful and slightly wrong scores **zero on Architecture**. A README that is
plain and exactly right clears the floor before the marker has read a line of code. Every other
consideration in this document is subordinate to that.

In scope: the README's structure and its claim audit; the planning set as a navigable index; the
submission mechanics; the demonstration script; the rubric self-audit.

Out of scope: a written report (not requested), slides, a video, and renumbering the README's existing
decision register (a concurrent editor owns it — §4.3).

---

## 2. Current foundation

The README has grown well past a stub. It currently contains, in order: Scope (with the weight table and
the three chosen services), Chosen Stack with rationale, Architecture with an ASCII diagram, Data flow,
Time handling, Persistence model, the MQTT contract, Configuration, Running Locally, Running the
Platform, Testing, Security Decisions, Decision Register (D1–D8), Progress Log, Known Issues (R1–R11),
Open Items, AI Declaration, Licences.

That is a strong README. It is also **still edited by another instance of this conversation**, which is
the single most important constraint on this document (§4.3).

The planning set is complete and separate: 34 documents, `00`–`54`, ~9,700 lines, none of them
referenced from the README yet.

### 2.1 The claim audit (the finding that matters)

Every command the README tells a reader to run, checked against the tree as it is:

| README says | Actually | Verdict |
| :--- | :--- | :--- |
| `npm install` | workspaces install | **works** |
| `cp .env.example .env` | `.env.example` lists names only, no values | **works** |
| `npm run dev` | `concurrently` → `tsx watch` + `vite` | works off this machine; `tsx` fails here with `EROFS` (R11 already records this) |
| `npm run build` | `web build && server build` | **works** |
| `npm start` | `node dist/index.js` | **works** |
| `npm test` | `vitest run` | **fails** — zero test files (D-1) |
| `npm run test:watch` | `vitest` | same |
| `npm run typecheck` | both workspaces | **works** |
| `podman load -i images/*.tar` | bundle present | **works** |
| `podman-compose -f arl-test.yaml up -d api rta mhe opg` | podman-compose 1.0.6 present | **works** |

Two failures, both the same cause. A marker who runs `npm test` and sees `No test files found` now
doubts **every** other command in the file, including the five that work. That is the exact failure the
0 % band describes, arriving by a side door.

The README's Testing section presents a strategy in the present tense as though implemented. The honest
options are (a) write the tests, or (b) label the section as planned. (a) is cheaper than the risk.

---

## 3. Gaps

| Gap | Rubric effect | Fix |
| :--- | :--- | :--- |
| `npm test` fails while the README claims it runs (D-1) | Architecture floor at risk; Testing ≤ 25 % | §4.1.3: make the claim true, or make the label honest — in that order of preference |
| Nothing in the README points at `Planning Docs/` | ~9 400 lines of reasoning that a marker never opens | §4.2 |
| No §"Harness" commands (`stack.sh`, `drill.sh`, fixtures, `verify`) | `51`/`52` plan commands that do not exist yet; the README cannot promise them | §4.1.2, phased |
| Two registers use the same letter | "D4" (a decision) and "D-4" (a defect) will be confused | §4.3.3 convention |
| No rubric self-audit | The marker has to reconstruct which file answers which criterion | §4.5 |
| The repository is not the graded repository | **The work would not be detected at all** | §4.4.1 — the highest-severity item in the whole plan |
| No demonstration script | A marker has five minutes and no route | §4.6 |

---

## 4. Decomposition

### 4.1 The README

#### 4.1.1 The invariant

**Every command in the README must succeed on a clean clone, in the order given, with nothing but
`.env`.** Where that is not yet true, the section says so in the same sentence — `*(planned — see
Planning Docs/51)*` — rather than in a footnote. A truthful "planned"
costs nothing; a broken command costs a band.

#### 4.1.2 Structure

Keep the existing order and append, rather than reflowing. The additions, in the sections they belong
to:

| Section | Addition |
| :--- | :--- |
| top matter | one line: *the implementation plan for every component is in `Planning Docs/`, indexed at `00-INDEX-AND-BLUEPRINT.md`* |
| Running Locally | a "The harness" subsection: `scripts/stack.sh up`, `scripts/drill.sh <name>`, `scripts/stack.sh down`, each with what it does in one clause |
| Testing | the command table from `51` §4 (`test`, `test:coverage`, `typecheck`, `verify`, `fixtures`, `drill`), and one sentence of strategy justification referencing `51` §3 |
| Architecture | a "Documentation map" line per module: which numbered document decomposes it. Five rows, not thirty |
| Known Issues | the harness's own failures once they are known (`52` §5) |

Nothing is removed from the existing text. The fences and caveats there are evidence of real verification
and are worth marks in their own right (R1–R11 name defects the team found and fixed; that reads as
competence, not as a list of weaknesses).

#### 4.1.3 The claim audit as a recurring check

Add `npm run verify` (`typecheck && test && build`) and make the README's front matter say: *every
command in this file is exercised by `npm run verify` or by a drill.* Then re-audit §2.1 before each
push. The audit is four minutes' work and it protects a 5 % criterion; nothing else in the project has
that ratio.

#### 4.1.4 The three commands a stranger needs

Whatever else changes, these must be true, in this order, on a machine with Node 18, podman and nothing
else:

```bash
npm install
cp .env.example .env          # then fill in four values: broker host/port, API host/port
npm run build && npm start     # http://localhost:3000
```

`npm run dev` is offered as the developer path and labelled as such, with `tsx`'s sandbox limitation
noted once (it already is, R11). A marker should never need `dev`.

### 4.2 The planning set

#### 4.2.1 What it is

34 documents in `Planning Docs/`, one per component, each decomposed into subsystems and subcomponents
with a **Responsibility / Contract / Steps / Acceptance** block per subcomponent. `00-INDEX-AND-BLUEPRINT.md`
is the map and the blueprint; `exam_handout.md` is the brief itself.

| Range | Covers |
| :--- | :--- |
| `00` | Index, the delivery order, the defect register (D-1…D-10), the document template |
| `01`–`11` | The platform: runtime, topology registry, MQTT ingest, store, alert system, control plane, replay, REST, WebSocket, ARL API client, derived measures |
| `12`–`15` | The web client: shell and design system, live store, shared visuals, operator flows |
| `20`–`23` | RTA: data, controls, visualisation, alerts |
| `30`–`33` | MHE: data, controls, visualisation, alerts |
| `40`–`43` | OPG: data, controls, visualisation, alerts |
| `50`–`53` | Security, testing, simulator harness, submission (this document) |
| `54` | The implementation queue: what is non-negotiable, what order to build in, and what to cut |

#### 4.2.2 How it should be read

Three reading paths, stated in `00` and again here, because a marker will not read 9 300 lines:

| Reader | Path |
| :--- | :--- |
| "What is this and does it work?" | README → `00` §1–2 → `52` §4.7 (the drill results) |
| "How is RTA data handled?" | `20` → `03` → `04` → `11` → `22` |
| "Where is the evidence for the rubric?" | `00` §3 (the rubric map) → §4.5 below |

#### 4.2.3 What the set is not

It is not a design document written after the fact. The three service quadruples were written by reading
the specifications and the existing code together, and that process produced D-9 and D-10 — two real
threshold contradictions between the MHE/OPG pages and the services. A planning set that finds bugs is
doing its job; one that only describes intentions is decoration.

### 4.3 Working with a concurrently edited README

A second instance of this conversation is editing `README.md` at the same time. Overlap is the risk;
silence is not an option, because the README is a marked artefact.

#### 4.3.1 The protocol

| Rule | Why |
| :--- | :--- |
| **Re-read the file immediately before every edit** | A cached copy may already be stale by the time the edit lands |
| **Append, never reflow** | Rewrapping a paragraph another instance just wrote produces a conflict over formatting, and formatting conflicts are unmergeable |
| **Additions go at the end of the section they belong to** | Two inserts at the same anchor are one conflict; two inserts at different anchors are none |
| **One `SearchReplace` per logical change, anchored on text that already exists** | Whole-file rewrites would destroy the other instance's work |
| **Never renumber an existing table** | D1–D8 and R1–R11 are cited nowhere else, but a marker may cite them, and the other instance's prose refers to them |
| **If a section already says it, add nothing** | Duplication across two instances is the failure mode; the check is a grep for the heading first |

#### 4.3.2 What is genuinely ours to add

The other instance is documenting the *platform build* (stack, decisions, progress, risks). The planning
set is documentation of the *plan*. These barely overlap. Specifically ours:

- the pointer to `Planning Docs/` and the three reading paths;
- the documentation map (module → numbered document);
- the harness commands, once `scripts/` exists;
- the `npm run verify` claim, once it exists.

Specifically theirs, and not to be touched: Scope, Chosen Stack, Architecture, Data flow, Time handling,
Persistence model, MQTT contract, Configuration, Decision Register, Progress Log, Known Issues, Open
Items, AI Declaration.

#### 4.3.3 The register convention

Two registers share a letter. Fix it by convention, in one sentence in both places:

| Form | Means | Lives in |
| :--- | :--- | :--- |
| `D1`…`D8` | A **decision** (what we chose and why) | README § Decision Register |
| `D-1`…`D-10` | A **defect** (what is wrong, and which document fixes it) | `Planning Docs/00` §6 |
| `R1`…`R11` | A **risk** (what could go wrong, and the mitigation) | README § Known Issues |

No renumbering. The hyphen is the difference, and the sentence makes it explicit rather than subtle.

### 4.4 The submission

#### 4.4.1 The repository (highest severity item)

The handout: *"create a private repository on `sdp.ms.wits.ac.za` named `<student-number>-sdp-exam-2026`
… We will run a script to automatically detect the repositories at lunch, and then again 30 minutes
before the end of the exam."*

The workspace is currently `SDP_Exam` and points at a directory of that name. **A repository named
`SDP_Exam` is not detected, and undetected work scores zero regardless of quality.** The README already
records this as an open item; it is restated here because it is the only failure in this document that
is unrecoverable after the fact.

| Requirement | Action |
| :--- | :--- |
| Name | `<student-number>-sdp-exam-2026`, exactly |
| Host | `https://sdp.ms.wits.ac.za/<username>/<student-number>-sdp-exam-2026.git` |
| Visibility | private |
| Detection | at lunch, and again 30 minutes before the end |

**Consequence for cadence.** The lunch detection is a hard deadline for *having something pushed*, not
for finishing. So: push a working, README-accurate state **before lunch**, whatever else is unfinished,
and push again before the final detection. A repository whose last commit is at 10:00 is marked on that
commit; a repository that is perfect at 16:58 and unpushed is marked on nothing.

#### 4.4.2 What must and must not be committed

| Must be committed | Must not be committed |
| :--- | :--- |
| `server/src`, `web/src`, `package.json`, `package-lock.json` | `.env` or any credential (`.gitignore` covers it) |
| `Planning Docs/**` | `data/*.sqlite*` (gitignored) |
| `Services/arl-sim/config`, `scenarios`, `mosquitto`, `arl-test.yaml` | `Services/*.zip`, `Services/*.tar.gz` (gitignored) |
| `scenarios/*.toml` once they exist | `.logs/`, drill artefacts (to be gitignored) |
| `.env.example` (names only) | `node_modules/`, `dist/`, `web/dist/` |

The simulator bundle is exam material and the `.gitignore` already excludes its archives. Our *scenario
files* are ours and must be committed, because they are the drills' definitions.

#### 4.4.3 The pre-push checklist

1. `git status` — no `.env`, no `data/`, no `.log`, no artefact directory.
2. `rm -rf node_modules && npm install && npm run build && npm start` — from nothing, in one clean run. This is the Architecture floor, executed rather than assumed.
3. `npm test` — either passes, or the README does not claim it.
4. `grep -ri "password\|secret\|token" --include=*.ts --include=*.tsx server/src web/src` — only config reads.
5. README's commands re-run in order (§2.1).
6. Push.

### 4.5 The rubric self-audit

The one table that says where each claim is evidenced. It belongs in `00` as well; repeated here because
this is the document about evidence.

| Criterion | Weight | Evidence |
| :--- | :--- | :--- |
| RTA — required | 30 % | `20`–`23`; drill `controls-rta`; the scan raster and measured image quality |
| MHE or LWM (best) | 17.5 % | `30`–`33`; drills `controls-mhe`, `faults` |
| OPG or OWT (best) | 17.5 % | `40`–`43`; drills `controls-opg`, `reconcile` |
| Alert system | 10 % | `05`, `23`/`33`/`43`; `storm` and `faults` drills; the `AlertContext` unit tests |
| Replay | 10 % | `07`, `08`; drill `replay`; `alertsAsOf` |
| Architecture | 5 % | `01`–`11`; §2.1 audit; the shared registry driving all three services; `reconcile` |
| Security | 5 % | `50`; the per-service verification test; §4.4.2 secrets check |
| UI / UX | 2.5 % | `12`–`15`; the design system; usable with three services offline and twenty alerts raised |
| Testing | 2.5 % | `51`, `52`; `npm test` runnable, then the drills |

The honest reading of that table today: Architecture is real, Security is real, and Testing is the gap
that also endangers Architecture. The service quadruples are plans, not evidence, until the drills in
`52` §4.7 have rows.

### 4.6 The demonstration

A marker has minutes. Give them a script, in the README, of that length:

1. `npm run build && npm start` → open `http://localhost:3000`. The overview shows three services,
   `rta` with a live dish grid, an annunciator with whatever is currently raised.
2. **RTA:** open the array view. Point at a dish → its temperature, power and movement history. The scan
   canvas shows the last raster and its measured quality.
3. **Alert:** pick a raised alert → the card names the value, the limit from the API, the siblings, the
   suspected cause and the controls that would help, each already filtered by the guards.
4. **Control:** choose a researcher code, issue `set_target` then `start_scan`, and watch the ack move
   `accepted → in_progress → completed` with the scan id. Then issue a command the code is not permitted
   for, and watch it be refused with the reason.
5. **Replay:** open replay, pick the last hour, and find the alert that was just raised at its own
   timestamp, in purple, with `HISTORICAL REPLAY` showing.
6. **Resilience:** `stack.sh down` and reload. The UI says the services are offline, says since when, and
   stays usable. Nothing spins forever.

Six steps, each one or two rubric lines. If a step cannot be performed, that rubric line is not earned,
and the script is therefore also the pre-submission test.

---

## 5. Failure modes

| Failure | Symptom | Handling |
| :--- | :--- | :--- |
| The workspace is not the graded repository | Zero, undetected | §4.4.1; the single unrecoverable item |
| A README command fails | Architecture 0 % band, by the letter of the rubric | §2.1 audit before every push |
| `npm test` claims a suite that does not exist (D-1) | Testing ≤ 25 % and doubt cast on every other command | Write the tests, or label the section planned |
| Two instances edit the same paragraph | Unmergeable formatting conflict | §4.3.1: re-read, append, anchor on existing text |
| Two registers share a letter | D4 vs D-4 confusion in the audit | §4.3.3 convention, stated in both places |
| Planning set unreferenced | 9 300 lines nobody opens | §4.1.2 pointer + §4.2.2 reading paths |
| Secrets in the tree | Security penalty and an actual leak | `.gitignore` plus the §4.4.3 grep |
| Last commit after the final detection | Unmarked work | Push by lunch (§4.4.1) |
| The demo depends on a live lab | Fails if the marker has no podman | The platform must be demonstrable on captured history in replay, with no simulator running |

---

## 6. Test plan

| Test | Asserts |
| :--- | :--- |
| Clean-clone walkthrough | `npm install` → `.env` → `build` → `start` → the UI loads, with no simulator running |
| Command audit | Every fenced command in the README is either executed by `verify` or by a drill, or labelled planned |
| Secrets audit | The grep in §4.4.3 returns only config reads and `.env.example` |
| Register audit | No `D<n>` in a planning document means a decision, and no `D-<n>` in the README means a defect |
| Link audit | Every `Planning Docs/` reference resolves to a file that exists |
| Demo script | The six steps of §4.6 performed end to end, once, before the final push |
| Detection dry run | `git ls-remote` against the graded repository name resolves and its last commit is the one expected |

---

## 7. Definition of done for this document

- The graded repository exists, is private, is named `<student-number>-sdp-exam-2026`, and holds the
  work — by lunch.
- The README's every command succeeds on a clean clone, or is labelled planned in the same sentence.
- The README points at `Planning Docs/00-INDEX-AND-BLUEPRINT.md` and carries the documentation map.
- `00` carries the register convention and the rubric map; `00` lists D-9 and D-10.
- The six-step demonstration has been performed once, without a simulator running, from a clean clone.
- The pre-push checklist has been run before the final push, and the tree passes it.

---

## 8. Open decisions

| # | Decision | Recommendation |
| :--- | :--- | :--- |
| 1 | Write the tests, or label Testing as planned? | Write them. `51` §5 orders them so that two days clears the 75 % band, and the floor claim is at stake |
| 2 | Who owns the README? | One instance, one set of sections each (§4.3.2). Every edit re-reads the file first |
| 3 | Mirror this workspace into the graded repo, or develop in it? | Develop in the graded repo once it exists. A mirror introduces a step that can be forgotten at exactly the wrong moment |
| 4 | Publish the planning set as-is? | Yes. It is reasoning, and the rubric rewards reasoned decisions. Editing it to sound finished would remove the evidence that it found D-9 and D-10 |
| 5 | Should the README list every planning document? | No. Five module rows plus three reading paths. A 31-row table is an index nobody follows |
| 6 | Keep the Progress Log's bug narratives? | Yes. A record of five real defects found by verification is stronger evidence than a claim of correctness |
| 7 | What if the deadline arrives mid-refactor? | The repo is pushed at every working state, so the last commit is always a coherent one. That is the point of the lunch cadence |
| 8 | Does the AI declaration stay? | Yes, completed. It is a submission requirement and an honest one |