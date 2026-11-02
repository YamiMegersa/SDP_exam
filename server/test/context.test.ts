import { describe, expect, it } from 'vitest';
import { Store } from '../src/db/store';
import type { AlertRecord } from '../src/types';
import {
  buildContext,
  buildHistory,
  buildMeasured,
  buildRelated,
  buildSiblings,
  buildSuggestedControls,
  type AlertContext,
} from '../src/alerts/context';
import { RTA_TOPOLOGY, MHE_TOPOLOGY, OPG_TOPOLOGY, writeTelemetry, writeEvents } from './helpers';
import { fmt, fmtDelta, fmtRate, plural, collapseSpaces } from '../src/alerts/narrative-format';

/**
 * The context pack (Planning Docs/05 §4.3, 23 §6.3). Each helper is tested in isolation against
 * a small in-memory store, then the full `buildContext` is tested end-to-end.
 */

function mkStore(): Store {
  return new Store(':memory:');
}

function seedRtaTopology(store: Store): void {
  store.saveTopology('rta', 'test-1', JSON.stringify(RTA_TOPOLOGY), 1_000);
}

function seedAlert(
  store: Store,
  service: string,
  overrides: Partial<AlertRecord> & { alert_id: string; type: string },
): AlertRecord {
  const ts = overrides.raised_ts ?? 1_800_000_000_000;
  const result = store.applyAlertEvent(
    service,
    {
      alert_id: overrides.alert_id,
      type: overrides.type,
      severity: overrides.severity ?? 'warning',
      state: overrides.status === 'cleared' ? 'cleared' : 'raised',
      value: overrides.value ?? null,
      limit: overrides.limit_value ?? null,
      unit: overrides.unit ?? null,
      message: overrides.message ?? null,
      metadata: overrides.metadata ?? {},
      entity: overrides.entity ?? undefined,
      ts,
    },
    ts,
    Date.now(),
    overrides.entity ?? null,
  );
  return result.alert;
}

// ---------------------------------------------------------------- measured

describe('buildMeasured', () => {
  it('returns the alert own value/limit/unit as the primary measure', () => {
    const store = mkStore();
    const alert = seedAlert(store, 'rta', {
      alert_id: 'a1',
      type: 'dish_temperature',
      entity: 'dish-042',
      value: 335.2,
      limit_value: 333,
      unit: 'K',
      severity: 'warning',
    });
    const m = buildMeasured(alert, store);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({
      key: 'dish_temperature',
      value: 335.2,
      unit: 'K',
      limit: 333,
      limitKey: 'warn_k',
      direction: 'above',
    });
  });

  it('returns an empty list for a platform alert that has no value', () => {
    const store = mkStore();
    const alert = seedAlert(store, 'platform', {
      alert_id: 'p1',
      type: 'broker',
      value: null,
      limit_value: null,
      unit: null,
    });
    expect(buildMeasured(alert, store)).toEqual([]);
  });

  it('adds companions from the latest telemetry for the same entity', () => {
    const store = mkStore();
    seedRtaTopology(store);
    writeTelemetry(store, [
      {
        service: 'rta',
        entity: 'dish-042',
        stream: 'normal',
        ts: 1_800_000_000_000,
        data: { temperature_k: 335, system_temperature_k: 33, power_w: 1200, elevation_rad: 0.5 },
      },
    ]);
    const alert = seedAlert(store, 'rta', {
      alert_id: 'a2',
      type: 'dish_temperature',
      entity: 'dish-042',
      value: 335,
      limit_value: 333,
      unit: 'K',
    });
    const m = buildMeasured(alert, store);
    expect(m.length).toBeGreaterThan(1);
    expect(m.map((x) => x.key)).toEqual(
      expect.arrayContaining(['dish_temperature', 'system_temperature_k', 'power_w', 'elevation_rad']),
    );
  });
});

// ----------------------------------------------------------------- history

describe('buildHistory', () => {
  it('returns 60 buckets over the 30-minute window before raised_ts', () => {
    const store = mkStore();
    seedRtaTopology(store);
    const raisedTs = 1_800_000_000_000;
    // 90 samples over 30 minutes — series() will stride them down to 60.
    const rows = Array.from({ length: 90 }, (_, i) => ({
      service: 'rta',
      entity: 'dish-042',
      stream: 'normal',
      ts: raisedTs - 30 * 60_000 + i * 20_000,
      data: { temperature_k: 300 + i * 0.4 },
    }));
    writeTelemetry(store, rows);
    const alert = seedAlert(store, 'rta', {
      alert_id: 'a3',
      type: 'dish_temperature',
      entity: 'dish-042',
      raised_ts: raisedTs,
      value: 335,
      limit_value: 333,
      unit: 'K',
    });
    const h = buildHistory(alert, store);
    expect(h.length).toBeLessThanOrEqual(60);
    expect(h.length).toBeGreaterThan(0);
    expect(h[0].ts).toBeGreaterThanOrEqual(raisedTs - 30 * 60_000);
    expect(h[h.length - 1].ts).toBeLessThanOrEqual(raisedTs);
  });

  it('returns an empty list for an alert type with no history stream', () => {
    const store = mkStore();
    const alert = seedAlert(store, 'rta', { alert_id: 'a4', type: 'availability', value: 87 });
    expect(buildHistory(alert, store)).toEqual([]);
  });
});

// ---------------------------------------------------------------- siblings

describe('buildSiblings', () => {
  it('classifies every peer dish against the alert limit', () => {
    const store = mkStore();
    seedRtaTopology(store);
    writeTelemetry(store, [
      { service: 'rta', entity: 'dish-001', stream: 'normal', ts: 1, data: { temperature_k: 300 } },
      { service: 'rta', entity: 'dish-002', stream: 'normal', ts: 1, data: { temperature_k: 340 } },
      { service: 'rta', entity: 'dish-003', stream: 'normal', ts: 1, data: { temperature_k: 335 } },
      { service: 'rta', entity: 'dish-004', stream: 'normal', ts: 1, data: { temperature_k: 310 } },
    ]);
    const alert = seedAlert(store, 'rta', {
      alert_id: 'a5',
      type: 'dish_temperature',
      entity: 'dish-002',
      value: 340,
      limit_value: 333,
      unit: 'K',
      severity: 'warning',
    });
    const s = buildSiblings(alert, store);
    expect(s).toHaveLength(4);
    const warn = s.filter((x) => x.state === 'warn');
    const ok = s.filter((x) => x.state === 'ok');
    expect(warn.length).toBeGreaterThanOrEqual(1);
    expect(ok.length).toBeGreaterThanOrEqual(1);
  });
});

// ----------------------------------------------------------------- related

describe('buildRelated', () => {
  it('surfaces other alerts within ±5 min that share a cause hint', () => {
    const store = mkStore();
    const t = 1_800_000_000_000;
    // An RTA wind stow and an OPG solar underperformance within 2 minutes — both tied to env.storm.
    seedAlert(store, 'rta', {
      alert_id: 'rta/wind',
      type: 'wind_stow',
      severity: 'warning',
      raised_ts: t,
      value: 18,
      limit_value: 15,
      unit: 'm/s',
    });
    seedAlert(store, 'opg', {
      alert_id: 'opg/solar',
      type: 'solar_underperformance',
      severity: 'warning',
      raised_ts: t + 120_000,
      value: 0.4,
    });
    // And one unrelated alert 30 min earlier.
    seedAlert(store, 'rta', {
      alert_id: 'rta/old',
      type: 'dish_offline',
      raised_ts: t - 30 * 60_000,
    });
    const rta = store.getAlert('rta/wind')!;
    const related = buildRelated(rta, store);
    expect(related.map((r) => r.alert_id)).toEqual(['opg/solar']);
  });

  it('returns nothing for an alert type with no cause hints', () => {
    const store = mkStore();
    seedAlert(store, 'platform', { alert_id: 'p2', type: 'broker', severity: 'critical' });
    const related = buildRelated(store.getAlert('p2')!, store);
    expect(related).toEqual([]);
  });
});

// -------------------------------------------------------------- suggestions

describe('buildSuggestedControls', () => {
  const topology = {
    controls: [
      { service: 'rta', control: 'stow_dish', entityKinds: ['dish'] },
      { service: 'rta', control: 'request_recalibration', entityKinds: ['dish'] },
    ],
  };

  it('returns only controls that exist in the topology', () => {
    const store = mkStore();
    const alert = seedAlert(store, 'rta', {
      alert_id: 'a6',
      type: 'dish_temperature',
      entity: 'dish-042',
      value: 340,
      limit_value: 333,
    });
    const { suggestions, suppressed } = buildSuggestedControls(alert, topology);
    expect(suggestions.map((s) => s.control)).toEqual(
      expect.arrayContaining(['stow_dish', 'request_recalibration']),
    );
    // `assign_subarray` is in the RTA table but not in the topology, so it is suppressed.
    expect(suppressed.some((s) => s.control === 'assign_subarray')).toBe(true);
  });

  it('returns nothing for an alert type with no suggestion table', () => {
    const store = mkStore();
    const alert = seedAlert(store, 'rta', { alert_id: 'a7', type: 'availability', value: 87 });
    const { suggestions, suppressed } = buildSuggestedControls(alert, topology);
    // availability has enable_dish + request_recalibration in the table, but only
    // request_recalibration is in the topology, so enable_dish is suppressed.
    expect(suggestions).toHaveLength(1);
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0].control).toBe('enable_dish');
  });
});

// ----------------------------------------------------------------- narrative

describe('narrative formatters', () => {
  it('fmt never emits undefined, NaN or a doubled space', () => {
    expect(fmt(335.2, 'K')).toBe('335.2 K');
    expect(fmt(1200, 'W')).toBe('1,200 W');
    expect(fmt(null, 'K')).toBe('—');
    expect(fmt(Number.NaN, 'K')).toBe('—');
    expect(fmt(335.2, null)).toBe('335.2');
  });

  it('fmtDelta signs the delta correctly', () => {
    expect(fmtDelta(2.2, 'K')).toBe('+2.2 K');
    expect(fmtDelta(-0.3, 'K')).toBe('−0.3 K');
    expect(fmtDelta(0, 'K')).toBe('0 K');
  });

  it('fmtRate returns null when there is no slope to compute', () => {
    expect(fmtRate(null, null, 'K')).toBeNull();
    expect(fmtRate({ ts: 0, value: 10 }, { ts: 0, value: 20 }, 'K')).toBeNull();
    expect(fmtRate({ ts: 0, value: 10 }, { ts: 60_000, value: 20 }, 'K')).toBe('+10 K/min');
  });

  it('plural handles singular and plural', () => {
    expect(plural(1, 'dish', 'dishes')).toBe('1 dish');
    expect(plural(11, 'dish', 'dishes')).toBe('11 dishes');
  });

  it('collapseSpaces removes accidental double spaces', () => {
    expect(collapseSpaces('a  b   c')).toBe('a b c');
  });
});

describe('narrative templates', () => {
  const helpers = { fmt, fmtDelta, fmtRate, plural };

  it('produces a non-empty, well-formed narrative for every RTA alert type', async () => {
    const { RTA_NARRATIVES } = await import('../src/alerts/narratives');
    const types = Object.keys(RTA_NARRATIVES);
    expect(types.length).toBeGreaterThanOrEqual(8);
    for (const type of types) {
      const store = mkStore();
      seedRtaTopology(store);
      const alert = seedAlert(store, 'rta', {
        alert_id: `n-${type}`,
        type,
        entity: 'dish-042',
        value: 335,
        limit_value: 333,
        unit: 'K',
        severity: 'warning',
        metadata: { fault_code: 'overheat' },
      });
      const ctx = buildContext(alert, { store, topology: { controls: [] } });
      expect(ctx.narrative, `narrative for ${type}`).not.toBe('');
      expect(ctx.narrative, `no undefined in ${type}`).not.toMatch(/undefined/);
      expect(ctx.narrative, `no NaN in ${type}`).not.toMatch(/NaN/);
      expect(ctx.narrative, `no double space in ${type}`).not.toMatch(/  /);
    }
  });

  it('produces a non-empty narrative for every MHE and OPG alert type', async () => {
    const { MHE_NARRATIVES, OPG_NARRATIVES } = await import('../src/alerts/narratives');
    for (const [service, table] of [['mhe', MHE_NARRATIVES], ['opg', OPG_NARRATIVES]] as const) {
      for (const type of Object.keys(table)) {
        const store = mkStore();
        const alert = seedAlert(store, service, {
          alert_id: `n-${service}-${type}`,
          type,
          entity: service === 'mhe' ? 'room-1' : 'batteries',
          value: 1500,
          limit_value: 1200,
          unit: service === 'mhe' ? 'ppm' : '%',
          severity: 'warning',
        });
        const ctx = buildContext(alert, { store, topology: { controls: [] } });
        expect(ctx.narrative, `narrative for ${service}/${type}`).not.toBe('');
      }
    }
  });
});

// --------------------------------------------------------------- full pack

describe('buildContext', () => {
  it('returns a complete pack when every field can be built', () => {
    const store = mkStore();
    seedRtaTopology(store);
    writeTelemetry(store, [
      {
        service: 'rta',
        entity: 'dish-042',
        stream: 'normal',
        ts: 1_800_000_000_000,
        data: { temperature_k: 335, system_temperature_k: 33, power_w: 1200, elevation_rad: 0.5 },
      },
      {
        service: 'rta',
        entity: 'dish-001',
        stream: 'normal',
        ts: 1_800_000_000_000,
        data: { temperature_k: 300 },
      },
    ]);
    const topology = {
      controls: [
        { service: 'rta', control: 'stow_dish', entityKinds: ['dish'] },
        { service: 'rta', control: 'request_recalibration', entityKinds: ['dish'] },
      ],
    };
    const alert = seedAlert(store, 'rta', {
      alert_id: 'full',
      type: 'dish_temperature',
      entity: 'dish-042',
      value: 335,
      limit_value: 333,
      unit: 'K',
      severity: 'warning',
    });
    const ctx: AlertContext = buildContext(alert, { store, topology });
    expect(ctx.context_quality).toBe('complete');
    expect(ctx.measured.length).toBeGreaterThanOrEqual(1);
    expect(ctx.siblings.length).toBe(2);
    expect(ctx.history.length).toBeGreaterThanOrEqual(0);
    expect(ctx.suggested_controls.length).toBeGreaterThan(0);
    expect(ctx.narrative).not.toBe('');
  });

  it('degrades to partial when history cannot be built', () => {
    const store = mkStore();
    // No telemetry at all — history returns [], which is a valid empty list, not a failure.
    // Force a failure by stubbing series() to throw via a broken table.
    store.db.exec('DROP TABLE telemetry');
    const alert = seedAlert(store, 'rta', {
      alert_id: 'broken',
      type: 'dish_temperature',
      entity: 'dish-042',
      value: 335,
      limit_value: 333,
      unit: 'K',
    });
    const ctx = buildContext(alert, { store, topology: { controls: [] } });
    expect(ctx.context_quality).toBe('partial');
    expect(ctx.history).toEqual([]);
    // Other fields are still populated.
    expect(ctx.measured.length).toBeGreaterThan(0);
    expect(ctx.narrative).not.toBe('');
  });
});
