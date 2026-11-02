import { latestTelemetry } from '../db/queries';
import type { Measure, MeasureContext, ServicePlugin } from './types';
import { asNumber, clamp, limit, mean, newest, round, sum } from './util';

export const mhePlugin: ServicePlugin = {
  code: 'mhe',
  label: 'Mars Habitation Experiment',
  accent: '#34d399',
  focalKind: 'room',

  derive({ store, registry, cfg, limits }: MeasureContext) {
    const rooms = registry.get('mhe')?.entitiesOfKind('room').length ?? 0;
    const crew = registry.get('mhe')?.entitiesOfKind('crew').length ?? 0;
    const expected = cfg.derived.crewExpected > 0 ? cfg.derived.crewExpected : crew;

    const environment = latestTelemetry(store, 'mhe', ['environment']);
    const reporting = environment.filter((sample) => asNumber(sample.data.crew_count) !== null);
    const headcount = sum(reporting.map((sample) => asNumber(sample.data.crew_count) as number));
    const ts = newest(environment);

    // Every crew member is in exactly one compartment, so the sum across rooms is the whole
    // habitat. A mismatch means a badge is unaccounted for or a room has gone silent.
    const presence: Measure = {
      key: 'mhe.headcount',
      label: 'Habitat headcount',
      question: 'Does the sum of room occupancy match the crew we are responsible for?',
      unit: 'people',
      value: reporting.length > 0 ? headcount : null,
      verdict:
        reporting.length === 0
          ? 'unknown'
          : headcount !== expected
            ? 'crit'
            : reporting.length < rooms
              ? 'warn'
              : 'ok',
      inputs: {
        expected,
        rooms_reporting: reporting.length,
        rooms_total: rooms,
        delta: reporting.length > 0 ? headcount - expected : null,
      },
      reason:
        reporting.length < rooms
          ? `${rooms - reporting.length} room(s) have not reported occupancy`
          : undefined,
    };

    const co2Values = environment
      .map((sample) => asNumber(sample.data.co2_ppm))
      .filter((value): value is number => value !== null);
    const co2 = mean(co2Values);
    const warnPpm = limit(limits, 'air.co2_warn_ppm');
    const critPpm = limit(limits, 'air.co2_crit_ppm');
    const air: Measure = {
      key: 'mhe.co2_mean',
      label: 'Mean CO2',
      question: 'Is the habitat air turning over fast enough?',
      unit: 'ppm',
      value: co2 === null ? null : round(co2, 0),
      verdict:
        co2 === null || warnPpm === null || critPpm === null
          ? 'unknown'
          : co2 >= critPpm
            ? 'crit'
            : co2 >= warnPpm
              ? 'warn'
              : 'ok',
      inputs: { rooms: co2Values.length, warn_ppm: warnPpm, crit_ppm: critPpm },
    };

    // Heart-rate reserve: 0 at resting rate, 100 at the ceiling where the crew's own
    // `crew.hr_max` limit sits. CO2 travels with the index in the inputs because a rising
    // heart rate in stale air is an environment problem, not a fitness one.
    const vitals = latestTelemetry(store, 'mhe', ['vitals']);
    const hrValues = vitals
      .map((sample) => asNumber(sample.data.heart_rate_bpm))
      .filter((value): value is number => value !== null);
    const meanHr = mean(hrValues);
    const rest = cfg.derived.stressRestBpm;
    const ceiling = Math.max(rest + 1, cfg.derived.stressMaxBpm);
    const stressIndex =
      meanHr === null ? null : clamp(((meanHr - rest) / (ceiling - rest)) * 100, 0, 100);
    const stress: Measure = {
      key: 'mhe.stress_index',
      label: 'Crew stress index',
      question: 'How hard is the crew working, and is the air explaining it?',
      unit: 'index',
      value: stressIndex === null ? null : round(stressIndex, 1),
      verdict:
        stressIndex === null
          ? 'unknown'
          : stressIndex >= 80
            ? 'crit'
            : stressIndex >= 60
              ? 'warn'
              : 'ok',
      inputs: {
        mean_hr_bpm: meanHr === null ? null : round(meanHr, 1),
        rest_bpm: rest,
        max_bpm: ceiling,
        mean_co2_ppm: co2 === null ? null : round(co2, 0),
        crew_reporting: hrValues.length,
      },
    };

    return { ts, measures: [presence, stress, air] };
  },
};
