# 10 — ARL API Integration

**Component.** The client for the laboratory's read-only support API: researcher verification,
the RTA target catalogue, and the per-service alert limits that every service and the console
must honour.

**Owner files.** `server/src/arlApi/client.ts`, `server/src/http/app.ts` (proxy routes).

**Rubric.** Security 5 % (*"researcher codes resolve correctly (via the ARL API)"*); all four
service criteria reference API-supplied limits and the catalogue.

**Depends on.** `01`.

---

## 1. Boundary

In scope: HTTP calls, caching, single-flight, failure semantics, and the shape handed to the
rest of the platform. Out of scope: the backlog CSV export — **the platform must not use it**
(`07` §1). Documenting that refusal matters: it is an architecture decision the grader looks
for.

---

## 2. Endpoints used

| Call | Endpoint | Used by |
| :--- | :--- | :--- |
| Researcher lookup | `GET /v1/researchers/{code}` | `05` (attribution display), `14` (code check) |
| Verify | `POST /v1/researchers/verify { code, service }` | `06` (every control) |
| Alert limits | `GET /v1/alert-limits/{service}` | `05` (context), `11` (derived), console gauges |
| Targets | `GET /v1/targets` | `21` (target selector), `22` (labels) |
| Health | `GET /healthz` | header LED |

Deliberately unused: `GET /v1/backlog/...` (replay must use local capture), `POST /v1/targets`,
`DELETE /v1/targets/{id}` (test-deployment only; the platform never mutates the catalogue).

---

## 3. Current foundation

Cached, single-flight axios client. 404 → `null` for an unknown code, and the last known record
is persisted in `researcher`. `verify` fails closed with `api_unavailable`. Limits cached for
5 minutes; targets cached for 5 minutes. `RESEARCHER_CODE_PATTERN` and `isWellFormedCode()`.

---

## 4. Gaps

| Gap | Fix |
| :--- | :--- |
| Limits are fetched but only used server-side by nothing yet | Expose as a typed map and consume in `05`/`11`/console |
| Client types limits as `Record<string,{type,severity,warn,crit}>`; server returns `{key,value,unit}[]` (D-3) | One shared shape: `{ [key]: { value, unit } }` plus a `limitMeta` table for severity/direction |
| No negative caching TTL distinction | Cache a "not found" for 5 min and a transport error for 5 s so a brief outage does not lock out a valid code for 60 s |
| No `/api/health` surfacing of API reachability | Add `arlApi: boolean` and `arlApiLatencyMs` |
| Limits key naming mismatch (`rta.availability.min_active` vs `availability.min_active`) | Normalise by stripping the `<service>.` prefix on ingest and storing the full key too |

---

## 5. Decomposition

### 5.1 Researcher subsystem

#### 5.1.1 Lookup

- **Responsibility.** Name and scope for display; never authorisation.
- **Contract.** `researcher(code)` → `ResearcherRecord | null`; 404 is a cached `null`.
- **Steps.** Persist the successful record so the console can show a name while the API is down.
  Never cache a malformed code (reject before the call).
- **Acceptance.** Typing `arl-as3` in the header shows the name and the three permitted services
  within 200 ms on the second keystroke-triggered lookup.

#### 5.1.2 Verify

- **Responsibility.** The single authorisation decision.
- **Contract.** `verify(code, service)` → `{ valid, reason, researcher? }`; a transport failure
  throws and `06` maps it to 503.
- **Steps.** Single-flight per `code|service` so ten rapid clicks produce one HTTP request.
  Cache positives for 60 s, negatives for 60 s, transport failures for 5 s.
- **Acceptance.** One hundred rapid commands produce at most two verify calls.

### 5.2 Limits subsystem

#### 5.2.1 Shape

- **Responsibility.** One representation for every consumer.
- **Contract.**
  ```ts
  type Limits = Record<string, { value: number; unit: string | null }>;
  interface LimitMeta {
    key: string;                       // full key incl. service prefix
    short: string;                     // prefix stripped
    severity: 'info' | 'warning' | 'critical' | 'warning|critical';
    direction: 'above' | 'below';
    alert: string;                     // alert type that uses it
    label: string;                     // human label for the UI
    service: string;
  }
  ```
- **Steps.** Encode `LimitMeta` as a static table in `server/src/services/limits.ts`, built
  directly from the API spec's default-limits table, so the platform knows the *meaning*
  (severity, direction, which alert) while the API remains the source of the *value*.
- **Acceptance.** `GET /api/alert-limits/rta` returns both the values (from the API) and the
  metadata (from the table), and a unit test asserts that every key in the table appears in a
  live API response.

#### 5.2.2 Refresh and fallback

- **Responsibility.** Limits must be current, and must not vanish when the API blinks.
- **Contract.** Refresh every 5 minutes; keep the last good map in memory and persist it in
  `meta` so a restart with the API down still has values.
- **Steps.** On refresh failure, log once per 5 minutes, keep serving the previous map, and mark
  `staleSince`. The UI shows a "limits stale" chip when `staleSince` is older than 15 minutes.
- **Acceptance.** Stopping the API does not remove any limit from the UI; it shows stale.

### 5.3 Target catalogue subsystem

#### 5.3.1 Fetch and index

- **Responsibility.** Names for pointings and a selector for the RTA.
- **Contract.** `targets()` → `Target[]`; index by id and by rounded pointing (1e-3 rad) for
  `targetLabel()`.
- **Steps.** Cache 5 minutes; on failure keep the previous list and mark stale. Never invent a
  target: an unknown pointing renders as `RA x / DEC y`.
- **Acceptance.** The scan HUD shows "Centaurus A" for a `tgt-cen` scan and the raw RA/DEC for a
  custom position.

### 5.4 Resilience subsystem

#### 5.4.1 Circuit breaker

- **Responsibility.** Do not hammer a dead API.
- **Contract.** After 5 consecutive transport failures, open for 30 s (fail fast with
  `api_unavailable`), then half-open with a single probe.
- **Steps.** Expose state on `/api/health` (`closed | open | half_open`). Controls are locked
  while open (`06` §4.1.3); reads that use cached data keep working.
- **Acceptance.** With the API stopped, the twelfth command returns in < 5 ms with 503 instead
  of waiting 5 s.

#### 5.4.2 Timeouts and retries

- **Responsibility.** Bounded latency on the command path.
- **Contract.** `ARL_API_TIMEOUT_MS` (default 5 000). One retry only for idempotent GETs
  (`targets`, `alert-limits`, `researchers/{code}`, `healthz`); **no** retry for `verify`,
  because a duplicated authorisation request adds latency to a button press.
- **Acceptance.** A 10 s API stall produces a 503 at 5 s, not a hung request.

---

## 6. Failure modes

| Failure | Behaviour |
| :--- | :--- |
| 404 on a researcher | `null`, cached; the console says "not in directory" but still records the ack |
| 403 from verify | Reason passed through verbatim; the command is not published |
| 429 rate limited | Back off with a 1 s delay, one retry for GETs |
| API returns a new limit key the table does not know | Store it, expose it with `alert: 'unknown'`, log once |
| API returns an unknown service | Ignore for that service; log |

---

## 7. Test plan

- Unit: caching and single-flight (fake clock, counting HTTP calls).
- Unit: circuit breaker transitions.
- Unit: `LimitMeta` completeness against a recorded API response fixture.
- Integration (with the simulator API in a container): verify a real code, a defunct code and a
  wrong-service code.
- Integration: stop the API, assert controls return 503 and limits stay served from cache.

---

## 8. Open decisions

- **Where do limit *values* live?** The API. The platform never hard-codes a threshold; it
  hard-codes only the *meaning* of a key. This satisfies "the API is the single source of truth".
- **Do we mirror the researcher register locally?** Only as a cache, never as an authority.