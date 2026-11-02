/**
 * Number formatters used by every narrative template.
 *
 * They live here so a template never has to decide whether to call `toFixed` or `toPrecision`,
 * and so a snapshot test can assert that no template emits `undefined`, `NaN`, or a doubled
 * space (Planning Docs/05 §4.3.2).
 */

/** Format a number with its unit: `335.2 K`, `1,200 ppm`, `48.0 %`. */
export function fmt(value: number | null | undefined, unit: string | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  // Keep one decimal for values under 1000 (temperatures, rates, percentages); round integers
  // above that (counts of dishes, watts over a few thousand). `toLocaleString('en-GB')` adds
  // the thousands separator.
  const rounded = Math.abs(value) >= 1000 ? Math.round(value) : Number(value.toFixed(1));
  const text = rounded.toLocaleString('en-GB');
  return unit ? `${text} ${unit}` : text;
}

/** Signed delta to a limit: `+2.2 K`, `−0.3 K/s`. */
export function fmtDelta(value: number, unit: string | null | undefined, signed = true): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const rounded = abs >= 100 ? Math.round(abs) : Number(abs.toFixed(1));
  const sign = signed ? (value < 0 ? '−' : value > 0 ? '+' : '') : value < 0 ? '−' : '';
  const text = `${sign}${rounded.toLocaleString('en-GB')}`;
  return unit ? `${text} ${unit}` : text;
}

/** Rate of change per minute, computed from two samples. */
export function fmtRate(
  from: { ts: number; value: number } | null,
  to: { ts: number; value: number } | null,
  unit: string | null | undefined,
): string | null {
  if (!from || !to) return null;
  const dtMin = (to.ts - from.ts) / 60_000;
  if (dtMin <= 0) return null;
  const perMin = (to.value - from.value) / dtMin;
  return fmtDelta(perMin, unit ? `${unit}/min` : '/min');
}

/** English plural: `1 dish`, `11 dishes`. When `pluralForm` is omitted, default to `${singular}s`. */
export function plural(n: number, singular: string, pluralForm?: string): string {
  const word = n === 1 ? singular : (pluralForm ?? `${singular}s`);
  return `${fmt(n, null)} ${word}`;
}

/** Collapse whitespace that a template accidentally doubled. */
export function collapseSpaces(s: string): string {
  return s.replace(/  +/g, ' ').trim();
}
