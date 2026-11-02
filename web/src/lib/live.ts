import { ScanRaster } from './imaging';
import type {
  AlertCounts,
  AlertRecord,
  CommandRow,
  HelloFrame,
  PlatformEvent,
  ReplayFrame,
  ReplaySnapshot,
  Sample,
  StateRow,
  Topology,
} from './types';

/**
 * The live client.
 *
 * Everything that arrives at more than a few hertz is stored *outside* React:
 * the RTA publishes ~90 samples a second, and routing that through component
 * state would re-render a hundred dish tiles for every scan tick. Components read
 * plain Maps from this object and re-render when the version counter changes,
 * which is throttled to the display rate (10 Hz).
 *
 * Precedent for the shape: a tiny external store plus `useSyncExternalStore`,
 * which is exactly what React's own docs recommend for high-frequency sources.
 */

const MAX_EVENTS = 40;
const MAX_COMMANDS = 40;
const NOTIFY_MS = 100;

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface LiveEvent {
  id: number;
  service: string;
  name: string;
  ts: number;
  payload: Record<string, unknown>;
}

export interface StateEntry {
  ts: number;
  value: unknown;
}

/** One retained chart buffer. `entity` is `*` for a service-wide aggregate. */
export interface Ring {
  readonly key: string;
  readonly service: string;
  readonly stream: string;
  readonly entity: string;
  readonly field: string;
  points: Sample[];
  readonly max: number;
}

export interface ServiceRuntime {
  code: string;
  version: string | null;
  online: boolean | null;
  lastMsgTs: number | null;
  lastRecvTs: number | null;
  topology: Topology | null;
  /** `${entity}|${item}` -> latest value. */
  states: Map<string, StateEntry>;
  /** `${stream}|${entity}` -> latest sample. */
  latest: Map<string, Sample>;
  events: LiveEvent[];
  samples: number;
  raster: ScanRaster;
  /** Last `events/scan` payload, which is the authority on scan geometry. */
  scan: {
    scanId: string | null;
    target: string | null;
    bandHz: number | null;
    gridSize: number | null;
    fovRad: number | null;
    overlap: number | null;
    expectedDurationS: number | null;
    startedTs: number | null;
    dishes: number;
  };
}

function emptyService(code: string): ServiceRuntime {
  return {
    code,
    version: null,
    online: null,
    lastMsgTs: null,
    lastRecvTs: null,
    topology: null,
    states: new Map(),
    latest: new Map(),
    events: [],
    samples: 0,
    raster: new ScanRaster(),
    scan: {
      scanId: null,
      target: null,
      bandHz: null,
      gridSize: null,
      fovRad: null,
      overlap: null,
      expectedDurationS: null,
      startedTs: null,
      dishes: 0,
    },
  };
}

export class LiveClient {
  services = new Map<string, ServiceRuntime>();
  alerts = new Map<string, AlertRecord>();
  counts: AlertCounts = {
    open: 0,
    critical: 0,
    unacknowledged: 0,
    cleared: 0,
    resolved: 0,
    total: 0,
  };
  commands: CommandRow[] = [];
  connection: ConnectionState = 'connecting';
  /** Newest simulator timestamp we have seen - the console's own clock. */
  simTime: number | null = null;
  simulated = false;
  /** Set when the broker drops: the services keep publishing into the void. */
  brokerOnline = true;
  ingest: { received: number; dropped: number; gaps: number; lastRecvTs: number | null } = {
    received: 0,
    dropped: 0,
    gaps: 0,
    lastRecvTs: null,
  };
  receivedFrames = 0;
  lastFrameAt = 0;

  private version = 0;
  private listeners = new Set<() => void>();
  private notifyTimer: number | null = null;
  private rings = new Map<string, Ring>();
  private ringListeners = new Set<() => void>();
  private eventSeq = 0;
  private socket: WebSocket | null = null;
  private socketAttempts = 0;
  private pingTimer: number | null = null;
  private replayHandlers = new Set<(id: string, frame: ReplayFrame) => void>();
  private replayStatusHandlers = new Set<(id: string, snapshot: ReplaySnapshot) => void>();
  private seenAlertIds = new Set<string>();

  // ------------------------------------------------------------ subscription

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getVersion = (): number => this.version;

  subscribeRings = (listener: () => void): (() => void) => {
    this.ringListeners.add(listener);
    return () => {
      this.ringListeners.delete(listener);
    };
  };

  /** Coalesces a burst of frames into one React render. */
  private notify(): void {
    if (this.notifyTimer !== null) return;
    this.notifyTimer = window.setTimeout(() => {
      this.notifyTimer = null;
      this.version += 1;
      for (const listener of [...this.listeners]) listener();
    }, NOTIFY_MS);
  }

  private notifyRings(): void {
    for (const listener of [...this.ringListeners]) listener();
  }

  // ---------------------------------------------------------------- transport

  connect(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.connection = this.socketAttempts === 0 ? 'connecting' : 'reconnecting';
    this.notify();

    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${window.location.host}/ws`);
    this.socket = socket;

    socket.onopen = () => {
      this.connection = 'open';
      this.socketAttempts = 0;
      this.notify();
      this.startPing();
    };

    socket.onmessage = (event) => {
      this.receive(String(event.data));
    };

    socket.onclose = () => {
      this.connection = 'closed';
      this.stopPing();
      this.notify();
      this.socketAttempts += 1;
      const delay = Math.min(15_000, 500 * 2 ** Math.min(5, this.socketAttempts));
      window.setTimeout(() => this.connect(), delay);
    };

    socket.onerror = () => {
      socket.close();
    };
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = window.setInterval(() => {
      this.send({ type: 'ping' });
    }, 25_000);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) window.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private send(payload: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(payload));
  }

  watchReplay(id: string): void {
    this.send({ type: 'watch', id });
  }

  unwatchReplay(id: string): void {
    this.send({ type: 'unwatch', id });
  }

  onReplayFrame(handler: (id: string, frame: ReplayFrame) => void): () => void {
    this.replayHandlers.add(handler);
    return () => this.replayHandlers.delete(handler);
  }

  onReplayStatus(handler: (id: string, snapshot: ReplaySnapshot) => void): () => void {
    this.replayStatusHandlers.add(handler);
    return () => this.replayStatusHandlers.delete(handler);
  }

  // ------------------------------------------------------------------ ingest

  private receive(text: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (message.type) {
      case 'hello':
        this.applyHello(message as unknown as HelloFrame);
        break;
      case 'frames':
        this.receivedFrames += 1;
        this.lastFrameAt = Date.now();
        for (const frame of message.frames as PlatformEvent[]) this.apply(frame);
        this.notify();
        break;
      case 'replay-frame':
        for (const handler of [...this.replayHandlers]) {
          handler(String(message.id), message.frame as ReplayFrame);
        }
        break;
      case 'replay-status':
        for (const handler of [...this.replayStatusHandlers]) {
          handler(String(message.id), message.snapshot as ReplaySnapshot);
        }
        break;
      case 'error':
        // The hub reports unknown replay sessions; nothing to do but stop waiting.
        break;
      default:
        break;
    }
  }

  private applyHello(hello: HelloFrame): void {
    this.simulated = hello.simulated;
    if (hello.simNow !== null) this.simTime = hello.simNow;
    this.counts = hello.counts;

    this.services.clear();
    for (const snapshot of hello.services) {
      const service = emptyService(snapshot.code);
      service.version = snapshot.version;
      service.online = snapshot.online;
      service.lastMsgTs = snapshot.lastMsgTs;
      service.lastRecvTs = snapshot.lastRecvTs;
      service.topology = snapshot.topology;
      for (const row of snapshot.states) {
        service.states.set(`${row.entity}|${row.item}`, { ts: row.ts, value: row.value });
        this.seedScanMeta(service, row);
      }
      this.services.set(snapshot.code, service);
    }

    for (const alert of hello.alerts) {
      this.alerts.set(alert.alert_id, alert);
      this.seenAlertIds.add(alert.alert_id);
    }

    this.commands = [...hello.commands];
    this.notify();
  }

  /** Topology-shaped state (`target`, `scan_id`) is a good fallback before the scan event arrives. */
  private seedScanMeta(service: ServiceRuntime, row: StateRow): void {
    if (row.entity !== 'main') return;
    if (row.item === 'target' && row.value && typeof row.value === 'object') {
      const target = row.value as Record<string, unknown>;
      if (typeof target.id === 'string') service.scan.target = target.id;
      if (typeof target.fov_rad === 'number') service.scan.fovRad ??= target.fov_rad;
      if (typeof target.band_hz === 'number') service.scan.bandHz ??= target.band_hz;
    }
    if (row.item === 'scan_id' && typeof row.value === 'string') service.scan.scanId = row.value;
  }

  private service(code: string): ServiceRuntime {
    let service = this.services.get(code);
    if (!service) {
      service = emptyService(code);
      this.services.set(code, service);
    }
    return service;
  }

  private apply(frame: PlatformEvent): void {
    switch (frame.kind) {
      case 'telemetry':
        this.applyTelemetry(frame);
        break;
      case 'state':
        this.applyState(frame);
        break;
      case 'event':
        this.applyEvent(frame);
        break;
      case 'alert':
        this.alerts.set(frame.alert.alert_id, frame.alert);
        this.seenAlertIds.add(frame.alert.alert_id);
        break;
      case 'command': {
        const command = frame.command;
        if (!command) break;
        const index = this.commands.findIndex((c) => c.command_id === command.command_id);
        if (index >= 0) this.commands[index] = command;
        else this.commands = [command, ...this.commands].slice(0, MAX_COMMANDS);
        break;
      }
      case 'service': {
        const service = this.service(frame.service);
        service.online = frame.online;
        if (frame.lastMsgTs !== null) {
          service.lastMsgTs = frame.lastMsgTs;
          if (this.simTime === null || frame.lastMsgTs > this.simTime) this.simTime = frame.lastMsgTs;
        }
        if (frame.lastRecvTs !== null) service.lastRecvTs = frame.lastRecvTs;
        break;
      }
      case 'topology': {
        const service = this.service(frame.service);
        service.version = frame.version;
        break;
      }
      case 'broker':
        this.brokerOnline = frame.connected;
        break;
      case 'ingest':
        this.ingest = {
          received: this.ingest.received,
          dropped: frame.dropped,
          gaps: frame.gaps,
          lastRecvTs: frame.lastRecvTs,
        };
        break;
      default:
        break;
    }
  }

  private applyTelemetry(frame: Extract<PlatformEvent, { kind: 'telemetry' }>): void {
    const service = this.service(frame.service);
    const key = `${frame.stream}|${frame.entity}`;
    service.latest.set(key, { ts: frame.ts, data: frame.data });
    service.samples += 1;
    if (service.lastMsgTs === null || frame.ts > service.lastMsgTs) service.lastMsgTs = frame.ts;
    if (this.simTime === null || frame.ts > this.simTime) this.simTime = frame.ts;
    this.ingest.received += 1;

    if (frame.stream === 'scan') this.foldScanSample(service, frame.ts, frame.data);
    this.pushToRings(service, frame.stream, frame.entity, frame.ts, frame.data);
  }

  private foldScanSample(service: ServiceRuntime, ts: number, data: Record<string, unknown>): void {
    const ra = numberOrNull(data.pointing_offset_ra_rad);
    const dec = numberOrNull(data.pointing_offset_dec_rad);
    const signal = numberOrNull(data.signal_strength) ?? numberOrNull(data.snr_db);
    if (ra === null || dec === null || signal === null) return;

    const scanId = typeof data.scan_id === 'string' ? data.scan_id : null;
    // A new scan id - or the first sample after a restart - invalidates the mosaic.
    if (scanId && scanId !== service.raster.meta.scanId) {
      service.raster.reset({
        scanId,
        gridSize: service.scan.gridSize ?? 128,
        fovRad: service.scan.fovRad ?? 0.01,
        overlap: service.scan.overlap ?? 3,
        bandHz: service.scan.bandHz,
        target: service.scan.target,
        startedTs: service.scan.startedTs ?? ts,
      });
      service.scan.scanId = scanId;
    }
    if (service.raster.meta.scanId === null) {
      service.raster.reset({
        scanId: scanId ?? 'unannounced',
        gridSize: service.scan.gridSize ?? 128,
        fovRad: service.scan.fovRad ?? 0.01,
        overlap: service.scan.overlap ?? 3,
        bandHz: service.scan.bandHz,
        target: service.scan.target,
      });
    }
    service.raster.add(ra, dec, signal, ts);
  }

  /** Appends to every retained chart buffer that wants this stream. */
  private pushToRings(
    service: ServiceRuntime,
    stream: string,
    entity: string,
    ts: number,
    data: Record<string, unknown>,
  ): void {
    if (this.rings.size === 0) return;
    let touched = false;

    for (const ring of this.rings.values()) {
      if (ring.service !== service.code || ring.stream !== stream) continue;

      if (ring.entity === '*') {
        // Aggregates are sampled at 1 Hz of simulator time; a 100-dish stream
        // would otherwise produce a hundred identical points a second.
        const last = ring.points[ring.points.length - 1];
        if (last && ts - last.ts < 900) continue;
        const stats = this.aggregate(service, stream, ring.field);
        if (!stats) continue;
        ring.points.push({ ts, data: stats });
      } else {
        if (ring.entity !== entity) continue;
        const value = numberOrNull(data[ring.field]);
        if (value === null) continue;
        ring.points.push({ ts, data: { value } });
      }

      if (ring.points.length > ring.max) ring.points.splice(0, ring.points.length - ring.max);
      touched = true;
    }

    if (touched) this.notifyRings();
  }

  private applyState(frame: Extract<PlatformEvent, { kind: 'state' }>): void {
    const service = this.service(frame.service);
    service.states.set(`${frame.entity}|${frame.item}`, { ts: frame.ts, value: frame.value });
    if (frame.entity === 'main' && frame.item === 'target' && frame.value && typeof frame.value === 'object') {
      const target = frame.value as Record<string, unknown>;
      if (typeof target.id === 'string') service.scan.target = target.id;
    }
    if (frame.entity === 'main' && frame.item === 'scan_id' && typeof frame.value === 'string') {
      if (service.scan.scanId !== frame.value) {
        service.scan.scanId = frame.value;
        service.raster.reset({
          scanId: frame.value,
          gridSize: service.scan.gridSize ?? 128,
          fovRad: service.scan.fovRad ?? 0.01,
          overlap: service.scan.overlap ?? 3,
          bandHz: service.scan.bandHz,
          target: service.scan.target,
        });
      }
    }
  }

  private applyEvent(frame: Extract<PlatformEvent, { kind: 'event' }>): void {
    const service = this.service(frame.service);
    const event: LiveEvent = {
      id: (this.eventSeq += 1),
      service: frame.service,
      name: frame.name,
      ts: frame.ts,
      payload: frame.payload,
    };
    service.events = [event, ...service.events].slice(0, MAX_EVENTS);

    if (frame.name === 'scan') {
      const payload = frame.payload;
      service.scan = {
        scanId: typeof payload.scan_id === 'string' ? payload.scan_id : service.scan.scanId,
        target: typeof payload.target === 'string' ? payload.target : service.scan.target,
        bandHz: numberOrNull(payload.band_hz) ?? service.scan.bandHz,
        gridSize: numberOrNull(payload.grid_size) ?? service.scan.gridSize,
        fovRad: numberOrNull(payload.fov_rad) ?? service.scan.fovRad,
        overlap: numberOrNull(payload.overlap) ?? service.scan.overlap,
        expectedDurationS: numberOrNull(payload.expected_duration_s) ?? service.scan.expectedDurationS,
        startedTs: typeof payload.started_at === 'number' ? payload.started_at : frame.ts,
        dishes: Array.isArray(payload.dishes) ? payload.dishes.length : service.scan.dishes,
      };
      service.raster.reset({
        scanId: service.scan.scanId,
        gridSize: service.scan.gridSize ?? 128,
        fovRad: service.scan.fovRad ?? 0.01,
        overlap: service.scan.overlap ?? 3,
        bandHz: service.scan.bandHz,
        target: service.scan.target,
        origin: typeof payload.origin === 'string' ? payload.origin : null,
        startedTs: service.scan.startedTs,
        expectedDurationS: service.scan.expectedDurationS,
        fromEvent: true,
      });
    }
  }

  // ---------------------------------------------------------------- accessors

  /** Mean/min/max/sd of a numeric field across every entity currently reporting it. */
  aggregate(
    service: ServiceRuntime,
    stream: string,
    field: string,
  ): { value: number; min: number; max: number; sd: number; n: number } | null {
    let sum = 0;
    let sumSq = 0;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let n = 0;
    for (const [key, sample] of service.latest) {
      if (!key.startsWith(`${stream}|`)) continue;
      const value = numberOrNull(sample.data[field]);
      if (value === null) continue;
      sum += value;
      sumSq += value * value;
      if (value < min) min = value;
      if (value > max) max = value;
      n += 1;
    }
    if (n === 0) return null;
    const mean = sum / n;
    return { value: mean, min, max, sd: Math.sqrt(Math.max(0, sumSq / n - mean * mean)), n };
  }

  sample(service: string, stream: string, entity: string): Sample | undefined {
    return this.services.get(service)?.latest.get(`${stream}|${entity}`);
  }

  state(service: string, entity: string, item: string): unknown {
    return this.services.get(service)?.states.get(`${entity}|${item}`)?.value;
  }

  stateEntry(service: string, entity: string, item: string): StateEntry | undefined {
    return this.services.get(service)?.states.get(`${entity}|${item}`);
  }

  /** Latest value of a field, whatever entity reported it most recently. */
  latestField(service: string, stream: string, field: string): number | null {
    const runtime = this.services.get(service);
    if (!runtime) return null;
    let best: Sample | undefined;
    for (const [key, sample] of runtime.latest) {
      if (!key.startsWith(`${stream}|`)) continue;
      if (!best || sample.ts > best.ts) best = sample;
    }
    return best ? numberOrNull(best.data[field]) : null;
  }

  activeAlerts(): AlertRecord[] {
    return [...this.alerts.values()]
      .filter((alert) => alert.resolved_ts === null && alert.status === 'raised')
      .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.last_ts - a.last_ts);
  }

  clearedAlerts(): AlertRecord[] {
    return [...this.alerts.values()]
      .filter((alert) => alert.resolved_ts === null && alert.status === 'cleared')
      .sort((a, b) => b.last_ts - a.last_ts);
  }

  upsertAlert(alert: AlertRecord): void {
    this.alerts.set(alert.alert_id, alert);
    this.seenAlertIds.add(alert.alert_id);
    this.notify();
  }

  dropAlert(alertId: string): void {
    this.alerts.delete(alertId);
    this.notify();
  }

  // -------------------------------------------------------------------- rings

  private ringKey(service: string, stream: string, entity: string, field: string): string {
    return `${service}|${stream}|${entity}|${field}`;
  }

  /** Idempotent: several charts can share one buffer. */
  retain(service: string, stream: string, entity: string, field: string, max = 900): Ring {
    const key = this.ringKey(service, stream, entity, field);
    let ring = this.rings.get(key);
    if (!ring) {
      ring = { key, service, stream, entity, field, points: [], max };
      this.rings.set(key, ring);
    }
    return ring;
  }

  release(service: string, stream: string, entity: string, field: string): void {
    this.rings.delete(this.ringKey(service, stream, entity, field));
  }

  /** Seeded by a component after it backfills from `/api/series`. */
  seed(ring: Ring, points: Sample[]): void {
    const merged = [...points, ...ring.points].sort((a, b) => a.ts - b.ts);
    const seen = new Set<number>();
    ring.points = merged
      .filter((point) => {
        if (seen.has(point.ts)) return false;
        seen.add(point.ts);
        return true;
      })
      .slice(-ring.max);
    this.notifyRings();
  }
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function severityRank(severity: string): number {
  return severity === 'critical' ? 3 : severity === 'warning' ? 2 : 1;
}

export const live = new LiveClient();
