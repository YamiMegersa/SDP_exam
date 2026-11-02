import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../src/db/store';
import { ReplayService, ReplaySession, type ReplayFrame } from '../src/replay/session';
import { writeEvents, writeStates, writeTelemetry } from './helpers';

let store: Store;

beforeEach(() => {
  vi.useFakeTimers();
  store = new Store(':memory:');
});

afterEach(() => {
  vi.useRealTimers();
  store.close();
});

/** Collects every frame a session releases while the fake clock advances. */
async function drain(session: ReplaySession, ms: number): Promise<ReplayFrame[]> {
  const frames: ReplayFrame[] = [];
  session.onFrame((frame) => frames.push(frame));
  await vi.advanceTimersByTimeAsync(ms);
  return frames;
}

/** Three interleaved sources: the shape that used to make the mosaic empty. */
function seedInterleaved(): void {
  writeTelemetry(
    store,
    Array.from({ length: 30 }, (_, i) => ({
      service: 'rta',
      entity: 'dish-001',
      stream: 'scan',
      ts: 1_000 + i,
      seq: i,
      data: { scan_id: 'scan-0001', scan_progress: i / 30, status: true },
    })),
  );
  writeStates(
    store,
    Array.from({ length: 10 }, (_, i) => ({
      service: 'rta',
      entity: 'dish-001',
      item: 'commanded',
      ts: 1_000 + i * 3,
      value: { azimuth_rad: i },
    })),
  );
  writeEvents(
    store,
    Array.from({ length: 5 }, (_, i) => ({
      service: 'rta',
      kind: 'scan',
      ts: 1_000 + i * 6,
      payload: { scan_id: 'scan-0001' },
    })),
  );
}

describe('replay interleaving', () => {
  it('releases every source as its own kind, in simulated-time order', () => {
    seedInterleaved();
    const session = new ReplaySession(store, { services: ['rta'], from: 1_000, to: 1_029 });

    session.play();
    const frames = drain(session, 200);

    return frames.then((released) => {
      const byKind = (kind: ReplayFrame['kind']) => released.filter((f) => f.kind === kind);

      // The regression: draining the first non-empty buffer mislabelled rows, so telemetry arrived
      // as `state` and the scan raster never filled. Each source must now arrive as itself.
      expect(byKind('telemetry')).toHaveLength(30);
      expect(byKind('state')).toHaveLength(10);
      expect(byKind('event')).toHaveLength(5);
      expect(released).toHaveLength(session.snapshot.rows);

      for (const frame of byKind('telemetry')) {
        expect(frame.kind === 'telemetry' && frame.stream).toBe('scan');
        expect(frame.kind === 'telemetry' && frame.data.scan_id).toBe('scan-0001');
      }
      for (const frame of byKind('state')) {
        expect(frame.kind === 'state' && frame.item).toBe('commanded');
      }
      for (const frame of byKind('event')) {
        expect(frame.kind === 'event' && frame.name).toBe('scan');
      }

      const timestamps = released.map((f) => f.ts);
      expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));

      expect(session.snapshot).toMatchObject({ status: 'ended', emitted: 45, rows: 45, progress: 1 });
    });
  });

  it('keeps a row that sits exactly on the seek target', () => {
    writeTelemetry(store, [
      { service: 'rta', entity: 'dish-001', stream: 'scan', ts: 500, data: { scan_id: 'a' } },
      { service: 'rta', entity: 'dish-001', stream: 'scan', ts: 1_000, data: { scan_id: 'b' } },
      { service: 'rta', entity: 'dish-001', stream: 'scan', ts: 1_500, data: { scan_id: 'c' } },
    ]);

    const session = new ReplaySession(store, { services: ['rta'], from: 0, to: 2_000 });
    session.seek(1_000);
    session.play();

    return drain(session, 1_000).then((frames) => {
      const ids = frames.map((f) => (f.kind === 'telemetry' ? f.data.scan_id : null));
      // `lastId` used to start at Number.MAX_SAFE_INTEGER, which skipped the target row itself.
      expect(ids).toEqual(['b', 'c']);
    });
  });

  it('only replays the services it was opened for', () => {
    writeTelemetry(store, [
      { service: 'rta', entity: 'dish-001', stream: 'scan', ts: 1_000, data: { scan_id: 'rta' } },
      { service: 'mhe', entity: 'room-1', stream: 'environment', ts: 1_000, data: { co2_ppm: 600 } },
    ]);

    const session = new ReplaySession(store, { services: ['mhe'], from: 0, to: 2_000 });
    expect(session.snapshot.rows).toBe(1);
    session.play();

    return drain(session, 1_200).then((frames) => {
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({ kind: 'telemetry', service: 'mhe', entity: 'room-1' });
    });
  });
});

describe('replay controls', () => {
  const open = () => new ReplaySession(store, { services: ['rta'], from: 1_000, to: 61_000 });

  it('clamps speed to the supported range', () => {
    const session = open();
    expect(session.setSpeed(100).speed).toBe(64);
    expect(session.setSpeed(0).speed).toBe(0.1);
    expect(session.setSpeed(Number.NaN).speed).toBe(1);
    expect(session.setSpeed(5).speed).toBe(5);
  });

  it('clamps a seek inside the capture window', () => {
    const session = open();
    expect(session.seek(0).cursor).toBe(1_000);
    expect(session.seek(999_999).cursor).toBe(61_000);
    expect(session.seek(31_000).cursor).toBe(31_000);
  });

  it('pauses without losing its place and stops exactly once', () => {
    const session = open();
    session.play();
    expect(session.snapshot.status).toBe('playing');
    expect(session.pause().status).toBe('paused');
    expect(session.play().status).toBe('playing');

    const ended: number[] = [];
    session.onEnd(() => ended.push(1));
    session.stop();
    session.stop();

    expect(ended).toHaveLength(1);
    expect(session.snapshot.status).toBe('stopped');
    // A stopped session cannot be restarted; the client must open a new one.
    expect(session.play().status).toBe('stopped');
  });

  it('refuses to release anything before play', async () => {
    seedInterleaved();
    const session = new ReplaySession(store, { services: ['rta'], from: 1_000, to: 1_029 });
    const frames = await drain(session, 500);
    expect(frames).toHaveLength(0);
    expect(session.snapshot.status).toBe('paused');
  });
});

describe('replay service', () => {
  it('requires a service and a finite window', () => {
    const replay = new ReplayService(store);
    expect(() => replay.create({ services: [], from: 0, to: 1 })).toThrow(/at least one service/);
    expect(() => replay.create({ services: ['rta'], from: Number.NaN, to: 1 })).toThrow(
      /simulated time range/,
    );
  });

  it('tracks open sessions by id', () => {
    const replay = new ReplayService(store);
    const session = replay.create({ services: ['rta'], from: 0, to: 1_000 });
    expect(replay.get(session.id)).toBe(session);
    expect(replay.list().map((s) => s.id)).toEqual([session.id]);

    replay.stopAll();
    expect(replay.list()).toHaveLength(0);
  });
});
