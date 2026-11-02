import type { Store } from '../db/store';
import type { AlertRecord } from '../types';
import { series as querySeries, latestTelemetry } from '../db/queries';
import { fmt, fmtDelta, fmtRate, plural } from './narrative-format';
import { RTA_NARRATIVES, MHE_NARRATIVES, OPG_NARRATIVES } from './narratives';
import { causesFor, peersOf, type CauseEntry } from './relations';

/**
 * The context pack (Planning Docs/05 §4.3, 23 §6.3, 33 §6.3, 43 §6.3).
 *
 * Built lazily on `GET /api/alerts/:id/context`. Every field is assembled from pure helpers so
 * the narrative can be snapshot-tested against fixture packs, and so a missing piece degrades the
 * pack to `context_quality: 'partial'` instead of failing the request.
 */

export type ContextQuality = 'complete' | 'partial';

export interface MeasuredValue {
  key: string;
  value: number;
  unit: string | null;
  limit: number | null;
  limitKey: string | null;
  direction: 'above' | 'below' | null;
}

export interface HistoryEntry {
  ts: number;
  value: number;
}

export interface SiblingValue {
  entity: string;
  value: number;
  state: 'ok' | 'warn' | 'crit' | 'unknown';
}

export interface RelatedAlert {
  service: string;
  type: string;
  alert_id: string;
  ts: number;
}

export interface ControlSuggestion {
  service: string;
  entity: string;
  control: string;
  label: string;
  value: unknown;
  rationale: string;
}

export interface SuppressedControl {
  control: string;
  why: string;
}

export interface AlertContext {
  alert: AlertRecord;
  measured: MeasuredValue[];
  history: HistoryEntry[];
  siblings: SiblingValue[];
  related: RelatedAlert[];
  suggested_controls: ControlSuggestion[];
  suppressed_controls: SuppressedControl[];
  narrative: string;
  context_quality: ContextQuality;
}

/**
 * The alert's own measured value plus the companion fields that make it interpretable.
 *
 * The alert payload carries `value`/`limit`/`unit`; companions come from the latest telemetry
 * row for the same entity. For `dish_temperature` the companion is `system_temperature_k`;
 * for `dish_scan` it is `snr_db` and `scan_progress`; for `dish_power` it is `elevation_rad`.
 * Platform alerts (`service_offline`, `broker`, `ingest-gap`) have no companions.
 */
export interface CompanionSpec {
  /** Stream the companion lives on. */
  stream: string;
  /** Keys to pull from the companion row. */
  keys: Array<{ key: string; unit?: string; limit?: number; limitKey?: string }>;
}

const RTA_COMPANIONS: Record<string, CompanionSpec> = {
  dish_temperature: {
    stream: 'normal',
    keys: [
      { key: 'temperature_k', unit: 'K' },
      { key: 'system_temperature_k', unit: 'K' },
      { key: 'power_w', unit: 'W' },
      { key: 'elevation_rad', unit: 'rad' },
    ],
  },
  dish_power: {
    stream: 'normal',
    keys: [
      { key: 'power_w', unit: 'W', limit: 5000, limitKey: 'rta.dish_power.max_w' },
      { key: 'elevation_rad', unit: 'rad' },
    ],
  },
  dish_scan: {
    stream: 'scan',
    keys: [
      { key: 'snr_db', unit: 'dB', limit: 3, limitKey: 'rta.scan.min_snr_db' },
      { key: 'scan_progress', unit: '%' },
    ],
  },
};

export function buildMeasured(
  alert: AlertRecord,
  store: Store,
): MeasuredValue[] {
  const out: MeasuredValue[] = [];

  // The alert's own primary measure.
  if (typeof alert.value === 'number') {
    out.push({
      key: primaryMeasureKey(alert),
      value: alert.value,
      unit: alert.unit,
      limit: alert.limit_value,
      limitKey: primaryLimitKey(alert),
      direction: directionOf(alert),
    });
  }

  // Companions: latest telemetry for the same entity.
  const spec = companionsFor(alert);
  if (spec && alert.entity) {
    try {
      const samples = latestTelemetry(store, alert.service, [spec.stream]).filter(
        (s) => s.entity === alert.entity,
      );
      if (samples.length > 0) {
        const data = samples[0].data;
        for (const k of spec.keys) {
          const v = data[k.key];
          if (typeof v === 'number' && Number.isFinite(v)) {
            out.push({
              key: k.key,
              value: v,
              unit: k.unit ?? null,
              limit: k.limit ?? null,
              limitKey: k.limitKey ?? null,
              direction: null,
            });
          }
        }
      }
    } catch {
      // Companions are best-effort; if telemetry is unavailable, the primary measure is still
      // returned.
    }
  }

  return out;
}

function primaryMeasureKey(alert: AlertRecord): string {
  // The alert type is the measure, by convention.
  return alert.type;
}

function primaryLimitKey(alert: AlertRecord): string | null {
  // The limit key is service-specific; the alert row does not carry it, so we fall back to a
  // well-known table for the types that have one. Platform alerts return null.
  if (alert.service === 'rta') {
    switch (alert.type) {
      case 'dish_temperature':
        return alert.severity === 'critical' ? 'crit_k' : 'warn_k';
      case 'availability':
        return 'rta.availability.min_active';
      case 'wind_stow':
        return 'rta.wind_stow.gust_ms';
      case 'dish_power':
        return 'rta.dish_power.max_w';
      case 'dish_scan':
        return 'rta.scan.min_snr_db';
      case 'dish_calibration':
        return 'rta.calibration.max_age_h';
      default:
        return null;
    }
  }
  return null;
}

function directionOf(alert: AlertRecord): 'above' | 'below' | null {
  if (typeof alert.value !== 'number' || typeof alert.limit_value !== 'number') return null;
  return alert.value >= alert.limit_value ? 'above' : 'below';
}

function companionsFor(alert: AlertRecord): CompanionSpec | null {
  if (alert.service === 'rta') return RTA_COMPANIONS[alert.type] ?? null;
  // MHE and OPG companions are added when their narrative templates need them; until then the
  // measured field carries only the primary measure.
  return null;
}

/**
 * 30-minute window of the alert's primary measure, 60 buckets. The existing `series()` helper
 * already handles stride and bucket count; we just slice the right key out of each row's `data`.
 */
export function buildHistory(
  alert: AlertRecord,
  store: Store,
  windowMs = 30 * 60_000,
  buckets = 60,
): HistoryEntry[] {
  if (!alert.entity) return [];
  const stream = historyStreamFor(alert);
  const key = historyKeyFor(alert);
  if (!stream || !key) return [];

  const to = alert.raised_ts;
  const from = to - windowMs;
  const { rows } = querySeries(store, {
    service: alert.service,
    stream,
    entity: alert.entity,
    from,
    to,
    limit: buckets,
  });
  const out: HistoryEntry[] = [];
  for (const r of rows) {
    const v = r.data[key];
    if (typeof v === 'number' && Number.isFinite(v)) out.push({ ts: r.ts, value: v });
  }
  return out;
}

function historyStreamFor(alert: AlertRecord): string | null {
  if (alert.service === 'rta') {
    if (alert.type === 'dish_scan') return 'scan';
    if (
      alert.type === 'dish_temperature' ||
      alert.type === 'dish_power' ||
      alert.type === 'dish_movement' ||
      alert.type === 'dish_calibration' ||
      alert.type === 'dish_offline'
    ) {
      return 'normal';
    }
    return null;
  }
  return null;
}

function historyKeyFor(alert: AlertRecord): string | null {
  if (alert.service === 'rta') {
    switch (alert.type) {
      case 'dish_temperature':
        return 'temperature_k';
      case 'dish_power':
        return 'power_w';
      case 'dish_scan':
        return 'snr_db';
      default:
        return null;
    }
  }
  return null;
}

/**
 * Peers that share the same measure. For dish alerts that is every other dish; for array-level
 * alerts (availability, wind_stow) it is the previous 6 hours of the same measure.
 */
export function buildSiblings(alert: AlertRecord, store: Store): SiblingValue[] {
  if (alert.service !== 'rta' || !alert.entity) return [];
  const spec = companionsFor(alert);
  if (!spec) return [];
  const key = spec.keys[0]?.key;
  if (!key) return [];

  const samples = (() => {
    try {
      return latestTelemetry(store, alert.service, [spec.stream]);
    } catch {
      return [];
    }
  })();
  if (samples.length === 0) return [];

  const values = samples
    .map((s) => ({ entity: s.entity, v: s.data[key] }))
    .filter((s): s is { entity: string; v: number } => typeof s.v === 'number' && Number.isFinite(s.v));
  if (values.length === 0) return [];

  // Band classification against the alert's own limit when one exists, otherwise against the
  // median. This is what lets the card say "11 of 100 dishes are above the array median".
  const limit = alert.limit_value ?? median(values.map((v) => v.v));
  return values.map(({ entity, v }) => ({
    entity,
    value: v,
    state: siblingState(v, limit, alert.severity),
  }));
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function siblingState(
  value: number,
  limit: number,
  severity: AlertRecord['severity'],
): SiblingValue['state'] {
  if (severity === 'critical' && value >= limit) return 'crit';
  if (severity === 'warning' && value >= limit) return 'warn';
  if (value >= limit) return 'warn';
  return 'ok';
}

/**
 * Other alerts within ±5 min, cross-service. Keyed by the cause table in `relations.ts`,
 * matched on `type` + service only — never on a simulated value (05 §6.3.3).
 */
export function buildRelated(alert: AlertRecord, store: Store, windowMs = 5 * 60_000): RelatedAlert[] {
  const causes = causesFor(alert.service, alert.type);
  if (causes.length === 0) return [];

  // The set of (service, type) pairs that share a cause with this alert, excluding the alert
  // itself. A single alert can appear in several causes; we take the union.
  const peers = new Set<string>();
  for (const cause of causes) {
    for (const p of peersOf(cause, alert.service, alert.type)) {
      peers.add(`${p.service}:${p.type}`);
    }
  }
  if (peers.size === 0) return [];

  const from = alert.raised_ts - windowMs;
  const to = alert.raised_ts + windowMs;
  const all = store.listAlerts({ sinceTs: from, limit: 500 });
  const out: RelatedAlert[] = [];
  for (const other of all) {
    if (other.raised_ts > to) continue;
    if (other.alert_id === alert.alert_id) continue;
    if (!peers.has(`${other.service}:${other.type}`)) continue;
    out.push({
      service: other.service,
      type: other.type,
      alert_id: other.alert_id,
      ts: other.raised_ts,
    });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/**
 * Controls the card can offer. Sourced from the per-service tables (23 §6.3.4, 33 §6.3.4,
 * 43 §6.3.4), filtered by the live topology so a suggestion for a control that does not exist
 * is never shown.
 *
 * The guard check (a suggestion whose precondition currently fails is returned as `suppressed`
 * rather than as a button) is wired in a follow-up commit; this step only filters by topology.
 */
export function buildSuggestedControls(
  alert: AlertRecord,
  topology: { controls: Array<{ service: string; control: string; entityKinds: string[] }> },
): { suggestions: ControlSuggestion[]; suppressed: SuppressedControl[] } {
  const table = suggestionsTableFor(alert);
  if (!table) return { suggestions: [], suppressed: [] };

  const suggestions: ControlSuggestion[] = [];
  const suppressed: SuppressedControl[] = [];
  for (const row of table) {
    const exists = topology.controls.some(
      (c) => c.service === alert.service && c.control === row.control,
    );
    if (!exists) {
      suppressed.push({ control: row.control, why: 'control not present in topology' });
      continue;
    }
    suggestions.push({
      service: alert.service,
      entity: alert.entity ?? 'global',
      control: row.control,
      label: row.label,
      value: row.value,
      rationale: row.rationale,
    });
  }
  return { suggestions, suppressed };
}

interface SuggestionRow {
  control: string;
  label: string;
  value: unknown;
  rationale: string;
}

function suggestionsTableFor(alert: AlertRecord): SuggestionRow[] | null {
  if (alert.service === 'rta') return RTA_SUGGESTIONS[alert.type] ?? null;
  if (alert.service === 'mhe') return MHE_SUGGESTIONS[alert.type] ?? null;
  if (alert.service === 'opg') return OPG_SUGGESTIONS[alert.type] ?? null;
  return null;
}

const RTA_SUGGESTIONS: Record<string, SuggestionRow[]> = {
  availability: [
    { control: 'enable_dish', label: 'Enable faulty dish', value: true, rationale: 'Bring dishes back into service.' },
    { control: 'request_recalibration', label: 'Recalibrate stale dishes', value: true, rationale: 'Cheapest fix when many dishes report a stale calibration.' },
  ],
  wind_stow: [
    { control: 'cancel_scan', label: 'Cancel running scan', value: true, rationale: 'Scans cannot start while stowed; stop work that would fail.' },
  ],
  dish_offline: [
    { control: 'enable_dish', label: 'Reset then re-enable', value: true, rationale: 'Reset the enabled path, then recalibrate on return.' },
    { control: 'request_recalibration', label: 'Recalibrate on return', value: true, rationale: 'A dish that came back online should be recalibrated before work.' },
  ],
  dish_temperature: [
    { control: 'stow_dish', label: 'Stow dish', value: true, rationale: 'Removes slew and solar load.' },
    { control: 'request_recalibration', label: 'Request recalibration', value: true, rationale: 'Resets receiver drift when the temperature is rising without a fault code.' },
    { control: 'assign_subarray', label: 'Move to maintenance subarray', value: 'maintenance', rationale: 'Pulls the dish out of the scan.' },
  ],
  dish_power: [
    { control: 'stow_dish', label: 'Stow dish', value: true, rationale: 'Drops the draw; reversible without re-enabling.' },
    { control: 'enable_dish', label: 'Disable dish', value: false, rationale: 'Drops the draw when stow is not enough.' },
  ],
  dish_movement: [
    { control: 'enable_dish', label: 'Disable dish', value: false, rationale: 'Take the dish out of service while the drive recovers.' },
    { control: 'request_recalibration', label: 'Recalibrate', value: true, rationale: 'Recalibrate once the drive reports a successful slew again.' },
  ],
  dish_calibration: [
    { control: 'request_recalibration', label: 'Recalibrate (batch)', value: true, rationale: 'Cheapest fix in the system; 120 s each, a batch resolves many at once.' },
  ],
  dish_scan: [
    { control: 'request_recalibration', label: 'Recalibrate', value: true, rationale: 'Right fix when SNR alone is low and no fault code is set.' },
    { control: 'cancel_scan', label: 'Cancel scan', value: true, rationale: 'Right fix when the whole scan is bad.' },
  ],
};

const MHE_SUGGESTIONS: Record<string, SuggestionRow[]> = {
  air_concentration: [
    { control: 'ventilation', label: 'Increase ventilation', value: 'high', rationale: 'Lowers CO₂ directly.' },
  ],
  room_condition: [
    { control: 'heater', label: 'Reduce heating', value: 'low', rationale: 'Brings the room back inside the comfort band.' },
  ],
};

const OPG_SUGGESTIONS: Record<string, SuggestionRow[]> = {
  low_battery: [
    { control: 'battery_reserve', label: 'Raise reserve', value: 30, rationale: 'Keeps the batteries above the reserve that triggered the alert.' },
  ],
  supply_shortfall: [
    { control: 'shed_load', label: 'Shed non-essential load', value: 'non_essential', rationale: 'Brings demand under available supply.' },
    { control: 'start_generator', label: 'Start generator', value: true, rationale: 'Covers the shortfall until solar or batteries recover.' },
  ],
  backup_active: [
    { control: 'stop_generator', label: 'Stop generator', value: true, rationale: 'Only when the shortfall has cleared; otherwise the batteries will re-trigger it.' },
  ],
};

/**
 * Assemble the full context pack for one alert. Returns `context_quality: 'partial'` when any
 * field could not be built, rather than throwing.
 */
export interface ContextDeps {
  store: Store;
  topology: { controls: Array<{ service: string; control: string; entityKinds: string[] }> };
}

export function buildContext(alert: AlertRecord, deps: ContextDeps): AlertContext {
  let quality: ContextQuality = 'complete';
  const missing: string[] = [];

  const measured = buildMeasured(alert, deps.store);
  const siblings = buildSiblings(alert, deps.store);
  const related = buildRelated(alert, deps.store);

  let history: HistoryEntry[] = [];
  try {
    history = buildHistory(alert, deps.store);
  } catch {
    quality = 'partial';
    missing.push('history');
  }

  const { suggestions, suppressed } = buildSuggestedControls(alert, deps.topology);

  const narrative = buildNarrative(alert, { measured, history, siblings, related, suggested_controls: suggestions });
  if (!narrative) {
    quality = 'partial';
    missing.push('narrative');
  }

  return {
    alert,
    measured,
    history,
    siblings,
    related,
    suggested_controls: suggestions,
    suppressed_controls: suppressed,
    narrative: narrative ?? '',
    context_quality: quality,
  };
}

function buildNarrative(
  alert: AlertRecord,
  ctx: Pick<AlertContext, 'measured' | 'history' | 'siblings' | 'related' | 'suggested_controls'>,
): string | null {
  const table =
    alert.service === 'rta' ? RTA_NARRATIVES
    : alert.service === 'mhe' ? MHE_NARRATIVES
    : alert.service === 'opg' ? OPG_NARRATIVES
    : null;
  const template = table?.[alert.type];
  if (!template) return null;
  return template(alert, ctx, { fmt, fmtDelta, fmtRate, plural });
}

