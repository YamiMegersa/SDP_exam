import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AlertEngine } from '../src/alerts/engine';
import { Store } from '../src/db/store';
import { Ingest } from '../src/mqtt/ingest';
import { Bus } from '../src/platform/bus';
import type { PlatformEvent } from '../src/platform/events';
import { ServiceTopology, TopologyRegistry, validateControlValue } from '../src/topology/registry';
import type { ValueSchema } from '../src/types';
import { SimClock } from '../src/util/clock';
import { countRows, testConfig } from './helpers';

/**
 * Contract tests (Planning Docs/51 §2.3): the platform against what the simulator really publishes.
 * The fixtures are a seeded `preroll` of each service (`npm run fixtures`), not hand-written
 * payloads, so a field the specification forgot to mention still has to route.
 */
interface Message {
  topic: string;
  retain?: boolean;
  payload: Record<string, unknown>;
}
interface Samples {
  source: { service: string; seed: number; from: string; to: string; scenario: string };
  telemetry: Record<string, Message[]>;
  state: Record<string, Message>;
  events: Record<string, Message>;
}

const FIXTURES = join(__dirname, 'fixtures');
const load = <T>(name: string): T => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as T;
const ENVELOPE = new Set(['v', 'ts', 'seq', 'entity']);

for (const service of ['rta', 'mhe', 'opg']) {
  const raw = load<Record<string, unknown[]> & { service: string }>(`${service}.topology.json`);
  const samples = load<Samples>(`${service}.samples.json`);
  const topology = new ServiceTopology(raw);
  const telemetry = Object.values(samples.telemetry).flat();

  describe(`${service} contract (seed ${samples.source.seed}, ${samples.source.scenario})`, () => {
    it('parses the published $topology without dropping an entry', () => {
      expect(topology.service).toBe(service);
      expect(topology.entities).toHaveLength(raw.entities!.length);
      expect(topology.streams).toHaveLength(raw.streams!.length);
      expect(topology.states).toHaveLength(raw.state!.length);
      expect(topology.events).toHaveLength(raw.events!.length);
      expect(topology.controls).toHaveLength(raw.controls!.length);
      expect(topology.entities.every((e) => e.kind !== 'unknown')).toBe(true);
    });

    it('routes every telemetry sample to a declared stream, and every field is declared', () => {
      expect(telemetry.length).toBeGreaterThan(0);
      for (const message of telemetry) {
        const match = topology.matchTelemetry(message.topic);
        expect(match, message.topic).not.toBeNull();
        expect(topology.kindOf(match!.entity), message.topic).toBeDefined();
        if (match!.def.entityKinds.length) {
          expect(match!.def.entityKinds).toContain(topology.kindOf(match!.entity));
        }
        const declared = new Set(match!.def.fields.map((f) => f.key));
        const undeclared = Object.keys(message.payload).filter((k) => !ENVELOPE.has(k) && !declared.has(k));
        expect(undeclared, message.topic).toEqual([]);
        expect(typeof message.payload.ts).toBe('number');
      }
    });

    it('routes every state item and every event kind', () => {
      for (const message of Object.values(samples.state)) {
        expect(topology.matchState(message.topic), message.topic).not.toBeNull();
        expect(message.retain, `${message.topic} should be retained`).toBe(true);
      }
      for (const message of Object.values(samples.events)) {
        const match = topology.matchEvent(message.topic);
        expect(match, message.topic).not.toBeNull();
        expect(topology.hasEventKind(match!.kind)).toBe(true);
      }
    });

    it('validates every published control at and beyond its bounds', () => {
      for (const control of topology.controls) {
        const { good, bad } = probes(control.value);
        const label = `${control.control} (${control.value.type})`;
        expect(validateControlValue(control.value, good).ok, `${label} accepts ${JSON.stringify(good)}`).toBe(true);
        for (const value of bad) {
          expect(validateControlValue(control.value, value).ok, `${label} rejects ${JSON.stringify(value)}`).toBe(false);
        }
        // Every control is addressable on at least one entity the topology declares.
        const target = topology.entities.find((e) => topology.controlFor(e.id, control.control));
        expect(target, `${control.control} has an addressable entity`).toBeDefined();
      }
    });

    describe('through the ingest path', () => {
      let store: Store;
      let ingest: Ingest;

      beforeEach(() => {
        store = new Store(':memory:');
        const clock = new SimClock();
        const alerts = new AlertEngine(store, new Bus<PlatformEvent>(), clock, {
          services: [service],
          silenceMs: 60_000,
        });
        ingest = new Ingest(
          testConfig({ ARL_SERVICES: service }),
          new TopologyRegistry([service]),
          store,
          new Bus<PlatformEvent>(),
          clock,
          alerts,
        );
      });
      afterEach(() => store.close());

      const deliver = (message: { topic: string; payload: unknown }): void =>
        (ingest as unknown as { receive(t: string, p: Buffer): void }).receive(
          message.topic,
          Buffer.from(JSON.stringify(message.payload)),
        );
      const flush = (): void => (ingest as unknown as { flush(): void }).flush();

      it('stores every sample and raises every alert the window produced', () => {
        deliver({ topic: `arl/${service}/$topology`, payload: raw });
        for (const message of Object.values(samples.state)) deliver(message);
        for (const message of telemetry) deliver(message);
        const events = Object.values(samples.events).sort((a, b) => Number(a.payload.ts) - Number(b.payload.ts));
        for (const message of events) deliver(message);
        flush();

        expect(ingest.counters.unparsed).toBe(0);
        expect(ingest.counters.dropped).toBe(0);
        expect(countRows(store, 'telemetry')).toBe(telemetry.length);
        expect(countRows(store, 'entity')).toBe(raw.entities!.length);

        const raised = new Set(
          events.filter((m) => m.topic.endsWith('/alert') && m.payload.state === 'raised').map((m) => m.payload.alert_id),
        );
        const stored = new Set(store.listAlerts({ service, limit: 1000 }).map((a) => a.alert_id));
        for (const id of raised) expect(stored, String(id)).toContain(id);
      });
    });
  });
}

/** One in-bounds value and a set of values that must be refused, derived from the schema alone. */
function probes(schema: ValueSchema): { good: unknown; bad: unknown[] } {
  switch (schema.type) {
    case 'bool':
      return { good: true, bad: ['yes', 1, null] };
    case 'enum':
      return { good: schema.values![0], bad: ['not-a-value', 0] };
    case 'string':
      return { good: 'sub-1', bad: ['', 'x'.repeat(65), 7] };
    case 'timestamp':
      return { good: 1_804_017_600_000, bad: ['tomorrow', 1.5] };
    case 'float':
    case 'integer': {
      const min = schema.min ?? 0;
      const max = schema.max ?? min + 100;
      const bad: unknown[] = ['abc'];
      if (schema.min !== undefined) bad.push(schema.min - 1);
      if (schema.max !== undefined) bad.push(schema.max + 1);
      return { good: schema.type === 'integer' ? Math.ceil(min) : (min + max) / 2, bad };
    }
    case 'object': {
      const fields = schema.fields ?? [];
      const good = Object.fromEntries(
        fields.map((f) => [f.key, f.type === 'string' ? '06:00' : f.type === 'bool' ? true : 1]),
      );
      return { good, bad: [{ ...good, extra: 1 }, {}, 'x'] };
    }
    default:
      return { good: undefined, bad: [] };
  }
}
