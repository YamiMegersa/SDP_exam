import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArlApi } from '../src/arlApi/client';
import { CommandService } from '../src/commands/service';
import { Store } from '../src/db/store';
import type { Ingest } from '../src/mqtt/ingest';
import { Bus } from '../src/platform/bus';
import type { PlatformEvent } from '../src/platform/events';
import type { CommandAck, VerifyResult } from '../src/types';
import { SimClock } from '../src/util/clock';
import { registryWithTopologies, testConfig } from './helpers';

/**
 * The command path with a fake API and a fake publisher (51 §5, item 6): the guards run in order and
 * stop before the API is asked, the API's verdict decides whether anything is published, and the
 * acks that come back are applied to the row the platform stored.
 */

let store: Store;
let bus: Bus<PlatformEvent>;
let events: PlatformEvent[];
let clock: SimClock;
let verdict: VerifyResult;
let verify: ReturnType<typeof vi.fn>;
let publish: ReturnType<typeof vi.fn>;
let deliverAck: (service: string, ack: CommandAck) => void;
let commands: CommandService;

beforeEach(() => {
  store = new Store(':memory:');
  bus = new Bus<PlatformEvent>();
  events = [];
  bus.on((e) => events.push(e));
  clock = new SimClock();
  clock.observe('opg', 1_800_000_000_000);
  verdict = { valid: true, reason: null };
  verify = vi.fn(async () => verdict);
  publish = vi.fn(async () => {});
  const ingest = {
    onAck: (fn: typeof deliverAck) => {
      deliverAck = fn;
    },
    publishCommand: publish,
  } as unknown as Ingest;
  const api = { verify } as unknown as ArlApi;
  commands = new CommandService(testConfig(), store, registryWithTopologies(), ingest, api, bus, clock);
});

afterEach(() => {
  commands.stop();
  vi.useRealTimers();
  store.close();
});

const shed = (overrides: Record<string, unknown> = {}) =>
  commands.send({ service: 'opg', entity: 'global', control: 'shed_load', value: 'non_essential', researcher: 'arl-n0v', ...overrides });

describe('guards', () => {
  it.each([
    [{ service: 'owt' }, 404, 'unknown_service'],
    [{ entity: '  ' }, 400, 'malformed'],
    [{ entity: 'diesel-9' }, 422, 'unknown_target'],
    [{ control: 'self_destruct' }, 422, 'unknown_control'],
    [{ value: 'everything' }, 400, 'invalid_value'],
    [{ researcher: 'x!' }, 400, 'malformed'],
  ])('%j is refused with %i %s before the API is asked', async (overrides, status, error) => {
    const result = await shed(overrides);
    expect(result).toMatchObject({ ok: false, status, error });
    expect(verify).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM command').get()).toEqual({ n: 0 });
  });

  it('applies the control to the entity kinds its topology names', async () => {
    const result = await commands.send({ service: 'rta', entity: 'global', control: 'target', value: 'M31', researcher: 'arl-as3' });
    expect(result).toMatchObject({ ok: false, status: 422, error: 'unknown_control' });
  });
});

describe('the ARL directory decides', () => {
  it("returns the API's own reason and publishes nothing", async () => {
    verdict = { valid: false, reason: 'not_permitted' };
    expect(await shed()).toMatchObject({ ok: false, status: 403, error: 'not_permitted' });
    expect(verify).toHaveBeenCalledWith('arl-n0v', 'opg');
    expect(publish).not.toHaveBeenCalled();
  });

  it('tells an unreachable directory (503) from a refusal', async () => {
    verdict = { valid: false, reason: 'api_unavailable' };
    expect(await shed()).toMatchObject({ ok: false, status: 503, error: 'api_unavailable' });
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('publishing', () => {
  it('sends exactly the spec envelope and stores the row at the service clock', async () => {
    const result = await shed({ researcher: ' ARL-N0V ' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { command } = result;
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith('arl/opg/cmd/global/shed_load', {
      command_id: command.command_id,
      researcher: 'arl-n0v',
      value: 'non_essential',
    });
    expect(command).toMatchObject({ state: 'queued', researcher: 'arl-n0v', sent_ts: 1_800_000_000_000 });
    expect(events.filter((e) => e.kind === 'command')).toHaveLength(1);
  });

  it('marks the row failed when the broker refuses the publish', async () => {
    publish.mockRejectedValueOnce(new Error('client disconnected'));
    expect(await shed()).toMatchObject({ ok: false, status: 503, error: 'broker_unavailable' });
    const row = store.db.prepare('SELECT state, reason FROM command').get();
    expect(row).toEqual({ state: 'failed', reason: 'platform_publish_failed' });
  });
});

describe('acks', () => {
  it('applies the service acks in order up to the terminal one', async () => {
    const sent = await shed();
    if (!sent.ok) throw new Error('send failed');
    const id = sent.command.command_id;
    deliverAck('opg', { command_id: id, state: 'accepted' } as CommandAck);
    deliverAck('opg', { command_id: id, state: 'completed' } as CommandAck);
    expect(store.getCommand(id)).toMatchObject({ state: 'completed' });
    expect(store.getCommand(id)?.settled_ts).not.toBeNull();
  });

  it('records a rejection with its reason', async () => {
    const sent = await shed();
    if (!sent.ok) throw new Error('send failed');
    deliverAck('opg', { command_id: sent.command.command_id, state: 'rejected', reason: 'controls_disabled' } as CommandAck);
    expect(store.getCommand(sent.command.command_id)).toMatchObject({ state: 'rejected', reason: 'controls_disabled' });
  });

  it('ignores an unknown state, an unknown command and a malformed ack without throwing', async () => {
    const sent = await shed();
    if (!sent.ok) throw new Error('send failed');
    const before = events.length;
    deliverAck('opg', { command_id: sent.command.command_id, state: 'exploded' } as unknown as CommandAck);
    deliverAck('opg', { command_id: 'not-ours', state: 'completed' } as CommandAck);
    deliverAck('opg', null as unknown as CommandAck);
    expect(store.getCommand(sent.command.command_id)).toMatchObject({ state: 'queued' });
    expect(events.length).toBe(before);
  });

  it('times out a command no service acknowledges', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const sent = await shed();
    if (!sent.ok) throw new Error('send failed');
    commands.start();
    vi.advanceTimersByTime(60_000);
    expect(store.getCommand(sent.command.command_id)).toMatchObject({ state: 'timeout', reason: 'timeout' });
    expect(events.at(-1)).toMatchObject({ kind: 'command', command: { state: 'timeout' } });
  });
});
