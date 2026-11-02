import { num, pct, watts } from '../lib/format';
import { useDerived } from '../lib/hooks';
import type { DerivedMeasure, MeasureVerdict } from '../lib/types';
import { Datum, type Tone } from './ui';

/**
 * Rendering for the server's derived measures.
 *
 * The arithmetic lives in `server/src/derived/measures.ts`. The console only formats what the API
 * returns, so "battery autonomy" means the same thing in the workspace, in an alert caption and in
 * a test fixture.
 */
export function useMeasures(service: string): Map<string, DerivedMeasure> {
  const report = useDerived().get(service);
  return new Map((report?.measures ?? []).map((measure) => [measure.key, measure]));
}

/** One measure's value in its own unit, or an em dash when the inputs were not there. */
export function measureText(measure: DerivedMeasure | undefined): string {
  if (!measure || measure.value === null) return '\u2014';
  const value = measure.value;
  switch (measure.unit) {
    case 'ratio':
      return pct(value * 100, 0);
    case 'W':
      return watts(value);
    case 'h':
      return `${num(value, 1)} h`;
    case 'ppm':
      return `${num(value, 0)} ppm`;
    case 'deg':
      return `${num(value, 2)}\u00b0`;
    case 'people':
      return num(value, 0);
    case 'index':
      return num(value, 0);
    default:
      return num(value, 1);
  }
}

export function verdictTone(measure: DerivedMeasure | undefined): Tone {
  const verdict: MeasureVerdict = measure?.verdict ?? 'unknown';
  return verdict === 'unknown' ? 'inert' : verdict;
}

/** A single derived measure as a compact label/value row. */
export function DerivedDatum({
  measure,
  label,
}: {
  measure: DerivedMeasure | undefined;
  label?: string;
}) {
  return (
    <Datum
      label={label ?? measure?.label.toLowerCase() ?? 'derived'}
      value={
        <span title={measure ? `${measure.question}\n${describeInputs(measure)}` : undefined}>
          {measureText(measure)}
        </span>
      }
      tone={verdictTone(measure)}
    />
  );
}

function describeInputs(measure: DerivedMeasure): string {
  const parts = Object.entries(measure.inputs)
    .filter(([, value]) => value !== null)
    .map(([key, value]) => `${key.replace(/_/g, ' ')} ${value}`);
  const reason = measure.reason ? `\n${measure.reason}` : '';
  return `${parts.join(' \u00b7 ')}${reason}`;
}
