import fs from 'node:fs';
import path from 'node:path';
import express, { NextFunction, Request, Response } from 'express';
import type { ArlApi } from '../arlApi/client';
import { isWellFormedCode } from '../arlApi/client';
import type { CommandService } from '../commands/service';
import type { Config } from '../config';
import type { Store } from '../db/store';
import { latestStates, series, serviceCounts, timeRange } from '../db/queries';
import type { Ingest } from '../mqtt/ingest';
import type { ReplayService } from '../replay/session';
import type { TopologyRegistry } from '../topology/registry';
import type { SimClock } from '../util/clock';
import { logger } from '../util/log';

const log = logger('http');

export interface AppDeps {
  cfg: Config;
  store: Store;
  registry: TopologyRegistry;
  ingest: Ingest;
  commands: CommandService;
  api: ArlApi;
  replay: ReplayService;
  clock: SimClock;
  startedAt: number;
}

/** REST surface. Everything the browser needs is here or on the websocket, never in a service SDK. */
export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use((_req, res, next) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    next();
  });

  const api = express.Router();
  api.use((_req, res, next) => {
    res.setHeader('cache-control', 'no-store');
    next();
  });

  // ------------------------------------------------------------------- status

  api.get('/health', async (_req, res) => {
    const broker = deps.ingest.connected;
    const arl = await deps.api.health().catch(() => ({ ok: false }));
    const counts = deps.store.countAlerts();
    res.json({
      ok: broker,
      uptimeMs: Date.now() - deps.startedAt,
      broker,
      arl,
      ingest: deps.ingest.counters,
      alerts: counts,
      simNow: deps.clock.known() ? deps.clock.now() : null,
      simulated: deps.clock.known(),
      services: deps.registry.services,
      db: deps.cfg.dbPath,
    });
  });

  api.get('/services', (_req, res) => {
    const rows = new Map(deps.store.listServices().map((r) => [r.code, r]));
    const counts = new Map(serviceCounts(deps.store, deps.registry.services).map((c) => [c.service, c]));
    res.json(
      deps.registry.services.map((code) => {
        const topology = deps.registry.get(code);
        const row = rows.get(code);
        const count = counts.get(code);
        const alerts = deps.store.listAlerts({ service: code, status: 'raised', limit: 500 });
        return {
          code,
          version: row?.version ?? topology?.version ?? null,
          online: row ? Boolean(row.online) : null,
          lastMsgTs: row?.last_msg_ts ?? null,
          lastRecvTs: row?.last_recv_ts ?? null,
          topology: topology
            ? {
                version: topology.version,
                entities: topology.entities.length,
                entityKinds: [...new Set(topology.entities.map((e) => e.kind))],
                streams: topology.streams.map((s) => ({
                  stream: s.stream,
                  topic: s.topic,
                  entityKinds: s.entityKinds,
                  periodS: s.periodS ?? null,
                  fields: s.fields,
                })),
                states: topology.states,
                events: topology.events,
                controls: topology.controls.length,
              }
            : null,
          counts: count ?? null,
          alerts: {
            open: alerts.length,
            critical: alerts.filter((a) => a.severity === 'critical').length,
            unacknowledged: alerts.filter((a) => !a.ack_ts).length,
          },
        };
      }),
    );
  });

  api.get('/services/:service/topology', (req, res) => {
    const topology = deps.registry.get(req.params.service);
    if (!topology) return res.status(404).json({ error: 'unknown_service' });
    res.json(topology.describe());
  });

  // -------------------------------------------------------------------- data

  api.get('/series', (req, res) => {
    const service = String(req.query.service ?? '');
    const stream = String(req.query.stream ?? '');
    if (!service || !stream) return res.status(400).json({ error: 'service and stream are required' });
    if (!deps.registry.get(service)) return res.status(404).json({ error: 'unknown_service' });

    const now = deps.clock.known() ? deps.clock.now() : Date.now();
    const to = number(req.query.to) ?? now;
    const from = number(req.query.from) ?? to - 15 * 60_000;
    const entity = typeof req.query.entity === 'string' && req.query.entity ? req.query.entity : undefined;

    const result = series(deps.store, {
      service,
      stream,
      entity,
      from: Math.min(from, to),
      to: Math.max(from, to),
      limit: number(req.query.limit) ?? 2_000,
    });
    res.json({ service, stream, entity: entity ?? null, from, to, ...result });
  });

  api.get('/states', (req, res) => {
    const service = String(req.query.service ?? '');
    if (!service) return res.status(400).json({ error: 'service is required' });
    if (!deps.registry.get(service)) return res.status(404).json({ error: 'unknown_service' });
    res.json(latestStates(deps.store, service));
  });

  api.get('/range', (req, res) => {
    const service = String(req.query.service ?? '');
    if (!deps.registry.get(service)) return res.status(404).json({ error: 'unknown_service' });
    res.json(timeRange(deps.store, service));
  });

  api.get('/targets', async (_req, res) => {
    res.json(await deps.api.targets());
  });

  api.get('/alert-limits/:service', async (req, res) => {
    if (!deps.registry.get(req.params.service)) return res.status(404).json({ error: 'unknown_service' });
    res.json(await deps.api.alertLimits(req.params.service));
  });

  api.get('/researchers/:code', async (req, res) => {
    const code = req.params.code.toLowerCase();
    if (!isWellFormedCode(code)) return res.status(400).json({ error: 'malformed' });
    const record = await deps.api.researcher(code);
    if (!record) return res.status(404).json({ error: 'unknown_researcher' });
    res.json(record);
  });

  // ------------------------------------------------------------------ alerts

  api.get('/alerts', (req, res) => {
    const status = String(req.query.status ?? 'open') as
      | 'open'
      | 'raised'
      | 'cleared'
      | 'acknowledged'
      | 'unacknowledged'
      | 'resolved';
    const alerts = deps.store.listAlerts({
      service: typeof req.query.service === 'string' ? req.query.service : undefined,
      status,
      limit: number(req.query.limit) ?? 200,
      sinceTs: number(req.query.since) ?? undefined,
    });
    res.json({ alerts, counts: deps.store.countAlerts() });
  });

  api.get('/alerts/:id', (req, res) => {
    const alert = deps.store.getAlert(req.params.id);
    if (!alert) return res.status(404).json({ error: 'alert_not_found' });
    res.json({
      alert,
      transitions: deps.store.listTransitions(alert.alert_id),
      researcher: alert.ack_by ? deps.store.cachedResearcher(alert.ack_by, Number.MAX_SAFE_INTEGER) : null,
    });
  });

  api.post('/alerts/:id/acknowledge', (req, res) => {
    const researcher = String(req.body?.researcher ?? '').toLowerCase().trim();
    if (!isWellFormedCode(researcher)) return res.status(400).json({ error: 'malformed' });
    const result = deps.store.acknowledgeAlert({
      alertId: req.params.id,
      researcher,
      note: typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : null,
      ts: deps.clock.now(),
      wallTs: Date.now(),
    });
    if (!result.ok) return res.status(result.code).json({ error: result.error });
    res.json({ alert: result.alert });
  });

  api.post('/alerts/:id/resolve', (req, res) => {
    const researcher = String(req.body?.researcher ?? '').toLowerCase().trim();
    if (!isWellFormedCode(researcher)) return res.status(400).json({ error: 'malformed' });
    const resolution = String(req.body?.resolution ?? '').trim();
    if (resolution.length < 3 || resolution.length > 500) {
      return res.status(400).json({ error: 'invalid_resolution', detail: '3 to 500 characters' });
    }
    const result = deps.store.resolveAlert({
      alertId: req.params.id,
      researcher,
      resolution,
      cause: typeof req.body?.cause === 'string' ? req.body.cause.slice(0, 120) : null,
      ts: deps.clock.now(),
      wallTs: Date.now(),
    });
    if (!result.ok) return res.status(result.code).json({ error: result.error });
    res.json({ alert: result.alert });
  });

  // ---------------------------------------------------------------- commands

  api.get('/commands', (req, res) => {
    const limit = number(req.query.limit) ?? 50;
    const rows = deps.store.listCommands(Math.min(Math.max(limit, 1), 500));
    res.json(
      rows.map((row) => ({
        ...row,
        researcher_name: deps.store.cachedResearcher(row.researcher, Number.MAX_SAFE_INTEGER)?.name ?? null,
      })),
    );
  });

  api.get('/commands/:id/acks', (req, res) => {
    const rows = deps.store.db
      .prepare('SELECT * FROM command_ack WHERE command_id = ? ORDER BY id ASC')
      .all(req.params.id) as Array<Record<string, unknown>>;
    res.json(rows.map((r) => ({ ...r, raw: safeJson(String(r.raw), null) })));
  });

  api.post('/commands', async (req, res) => {
    const body = req.body ?? {};
    const result = await deps.commands.send({
      service: String(body.service ?? '').toLowerCase(),
      entity: String(body.entity ?? ''),
      control: String(body.control ?? ''),
      value: body.value,
      researcher: String(body.researcher ?? ''),
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, detail: result.detail });
    }
    res.status(202).json(result.command);
  });

  // ------------------------------------------------------------------ replay

  api.get('/replay', (_req, res) => {
    res.json(deps.replay.list());
  });

  api.post('/replay', (req, res) => {
    const body = req.body ?? {};
    const services = Array.isArray(body.services)
      ? body.services.filter((s: unknown): s is string => typeof s === 'string')
      : typeof body.service === 'string'
        ? [body.service]
        : [];
    const unknown = services.filter((s: string) => !deps.registry.get(s));
    if (unknown.length > 0) return res.status(404).json({ error: 'unknown_service', detail: unknown });

    const range = services.length > 0 ? timeRange(deps.store, services[0]) : { minTs: null, maxTs: null };
    const from = number(body.from) ?? range.minTs ?? deps.clock.now() - 60_000;
    const to = number(body.to) ?? range.maxTs ?? deps.clock.now();
    if (services.length === 0) return res.status(400).json({ error: 'services are required' });

    try {
      const session = deps.replay.create({
        services,
        from,
        to,
        speed: number(body.speed) ?? 1,
        streams: Array.isArray(body.streams) ? body.streams : undefined,
        entities: Array.isArray(body.entities) ? body.entities : undefined,
      });
      res.status(201).json(session.snapshot);
    } catch (error) {
      res.status(400).json({ error: 'replay_failed', detail: message(error) });
    }
  });

  api.post('/replay/:id/:action(play|pause)', (req, res) => {
    const session = deps.replay.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'unknown_replay' });
    res.json(req.params.action === 'play' ? session.play() : session.pause());
  });

  api.post('/replay/:id/speed', (req, res) => {
    const session = deps.replay.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'unknown_replay' });
    res.json(session.setSpeed(number(req.body?.speed) ?? 1));
  });

  api.post('/replay/:id/seek', (req, res) => {
    const session = deps.replay.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'unknown_replay' });
    const ts = number(req.body?.ts);
    if (ts === null) return res.status(400).json({ error: 'bad_timestamp' });
    res.json(session.seek(ts));
  });

  api.delete('/replay/:id', (req, res) => {
    const session = deps.replay.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'unknown_replay' });
    session.stop();
    res.status(204).end();
  });

  api.get('/replay/:id', (req, res) => {
    const session = deps.replay.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'unknown_replay' });
    res.json(session.snapshot);
  });

  app.use('/api', api);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

  // The built client is served by the same process, so deployment is one command.
  const webRoot = path.resolve(__dirname, '../../../web/dist');
  if (fs.existsSync(webRoot)) {
    app.use(express.static(webRoot, { maxAge: '1h', index: false }));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return next();
      res.sendFile(path.join(webRoot, 'index.html'));
    });
  }

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    log.error(`unhandled: ${message(error)}`);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

function number(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
