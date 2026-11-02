# 52 — Simulator Harness

**Component.** The apparatus that runs the lab: bringing a known stack up, perturbing it
deterministically, recording what happened, and keeping the evidence. This is what turns the
Testing 100 % band's wording — *"against the test broker with controls enabled or simulated
faults"* — from a claim into a command someone else can run.

**Owner files (new).** `scripts/stack.sh`, `scripts/drill.sh`, `scripts/drills/*.mjs`,
`scripts/fixtures.mjs`, `scenarios/*.toml` (our drills, alongside the supplied `example.toml`),
`.gitignore` (drill artefacts), `README.md` (the harness section).

**Rubric.** Testing 2.5 % directly; Architecture 100 % indirectly, because "handles the data rates
and failures with reasoned decisions" can only be demonstrated against real rates and real failures.
It is also how the Data, Control and Alerts criteria of three services are evidenced rather than
asserted.

**Depends on.** `51` (the drill layer this executes), `01` (configuration), `02` (ingest), `04`/`11`
(the store and derived series), `50` (no secrets in the harness), and the six service documents.

---

## 1. Boundary

The simulator is the lab. **This is the rig**, not the lab. Three jobs and no others:

1. **Bring up a known state.** Idempotent, health-gated, and identical on a second machine.
2. **Perturb it deterministically.** Weather and faults through scenario files; controls through the
   platform's own REST API, so the command path is exercised rather than bypassed.
3. **Record what happened.** Fixtures, drill results, and the artefacts needed to reproduce a
   failure.

In scope: process orchestration, environment matrices, scenario authoring, fixture capture, the
drill catalogue, the results log.

Out of scope, deliberately:

| Not done | Why |
| :--- | :--- |
| Modifying the simulator, its images or its compose file | It is the specification. A harness that patches its own oracle is not evidence |
| Adding containers to `Services/arl-sim/arl-test.yaml` | The file is upstream and read-only in spirit; all configuration goes through documented environment variables and scenario files |
| Publishing faults directly to MQTT | That would test our own dictionary. Faults come from the service that owns them |
| Using the ARL API's write endpoints | `50` §4.4: the platform's posture toward the lab is read-only, and the harness must not normalise something the platform forbids itself |
| Running the lab in CI unconditionally | `51` §8; the drills are a documented gate with a recorded result, not a per-commit job |

---

## 2. Current foundation

The bundle is present and complete at `Services/arl-sim/`:

```
arl-test.yaml          the compose file, preconfigured
config/                api.toml, rta.toml, mhe.toml, opg.toml, lwm.toml, owt.toml
scenarios/             example.toml — the only scenario supplied
mosquitto/             mosquitto.conf
images/                six .tar images: arl-{api,rta,mhe,lwm,opg,owt}.tar
bin/                   six static Linux x86_64 binaries
```

What is established, from the bundle itself:

- **The compose file gates health.** Every service `depends_on` the broker and `api` with
  `condition: service_healthy`, mounts `./config:/config:ro` and `./scenarios:/scenarios:ro`, and
  runs with `read_only: true` and `tmpfs: [/tmp]`. The stack cannot come up half-ready.
- **Controls are enabled in this deployment.** `config/*.toml` all carry `control_enabled = true`, and
  `Running the ARL` §3.3 confirms: *"Controls are enabled in your local copy."*
- **The broker is anonymous** (`allow_anonymous true`, no persistence) on `localhost:1883`. The API
  is on `localhost:8080` with Swagger at `/docs`.
- **Reads need no credential.** The API specification states *"Authentication: None for reads"*, and
  every endpoint the platform uses (`/v1/researchers/verify`, `/v1/alert-limits/...`,
  `/v1/backlog/...`) is a read. `ARL_SERVICE_TOKEN: test-service-token` in the compose is for the
  services' own calls, not for the platform.
- **The API records everything anyway.** `record = true`, `retention_days = 75`, serving telemetry,
  state and events (never commands or acks) as CSV, up to 7 days per request — an independent second
  copy of the truth, which §4.5.3 exploits.
- **Six deterministic inputs.** `ARL_SEED`, `ARL_START_TIME`, `ARL_SCENARIO`, `ARL_SPEEDUP`,
  `control_enabled`, and the command sequence. Everything else is derived.

What is **not** there: no script of any kind, no drill scenarios, no fixture capture, no results log,
and no mention of the simulator in the repository README at all.

**Environment reality on this machine.** Docker is not installed; `podman-compose` 1.0.6 is. Every
command in `Services/arl-sim/README.md` and `Running the ARL` must be translated:

| Upstream says | Here |
| :--- | :--- |
| `docker load -i images/x.tar` | `podman load -i Services/arl-sim/images/x.tar` |
| `docker compose -f arl-test.yaml up -d` | `podman-compose -f Services/arl-sim/arl-test.yaml up -d` |
| `docker compose ... down -v` | `podman-compose ... down -v` |
| `docker cp arl-files:/assets` | `podman cp arl-files:/assets` |

The harness hides that difference behind one script so that nobody has to remember it.

---

## 3. Gaps

| Gap | Rubric effect | Fix |
| :--- | :--- | :--- |
| No script to start the stack; the README's commands are Docker-only | A marker cannot run the evidence, so the 100 % band is unearned | §4.1 `scripts/stack.sh` |
| No readiness gate beyond `up -d` | Drills race the first `$topology` and fail intermittently | §4.4: wait on `/api/health`'s `services` |
| One scenario file, and it is a demonstration rather than a drill | Faults are present but nothing asserts on them | §4.3/§4.6: a scenario per drill, with the fault chosen to produce the exact alert under test |
| No fixture capture | Contract tests in `51` §2.3 have no source | §4.5: three capture paths |
| No record of a run | "We tested it" with nothing behind it | §4.7: an append-only results log |
| Speedup treated as one global number | Two services at different multipliers live in different simulated eras, so cross-service work is silently meaningless | §4.2.1: the speedup rule |
| No reconciliation against the API backlog | The store could lose rows and no test would notice | §4.6 drill `reconcile` |
| Nobody knows the cost of a drill | Drills get skipped as "too slow" | §4.8: measured budget per drill |

---

## 4. Decomposition

### 4.1 The stack

`scripts/stack.sh <up|down|reset|ps|logs|status> [services...]`

#### 4.1.1 `up`

- **Responsibility.** One command from a cold checkout to a working lab.
- **Contract.** `stack.sh up` — loads any missing images, then
  `podman-compose -f Services/arl-sim/arl-test.yaml up -d mosquitto api rta mhe opg`, then waits for
  readiness. Idempotent: a second `up` changes nothing and returns fast.
- **Steps.**
  1. Preflight: `podman` and `podman-compose` on `PATH`; ports 1883 and 8080 free (a stale process is
     reported by name, not killed).
  2. `podman image exists arl/api:0.1.0` per service; load from `images/*.tar` only what is missing —
     loading six images unconditionally costs minutes on every invocation.
  3. Compose up. Only the three services we chose plus the broker and API: `lwm` and `owt` stay down
     unless a drill asks for them, which halves the message rate and the log noise.
  4. Wait for the API's own health, then for the platform's (§4.4 step 4).
- **Acceptance.** On a machine with the images already loaded, `stack.sh up` returns in under 30 s and
  `stack.sh status` reports the API `ok` with `database: true` and `broker: true`.

#### 4.1.2 `reset` is not `restart`

- `down` keeps the Postgres volume, so the backlog and the seeded researchers survive.
- `reset` is `down -v`: the volume is deleted and the seed directory is loaded again on the next
  start. It is the only way to get a pristine researcher register, and it destroys the backlog — so
  `reset` is **never** part of an ordinary drill, only of a drill that needs a fresh catalogue.
- `read_only: true` means a container cannot be edited in place. A configuration change is a file
  edit plus `restart <svc>`; `up -d` alone does not re-read it and is the most common wasted hour.

#### 4.1.3 Ports

| Port | Who | Visible from the host |
| :--- | :--- | :--- |
| 1883 | Mosquitto | yes (published) |
| 8080 | ARL API (`/docs`, `/healthz`, `/v1/...`) | yes (published) |
| 9100 | each service's own `/healthz` | **no** — internal to its container |
| 3000/4000 | the platform (HTTP and WS are the same port) | yes |

The absence of a published 9100 matters: `stack.sh status` reports service health from
`podman-compose ps` and from the platform's `/api/health`, never by curling a port that is not there.

### 4.2 The environment matrix

| Variable | Default | Values we use | Note |
| :--- | :--- | :--- | :--- |
| `ARL_SEED` | 1 | 1 for every drill; 2–7 only to prove a fault is not seed-specific | The seed alone is not determinism — see §4.3.4 |
| `ARL_SPEEDUP` | 1 | 1, 10, 50, 500, 2000 | Clamped per service: RTA 50, MHE 2000, LWM/OPG/OWT 500 |
| `ARL_START_TIME` | `now` | `now` for smoke drills; a fixed RFC 3339 time for anything compared or replayed | An absolute start time is what makes "the storm begins at 14:30" true |
| `ARL_SCENARIO` | none | `/scenarios/<drill>.toml` | A path **inside the container**; the host folder is mounted at `/scenarios` |
| `ARL_CONTROL_ENABLED` | from config (`true`) | `false` for the negative drill only | Proves the `controls_disabled` reason is real and not a mock |
| `MQTT_BROKER_ADDRESS` / `ARL_API_ADDRESS` | `mosquitto` / `api` (in-container) | `localhost` for the host-side platform | The platform is not in the compose file |
| `HEALTH_PORT` | 9100 | one per binary when running several | Binary mode only |

#### 4.2.1 The speedup rule (a real trap)

`ARL_SPEEDUP` applies to every service in the compose file, but each service has its own ceiling.
`ARL_SPEEDUP=2000` gives MHE 2000× and RTA 50× (its `max_speedup`), so after one real hour MHE is 80
mission days in and RTA is 2.7 simulated hours in. Any cross-service relation — a storm that stows
the dishes *and* darkens the solar array *and* drives the habitat into load shedding — is then
comparing three different epochs.

The rule, therefore:

| Drill kind | Speedup | Reason |
| :--- | :--- | :--- |
| Cross-service (`storm`, `replay`, `reconcile`) | **1** | All three services must share one clock. Slower, but the only honest setting |
| Single-service, RTA (`controls-rta`, `faults` on a dish) | 10–50 | RTA's own ceiling is 50; a 9-minute scan finishes in ~11 s |
| Single-service, MHE (`controls-mhe`) | 500–2000 | The 30-minute temperature approach is the point; at 1× it would take half an hour of wall time |
| Single-service, OPG (`controls-opg`) | 100–500 | A night drain and a generator start are visible inside a minute |

The harness encodes this per drill rather than taking it from the shell, and `stack.sh` prints the
effective multiplier per service at start.

### 4.3 Scenarios

A scenario is a TOML file of timed events. Every service reads the same file and applies what is
addressed to it, so one file drives all three; `service = "env"` events change shared weather and are
seen by everyone.

```toml
[[event]]
at = "+00:30:00"          # offset from ARL_START_TIME (+HH:MM:SS, hours may exceed 24)
                          # or an absolute RFC 3339 time
service = "env"           # env | rta | mhe | lwm | opg | owt
fault = "storm"           # what happens
duration = "01:30:00"     # optional; without it the fault lasts until repair or the matching control
params = { gust_ms = 26.0, speed_ms = 8.0, rain_mm_h = 30.0 }
```

#### 4.3.1 The catalogue (authoritative, from the specifications)

**Weather — `service = "env"`, shared by all services**

| Fault | Params (default) | Effect |
| :--- | :--- | :--- |
| `storm` | `gust_ms` 24, `speed_ms` 10 (2–30), `rain_mm_h` 30 (0–100) | Thunderstorm arriving at `at`: lightning, heavy rain, gusts up to `gust_ms` |
| `dust` | none | Stronger wind, less sunshine, faster soiling of solar surfaces |
| `heatwave` | `delta_k` 10 K | Raises air temperature by `delta_k` |
| `cold_snap` | `delta_k` −10 K | Lowers air temperature by `delta_k` |
| `clear_sky` | none | No cloud and no storms |

**RTA — entity is a dish id**

| Fault | Params (default) | Effect | Produces |
| :--- | :--- | :--- | :--- |
| `overheat` | `peak_k` 345, `recover_after` | The dish heats towards `peak_k` | `dish_temperature`, `dish_movement` |
| `drive_stall` | `recover_after` | Drive stops, slews fail | `dish_movement` |
| `receiver_fault` | `recover_after` | Receiver misbehaves, scan data poor | `dish_scan` |
| `power_fault` | `peak_w` 7000, `recover_after` | Draw rises, then the dish goes offline | `dish_power`, `dish_offline` |
| `comms_loss` | `recover_after` | The dish stops reporting | `dish_offline` |
| `encoder_error` | `recover_after` | Fault code `encoder_error`, dish stays in service | `dish_calibration` |
| `recalibrate` | none | A technician calibrates it (all dishes if no entity) | clears `dish_calibration` |
| `repair` | none | Ends the dish's faults | — |

Most RTA faults accept `recover_after` (an `HH:MM:SS` or seconds) as an alternative to `duration`.

**MHE — entity is a room id or a crew id**

| Fault | Entity | Params | Effect | Produces |
| :--- | :--- | :--- | :--- | :--- |
| `ventilation_fault` | room | none | Ventilation stops; CO₂ builds if occupied | `air_concentration` |
| `heater_fault` | room | none | Temperature drifts down | `room_condition`, `habitat_fault` |
| `sensor_drift` | room | `quantity` (`temperature`/`humidity`), `rate` 0.2/h | The reading drifts away from the truth | `room_condition` (a lie, not a fault) |
| `hydroponics_pump_fault` | none | none | Irrigation stops | `habitat_fault` (hydroponics) |
| `airlock_door_fault` | none | none | Door reports open when it should not | `habitat_fault` (airlock); clears on cycling or repair |
| `subsystem` | none | `subsystem`, `status` | Forces a subsystem's status | `habitat_fault` |
| `lab_equipment` | none | `status` | Sets the lab equipment status | `habitat_fault` |
| `wearable_offline` | crew | none | Vitals stop | `crew_status` (`wearable_offline`) |
| `crew_illness` | crew | `fever_k` 1.5 | Fever and raised heart rate | `crew_health` |
| `skip_survey` | crew | none | Skips the next survey | `survey_missed` |
| `wellbeing_drop` | crew | `delta` 0.3 | Surveys score worse | `survey_wellbeing` |
| `repair` | room or crew | none | Ends the faults on it | — |

**OPG — entity is `solar`, `batteries` or `diesel`**

| Fault | Entity | Params | Effect | Produces |
| :--- | :--- | :--- | :--- | :--- |
| `inverter_fault` | `solar` | none | No solar output | `solar_underperformance` |
| `string_failure` | `solar` | none | Part of the array down | `solar_underperformance` |
| `battery_cell_fault` | `batteries` | none | Bank heats, some health lost | `battery_temperature` |
| `generator_fail_start` | `diesel` | none | The next start fails | `generator_fault` |
| `generator_trip` | `diesel` | none | Running generators fail | `generator_fault` |
| `fuel_leak` | `diesel` | none | Fuel falls until the next refuel | `low_fuel` |
| `set_state` | any | `soc_pct`, `fuel_pct` | Sets SOC and/or fuel directly | whatever follows from it |
| `soiling` | `solar` | `ratio` | Sets panel cleanliness; rain cleans them | `solar_underperformance` |
| `repair` | `solar`/`batteries`/`diesel` | none | Ends that entity's faults | — |

#### 4.3.2 Authoring rules

| Rule | Consequence of breaking it |
| :--- | :--- |
| The entity id must exist (`dish-042`, `crew-3`, `quarters-3`) | An unknown id is ignored without error; the drill then "passes" because nothing happened. Validated against the live `$topology` before the run |
| Offsets are from `ARL_START_TIME`, and hours may exceed 24 | `+26:00:00` is legal and is how a two-day drill is written |
| No `duration` means *until repaired* | A forgotten duration poisons every later drill in the same run. The validator requires either `duration`, `recover_after`, or an explicit later `repair` |
| `set_state` is instantaneous and is not a fault | There is no "unset": restore with a second `set_state`, and expect the SOC to move freely afterwards |
| While an event is active on an entity, the service's own random faults on that entity are paused | This is what makes a drill deterministic — the scenario *owns* the entity — and is why drills use scenarios instead of waiting for randomness |
| Weather is global | A `clear_sky` in one drill removes the cloud a solar drill needs. Each drill loads exactly one scenario |
| A scenario change needs a restart | `restart <svc>`, not `up -d`. Events are timed from the start, so a restart replays the whole file |
| The path must exist inside the container | `/scenarios/x.toml`, and the file must be in `Services/arl-sim/scenarios/`. A wrong path is not always diagnosed by the service |

#### 4.3.3 Our scenario files

Supplied: `scenarios/example.toml` (storm at +30 min, heatwave at +3 h, `dish-042` overheat, LWM
comms loss, MHE ventilation failure, OPG SOC to 25 %, OWT pump failure). It is a demonstration of
everything at once, and as a drill it is crowded — six alerts across two services at once is a test
of the annunciator, not of a rule.

Added alongside it, one concern each:

| File | Contents | Used by |
| :--- | :--- | :--- |
| `drill-storm.toml` | `storm` at +20 min for 90 min, nothing else | `storm` — all three services, one cause |
| `drill-rta-faults.toml` | `dish-042 overheat` (peak 345 K), `dish-017 comms_loss`, `recalibrate dish-017` at +25 min | `faults` — two fault classes and a clearing |
| `drill-rta-scan.toml` | empty (clean sky, no faults) | `controls-rta` — a scan with nothing else in the picture |
| `drill-mhe-seal.toml` | empty; the drill seals a room by control | `controls-mhe` — the sealed-room CO₂ rise must be caused by the command, not by a fault |
| `drill-mhe-cascade.toml` | `ventilation_fault common` at +5 min, `crew_illness crew-3` at +40 min | `faults` — the §6 incident grouping in `33` |
| `drill-opg-reserve.toml` | `set_state batteries soc_pct 25` at +2 min | `controls-opg` — reserve, generator start, `backup_active` |
| `drill-opg-fuel.toml` | `fuel_leak diesel` at +5 min | `low_fuel` projection arithmetic |
| `drill-degraded.toml` | `inverter_fault solar` and `generator_fail_start diesel` at +10 min | the OPG unrecoverable path: `solar_underperformance` + `generator_fault` together |

#### 4.3.4 What determinism actually requires

The same data requires the same **seed, start time, scenario and command sequence**. A replay of a
drill that differs only in when the operator clicked will diverge. So each drill records all four
(§4.8), and any drill that issues controls declares them in a fixed order with fixed values — no
"click until it works".

### 4.4 The drill runner

`scripts/drill.sh <name> [--keep] [--seed N] [--from-json]`

- **Responsibility.** One command per drill, from cold to a verdict, with artefacts on failure.
- **Contract.** Exit 0 = every assertion held. Exit non-zero with the failing step named. `--keep`
  leaves the stack and the platform running for inspection.

**Steps.**

1. **Preflight.** Scenario file exists in the mount; its entity ids all appear in the last recorded
   `$topology` (`npm run fixtures` cache), so an ignored event cannot be mistaken for a passing test.
2. **Up.** `stack.sh up` with the drill's environment (§4.2). `reset` only where declared.
3. **Readiness.** Poll `GET localhost:8080/healthz` until `database` and `broker` are both true.
4. **Topologies.** Poll the platform's `GET /api/health` until `services` contains `rta`, `mhe`,
   `opg`. This is the real gate: it proves the retained `$topology` reached *us*, which is the first
   thing a drill needs and the last thing `up -d` guarantees.
5. **Platform up.** `npm run build && npm start` with `ARL_SERVICES=rta,mhe,opg`,
   `ARL_CONTROL_ENABLED` as needed, a **fresh** `DB_PATH` per drill (`.logs/drills/<id>/arl.sqlite`),
   and no touches to `data/arl.sqlite`.
6. **Run the assertion script.** `scripts/drills/<name>.mjs`, a list of named steps, each returning
   pass/fail with the values it compared. Assertions are on **ordering and state transitions**, never
   on wall-clock durations (`51` §3.3).
7. **Capture and tear down.** Logs, the alert table, the command table and the query set go into
   `.logs/drills/<id>/` (gitignored). Teardown unless `--keep`.

**Acceptance.** `scripts/drill.sh controls-rta` passes twice in a row on a machine with the images
already loaded, and a deliberately broken assertion fails with the step named and the artefact
directory printed.

### 4.5 Fixtures

Three capture paths, each for a different job.

#### 4.5.1 `run --ndjson` — offline, deterministic, cheap

Each binary accepts `run --ndjson <file>`: it writes every message it would have published to a
newline-delimited JSON file and publishes nothing. Combined with a fixed seed, start time and
scenario, this produces the contract fixtures of `51` §2.3 **without a broker at all**:

```
./bin/arl-rta --config config/rta.toml --seed 1 \
  --start-time 2027-03-02T00:00:00Z --scenario scenarios/drill-storm.toml \
  run --ndjson /tmp/rta.ndjson
```

- **Steps.** Run each service for a bounded simulated window, then slice: keep the retained
  `$topology`, two or three telemetry frames per stream with at least one containing a `null`, one
  alert payload per type that the window produced, and the control definitions.
- **Acceptance.** Each fixture under 50 kB (`51` §8), committed as JSON, and a fixture re-generated
  from the same seed is byte-identical.
- **Decision.** This is the primary path. It makes contract tests runnable on a machine with no
  containers, which is the difference between a suite that runs and one that does not.

#### 4.5.2 Broker tap — what the wire really carried

A short subscriber on `arl/#` recording raw bytes for the duration of a drill. Used when the question
is not "what does a payload look like" but "did our decode survive what was actually published" —
retained-message timing, QoS 1 duplicates, out-of-order arrival.

- **Acceptance.** The taps from two runs of the same drill at 1× contain the same message set.

#### 4.5.3 The API backlog — the independent record

`GET /v1/backlog/{service}/streams` reports what the API recorded (streams, items, event kinds,
`earliest_ts`, `latest_ts`); `GET /v1/backlog/{service}.csv?kind=...&stream=...&from=...&to=...`
downloads it. Since the API records independently of us, this is the only way to prove we did not
lose rows. It is the basis of the `reconcile` drill (§4.6).

### 4.6 The drill catalogue

| Drill | Command | Scenario | What it proves |
| :--- | :--- | :--- | :--- |
| `storm` | `drill.sh storm` | `drill-storm.toml`, all three at **1×** | One weather event reaches three services: `rta.wind_stow`, solar underperformance at OPG, habitat load; the platform relates them (`23`/`33`/`43` cause hints) and the annunciator survives the burst |
| `controls-rta` | `drill.sh controls-rta` | `drill-rta-scan.toml`, RTA at 50× | `set_target` → `start_scan` → raster fills → `cancel_scan`, with each ack state observed in order and the image matching the reference shape |
| `controls-mhe` | `drill.sh controls-mhe` | `drill-mhe-seal.toml`, MHE at 1000× | `seal_room` on an occupied room raises CO₂, `air_concentration` fires, `crew_wellness_check` reaches `completed` with `needs_support` honoured as a result rather than a failure |
| `controls-opg` | `drill.sh controls-opg` | `drill-opg-reserve.toml`, OPG at 200× | `low_battery` → critical at the reserve → automatic generator start → `backup_active`; then a manual `stop_generator` and the shortfall it causes |
| `faults` | `drill.sh faults --from-json drills/rta,mhe` | `drill-rta-faults.toml` and `drill-mhe-cascade.toml` | Alert context, the MHE incident grouping with root-first ordering, and the suppression of futile controls (`33`: no `adjust_temperature` while heating is faulty) |
| `replay` | `drill.sh replay` | reuses the last drill's database | Alerts and events appear inside the replay at the cursor, and a seek does not invent or drop frames (`07`, `08`) |
| `reconcile` | `drill.sh reconcile` | any; runs after another drill | Every row the platform stored is present in the API backlog for the same window and stream, and the counts agree within the documented tolerance — the store is not silently lossy |
| `controls-disabled` | `drill.sh controls-disabled` | clean, `ARL_CONTROL_ENABLED=false` | Every command returns `rejected / controls_disabled`, and the UI says so instead of pretending |

`reconcile` is the one this document adds to `51`'s list. Its tolerance is not zero: the platform
records what it received, the API records what it recorded, and a restart on either side loses a
window. The assertion is therefore exact on *counts per stream per minute at 1×* and explicit about
the excluded windows, rather than a vague "roughly equal".

### 4.7 The results log

A table in this document, appended by `drill.sh --record`. Append-only: a failed run is recorded, and
a fix is a new row. That is what makes the log evidence rather than marketing.

| Drill | Date | Commit | Seed | Start time | Speedup | Scenario | Result | Artefacts |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| — | | | | | | | *(no run recorded yet — the harness is not built)* | |

Each row also records: the number of assertions and how many passed; the alert types observed with
their severities; the peak message rate seen by the ingest; the peak WebSocket pending depth; and the
size of the database afterwards.

The final two numbers are the Architecture 100 % evidence. They are measurements, not claims, and a
drill that reports a 5 000-frame pending queue is telling us something that must be fixed rather than
recorded.

### 4.8 Cost

Derived from the reporting rates in the six specifications, at the speedups of §4.2.1:

| Service | Simulated work | At 1× | At its ceiling |
| :--- | :--- | :--- | :--- |
| RTA | One scan (128 × 128, overlap 3, ~9 min) | ~9 min | 50× → ~11 s |
| RTA | A dish's normal reporting (120 s) | 2 min per frame | 50× → 2.4 s per frame |
| MHE | One vitals frame (60 s) | 1 min | 2000× → 30 ms |
| MHE | A full 90-day mission | 90 days | 2000× → ~65 min |
| MHE | A survey deadline (09:00 / 23:30) | half a day | 2000× → ~22 s |
| OPG | A full day, including the night drain | 24 h | 500× → ~2.9 min |
| OPG | A reserve crossing under night load | hours | 500× → under a minute |
| All three | `storm` — a 90-minute storm plus recovery | 1.5 h | 1× only (the rule) |
| All three | `reconcile` over a 1-hour window | 1 h | 1× only |

So the budget is: **`storm` about 2 minutes of wall time, `controls-rta` under a minute,
`controls-mhe` about a minute, `controls-opg` about a minute, `reconcile` about two.** The whole
catalogue is under ten minutes, which is why it can be a documented gate rather than an aspiration.

What is *not* free and must be stated in the README: the first image load, and `reset` after it. The
drills are cheap; preparing the machine is not.

---

## 5. Failure modes

| Failure | Symptom | Handling |
| :--- | :--- | :--- |
| Docker assumed | `docker: command not found` | `stack.sh` uses podman and says so; the translation table is in the README |
| Port 1883 or 8080 already held | `up` fails with an address-in-use error | Preflight names the holding process; the harness never kills a process it did not start |
| `up -d` returns before the topology is retained | Drill fails on the first assertion, intermittently | The readiness gate is `/api/health`'s `services`, not container state (§4.4 step 4) |
| A scenario edited without a restart | The drill tests the previous scenario | `drill.sh` always recreates the services it needs |
| Unknown entity id in a scenario | Event silently ignored; the drill passes vacuously | Preflight validates ids against the topology cache |
| Mixed speedups in a cross-service drill | Three services in three simulated epochs; correlations are nonsense | The speedup rule is per drill, and `stack.sh` prints the effective multiplier |
| Speedup above a service's ceiling | Requested 2000×, RTA silently runs at 50× | The same print makes it visible; the drill record stores the effective value |
| A drill reuses the previous database | Alerts from the last run appear in this one | A fresh `DB_PATH` per drill; `data/arl.sqlite` is never touched |
| Failure leaves the stack running | The next drill races a warm lab | Teardown in a `trap`; `--keep` is explicit |
| A fixture regenerated from a different seed | Contract tests fail once and then "pass" after the fixture is overwritten | Determinism assertion in §4.5.1, and a fixture diff is a review artefact |
| Drills become slow as data accumulates | Nobody runs them | Fresh database per drill; the window is bounded; §4.8 keeps the budget visible |
| The API's backlog is emptied by `reset` | A `reconcile` drill finds nothing | `reset` is only used by drills that say so; `reconcile` refuses to run against an empty backlog |

---

## 6. Test plan

| Test | Asserts |
| :--- | :--- |
| `stack.sh up` twice | Idempotent; the second returns fast and changes nothing |
| Readiness gate | With no scenario loaded, a drill with no faults still passes at 1× |
| Scenario validator | An unknown entity id, a missing duration, and a nonexistent path are each rejected before `up` |
| Determinism | Two `--ndjson` captures with the same seed and start time are byte-identical |
| Determinism negative | Changing only the seed changes the payloads |
| Speedup rule | A cross-service drill refuses a speedup above 50 |
| Teardown | A drill that fails midway leaves no container running and no platform process |
| Artefacts | Every run leaves a directory containing the logs, the alert table and the assertion results |
| `controls-disabled` | With `ARL_CONTROL_ENABLED=false`, every command is rejected with that exact reason |

---

## 7. Definition of done for this document

- `scripts/stack.sh up` brings the three chosen services and their dependencies up and reports ready,
  on a machine with podman and no docker.
- All eight drills exist as scripts and scenarios, and every one of them has a row in §4.7.
- At least one drill per service has passed at its documented speedup, and the `storm` drill has
  passed at 1×.
- `npm run fixtures` regenerates every contract fixture in `server/test/fixtures/` byte-identically.
- The README documents the harness in the four commands a marker needs: up, drill, fixtures, down.

---

## 8. Open decisions

| # | Decision | Recommendation |
| :--- | :--- | :--- |
| 1 | Build the harness before or after the platform features? | Before the drills that prove the features, after `stack.sh`. Being able to see real data early prevents a week of building against an imagined payload |
| 2 | Keep `lwm` and `owt` running? | No by default. Two extra services double the ingest rate and add alerts we are not marking. Start them only for `storm` if a cross-service relation needs them |
| 3 | `data/arl.sqlite` or a per-drill database? | Per drill. The shared file is for the demonstration; reusing it across drills turns evidence into noise |
| 4 | Should `reconcile` have zero tolerance? | No. Restarts on either side lose windows. Pin the tolerance per stream and exclude the restart windows explicitly, then the test means something |
| 5 | Bash or node for the assertion scripts? | Node. Bash cannot parse the JSON the assertions are made of, and the platform is already Node |
| 6 | Do the drills belong in CI? | Only if the runner has podman; otherwise a manual gate whose last run is a page in the submission | 
| 7 | Should `stack.sh` start the platform too? | No. The lab and the platform are separate concerns with separate failure modes; the drill runner composes them, and `stack.sh` stays a lab tool |
| 8 | How long should the artefact directory be kept? | It is gitignored; keep the last ten and let the rest go. What goes in the submission is the results log, not the logs |