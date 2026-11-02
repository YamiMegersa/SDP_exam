import type { AlertLimit } from '../arlApi/client';
import type { Config } from '../config';
import type { Store } from '../db/store';
import type { TopologyRegistry } from '../topology/registry';
import { mhePlugin } from './mhe';
import { opgPlugin } from './opg';
import { rtaPlugin } from './rta';
import type { DerivedReport, ServicePlugin } from './types';

export type { DerivedReport, Measure, Verdict } from './types';

/**
 * The plugin table.
 *
 * One line per service: this array, and the topology it subscribes to, are the only places the
 * platform enumerates its services. A service that publishes a `$topology` but has no plugin here
 * is still ingested, stored and charted - it simply has no workspace and answers no questions of
 * its own yet, which is the right behaviour for a service the exam does not require.
 */
const PLUGINS: ServicePlugin[] = [rtaPlugin, mhePlugin, opgPlugin];

export function listPlugins(): ServicePlugin[] {
  return PLUGINS;
}

export function pluginFor(code: string): ServicePlugin | null {
  return PLUGINS.find((plugin) => plugin.code === code) ?? null;
}

/** Derived indicators for every plugin, or only the ones named in `only`, in registry order. */
export function deriveAll(
  store: Store,
  registry: TopologyRegistry,
  cfg: Config,
  limits: Map<string, AlertLimit[]>,
  only?: string[],
): DerivedReport[] {
  const wanted = only ? new Set(only) : null;
  return listPlugins()
    .filter((plugin) => !wanted || wanted.has(plugin.code))
    .map((plugin) => {
      const report = plugin.derive({ store, registry, cfg, limits: limits.get(plugin.code) ?? [] });
      return { service: plugin.code, ts: report.ts, measures: report.measures };
    });
}
