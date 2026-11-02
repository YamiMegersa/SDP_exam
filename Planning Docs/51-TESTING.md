# 51 — Testing

**Component.** The test suite that does not yet exist: what is tested, at which layer, with which
fixtures, and the justification of the strategy — including the drill against the real test broker
with controls enabled and simulated faults.

**Owner files (new).** `server/vitest.config.ts`, `server/test/**`, `server/test/fixtures/**`,
`scripts/drill.sh`, `package.json` (scripts), `README.md` (the commands).

**Rubric.** Testing 2.5 % of the exam. Bands: ≤ 25 % "some tests exist and can be run"; ≤ 50 %
"tests cover core logic such as message parsing and alert rules"; ≤ 75 % "tests cover persistence and
integration behaviour and are run from the README"; 100 % *"the testing strategy is justified, e.g.
against the test broker with controls enabled or simulated faults"*.

Note what the 100 % band actually asks for: not coverage, but **justification**, and specifically
testing against the broker with controls enabled or faults injected. A suite of 300 unit tests and
no drill would sit at 75 %.

---

## 1. Boundary and current state

**Current state.** All four layers exist and have been run. `npm test` runs layers 1–3: 141 tests
in 11 files (`alerts`, `api`, `commands`, `config`, `contract`, `derived`, `design`, `ingest`,
`persistence`, `replay`, `topology`) in under 2 s, against fakes, `:memory:` databases and the
committed `preroll` fixtures — none needs a broker. `npm run test:coverage` enforces the §4 threshold
(86 % lines, 86 % functions on the marked modules). Layer 4 is eight drills against the real compose
stack (`52` §4.4, §4.6), all passed and recorded in `52` §4.7. Building layers 3–4 found two
platform bugs and one harness bug, each fixed (§3.6). (The earlier "no test files" state of D-1, and the
layer-1–2-only state after it, are history.)

**In scope.** Unit tests of pure logic, integration tests of routes and the store, contract tests
against recorded simulator payloads, and scripted end-to-end drills.

**Out of scope.** Testing the simulator itself (it is the specification), browser rendering beyond a
handful of pure functions, and coverage as a target.

---

## 2. The layers, and what each one is for

```
        ┌───────────────────────────────────────────────┐
  4     │ Drills: compose + scenarios + controls on     │  8 drills, ~0.5–5 min each
        ├───────────────────────────────────────────────┤
  3     │ Contract: recorded $topology + payloads       │  ~40 cases, milliseconds
        ├───────────────────────────────────────────────┤
  2     │ Integration: supertest + temp SQLite + fake   │  ~60 cases, tens of ms
        │               bus/broker/api                  │
        ├───────────────────────────────────────────────┤
  1     │ Unit: pure functions, fixtures in, values out │  ~150 cases, µs
        └───────────────────────────────────────────────┘
```

### 2.1 Layer 1 — unit

| Target | What is asserted | Why it carries marks |
| :--- | :--- | :--- |
| `classify(topic)` | The five topic families and their parse results, including a malformed topic | Data: "message parsing" is named in the 50 % band |
| `decode(payload)` | Nulls preserved; `0` is not null; unknown keys kept; `v` mismatch tolerated | Data |
| `seq` gap detection | One gap per discontinuity, none for a restart after a `$topology` republish | Architecture |
| `validateControlValue` | Bounds per control per service, from topology alone | Control |
| Guards (RTA/MHE/OPG tables) | Each row of `06` §4.3.2 with a fixture snapshot → the exact reason | Control |
| Alert lifecycle | Allowed/denied transitions, reopen, escalate, `not_acknowledged` | Alert system |
| `AlertContext` assembly | `measured`/`siblings`/`narrative` for every type of all three services | Alerts 100 % |
| Measures | Energy integral, PR model, autonomy, cycles, CO₂ exposure, image quality | Data 100 % |
| `imaging` | Spec pixel formulas, half-pixel centres, out-of-range rejection | Visualisation |
| Model predictions | `merged_model`-style: does the SOC projection reach the reserve within ±15 %? | Data |

Determinism rule: every unit test takes an explicit fixture. **No `Date.now()` inside tested code** —
the `SimClock` is injected (an existing design decision that now pays for itself).

### 2.2 Layer 2 — integration

| Target | Setup | Assertion |
| :--- | :--- | :--- |
| REST routes | `createApp()` + temp SQLite + fake registry | Status, error code, and body shape per `08`'s contract table |
| Command path | Fake `ArlApi` returning scripted verdicts; fake publisher capturing topics | Correct topic, correct payload, verification called with the right service |
| Persistence | Write 10 000 rows, close, reopen | Row count, indexes used, WAL recovered |
| `series()` | 24 h of synthetic samples | Bucket count, stride, first/last values, gap preservation |
| Replay | Two-day capture, a watch, a seek | Chunk k-way merge returns ordered, de-duplicated frames |
| WebSocket | `ws` client against a real server on port 0 | `hello`, frame ordering, coalescing, alert frames never dropped |
| Alert attribution | Ack/resolve through HTTP with a fake API | `ack_verified`/`resolve_verified` and the timestamp ordering |

Every integration test uses a **temp database in `os.tmpdir()`** and deletes it in `afterEach`. No
test touches `data/arl.sqlite`.

### 2.3 Layer 3 — contract (the highest-value layer here)

- **Responsibility.** Pin the platform to the specifications, not to our reading of them.
- **Contract.** `server/test/fixtures/` holds, per service: the real `$topology` document, two or
  three real telemetry payloads per stream, one alert payload per alert type, and the control
  definitions. Generated offline with each binary's `preroll` (fixed seed and start time, no broker,
  no pacing — `52` §4.5.1) and committed as JSON, so the same command reproduces them byte for byte.
- **Steps.** A fixture-driven test iterates every `$topology`:

  ```ts
  for (const svc of ['rta', 'mhe', 'opg']) {
    const topo = loadFixture(`${svc}.topology.json`);
    it(`${svc}: every control validates its documented bounds`, ...);
    it(`${svc}: every alert type has a narrative template`, ...);
    it(`${svc}: every telemetry stream classifies`, ...);
    it(`${svc}: every state item is retained and de-duplicated`, ...);
  }
  ```

- **Acceptance.** Adding a control or alert type to a fixture without implementing its context makes
  the suite fail — which is exactly the guard we want against drift.
- **Refresh procedure.** `npm run fixtures` regenerates them offline (no stack needed; RTA's assets
  are copied once from its image); `npm run fixtures -- --check` exits 1 if a regeneration would
  change any committed file. The diff is a review artefact, so a spec change shows up as a test
  change rather than as a silent rot. Verified: a regeneration is byte-identical.

### 2.4 Layer 4 — drills against the real broker

- **Responsibility.** Satisfy the 100 % band's own wording: *"against the test broker with controls
  enabled or simulated faults"*.
- **Contract.** `npm run drill -- <name>` (`scripts/drill.sh`, specified in `52` §4.4) runs:

  ```
  preflight                      # scenario ids vs fixture topologies; speedup under every ceiling
  simulator env:  ARL_SCENARIO=/scenarios/drill-<name>.toml ARL_SPEEDUP ARL_SEED ARL_START_TIME
  scripts/stack.sh [reset] infra # compose: mosquitto, postgres, api only (recreated)
                                 # waits for API /healthz database: true, broker: true
  platform env:   MQTT_BROKER_ADDRESS=localhost MQTT_BROKER_PORT=1883 (anonymous)
                  ARL_API_ADDRESS=localhost ARL_API_PORT=8080 PORT=3100 DB_PATH=.logs/drills/<id>/
  node server/dist/index.js      # waits for /api/health broker: true — subscribed
  scripts/stack.sh start <svcs>  # the simulators, last: events are not retained
  wait for /api/services         # every service: topology non-null, online: true
  run scripts/drills/<name>.mjs  # named steps: API calls and ordered assertions
  capture, tear down, report pass/fail (--record appends the row to 52 §4.7)
  ```

  The two environments are different on purpose. `ARL_SCENARIO`, `ARL_SPEEDUP`, `ARL_SEED` and
  `ARL_START_TIME` are read by the **simulator** (compose passes them through); the platform never
  reads them. Controls are on by the services' own config (`control_enabled = true`), and compose
  does **not** forward `ARL_CONTROL_ENABLED`, so the negative drill runs a binary with
  `--control-enabled false` instead. The gate is the platform's `/api/services` because
  `/api/health`'s `services` is the configured list, true before any `$topology` has arrived. The
  simulators start after the platform has subscribed because `$topology` and state are retained but
  events are not: started first, the opening minutes' alerts were lost. Each service *refuses* a
  speedup above its ceiling (RTA 50, MHE 2000, OPG 500) — it exits rather than clamping — so a drill
  with RTA in it runs at 50× at most (`52` §4.2.1).

- **The drills:**

| Drill | Scenario | What it proves |
| :--- | :--- | :--- |
| `storm` | `drill-storm.toml` (storm at +20 min for 90 min, nothing else), all three at 50× | One weather cause seen by two services: `rta.wind_stow` engages and releases inside the storm, OPG irradiance collapses and recovers, MHE keeps reporting; the ingest drops nothing and sees no sequence gap. The platform does **not** relate the services (no cause hints were built) |
| `controls-rta` | `drill-rta-scan.toml` (clean), 50× | Six platform refusals that never reach the broker; `set_target` → `start_scan` → raster fills → `completed`; a second scan cancelled mid-run; every ack sequence in legal order |
| `controls-mhe` | `drill-mhe-seal.toml` (clean), 1000× | `seal_room` on an occupied room → CO₂ rises → `air_concentration`; unseal and CO₂ falls; `crew_wellness_check` completes |
| `controls-opg` | `drill-opg-reserve.toml` (`batteries set_state soc_pct 25`), 200× | `low_battery` → `supply_shortfall` → generator auto-start and `backup_active`, shortfall clears; a manual `stop_generator` and the 30 minutes after it; `battery_reserve 30` applied |
| `faults` | `drill-faults.toml` (`dish-042 overheat`, `dish-017 comms_loss` + `repair`, MHE `heater_fault`, `ventilation_fault`), RTA and MHE at 50× | Raise → escalate → clear as one alert id; the operator lifecycle with every refusal (`403`, `409`, `400`) and the exact audit trail; MHE alerts on the faulted rooms. MHE incident grouping and futile-control suppression are not built and not asserted |
| `replay` | a copy of the newest `faults` database; no lab | Frames equal the stored rows exactly, in order; alert events at their own `ts`, never behind the cursor; forward and backward seeks |
| `reconcile` | none; `reset` first, all three at 50× | Per stream, entity and simulated minute, the store's row count equals the API backlog's — zero mismatches; alert events agree |
| `controls-disabled` | clean; `bin/arl-opg --control-enabled false` in place of compose `opg` | All six OPG controls settle `rejected / controls_disabled`, recorded as such; OPG stays online |

The authoritative list, speedups and scenario contents are `52` §4.2.1, §4.3.3 and §4.6; this table
must agree with them.

- **Acceptance.** Every drill is deterministic enough to run twice and produce the same assertions;
  where timing is involved the assertion is on ordering, not on milliseconds. **Status:** all eight
  passed with `--record` (`52` §4.7); the full set takes ~12.5 min of wall time (`52` §4.8), and
  `controls-rta` passed on consecutive runs.

---

## 3. The strategy, justified

The rubric asks for justification rather than volume. The reasoning:

1. **Most of this platform's risk is in interpretation, not in code volume.** The hardest failures
   are a mis-parsed alert field, a guard that disagrees with the spec, or a measure that is subtly
   wrong — none of which a UI test finds. Hence layer 3 exists and is prioritised above layer 4's
   breadth.
2. **The services are the specification, so they are also the oracle.** Fixtures come from the
   simulator, not from hand-written JSON. A test that passes against a fixture is a test that passes
   against the lab.
3. **Two clocks make naive e2e tests flaky.** Any assertion on wall-clock timing at 2000× is a coin
   flip. End-to-end drills therefore assert *ordering and state transitions*, and the timing-sensitive
   logic is unit-tested with an injected clock instead.
4. **Controls must be tested with controls enabled — and disabled.** A suite that only reads
   telemetry can never prove the Control criterion, so every control drill issues real commands to
   the real services and asserts on their acks. The shipped configs set `control_enabled = true`;
   the one drill that needs it off (`controls-disabled`) runs a binary with `--control-enabled false`,
   because compose does not forward `ARL_CONTROL_ENABLED`. A deployment that rejects commands must
   then be *visible* as `rejected / controls_disabled`, not as a silent failure.
5. **Faults must be tested with faults, not with mocks.** The simulator's scenario files inject the
   exact faults the rubric mentions. `scenarios/example.toml` encodes them all at once; the drills use
   one-concern files (`drill-storm.toml`, `drill-faults.toml`, …) so a failing assertion names one
   cause. That is cheaper and more credible than faking alert events in unit tests (which we also
   do, for breadth).
6. **The upper layers earn their cost by finding what the lower ones cannot.** Building them found
   two platform bugs that 103 unit and integration tests had passed over, each now pinned by a
   lower-layer test, and one harness bug:
   - `controls-rta`: the ingest keyed sequence numbers by service and stream but not entity, so all
     100 dishes shared one counter and interleaved frames looked like gaps. Now keyed per entity and
     stream (`ingest.test.ts`).
   - The command-path tests (§5 item 6): an expired command was broadcast with its pre-expiry
     `queued` row, so a browser kept a spinner on a command that was over. `expireCommands` now
     returns the rows as updated (`commands.test.ts`).
   - Drill ordering: starting the simulators before the platform subscribed lost the opening
     minutes' alerts, because events are not retained. A harness bug rather than a platform one;
     it reordered `52` §4.4.

   The drills also corrected the documents: the speedup ceiling is a refusal, not a clamp (`faults`
   at 1000×), and several promised behaviours — cross-service cause hints, MHE incident grouping,
   futile-control suppression — were never built; the drill tables now say so instead of asserting
   them.

What is deliberately not done: coverage targets on `pages/`, snapshot tests of charts, and mocking
the MQTT client in integration tests (the fake broker emits recorded bytes instead, so the decode
path is exercised for real).

---

## 4. Configuration and commands

```ts
// server/vitest.config.ts
test: {
  include: ['test/**/*.test.ts'],
  environment: 'node',
  testTimeout: 15_000,
  hookTimeout: 15_000,
  coverage: {
    provider: 'v8',
    include: ['src/alerts/**', 'src/topology/**', 'src/db/**', 'src/mqtt/**', 'src/commands/**'],
    reporter: ['text-summary', 'text'],
    reportsDirectory: '../.logs/coverage',
    thresholds: { lines: 80, functions: 80 },
  },
}
```

The suite runs on vitest's default pool. An earlier draft prescribed `pool: 'forks'` with a single
fork against sandboxes that block worker IPC; it was never needed here, so it is not configured. If
a sandbox does hang the suite, `npx vitest run --pool=forks` is the fallback (§6).

| Command | Does |
| :--- | :--- |
| `npm test` | `vitest run` (layers 1–3), no broker needed |
| `npm --workspace server run test:watch` | Watch mode while developing |
| `npm run test:coverage` | Coverage with the thresholds above; report in `.logs/coverage/` |
| `npm run typecheck` | `tsc --noEmit` in both workspaces |
| `npm run verify` | `typecheck && test && build` — the one command the README promises |
| `npm run fixtures` | Regenerate the contract fixtures offline with `preroll`; `-- --check` fails on any change |
| `scripts/stack.sh up` / `down` | The lab by hand (`52` §4.1); a drill manages its own |
| `npm run drill -- storm` | Layer 4 against the real broker (`--keep`, `--record`, `--seed N`) |
| `npm run drill -- all` | Every drill in sequence, with a summary table |

The coverage threshold covers only the modules that carry marks — alert rules, topology, store,
ingest and command path. A global threshold would be met by untested JSX and would mean nothing.
The first measurement was 77.5 % lines, under the threshold, because the command path had no tests
at all; §5 item 6 (`commands.test.ts`, 15 tests) brought it to 86 %.

---

## 5. What the first 30 tests should be

If time is short, this order buys the most marks per hour:

1. `decode`/`classify` (5 tests) — the 50 % band's own words.
2. Alert lifecycle transitions (6) — the alert-system rubric.
3. Guard tables, one test per row (8) — Control.
4. One contract test per service `$topology` (3) — catches drift.
5. `series()` bucketing and gap preservation (3) — persistence band.
6. Command path with a fake API (3) — security band (per-service verification).
7. One drill: `controls-rta` (1) — the end-to-end evidence.

That is roughly two days of work and it clears the 75 % band with evidence.

---

## 6. Failure modes

| Failure | Symptom | Handling |
| :--- | :--- | :--- |
| Tests depend on a running broker | Suite fails on a clean checkout | Layers 1–3 use fakes; only drills need the stack |
| Fixtures drift from the simulator | Contract tests pass while the platform is wrong | `npm run fixtures` and review the diff; the fixture refresh is part of the release checklist |
| Port collisions in integration tests | Flaky failures | Bind port 0 and read the assigned port |
| Temp DB left behind | Disk growth | `afterEach` removal; a `test/tmp` directory that is gitignored |
| Timing assertions at 2000× | Flaky | Assert ordering and state, never wall durations |
| Sandbox blocks worker IPC | `npm test` hangs | Not seen here; `npx vitest run --pool=forks` is the fallback (§4) |
| Suite too slow to run often | Nobody runs it | Budget: layers 1–3 under 20 s total (measured: under 2 s) |

---

## 7. Definition of done for this document

- `npm test` passes on a clean checkout with no broker running. **Done** (141 tests).
- `npm run verify` passes and is the command in the README. **Done.**
- At least one drill per service has been run and its result recorded in `52`. **Done** — all eight.
- The 30 tests in §5 exist and the coverage threshold is enforced on the marked modules. **Done**
  (86 % lines and functions against a threshold of 80).

---

## 8. Open decisions

| # | Decision | Recommendation |
| :--- | :--- | :--- |
| 1 | Front-end tests | Only pure functions (`imaging`, `format`, `catalogue`); no component tests. The UI marks come from design, not from test coverage |
| 2 | Should the drill run in CI? | Yes if a runner supports podman; otherwise document it as a manual gate and record the last run |
| 3 | Fixture size | Keep each under 50 kB; a fixture larger than that is a capture, not a contract |
| 4 | Recorded fixtures vs generated payloads | Recorded. Hand-written payloads test our assumptions, which is precisely the thing that is wrong when tests are needed |
| 5 | Coverage gate on new modules | Yes — a new module under the marked paths starts at 80 % or the build fails, which is how the threshold stays meaningful |