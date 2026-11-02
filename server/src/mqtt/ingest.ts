import mqtt, { MqttClient } from 'mqtt';
import type { Config } from '../config';
import type { AlertEngine } from '../alerts/engine';
import type { EventRow, GapRow, StateRow, Store, TelemetryRow } from '../db/store';
import type { PlatformBus } from '../platform/events';
import type { ServiceTopology, TopologyRegistry } from '../topology/registry';
import type { SimClock } from '../util/clock';
import { logger } from '../util/log';
import type { AlertPayload, CommandAck } from '../types';

const log = logger('ingest');

/**
 * Wildcards only: the platform must discover whatever the services publish, including entities and
 * streams that did not exist when this code was written.
 */
const SUBSCRIPTIONS = [
  'arl/+/$topology',
  'arl/+/+/telemetry/+',
  'arl/+/+/state/+',
  'arl/+/events/+',
  'arl/+/ack/+',
];

interface PendingBatch {
  telemetry: TelemetryRow[];
  states: StateRow[];
  events: EventRow[];
  gaps: GapRow[];
}

interface IngestStats {
  received: number;
  dropped: number;
  unparsed: number;
  gaps: number;
  lastRecvTs: number | null;
}

export class Ingest {
  private client: MqttClient | null = null;
  private pending: PendingBatch = emptyBatch();
  private flushTimer: NodeJS.Timeout | null = null;
  private statsTimer: NodeJS.Timeout | null = null;
  private readonly dirtyServices = new Set<string>();
  private readonly lastSeen = new Map<string, { msgTs: number | null; recvTs: number; online: boolean | null }>();
  /** Last `seq` per topic - a jump means samples were lost between the service and us. */
  private readonly seqs = new Map<string, number>();
  /** Messages that arrived before their service's `$topology`; replayed once it lands. */
  private readonly orphans = new Map<string, { service: string; raw: Record<string, unknown>; at: number }>();
  /**
   * Last serialised value per state item.
   *
   * Services republish unchanged state continuously (the RTA rewrites every dish's `commanded` item
   * every second), so storing each repeat would turn a slow table into a fast one and bury real
   * transitions.
   */
  private readonly lastState = new Map<string, string>();
  private readonly stats: IngestStats = { received: 0, dropped: 0, unparsed: 0, gaps: 0, lastRecvTs: null };
  private ackHandler: ((service: string, ack: CommandAck) => void) | null = null;

  constructor(
    private readonly cfg: Config,
    private readonly registry: TopologyRegistry,
    private readonly store: Store,
    private readonly bus: PlatformBus,
    private readonly clock: SimClock,
    private readonly alerts: AlertEngine,
  ) {}

  get connected(): boolean {
    return Boolean(this.client?.connected);
  }

  get counters(): IngestStats {
    return { ...this.stats };
  }

  onAck(handler: (service: string, ack: CommandAck) => void): void {
    this.ackHandler = handler;
  }

  start(): void {
    const { address, port, user, password, clientId, queueLimit } = this.cfg.mqtt;
    // `config` hands over a bare host, which may already carry its port ("host:1883").
    const addressHasPort = /:\d+$/.test(address);
    const url = /^mqtts?:\/\//i.test(address)
      ? address
      : `mqtt://${address}${addressHasPort ? '' : `:${port}`}`;
    log.info(`connecting to ${url.replace(/\/\/.*@/, '//')} as ${clientId}`);

    this.client = mqtt.connect(url, {
      clientId,
      username: user || undefined,
      password: password || undefined,
      clean: true,
      keepalive: 30,
      connectTimeout: 10_000,
      reconnectPeriod: 2_000,
      protocolVersion: 4,
      queueQoSZero: false,
    });

    this.client.on('connect', () => {
      log.info('broker connected');
      this.alerts.broker(true);
      this.client?.subscribe(SUBSCRIPTIONS, { qos: 1 }, (error, granted) => {
        if (error) {
          log.error(`subscribe failed: ${error.message}`);
          return;
        }
        log.info(`subscribed to ${granted?.length ?? 0} topic filters`);
      });
    });

    this.client.on('message', (topic, payload) => this.receive(topic, payload));

    this.client.on('offline', () => {
      log.warn('broker offline; mqtt.js will keep retrying');
      this.alerts.broker(false, 'offline');
    });

    this.client.on('close', () => this.alerts.broker(false));

    this.client.on('reconnect', () => log.info('reconnecting to broker'));

    this.client.on('error', (error) => log.error(`broker error: ${error.message}`));

    this.client.on('end', () => log.warn('broker connection closed'));

    this.statsTimer = setInterval(() => {
      this.bus.emit({
        kind: 'ingest',
        dropped: this.stats.dropped,
        gaps: this.stats.gaps,
        lastRecvTs: this.stats.lastRecvTs ?? 0,
      });
    }, 5_000);
    this.statsTimer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.flushTimer = null;
    this.statsTimer = null;
    this.flush();
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    await new Promise<void>((resolve) => client.end(false, {}, () => resolve()));
  }

  /** Sends a control command. QoS 1 because a silently dropped command looks like a stuck device. */
  publishCommand(topic: string, envelope: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      const client = this.client;
      if (!client || !client.connected) {
        reject(new Error('broker_unavailable'));
        return;
      }
      client.publish(topic, JSON.stringify(envelope), { qos: 1 }, (error) => {
        if (error) {
          log.error(`publish to ${topic} failed: ${error.message}`);
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  // --------------------------------------------------------------- dispatching

  private receive(topic: string, payload: Buffer): void {
    try {
      const service = topic.split('/')[1];
      if (!service || !this.registry.accepts(service)) return;

      this.stats.received += 1;
      this.stats.lastRecvTs = Date.now();

      const raw = parseJson(payload);
      if (raw === null) {
        this.stats.unparsed += 1;
        log.warn(`ignoring non-object payload on ${topic}`);
        return;
      }

      // The topology bootstraps the routing table, so it cannot itself wait for a topology.
      if (topic === `arl/${service}/$topology`) {
        this.acceptTopology(topic, raw);
        return;
      }

      const topology = this.registry.get(service);
      if (!topology) {
        this.holdOrphan(service, topic, raw);
        return;
      }
      this.dispatch(topology, topic, raw);
    } catch (error) {
      this.stats.dropped += 1;
      log.error(`failed to handle ${topic}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private dispatch(topology: ServiceTopology, topic: string, raw: Record<string, unknown>): void {
    const service = topology.service;

    this.markSeen(service, numeric(raw.ts));

    const ack = topology.matchAck(topic);
    if (ack) {
      this.ackHandler?.(service, { ...(raw as unknown as CommandAck), command_id: ack.commandId });
      return;
    }

    const telemetry = topology.matchTelemetry(topic);
    if (telemetry) {
      this.pushTelemetry(service, telemetry.def.stream, telemetry.entity, raw);
      return;
    }

    const state = topology.matchState(topic);
    if (state) {
      this.pushState(service, state.def.item, state.entity, raw);
      return;
    }

    const event = topology.matchEvent(topic);
    if (event && topology.hasEventKind(event.kind)) {
      this.pushEvent(service, event.kind, raw);
      return;
    }

    log.debug(`unrouted topic ${topic}`);
  }

  private acceptTopology(topic: string, raw: Record<string, unknown>): void {
    let changed = false;
    let service = '';
    try {
      const candidate = typeof raw.service === 'string' ? raw.service : '';
      if (!this.registry.accepts(candidate)) {
        log.warn(`ignoring topology for unconfigured service "${candidate}"`);
        return;
      }
      const result = this.registry.set(raw);
      service = result.topology.service;
      changed = result.changed;
      const ts = numeric(raw.ts) ?? (this.clock.known() ? this.clock.now() : Date.now());
      this.store.saveTopology(service, result.topology.version, JSON.stringify(raw), ts);
      if (changed) {
        this.store.replaceEntities(service, result.topology.entities);
        this.bus.emit({ kind: 'topology', service, version: result.topology.version });
      }
      log.info(
        `topology ${service} v${result.topology.version}: ` +
          `${result.topology.entities.length} entities, ${result.topology.streams.length} streams, ` +
          `${result.topology.controls.length} controls${changed ? ' (updated)' : ''}`,
      );
    } catch (error) {
      log.error(`rejected topology on ${topic}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    this.drainOrphans(service);
  }

  // ------------------------------------------------------------------ routing

  private pushTelemetry(
    service: string,
    stream: string,
    entity: string,
    raw: Record<string, unknown>,
  ): void {
    const ts = numeric(raw.ts) ?? this.clock.forService(service);
    const seq = numeric(raw.seq);
    const backfill = raw.backfill === true;
    this.clock.observe(service, ts);

    const data: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (key === 'v' || key === 'ts' || key === 'seq' || key === 'entity') continue;
      data[key] = value;
    }

    this.pending.telemetry.push({
      service,
      entity,
      stream,
      ts,
      seq: seq ?? null,
      recvTs: Date.now(),
      backfill,
      data,
    });

    if (!backfill) {
      const gap = this.trackSeq(`${service}/${stream}`, seq, service, entity, stream, ts);
      if (gap) this.pending.gaps.push(gap);
    }

    this.bus.emit({ kind: 'telemetry', service, entity, stream, ts, seq: seq ?? null, backfill, data });
    this.scheduleFlush();
  }

  private pushState(service: string, item: string, entity: string, raw: Record<string, unknown>): void {
    const ts = numeric(raw.ts) ?? this.clock.forService(service);
    const seq = numeric(raw.seq);
    const value = 'value' in raw ? raw.value : raw;
    this.clock.observe(service, ts);

    const key = `${service}/${entity}/${item}`;
    const serialised = JSON.stringify(value) ?? 'null';
    if (this.lastState.get(key) === serialised) return;
    if (this.lastState.size > 20_000) this.lastState.clear();
    this.lastState.set(key, serialised);

    this.pending.states.push({
      service,
      entity,
      item,
      ts,
      seq: seq ?? null,
      recvTs: Date.now(),
      value,
    });

    if (item === 'online') this.handleOnline(service, value);
    this.bus.emit({ kind: 'state', service, entity, item, ts, value });
    this.scheduleFlush();
  }

  private pushEvent(service: string, kind: string, raw: Record<string, unknown>): void {
    const ts = numeric(raw.ts) ?? this.clock.forService(service);
    this.clock.observe(service, ts);
    const entity = typeof raw.entity === 'string' ? raw.entity : null;

    this.pending.events.push({
      service,
      entity,
      kind,
      ts,
      seq: numeric(raw.seq) ?? null,
      recvTs: Date.now(),
      payload: raw,
    });

    if (kind === 'alert') {
      this.alerts.serviceAlert(service, raw as unknown as AlertPayload, entity);
    } else {
      this.bus.emit({ kind: 'event', service, name: kind, ts, payload: raw });
    }
    this.scheduleFlush();
  }

  private handleOnline(service: string, value: unknown): void {
    const online = value === true || value === 'true' || value === 1;
    const seen = this.lastSeen.get(service);
    if (seen && seen.online === online) return;
    this.markSeen(service, null, online);
    this.alerts.online(service, online);
  }

  private markSeen(service: string, msgTs: number | null, online: boolean | null = null): void {
    const previous = this.lastSeen.get(service);
    this.lastSeen.set(service, {
      msgTs: msgTs ?? previous?.msgTs ?? null,
      recvTs: Date.now(),
      online: online ?? previous?.online ?? null,
    });
    this.dirtyServices.add(service);
  }

  // ------------------------------------------------------------- gap tracking

  private trackSeq(
    key: string,
    seq: number | null,
    service: string,
    entity: string | null,
    stream: string | null,
    ts: number | null,
  ): GapRow | null {
    if (seq === null) return null;
    const previous = this.seqs.get(key);
    this.seqs.set(key, seq);
    if (previous === undefined || seq <= previous + 1) return null;
    const gap: GapRow = {
      service,
      entity,
      stream,
      topic: key,
      expectedSeq: previous + 1,
      receivedSeq: seq,
      missed: seq - previous - 1,
      ts,
      wallTs: Date.now(),
    };
    this.stats.gaps += 1;
    this.alerts.ingestGap(service, gap);
    return gap;
  }

  // ------------------------------------------------------------------- orphans

  private holdOrphan(service: string, topic: string, raw: Record<string, unknown>): void {
    if (this.orphans.size >= 5_000) {
      const oldest = this.orphans.keys().next().value;
      if (oldest) this.orphans.delete(oldest);
    }
    this.orphans.set(topic, { service, raw, at: Date.now() });
    log.debug(`holding ${topic} until its topology arrives`);
  }

  private drainOrphans(service: string): void {
    const topology = this.registry.get(service);
    if (!topology) return;
    for (const [topic, entry] of [...this.orphans]) {
      if (entry.service !== service) continue;
      this.orphans.delete(topic);
      this.dispatch(topology, topic, entry.raw);
    }
  }

  // ------------------------------------------------------------------- batching

  private scheduleFlush(): void {
    const queued = this.pending.telemetry.length + this.pending.states.length;
    if (queued >= this.cfg.telemetryBatch.maxRows) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      this.flush();
      return;
    }
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, this.cfg.telemetryBatch.maxDelayMs);
  }

  private flush(): void {
    const batch = this.pending;
    this.pending = emptyBatch();

    if (batch.telemetry.length || batch.states.length || batch.events.length || batch.gaps.length) {
      try {
        this.store.writeBatch(batch);
      } catch (error) {
        log.error(`batch write failed (${batch.telemetry.length} rows): ${describe(error)}`);
      }
    }

    if (this.dirtyServices.size > 0) {
      for (const service of this.dirtyServices) {
        const seen = this.lastSeen.get(service);
        try {
          this.store.touchService(service, {
            online: seen?.online ?? undefined,
            ts: seen?.msgTs ?? null,
            recvTs: seen?.recvTs ?? Date.now(),
          });
        } catch (error) {
          log.error(`failed to update service ${service}: ${describe(error)}`);
        }
      }
      this.dirtyServices.clear();
    }
  }
}

function emptyBatch(): PendingBatch {
  return { telemetry: [], states: [], events: [], gaps: [] };
}

function parseJson(payload: Buffer): Record<string, unknown> | null {
  const text = payload.toString('utf8').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    // A bare scalar is legal for a retained state item.
    return { value: text };
  }
}

function numeric(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
