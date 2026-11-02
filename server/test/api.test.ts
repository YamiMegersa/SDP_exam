import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ArlApi } from '../src/arlApi/client';
import type { CommandService } from '../src/commands/service';
import { Store } from '../src/db/store';
import { createApp } from '../src/http/app';
import type { Ingest } from '../src/mqtt/ingest';
import { ReplayService } from '../src/replay/session';
import { TopologyRegistry } from '../src/topology/registry';
import { SimClock } from '../src/util/clock';
import { LIMITS, TOPOLOGIES, countRows, testConfig } from './helpers';

const ALERT_ID = 'rta/dish-001/temperature';
const ALERT_PATH = encodeURIComponent(ALERT_ID);

const RESEARCHERS = new Map([
  ['arl-as3', { code: 'arl-as3', name: 'Person A', experiments: ['rta'], status: 'active' }],
]);

/** Stands in for the ARL directory so the tests never need the live API. */
const fakeApi = {
  identify: async (code: string) => {
    // The directory being unreachable must be distinguishable from an unknown code.
    if (code === 'api-down') return { status: 'unavailable' as const };
    const record = RESEARCHERS.get(code);
    return record ? { status: 'verified' as const, record } : { status: 'unknown' as const };
  },
  alertLimits: async (service: string) => LIMITS[service] ?? [],
  health: async () => ({ ok: true }),
} as unknown as ArlApi;

const fakeIngest = {
  connected: true,
  counters: { received: 0, dropped: 0, unparsed: 0, gaps: 0, lastRecvTs: null },
} as unknown as Ingest;

const fakeCommands = {
  send: async () => ({ ok: false, status: 400, error: 'not_used' }),
} as unknown as CommandService;

let store: Store;
let registry: TopologyRegistry;
let replay: ReplayService;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  store = new Store(':memory:');
  registry = new TopologyRegistry(['rta', 'mhe', 'opg']);
  for (const topology of TOPOLOGIES) registry.set(topology);
  replay = new ReplayService(store);
  app = createApp({
    cfg: testConfig(),
    store,
    registry,
    ingest: fakeIngest,
    commands: fakeCommands,
    api: fakeApi,
    replay,
    clock: new SimClock(),
    startedAt: Date.now(),
  });

  store.applyAlertEvent(
    'rta',
    {
      alert_id: ALERT_ID,
      type: 'temperature_high',
      severity: 'warning',
      state: 'raised',
      value: 72,
      limit: 70,
      unit: 'C',
      message: 'Dish 1 running hot',
    },
    1_000,
    Date.now(),
    'dish-001',
  );
});

afterEach(() => {
  replay.stopAll();
  store.close();
});

describe('derived endpoint', () => {
  it('answers for every configured service', async () => {
    const res = await request(app).get('/api/derived').expect(200);

    expect(res.body.services.map((s: { service: string }) => s.service)).toEqual([
      'rta',
      'mhe',
      'opg',
    ]);
    for (const service of res.body.services) {
      expect(service.measures).toHaveLength(3);
    }
    // Nothing has been ingested, so every question is honestly unanswered.
    expect(res.body.services[0].measures[0]).toMatchObject({ value: null, verdict: 'unknown' });
  });

  it('narrows to one service and rejects an unknown one', async () => {
    const one = await request(app).get('/api/derived?service=opg').expect(200);
    expect(one.body.services.map((s: { service: string }) => s.service)).toEqual(['opg']);

    const unknown = await request(app).get('/api/derived?service=lwm').expect(404);
    expect(unknown.body).toEqual({ error: 'unknown_service', detail: ['lwm'] });
  });
});

describe('alert mutations are gated on the ARL directory', () => {
  it('rejects a malformed researcher code before doing anything', async () => {
    const res = await request(app)
      .post(`/api/alerts/${ALERT_PATH}/acknowledge`)
      .send({ researcher: 'x' })
      .expect(400);

    expect(res.body).toEqual({ error: 'malformed' });
    expect(store.getAlert(ALERT_ID)?.ack_ts).toBeNull();
  });

  it('refuses an unknown researcher with 403 and writes no audit entry', async () => {
    const before = countRows(store, 'alert_transition');

    const res = await request(app)
      .post(`/api/alerts/${ALERT_PATH}/acknowledge`)
      .send({ researcher: 'arl-zz9' })
      .expect(403);

    expect(res.body).toEqual({ error: 'unknown_researcher' });
    expect(store.getAlert(ALERT_ID)?.ack_ts).toBeNull();
    expect(countRows(store, 'alert_transition')).toBe(before);
  });

  it('distinguishes an unreachable directory (503) from an unknown code (403)', async () => {
    const res = await request(app)
      .post(`/api/alerts/${ALERT_PATH}/acknowledge`)
      .send({ researcher: 'api-down' })
      .expect(503);

    expect(res.body).toEqual({ error: 'api_unavailable' });
    expect(store.getAlert(ALERT_ID)?.ack_ts).toBeNull();
  });

  it('acknowledges under a verified code', async () => {
    const res = await request(app)
      .post(`/api/alerts/${ALERT_PATH}/acknowledge`)
      .send({ researcher: 'arl-as3', note: 'on it' })
      .expect(200);

    expect(res.body.alert).toMatchObject({ ack_by: 'arl-as3', ack_note: 'on it' });
    expect(store.getAlert(ALERT_ID)?.ack_ts).not.toBeNull();
  });

  it('will not resolve an alert that was never acknowledged', async () => {
    const res = await request(app)
      .post(`/api/alerts/${ALERT_PATH}/resolve`)
      .send({ researcher: 'arl-as3', resolution: 'fixed it' })
      .expect(409);

    expect(res.body).toEqual({ error: 'alert_not_acknowledged' });
  });

  it('requires a substantive resolution note', async () => {
    await request(app)
      .post(`/api/alerts/${ALERT_PATH}/acknowledge`)
      .send({ researcher: 'arl-as3' })
      .expect(200);

    const res = await request(app)
      .post(`/api/alerts/${ALERT_PATH}/resolve`)
      .send({ researcher: 'arl-as3', resolution: 'ok' })
      .expect(400);

    expect(res.body.error).toBe('invalid_resolution');
    expect(store.getAlert(ALERT_ID)?.resolved_ts).toBeNull();
  });

  it('resolves under a verified code, recording the note and the actor', async () => {
    await request(app)
      .post(`/api/alerts/${ALERT_PATH}/acknowledge`)
      .send({ researcher: 'arl-as3' })
      .expect(200);

    const res = await request(app)
      .post(`/api/alerts/${ALERT_PATH}/resolve`)
      .send({ researcher: 'arl-as3', resolution: 'cooling pump restarted' })
      .expect(200);

    expect(res.body.alert).toMatchObject({
      resolved_by: 'arl-as3',
      resolution: 'cooling pump restarted',
    });
    expect(store.listTransitions(ALERT_ID).map((t) => t.action)).toEqual([
      'raised',
      'acknowledged',
      'resolved',
    ]);
  });
});

describe('replay endpoints', () => {
  it('refuses an unknown service and an empty request', async () => {
    const unknown = await request(app)
      .post('/api/replay')
      .send({ services: ['lwm'], from: 0, to: 1_000 })
      .expect(404);
    expect(unknown.body.error).toBe('unknown_service');

    const empty = await request(app).post('/api/replay').send({ from: 0, to: 1_000 }).expect(400);
    expect(empty.body.error).toBe('services are required');
  });

  it('opens, controls and closes a session', async () => {
    const created = await request(app)
      .post('/api/replay')
      .send({ services: ['rta'], from: 0, to: 1_000 })
      .expect(201);
    const id = created.body.id as string;
    expect(created.body).toMatchObject({ status: 'paused', rows: 0, speed: 1 });

    const played = await request(app).post(`/api/replay/${id}/play`).expect(200);
    expect(played.body.status).toBe('playing');

    const paused = await request(app).post(`/api/replay/${id}/pause`).expect(200);
    expect(paused.body.status).toBe('paused');

    const badSeek = await request(app).post(`/api/replay/${id}/seek`).send({ ts: 'soon' }).expect(400);
    expect(badSeek.body.error).toBe('bad_timestamp');

    const seeked = await request(app).post(`/api/replay/${id}/seek`).send({ ts: 500 }).expect(200);
    expect(seeked.body.cursor).toBe(500);

    await request(app).delete(`/api/replay/${id}`).expect(204);
    // The finished session lingers briefly so a client can read its final snapshot, then is freed.
    const afterStop = await request(app).get(`/api/replay/${id}`).expect(200);
    expect(afterStop.body.status).toBe('stopped');
  });
});

describe('read endpoints', () => {
  it('reports broker, services and captured alert counts', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body).toMatchObject({ ok: true, broker: true, simulated: false });
    expect(res.body.services).toEqual(['rta', 'mhe', 'opg']);
    expect(res.body.alerts).toMatchObject({ open: 1, total: 1 });
  });

  it('lists the services with their topology summary', async () => {
    const res = await request(app).get('/api/services').expect(200);
    expect(res.body).toHaveLength(3);
    expect(res.body[0]).toMatchObject({
      code: 'rta',
      version: 'test-1',
      topology: { entities: 5, controls: 1 },
    });
  });

  it('serves the alert board', async () => {
    const res = await request(app).get('/api/alerts?status=raised').expect(200);
    const board = Array.isArray(res.body) ? res.body : res.body.alerts;
    expect(board).toHaveLength(1);
    expect(board[0]).toMatchObject({ alert_id: ALERT_ID, status: 'raised' });
  });

  it('answers an unknown API path with JSON 404, never the SPA shell', async () => {
    const res = await request(app).get('/api/nope').expect(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });
});
