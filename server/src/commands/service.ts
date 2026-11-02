import { randomUUID } from 'node:crypto';
import type { ArlApi } from '../arlApi/client';
import { isWellFormedCode } from '../arlApi/client';
import type { Config } from '../config';
import type { CommandRow, Store } from '../db/store';
import type { Ingest } from '../mqtt/ingest';
import type { PlatformBus } from '../platform/events';
import { validateControlValue } from '../topology/registry';
import type { TopologyRegistry } from '../topology/registry';
import type { CommandAck } from '../types';
import type { SimClock } from '../util/clock';
import { logger, maskCode } from '../util/log';

const log = logger('commands');

export type SendResult =
  | { ok: true; command: CommandRow }
  | { ok: false; status: number; error: string; detail?: string };

export interface SendInput {
  service: string;
  entity: string;
  control: string;
  value: unknown;
  researcher: string;
}

/**
 * Turns an operator's intent into a command on the wire.
 *
 * The platform is not the authority on who may control what: the ARL support API answers that, and
 * the answer is required before anything is published. A rejection is returned with the API's own
 * reason code so the operator sees "researcher_not_permitted" instead of a generic failure.
 */
export class CommandService {
  private timer: NodeJS.Timeout | null = null;
  /** How long a command may sit unacknowledged before it is marked timed out. */
  private readonly settleTimeoutMs: number;

  constructor(
    private readonly cfg: Config,
    private readonly store: Store,
    private readonly registry: TopologyRegistry,
    private readonly ingest: Ingest,
    private readonly api: ArlApi,
    private readonly bus: PlatformBus,
    private readonly clock: SimClock,
  ) {
    this.settleTimeoutMs = 45_000;
    this.ingest.onAck((service, ack) => this.receiveAck(service, ack));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.expire(), 10_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async send(input: SendInput): Promise<SendResult> {
    const topology = this.registry.get(input.service);
    if (!topology) {
      return { ok: false, status: 404, error: 'unknown_service' };
    }

    const entity = input.entity?.trim();
    const control = input.control?.trim();
    if (!entity || !control) {
      return { ok: false, status: 400, error: 'malformed', detail: 'entity and control are required' };
    }

    if (!topology.entityById.has(entity)) {
      return { ok: false, status: 422, error: 'unknown_target', detail: entity };
    }

    const def = topology.controlFor(entity, control);
    if (!def) {
      return { ok: false, status: 422, error: 'unknown_control', detail: control };
    }

    const checked = validateControlValue(def.value, input.value);
    if (!checked.ok) {
      return { ok: false, status: 400, error: 'invalid_value', detail: checked.error };
    }

    const code = (input.researcher ?? '').trim().toLowerCase();
    if (!isWellFormedCode(code)) {
      return { ok: false, status: 400, error: 'malformed', detail: 'researcher code is not well formed' };
    }

    const verdict = await this.api.verify(code, input.service);
    if (!verdict.valid) {
      log.warn(`control refused for ${maskCode(code)} on ${input.service}: ${verdict.reason}`);
      return {
        ok: false,
        status: verdict.reason === 'api_unavailable' ? 503 : 403,
        error: verdict.reason ?? 'researcher_not_permitted',
        detail: verdict.researcher ? `researcher ${verdict.researcher.code}` : undefined,
      };
    }

    const commandId = randomUUID();
    const topic = `arl/${input.service}/cmd/${entity}/${control}`;
    const row: CommandRow = {
      command_id: commandId,
      service: input.service,
      entity,
      control,
      value: checked.value,
      researcher: code,
      topic,
      sent_ts: this.clock.forService(input.service),
      sent_wall_ts: Date.now(),
      state: 'queued',
      progress: null,
      reason: null,
      detail: null,
      settled_ts: null,
    };

    this.store.insertCommand(row);

    try {
      // The wire envelope is exactly what the service spec defines; nothing extra is added so a
      // strict consumer cannot reject the command for unexpected fields.
      await this.ingest.publishCommand(topic, {
        command_id: commandId,
        researcher: code,
        value: checked.value,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.store.applyAck(
        { command_id: commandId, state: 'failed', reason: 'platform_publish_failed', detail },
        row.sent_ts,
      );
      const failed = this.store.getCommand(commandId);
      this.bus.emit({ kind: 'command', command: failed });
      log.error(`could not publish ${topic}: ${detail}`);
      return { ok: false, status: 503, error: 'broker_unavailable', detail };
    }

    const stored = this.store.getCommand(commandId) ?? row;
    this.bus.emit({ kind: 'command', command: stored });
    log.info(
      `${maskCode(code)} sent ${input.service}/${entity}/${control} as ${commandId.slice(0, 8)}`,
    );
    return { ok: true, command: stored };
  }

  /** An ack from `arl/<svc>/ack/<command_id>`. Never throws: a bad ack must not kill ingest. */
  receiveAck(service: string, ack: CommandAck): void {
    const valid = ['accepted', 'rejected', 'in_progress', 'completed', 'failed'];
    if (!ack || typeof ack.command_id !== 'string') return;
    if (ack.state && !valid.includes(ack.state)) {
      log.warn(`ignoring ack for ${ack.command_id} with unknown state "${ack.state}"`);
      return;
    }
    try {
      const ts = this.clock.forService(service);
      const { row, terminal } = this.store.applyAck(ack, ts);
      if (!row) {
        // Acks for commands sent by someone else (another instance of the platform) still get
        // recorded by the caller, but there is no local row to attach them to.
        log.debug(`ack for unknown command ${ack.command_id}`);
        return;
      }
      this.bus.emit({ kind: 'command', command: row, ack });
      if (terminal) {
        log.info(`command ${ack.command_id.slice(0, 8)} ${ack.state}${ack.reason ? ` (${ack.reason})` : ''}`);
      }
    } catch (error) {
      log.error(`failed to apply ack ${ack.command_id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private expire(): void {
    try {
      const expired = this.store.expireCommands(Date.now() - this.settleTimeoutMs);
      for (const row of expired) {
        this.bus.emit({ kind: 'command', command: row });
      }
      if (expired.length > 0) log.warn(`${expired.length} command(s) timed out without an ack`);
    } catch (error) {
      log.error(`command expiry sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
