import { describe, expect, it } from 'vitest';
import type { AlertLimit } from '../src/arlApi/client';
import { Store } from '../src/db/store';
import { deriveAll, listPlugins, pluginFor } from '../src/services';
import type { DerivedReport, Measure } from '../src/services/types';
import {
  LIMITS,
  registryWithTopologies,
  testConfig,
  writeStates,
  writeTelemetry,
} from './helpers';

const cfg = testConfig({ MHE_CREW_EXPECTED: '5' });
const limits = new Map<string, AlertLimit[]>(Object.entries(LIMITS));

function emptyStore(): Store {
  return new Store(':memory:');
}

function answer(store: Store): Map<string, DerivedReport> {
  return new Map(deriveAll(store, registryWithTopologies(), cfg, limits).map((r) => [r.service, r]));
}

function measure(report: DerivedReport | undefined, key: string): Measure {
  const found = report?.measures.find((m) => m.key === key);
  if (!found) throw new Error(`no measure ${key} in ${report?.service ?? 'nothing'}`);
  return found;
}

function seedRta(store: Store): void {
  writeStates(store, [
    {
      service: 'rta',
      entity: 'dish-001',
      item: 'commanded',
      ts: 900,
      value: { azimuth_rad: 1, elevation_rad: 0.5 },
    },
  ]);
  writeTelemetry(store, [
    { service: 'rta', entity: 'dish-001', stream: 'normal', ts: 1_000, data: { status: true, azimuth_rad: 1, elevation_rad: 0.5 } },
    { service: 'rta', entity: 'dish-002', stream: 'normal', ts: 1_000, data: { status: true } },
    { service: 'rta', entity: 'dish-003', stream: 'normal', ts: 1_000, data: { status: false } },
    { service: 'rta', entity: 'dish-004', stream: 'normal', ts: 1_000, data: { status: false } },
  ]);
}

function seedMhe(store: Store): void {
  writeTelemetry(store, [
    { service: 'mhe', entity: 'room-1', stream: 'environment', ts: 1_000, data: { crew_count: 2, co2_ppm: 600 } },
    { service: 'mhe', entity: 'room-2', stream: 'environment', ts: 1_000, data: { crew_count: 2, co2_ppm: 700 } },
    { service: 'mhe', entity: 'room-3', stream: 'environment', ts: 1_000, data: { crew_count: 1, co2_ppm: 650 } },
    { service: 'mhe', entity: 'crew-1', stream: 'vitals', ts: 1_000, data: { heart_rate_bpm: 60 } },
    { service: 'mhe', entity: 'crew-2', stream: 'vitals', ts: 1_000, data: { heart_rate_bpm: 60 } },
    { service: 'mhe', entity: 'crew-3', stream: 'vitals', ts: 1_000, data: { heart_rate_bpm: 66 } },
  ]);
}

function seedOpg(store: Store): void {
  writeStates(store, [{ service: 'opg', entity: 'batteries', item: 'reserve_pct', ts: 900, value: 20 }]);
  writeTelemetry(store, [
    { service: 'opg', entity: 'solar', stream: 'power', ts: 1_000, data: { power_output_w: 400_000, irradiance_wm2: 800 } },
    { service: 'opg', entity: 'diesel', stream: 'power', ts: 1_000, data: { power_output_w: 0 } },
    { service: 'opg', entity: 'batteries', stream: 'power', ts: 1_000, data: { state_of_charge_pct: 50, battery_power_w: -100_000 } },
    { service: 'opg', entity: 'global', stream: 'power', ts: 1_000, data: { total_load_w: 600_000, supply_mode: 'hybrid' } },
  ]);
}

describe('plugin registry', () => {
  it('enumerates exactly the three services the platform answers for', () => {
    expect(listPlugins().map((p) => p.code)).toEqual(['rta', 'mhe', 'opg']);
    expect(pluginFor('opg')?.label).toBe('On-demand Power Generation');
    expect(pluginFor('lwm')).toBeNull();
  });

  it('reports every plugin even when a service has published nothing', () => {
    const store = emptyStore();
    const reports = deriveAll(store, registryWithTopologies(), cfg, limits);
    expect(reports.map((r) => r.service)).toEqual(['rta', 'mhe', 'opg']);
    store.close();
  });
});

describe('RTA measures', () => {
  it('computes the active-dish ratio against the published minimum', () => {
    const store = emptyStore();
    seedRta(store);

    const availability = measure(answer(store).get('rta'), 'rta.array_availability');
    expect(availability).toMatchObject({
      value: 0.5,
      verdict: 'crit',
      unit: 'ratio',
      inputs: { active: 2, total: 4, min_active: 80 },
    });
    store.close();
  });

  it('measures pointing as the angle between commanded and achieved', () => {
    const store = emptyStore();
    seedRta(store);

    const pointing = measure(answer(store).get('rta'), 'rta.pointing_error');
    expect(pointing.value).toBe(0);
    expect(pointing.verdict).toBe('ok');
    expect(pointing.inputs).toMatchObject({ dishes_compared: 1 });
    store.close();
  });

  it('turns a 2.5 degree error into a critical pointing fault', () => {
    const store = emptyStore();
    writeStates(store, [
      { service: 'rta', entity: 'dish-001', item: 'commanded', ts: 900, value: { azimuth_rad: 0, elevation_rad: 0 } },
    ]);
    writeTelemetry(store, [
      {
        service: 'rta',
        entity: 'dish-001',
        stream: 'normal',
        ts: 1_000,
        data: { status: true, azimuth_rad: (2.5 * Math.PI) / 180, elevation_rad: 0 },
      },
    ]);

    const pointing = measure(answer(store).get('rta'), 'rta.pointing_error');
    expect(pointing.value).toBeCloseTo(2.5, 3);
    expect(pointing.verdict).toBe('crit');
    store.close();
  });

  it('aggregates the scan progress of the dishes currently scanning', () => {
    const store = emptyStore();
    writeTelemetry(store, [
      { service: 'rta', entity: 'dish-001', stream: 'scan', ts: 1_000, data: { status: true, scan_id: 'scan-0007', scan_progress: 0.4 } },
      { service: 'rta', entity: 'dish-002', stream: 'scan', ts: 1_000, data: { status: true, scan_id: 'scan-0007', scan_progress: 0.6 } },
    ]);

    const scan = measure(answer(store).get('rta'), 'rta.scan_progress');
    expect(scan.value).toBeCloseTo(0.5, 6);
    expect(scan.verdict).toBe('ok');
    expect(scan.inputs).toMatchObject({ scan_id: 'scan-0007', dishes: 2 });
    store.close();
  });
});

describe('MHE measures', () => {
  it('sums room occupancy and compares it with the crew roster', () => {
    const store = emptyStore();
    seedMhe(store);

    const headcount = measure(answer(store).get('mhe'), 'mhe.headcount');
    expect(headcount).toMatchObject({
      value: 5,
      verdict: 'ok',
      unit: 'people',
      inputs: { expected: 5, rooms_reporting: 3, rooms_total: 3, delta: 0 },
    });
    store.close();
  });

  it('calls a missing crew member critical, and names the delta', () => {
    const store = emptyStore();
    writeTelemetry(store, [
      { service: 'mhe', entity: 'room-1', stream: 'environment', ts: 1_000, data: { crew_count: 2, co2_ppm: 600 } },
      { service: 'mhe', entity: 'room-2', stream: 'environment', ts: 1_000, data: { crew_count: 1, co2_ppm: 600 } },
      { service: 'mhe', entity: 'room-3', stream: 'environment', ts: 1_000, data: { crew_count: 1, co2_ppm: 600 } },
    ]);

    const headcount = measure(answer(store).get('mhe'), 'mhe.headcount');
    expect(headcount.value).toBe(4);
    expect(headcount.verdict).toBe('crit');
    expect(headcount.inputs).toMatchObject({ delta: -1 });
    store.close();
  });

  it('warns while a room is silent even if the total still adds up', () => {
    const store = emptyStore();
    writeTelemetry(store, [
      { service: 'mhe', entity: 'room-1', stream: 'environment', ts: 1_000, data: { crew_count: 3, co2_ppm: 600 } },
      { service: 'mhe', entity: 'room-2', stream: 'environment', ts: 1_000, data: { crew_count: 2, co2_ppm: 600 } },
    ]);

    const headcount = measure(answer(store).get('mhe'), 'mhe.headcount');
    expect(headcount.value).toBe(5);
    expect(headcount.verdict).toBe('warn');
    expect(headcount.reason).toMatch(/1 room\(s\)/);
    store.close();
  });

  it('maps mean heart rate onto the stress index and carries CO2 alongside it', () => {
    const store = emptyStore();
    seedMhe(store);

    const stress = measure(answer(store).get('mhe'), 'mhe.stress_index');
    // (62 - 60) / (110 - 60) * 100
    expect(stress.value).toBe(4);
    expect(stress.verdict).toBe('ok');
    expect(stress.inputs).toMatchObject({ mean_hr_bpm: 62, rest_bpm: 60, max_bpm: 110, mean_co2_ppm: 650 });
    store.close();
  });

  it('escalates mean CO2 using the service\'s own limits', () => {
    const store = emptyStore();
    writeTelemetry(store, [
      { service: 'mhe', entity: 'room-1', stream: 'environment', ts: 1_000, data: { crew_count: 5, co2_ppm: 1_600 } },
      { service: 'mhe', entity: 'room-2', stream: 'environment', ts: 1_000, data: { crew_count: 0, co2_ppm: 2_600 } },
      { service: 'mhe', entity: 'room-3', stream: 'environment', ts: 1_000, data: { crew_count: 0, co2_ppm: 1_500 } },
    ]);

    const co2 = measure(answer(store).get('mhe'), 'mhe.co2_mean');
    expect(co2.value).toBe(1_900);
    expect(co2.verdict).toBe('warn');
    expect(co2.inputs).toMatchObject({ warn_ppm: 1_500, crit_ppm: 2_500 });
    store.close();
  });
});

describe('OPG measures', () => {
  it('computes the net margin from the three power sources', () => {
    const store = emptyStore();
    seedOpg(store);

    const margin = measure(answer(store).get('opg'), 'opg.net_margin');
    expect(margin).toMatchObject({
      value: -200_000,
      verdict: 'warn',
      unit: 'W',
      inputs: { solar_w: 400_000, diesel_w: 0, load_w: 600_000, supply_mode: 'hybrid' },
    });
    store.close();
  });

  it('projects battery autonomy from the discharge rate and the plant capacity', () => {
    const store = emptyStore();
    seedOpg(store);

    const autonomy = measure(answer(store).get('opg'), 'opg.autonomy');
    // (50% - 20%) of 4000 kWh = 1200 kWh, drawn at 100 kW.
    expect(autonomy.value).toBe(12);
    expect(autonomy.verdict).toBe('ok');
    expect(autonomy.inputs).toMatchObject({
      soc_pct: 50,
      reserve_pct: 20,
      battery_kwh: 4_000,
      discharge_kw: 100,
      usable_kwh: 1_200,
    });
    store.close();
  });

  it('reports no projection while the bank is charging', () => {
    const store = emptyStore();
    seedOpg(store);
    writeTelemetry(store, [
      {
        service: 'opg',
        entity: 'batteries',
        stream: 'power',
        ts: 1_100,
        data: { state_of_charge_pct: 52, battery_power_w: 50_000 },
      },
    ]);

    const autonomy = measure(answer(store).get('opg'), 'opg.autonomy');
    expect(autonomy.value).toBeNull();
    expect(autonomy.verdict).toBe('ok');
    expect(autonomy.reason).toBe('the bank is not discharging');
    store.close();
  });

  it('calls a low bank critical once it is carrying the load', () => {
    const store = emptyStore();
    seedOpg(store);
    writeTelemetry(store, [
      { service: 'opg', entity: 'solar', stream: 'power', ts: 1_100, data: { power_output_w: 0, irradiance_wm2: 0 } },
      { service: 'opg', entity: 'batteries', stream: 'power', ts: 1_100, data: { state_of_charge_pct: 25, battery_power_w: -600_000 } },
    ]);

    const report = answer(store).get('opg');
    expect(measure(report, 'opg.net_margin').verdict).toBe('crit');
    // (25 - 20)% of 4000 kWh = 200 kWh at 600 kW.
    expect(measure(report, 'opg.autonomy').value).toBeCloseTo(0.33, 2);
    // Night: solar share describes the clock, not a fault.
    expect(measure(report, 'opg.renewable_share').verdict).toBe('unknown');
    store.close();
  });
});

describe('no data', () => {
  it('answers "unknown" rather than inventing a reading', () => {
    const store = emptyStore();
    const reports = answer(store);

    for (const report of reports.values()) {
      for (const m of report.measures) {
        expect(m, `${m.key} should not be answered without data`).toMatchObject({
          value: null,
          verdict: 'unknown',
        });
      }
    }
    store.close();
  });
});
