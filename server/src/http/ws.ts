import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import type { Store } from '../db/store';
import { latestStates } from '../db/queries';
import type { PlatformBus, PlatformEvent } from '../platform/events';
import type { ReplayService } from '../replay/session';
import type { TopologyRegistry } from '../topology/registry';
import type { SimClock } from '../util/clock';
import { logger } from '../util/log';

const log = logger('ws');

interface Client {
  socket: WebSocket;
  alive: boolean;
  pending: PlatformEvent[];
  pendingKeys: Map<string, number>;
  watched: Map<string, Array<() => void>>;
}

const FLUSH_MS = 100;

/**
 * Pushes live data to browsers.
 *
 * Samples are coalesced per (entity, stream) within a 100 ms tick: the RTA scan can produce ~90
 * messages a second, and sending every one would spend the operator's bandwidth on frames the
 * display cannot resolve. History is not lost - charts backfill from the HTTP series endpoint.
 */
export class WsHub {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<Client>();
  private readonly unsubscribe: () => void;
  private flushTimer: NodeJS.Timeout | null = null;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    server: Server,
    private readonly deps: {
      store: Store;
      bus: PlatformBus;
      registry: TopologyRegistry;
      clock: SimClock;
      replay: ReplayService;
    },
  ) {
    this.wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1 << 20 });
    this.wss.on('connection', (socket, request) => this.accept(socket, request.socket.remoteAddress));
    this.unsubscribe = deps.bus.on((event) => this.broadcast(event));
  }

  start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flush(), FLUSH_MS);
    this.flushTimer.unref?.();
    this.heartbeat = setInterval(() => this.ping(), 30_000);
    this.heartbeat.unref?.();
  }

  close(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.flushTimer = null;
    this.heartbeat = null;
    this.unsubscribe();
    for (const client of this.clients) {
      for (const offs of client.watched.values()) for (const off of offs) off();
      client.socket.close(1001, 'server shutting down');
    }
    this.clients.clear();
    this.wss.close();
  }

  private accept(socket: WebSocket, remote: string | undefined): void {
    const client: Client = {
      socket,
      alive: true,
      pending: [],
      pendingKeys: new Map(),
      watched: new Map(),
    };
    this.clients.add(client);
    log.info(`client connected from ${remote ?? 'unknown'} (${this.clients.size} total)`);

    socket.on('pong', () => {
      client.alive = true;
    });

    socket.on('message', (data) => this.receive(client, data.toString()));

    socket.on('close', () => {
      for (const offs of client.watched.values()) for (const off of offs) off();
      client.watched.clear();
      this.clients.delete(client);
      log.info(`client disconnected (${this.clients.size} remaining)`);
    });

    socket.on('error', (error) => {
      log.warn(`client socket error: ${error.message}`);
    });

    this.send(client, { type: 'hello', ...this.snapshot() });
  }

  private receive(client: Client, text: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.send(client, { type: 'error', error: 'malformed_frame' });
      return;
    }
    const type = String(message.type ?? '');
    if (type === 'ping') {
      this.send(client, { type: 'pong', t: Date.now() });
      return;
    }
    if (type === 'watch') {
      this.watch(client, String(message.id ?? ''));
      return;
    }
    if (type === 'unwatch') {
      this.unwatch(client, String(message.id ?? ''));
    }
  }

  /** `hello`: everything a panel needs to render before the first live sample arrives. */
  private snapshot(): Record<string, unknown> {
    const { store, registry, clock, replay } = this.deps;
    const services = registry.services;
    return {
      simNow: clock.known() ? clock.now() : null,
      simulated: clock.known(),
      services: services.map((code) => {
        const topology = registry.get(code);
        const row = store.listServices().find((r) => r.code === code);
        return {
          code,
          version: row?.version ?? topology?.version ?? null,
          online: row ? Boolean(row.online) : null,
          lastMsgTs: row?.last_msg_ts ?? null,
          lastRecvTs: row?.last_recv_ts ?? null,
          topology: topology ? topology.describe() : null,
          states: latestStates(store, code),
        };
      }),
      // The annunciator board only carries alerts that are *in alarm*; the full
      // history (cleared-but-unresolved, resolved) is paged from `/api/alerts`.
      alerts: store.listAlerts({ status: 'raised', limit: 200 }),
      commands: store.listCommands(25),
      counts: store.countAlerts(),
      replay: replay.list(),
    };
  }

  private watch(client: Client, id: string): void {
    if (client.watched.has(id)) return;
    const session = this.deps.replay.get(id);
    if (!session) {
      this.send(client, { type: 'error', error: 'unknown_replay', id });
      return;
    }
    const offs = [
      session.onFrame((frame) => this.send(client, { type: 'replay-frame', id, frame })),
      session.onStatus((snapshot) => this.send(client, { type: 'replay-status', id, snapshot })),
      session.onEnd((snapshot) => {
        this.send(client, { type: 'replay-status', id, snapshot });
        this.unwatch(client, id);
      }),
    ];
    client.watched.set(id, offs);
    this.send(client, { type: 'replay-status', id, snapshot: session.snapshot });
  }

  private unwatch(client: Client, id: string): void {
    const offs = client.watched.get(id);
    if (!offs) return;
    for (const off of offs) off();
    client.watched.delete(id);
  }

  private broadcast(event: PlatformEvent): void {
    for (const client of this.clients) this.queue(client, event);
  }

  private queue(client: Client, event: PlatformEvent): void {
    if (event.kind === 'telemetry') {
      const key = `t:${event.service}/${event.entity}/${event.stream}`;
      const index = client.pendingKeys.get(key);
      if (index !== undefined) {
        client.pending[index] = event;
        return;
      }
      client.pendingKeys.set(key, client.pending.length);
    }
    client.pending.push(event);
  }

  private flush(): void {
    for (const client of this.clients) {
      if (client.socket.readyState !== WebSocket.OPEN) continue;
      if (client.pending.length === 0) continue;
      const frames = client.pending;
      client.pending = [];
      client.pendingKeys.clear();
      this.send(client, { type: 'frames', t: Date.now(), frames });
    }
  }

  private ping(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        client.socket.terminate();
        this.clients.delete(client);
        continue;
      }
      client.alive = false;
      client.socket.ping();
    }
  }

  private send(client: Client, payload: unknown): void {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    try {
      client.socket.send(JSON.stringify(payload));
    } catch (error) {
      log.warn(`send failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
