import { describe, expect, it } from 'vitest';
import {
  ServiceTopology,
  TopologyRegistry,
  validateControlValue,
} from '../src/topology/registry';
import { RTA_TOPOLOGY } from './helpers';

/** Parse the fixture exactly as it arrives off the wire: a JSON object, nothing typed. */
const parse = (raw: object) => new ServiceTopology(JSON.parse(JSON.stringify(raw)));
const rta = parse(RTA_TOPOLOGY);

describe('topology parsing', () => {
  it('normalises entities, keeping their kind and metadata', () => {
    expect(rta.service).toBe('rta');
    expect(rta.version).toBe('test-1');
    expect(rta.entities).toHaveLength(5);
    expect(rta.kindOf('dish-003')).toBe('dish');
    expect(rta.entitiesOfKind('dish').map((e) => e.id)).toEqual([
      'dish-001',
      'dish-002',
      'dish-003',
      'dish-004',
    ]);
    // Row/col survive as metadata so the dish matrix can place each dish without a lookup table.
    expect(rta.entityById.get('dish-001')?.meta).toMatchObject({ row: 1, col: 1 });
  });

  it('derives the stream name from the topic and keeps declared fields', () => {
    const scan = rta.streams.find((s) => s.stream === 'scan');
    expect(scan?.topic).toBe('arl/rta/+/telemetry/scan');
    expect(scan?.entityKinds).toEqual(['dish']);
    expect(scan?.periodS).toBe(1);
    expect(scan?.fields.map((f) => f.key)).toEqual(['status', 'scan_id', 'scan_progress']);
  });

  it('drops entries that cannot be routed instead of failing the whole topology', () => {
    const partial = parse({
      service: 'mhe',
      entities: [{ id: 'room-1', kind: 'room' }, { kind: 'room' }, 'nonsense'],
      streams: [{ period_s: 10 }, { topic: 'arl/mhe/+/telemetry/environment' }],
      controls: [{ value: { type: 'bool' } }],
    });
    expect(partial.entities.map((e) => e.id)).toEqual(['room-1']);
    expect(partial.streams).toHaveLength(1);
    expect(partial.controls).toHaveLength(0);
  });

  it('rejects a payload that is not a service topology', () => {
    expect(() => new ServiceTopology({})).toThrow(/service code/);
    expect(() => new ServiceTopology(null as unknown as object)).toThrow(/not an object/);
  });

  it('defaults a missing entity kind rather than dropping the entity', () => {
    const topology = parse({ service: 'opg', entities: [{ id: 'solar' }] });
    expect(topology.kindOf('solar')).toBe('unknown');
  });
});

describe('topic routing', () => {
  it('matches telemetry against the wildcarded stream pattern', () => {
    const match = rta.matchTelemetry('arl/rta/dish-002/telemetry/scan');
    expect(match?.entity).toBe('dish-002');
    expect(match?.def.stream).toBe('scan');
  });

  it('refuses topics the topology does not declare', () => {
    expect(rta.matchTelemetry('arl/rta/dish-002/telemetry/unknown')).toBeNull();
    expect(rta.matchTelemetry('arl/rta/dish-002/state/scan')).toBeNull();
    expect(rta.matchTelemetry('arl/rta/dish-002/telemetry')).toBeNull();
  });

  it('honours state items declared for one exact entity', () => {
    // `arl/rta/global/state/online` is published literally, so the wildcard lookup misses first.
    const exact = rta.matchState('arl/rta/global/state/online');
    expect(exact?.def.item).toBe('online');
    expect(exact?.entity).toBe('global');

    const wildcard = rta.matchState('arl/rta/dish-001/state/commanded');
    expect(wildcard?.def.item).toBe('commanded');
  });

  it('matches events and acknowledgements, and knows which event kinds it declared', () => {
    expect(rta.matchEvent('arl/rta/events/alert')).toEqual({ kind: 'alert' });
    expect(rta.matchEvent('arl/rta/events/scan')).toEqual({ kind: 'scan' });
    expect(rta.hasEventKind('alert')).toBe(true);
    // The topic shape is valid but the kind was never declared, which is what ingest gates on.
    expect(rta.hasEventKind('scan')).toBe(false);
    expect(rta.matchAck('arl/rta/ack/cmd-7')).toEqual({ commandId: 'cmd-7' });
  });

  it('only offers a control to entities of the declared kind', () => {
    expect(rta.controlFor('dish-001', 'target')?.control).toBe('target');
    expect(rta.controlFor('global', 'target')).toBeNull();
    expect(rta.controlFor('dish-001', 'unknown')).toBeNull();
    expect(rta.controlsForEntity('dish-001').map((c) => c.control)).toEqual(['target']);
    expect(rta.controlsForEntity('global')).toHaveLength(0);
  });
});

describe('control validation', () => {
  it('accepts a boolean and nothing that merely looks like one', () => {
    expect(validateControlValue({ type: 'bool' }, true)).toEqual({ ok: true, value: true });
    expect(validateControlValue({ type: 'bool' }, 'true').ok).toBe(false);
    expect(validateControlValue({ type: 'bool' }, 1).ok).toBe(false);
  });

  it('restricts an enum to its published values', () => {
    const schema = { type: 'enum' as const, values: ['none', 'non_essential', 'all'] };
    expect(validateControlValue(schema, 'all')).toEqual({ ok: true, value: 'all' });
    expect(validateControlValue(schema, 'everything').ok).toBe(false);
  });

  it('coerces numeric strings but enforces range and integrality', () => {
    const schema = { type: 'float' as const, min: 0, max: 10, unit: 'm' };
    expect(validateControlValue(schema, '5')).toEqual({ ok: true, value: 5 });
    expect(validateControlValue(schema, 11).ok).toBe(false);
    expect(validateControlValue(schema, -1).ok).toBe(false);
    expect(validateControlValue({ type: 'integer' }, 2.5).ok).toBe(false);
    expect(validateControlValue({ type: 'integer' }, 2).ok).toBe(true);
    expect(validateControlValue({ type: 'float' }, 'abc').ok).toBe(false);
  });

  it('bounds strings so a control payload cannot become a document', () => {
    expect(validateControlValue({ type: 'string' }, 'tgt-003').ok).toBe(true);
    expect(validateControlValue({ type: 'string' }, '').ok).toBe(false);
    expect(validateControlValue({ type: 'string' }, 'x'.repeat(65)).ok).toBe(false);
  });

  it('requires every declared object field and rejects undeclared ones', () => {
    const schema = {
      type: 'object' as const,
      fields: [
        { key: 'azimuth_rad', type: 'float' as const },
        { key: 'elevation_rad', type: 'float' as const },
      ],
    };
    expect(validateControlValue(schema, { azimuth_rad: 1, elevation_rad: 0.5 })).toEqual({
      ok: true,
      value: { azimuth_rad: 1, elevation_rad: 0.5 },
    });
    expect(validateControlValue(schema, { azimuth_rad: 1 }).ok).toBe(false);
    expect(validateControlValue(schema, { azimuth_rad: 1, elevation_rad: 1, extra: 2 }).ok).toBe(
      false,
    );
    expect(validateControlValue(schema, [1, 2]).ok).toBe(false);
  });

  it('requires a whole-millisecond timestamp', () => {
    expect(validateControlValue({ type: 'timestamp' }, 1_700_000_000_000).ok).toBe(true);
    expect(validateControlValue({ type: 'timestamp' }, 1.5).ok).toBe(false);
  });

  it('refuses a schema type it cannot enforce', () => {
    expect(validateControlValue({ type: 'array' }, [1]).ok).toBe(false);
  });
});

describe('topology registry', () => {
  it('reports a change only when the version or entity set moves', () => {
    const registry = new TopologyRegistry(['rta', 'mhe', 'opg']);
    const first = registry.set(RTA_TOPOLOGY);
    expect(first.changed).toBe(true);

    const repeat = registry.set(RTA_TOPOLOGY);
    expect(repeat.changed).toBe(false);

    const moved = registry.set({ ...RTA_TOPOLOGY, version: 'test-2' });
    expect(moved.changed).toBe(true);
    expect(registry.get('rta')?.version).toBe('test-2');
  });

  it('knows which services it is configured for', () => {
    const registry = new TopologyRegistry(['rta']);
    expect(registry.accepts('rta')).toBe(true);
    expect(registry.accepts('lwm')).toBe(false);
    expect(registry.services).toEqual(['rta']);
    expect(registry.get('mhe')).toBeUndefined();
  });
});
