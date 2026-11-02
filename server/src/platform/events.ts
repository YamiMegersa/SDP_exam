import type { AlertRecord, CommandAck } from '../types';
import type { CommandRow } from '../db/store';
import type { Bus } from './bus';

/**
 * Everything the platform pushes to connected browsers.
 *
 * Field names stay explicit because these frames are also the payloads of the websocket API, and the
 * client renders them directly.
 */
export type PlatformEvent =
  | {
      kind: 'telemetry';
      service: string;
      entity: string;
      stream: string;
      ts: number;
      seq: number | null;
      backfill: boolean;
      data: Record<string, unknown>;
    }
  | {
      kind: 'state';
      service: string;
      entity: string;
      item: string;
      ts: number;
      value: unknown;
    }
  | {
      kind: 'event';
      service: string;
      name: string;
      ts: number;
      payload: Record<string, unknown>;
    }
  | { kind: 'alert'; alert: AlertRecord; change: string }
  | { kind: 'command'; command: CommandRow | null; ack?: CommandAck }
  | { kind: 'topology'; service: string; version: string }
  | {
      kind: 'service';
      service: string;
      online: boolean | null;
      lastRecvTs: number | null;
      lastMsgTs: number | null;
    }
  | { kind: 'broker'; connected: boolean; detail?: string }
  | { kind: 'ingest'; dropped: number; gaps: number; lastRecvTs: number };

export type PlatformBus = Bus<PlatformEvent>;
