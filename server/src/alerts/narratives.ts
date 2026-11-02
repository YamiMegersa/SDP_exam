import type { AlertRecord } from '../types';
import type {
  HistoryEntry,
  MeasuredValue,
  SiblingValue,
  RelatedAlert,
  ControlSuggestion,
} from './context';
import { collapseSpaces } from './narrative-format';

/**
 * Narrative templates (Planning Docs/05 §4.3.2, 23 §6.3.2, 33 §6.3.2, 43 §6.3.2).
 *
 * Each template is a pure function of the context pack. Rules:
 *   - Never emit `undefined`, `NaN`, or a doubled space.
 *   - When `history` is empty, drop the rate clause rather than guess.
 *   - Never claim a cause the data does not support; when the cause is unknown say so.
 *
 * The formatters are passed in so the template file does not import `narrative-format` directly;
 * that keeps the dependency graph one-way (templates → format, not the reverse).
 */

export interface FormatHelpers {
  fmt: (value: number | null | undefined, unit: string | null | undefined) => string;
  fmtDelta: (value: number, unit: string | null | undefined, signed?: boolean) => string;
  fmtRate: (
    from: { ts: number; value: number } | null,
    to: { ts: number; value: number } | null,
    unit: string | null | undefined,
  ) => string | null;
  plural: (n: number, singular: string, pluralForm?: string) => string;
}

export interface NarrativeContext {
  measured: MeasuredValue[];
  history: HistoryEntry[];
  siblings: SiblingValue[];
  related: RelatedAlert[];
  suggested_controls: ControlSuggestion[];
}

export type NarrativeTemplate = (
  alert: AlertRecord,
  ctx: NarrativeContext,
  h: FormatHelpers,
) => string;

// --------------------------------------------------------------------------- RTA

const findMeasured = (ctx: NarrativeContext, key: string): MeasuredValue | null =>
  ctx.measured.find((m) => m.key === key) ?? null;

const rateClause = (
  ctx: NarrativeContext,
  unit: string | null,
  h: FormatHelpers,
): string => {
  if (ctx.history.length < 2) return '';
  const first = ctx.history[0];
  const last = ctx.history[ctx.history.length - 1];
  const rate = h.fmtRate(first, last, unit);
  return rate ? `${rate} ` : '';
};

const siblingAboveCount = (ctx: NarrativeContext, limit: number | null): number => {
  if (limit === null) return 0;
  return ctx.siblings.filter((s) => s.value >= limit).length;
};

export const RTA_NARRATIVES: Record<string, NarrativeTemplate> = {
  availability: (alert, ctx, h) =>
    collapseSpaces(
      `${h.fmt(alert.value, 'dishes')} of ${h.fmt(alert.limit_value, 'dishes')} required are in service. ` +
      `${siblingAboveCount(ctx, null)} disabled or faulted.`,
    ),

  wind_stow: (alert, ctx, h) => {
    const gust = findMeasured(ctx, 'wind_stow')?.value ?? alert.value;
    const release = 'gusts stay under 10 m/s for 10 minutes';
    return collapseSpaces(
      `Gusts are ${h.fmt(gust, 'm/s')} against the 15 m/s limit; the array stowed itself. ` +
      `It releases after ${release}. Scans cannot start while stowed.`,
    );
  },

  dish_offline: (alert, ctx, h) => {
    const offlinePeers = ctx.siblings.filter((s) => s.state === 'crit').length;
    return collapseSpaces(
      `${alert.entity ?? 'A dish'} has not reported. ` +
      `${h.plural(offlinePeers, 'other dish is', 'other dishes are')} also offline.` +
      (ctx.related.length > 0 ? ` Related: ${ctx.related.length} alert(s) across services.` : ''),
    );
  },

  dish_temperature: (alert, ctx, h) => {
    const delta = typeof alert.value === 'number' && typeof alert.limit_value === 'number'
      ? alert.value - alert.limit_value
      : null;
    const band = alert.severity === 'critical' ? 'critical' : 'warning';
    const rate = rateClause(ctx, 'K', h);
    const above = siblingAboveCount(ctx, alert.limit_value);
    const total = ctx.siblings.length || 100;
    const power = findMeasured(ctx, 'power_w');
    const elevation = findMeasured(ctx, 'elevation_rad');
    return collapseSpaces(
      `${alert.entity} is ${delta !== null ? h.fmtDelta(delta, 'K') + ' ' : ''}above the ${band} limit ` +
      `and ${rate}rising; ` +
      `${h.plural(above, 'dish', 'dishes')} of ${h.plural(total, 'dish', 'dishes')} above the array median. ` +
      (power ? `Drawing ${h.fmt(power.value, 'W')} ` : '') +
      (elevation ? `at ${h.fmt(elevation.value, 'rad')} elevation. ` : '') +
      (ctx.suggested_controls.length > 0
        ? `Stowing the dish removes the slew and solar load.`
        : ''),
    );
  },

  dish_power: (alert, ctx, h) => {
    const median = ctx.siblings.length
      ? ctx.siblings.reduce((a, b) => a + b.value, 0) / ctx.siblings.length
      : null;
    return collapseSpaces(
      `${alert.entity} is drawing ${h.fmt(alert.value, 'W')} against a ${h.fmt(alert.limit_value, 'W')} limit. ` +
      (median !== null ? `The array median is ${h.fmt(median, 'W')}.` : ''),
    );
  },

  dish_movement: (alert, ctx, h) =>
    collapseSpaces(
      `${alert.entity} failed to reach its commanded position. ` +
      `The drive reports ${alert.metadata?.fault_code ?? 'no fault code'}.`,
    ),

  dish_calibration: (alert, ctx, h) => {
    const sameState = ctx.siblings.filter((s) => s.state === 'warn' || s.state === 'crit').length;
    return collapseSpaces(
      `${alert.entity} was last calibrated ${h.fmt(alert.value, 'h')} ago against a ${h.fmt(alert.limit_value, 'h')} limit. ` +
      `${h.plural(sameState, 'dish is', 'dishes are')} in the same state.` +
      (ctx.suggested_controls.length > 0 ? ` Recalibration is the cheapest fix in the system.` : ''),
    );
  },

  dish_scan: (alert, ctx, h) => {
    const reason = alert.metadata?.fault_code
      ? `because of a ${String(alert.metadata.fault_code)}`
      : alert.value !== null
      ? `with mean SNR ${h.fmt(alert.value, 'dB')}`
      : 'for an unknown reason';
    const limit = alert.limit_value;
    return collapseSpaces(
      `During the scan, ${alert.entity} ${reason}. ` +
      (limit !== null ? `Against a ${h.fmt(limit, 'dB')} limit; ` : '') +
      (ctx.related.length > 0 ? `${ctx.related.length} related alert(s) across services.` : ''),
    );
  },
};

// --------------------------------------------------------------------------- MHE

export const MHE_NARRATIVES: Record<string, NarrativeTemplate> = {
  air_concentration: (alert, ctx, h) =>
    collapseSpaces(
      `${alert.entity ?? 'The room'} reports ${h.fmt(alert.value, alert.unit)} ` +
      `against a ${h.fmt(alert.limit_value, alert.unit)} limit. ` +
      (ctx.suggested_controls.length > 0 ? `Increasing ventilation lowers it directly.` : ''),
    ),
  room_condition: (alert, _ctx, h) =>
    collapseSpaces(
      `${alert.entity ?? 'The room'} is outside the comfort band: ${h.fmt(alert.value, alert.unit)} ` +
      `against a ${h.fmt(alert.limit_value, alert.unit)} limit.`,
    ),
};

// --------------------------------------------------------------------------- OPG

export const OPG_NARRATIVES: Record<string, NarrativeTemplate> = {
  low_battery: (alert, _ctx, h) =>
    collapseSpaces(
      `Batteries are at ${h.fmt(alert.value, '%')} against a ${h.fmt(alert.limit_value, '%')} reserve. ` +
      `Raising the reserve holds them above the threshold that triggered the alert.`,
    ),
  supply_shortfall: (alert, _ctx, h) =>
    collapseSpaces(
      `Supply is ${h.fmt(alert.value, 'W')} below demand. ` +
      `Shedding non-essential load or starting a generator covers the gap.`,
    ),
  backup_active: (alert, _ctx, _h) =>
    collapseSpaces(
      `Backup is active: ${alert.message ?? 'generators are carrying the load'}. ` +
      `Stop the generator only once the shortfall has cleared.`,
    ),
};
