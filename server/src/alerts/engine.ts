import type { AlertPayload, AlertRecord } from '../types';
import type { GapRow, Store } from '../db/store';
import type { PlatformBus } from '../platform/events';
import type { SimClock } from '../util/clock';
import { logger } from '../util/log';

const log = logger('alerts');

/** Platform alert ids are namespaced so they can never collide with a service's own alert ids. */
const prefix = (service: string, type: string) => `platform/${service}/${type}`;

export interface AlertEngineOptions {
  services: string[];
  /** How long a service may be silent before its feed is declared stale. */
  silenceMs: number;
  /** How long after the last gap an ingest-gap alert stays raised. */
  gapRecoveryMs?: number;
  sweepMs?: number;
}

/**
 * Owns the alert lifecycle.
 *
 * Service alerts arrive on `arl/<svc>/events/alert` and are stored verbatim: the platform never
 * invents or suppresses a service condition, it only records the transitions and the researcher's
 * acknowledgement. Alongside those it raises its own "this monitoring pipeline is broken" alerts
 * (offline service, silent feed, ingest gap, broker loss) so that an empty screen is never mistaken
 * for a healthy system.
 */
export class AlertEngine {
  private timer: NodeJS.Timeout | null = null;
  private readonly startedAt = Date.now();
  private readonly lastGap = new Map<string, number>();
  private readonly gapTotals = new Map<string, number>();
  private brokerConnected = true;

  constructor(
    private readonly store: Store,
    private readonly bus: PlatformBus,
    private readonly clock: SimClock,
    private readonly opts: AlertEngineOptions,
  ) {}

  start(): void {
    if (this.timer) return;
    const every = this.opts.sweepMs ?? 10_000;
    this.timer = setInterval(() => this.sweep(), every);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** A service-reported alert. `alert_id` is stable across escalation, so repeats are updates. */
  serviceAlert(
    service: string,
    payload: AlertPayload,
    entity: string | null,
  ): { alert: AlertRecord; change: string } | null {
    if (!payload || typeof payload.alert_id !== 'string' || !payload.alert_id) {
      log.warn(`${service}: alert event without an alert_id, ignored`);
      return null;
    }
    if (payload.state !== 'raised' && payload.state !== 'cleared') {
      log.warn(`${service}: alert ${payload.alert_id} has unknown state "${String(payload.state)}"`);
      return null;
    }
    const ts = Number.isFinite(payload.ts) ? Number(payload.ts) : this.clock.forService(service);
    try {
      const result = this.store.applyAlertEvent(
        service,
        { ...payload, severity: payload.severity ?? 'warning' },
        ts,
        Date.now(),
        entity,
      );
      this.bus.emit({ kind: 'alert', alert: result.alert, change: result.change });
      return result;
    } catch (error) {
      log.error(`failed to record alert ${payload.alert_id}: ${describe(error)}`);
      return null;
    }
  }

  /** The service's own `state/online` item, or its last will when the process dies. */
  online(service: string, online: boolean): void {
    this.raise(service, 'offline', {
      type: 'service_offline',
      severity: 'critical',
      raised: !online,
      message: online ? `${service} is publishing again` : `${service} reports itself offline`,
    });
    this.bus.emit({
      kind: 'service',
      service,
      online,
      lastRecvTs: Date.now(),
      lastMsgTs: this.clock.forService(service),
    });
  }

  broker(connected: boolean, detail?: string): void {
    if (this.brokerConnected === connected) return;
    this.brokerConnected = connected;
    this.raise('platform', 'broker', {
      type: 'broker_disconnected',
      severity: 'critical',
      raised: !connected,
      message: connected
        ? 'Reconnected to the MQTT broker'
        : `Lost the MQTT broker connection${detail ? `: ${detail}` : ''}`,
    });
    this.bus.emit({ kind: 'broker', connected, detail });
  }

  /**
   * A sequence gap means samples were dropped between the service and the platform.
   *
   * RTA publishes at ~90 msg/s, so gaps are expected under load; the alert is what makes the loss
   * visible instead of leaving a hole in a chart that looks like a flat line.
   */
  ingestGap(service: string, gap: GapRow): void {
    this.store.recordGap(gap);
    this.lastGap.set(service, gap.wallTs);
    this.gapTotals.set(service, (this.gapTotals.get(service) ?? 0) + gap.missed);
    this.raise(service, 'ingest-gap', {
      type: 'ingest_gap',
      severity: gap.missed > 25 ? 'warning' : 'info',
      raised: true,
      message:
        `${gap.missed} sample${gap.missed === 1 ? '' : 's'} missed on ${gap.topic} ` +
        `(expected seq ${gap.expectedSeq}, received ${gap.receivedSeq})`,
      metadata: {
        topic: gap.topic,
        stream: gap.stream,
        entity: gap.entity,
        missed: gap.missed,
        totalMissed: this.gapTotals.get(service) ?? gap.missed,
      },
    });
  }

  private raise(
    service: string,
    id: string,
    input: {
      type: string;
      severity: 'info' | 'warning' | 'critical';
      raised: boolean;
      message: string;
      metadata?: Record<string, unknown>;
    },
  ): void {
    const ts = this.clock.forService(service);
    try {
      const result = this.store.setPlatformAlert({
        alertId: prefix(service, id),
        service,
        type: input.type,
        severity: input.severity,
        raised: input.raised,
        message: input.message,
        ts,
        wallTs: Date.now(),
        metadata: input.metadata,
      });
      const alert = result?.alert ?? this.store.getAlert(prefix(service, id));
      if (alert) {
        this.bus.emit({ kind: 'alert', alert, change: result?.change ?? 'updated' });
      }
    } catch (error) {
      log.error(`failed to set platform alert ${prefix(service, id)}: ${describe(error)}`);
    }
  }

  /** Periodic health sweep: a feed that stops receiving data is an alert, not a blank chart. */
  sweep(): void {
    const now = Date.now();
    const rows = this.store.listServices();
    const byCode = new Map(rows.map((r) => [r.code, r]));
    const gapRecovery = this.opts.gapRecoveryMs ?? 120_000;

    for (const code of this.opts.services) {
      const row = byCode.get(code);
      const lastRecv = row?.last_recv_ts ?? null;
      const reference = lastRecv ?? this.startedAt;
      const silentFor = now - reference;
      if (silentFor > this.opts.silenceMs) {
        this.raise(code, 'silent', {
          type: 'service_silent',
          severity: 'warning',
          raised: true,
          message: `No data from ${code} for ${Math.round(silentFor / 1000)}s`,
          metadata: { lastRecvTs: lastRecv, silentFor },
        });
      } else {
        this.raise(code, 'silent', {
          type: 'service_silent',
          severity: 'warning',
          raised: false,
          message: `${code} is publishing`,
        });
      }

      const lastGapAt = this.lastGap.get(code) ?? 0;
      if (lastGapAt > 0 && now - lastGapAt > gapRecovery) {
        this.raise(code, 'ingest-gap', {
          type: 'ingest_gap',
          severity: 'info',
          raised: false,
          message: 'No further sample loss observed',
        });
        this.lastGap.delete(code);
        this.gapTotals.delete(code);
      }
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
