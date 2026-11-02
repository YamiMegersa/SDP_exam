# 50 — Security

**Component.** The platform's own security posture: who may command what, what the platform accepts
from the network, what it logs, what it stores, and — just as important — what it deliberately does
*not* do to a lab that is already weak.

**Owner files.** `server/src/commands/service.ts`, `server/src/http/app.ts`, `server/src/http/ws.ts`,
`server/src/arlApi/client.ts`, `server/src/config.ts`, `.env.example`, `.gitignore`.

**Rubric.** Security 5 % of the exam. Bands: ≤ 25 % "researcher codes are not checked"; ≤ 50 %
"codes resolve correctly (via the ARL API)"; ≤ 75 % "services are access protected" + "alerts
correctly attribute resolution and acknowledgement"; 100 % *"security decisions are reasoned and the
lab is not further weakened, e.g. input handling and secrets"*.

**Depends on.** `06` (control plane), `05` (alert attribution), `01` (config), `08`/`09` (transport).

---

## 1. Boundary

The handout is explicit: *"The security of the lab is not the best. Your role is not to fix it, but
ensure that the lab is not further weakened by your implementation."*

In scope: identity of the researcher, authorisation per service, validation of everything that
arrives, secret handling, resource limits, audit integrity, and a written record of the reasoning.

Out of scope, deliberately: hardening the simulator's broker, adding an identity provider, changing
the ARL API's own authentication, or anything that requires modifying the lab. Attempting those would
be "fixing the lab", which is not the task and would also break the test deployment.

The platform is, however, a **new attack surface**: it adds eleven REST routes, a WebSocket fan-out,
six control consoles and a researcher-code field. Every one of those is a place the lab could be
weakened if handled carelessly.

---

## 2. Threat model

| Asset | Actor | Path | Control |
| :--- | :--- | :--- | :--- |
| Physical plant (dish drives, airlock, diesel) | Anyone on the lab network | `POST /api/commands` with a forged or borrowed code | §4.1: per-service verification against the ARL API, value bounds by topology, guards |
| The plant's integrity (bad commands) | A careless researcher | A plausible but unsafe command | Not security but safety: guards and confirmations (`06`, `41`) |
| Researcher identity records | A curious user | Reading `commands`/`alerts` | Codes are identifiers, not secrets; names come from the API; nothing more is stored (§4.3) |
| The platform's own availability | Anyone | Oversized bodies, unbounded WS queues, expensive series queries | §4.5 |
| The simulation's credibility | Everyone | A console that claims a command succeeded when it did not | §4.6: honest attribution and never-delete audit |
| Secrets (broker password, future API keys) | Repository readers, logs | Committed `.env`, logged connection strings | §4.3 |

The one actor *not* modelled is a determined attacker with broker access: if they can publish to
`arl/<svc>/cmd/...` they bypass the platform entirely. That is the lab's existing weakness and
fixing it is explicitly out of scope — but it must be *stated*, because a security section that
omits the biggest hole looks naive.

---

## 3. Where each band is earned

| Band | Requirement | Evidence in this project |
| :--- | :--- | :--- |
| ≤ 25 % | Codes not checked | (the floor — we are well past it) |
| ≤ 50 % | Codes resolve correctly via the ARL API | `commands/service.ts` calls `api.verify(code, service)` before every dispatch (§4.1.1) |
| ≤ 75 % | Services access protected; alerts attribute ack/resolution | Verification is **per service**; `ack_by`/`resolved_by` are stored with `ack_verified`/`resolve_verified` (`05` §4.2.2) |
| 100 % | Decisions reasoned; lab not further weakened (input handling, secrets) | §4.2–§4.7: zod at the edge, topology-constrained identifiers, no secrets in code, resource caps, and a written rationale for every trade-off including the ones we declined |

---

## 4. Decomposition

### 4.1 Identity and authorisation

#### 4.1.1 Per-service verification

- **Responsibility.** A researcher code must be confirmed *for the service being commanded*.
- **Contract.** `POST /v1/researchers/verify {code, service}` → `{valid, reason}` where `reason ∈
  {unknown, defunct, not_permitted, null}`. The platform never decides membership itself.
- **Steps.** In `send()`: normalise the code (trim, case), call `verify(code, service)`, and map the
  verdict: `unknown`/`defunct` → 403 `unknown_researcher` / `researcher_defunct`; `not_permitted` →
  403 with the API's reason verbatim; transport failure → **503 `api_unavailable`, fail closed**.
- **Acceptance.** A code scoped to `lwm` gets 403 `researcher_not_permitted` on an RTA command and no
  MQTT publish occurs; killing the API makes commands fail with 503 and never "succeed".

#### 4.1.2 The verification cache, and why it is bounded

- **Contract.** Cache key is `(code, service)`; TTL 60 s matching the simulator's own
  `api.researcher_cache_ttl_s`. Negative verdicts are cached for 10 s only, so a newly provisioned
  researcher is not locked out for a minute.
- **Steps.** Bounded LRU (1 000 entries) so a flood of distinct codes cannot grow memory. A cached
  *positive* verdict is never used to bypass a guard; it only avoids an HTTP round trip.
- **Acceptance.** 2 000 distinct codes leave the cache at ≤ 1 000 entries; a repeated code within
  60 s makes one API call.

#### 4.1.3 Defunct researchers and the audit

- A defunct code cannot command (`researcher_defunct`) but **can still be recorded** as the actor of
  a historical command — the audit must not be rewritten when a person leaves.
- Resolution requires a verified code (fail closed); acknowledgement accepts an unverified but
  well-formed code and records `ack_verified = 0` (`05` §4.2.2). The asymmetry is reasoned: closing
  an incident is consequential and rare; noticing one during an API outage is neither.

#### 4.1.4 Log hygiene

- `maskCode()` reduces a code to its first 3 and last 2 characters in logs (`arl-…-3f`), because logs
  are shipped and pasted into the README. The database stores codes in full; the log does not.

### 4.2 Input handling at the edge

#### 4.2.1 Schema validation (fixes D-4)

- **Responsibility.** Every route and every WebSocket frame is parsed, not coerced.
- **Contract.** `zod` (already a dependency, currently unused) schemas per route in
  `server/src/http/schemas.ts`; a failure returns 400 `invalid_request` with the field path.
- **Steps.** Body limit stays at 64 kB. Schemas use `z.coerce.number()` **only** where a string is
  legitimately accepted (query strings), and never on a command value — `Number('')` is `0`, and a
  silent 0 is a real command to a real device.
- **Acceptance.** `{control: 'adjust_temperature', value: ''}` is rejected as `invalid_value`, not
  sent as 0 K.

#### 4.2.2 Identifiers come from the topology, never from the request

- **Responsibility.** The platform publishes to `arl/<service>/cmd/<entity>/<control>`; that string is
  an injection point.
- **Contract.** `entity` must exist in `topology.entityById`; `control` must exist via
  `topology.controlFor(entity, control)`; `service` must be one of the configured services. The
  publish topic is then built from the **canonical** ids, never from the raw request strings.
- **Steps.** Reject any id containing `/`, `+`, `#`, or whitespace before it ever reaches the broker;
  additionally the entity lookup makes such a string fail anyway. On the subscribe side, the five
  filters are constant (`arl/+/…`), never derived from input.
- **Acceptance.** `{entity: '../../foo', control: 'x'}` returns 422 `unknown_target` and no publish is
  attempted; a captured unit test asserts the constructed topic for a valid command exactly equals
  `arl/rta/dish-042/cmd/adjust_azimuth`.

#### 4.2.3 Numeric and structural bounds

| Input | Bound | Failure |
| :--- | :--- | :--- |
| `value` | per control, from `$topology` (`validateControlValue`) | 422 `invalid_value` |
| `limit` (series) | clamped 10…20 000 in the store | silently clamped, documented |
| `limit` (alerts/commands) | clamped at the route | silently clamped |
| `from`/`to` | must be finite integers, `from ≤ to`, span ≤ 7 days | 400 `invalid_request` |
| Batch `commands[]` | ≤ 200 entries | 400 `too_many_commands` |
| Replay speed | clamped to 0.1–64 by `clampSpeed()` (finite check, then clamp); the UI offers only 1 / 2 / 5 / 10 per the design system | silently clamped, documented |
| WS frame | `maxPayload` 1 MB; unknown `type` ignored | — |
| Alert `resolution` | 3–500 chars; `cause` from the vocabulary | 400 `invalid_cause` |

#### 4.2.4 JSON parsing and prototype pollution

- `JSON.parse` on WS frames is wrapped; a non-object result is rejected. Bodies go through
  `express.json` with the 64 kB limit, which does not itself protect against `__proto__` keys, so
  schemas use `z.object()` (strips unknown keys) rather than spreading request bodies into objects.
  A test asserts `{__proto__: {polluted: true}}` does not pollute `Object.prototype`.

### 4.3 Secrets and configuration

| Rule | Implementation |
| :--- | :--- |
| No credentials in code | `.env.example` contains only names; the README documents variables, never values |
| Secrets not committed | `.env`, `data/`, `*.sqlite*` are in `.gitignore`; a test asserts `.env` is ignored |
| Secrets not logged | The MQTT client logs host and port, never the password; connection errors are logged by class, not by URL-with-credentials |
| No secret in the browser | The web bundle receives none of `MQTT_BROKER_PASSWORD` or any API credential; the browser only talks to the platform's own origin |
| No default passwords | The broker is anonymous *by the lab's design*; the platform supports `MQTT_BROKER_USER/PASSWORD` and passes them through without inventing a default |
| Fail loudly on missing config | A missing `MQTT_BROKER_ADDRESS` is a startup error with a named variable, not a silent fallback to `localhost` in production |

**Acceptance.** `grep -ri "password" server/src web/src` returns only the config-reader lines and the
`.env.example` keys; the built bundle contains no secret.

### 4.4 Transport and exposure

| Decision | Reasoning |
| :--- | :--- |
| **No CORS middleware** | The console is served same-origin (static build) or via the Vite dev proxy. Adding `cors()` with `*` would let any page on the lab network command the plant using a visitor's browser. Absence is a decision, not an omission — it is stated here so it reads as one |
| **No TLS termination in the app** | TLS belongs at the edge; the platform binds to the interface named in config. The honest statement is that traffic is plaintext on the lab network, which is the lab's existing posture |
| **Bind address from config** | Default `0.0.0.0` for the test deployment (the other containers must reach it); documented so a deployment can narrow it |
| **No `TRUST_PROXY` by default** | Rate limiting and logged client addresses must not be spoofable via `X-Forwarded-For` unless a proxy is actually present |
| **Read-only posture toward the ARL API** | The platform never calls an API write endpoint. The live deployment rejects writes anyway; not using them at all is the stronger position |

### 4.5 Resource limits (a security control, not a performance one)

| Limit | Value | Why |
| :--- | :--- | :--- |
| HTTP body | 64 kB (existing) | Bounded parse cost |
| WS `maxPayload` | 1 MB (existing) | No frame can allocate unbounded memory |
| WS clients | 50, newest rejected with a close code | The console is single-user; 50 is generous headroom |
| WS pending queue per client | 5 000 frames, then drop oldest **non-alert** frames and set a `lagging` flag | The current `queue()` grows without bound for non-telemetry events |
| Replay watch sessions | 4 concurrent, TTL 10 min | Each holds a cursor and a decimation buffer |
| Backlog fetch | 5 000 000 rows is the API's own refusal; the platform additionally refuses a client request spanning > 7 days without an explicit confirm | A 5 M-row JSON array is a memory event |
| Verification calls | 20/s token bucket per client IP | Prevents the platform becoming an amplifier against the API |
| Series requests | Clamped limit + 7-day span cap (§4.2.3) | Bounded query cost |

**Acceptance.** A client that stops reading for 60 s accumulates ≤ 5 000 pending frames, keeps all
alert frames, loses telemetry, and sees a `lagging` indicator; a 51st WebSocket is refused.

### 4.6 Audit integrity (and why it is security)

- Alert and command rows are **append-only**; nothing is deleted, including resolved alerts and
  failed commands (`05` §4.2.1). The lifecycle is expressed by timestamps, not by overwriting state.
- Every command stores `researcher`, `sent_ts`, `sent_wall_ts`, `topic`, and the settled state; every
  alert stores `ack_by`/`resolved_by` with verification flags. Attribution is never inferred from
  the browser session.
- Scheduled and preset dispatches use `origin` (`command`/`schedule`) so the audit distinguishes a
  human from a rule. A machine is never recorded as a person.
- A failed command is as valuable as a successful one: the store keeps `reason` and `detail` verbatim.

**Acceptance.** Resolving an alert leaves `raised_ts < ack_ts < resolved_ts` with both codes; deleting
a row is impossible through any route.

### 4.7 What we deliberately do not do

| Temptation | Decision |
| :--- | :--- |
| Add a login | The UI/UX rubric explicitly wants a console "without sign in"; identity belongs to the command path, where it is enforced |
| Patch the simulator's broker auth | Out of scope and would break the test deployment |
| Add an `exec`/shell tool to the platform | Never; no code path spawns processes from user input |
| Proxy arbitrary URLs for the API | The API base is configuration only; no user-supplied URL is ever fetched (no SSRF surface) |
| Store the researcher's full record | Only `code`, `name`, `status`, `experiments` — what the API gives and the UI needs |
| Rewrite history for a defunct researcher | Never; the audit outlives the person's access |

---

## 5. Failure modes

| Failure | Symptom | Handling |
| :--- | :--- | :--- |
| ARL API down | Every command 503 | Fail closed by design; the UI says "cannot verify codes — commands disabled" |
| API returns a malformed verify body | Cannot decide | Treat as `api_unavailable`, fail closed, log the shape error |
| Code with control characters | Log injection, topic corruption | Reject at schema level (`^[a-z0-9-]{3,64}$`-style), never publish |
| Replay watch id invented | A stranger watches a session | Sessions are random ids, read-only, TTL 10 min; no command path is exposed by watching |
| Client floods `/api/series` | CPU saturation | Span cap, limit clamp, verification token bucket, and a 429 with `Retry-After` |
| Broker password misconfigured | Connection loop | Error logged by class only; the process stays up and reports `broker_disconnected` |
| Someone copies `.env.example` to `.env` and commits it | Secret leak | `.env` ignored; a test asserts the ignore rule; the README says never to commit it |

---

## 6. Test plan

| # | Test | Type |
| :--- | :--- | :--- |
| 1 | Unknown code → 403 `unknown_researcher`; defunct → `researcher_defunct`; wrong service → `researcher_not_permitted` with the API's reason | integration |
| 2 | API unreachable → 503 and zero MQTT publishes (assert on a fake bus) | unit |
| 3 | Verification cache: 2 calls in 60 s → 1 API call; 2 000 codes → ≤ 1 000 cached | unit |
| 4 | Entity/control injection attempts are rejected and no topic is constructed with `/`, `+`, `#` | unit |
| 5 | `value: ''` is rejected rather than coerced to 0 | unit |
| 6 | `__proto__` body does not pollute `Object.prototype` | unit |
| 7 | Batch of 201 commands → 400 `too_many_commands` | integration |
| 8 | Series span > 7 days → 400; `limit` clamped | integration |
| 9 | 51st WebSocket refused; lagging client drops telemetry but keeps alerts | integration |
| 10 | `grep`-based secrets test: no credential literal in `server/src` or the built bundle | integration |
| 11 | Audit invariants: `raised_ts < ack_ts < resolved_ts`, no delete route, `ack_verified` correct | integration |

---

## 7. Open decisions

| # | Decision | Recommendation |
| :--- | :--- | :--- |
| 1 | Reject a command whose researcher verified from cache but is now defunct? | Re-verify on any command that changes a safety-relevant state (`start_scan`, `cycle_airlock`, `start_generator`), even inside the TTL |
| 2 | Should `/api/alerts` and `/api/commands` require a researcher code? | No — the console is read-only by design and the rubric wants it open; state this explicitly rather than leaving it ambiguous |
| 3 | Rate-limit `/api/commands` per code or per IP? | Per code (a person cannot exceed the plant's patience) plus a coarse per-IP cap |
| 4 | TLS | Out of scope; state the assumption and the deployment note. Do not pretend |
| 5 | Should the platform detect a rogue publisher on the broker? | Yes, cheaply: an ack with an unknown `command_id` is logged as `unexpected_ack` — an early warning that someone else is publishing |