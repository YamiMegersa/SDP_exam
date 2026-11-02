import { api } from './api';
import type { Target } from './types';

/**
 * The ARL target catalogue, and the mapping from a raw pointing back to a name.
 *
 * The array publishes `main/state/target` as `{ra_rad, dec_rad, fov_rad}` - there
 * is no id in the payload - and the scan event carries the same object. Operators
 * recognise "Centaurus A", not "RA 3.5145 / DEC -0.7508", so the console matches
 * the pointing against the catalogue the read-only ARL API hands out.
 *
 * The cache lives outside React because `live.ts` formats replayed frames too,
 * and nothing should depend on a component having mounted first.
 */

let cache: Target[] | null = null;
let inflight: Promise<Target[]> | null = null;

export function cachedTargets(): Target[] {
  return cache ?? [];
}

export function loadTargets(): Promise<Target[]> {
  if (cache) return Promise.resolve(cache);
  inflight ??= api
    .targets()
    .then((rows) => {
      cache = rows;
      return rows;
    })
    .catch((cause: unknown) => {
      inflight = null;
      throw cause;
    });
  return inflight;
}

/** Pointings are exact copies of catalogue values; allow for published rounding. */
const MATCH_RAD = 1e-3;

export function matchTarget(raRad: unknown, decRad: unknown): Target | null {
  const ra = typeof raRad === 'number' ? raRad : null;
  const dec = typeof decRad === 'number' ? decRad : null;
  if (ra === null || dec === null) return null;
  for (const target of cachedTargets()) {
    if (Math.abs(target.ra_rad - ra) <= MATCH_RAD && Math.abs(target.dec_rad - dec) <= MATCH_RAD) return target;
  }
  return null;
}

/**
 * Label for any shape the services use for a pointing: a plain string, the
 * catalogue object, or the object embedded in a scan event payload.
 */
export function targetLabel(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (typeof record.name === 'string') return record.name;
  if (typeof record.id === 'string') return record.id;
  const hit = matchTarget(record.ra_rad, record.dec_rad);
  if (hit) return hit.name;
  const ra = record.ra_rad;
  const dec = record.dec_rad;
  if (typeof ra === 'number' && typeof dec === 'number') {
    return `RA ${ra.toFixed(3)} / DEC ${dec.toFixed(3)}`;
  }
  return null;
}
