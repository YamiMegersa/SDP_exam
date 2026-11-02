import http from 'node:http';
import { AlertEngine } from './alerts/engine';
import { ArlApi } from './arlApi/client';
import { CommandService } from './commands/service';
import { loadConfig, loadDotEnv } from './config';
import { Store } from './db/store';
import { createApp } from './http/app';
import { WsHub } from './http/ws';
import { Ingest } from './mqtt/ingest';
import { Bus } from './platform/bus';
import type { PlatformEvent } from './platform/events';
import { ReplayService } from './replay/session';
import { TopologyRegistry } from './topology/registry';
import { SimClock } from './util/clock';
import { logger } from './util/log';

const log = logger('main');

async function main(): Promise<void> {
  loadDotEnv();
  const cfg = loadConfig();
  const startedAt = Date.now();

  const store = new Store(cfg.dbPath);
  const bus = new Bus<PlatformEvent>();
  const clock = new SimClock();
  const registry = new TopologyRegistry(cfg.services);

  // Rehydrate the last known topology so the UI renders immediately on restart, before the broker
  // re-delivers the retained `$topology` messages.
  for (const code of cfg.services) {
    const json = store.topologyJson(code);
    if (!json) continue;
    try {
      registry.set(JSON.parse(json));
      log.info(`restored topology for ${code} from the store`);
    } catch {
      log.warn(`stored topology for ${code} is unreadable, waiting for the broker`);
    }
  }

  const api = new ArlApi(cfg, store);
  const alerts = new AlertEngine(store, bus, clock, {
    services: cfg.services,
    silenceMs: cfg.serviceSilenceMs,
  });
  const ingest = new Ingest(cfg, registry, store, bus, clock, alerts);
  const commands = new CommandService(cfg, store, registry, ingest, api, bus, clock);
  const replay = new ReplayService(store);

  const app = createApp({
    cfg,
    store,
    registry,
    ingest,
    commands,
    api,
    replay,
    clock,
    startedAt,
  });
  const server = http.createServer(app);
  const hub = new WsHub(server, { store, bus, registry, clock, replay });

  server.on('error', (error) => {
    log.error(`http server error: ${error.message}`);
    process.exitCode = 1;
  });

  await new Promise<void>((resolve) => server.listen(cfg.port, resolve));
  hub.start();
  alerts.start();
  commands.start();
  ingest.start();

  const arl = await api.health().catch(() => ({ ok: false }));
  log.info(`listening on http://localhost:${cfg.port} (websocket at /ws)`);
  log.info(`services: ${cfg.services.join(', ')}`);
  log.info(`broker: ${cfg.mqtt.address}:${cfg.mqtt.port}`);
  log.info(`ARL API: ${cfg.arl.baseUrl} ${arl.ok ? '(healthy)' : '(not reachable yet)'}`);
  log.info(`store: ${cfg.dbPath}`);

  if (cfg.telemetryRetentionHours > 0) scheduleRetention(store, cfg.telemetryRetentionHours);

  const shutdown = async (signal: string) => {
    log.info(`${signal} received, shutting down`);
    hub.close();
    alerts.stop();
    commands.stop();
    replay.stopAll();
    await ingest.stop().catch(() => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

/** Optional compaction so a long exam run does not fill the disk. Off by default. */
function scheduleRetention(store: Store, hours: number): void {
  const run = () => {
    const cutoff = Date.now() - hours * 3_600_000;
    try {
      const removed = store.db.prepare('DELETE FROM telemetry WHERE recv_ts < ?').run(cutoff);
      if (removed.changes > 0) log.info(`retention: removed ${removed.changes} telemetry rows`);
    } catch (error) {
      log.error(`retention sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const timer = setInterval(run, 3_600_000);
  timer.unref?.();
  run();
}

main().catch((error) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
