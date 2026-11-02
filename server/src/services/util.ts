import type { AlertLimit } from '../arlApi/client';

/**
 * Small numeric helpers shared by the service plugins.
 *
 * They all treat a missing sample as missing: nothing here substitutes 0 for `null`, because a
 * measure that silently invents a reading is worse than one that reports it could not answer.
 */
export function limit(limits: AlertLimit[], key: string): number | null {
  const hit = limits.find((entry) => entry.key === key);
  return hit && Number.isFinite(hit.value) ? hit.value : null;
}

export function newest(samples: Array<{ ts: number }>): number | null {
  if (samples.length === 0) return null;
  return samples.reduce((acc, sample) => Math.max(acc, sample.ts), 0);
}

export function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** Great-circle angle between two az/el pointings, in radians. */
export function angularDistance(
  actual: Record<string, unknown>,
  want: Record<string, unknown>,
): number | null {
  const a = vector(actual.azimuth_rad, actual.elevation_rad);
  const b = vector(want.azimuth_rad, want.elevation_rad);
  if (!a || !b) return null;
  const dot = clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1);
  return Math.acos(dot);
}

function vector(azimuth: unknown, elevation: unknown): [number, number, number] | null {
  const az = asNumber(azimuth);
  const el = asNumber(elevation);
  if (az === null || el === null) return null;
  return [Math.cos(el) * Math.cos(az), Math.cos(el) * Math.sin(az), Math.sin(el)];
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

export function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

export function max(values: number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}

export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

export function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** Radians to degrees, the unit an operator reads a pointing error in. */
export function toDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}
