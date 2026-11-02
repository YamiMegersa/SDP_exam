import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AlertEngine } from '../src/alerts/engine';
import { Store } from '../src/db/store';
import { Ingest } from '../src/mqtt/ingest';
import { Bus } from '../src/platform/bus';
import type { PlatformEvent } from '../src/platform/events';
import { TopologyRegistry } from '../src/topology/registry';
import { SimClock } from '../src/util/clock';
import { RTA_TOPOLOGY, countRows, testConfig } from './helpers';

let store: Store;
let registry: TopologyRegistry;
let ingest: Ingest;

beforeEach(() => {
  store = new Store(':memory:');
  registry = new TopologyRegistry(['rta', 'mhe', 'opg']);
  const clock = new SimClock();
  const alerts = new AlertEngine(store, new Bus<PlatformEvent>(), clock, {
    services: ['rta', 'mhe', 'opg'],
    silenceMs: 60_000,
  });
  ingest = new Ingest(testConfig(), registry, store, new Bus<PlatformEvent>(), clock, alerts);
});

afterEach(() => {
  store.close();
});

/**
 * Drives the ingest path the way the broker does: a topic string and a payload buffer. `receive` is
 * private because production only ever calls it from `mqtt.js`; the seam here is deliberate.
 */
const deliver = (topic: string, payload: unknown): void => {
  const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  (ingest as unknown as { receive(t: string, p: Buffer): void }).receive(topic, buffer);
};

/** The flusher is a 250 ms timer in production; tests fire it explicitly. */
const flush = (): void => (ingest as unknown as { flush(): void }).flush();

const envelope = (fields: Record<string, unknown>) => ({ v: 1, ts: 1_000, ...fields });

describe('topology-driven ingestion', () => {
  it('holds samples that outrun their topology, then routes them when it lands', () => {
    deliver('arl/rta/dish-001/telemetry/normal', envelope({ seq: 1, status: true, azimuth_rad: 1 }));
    flush();

    // Nothing can be routed yet, but the message is not lost.
    expect(countRows(store, 'telemetry')).toBe(0);
    expect(ingest.counters.received).toBe(1);

    deliver('arl/rta/$topology', RTA_TOPOLOGY);
    flush();

    expect(countRows(store, 'telemetry')).toBe(1);
    expect(countRows(store, 'entity')).toBe(5);
    expect(store.topologyJson('rta')).toContain('"version":"test-1"');

    const row = store.db.prepare('SELECT entity, stream, ts, seq, data FROM telemetry').get() as {
      entity: string;
      stream: string;
      ts: number;
      seq: number;
      data: string;
    };
    expect(row).toMatchObject({ entity: 'dish-001', stream: 'normal', ts: 1_000, seq: 1 });
    // The envelope is stripped: only the sample itself is stored.
    expect(JSON.parse(row.data)).toEqual({ status: true, azimuth_rad: 1 });
  });

  it('routes only the streams the topology declares', () => {
    deliver('arl/rta/$topology', RTA_TOPOLOGY);
    deliver('arl/rta/dish-001/telemetry/scan', envelope({ seq: 1, status: true, scan_id: 'scan-0001' }));
    deliver('arl/rta/dish-001/telemetry/invented', envelope({ seq: 2, status: true }));
    flush();

    expect(countRows(store, 'telemetry')).toBe(1);
    expect(store.db.prepare('SELECT stream FROM telemetry').get()).toEqual({ stream: 'scan' });
  });

  it('ignores a service it is not configured for, including its topology', () => {
    deliver('arl/lwm/$topology', { service: 'lwm', version: '1', entities: [{ id: 'water-1', kind: 'tank' }] });
    deliver('arl/lwm/water-1/telemetry/flow', envelope({ seq: 1, flow_lpm: 12 }));
    flush();

    expect(registry.get('lwm')).toBeUndefined();
    expect(countRows(store, 'telemetry')).toBe(0);
    expect(ingest.counters.received).toBe(0);
  });

  it('survives an unparseable topology payload without losing the broker session', () => {
    deliver('arl/rta/$topology', Buffer.from('{ not json'));
    expect(registry.get('rta')).toBeUndefined();

    deliver('arl/rta/$topology', RTA_TOPOLOGY);
    expect(registry.get('rta')?.version).toBe('test-1');
  });
});

describe('sequence-gap tracking', () => {
  it('records the missed samples and raises a platform alert', () => {
    deliver('arl/rta/$topology', RTA_TOPOLOGY);
    for (const seq of [1, 2, 5]) {
      deliver('arl/rta/dish-001/telemetry/normal', envelope({ seq, ts: 1_000 + seq, status: true }));
    }
    flush();

    const gap = store.db.prepare('SELECT * FROM ingest_gap').get() as Record<string, unknown>;
    expect(gap).toMatchObject({
      service: 'rta',
      stream: 'normal',
      expected_seq: 3,
      received_seq: 5,
      missed: 2,
    });
    expect(ingest.counters.gaps).toBe(1);
    expect(store.getAlert('platform/rta/ingest-gap')).toMatchObject({
      status: 'raised',
      severity: 'info',
    });
  });

  it('keeps one counter per topic, so interleaved dishes are not gaps', () => {
    deliver('arl/rta/$topology', RTA_TOPOLOGY);
    // Found by the controls-rta drill: dishes that were not scanning kept counting while the
    // others paused, and a single per-stream counter read that as missed samples.
    for (const [dish, seq] of [['dish-001', 1], ['dish-002', 1], ['dish-002', 2], ['dish-002', 3], ['dish-001', 2], ['dish-002', 4]] as const) {
      deliver(`arl/rta/${dish}/telemetry/normal`, envelope({ seq, ts: 1_000 + seq, status: true }));
    }
    flush();

    expect(countRows(store, 'ingest_gap')).toBe(0);
    expect(ingest.counters.gaps).toBe(0);
  });

  it('does not track gaps on backfilled samples', () => {
    deliver('arl/rta/$topology', RTA_TOPOLOGY);
    deliver('arl/rta/dish-001/telemetry/normal', envelope({ seq: 1, backfill: true, status: true }));
    deliver('arl/rta/dish-001/telemetry/normal', envelope({ seq: 90, backfill: true, status: true }));
    flush();

    expect(countRows(store, 'ingest_gap')).toBe(0);
  });
});

describe('state and events', () => {
  it('stores a state item once while its value is unchanged', () => {
    deliver('arl/rta/$topology', RTA_TOPOLOGY);
    deliver('arl/rta/dish-001/state/commanded', envelope({ ts: 1_000, value: { azimuth_rad: 1 } }));
    deliver('arl/rta/dish-001/state/commanded', envelope({ ts: 1_500, value: { azimuth_rad: 1 } }));
    flush();
    expect(countRows(store, 'state_change')).toBe(1);

    deliver('arl/rta/dish-001/state/commanded', envelope({ ts: 2_000, value: { azimuth_rad: 2 } }));
    flush();
    expect(countRows(store, 'state_change')).toBe(2);
  });

  it('accepts a bare scalar on a retained state topic', () => {
    deliver('arl/rta/$topology', RTA_TOPOLOGY);
    deliver('arl/rta/global/state/online', Buffer.from('true'));
    flush();

    const row = store.db.prepare('SELECT entity, item, value FROM state_change').get();
    expect(row).toEqual({ entity: 'global', item: 'online', value: 'true' });
  });

  it('records a service alert event and broadcasts it to the annunciator', () => {
    const bus = new Bus<PlatformEvent>();
    const seen: PlatformEvent[] = [];
    bus.on((event) => seen.push(event));

    const clock = new SimClock();
    ingest = new Ingest(
      testConfig(),
      registry,
      store,
      bus,
      clock,
      new AlertEngine(store, bus, clock, { services: ['rta'], silenceMs: 60_000 }),
    );

    deliver('arl/rta/$topology', RTA_TOPOLOGY);
    deliver('arl/rta/events/alert', {
      v: 1,
      ts: 1_000,
      alert_id: 'rta/dish-001/temperature',
      type: 'temperature_high',
      severity: 'warning',
      state: 'raised',
      value: 72,
      limit: 70,
      unit: 'C',
      message: 'Dish 1 running hot',
    });
    flush();

    expect(store.getAlert('rta/dish-001/temperature')).toMatchObject({
      status: 'raised',
      severity: 'warning',
      origin: 'service',
    });
    expect(countRows(store, 'event')).toBe(1);
    // An alert event becomes an annunciator alert, not a generic `event` broadcast.
    expect(seen.filter((event) => event.kind === 'alert')).toHaveLength(1);
    expect(seen.some((event) => event.kind === 'event')).toBe(false);
  });

  it('flips the service offline alert from its own online state', () => {
    deliver('arl/rta/$topology', RTA_TOPOLOGY);
    deliver('arl/rta/global/state/online', envelope({ ts: 1_000, value: false }));
    expect(store.getAlert('platform/rta/offline')).toMatchObject({
      status: 'raised',
      severity: 'critical',
    });

    deliver('arl/rta/global/state/online', envelope({ ts: 1_100, value: true }));
    expect(store.getAlert('platform/rta/offline')?.status).toBe('cleared');
  });
});
