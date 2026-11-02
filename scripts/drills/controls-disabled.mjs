// controls-disabled (52 §4.6): with control turned off on the service itself, every one of OPG's
// controls is still sent (the platform cannot know in advance) and every one comes back
// `rejected / controls_disabled` — recorded as such, not as completed and not as a timeout.
//
// The compose file passes no ARL_CONTROL_ENABLED, so OPG runs here as the bundled binary with
// `--control-enabled false` against the compose broker and API; the containerised OPG is not started.

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { ROOT, assert } from './lib.mjs';

const SIM = join(ROOT, 'Services/arl-sim');
const START = '2027-03-02T22:00:00+02:00';
const SPEEDUP = 50;

// One valid value per control, so the only reason left to refuse it is the switch.
const CONTROLS = [
  ['global', 'generation_priority', 'battery_first'],
  ['global', 'load_shed', false],
  ['solar', 'enable_solar_array', true],
  ['batteries', 'battery_reserve', 30],
  ['diesel', 'start_generator', true],
  ['diesel', 'stop_generator', true],
];

let child = null;

export default {
  name: 'controls-disabled',
  services: ['opg'],
  startServices: [], // broker and API only; OPG is the binary below
  speedup: SPEEDUP,
  startTime: START,

  async afterStart(ctx) {
    const log = createWriteStream(join(ctx.dir, 'opg-binary.log'));
    child = spawn(
      join(SIM, 'bin/arl-opg'),
      ['--config', 'config/opg.toml', '--control-enabled', 'false', '--seed', '1', '--speedup', String(SPEEDUP), '--start-time', START],
      {
        cwd: SIM,
        env: {
          PATH: process.env.PATH,
          RUST_LOG: 'info',
          MQTT_BROKER_ADDRESS: 'localhost',
          MQTT_BROKER_PORT: '1883',
          ARL_API_ADDRESS: 'localhost',
          ARL_API_PORT: '8080',
          HEALTH_PORT: '9105',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert(child.exitCode === null, `arl-opg exited ${child.exitCode} at start-up; see opg-binary.log`);
    return { pid: child.pid, args: '--control-enabled false' };
  },

  async run(ctx) {
    const reasons = {};
    for (const [entity, control, value] of CONTROLS) {
      await ctx.step(`${control} is rejected with controls_disabled`, async () => {
        const sent = await ctx.command('opg', entity, control, value, 'arl-n0v');
        assert(sent.status === 202, `the platform refused it itself (${sent.status}); it should have been sent`, sent.body);
        const { row, states, acks } = await ctx.settle(sent.body.command_id, { timeoutMs: 30_000 });
        const last = acks.at(-1);
        assert(row.state === 'rejected', `ended ${row.state}, not rejected`, { row, states });
        assert(last?.reason === 'controls_disabled', `rejected for ${last?.reason}`, { acks });
        assert(!states.includes('completed') && !states.includes('in_progress'), 'acted on despite the switch', { states });
        reasons[control] = `${states.join('>')} (${last.reason})`;
        return { acks: reasons[control] };
      });
    }

    await ctx.step('the service is still online and reporting', async () => {
      const { body } = await ctx.get('/api/services');
      const opg = body.find((s) => s.code === 'opg');
      assert(opg?.online === true, 'opg went offline', opg);
      const power = ctx.latest('opg', 'global', 'power');
      assert(power, 'no global power telemetry stored');
      ctx.facts.note = `${Object.keys(reasons).length}/6 OPG controls rejected/controls_disabled`;
      return { online: opg.online, last_ts: power.ts };
    });
  },

  async cleanup() {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5000);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    child = null;
  },
};
