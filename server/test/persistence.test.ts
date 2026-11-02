import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { latestStates, latestTelemetry, series, timeRange } from '../src/db/queries';
import { Store } from '../src/db/store';
import type { CommandAck } from '../src/types';
import { countRows, writeEvents, writeStates, writeTelemetry } from './helpers';

let dir: string;
let file: string;
let store: Store;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arl-platform-test-'));
  file = path.join(dir, 'nested', 'arl.sqlite');
  store = new Store(file);
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('store durability', () => {
  it('opens in WAL mode so a reader never blocks the ingest flush', () => {
    expect(store.db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(store.db.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('creates the database directory and survives a reopen', () => {
    writeTelemetry(store, [
      { service: 'rta', entity: 'dish-001', stream: 'scan', ts: 1_000, seq: 1, data: { status: true } },
      { service: 'rta', entity: 'dish-002', stream: 'scan', ts: 1_000, seq: 2, data: { status: false } },
    ]);
    store.close();

    const reopened = new Store(file);
    expect(countRows(reopened, 'telemetry')).toBe(2);
    const row = reopened.db.prepare('SELECT data FROM telemetry ORDER BY id LIMIT 1').get() as {
      data: string;
    };
    expect(JSON.parse(row.data)).toEqual({ status: true });
    reopened.close();

    // Hand the store back to `afterEach` without double-closing the same handle.
    store = new Store(':memory:');
  });

  it('writes a whole batch in one transaction, mixing telemetry, state, events and gaps', () => {
    store.writeBatch({
      telemetry: [
        { service: 'rta', entity: 'dish-001', stream: 'scan', ts: 1_000, seq: 1, recvTs: 1, backfill: false, data: { status: true } },
      ],
      states: [{ service: 'rta', entity: 'dish-001', item: 'commanded', ts: 1_000, seq: null, recvTs: 1, value: { azimuth_rad: 1 } }],
      events: [{ service: 'rta', entity: null, kind: 'scan', ts: 1_000, seq: null, recvTs: 1, payload: { grid_size: 128 } }],
      gaps: [{ service: 'rta', entity: 'dish-001', stream: 'scan', topic: 'rta/scan', expectedSeq: 2, receivedSeq: 4, missed: 1, ts: 1_000, wallTs: 1 }],
    });

    expect(countRows(store, 'telemetry')).toBe(1);
    expect(countRows(store, 'state_change')).toBe(1);
    expect(countRows(store, 'event')).toBe(1);
    expect(countRows(store, 'ingest_gap')).toBe(1);
  });

  it('keeps the newest receive time when two paths touch the same service', () => {
    store.touchService('rta', { ts: 1_000, recvTs: 5_000, online: true });
    store.touchService('rta', { ts: 1_100, recvTs: 4_000 });
    const row = store.listServices().find((s) => s.code === 'rta');
    expect(row).toMatchObject({ online: 1, last_msg_ts: 1_100, last_recv_ts: 5_000 });
  });
});

describe('read models', () => {
  it('returns the newest sample per entity across the requested streams', () => {
    writeTelemetry(store, [
      { service: 'rta', entity: 'dish-001', stream: 'normal', ts: 100, data: { status: true } },
      { service: 'rta', entity: 'dish-001', stream: 'scan', ts: 300, data: { status: true, scan_id: 's1' } },
      { service: 'rta', entity: 'dish-002', stream: 'normal', ts: 200, data: { status: false } },
      { service: 'mhe', entity: 'room-1', stream: 'environment', ts: 400, data: { co2_ppm: 600 } },
    ]);

    const latest = latestTelemetry(store, 'rta', ['scan', 'normal']);
    expect(latest).toHaveLength(2);
    expect(latest.find((s) => s.entity === 'dish-001')).toMatchObject({ stream: 'scan', ts: 300 });
    expect(latest.find((s) => s.entity === 'dish-002')).toMatchObject({ stream: 'normal' });
  });

  it('returns the newest value of each state item', () => {
    writeStates(store, [
      { service: 'rta', entity: 'dish-001', item: 'commanded', ts: 100, value: { azimuth_rad: 1 } },
      { service: 'rta', entity: 'dish-001', item: 'commanded', ts: 200, value: { azimuth_rad: 2 } },
      { service: 'rta', entity: 'global', item: 'online', ts: 150, value: true },
    ]);

    const states = latestStates(store, 'rta');
    expect(states).toHaveLength(2);
    expect(states.find((s) => s.item === 'commanded')?.value).toEqual({ azimuth_rad: 2 });
  });

  it('serves a chart range with row totals and a stride only when it must', () => {
    writeTelemetry(
      store,
      Array.from({ length: 40 }, (_, i) => ({
        service: 'rta',
        entity: 'dish-001',
        stream: 'scan',
        ts: 1_000 + i,
        seq: i,
        data: { scan_id: 's1', value: i },
      })),
    );

    const all = series(store, { service: 'rta', stream: 'scan', from: 0, to: 10_000 });
    expect(all.total).toBe(40);
    expect(all.stride).toBe(1);
    expect(all.rows).toHaveLength(40);
    expect(all.rows[0].data).toEqual({ scan_id: 's1', value: 0 });

    const windowed = series(store, { service: 'rta', stream: 'scan', from: 1_010, to: 1_019 });
    expect(windowed.total).toBe(10);
    expect(windowed.rows.every((r) => r.ts >= 1_010 && r.ts <= 1_019)).toBe(true);
  });

  it('reports the capture window for a service', () => {
    writeEvents(store, [{ service: 'mhe', kind: 'survey', ts: 500 }]);
    writeTelemetry(store, [
      { service: 'mhe', entity: 'room-1', stream: 'environment', ts: 700, data: {} },
      { service: 'mhe', entity: 'room-1', stream: 'environment', ts: 900, data: {} },
    ]);

    expect(timeRange(store, 'mhe')).toEqual({ minTs: 700, maxTs: 900, rows: 2 });
    expect(timeRange(store, 'opg')).toEqual({ minTs: null, maxTs: null, rows: 0 });
  });
});

describe('researcher cache and commands', () => {
  it('serves a cached researcher only inside the TTL', () => {
    store.cacheResearcher({ code: 'arl-as3', name: 'Person A', experiments: ['rta'], status: 'active' });
    expect(store.cachedResearcher('arl-as3', 60_000)?.name).toBe('Person A');
    expect(store.cachedResearcher('arl-as3', -1)).toBeNull();
    expect(store.cachedResearcher('arl-zz9', 60_000)).toBeNull();
  });

  it('tracks a command from queue to a settled acknowledgement', () => {
    store.insertCommand({
      command_id: 'cmd-1',
      service: 'rta',
      entity: 'dish-001',
      control: 'target',
      value: { target: 'tgt-003' },
      researcher: 'arl-as3',
      topic: 'arl/rta/cmd/dish-001/target',
      sent_ts: 1_000,
      sent_wall_ts: 1_700_000_000_000,
      state: 'queued',
      progress: null,
      reason: null,
      detail: null,
      settled_ts: null,
    });

    const ack = (state: string, progress: number | null): CommandAck =>
      ({ command_id: 'cmd-1', state, progress, researcher: 'arl-as3' }) as unknown as CommandAck;

    expect(store.applyAck(ack('in_progress', 0.5), 1_010)).toMatchObject({
      terminal: false,
    });
    expect(store.getCommand('cmd-1')).toMatchObject({ state: 'in_progress', progress: 0.5 });

    const done = store.applyAck(ack('completed', 1), 1_020);
    expect(done.terminal).toBe(true);
    expect(done.row).toMatchObject({ state: 'completed', settled_ts: 1_020 });
    expect(store.getCommand('cmd-1')?.value).toEqual({ target: 'tgt-003' });
  });

  it('times out a command that was never acknowledged', () => {
    store.insertCommand({
      command_id: 'cmd-stuck',
      service: 'opg',
      entity: 'global',
      control: 'shed_load',
      value: 'all',
      researcher: 'arl-as3',
      topic: 'arl/opg/cmd/global/shed_load',
      sent_ts: 1_000,
      sent_wall_ts: 1_600_000_000_000,
      state: 'accepted',
      progress: null,
      reason: null,
      detail: null,
      settled_ts: null,
    });

    const expired = store.expireCommands(Date.now());
    expect(expired.map((c) => c.command_id)).toEqual(['cmd-stuck']);
    expect(store.getCommand('cmd-stuck')).toMatchObject({ state: 'timeout', reason: 'timeout' });
    expect(store.expireCommands(Date.now())).toHaveLength(0);
  });
});
