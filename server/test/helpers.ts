import type { AlertLimit } from '../src/arlApi/client';
import { loadConfig, type Config } from '../src/config';
import type { Store } from '../src/db/store';
import { TopologyRegistry } from '../src/topology/registry';

/** A config that needs neither a broker nor a reachable ARL API. */
export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    MQTT_BROKER_ADDRESS: '127.0.0.1',
    MQTT_BROKER_PORT: '1883',
    ARL_API_ADDRESS: '127.0.0.1',
    ARL_API_PORT: '8080',
    ...overrides,
  } as NodeJS.ProcessEnv);
}

/**
 * Topologies shaped like the real `$topology` payloads: entities carry a `kind`, streams and
 * controls wildcard the entity, and some state items are declared exactly for one entity.
 */
export const RTA_TOPOLOGY = {
  v: 1,
  service: 'rta',
  version: 'test-1',
  entities: [
    { id: 'global', kind: 'global' },
    { id: 'dish-001', kind: 'dish', row: 1, col: 1 },
    { id: 'dish-002', kind: 'dish', row: 1, col: 2 },
    { id: 'dish-003', kind: 'dish', row: 2, col: 1 },
    { id: 'dish-004', kind: 'dish', row: 2, col: 2 },
  ],
  streams: [
    {
      topic: 'arl/rta/+/telemetry/normal',
      entity_kinds: ['dish'],
      period_s: 120,
      fields: [
        { key: 'status', type: 'bool' },
        { key: 'azimuth_rad', type: 'float' },
        { key: 'elevation_rad', type: 'float' },
      ],
    },
    {
      topic: 'arl/rta/+/telemetry/scan',
      entity_kinds: ['dish'],
      period_s: 1,
      fields: [
        { key: 'status', type: 'bool' },
        { key: 'scan_id', type: 'string' },
        { key: 'scan_progress', type: 'float' },
      ],
    },
  ],
  state: [
    { topic: 'arl/rta/+/state/commanded', type: 'object' },
    { topic: 'arl/rta/global/state/online', type: 'bool' },
  ],
  events: [{ topic: 'arl/rta/events/alert' }],
  controls: [
    {
      topic: 'arl/rta/cmd/+/target',
      entity_kinds: ['dish'],
      value: { type: 'string' },
    },
  ],
};

export const MHE_TOPOLOGY = {
  v: 1,
  service: 'mhe',
  version: 'test-1',
  entities: [
    { id: 'global', kind: 'global' },
    { id: 'room-1', kind: 'room' },
    { id: 'room-2', kind: 'room' },
    { id: 'room-3', kind: 'room' },
    { id: 'crew-1', kind: 'crew' },
    { id: 'crew-2', kind: 'crew' },
    { id: 'crew-3', kind: 'crew' },
  ],
  streams: [
    {
      topic: 'arl/mhe/+/telemetry/environment',
      entity_kinds: ['room'],
      period_s: 10,
      fields: [
        { key: 'crew_count', type: 'integer' },
        { key: 'co2_ppm', type: 'float' },
      ],
    },
    {
      topic: 'arl/mhe/+/telemetry/vitals',
      entity_kinds: ['crew'],
      period_s: 60,
      fields: [{ key: 'heart_rate_bpm', type: 'float' }],
    },
  ],
  state: [{ topic: 'arl/mhe/+/state/airlock', type: 'enum', values: ['open', 'sealed'] }],
  events: [{ topic: 'arl/mhe/events/survey' }],
  controls: [
    {
      topic: 'arl/mhe/cmd/+/scrubber',
      entity_kinds: ['room'],
      value: { type: 'bool' },
    },
  ],
};

export const OPG_TOPOLOGY = {
  v: 1,
  service: 'opg',
  version: 'test-1',
  entities: [
    { id: 'global', kind: 'global' },
    { id: 'solar', kind: 'solar' },
    { id: 'diesel', kind: 'diesel' },
    { id: 'batteries', kind: 'batteries' },
  ],
  streams: [
    {
      topic: 'arl/opg/+/telemetry/power',
      entity_kinds: ['global', 'solar', 'diesel', 'batteries'],
      period_s: 5,
      fields: [{ key: 'power_output_w', type: 'float' }],
    },
  ],
  state: [{ topic: 'arl/opg/+/state/reserve_pct', type: 'float' }],
  events: [{ topic: 'arl/opg/events/alert' }],
  controls: [
    {
      topic: 'arl/opg/cmd/+/shed_load',
      value: { type: 'enum', values: ['none', 'non_essential', 'all'] },
    },
  ],
};

export const TOPOLOGIES = [RTA_TOPOLOGY, MHE_TOPOLOGY, OPG_TOPOLOGY];

/** The limits the live ARL API publishes, reduced to the keys the derived measures consult. */
export const LIMITS: Record<string, AlertLimit[]> = {
  rta: [{ key: 'availability.min_active', value: 80, unit: 'dishes' }],
  mhe: [
    { key: 'air.co2_warn_ppm', value: 1500, unit: 'ppm' },
    { key: 'air.co2_crit_ppm', value: 2500, unit: 'ppm' },
  ],
  opg: [{ key: 'battery.warn_pct', value: 30, unit: '%' }],
};

export function registryWithTopologies(): TopologyRegistry {
  const registry = new TopologyRegistry(['rta', 'mhe', 'opg']);
  for (const topology of TOPOLOGIES) registry.set(topology);
  return registry;
}

export interface SeedTelemetry {
  service: string;
  entity: string;
  stream: string;
  ts: number;
  seq?: number | null;
  backfill?: boolean;
  data: Record<string, unknown>;
}

export function writeTelemetry(store: Store, rows: SeedTelemetry[]): void {
  store.writeBatch({
    telemetry: rows.map((row) => ({
      service: row.service,
      entity: row.entity,
      stream: row.stream,
      ts: row.ts,
      seq: row.seq ?? null,
      recvTs: 1_700_000_000_000,
      backfill: row.backfill ?? false,
      data: row.data,
    })),
    states: [],
    events: [],
    gaps: [],
  });
}

export function writeStates(
  store: Store,
  rows: Array<{ service: string; entity: string; item: string; ts: number; value: unknown }>,
): void {
  store.writeBatch({
    telemetry: [],
    states: rows.map((row) => ({
      service: row.service,
      entity: row.entity,
      item: row.item,
      ts: row.ts,
      seq: null,
      recvTs: 1_700_000_000_000,
      value: row.value,
    })),
    events: [],
    gaps: [],
  });
}

export function writeEvents(
  store: Store,
  rows: Array<{ service: string; entity?: string | null; kind: string; ts: number; payload?: Record<string, unknown> }>,
): void {
  store.writeBatch({
    telemetry: [],
    states: [],
    events: rows.map((row) => ({
      service: row.service,
      entity: row.entity ?? null,
      kind: row.kind,
      ts: row.ts,
      seq: null,
      recvTs: 1_700_000_000_000,
      payload: row.payload ?? {},
    })),
    gaps: [],
  });
}

/** Raw row counts, used where the assertion is about what was written rather than what is returned. */
export function countRows(store: Store, table: 'telemetry' | 'state_change' | 'event' | 'alert' | 'alert_transition' | 'ingest_gap' | 'entity'): number {
  const row = store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  return row.n;
}

export function alertPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    alert_id: 'rta/dish-001/temperature',
    type: 'temperature_high',
    severity: 'warning',
    state: 'raised',
    value: 71.5,
    limit: 70,
    unit: 'C',
    message: 'Dish 1 running hot',
    ts: 1_000,
    ...overrides,
  };
}
