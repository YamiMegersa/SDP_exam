import { useMemo } from 'react';
import type { Sample } from '../lib/types';

/**
 * Charts are hand-rolled SVG.
 *
 * A charting library would add ~120 kB to draw what is, at this density, a
 * polyline and a gradient: the panels already have their own axes, and the one
 * thing the console genuinely needs - pixel-exact scan rendering - is done on a
 * canvas instead.
 *
 * Coordinates live in a fixed 0..100 viewBox with `preserveAspectRatio="none"`,
 * so the path never has to be recomputed on resize.
 */

interface ChartProps {
  points: Sample[];
  /** A CSS colour; pass a token (`var(--rta)`), never a hex literal. */
  color: string;
  height?: number;
  /** Override the y-range; otherwise it is derived from the data. */
  min?: number;
  max?: number;
  fill?: boolean;
  className?: string;
  /** Highlighted threshold line (e.g. a limit). */
  threshold?: { value: number; label?: string } | null;
  unit?: string;
  digits?: number;
}

function valueOf(sample: Sample): number | null {
  const raw = sample.data.value;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

export function LineChart({
  points,
  color,
  height = 64,
  min,
  max,
  fill = true,
  className = '',
  threshold = null,
  unit,
  digits = 1,
}: ChartProps) {
  const geometry = useMemo(() => {
    const values = points.map(valueOf).filter((v): v is number => v !== null);
    if (values.length < 2) return null;

    let low = min ?? Math.min(...values);
    let high = max ?? Math.max(...values);
    if (threshold) {
      low = Math.min(low, threshold.value);
      high = Math.max(high, threshold.value);
    }
    if (high - low < 1e-9) {
      high = low + Math.max(Math.abs(low) * 0.02, 1);
      low -= Math.max(Math.abs(low) * 0.02, 1);
    }
    const span = high - low;

    let path = '';
    let area = '';
    let index = 0;
    const width = 100;
    const total = Math.max(1, points.length - 1);
    for (const point of points) {
      const value = valueOf(point);
      const x = (index / total) * width;
      if (value === null) {
        index += 1;
        continue;
      }
      const y = 100 - ((value - low) / span) * 100;
      path += `${index === 0 || path === '' ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)} `;
      if (index === 0) area = `M${x.toFixed(2)},100 `;
      area += `L${x.toFixed(2)},${y.toFixed(2)} `;
      index += 1;
    }
    if (area !== '') area += `L100,100 Z`;

    const thresholdY = threshold ? 100 - ((threshold.value - low) / span) * 100 : null;
    return { path: path.trim(), area: area.trim(), low, high, thresholdY, latest: values[values.length - 1] ?? null };
  }, [points, min, max, threshold]);

  if (!geometry) {
    return (
      <div
        className={`flex items-center justify-center rounded border border-dashed border-base-700 text-2xs text-ink-500 ${className}`}
        style={{ height }}
      >
        awaiting samples
      </div>
    );
  }

  const id = `grad-${color.replace(/[^a-z0-9]/gi, '')}`;

  return (
    <div className={`relative ${className}`} style={{ height }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full" role="img" aria-label="trend">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" style={{ stopColor: color }} stopOpacity="0.28" />
            <stop offset="100%" style={{ stopColor: color }} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <line x1="0" y1="99.5" x2="100" y2="99.5" style={{ stroke: 'var(--panel-edge)' }} strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {geometry.thresholdY !== null ? (
          <line
            x1="0"
            y1={geometry.thresholdY}
            x2="100"
            y2={geometry.thresholdY}
            style={{ stroke: 'var(--caution)' }}
            strokeWidth="1"
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
            opacity="0.6"
          />
        ) : null}
        {fill ? <path d={geometry.area} fill={`url(#${id})`} /> : null}
        <path
          d={geometry.path}
          fill="none"
          style={{ stroke: color }}
          strokeWidth="1.5"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="pointer-events-none absolute inset-y-0 right-0 flex flex-col justify-between py-0.5 text-2xs leading-none text-ink-500">
        <span className="telemetry-readout">{geometry.high.toFixed(digits)}</span>
        <span className="telemetry-readout">{geometry.low.toFixed(digits)}</span>
      </div>
      {unit ? (
        <div className="pointer-events-none absolute left-0 top-0 text-2xs text-ink-500">{unit}</div>
      ) : null}
    </div>
  );
}

/** Compact trend used inside dish tiles and metric strips. */
export function Sparkline({
  points,
  color,
  threshold,
}: {
  points: Sample[];
  color: string;
  threshold?: number;
}) {
  const geometry = useMemo(() => {
    const values = points.map(valueOf).filter((v): v is number => v !== null);
    if (values.length < 2) return null;
    let low = Math.min(...values);
    let high = Math.max(...values);
    if (threshold !== undefined) {
      low = Math.min(low, threshold);
      high = Math.max(high, threshold);
    }
    const span = Math.max(1e-9, high - low);
    const total = Math.max(1, values.length - 1);
    let path = '';
    values.forEach((value, index) => {
      const x = (index / total) * 100;
      const y = 100 - ((value - low) / span) * 100;
      path += `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)} `;
    });
    return path.trim();
  }, [points, threshold]);

  if (!geometry) return <div className="h-full w-full rounded-sm bg-base-800/50" />;
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full" aria-hidden>
      <path d={geometry} fill="none" style={{ stroke: color }} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * Horizontal 1..10 micro-meter (mood / stress / fatigue / sleep).
 * Values at the top of the scale flash, per the design system.
 */
export function MicroMeter({
  value,
  label,
  max = 10,
  caution = 9,
}: {
  value: number | null;
  label?: string;
  max?: number;
  caution?: number;
}) {
  const ratio = value === null ? 0 : Math.min(1, Math.max(0, value / max));
  const hot = value !== null && value >= caution;
  return (
    <div className="flex items-center gap-1.5">
      {label ? <span className="w-10 flex-none text-2xs uppercase tracking-wide text-ink-500">{label}</span> : null}
      <div className="h-1.5 flex-1 overflow-hidden rounded-sm bg-base-800">
        <div
          className={`h-full rounded-sm transition-[width] duration-300 ${hot ? 'bg-warn motion-safe:animate-pulse' : 'bg-rta'}`}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
      <span className={`telemetry-readout w-5 text-right text-2xs ${hot ? 'text-warn' : 'text-ink-300'}`}>
        {value === null ? '--' : value.toFixed(0)}
      </span>
    </div>
  );
}
