import type {
  AlertCounts,
  AlertLimit,
  AlertRecord,
  AlertTransition,
  CommandAckRow,
  CommandRow,
  DerivedResponse,
  ReplaySnapshot,
  Researcher,
  StateRow,
  Target,
  Topology,
} from './types';

/**
 * Thin REST client.
 *
 * Everything the console does that is not a live sample goes through here; the
 * WebSocket only carries pushes. Errors are surfaced as `ApiError` so the UI can
 * show the service's own reason code (`precondition_failed`, `out_of_range`, ...)
 * instead of a generic failure banner.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (error) {
    throw new ApiError(0, 'network_unreachable', error instanceof Error ? error.message : String(error));
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const payload: unknown = text ? safeParse(text) : null;

  if (!response.ok) {
    const body = (payload ?? {}) as { error?: string; detail?: string };
    throw new ApiError(response.status, body.error ?? `http_${response.status}`, body.detail);
  }
  return payload as T;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface SeriesResponse {
  service: string;
  stream: string;
  entity: string | null;
  from: number;
  to: number;
  total: number;
  stride: number;
  rows: Array<{ entity: string; ts: number; seq: number | null; data: Record<string, unknown> }>;
}

export interface RangeResponse {
  minTs: number | null;
  maxTs: number | null;
  rows: number;
}

export interface ServiceRow {
  code: string;
  version: string | null;
  online: boolean | null;
  lastMsgTs: number | null;
  lastRecvTs: number | null;
  topology: {
    version: string;
    entities: number;
    entityKinds: string[];
    streams: unknown[];
    states: unknown[];
    events: unknown[];
    controls: number;
  } | null;
  counts: { entities: number; streams: number; telemetry: number; alertsOpen: number } | null;
  alerts: { open: number; critical: number; unacknowledged: number };
}

export interface HealthResponse {
  ok: boolean;
  uptimeMs: number;
  broker: boolean;
  arl: { ok: boolean; status?: string; database?: boolean; broker?: boolean };
  ingest: { received: number; dropped: number; unparsed: number; gaps: number; lastRecvTs: number | null };
  alerts: AlertCounts;
  simNow: number | null;
  simulated: boolean;
  services: string[];
  db: string;
}

export interface CommandInput {
  service: string;
  entity: string;
  control: string;
  value: unknown;
  researcher: string;
}

export const api = {
  health: () => request<HealthResponse>('/health'),
  services: () => request<ServiceRow[]>('/services'),
  topology: (service: string) => request<Topology & { entities: never }>(`/services/${service}/topology`),
  states: (service: string) => request<StateRow[]>(`/states?service=${encodeURIComponent(service)}`),
  range: (service: string) => request<RangeResponse>(`/range?service=${encodeURIComponent(service)}`),
  series: (params: { service: string; stream: string; entity?: string; from: number; to: number; limit?: number }) => {
    const query = new URLSearchParams({
      service: params.service,
      stream: params.stream,
      from: String(params.from),
      to: String(params.to),
    });
    if (params.entity) query.set('entity', params.entity);
    if (params.limit) query.set('limit', String(params.limit));
    return request<SeriesResponse>(`/series?${query.toString()}`);
  },
  targets: () => request<Target[]>('/targets'),
  derived: () => request<DerivedResponse>('/derived'),
  /** The wire shape is the ARL API's own: a flat list of `{ key, value, unit }`. */
  alertLimits: (service: string) => request<AlertLimit[]>(`/alert-limits/${encodeURIComponent(service)}`),
  researchers: (code: string) => request<Researcher & { cached: boolean }>(`/researchers/${encodeURIComponent(code)}`),
  alerts: (params: { status?: string; service?: string; limit?: number } = {}) => {
    const query = new URLSearchParams();
    if (params.status) query.set('status', params.status);
    if (params.service) query.set('service', params.service);
    if (params.limit) query.set('limit', String(params.limit));
    return request<{ alerts: AlertRecord[]; counts: AlertCounts }>(`/alerts?${query.toString()}`);
  },
  alert: (id: string) =>
    request<{ alert: AlertRecord; transitions: AlertTransition[]; researcher: Researcher | null }>(
      `/alerts/${encodeURIComponent(id)}`,
    ),
  acknowledge: (id: string, body: { researcher: string; note?: string }) =>
    request<{ alert: AlertRecord }>(`/alerts/${encodeURIComponent(id)}/acknowledge`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  resolve: (id: string, body: { researcher: string; resolution: string; cause?: string }) =>
    request<{ alert: AlertRecord }>(`/alerts/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  commands: (limit = 50) => request<CommandRow[]>(`/commands?limit=${limit}`),
  commandAcks: (id: string) => request<CommandAckRow[]>(`/commands/${encodeURIComponent(id)}/acks`),
  sendCommand: (body: CommandInput) =>
    request<CommandRow>('/commands', { method: 'POST', body: JSON.stringify(body) }),
  replays: () => request<ReplaySnapshot[]>('/replay'),
  createReplay: (body: { services: string[]; from: number; to: number; speed?: number }) =>
    request<ReplaySnapshot>('/replay', { method: 'POST', body: JSON.stringify(body) }),
  replayAction: (id: string, action: 'play' | 'pause') =>
    request<ReplaySnapshot>(`/replay/${id}/${action}`, { method: 'POST' }),
  replaySpeed: (id: string, speed: number) =>
    request<ReplaySnapshot>(`/replay/${id}/speed`, { method: 'POST', body: JSON.stringify({ speed }) }),
  replaySeek: (id: string, ts: number) =>
    request<ReplaySnapshot>(`/replay/${id}/seek`, { method: 'POST', body: JSON.stringify({ ts }) }),
  deleteReplay: (id: string) => request<void>(`/replay/${id}`, { method: 'DELETE' }),
};

export function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.detail ? `${error.code} \u2014 ${error.detail}` : error.code;
  return error instanceof Error ? error.message : String(error);
}
