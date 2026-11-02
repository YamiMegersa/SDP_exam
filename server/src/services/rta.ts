import { latestStates, latestTelemetry } from '../db/queries';
import type { Measure, MeasureContext, ServicePlugin } from './types';
import { angularDistance, asRecord, limit, mean, newest, round, toDegrees } from './util';

/** Pointing tolerances for the array: an operator's rule of thumb, not a published limit. */
const POINTING_WARN_DEG = 0.5;
const POINTING_CRIT_DEG = 2;

export const rtaPlugin: ServicePlugin = {
  code: 'rta',
  label: 'Radio Telescope Array',
  accent: '#38bdf8',
  focalKind: 'dish',

  derive({ store, registry, limits }: MeasureContext) {
    const total = registry.get('rta')?.entitiesOfKind('dish').length ?? 0;
    // The scan stream is 1 Hz and the normal stream 1/120 Hz, so the newest row per dish is the
    // scan row while a scan runs and the normal row otherwise.
    const latest = latestTelemetry(store, 'rta', ['scan', 'normal']);
    const ts = newest(latest);
    const active = latest.filter((sample) => sample.data.status === true).length;
    const minActive = limit(limits, 'availability.min_active');
    // No samples is not "nothing is usable": the array is unknown until at least one dish reports.
    const ratio = latest.length > 0 && total > 0 ? active / total : null;

    const availability: Measure = {
      key: 'rta.array_availability',
      label: 'Array availability',
      question: 'How much of the array is usable right now?',
      unit: 'ratio',
      value: ratio,
      verdict:
        ratio === null
          ? 'unknown'
          : active < (minActive ?? total) || ratio < 0.8
            ? 'crit'
            : ratio < 0.95
              ? 'warn'
              : 'ok',
      inputs: { active, total, min_active: minActive },
    };

    // Commanded pointing lives in state, the achieved angles in telemetry: the gap between them is
    // what separates a dish that is slewing from one that is stuck.
    const commanded = new Map(
      latestStates(store, 'rta')
        .filter((state) => state.item === 'commanded')
        .map((state) => [state.entity, asRecord(state.value)]),
    );
    const errors: number[] = [];
    for (const sample of latest) {
      const want = commanded.get(sample.entity);
      if (!want) continue;
      const distance = angularDistance(sample.data, want);
      if (distance !== null) errors.push(distance);
    }
    const meanRad = mean(errors);
    const meanDeg = meanRad === null ? null : toDegrees(meanRad);
    const worstRad = errors.length > 0 ? Math.max(...errors) : null;
    const pointing: Measure = {
      key: 'rta.pointing_error',
      label: 'Pointing error',
      question: 'Is the array actually on target?',
      unit: 'deg',
      value: meanDeg === null ? null : round(meanDeg, 3),
      verdict:
        meanDeg === null
          ? 'unknown'
          : meanDeg > POINTING_CRIT_DEG
            ? 'crit'
            : meanDeg > POINTING_WARN_DEG
              ? 'warn'
              : 'ok',
      inputs: {
        dishes_compared: errors.length,
        max_deg: worstRad === null ? null : round(toDegrees(worstRad), 3),
      },
      reason: errors.length === 0 ? 'no dish is reporting a commanded position' : undefined,
    };

    const scanning = latest.filter((sample) => typeof sample.data.scan_id === 'string');
    const progress = mean(
      scanning
        .map((sample) => (typeof sample.data.scan_progress === 'number' ? sample.data.scan_progress : null))
        .filter((value): value is number => value !== null),
    );
    const scanId = scanning[0]?.data.scan_id;
    const scan: Measure = {
      key: 'rta.scan_progress',
      label: 'Scan progress',
      question: 'Will this scan finish, and how far through is it?',
      unit: 'ratio',
      value: progress,
      verdict: progress === null ? 'unknown' : 'ok',
      inputs: { scan_id: typeof scanId === 'string' ? scanId : null, dishes: scanning.length },
      reason: progress === null ? 'no scan in progress' : undefined,
    };

    return { ts, measures: [availability, pointing, scan] };
  },
};
