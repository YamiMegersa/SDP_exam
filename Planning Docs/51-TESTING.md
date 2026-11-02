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

**Current state (D-1).** `vitest` 2.1.8 and `supertest` 7 are installed, `server/package.json` has
`test: vitest run`, the root has `test: npm --workspace server run test`, and the README tells the
reader to run `npm test`. There are **no test files**, so `npm test` currently fails with "no test
files found" — the worst possible state, because it looks like a suite exists.

**In scope.** Unit tests of pure logic, integration tests of routes and the store, contract tests
against recorded simulator payloads, and scripted end-to-end drills.

**Out of scope.** Testing the simulator itself (it is the specification), browser rendering beyond a
handful of pure functions, and coverage as a target.

---

## 2. The layers, and what each one is for

```
        ┌───────────────────────────────────────────────┐
  4     │ Drills: compose + scenarios + controls on     │  4–6 runs, minutes each
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
  definitions. Captured once with `ARL_SPEEDUP=1` from the test broker and committed as JSON.
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
- **Refresh procedure.** `npm run fixtures` re-records against the running stack; the diff is a
  review artefact, so a spec change shows up as a test change rather than as a silent rot.

### 2.4 Layer 4 — drills against the real broker

- **Responsibility.** Satisfy the 100 % band's own wording: *"against the test broker with controls
  enabled or simulated faults"*.
- **Contract.** `npm run drill -- <name>` runs:

  ```
  podman-compose -f Services/arl-sim/arl-test.yaml up -d
  wait for /healthz and the three $topology documents
  start the platform with ARL_CONTROL_ENABLED=true and ARL_SCENARIO=...
  run the drill script (a sequence of API calls and assertions)
  tear down and report pass/fail
  ```

- **The drills:**

| Drill | Scenario | What it proves |
| :--- | :--- | :--- |
| `storm` | `scenarios/example.toml` (storm at +30 min, heatwave, `dish-042` overheat) | Cross-service alerts, co-occurring relations, replay of the window, load/carbon response |
| `controls-rta` | clean, `ARL_SPEEDUP=50` | `set_target` → `start_scan` → image fills → `cancel_scan`; each ack state observed |
| `controls-mhe` | clean, `ARL_SPEEDUP=2000` | `seal_room` on an occupied room → CO₂ rises → `air_concentration`; `crew_wellness_check` completes |
| `controls-opg` | `batteries set_state soc_pct 25` | `low_battery` → reserve → generator auto-start → `backup_active`; a manual stop and its shortfall |
| `faults` | `dish-042 overheat`, `ventilation_fault`, `inverter_fault` | Alert context, cascade, and suppression of futile controls |
| `replay` | any of the above after the fact | Alerts and events inside the replay at the cursor |

- **Acceptance.** Every drill is deterministic enough to run twice and produce the same assertions;
  where timing is involved the assertion is on ordering, not on milliseconds.

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
4. **Controls must be tested with controls enabled.** The simulator rejects commands by default in
   some deployments; a suite that only reads telemetry can never prove the Control criterion. Hence
   `ARL_CONTROL_ENABLED=true` in every drill.
5. **Faults must be tested with faults, not with mocks.** `scenarios/example.toml` already encodes
   the exact faults the rubric mentions; using it is both cheaper and more credible than faking
   alert events in unit tests (which we also do, for breadth).

What is deliberately not done: coverage targets on `pages/`, snapshot tests of charts, and mocking
the MQTT client in integration tests (the fake broker emits recorded bytes instead, so the decode
path is exercised for real).

---

## 4. Configuration and commands

```jsonc
// server/vitest.config.ts
{
  "test": {
    "include": ["test/**/*.test.ts"],
    "environment": "node",
    "pool": "forks",
    "poolOptions": { "forks": { "singleFork": true } },
    "coverage": {
      "provider": "v8",
      "include": ["src/alerts/**", "src/topology/**", "src/db/**", "src/mqtt/**", "src/commands/**"],
      "thresholds": { "lines": 80, "functions": 80 }
    }
  }
}
```

`pool: 'forks'` with a single fork is deliberate: worker threads and some sandboxed environments
fail to open their IPC sockets, and a suite that cannot run is worth nothing. It costs a little
speed and buys reliability.

| Command | Does |
| :--- | :--- |
| `npm test` | `vitest run` (layers 1–3) |
| `npm run test:watch` | Watch mode while developing |
| `npm run test:coverage` | Coverage with the thresholds above |
| `npm run typecheck` | `tsc --noEmit` in both workspaces |
| `npm run verify` | `typecheck && test && build` — the one command the README promises |
| `npm run fixtures` | Re-record contract fixtures against the running stack |
| `npm run drill -- storm` | Layer 4 against the real broker |
| `npm run drill -- all` | Every drill in sequence, with a summary table |

The coverage threshold covers only the modules that carry marks — alert rules, topology, store,
ingest and command path. A global threshold would be met by untested JSX and would mean nothing.

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
| Sandbox blocks worker IPC | `npm test` hangs | `pool: 'forks'`, `singleFork: true` |
| Suite too slow to run often | Nobody runs it | Budget: layers 1–3 under 20 s total |

---

## 7. Definition of done for this document

- `npm test` passes on a clean checkout with no broker running.
- `npm run verify` passes and is the command in the README.
- At least one drill per service has been run and its result recorded in `52`.
- The 30 tests in §5 exist and the coverage threshold is enforced on the marked modules.

---

## 8. Open decisions

| # | Decision | Recommendation |
| :--- | :--- | :--- |
| 1 | Front-end tests | Only pure functions (`imaging`, `format`, `catalogue`); no component tests. The UI marks come from design, not from test coverage |
| 2 | Should the drill run in CI? | Yes if a runner supports podman; otherwise document it as a manual gate and record the last run |
| 3 | Fixture size | Keep each under 50 kB; a fixture larger than that is a capture, not a contract |
| 4 | Recorded fixtures vs generated payloads | Recorded. Hand-written payloads test our assumptions, which is precisely the thing that is wrong when tests are needed |
| 5 | Coverage gate on new modules | Yes — a new module under the marked paths starts at 80 % or the build fails, which is how the threshold stays meaningful |