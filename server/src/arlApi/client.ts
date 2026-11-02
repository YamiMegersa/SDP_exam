import axios, { AxiosInstance, isAxiosError } from 'axios';
import type { Config } from '../config';
import type { ResearcherRecord, VerifyResult } from '../types';
import type { Store } from '../db/store';
import { logger } from '../util/log';

const log = logger('arl-api');

export interface AlertLimit {
  key: string;
  value: number;
  unit: string | null;
}

export interface Target {
  id: string;
  name: string;
  ra_rad: number;
  dec_rad: number;
  fov_rad: number;
  category: string;
}

interface CacheEntry {
  expires: number;
  value: unknown;
}

/**
 * Three-way answer for "who is this?", because "not a researcher" and "the directory is down"
 * must not collapse into the same refusal: the first is the operator's mistake (403), the second
 * is ours (503).
 */
export type IdentityResult =
  | { status: 'verified'; record: ResearcherRecord }
  | { status: 'unknown' }
  | { status: 'unavailable' };

/**
 * Thin, cached client for the ARL's read-only support API.
 *
 * The live deployment allows 20 requests/second (burst 40) and a single concurrent backlog download,
 * so nothing in the ingest path is allowed to call it: researcher checks, alert limits and the target
 * catalogue are cached and single-flight.
 */
export class ArlApi {
  private readonly http: AxiosInstance;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly cfg: Config,
    private readonly store: Store,
  ) {
    this.http = axios.create({
      baseURL: cfg.arl.baseUrl,
      timeout: cfg.arl.timeoutMs,
      headers: { accept: 'application/json' },
      // 4xx are meaningful answers here, not transport failures.
      validateStatus: (status) => status >= 200 && status < 400,
    });
  }

  get baseUrl(): string {
    return this.cfg.arl.baseUrl;
  }

  private async fetchCached<T>(
    key: string,
    ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.value as T;
    const running = this.inflight.get(key);
    if (running) return running as Promise<T>;
    const promise = fn()
      .then((value) => {
        this.cache.set(key, { expires: Date.now() + ttlMs, value });
        return value;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  /** GET /v1/researchers/{code} - cached; also persisted as a last-known record for display. */
  async researcher(code: string): Promise<ResearcherRecord | null> {
    const key = `researcher:${code}`;
    try {
      return await this.fetchCached<ResearcherRecord | null>(key, this.cfg.researcherCacheTtlMs, async () => {
        const res = await this.http.get(`/v1/researchers/${encodeURIComponent(code)}`);
        if (res.status === 404) return null;
        const record = normaliseResearcher(res.data);
        if (record) this.store.cacheResearcher(record);
        return record;
      });
    } catch (error) {
      const cached = this.store.cachedResearcher(code, Number.MAX_SAFE_INTEGER);
      log.warn(`researcher lookup failed for ${code}: ${describe(error)}`);
      return cached;
    }
  }

  /**
   * GET /v1/researchers/{code} - the identity gate for anything that writes an audit trail.
   *
   * Unlike `researcher()`, which falls back to the last-known record so a name still renders when
   * the directory is down, this fails closed: without an answer from the API nothing is recorded
   * under that code, and the caller is told whether the code was unknown or unverifiable.
   */
  async identify(code: string): Promise<IdentityResult> {
    try {
      const record = await this.fetchCached<ResearcherRecord | null>(
        `researcher:${code}`,
        this.cfg.researcherCacheTtlMs,
        async () => {
          const res = await this.http.get(`/v1/researchers/${encodeURIComponent(code)}`);
          if (res.status === 404) return null;
          const normalised = normaliseResearcher(res.data);
          if (normalised) this.store.cacheResearcher(normalised);
          return normalised;
        },
      );
      return record ? { status: 'verified', record } : { status: 'unknown' };
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 404) return { status: 'unknown' };
      log.warn(`identity check failed for ${code}: ${describe(error)}`);
      return { status: 'unavailable' };
    }
  }

  /**
   * POST /v1/researchers/verify - the authoritative answer for "may this code control this service?".
   * Fails closed: an unreachable API never grants control.
   */
  async verify(code: string, service: string): Promise<VerifyResult> {
    const key = `verify:${code}:${service}`;
    try {
      const result = await this.fetchCached<VerifyResult>(key, this.cfg.researcherCacheTtlMs, async () => {
        const res = await this.http.post('/v1/researchers/verify', { code, service });
        const valid = Boolean(res.data?.valid);
        return { valid, reason: res.data?.reason ?? (valid ? null : 'unknown') };
      });
      const record = await this.researcher(code).catch(() => null);
      return { ...result, researcher: record ?? undefined };
    } catch (error) {
      log.warn(`verify failed for ${code} on ${service}: ${describe(error)}`);
      return { valid: false, reason: 'api_unavailable' };
    }
  }

  /** GET /v1/alert-limits/{service} - the services re-read these every 5 minutes; mirror that. */
  async alertLimits(service: string): Promise<AlertLimit[]> {
    const key = `limits:${service}`;
    try {
      return await this.fetchCached<AlertLimit[]>(key, 300_000, async () => {
        const res = await this.http.get(`/v1/alert-limits/${encodeURIComponent(service)}`);
        return (Array.isArray(res.data) ? res.data : []).flatMap((r: Record<string, unknown>) => {
          if (typeof r.key !== 'string' || typeof r.value !== 'number') return [];
          return [{ key: r.key, value: r.value, unit: (r.unit as string | null) ?? null }];
        });
      });
    } catch (error) {
      log.warn(`alert limits unavailable for ${service}: ${describe(error)}`);
      return [];
    }
  }

  /** GET /v1/targets - the RTA target catalogue, used by the Set Target control. */
  async targets(): Promise<Target[]> {
    try {
      return await this.fetchCached<Target[]>('targets', 300_000, async () => {
        const res = await this.http.get('/v1/targets');
        return (Array.isArray(res.data) ? res.data : []).flatMap((t: Record<string, unknown>) => {
          if (typeof t.id !== 'string') return [];
          return [
            {
              id: t.id,
              name: String(t.name ?? t.id),
              ra_rad: Number(t.ra_rad ?? 0),
              dec_rad: Number(t.dec_rad ?? 0),
              fov_rad: Number(t.fov_rad ?? 0),
              category: String(t.category ?? ''),
            },
          ];
        });
      });
    } catch (error) {
      log.warn(`target catalogue unavailable: ${describe(error)}`);
      return [];
    }
  }

  async health(): Promise<{ ok: boolean; status?: string; database?: boolean; broker?: boolean | null }> {
    try {
      const res = await this.http.get('/healthz', { timeout: Math.min(2000, this.cfg.arl.timeoutMs) });
      return { ok: res.data?.status === 'ok', ...res.data };
    } catch (error) {
      return { ok: false, status: describe(error) };
    }
  }

  invalidate(): void {
    this.cache.clear();
  }
}

export const RESEARCHER_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{2,31}$/i;

export function isWellFormedCode(code: string): boolean {
  return RESEARCHER_CODE_PATTERN.test(code);
}

function normaliseResearcher(data: unknown): ResearcherRecord | null {
  if (!data || typeof data !== 'object') return null;
  const rec = data as Record<string, unknown>;
  if (typeof rec.code !== 'string') return null;
  return {
    code: rec.code,
    name: typeof rec.name === 'string' ? rec.name : rec.code,
    experiments: Array.isArray(rec.experiments)
      ? rec.experiments.filter((e): e is string => typeof e === 'string')
      : [],
    status: typeof rec.status === 'string' ? rec.status : 'unknown',
  };
}

function describe(error: unknown): string {
  if (isAxiosError(error)) {
    if (error.response) return `HTTP ${error.response.status}`;
    return error.code ?? error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
