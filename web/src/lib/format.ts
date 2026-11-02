/**
 * Presentation helpers.
 *
 * Two rules worth stating because they are easy to get wrong in an ops console:
 *
 * 1. Every timestamp shown to the operator is *simulator* time (`ts`), not wall
 *    clock. The sims run at 5x-30x, so wall-clock deltas would be nonsense.
 * 2. Every numeric readout is monospaced and tabular (`telemetry-readout`), so
 *    digits do not jitter while values update.
 */

const ZONE = 'Africa/Johannesburg'; // Carnarvon, Northern Cape - the facility's own clock.

const timeFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE,
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

const timeShortFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

const dateTimeFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: ZONE,
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export function clockTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return '--:--:--';
  return timeFormat.format(ts);
}

export function clockShort(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return '--:--';
  return timeShortFormat.format(ts);
}

export function dateTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return '---';
  return dateTimeFormat.format(ts);
}

/** Signed elapsed time, e.g. `+12s`, `-4m 05s`. */
export function elapsed(ms: number): string {
  const negative = ms < 0;
  const total = Math.abs(ms) / 1000;
  const sign = negative ? '-' : '+';
  if (total < 60) return `${sign}${total.toFixed(0)}s`;
  const minutes = Math.floor(total / 60);
  const seconds = Math.floor(total % 60);
  if (minutes < 60) return `${sign}${minutes}m ${String(seconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${sign}${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** `3s ago`, `14m ago` - used for feed freshness, where exact seconds do not matter. */
export function since(ts: number | null | undefined, now: number): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return 'never';
  const delta = Math.max(0, now - ts) / 1000;
  if (delta < 1) return 'now';
  if (delta < 60) return `${delta.toFixed(0)}s ago`;
  if (delta < 3600) return `${(delta / 60).toFixed(0)}m ago`;
  if (delta < 86_400) return `${(delta / 3600).toFixed(1)}h ago`;
  return `${(delta / 86_400).toFixed(1)}d ago`;
}

export function num(value: unknown, digits = 1): string {
  const n = toNumber(value);
  if (n === null) return '--';
  if (Math.abs(n) >= 1000 && digits === 0) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return n.toFixed(digits);
}

/** Signed with a real minus sign, for deltas like power margin. */
export function signed(value: number, digits = 1): string {
  const text = Math.abs(value).toFixed(digits);
  return `${value < 0 ? '\u2212' : '+'}${text}`;
}

export function pct(value: unknown, digits = 0): string {
  const n = toNumber(value);
  if (n === null) return '--';
  return `${n.toFixed(digits)}%`;
}

/** Kelvin is what the services publish; the console shows Celsius. */
export function kelvinToC(value: unknown, digits = 1): string {
  const n = toNumber(value);
  if (n === null) return '--';
  return `${(n - 273.15).toFixed(digits)}\u00b0C`;
}

export function celsiusToKelvin(value: number): number {
  return value + 273.15;
}

export function hz(value: unknown): string {
  const n = toNumber(value);
  if (n === null) return '--';
  if (n >= 1e9) return `${(n / 1e9).toFixed(3)} GHz`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MHz`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)} kHz`;
  return `${n.toFixed(0)} Hz`;
}

export function watts(value: unknown, digits = 1): string {
  const n = toNumber(value);
  if (n === null) return '--';
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(digits)} MW`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(digits)} kW`;
  return `${n.toFixed(0)} W`;
}

export function radiansToDeg(value: unknown, digits = 2): string {
  const n = toNumber(value);
  if (n === null) return '--';
  return `${((n * 180) / Math.PI).toFixed(digits)}\u00b0`;
}

export function duration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '--';
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  return null;
}

export function humanize(key: string): string {
  return key
    .replace(/[_.]+/g, ' ')
    .replace(/\b(rad|k|w|pct|bpm|ppm|kpa|lux|m3h|wm2|ec)\b/gi, (m) => m.toUpperCase())
    .replace(/^\w/, (c) => c.toUpperCase());
}

export function shortId(value: string): string {
  return value.length > 8 ? `${value.slice(0, 8)}` : value;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
