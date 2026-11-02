import type { AlertLimit } from '../arlApi/client';
import type { Config } from '../config';
import { latestStates, latestTelemetry } from '../db/queries';
import type { Store } from '../db/store';
import type { TopologyRegistry } from '../topology/registry';

/**
 * Derived indicators.
 *
 * A service publishes numbers; a researcher asks questions. These are the four questions the
 * platform answers from data it already stores, declared once here so the same definition is used
 * by the API, the workspaces and the tests:
 *
 *   RTA  N_active / N_total                  how much of the array is usable right now
 *        angular distance commanded-vs-actual is the array actually on target
 *        scan progress                       will this scan finish
 *   MHE  sum(room crew_count) vs rated crew  is anyone unaccounted for
 *        mean heart rate against its reserve  how stressed is the crew, and at what CO2
 *   OPG  P_solar + P_diesel - P_load         is the plant covering its load
 *        hours above reserve at current draw  how long until the batteries hit reserve
 *
 * Verdicts lean on the service's own alert limits (`GET /v1/alert-limits/:service`) rather than
 * numbers invented here; when a limit is missing the value is still reported with `unknown`.
 */
export type Verdict = 'ok' | 'warn' | 'crit' | 'unknown';

export interface Measure {
  key: string;
  label: string;
  question: string;
  unit: string | null;
  value: number | null;
  verdict: Verdict;
  /** Everything the number was computed from, so the arithmetic can be checked by eye. */
  inputs: Record<string, number | string | null>;
  reason?: string;
}

export interface DerivedReport {
  service: string;
  /** Newest simulator timestamp among the samples used; null when nothing has been stored. */
  ts: number | null;
  measures: Measure[];
}

/** Pointing tolerances for the array: an operator's rule of thumb, not a published limit. */
const POINTING_WARN_DEG = 0.5;
const POINTING_CRIT_DEG = 2;

export function deriveAll(
  store: Store,
  registry: TopologyRegistry,
  cfg: Config,
  limits: Map<string, AlertLimit[]>,
): DerivedReport[] {
  return registry.services.map((service) => {
    const serviceLimits = limits.get(service) ?? [];
    switch (service) {
      case 'rta':
        return { service, ...rtaMeasures(store, registry, serviceLimits) };
      case 'mhe':
        return { service, ...mheMeasures(store, registry, cfg, serviceLimits) };
      case 'opg':
        return { service, ...opgMeasures(store, cfg, serviceLimits) };
      default:
        return { service, ts: null, measures: [] };
    }
  });
}

// --------------------------------------------------------------------------- RTA

function rtaMeasures(
  store: Store,
  registry: TopologyRegistry,
  limits: AlertLimit[],
): { ts: number | null; measures: Measure[] } {
  const total = registry.get('rta')?.entitiesOfKind('dish').length ?? 0;
  const latest = latestTelemetry(store, 'rta', ['scan', 'normal']);
  const ts = newest(latest);
  const active = latest.filter((sample) => sample.data.status === true).length;
  const minActive = limit(limits, 'availability.min_active');

  const ratio = total > 0 ? active / total : null;
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
  const meanDeg = meanRad === null ? null : (meanRad * 180) / Math.PI;
  const worstDeg = max(errors);
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
      max_deg: worstDeg === null ? null : round((worstDeg * 180) / Math.PI, 3),
    },
    reason: errors.length === 0 ? 'no dish is reporting a commanded position' : undefined,
  };

  const scanning = latest.filter((sample) => typeof sample.data.scan_id === 'string');
  const progress = mean(
    scanning
      .map((sample) => asNumber(sample.data.scan_progress))
      .filter((value): value is number => value !== null),
  );
  const scanId = scanning[0]?.data.scan_id ?? null;
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
}

// --------------------------------------------------------------------------- MHE

function mheMeasures(
  store: Store,
  registry: TopologyRegistry,
  cfg: Config,
  limits: AlertLimit[],
): { ts: number | null; measures: Measure[] } {
  const rooms = registry.get('mhe')?.entitiesOfKind('room').length ?? 0;
  const crew = registry.get('mhe')?.entitiesOfKind('crew').length ?? 0;
  const expected = cfg.derived.crewExpected > 0 ? cfg.derived.crewExpected : crew;

  const environment = latestTelemetry(store, 'mhe', ['environment']);
  const reporting = environment.filter((sample) => asNumber(sample.data.crew_count) !== null);
  const headcount = sum(
    reporting.map((sample) => asNumber(sample.data.crew_count) as number),
  );
  const ts = newest(environment);

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
      stressIndex === null ? 'unknown' : stressIndex >= 80 ? 'crit' : stressIndex >= 60 ? 'warn' : 'ok',
    inputs: {
      mean_hr_bpm: meanHr === null ? null : round(meanHr, 1),
      rest_bpm: rest,
      max_bpm: ceiling,
      mean_co2_ppm: co2 === null ? null : round(co2, 0),
      crew_reporting: hrValues.length,
    },
  };

  return { ts, measures: [presence, stress, air] };
}

// --------------------------------------------------------------------------- OPG

function opgMeasures(
  store: Store,
  cfg: Config,
  limits: AlertLimit[],
): { ts: number | null; measures: Measure[] } {
  const power = latestTelemetry(store, 'opg', ['power']);
  const byEntity = new Map(power.map((sample) => [sample.entity, sample.data]));
  const global = byEntity.get('global') ?? {};
  const bank = byEntity.get('batteries') ?? {};
  const array = byEntity.get('solar') ?? {};
  const genset = byEntity.get('diesel') ?? {};

  const solarW = asNumber(array.power_output_w) ?? 0;
  const dieselW = asNumber(genset.power_output_w) ?? 0;
  const loadW = asNumber(global.total_load_w) ?? 0;
  const netW = solarW + dieselW - loadW;
  const soc = asNumber(bank.state_of_charge_pct);
  const batteryW = asNumber(bank.battery_power_w);
  const warnSoc = limit(limits, 'battery.warn_pct');
  const reservePct =
    asNumber(latestStates(store, 'opg').find((state) => state.item === 'reserve_pct')?.value) ?? 20;
  const ts = newest(power);

  const margin: Measure = {
    key: 'opg.net_margin',
    label: 'Net power margin',
    question: 'Are the sources covering the load, or is the bank doing it?',
    unit: 'W',
    value: Math.round(netW),
    verdict:
      netW >= 0 ? 'ok' : warnSoc !== null && soc !== null && soc <= warnSoc ? 'crit' : 'warn',
    inputs: {
      solar_w: Math.round(solarW),
      diesel_w: Math.round(dieselW),
      load_w: Math.round(loadW),
      supply_mode: typeof global.supply_mode === 'string' ? global.supply_mode : null,
    },
  };

  // Only a discharging bank has a projection: while charging, "time to reserve" is a statement
  // about the future, not a measurement.
  const dischargeKw = batteryW !== null && batteryW < 0 ? -batteryW / 1000 : null;
  const usableKwh = soc === null ? null : ((soc - reservePct) / 100) * cfg.derived.batteryKwh;
  const hours =
    usableKwh === null || dischargeKw === null || dischargeKw <= 0
      ? null
      : Math.max(0, usableKwh / dischargeKw);

  const autonomy: Measure = {
    key: 'opg.autonomy',
    label: 'Battery autonomy',
    question: 'At this discharge rate, how long until the bank hits reserve?',
    unit: 'h',
    value: hours === null ? null : round(hours, 2),
    verdict: hours === null ? 'ok' : hours < 0.25 ? 'crit' : hours < 1 ? 'warn' : 'ok',
    inputs: {
      soc_pct: soc === null ? null : round(soc, 1),
      reserve_pct: reservePct,
      battery_kwh: cfg.derived.batteryKwh,
      discharge_kw: dischargeKw === null ? null : round(dischargeKw, 1),
      usable_kwh: usableKwh === null ? null : round(usableKwh, 0),
    },
    reason: hours === null ? 'the bank is not discharging' : undefined,
  };

  const renewable = loadW > 0 ? clamp(solarW / loadW, 0, 1) : null;
  // At night there is no sun to be a share of: a zero here describes the clock, not a fault.
  const irradiance = asNumber(array.irradiance_wm2);
  const dark = irradiance !== null && irradiance < 50;
  const share: Measure = {
    key: 'opg.renewable_share',
    label: 'Solar share of load',
    question: 'How much of what we are using came straight from the sun?',
    unit: 'ratio',
    value: renewable === null ? null : round(renewable, 3),
    verdict: renewable === null || dark ? 'unknown' : renewable >= 0.8 ? 'ok' : renewable >= 0.3 ? 'warn' : 'crit',
    inputs: {
      solar_w: Math.round(solarW),
      load_w: Math.round(loadW),
      diesel_w: Math.round(dieselW),
      irradiance_wm2: irradiance === null ? null : Math.round(irradiance),
    },
    reason: loadW <= 0 ? 'no load reported' : dark ? 'night: there is no solar to account for' : undefined,
  };

  return { ts, measures: [margin, autonomy, share] };
}

// ------------------------------------------------------------------------- utils

function limit(limits: AlertLimit[], key: string): number | null {
  const hit = limits.find((entry) => entry.key === key);
  return hit && Number.isFinite(hit.value) ? hit.value : null;
}

function newest(samples: Array<{ ts: number }>): number | null {
  if (samples.length === 0) return null;
  return samples.reduce((acc, sample) => Math.max(acc, sample.ts), 0);
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

/** Great-circle angle between two az/el pointings, in radians. */
function angularDistance(actual: Record<string, unknown>, want: Record<string, unknown>): number | null {
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

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function sum(values: number[]): number {
  return values.reduce((acc, value) => acc + value, 0);
}

function max(values: number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
