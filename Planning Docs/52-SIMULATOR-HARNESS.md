# 52 — Simulator Harness

**Component.** The apparatus that runs the lab: bringing a known stack up, perturbing it
deterministically, recording what happened, and keeping the evidence. This is what turns the
Testing 100 % band's wording — *"against the test broker with controls enabled or simulated
faults"* — from a claim into a command someone else can run.

**Owner files (new).** `scripts/stack.sh`, `scripts/drill.sh`, `scripts/drills/*.mjs`,
`scripts/fixtures.mjs`, `Services/arl-sim/scenarios/drill-*.toml` (our drills, alongside the
supplied `example.toml` — that folder is the one compose mounts at `/scenarios`), `.gitignore`
(drill artefacts), `README.md` (the harness section).

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

- **The compose file declares an order, not a readiness.** Every service `depends_on` the broker
  with `condition: service_started` and `api` with `condition: service_healthy`, mounts
  `./config:/config:ro` and `./scenarios:/scenarios:ro`, and runs with `read_only: true` and
  `tmpfs: [/tmp]`. `api` itself declares no healthcheck, and podman-compose 1.0.6 turns every
  `depends_on` into `podman run --requires=…` — a start *order*, observed: all six containers were
  started within 3 s with no wait on any `condition:`. So the stack *can* come up half-ready here;
  the harness gates readiness itself (§4.4 steps 3 and 5).
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
- **Compose forwards four of them, not five.** The `x-env` block passes `ARL_SEED`, `ARL_SPEEDUP`,
  `ARL_START_TIME` and `RUST_LOG`; `ARL_SCENARIO` becomes the `--scenario` argument. There is no
  `ARL_CONTROL_ENABLED` in the file, so in compose mode controls are always on (the config default)
  and the only way to switch them off without editing upstream is a binary (§4.6
  `controls-disabled`).

What is **not** there: no script of any kind, no drill scenarios, no fixture capture and no results
log. (The repository README does document running the bundle by hand — `Running Locally` — but not
as a harness.)

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
| No readiness gate beyond `up -d` | Drills race the first `$topology` and fail intermittently | §4.4: wait on `/api/services` until every topology is non-null |
| One scenario file, and it is a demonstration rather than a drill | Faults are present but nothing asserts on them | §4.3/§4.6: a scenario per drill, with the fault chosen to produce the exact alert under test |
| No fixture capture | Contract tests in `51` §2.3 have no source | §4.5: three capture paths |
| No record of a run | "We tested it" with nothing behind it | §4.7: an append-only results log |
| Speedup treated as one global number | Two services at different multipliers live in different simulated eras, so cross-service work is silently meaningless | §4.2.1: the speedup rule |
| No reconciliation against the API backlog | The store could lose rows and no test would notice | §4.6 drill `reconcile` |
| Nobody knows the cost of a drill | Drills get skipped as "too slow" | §4.8: measured budget per drill |

---

## 4. Decomposition

### 4.1 The stack

`scripts/stack.sh <up|infra|start|down|reset|ps|status|logs> [services...]`

| Subcommand | Does |
| :--- | :--- |
| `up [svc...]` | `down`, then one `up -d` of broker, API and the services (default `rta mhe opg`) — for a person at a terminal |
| `infra` | `down`, then broker and API only; waits for `/healthz` `database` and `broker` |
| `start <svc...>` | adds simulators to a running `infra` with the **same** `ARL_*` settings (so the config hash matches and nothing is recreated), then prints each one's effective start and speedup |
| `down` | removes the project's containers; the Postgres volume is kept |
| `reset` | `down`, then deletes the volume |
| `ps`, `status`, `logs <svc>` | inspection |

The drill runner uses `infra` then `start` (§4.4); `up` is the one-shot for everyone else.

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
- **Recreate, do not restart — and recreate everything.** podman-compose 1.0.6 labels every
  container with one *project-wide* config hash (computed after `${ARL_…}` interpolation). An `up -d`
  whose hash differs from any existing container's tears down the named services **and their
  dependencies** (observed: `up -d opg` with a new `ARL_SPEEDUP` stopped and recreated `opg`, `api`,
  `postgres` and `mosquitto`, and left `rta`/`mhe` on the old settings and the old hash). Partial
  recreation therefore leaves a mixed-epoch stack. `stack.sh up` runs `down` (volume kept) and then
  one `up -d` for the whole set, so every container shares one hash, one setting and one start.
  It costs ~10 s and keeps the backlog.

#### 4.1.2 `reset` is not `restart`

- `down` keeps the Postgres volume, so the backlog and the seeded researchers survive.
- `reset` is `down -v`: the volume is deleted and the seed directory is loaded again on the next
  start. It is the only way to get a pristine researcher register, and it destroys the backlog — so
  `reset` is **never** part of an ordinary drill. One drill declares it: `reconcile`, which needs the
  backlog to hold only its own run (otherwise a window can overlap an older run and compare two).
- `read_only: true` means a container cannot be edited in place. A configuration change is a file
  edit plus `restart <svc>`; `up -d` alone does not re-read it and is the most common wasted hour.

#### 4.1.3 Ports

| Port | Who | Visible from the host |
| :--- | :--- | :--- |
| 1883 | Mosquitto | yes (published) |
| 8080 | ARL API (`/docs`, `/healthz`, `/v1/...`) | yes (published) |
| 9100 | each service's own `/healthz` | **no** — internal to its container |
| 3000 | the platform a person is using (HTTP and WS share the port) | yes |
| 3100 | the platform a drill starts (`DRILL_PORT`) | yes |

The absence of a published 9100 matters: `stack.sh status` reports service health from
`podman-compose ps` and from the platform's `/api/services`, never by curling a port that is not there.
The drill platform has its own port so that a console already running on 3000 — possibly pointed
at the shared lab — is never stopped, restarted or fed drill data.

### 4.2 The environment matrix

| Variable | Default | Values we use | Note |
| :--- | :--- | :--- | :--- |
| `ARL_SEED` | 1 | 1 for every drill; 2–7 only to prove a fault is not seed-specific | The seed alone is not determinism — see §4.3.4 |
| `ARL_SPEEDUP` | 1 | 50, 200, 1000 | Each service has a ceiling — RTA 50, MHE 2000, LWM/OPG/OWT 500 — and **refuses** a value above it: it exits at start-up and compose restarts it in a loop. It does not clamp (§4.2.1) |
| `ARL_START_TIME` | `now` | `now` for smoke drills; a fixed RFC 3339 time for anything compared or replayed | An absolute start time is what makes "the storm begins at 14:30" true |
| `ARL_SCENARIO` | none | `/scenarios/<drill>.toml` | A path **inside the container**; the host folder is mounted at `/scenarios` |
| `ARL_CONTROL_ENABLED` | from config (`true`) | `false` for the negative drill only | **Not forwarded by compose** (§2): the negative drill runs `bin/arl-opg --control-enabled false` against the compose broker and API instead |
| `MQTT_BROKER_ADDRESS` / `ARL_API_ADDRESS` | `mosquitto` / `api` (in-container) | `localhost` for the host-side platform and for a binary | The platform is not in the compose file |
| `HEALTH_PORT` | 9100 | one per binary when running several | Binary mode only |

Those are the **simulator's** inputs. The platform takes none of them: a drill starts it with
`MQTT_BROKER_ADDRESS=localhost`, `MQTT_BROKER_PORT=1883`, `MQTT_BROKER_USER=` and
`MQTT_BROKER_PASSWORD=` (empty — the local broker is anonymous), `ARL_API_ADDRESS=localhost`,
`ARL_API_PORT=8080`, `PORT=3100` and a fresh `DB_PATH`. They are set in the process environment,
which `.env` never overrides, so a `.env` holding the shared lab's credentials cannot leak into a
drill.

#### 4.2.1 The speedup rule (a real trap)

`ARL_SPEEDUP` applies to every service in the compose file, but each service has its own ceiling
(`max_speedup`). An earlier draft of this section said a service *clamps* to its ceiling, so that
`ARL_SPEEDUP=2000` would give MHE 2000× and RTA 50×. **That is wrong, and the harness found it:**
the first `faults` run asked for 1000×, and RTA logged `speedup_multiplier 1000 is outside 0.1 to
50`, exited, and was restarted by compose (`restart: unless-stopped`) in a loop. Nothing clamps;
the service is simply absent, and a drill waiting for its topology times out with no clue why.

So the rule is a refusal, made before anything starts: `drill.mjs` holds each service's ceiling and
its preflight fails a drill that would start a service above it (§4.4 step 1). And because one
`ARL_SPEEDUP` reaches every container, a drill that includes RTA runs at 50× or less, whatever else
it includes.

The earlier draft also said cross-service drills run at **1×**. That contradicted §4.8 (a
90-minute storm cannot take "about 2 minutes" at 1×). Below every ceiling the services share one
multiplier, so the limit is the lowest ceiling in the drill — RTA's 50 — not 1. What remains
unshared is start-up skew: each service starts its clock when its process starts, so a 1 s gap
between containers is 50 simulated seconds at 50×. Assertions therefore compare each service against
its own clock and on ordering, never across services to the second.

The rule, therefore:

| Drill kind | Speedup | Reason |
| :--- | :--- | :--- |
| Cross-service (`storm`, `reconcile`) | **50** | All three services share one clock; 50 is RTA's ceiling, the lowest |
| RTA and MHE together (`faults`) | **50** | RTA is in it. The MHE half (a 6-hour heater drift) therefore takes ~5 min of wall time; that is the price, not a reason to split the scenario |
| Single-service, RTA (`controls-rta`) | 50 | RTA's own ceiling; a 9-minute scan finishes in ~11 s |
| Single-service, MHE (`controls-mhe`) | 1000 | A sealed room's CO₂ rise to `air_concentration` takes seconds |
| Single-service, OPG (`controls-opg`, `controls-disabled`) | 200, 50 | A night drain, a generator start and a 30-minute aftermath inside a minute; `controls-disabled` needs no time at all |
| `replay` | — | No lab: it plays a copy of `faults`' database |

The harness encodes this per drill rather than taking it from the shell (`simEnv` is built from the
drill, not inherited — a stale `export ARL_SPEEDUP=200` in the shell once broke a hand-run
`preroll`), the preflight enforces the ceilings, and `stack.sh start` prints the effective
multiplier per service from its own start-up log.

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
| `drill-faults.toml` | Written for a 22:00 start. RTA: `dish-042 overheat` (peak 345 K) from +5 min for 70 min, `dish-017 comms_loss` at +5 and `repair` at +20; MHE: `heater_fault quarters-2` and `ventilation_fault quarters-3` from +5 for 6 h | `faults` — two services, three fault classes and their clearing, in one file because a run loads exactly one scenario. Ventilation is on an *occupied quarters* because at 22:00 `common` is empty and never crosses 1500 ppm; the overheat lasts 70 min because the dish climbs ~1 K per simulated minute and must hold past 343 K for the rule's 120 s |
| `drill-rta-scan.toml` | empty (clean sky, no faults) | `controls-rta` — a scan with nothing else in the picture |
| `drill-mhe-seal.toml` | empty; the drill seals a room by control | `controls-mhe` — the sealed-room CO₂ rise must be caused by the command, not by a fault |
| `drill-opg-reserve.toml` | `set_state batteries soc_pct 25` at +2 min | `controls-opg` — reserve, generator start, `backup_active` |
| `drill-opg-fuel.toml` | `fuel_leak diesel` at +5 min, `repair` at +4 h | `low_fuel` projection arithmetic — **no drill uses it yet** |
| `drill-degraded.toml` | `inverter_fault solar` and `generator_fail_start diesel` at +10 min, both repaired at +4 h | the OPG unrecoverable path: `solar_underperformance` + `generator_fault` together — **no drill uses it yet** |

#### 4.3.4 What determinism actually requires

The same data requires the same **seed, start time, scenario and command sequence**. A replay of a
drill that differs only in when the operator clicked will diverge. So each drill records all four
(§4.8), and any drill that issues controls declares them in a fixed order with fixed values — no
"click until it works".

### 4.4 The drill runner

`scripts/drill.sh <name|all> [--keep] [--record] [--seed N]` (also `npm run drill -- <name>`; the
shell script is a two-line wrapper round `scripts/drill.mjs`, because the assertions are JSON)

- **Responsibility.** One command per drill, from cold to a verdict, with artefacts on failure.
- **Contract.** Exit 0 = every assertion held. Exit non-zero with the failing step named. `--keep`
  leaves the stack running for inspection; `--record` appends the run to §4.7. A drill is a module
  in `scripts/drills/` declaring its services, speedup, start time and scenario, plus optional
  `reset`, `startServices`, `stack: false`, `gate: false`, `platformEnv`, `dbPath`, `afterStart` and
  `cleanup` — so `replay` (no lab) and `controls-disabled` (a binary instead of a container) are
  ordinary drills rather than special cases in the runner.

**Steps.**

1. **Preflight.** Scenario file exists in the mount; its entity ids all appear in the committed
   `$topology` fixtures (`server/test/fixtures/<svc>.topology.json`, `npm run fixtures`), so an
   ignored event cannot be mistaken for a passing test; every event ends by `duration`,
   `recover_after` or a later `repair`. The speedup is under every started service's ceiling and,
   for a cross-service drill, at most 50 (§4.2.1). Port 3100 is free.
2. **Lab up.** `stack.sh reset` where declared, then `stack.sh infra` with the drill's *simulator*
   environment (§4.2): broker and API only, which returns once `GET localhost:8080/healthz` reports
   `database` and `broker` true.
3. **Platform up.** `node server/dist/index.js` (built first if `dist/` is older than `src/`) with the
   *platform* environment of §4.2 — broker and API on `localhost`, empty broker credentials,
   `PORT=3100`, `ARL_SERVICES` = the drill's services and a **fresh** `DB_PATH` per drill
   (`.logs/drills/<id>/arl.sqlite`). It never touches `data/*.sqlite` or a platform already on 3000.
   The platform has no `ARL_CONTROL_ENABLED`: whether controls work is the simulator's setting. The
   step ends when the platform's `/api/health` reports `broker: true` — it is subscribed.
4. **Simulators up.** `stack.sh start <services>` with the same environment. **Only now**, because
   `$topology` and state are retained but events are not: the earlier order (everything up, then the
   platform) lost the first simulated minutes' alerts at 200×, which is exactly when a scenario's
   first fault fires.
5. **Topologies.** Poll the platform's `GET /api/services` until every configured service has a
   non-null `topology` and `online: true`. This is the real gate: it proves the retained `$topology`
   reached *us*. (`/api/health`'s `services` is the *configured* list and is true the moment the
   process starts, so it cannot be the gate.)
6. **Run the assertion script.** `scripts/drills/<name>.mjs`, a list of named steps, each returning
   pass/fail with the values it compared. Assertions are on **ordering and state transitions**, never
   on wall-clock durations (`51` §3.3).
7. **Capture and tear down.** `results.json` (every step with its compared values and duration),
   `alerts.json`, `commands.json`, `health.json`, each container's log, the platform's log and its
   database go into `.logs/drills/<id>/` (gitignored). Teardown in `finally` and on `^C` (once,
   however often it is pressed) unless `--keep`.

**Acceptance.** `scripts/drill.sh controls-rta` passes twice in a row on a machine with the images
already loaded, and a broken assertion fails with the step named and the artefact directory printed.
Both happened: `controls-rta` passed on consecutive runs, and the first `faults` run at 50× failed
as `FAIL 7/13 at “RTA: dish-042 dish_temperature escalates warning → critical and clears”` —
the drill read an escalation's severity from the transition payload, where the platform keeps it in
`to_status`. That was a drill bug; the platform was right.

### 4.5 Fixtures

Three capture paths, each for a different job.

#### 4.5.1 `preroll` — offline, deterministic, cheap

Each binary accepts `preroll --from <t> --to <t> --out <file>`: it runs the simulated window
**without delays** and writes every message it would have published — the retained `$topology`
first — to a newline-delimited JSON file, publishing nothing. Combined with a fixed seed, start
time and scenario, this produces the contract fixtures of `51` §2.3 **without a broker at all**, and
an hour of OPG takes milliseconds:

```
./bin/arl-opg --config config/opg.toml --seed 1 --start-time 2027-03-02T22:00:00+02:00 \
  preroll --from 2027-03-02T22:00:00+02:00 --to 2027-03-02T23:00:00+02:00 --out /tmp/opg.ndjson
```

(`run --ndjson <file>` also exists, but it is *paced*: it writes at the configured speedup and
never ends, so it is an inspection tool, not a fixture source. RTA's binary also needs the site map
and sky images, which `scripts/fixtures.mjs` copies out of `arl/rta:0.1.0` once, as
`Running the ARL` §4 describes, into the gitignored `.logs/harness/assets/`.)

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

Each row says what the drill **asserts**, as built and run. Where an earlier draft promised more
than the platform does, the row says so rather than quietly dropping it.

| Drill | Command | Scenario | What it asserts |
| :--- | :--- | :--- | :--- |
| `storm` | `drill.sh storm` | `drill-storm.toml`, all three at **50×**, start 11:00 | Before: dishes not stowed, irradiance in sunshine. `rta.wind_stow` engages after +20 min with its value over the limit and releases before +110 min (observed +23 → +58); OPG irradiance under the storm is under half its baseline and more than doubles again after; MHE keeps reporting; the ingest drops nothing, parses everything and records no sequence gap. *Not asserted:* OPG raises no alert for a storm, MHE does not respond to weather at all, and the platform has no cross-service cause hints — the earlier draft's "the platform relates them" was never built |
| `controls-rta` | `drill.sh controls-rta` | `drill-rta-scan.toml`, RTA at 50× | Six refusals by the platform (wrong-service, defunct and unknown researcher, out-of-range value, unknown dish, unknown control) with none reaching the broker; a sub-horizon target accepted but its scan `rejected / precondition_failed`; `set_target` → `start_scan` → `started` → raster complete (samples counted per dish over the 128 × 128 grid) → `completed`; a second scan cancelled mid-run; `cancel_scan` with nothing running rejected by the service. Every ack sequence is checked for legal order. The raster is counted, not compared with a reference image |
| `controls-mhe` | `drill.sh controls-mhe` | `drill-mhe-seal.toml`, MHE at 1000× | Wrong-service researcher and an out-of-range setpoint refused; `seal_room` on an occupied quarters completes and the room reports sealed; CO₂ rises; `air_concentration` is raised on that room; unsealing completes and CO₂ falls; `crew_wellness_check` runs `accepted > in_progress > completed` |
| `controls-opg` | `drill.sh controls-opg` | `drill-opg-reserve.toml`, OPG at 200× | Wrong-service researcher and a reserve above 80 % refused; then, in the order the service really reports it, `low_battery` → `supply_shortfall` (critical) → `backup_active` as the generators start, and the shortfall clears once diesel carries the load. A manual `stop_generator` completes and diesel output reaches 0; the 30 simulated minutes after it are recorded (observed: a new critical `supply_shortfall`, `backup_active` cleared). `battery_reserve 30` completes and the state reads 30. There is no separate "critical at the reserve" alert, which the earlier draft assumed |
| `faults` | `drill.sh faults` | `drill-faults.toml`, RTA and MHE at 50× (one scenario per run, §4.3.2) | RTA: `dish-017` `dish_offline` raised and cleared after the repair; `availability` critical below its limit; `dish-042` `dish_temperature` raised warning, escalated critical and cleared, as **one** alert id. The operator lifecycle on that alert: acknowledge by an unknown code `403`, resolve before acknowledge `409 alert_not_acknowledged`, a too-short resolution `400`, then acknowledge once (second `409`), resolve once (second `409`), and the audit trail reads exactly `raised > escalated > cleared > acknowledged > resolved`. MHE: `air_concentration` on `quarters-3` escalates under one id; the `quarters-2` heater fault raises `room_condition` below its limit. *Not asserted, because not built:* MHE incident grouping and suppression of futile controls (`33`) |
| `replay` | `drill.sh replay` | a copy of the newest `faults` (or `storm`) database; no lab, broker pointed at a closed port | A 20-minute window round the first escalated alert, at speed 64: the frames are exactly the stored rows (as a multiset, keyed on every field), in time order, with the session's row count equal to the store's; the alert's events are at their own `ts` and never released behind the cursor; a seek before play yields exactly the rows from the target; a backward seek mid-play yields exactly the rows from the target onward (`07`, `08`) |
| `reconcile` | `drill.sh reconcile` | none; `reset` first, all three at 50×, 75 simulated minutes | For every telemetry stream of every service, the platform's row count equals the API backlog's per stream, per entity, per simulated minute — **zero** mismatches — over the window excluding the first and last minute; alert event counts agree per minute; state counts are recorded, not asserted (both record changes) |
| `controls-disabled` | `drill.sh controls-disabled` | none; broker and API from compose, OPG as `bin/arl-opg --control-enabled false` | All six OPG controls are sent (the platform cannot know) and each settles `rejected / controls_disabled` — not completed and not timed out — and OPG stays online and reporting. The UI shows that state and reason from the command row; the drill checks the row, not the pixels |

`reconcile` is the one this document adds to `51`'s list. Its tolerance turned out to need no slack:
with `reset` first and the edge minutes excluded (the services' clocks start a few hundred ms
apart, and the last minute may be in flight on either side), the counts agree exactly. A restart on
either side would lose a window; no drill restarts anything mid-run, so none is excluded.

### 4.7 The results log

A table in this document, appended by `drill.sh --record`. Append-only: a failed run is recorded, and
a fix is a new row. That is what makes the log evidence rather than marketing.

| Drill | Date | Commit | Seed | Start time | Speedup | Scenario | Result | Artefacts |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `storm` | 2026-11-02 13:58 | `4d99818+dirty` | 1 | `2027-03-02T11:00:00+02:00` | rta 50×, mhe 50×, opg 50× | `drill-storm.toml` | **pass 12/12**; alerts: rta.dish_calibration (info), rta.wind_stow (warning); peak 212 msg/s; WS peak depth 203; DB 5.9 MB | `.logs/drills/storm-20261102T135814Z/` |
| `controls-rta` | 2026-11-02 14:00 | `4d99818+dirty` | 1 | `2027-03-02T22:00:00+02:00` | rta 50× | `drill-rta-scan.toml` | **pass 17/17**; alerts: rta.dish_calibration (info), rta.dish_scan (warning); peak 4460 msg/s; WS peak depth 902; DB 33.1 MB | `.logs/drills/controls-rta-20261102T140018Z/` |
| `controls-mhe` | 2026-11-02 14:00 | `4d99818+dirty` | 1 | `2027-03-02T22:00:00+02:00` | mhe 1000× | `drill-mhe-seal.toml` | **pass 13/13**; alerts: mhe.air_concentration (warning); peak 134 msg/s; WS peak depth 22; DB 2.3 MB | `.logs/drills/controls-mhe-20261102T140057Z/` |
| `controls-opg` | 2026-11-02 14:01 | `4d99818+dirty` | 1 | `2027-03-02T22:00:00+02:00` | opg 200× | `drill-opg-reserve.toml` | **pass 12/12**; alerts: opg.supply_shortfall (critical), opg.low_battery (critical), opg.backup_active (info); peak 19 msg/s; WS peak depth 7; DB 3.6 MB | `.logs/drills/controls-opg-20261102T140123Z/` |
| `faults` | 2026-11-02 14:02 | `4d99818+dirty` | 1 | `2027-03-02T22:00:00+02:00` | rta 50×, mhe 50× | `drill-faults.toml` | **pass 13/13**; alerts: mhe.air_concentration (critical), mhe.room_condition (warning), rta.dish_calibration (info), rta.availability (critical), rta.dish_offline (warning), rta.dish_temperature (critical); peak 120 msg/s; WS peak depth 120; DB 8.5 MB | `.logs/drills/faults-20261102T140216Z/` |
| `replay` | 2026-11-02 14:07 | `4d99818+dirty` | 1 | — | — (no stack) | — | **pass 7/7**; alerts: mhe.air_concentration (critical), platform.broker_disconnected (critical), mhe.room_condition (warning), rta.dish_calibration (info), rta.availability (critical), rta.dish_offline (warning), rta.dish_temperature (critical); peak 0 msg/s; WS peak depth 1; DB 4.4 MB | `.logs/drills/replay-20261102T140714Z/` |
| `reconcile` | 2026-11-02 14:08 | `4d99818+dirty` | 1 | `2027-03-05T00:00:00+02:00` | rta 50×, mhe 50×, opg 50× | — | **pass 12/12**; alerts: rta.dish_calibration (info); peak 122 msg/s; WS peak depth 122; DB 5.8 MB; reconciled 4439 telemetry rows | `.logs/drills/reconcile-20261102T140806Z/` |
| `controls-disabled` | 2026-11-02 14:10 | `4d99818+dirty` | 1 | `2027-03-02T22:00:00+02:00` | — (no stack) | — | **pass 12/12**; alerts: none; peak 0 msg/s; WS peak depth 4; DB 0.6 MB; 6/6 OPG controls rejected/controls_disabled | `.logs/drills/controls-disabled-20261102T141001Z/` |
| `controls-disabled` | 2026-11-02 14:11 | `4d99818+dirty` | 1 | `2027-03-02T22:00:00+02:00` | — (no stack) | — | **pass 12/12**; alerts: none; peak 0 msg/s; WS peak depth 5; DB 0.6 MB; 6/6 OPG controls rejected/controls_disabled | `.logs/drills/controls-disabled-20261102T141124Z/` |
| `controls-disabled` | 2026-11-02 14:12 | `4d99818+dirty` | 1 | `2027-03-02T22:00:00+02:00` | opg 50× | — | **pass 12/12**; alerts: none; peak 0 msg/s; WS peak depth 5; DB 0.6 MB; 6/6 OPG controls rejected/controls_disabled | `.logs/drills/controls-disabled-20261102T141205Z/` |

Each row also records: the number of assertions and how many passed; the alert types observed with
their severities; the peak message rate seen by the ingest; the peak WebSocket pending depth; and the
size of the database afterwards. The speedup column is each service's **effective** multiplier, read
from its own start-up log, not the requested one. `+dirty` means the working tree held uncommitted
changes; for these rows that was the planning documents only (the harness and platform code are in
`4d99818`). `replay`'s `platform.broker_disconnected` is its own doing — it points the platform at a
closed port on purpose.

The final two numbers are the Architecture 100 % evidence. They are measurements, not claims, and a
drill that reports a 5 000-frame pending queue is telling us something that must be fixed rather than
recorded.

The first two `controls-disabled` rows show `— (no stack)` because the runner did not yet take the
speedup of a service it had not started through compose; the third, after that fix, shows it. They
stay: the log is append-only.

Runs made while the drills were being written were not recorded, but what they found was fixed
and is in the README's progress log: the per-entity sequence-gap bug (`controls-rta`), the
late-subscriber loss that reordered §4.4, the speedup refusal of §4.2.1 (`faults` at 1000×), and
the expired-command broadcast (the command-path tests).

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
| All three | `storm` — a 90-minute storm plus a 10-minute release | ~2 h | 50× (the rule) → ~2.5 min |
| All three | `reconcile` over a 1-hour window | 1 h | 50× → ~72 s |

Measured (the §4.7 runs, wall time including lab start and teardown):

| Drill | Wall time | Of which waiting for simulated time |
| :--- | :--- | :--- |
| `storm` | 2 min 04 s | ~1 min 40 s |
| `controls-rta` | 39 s | ~16 s (the scan) |
| `controls-mhe` | 26 s | ~5 s |
| `controls-opg` | 53 s | ~35 s |
| `faults` | 4 min 58 s | ~4 min 40 s (the MHE heater drift at RTA's 50×) |
| `replay` | 52 s | none; four sessions at speed 64 |
| `reconcile` | 1 min 55 s | ~1 min 30 s |
| `controls-disabled` | ~40 s | none |
| **all eight** | **~12.5 min** | |

The lab itself costs ~4–8 s (`infra`) plus ~8–11 s (`start`) per drill, because every drill
recreates it. The estimate this section first gave — "under ten minutes" — missed `faults`, whose
six-hour MHE window cannot run faster than RTA allows (§4.2.1). It is still short enough to be a
documented gate rather than an aspiration.

What is *not* free and must be stated in the README: the first image load, and `reset` after it. The
drills are cheap; preparing the machine is not.

---

## 5. Failure modes

| Failure | Symptom | Handling |
| :--- | :--- | :--- |
| Docker assumed | `docker: command not found` | `stack.sh` uses podman and says so; the translation table is in the README |
| Port 1883 or 8080 already held | `up` fails with an address-in-use error | Preflight names the holding process; the harness never kills a process it did not start |
| `up -d` returns before the topology is retained | Drill fails on the first assertion, intermittently | The readiness gate is `/api/services`' topologies, not container state (§4.4 step 5) |
| The platform subscribes after the services start | Events are not retained, so the first simulated minutes' alerts never arrive; at 200× that is the scenario's first fault | Broker and API first, the platform next, the simulators last (§4.4 steps 2–4) |
| A scenario edited without a restart | The drill tests the previous scenario | `drill.sh` always recreates the services it needs |
| A `.env` pointed at the shared lab | The drill platform connects to the exam lab and issues drill commands there | Every platform variable is set in the drill's process environment, which `.env` never overrides; the runner refuses to start if `MQTT_BROKER_ADDRESS` would resolve to anything but `localhost` |
| A platform already running on 3000 | Two platforms, one database, or a person's console fed drill data | The drill platform uses `DRILL_PORT` (3100) and its own `DB_PATH`, and never signals a process it did not start |
| Unknown entity id in a scenario | Event silently ignored; the drill passes vacuously | Preflight validates ids against the topology cache |
| Mixed speedups in a cross-service drill | Three services in three simulated epochs; correlations are nonsense | The speedup rule is per drill, and `stack.sh` prints the effective multiplier |
| Speedup above a service's ceiling | The service exits at start-up (`speedup_multiplier … is outside 0.1 to 50`) and compose restarts it in a loop; the drill times out waiting for a topology | The preflight refuses the drill before anything starts (§4.2.1); the record stores each service's effective value |
| A stale `ARL_*` exported in the shell | A hand-run `preroll` or `stack.sh up` inherits it (observed: `ARL_SPEEDUP=200` broke an RTA preroll) | The runner builds the simulator environment from the drill, never from the shell; by hand, `unset ARL_SPEEDUP ARL_SEED ARL_START_TIME ARL_SCENARIO` first |
| A drill reuses the previous database | Alerts from the last run appear in this one | A fresh `DB_PATH` per drill; `data/arl.sqlite` is never touched |
| Failure leaves the stack running | The next drill races a warm lab | Teardown in `finally` and on `^C`; `--keep` is explicit |
| A fixture regenerated from a different seed | Contract tests fail once and then "pass" after the fixture is overwritten | Determinism assertion in §4.5.1, and a fixture diff is a review artefact |
| Drills become slow as data accumulates | Nobody runs them | Fresh database per drill; the window is bounded; §4.8 keeps the budget visible |
| The API's backlog is emptied by `reset` | A `reconcile` drill finds nothing | `reset` is only used by drills that say so; `reconcile` refuses to run against an empty backlog |

---

## 6. Test plan

| Test | Asserts |
| :--- | :--- |
| `stack.sh up` twice | Idempotent; the second returns fast and changes nothing |
| Readiness gate | With no scenario loaded, a drill with no faults still passes at its documented speedup |
| Scenario validator | An unknown entity id, a missing duration, and a nonexistent path are each rejected before `up` |
| Determinism | Two `preroll` captures with the same seed and start time are byte-identical |
| Determinism negative | Changing only the seed changes the payloads |
| Speedup rule | A cross-service drill refuses a speedup above 50, and any drill refuses one above a started service's ceiling (verified: `faults` at 1000× failed at preflight with nothing started) |
| Teardown | A drill that fails midway leaves no container running and no platform process |
| Artefacts | Every run leaves a directory containing the logs, the alert table and the assertion results |
| `controls-disabled` | With `--control-enabled false` on the binary, every command is rejected with that exact reason |

---

## 7. Definition of done for this document

- `scripts/stack.sh up` brings the three chosen services and their dependencies up and reports ready,
  on a machine with podman and no docker.
- All eight drills exist as scripts and scenarios, and every one of them has a row in §4.7.
- At least one drill per service has passed at its documented speedup, and the `storm` drill has
  passed at 50× (§4.2.1).
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