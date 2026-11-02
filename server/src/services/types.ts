import type { AlertLimit } from '../arlApi/client';
import type { Config } from '../config';
import type { Store } from '../db/store';
import type { TopologyRegistry } from '../topology/registry';

/**
 * Service plugins.
 *
 * The platform has one ingest path, one store and one REST surface; what differs between RTA, MHE
 * and OPG is the questions their data answers. A plugin is the single place a service is plugged
 * in: it declares its identity and computes its measures, and nothing else in the server needs to
 * know the service exists. Adding a fourth service is a new file plus one line in `index.ts`.
 *
 * The derived measures themselves are declared here rather than in the HTTP layer so the API,
 * the tests and any future alert rule all read the same definition.
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

export interface MeasureContext {
  store: Store;
  registry: TopologyRegistry;
  cfg: Config;
  /** The service's own alert limits, or `[]` when the API could not be reached. */
  limits: AlertLimit[];
}

export interface ServicePlugin {
  code: string;
  label: string;
  /** Workspace accent, kept next to the service so the client can name it once. */
  accent: string;
  /** Entity kind the workspace is built around (`dish`, `room`, `global`). */
  focalKind: string | null;
  derive(ctx: MeasureContext): { ts: number | null; measures: Measure[] };
}
