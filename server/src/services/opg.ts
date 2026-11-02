import { latestStates, latestTelemetry } from '../db/queries';
import type { Measure, MeasureContext, ServicePlugin } from './types';
import { asNumber, clamp, limit, newest, round } from './util';

export const opgPlugin: ServicePlugin = {
  code: 'opg',
  label: 'On-demand Power Generation',
  accent: '#facc15',
  focalKind: 'global',

  derive({ store, cfg, limits }: MeasureContext) {
    const power = latestTelemetry(store, 'opg', ['power']);
    const byEntity = new Map(power.map((sample) => [sample.entity, sample.data]));
    const global = byEntity.get('global') ?? {};
    const bank = byEntity.get('batteries') ?? {};
    const array = byEntity.get('solar') ?? {};
    const genset = byEntity.get('diesel') ?? {};

    const solarW = asNumber(array.power_output_w) ?? 0;
    const dieselW = asNumber(genset.power_output_w) ?? 0;
    const loadW = asNumber(global.total_load_w) ?? 0;
    const soc = asNumber(bank.state_of_charge_pct);
    const batteryW = asNumber(bank.battery_power_w);
    const warnSoc = limit(limits, 'battery.warn_pct');
    const reservePct =
      asNumber(latestStates(store, 'opg').find((state) => state.item === 'reserve_pct')?.value) ?? 20;
    const ts = newest(power);

    // P_net = P_solar + P_diesel - P_load. Negative is not automatically a fault - at night the
    // bank is meant to carry the base - so the verdict only escalates when the bank is also low.
    // With no samples at all the margin is unknowable, not zero: a plant that has gone silent must
    // not read as perfectly balanced.
    const reported = power.length > 0;
    const netW = reported ? solarW + dieselW - loadW : null;
    const margin: Measure = {
      key: 'opg.net_margin',
      label: 'Net power margin',
      question: 'Are the sources covering the load, or is the bank doing it?',
      unit: 'W',
      value: netW === null ? null : Math.round(netW),
      verdict:
        netW === null
          ? 'unknown'
          : netW >= 0
            ? 'ok'
            : warnSoc !== null && soc !== null && soc <= warnSoc
              ? 'crit'
              : 'warn',
      inputs: {
        solar_w: reported ? Math.round(solarW) : null,
        diesel_w: reported ? Math.round(dieselW) : null,
        load_w: reported ? Math.round(loadW) : null,
        supply_mode: typeof global.supply_mode === 'string' ? global.supply_mode : null,
      },
      reason: reported ? undefined : 'no power samples yet',
    };

    // Only a discharging bank has a projection: while charging, "time to reserve" is a statement
    // about the future, not a measurement of the present.
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
      // No usable projection is only benign when we know why: a charging bank is fine, an untracked
      // bank is not an answer at all.
      verdict:
        hours === null
          ? soc === null
            ? 'unknown'
            : 'ok'
          : hours < 0.25
            ? 'crit'
            : hours < 1
              ? 'warn'
              : 'ok',
      inputs: {
        soc_pct: soc === null ? null : round(soc, 1),
        reserve_pct: reservePct,
        battery_kwh: cfg.derived.batteryKwh,
        discharge_kw: dischargeKw === null ? null : round(dischargeKw, 1),
        usable_kwh: usableKwh === null ? null : round(usableKwh, 0),
      },
      reason:
        hours !== null
          ? undefined
          : soc === null
            ? 'no state of charge reported'
            : 'the bank is not discharging',
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
      verdict:
        renewable === null || dark
          ? 'unknown'
          : renewable >= 0.8
            ? 'ok'
            : renewable >= 0.3
              ? 'warn'
              : 'crit',
      inputs: {
        solar_w: Math.round(solarW),
        load_w: Math.round(loadW),
        diesel_w: Math.round(dieselW),
        irradiance_wm2: irradiance === null ? null : Math.round(irradiance),
      },
      reason:
        loadW <= 0 ? 'no load reported' : dark ? 'night: there is no solar to account for' : undefined,
    };

    return { ts, measures: [margin, autonomy, share] };
  },
};
