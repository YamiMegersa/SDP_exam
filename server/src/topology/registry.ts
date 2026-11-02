import type {
  ControlDef,
  EntityDef,
  EventDef,
  FieldDef,
  StateDef,
  StreamDef,
  ValueSchema,
} from '../types';

interface RawTopology {
  v?: number;
  service?: string;
  version?: string;
  entities?: Array<Record<string, unknown>>;
  streams?: Array<Record<string, unknown>>;
  state?: Array<Record<string, unknown>>;
  events?: Array<Record<string, unknown>>;
  controls?: Array<Record<string, unknown>>;
}

/**
 * A service's published `$topology`, normalised.
 *
 * Everything downstream (ingestion routing, topic validation, control forms, charts) is driven by
 * this description rather than by hand-written per-service knowledge, so a new device or a new
 * service needs no ingestion change.
 */
export class ServiceTopology {
  readonly service: string;
  readonly version: string;
  readonly entities: EntityDef[];
  readonly entityById: Map<string, EntityDef>;
  readonly streams: StreamDef[];
  readonly states: StateDef[];
  readonly events: EventDef[];
  readonly controls: ControlDef[];

  private readonly streamByPattern = new Map<string, StreamDef>();
  private readonly stateByPattern = new Map<string, StateDef>();
  private readonly controlByPattern = new Map<string, ControlDef>();
  private readonly eventKinds = new Set<string>();

  constructor(raw: RawTopology) {
    if (!raw || typeof raw !== 'object') throw new Error('topology payload is not an object');
    if (typeof raw.service !== 'string' || !raw.service) {
      throw new Error('topology payload has no service code');
    }
    this.service = raw.service;
    this.version = String(raw.version ?? '0');

    this.entities = (raw.entities ?? []).flatMap((e) => {
      if (typeof e.id !== 'string') return [];
      const { id, kind, ...meta } = e as { id: string; kind?: string } & Record<string, unknown>;
      return [{ id, kind: typeof kind === 'string' ? kind : 'unknown', meta }];
    });
    this.entityById = new Map(this.entities.map((e) => [e.id, e]));

    this.streams = (raw.streams ?? []).flatMap((s) => {
      if (typeof s.topic !== 'string') return [];
      const segments = s.topic.split('/');
      return [
        {
          topic: s.topic,
          stream: segments[segments.length - 1]!,
          entityKinds: asStringArray(s.entity_kinds),
          periodS: typeof s.period_s === 'number' ? s.period_s : undefined,
          fields: asFields(s.fields),
        },
      ];
    });

    this.states = (raw.state ?? []).flatMap((s) => {
      if (typeof s.topic !== 'string') return [];
      const segments = s.topic.split('/');
      return [
        {
          topic: s.topic,
          entity: segments[2]!,
          item: segments[4]!,
          type: (s.type as StateDef['type']) ?? 'string',
          unit: typeof s.unit === 'string' ? s.unit : undefined,
        },
      ];
    });

    this.events = (raw.events ?? []).flatMap((e) => {
      if (typeof e.topic !== 'string') return [];
      const segments = e.topic.split('/');
      return [{ topic: e.topic, kind: segments[segments.length - 1]! }];
    });

    this.controls = (raw.controls ?? []).flatMap((c) => {
      if (typeof c.topic !== 'string') return [];
      const segments = c.topic.split('/');
      return [
        {
          topic: c.topic,
          control: segments[segments.length - 1]!,
          entityKinds: asStringArray(c.entity_kinds),
          value: (c.value as ValueSchema) ?? { type: 'string' },
        },
      ];
    });

    for (const s of this.streams) this.streamByPattern.set(s.topic, s);
    for (const s of this.states) this.stateByPattern.set(s.topic, s);
    for (const c of this.controls) this.controlByPattern.set(c.topic, c);
    for (const e of this.events) this.eventKinds.add(e.kind);
  }

  kindOf(entity: string): string | undefined {
    return this.entityById.get(entity)?.kind;
  }

  entitiesOfKind(kind: string): EntityDef[] {
    return this.entities.filter((e) => e.kind === kind);
  }

  hasEventKind(kind: string): boolean {
    return this.eventKinds.has(kind);
  }

  /** `arl/<svc>/<entity>/telemetry/<stream>` -> stream definition (entity replaced by `+`). */
  matchTelemetry(topic: string): { def: StreamDef; entity: string } | null {
    const seg = topic.split('/');
    if (seg.length !== 5 || seg[3] !== 'telemetry') return null;
    const def = this.lookup(this.streamByPattern, `${seg[0]}/${seg[1]}/+/telemetry/${seg[4]}`, topic);
    return def ? { def, entity: seg[2]! } : null;
  }

  /** `arl/<svc>/<entity>/state/<item>` -> state definition. */
  matchState(topic: string): { def: StateDef; entity: string } | null {
    const seg = topic.split('/');
    if (seg.length !== 5 || seg[3] !== 'state') return null;
    const def = this.lookup(this.stateByPattern, `${seg[0]}/${seg[1]}/+/state/${seg[4]}`, topic);
    return def ? { def, entity: seg[2]! } : null;
  }

  /**
   * Topologies describe some items generically (`arl/rta/+/state/commanded`) and some exactly
   * (`arl/rta/global/state/online`), so both spellings have to be honoured.
   */
  private lookup<T>(map: Map<string, T>, wildcard: string, exact: string): T | undefined {
    return map.get(wildcard) ?? map.get(exact);
  }

  matchEvent(topic: string): { kind: string } | null {
    const seg = topic.split('/');
    if (seg.length !== 4 || seg[2] !== 'events') return null;
    return { kind: seg[3]! };
  }

  matchAck(topic: string): { commandId: string } | null {
    const seg = topic.split('/');
    if (seg.length !== 4 || seg[2] !== 'ack') return null;
    return { commandId: seg[3]! };
  }

  controlFor(entity: string, control: string): ControlDef | null {
    // Control topics are arl/<svc>/cmd/<entity>/<control> and the topology wildcards the entity.
    const def =
      this.controlByPattern.get(`arl/${this.service}/cmd/+/${control}`) ??
      this.controlByPattern.get(`arl/${this.service}/cmd/${entity}/${control}`);
    if (!def) return null;
    const kind = this.kindOf(entity);
    if (def.entityKinds.length > 0 && kind && !def.entityKinds.includes(kind)) return null;
    return def;
  }

  controlsForEntity(entity: string): ControlDef[] {
    const kind = this.kindOf(entity);
    return this.controls.filter(
      (c) => c.entityKinds.length === 0 || (kind !== undefined && c.entityKinds.includes(kind)),
    );
  }

  /** Compact description for the browser: enough to render panels and control forms. */
  describe(): Record<string, unknown> {
    return {
      service: this.service,
      version: this.version,
      entities: this.entities,
      streams: this.streams,
      states: this.states,
      events: this.events,
      controls: this.controls,
    };
  }
}

/** Holds the current topology of every configured service. */
export class TopologyRegistry {
  private readonly byService = new Map<string, ServiceTopology>();

  constructor(private readonly configured: string[]) {}

  get services(): string[] {
    return [...this.configured];
  }

  accepts(service: string): boolean {
    return this.configured.includes(service);
  }

  get(service: string): ServiceTopology | undefined {
    return this.byService.get(service);
  }

  all(): ServiceTopology[] {
    return [...this.byService.values()];
  }

  set(raw: unknown): { topology: ServiceTopology; changed: boolean } {
    const topology = new ServiceTopology(raw as RawTopology);
    const previous = this.byService.get(topology.service);
    this.byService.set(topology.service, topology);
    return {
      topology,
      changed: !previous || previous.version !== topology.version ||
        previous.entities.length !== topology.entities.length,
    };
  }
}

/** Validates a control value against the schema published in `$topology`. */
export function validateControlValue(
  schema: ValueSchema,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const type = schema.type;

  if (type === 'bool') {
    if (typeof value === 'boolean') return { ok: true, value };
    return { ok: false, error: 'expected a boolean' };
  }
  if (type === 'enum') {
    const values = schema.values ?? [];
    if (typeof value === 'string' && values.includes(value)) return { ok: true, value };
    return { ok: false, error: `expected one of ${values.join(', ')}` };
  }
  if (type === 'string') {
    if (typeof value === 'string' && value.length > 0 && value.length <= 64) {
      return { ok: true, value };
    }
    return { ok: false, error: 'expected a non-empty string (max 64 characters)' };
  }
  if (type === 'float' || type === 'integer') {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return { ok: false, error: 'expected a number' };
    if (schema.min !== undefined && n < schema.min) {
      return { ok: false, error: `must be at least ${schema.min}${schema.unit ?? ''}` };
    }
    if (schema.max !== undefined && n > schema.max) {
      return { ok: false, error: `must be at most ${schema.max}${schema.unit ?? ''}` };
    }
    if (type === 'integer' && !Number.isInteger(n)) return { ok: false, error: 'expected a whole number' };
    return { ok: true, value: n };
  }
  if (type === 'timestamp') {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return { ok: false, error: 'expected a Unix millisecond timestamp' };
    }
    return { ok: true, value: n };
  }
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, error: 'expected an object' };
    }
    const fields = schema.fields ?? [];
    const input = value as Record<string, unknown>;
    const known = new Set(fields.map((f) => f.key));
    for (const key of Object.keys(input)) {
      if (!known.has(key)) return { ok: false, error: `unexpected field "${key}"` };
    }
    const out: Record<string, unknown> = {};
    for (const field of fields) {
      const raw = input[field.key];
      if (raw === undefined || raw === null || raw === '') {
        return { ok: false, error: `missing field "${field.key}"` };
      }
      const checked = validateField(field, raw);
      if (!checked.ok) return { ok: false, error: `${field.key}: ${checked.error}` };
      out[field.key] = checked.value;
    }
    return { ok: true, value: out };
  }
  return { ok: false, error: `unsupported control type "${String(type)}"` };
}

function validateField(
  field: FieldDef,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  switch (field.type) {
    case 'float':
    case 'integer': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return { ok: false, error: 'expected a number' };
      return { ok: true, value: n };
    }
    case 'bool':
      return typeof value === 'boolean'
        ? { ok: true, value }
        : { ok: false, error: 'expected a boolean' };
    case 'enum': {
      const values = field.values ?? [];
      return typeof value === 'string' && values.includes(value)
        ? { ok: true, value }
        : { ok: false, error: `expected one of ${values.join(', ')}` };
    }
    default:
      return typeof value === 'string'
        ? { ok: true, value }
        : { ok: false, error: 'expected a string' };
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function asFields(value: unknown): FieldDef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((f) => {
    if (!f || typeof f !== 'object') return [];
    const rec = f as Record<string, unknown>;
    if (typeof rec.key !== 'string') return [];
    return [
      {
        key: rec.key,
        type: (rec.type as FieldDef['type']) ?? 'float',
        unit: typeof rec.unit === 'string' ? rec.unit : undefined,
        values: asStringArray(rec.values),
      },
    ];
  });
}
