# 02 — Topology Registry

**Component.** The subsystem that turns a service's retained `$topology` document into the
routing table the rest of the platform uses. It is what makes the platform generic: no
service entity list, stream name, control name or alert name is hard-coded anywhere else.

**Owner files.** `server/src/topology/registry.ts`, `server/src/types.ts`.

**Rubric.** Architecture 5 % — "services plug into the shared shell through a common
interface and are driven by the topic structure each service publishes, so a new service or
device needs limited changes".

**Depends on.** `01` (bus, config), `04` (topology persistence).

---

## 1. Boundary

In scope: parsing, indexing, validating and describing the `$topology` document; validating
a proposed control value against the declared schema. Out of scope: subscribing to the topic
(`03`), persisting the JSON (`04`), deciding whether a command is *allowed* (`06`).

> **Discovery is `$topology`, and nothing else.** There is no `arl/+/discovery` topic in the ARL.
> The retained `arl/<svc>/$topology` document is the only discovery mechanism: it is per service,
> versioned, re-published whenever entities, streams or controls change, and delivered to every
> new subscriber because it is retained. An implementation that waits for a `discovery` topic
> subscribes to nothing and discovers nothing — it will look connected and see no entities. This
> is stated first because the topic name appears in informal architecture descriptions and is
> wrong every time it does.

---

## 2. Current foundation

`ServiceTopology` normalises the raw document into `entities[]`, `streams[]`, `state[]`,
`events[]`, `controls[]`, each indexed by topic pattern. `lookup()` tolerates both wildcard
and exact spellings of a topic. `matchTelemetry/State/Event/Ack` return the normalised def
or `undefined`. `validateControlValue()` enforces per-type rules: bool, enum membership,
string length ≤ 64, float/integer with min/max, timestamp, and object with strict known
fields plus required fields. `set()` reports `changed` by comparing version and entity count.
`describe()` produces a compact summary for the console.

---

## 3. Gaps

| Gap | Effect | Fix |
| :--- | :--- | :--- |
| No schema validation of the document itself | A malformed `$topology` produces confusing downstream `undefined`s | Validate with `zod` on arrival; reject with a named error and keep the previous version |
| Change detection uses version + entity count | A change in controls or fields with the same count goes undetected | Hash the normalised structure |
| No per-service "capability" accessors | Every caller re-implements "find the scan stream" | Add a `ServiceAdapter` interface (see §4.4) |
| `validateControlValue` ignores numeric strings | The UI sends `"0.01"` from a text input and it is rejected as a type error | Coerce numeric strings for `float`/`integer` before validation |
| No cross-check against the ARL API | A control declared by the service but unknown to the platform is silently unsendable | Not needed; the registry is the authority. Document this. |

---

## 4. Decomposition

### 4.1 Document parsing subsystem

#### 4.1.1 Normaliser

- **Responsibility.** Convert the raw JSON into the internal `ServiceTopology` shape
  exactly once, tolerating field ordering and optional members.
- **Contract.** Input: `{ version?, entities?, streams?, state?, events?, controls? }` where
  each array member may use either `topic` (with `.` or `/` separators) or explicit
  `entity`/`stream`/`item` fields. Output: indexed structures plus a `raw` copy.
- **Steps.**
  1. Derive `service` from the topic prefix `arl/<service>/...`, not from the document body.
  2. Normalise topic separators to `/`.
  3. For a stream, derive `entityKinds` and `periodS` if absent by inspecting `fields`.
  4. For a control, derive `entityKinds` from the topic pattern segment.
  5. Keep the raw document for the `GET /api/services/:service/topology` passthrough.
- **Acceptance.** Feeding the retained documents captured from live `arl-rta`, `arl-mhe`,
  `arl-opg` produces non-empty `entities`, `streams`, `controls` for all three, and
  `describe()` lists every control name.

#### 4.1.2 Schema validation

- **Responsibility.** Reject an unusable document loudly instead of half-adopting it.
- **Contract.** A `zod` schema over the normalised shape. On failure: log the offending
  path, keep the previous topology, raise a platform alert `topology_invalid` (info).
- **Steps.** Validate that every `controls[].value` has a `type` in the allowed set; every
  `streams[].fields[]` has `key` and `type`; every `states[]` has `entity`, `item`, `type`.
- **Acceptance.** A document with a control missing `type` raises `topology_invalid` and
  leaves the previous routing table intact (a known control still works).

#### 4.1.3 Change detection

- **Responsibility.** Tell the platform when routing changed, including within a stream or
  control set.
- **Contract.** `set()` returns `{ changed: boolean, version, entityCount }`.
- **Steps.** Compute a stable hash over `JSON.stringify` of the sorted, normalised
  structures (sort arrays by topic before hashing so ordering is not a false positive).
- **Acceptance.** Re-publishing an identical document reports `changed: false`; adding a
  single control reports `changed: true`.

### 4.2 Indexing subsystem

#### 4.2.1 Pattern indexes

- **Responsibility.** Answer "is this topic a known stream/state/event?" in O(1)–O(k).
- **Contract.** Three maps keyed by the concrete topic and by the pattern with `<entity>`
  wildcards; `lookup()` tries the concrete topic first, then each pattern whose literal
  prefix matches.
- **Steps.** Precompute `prefix` (everything before the first wildcard segment) per pattern
  and bucket by prefix length descending; iterate only matching buckets.
- **Acceptance.** 100 dishes × 2 streams + 9 rooms × 4 streams resolves in under 50 µs per
  message on the dev machine (measured in `51` as a benchmark, not a hard test).

#### 4.2.2 Entity catalogue

- **Responsibility.** Provide the entity list with `meta` for the UI (dish `row`/`col`/
  `lat`/`lon`, room volume, plant capacity).
- **Contract.** `entitiesOf(kind)` and `entity(id)`.
- **Steps.** `replaceEntities` on `04` persists the list so a cold start has it before the
  next retained publish; set `online = 1` when a topology arrives.
- **Acceptance.** After a cold start with all services running, `/api/services` returns
  `rta:100` dishes, `mhe:9` rooms + 5 crew + global, `opg:4` entities, all with `meta`.

#### 4.2.3 Capability accessors

- **Responsibility.** Give service code a stable way to ask "what is this service's scan
  stream / power stream / environment stream?" without string matching in five places.
- **Contract.**
  ```ts
  interface Capabilities {
    primaryStream: StreamDef | null;      // scan > normal for rta; power / environment / vitals
    periodicStreams: StreamDef[];
    controlsByEntityKind: Map<string, ControlDef[]>;
    alertLimitKeys: string[];             // from observed alert payloads, see 05 — the
                                          // topology names controls, not limit keys; the
                                          // ARL API is the single source of truth for those
  }
  ```
- **Steps.** Implement in `11` (`serviceAdapters.ts`), consuming the registry; the registry
  itself stays service-agnostic. The registry exposes only generic queries.
- **Acceptance.** Deleting every service adapter file leaves the registry compiling.

### 4.3 Control-value subsystem

#### 4.3.1 Value coercion

- **Responsibility.** Accept the shapes a browser or a human actually sends, then validate
  strictly.
- **Contract.** `validateControlValue(def, value)` → `{ ok: true, value } | { ok: false, error }`.
- **Steps.**
  1. For `float`/`integer`, accept a numeric string matching `/^-?\d+(\.\d+)?$/` and coerce.
  2. For `bool`, accept `true|false|"true"|"false"|1|0`.
  3. For `timestamp`, accept ISO-8601 strings and coerce to ms.
  4. For `object`, reject unknown fields and report the first one by name
     (`unknown field "volume"`); enforce `required` fields; recurse into field types.
  5. For `enum`, report the allowed values in the error.
- **Acceptance.** `{ temperature_k: "295" }` is accepted for a float field; `{ temperature_k: 295, extra: 1 }`
  is rejected naming `extra`; `48.2` for a `0–1` ratio field is rejected with the range.

#### 4.3.2 Control availability

- **Responsibility.** Tell the UI whether a control is currently meaningful, without
  pretending to know the service's preconditions.
- **Contract.** `availability(def, currentState)` returns
  `{ enabled: boolean, hint?: string }` based on *platform-known* facts only (e.g. the
  entity is offline; the control requires a target and none is set; the scan is running and
  the control is marked "not while scanning").
- **Steps.** Encode the "not while scanning" / "not while stowed" rules from the specs as a
  small declarative table in `21`/`31`/`41`, not in the registry. The registry only exposes
  the raw def; the adapter supplies semantics.
- **Acceptance.** With `main.scan_state = running`, `set_target` renders disabled with the
  hint "not while scanning", and the service would reject it anyway if forced.

### 4.4 Service adapter interface (the plug point)

- **Responsibility.** The single extension point a new ARL service implements.
- **Contract.** Declared in `server/src/types.ts`, implemented per service in
  `server/src/services/<svc>.ts`:
  ```ts
  interface ServiceAdapter {
    code: 'rta' | 'mhe' | 'opg' | string;
    label: string;
    accent: string;                       // design-system hue
    /** Entities the platform should treat as "the thing being operated". */
    focalEntities(topology: ServiceTopology): string[];
    /** Alerts whose absence is itself a fault (e.g. crew vitals silence). */
    expectedPeriodic(topology: ServiceTopology): { entity: string; stream: string; periodS: number }[];
    /** Derived measures this service can answer. */
    measures: MeasureDef[];
  }
  ```
- **Steps.** Register adapters in a `Map<code, adapter>` at boot; unknown service codes get
  a null adapter and the platform still ingests them (that is the point of the shell).
- **Acceptance.** `ARL_SERVICES=rta,mhe,opg,owt` ingests OWT telemetry with no adapter and no
  crash; the console lists it in the header health counters but shows no workspace page.

---

## 5. Data contracts

```ts
// The registry's public surface. Nothing outside may touch internal maps.
interface TopologyRegistry {
  set(service: string, raw: unknown, ts: number): { changed: boolean; version: number };
  get(service: string): ServiceTopology | undefined;
  services(): string[];
  matchTelemetry(topic: string): { service: string; def: StreamDef; entity: string } | null;
  matchState(topic: string): { service: string; def: StateDef; entity: string; item: string } | null;
  matchEvent(topic: string): { service: string; def: EventDef; kind: string } | null;
  controlFor(entityKind: string, control: string): ControlDef | null;
  controlsForEntity(entityId: string): ControlDef[];
  validateControlValue(def: ControlDef, value: unknown): ValidationResult;
  describe(service: string): { entities: number; streams: number; controls: number; version: number };
}
```

---

## 6. Failure modes

| Failure | Behaviour |
| :--- | :--- |
| `$topology` arrives after telemetry (orphans held in `03`) | Registry records, ingest drains the orphan buffer for that service |
| `$topology` arrives malformed | Previous topology kept; `topology_invalid` raised once per version |
| `$topology` re-published with a new sub-array | `changed: true`; `replaceEntities`; UI re-renders the dish matrix from `meta` |
| A sub-array is removed and its retained state topics are cleared | Empty retained message → state row with `value: null`; registry keeps the entity until the next `$topology` |
| Control exists but the entity is unknown | `06` returns 422 `unknown_target` before any publish |

---

## 7. Test plan

- Fixture-based unit tests with the three captured `$topology` documents committed under
  `server/test/fixtures/topology/`.
- Round-trip: normalise → hash → normalise again → same hash.
- Negative: 8 malformed documents, each asserting a specific error path.
- Property: for every control in every fixture, `validateControlValue` accepts a value built
  from its own schema and rejects the same value with one field removed or one type flipped.

---

## 8. Open decisions

- **Where do service-specific rules live?** In adapters (`11`), never in the registry. The
  registry must remain installable for a service nobody planned for.
- **Do we re-emit `$topology` to the console verbatim?** Yes — `GET /api/services/:service/topology`
  returns the raw document, so the console can show "what the service says about itself",
  which is the architecture story.