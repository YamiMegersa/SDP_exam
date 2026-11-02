/**
 * Cross-service cause hints (Planning Docs/05 §6.3.3, 23 §6.3.3).
 *
 * A cause ties one physical event to the alerts it raises in different services, so the context
 * pack's `related` field can show that a storm behind RTA's wind stow is the same storm behind
 * OPG's solar underperformance. Matching is on `type` + service only — never on a simulated
 * value.
 *
 * Each cause lists every (service, type) pair it covers. `causesFor(alert)` returns the causes
 * that include the alert; `peersOf(cause, alert)` returns the other (service, type) pairs under
 * the same cause — which is what `buildRelated` queries for.
 */

export interface CauseEntry {
  cause: string;
  members: Array<{ service: string; type: string }>;
}

export const CAUSES: CauseEntry[] = [
  {
    cause: 'env.storm',
    members: [
      { service: 'rta', type: 'wind_stow' },
      { service: 'opg', type: 'solar_underperformance' },
    ],
  },
  {
    cause: 'env.heatwave',
    members: [
      { service: 'rta', type: 'dish_temperature' },
      { service: 'mhe', type: 'room_condition' },
      { service: 'opg', type: 'battery_temperature' },
    ],
  },
  {
    cause: 'env.cold_snap',
    members: [
      { service: 'mhe', type: 'room_condition' },
      { service: 'opg', type: 'battery_temperature' },
    ],
  },
  {
    cause: 'power.shortfall',
    members: [
      { service: 'rta', type: 'dish_power' },
      { service: 'mhe', type: 'habitat_fault' },
      { service: 'opg', type: 'supply_shortfall' },
      { service: 'opg', type: 'low_battery' },
      { service: 'opg', type: 'backup_active' },
    ],
  },
];

/** The causes that include this alert. */
export function causesFor(service: string, type: string): CauseEntry[] {
  return CAUSES.filter((c) => c.members.some((m) => m.service === service && m.type === type));
}

/** The other (service, type) pairs that share a cause with the given alert. */
export function peersOf(cause: CauseEntry, service: string, type: string): Array<{ service: string; type: string }> {
  return cause.members.filter((m) => !(m.service === service && m.type === type));
}
