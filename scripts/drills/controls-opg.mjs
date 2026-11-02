// controls-opg (52 §4.6): a bank set to 25 % at night, then the order the service reports it in —
// low_battery, the shortfall, diesel taking over — and two operator controls on top.
//
// What the reserve crossing looks like was found by preroll before this drill was written: the
// service raises `low_battery` (warning, limit 30 %), then `supply_shortfall` (critical) while the
// bank is held at its reserve, then `backup_active` as the generators start, and the shortfall
// clears once they carry the load. There is no separate "critical at the reserve" alert.

import { assert } from './lib.mjs';

export default {
  name: 'controls-opg',
  services: ['opg'],
  speedup: 200,
  startTime: '2027-03-02T22:00:00+02:00',
  scenario: 'drill-opg-reserve.toml',

  async run(ctx) {
    await ctx.step('an rta/mhe-only researcher is refused', async () => {
      const r = await ctx.command('opg', 'batteries', 'battery_reserve', 30, 'arl-as3');
      assert(r.status === 403 && r.body.error === 'not_permitted', `got ${r.status} ${r.body?.error}`, r.body);
      return { status: r.status, error: r.body.error };
    });

    await ctx.step('a reserve above 80 % is refused', async () => {
      const r = await ctx.command('opg', 'batteries', 'battery_reserve', 90, 'arl-n0v');
      assert(r.status === 400 && r.body.error === 'invalid_value', `got ${r.status} ${r.body?.error}`, r.body);
      return { status: r.status, detail: r.body.detail };
    });

    const first = async (type) => (await ctx.alerts({ service: 'opg', type })).sort((a, b) => a.raised_ts - b.raised_ts)[0];

    await ctx.step('low_battery, then supply_shortfall, then backup_active', async () => {
      const low = await ctx.waitAlert('low_battery', { service: 'opg', type: 'low_battery' });
      const backup = await ctx.waitAlert('backup_active', { service: 'opg', type: 'backup_active' });
      const shortfall = await first('supply_shortfall');
      assert(shortfall, 'no supply_shortfall before the generators started');
      assert(low.raised_ts < shortfall.raised_ts, 'supply_shortfall came before low_battery', { low, shortfall });
      assert(shortfall.raised_ts <= backup.raised_ts, 'backup_active came before the shortfall', { shortfall, backup });
      ctx.facts.sequence = { low: low.raised_ts, shortfall: shortfall.raised_ts, backup: backup.raised_ts };
      return {
        low_battery: `${low.severity} ${low.value}/${low.limit_value}`,
        shortfall: shortfall.severity,
        backup: backup.severity,
        minutesLowToBackup: Math.round((backup.raised_ts - low.raised_ts) / 60_000),
      };
    });

    await ctx.step('the shortfall clears once diesel carries the load', async () => {
      const cleared = await ctx.waitFor('supply_shortfall to clear', async () => {
        const s = await first('supply_shortfall');
        return s?.status === 'cleared' ? s : null;
      });
      const diesel = ctx.latest('opg', 'diesel', 'power');
      return { clearedAfterMin: Math.round((cleared.cleared_ts - cleared.raised_ts) / 60_000), diesel_w: diesel?.power_output_w, status: diesel?.generator_status };
    });

    await ctx.step('stop_generator completes and diesel output falls to zero', async () => {
      const before = ctx.simNow('opg');
      const stop = await ctx.sendAndSettle('opg', 'diesel', 'stop_generator', true, 'arl-n0v');
      assert(stop.row.state === 'completed', `stop_generator ended ${stop.row.state}`, stop.row);
      const off = await ctx.waitFor('diesel output 0', () => {
        const d = ctx.latest('opg', 'diesel', 'power');
        return d && d.ts > before && d.power_output_w === 0 ? d : null;
      });
      return { acks: stop.states.join('>'), status: off.generator_status };
    });

    await ctx.step('what follows the manual stop is recorded', async () => {
      // Observed, not asserted: the bank is at its reserve, so the load has nowhere to go.
      const stoppedAt = ctx.simNow('opg');
      await ctx.waitSim('opg', stoppedAt + 30 * 60_000);
      const after = (await ctx.alerts({ service: 'opg' })).filter((a) => (a.last_ts ?? a.raised_ts) >= stoppedAt);
      const global = ctx.latest('opg', 'global', 'power');
      ctx.facts.afterStop = after.map((a) => `${a.type}:${a.severity}:${a.status}`);
      return { alerts: ctx.facts.afterStop, supply_mode: global?.supply_mode, load_w: global?.total_load_w, gen_w: global?.total_generation_w };
    });

    await ctx.step('battery_reserve 30 completes and the state reads 30', async () => {
      const set = await ctx.sendAndSettle('opg', 'batteries', 'battery_reserve', 30, 'arl-n0v');
      assert(set.row.state === 'completed', `battery_reserve ended ${set.row.state}`, set.row);
      const value = await ctx.waitFor('reserve_pct = 30', () => (ctx.state('opg', 'batteries', 'reserve_pct') === 30 ? 30 : null), { timeoutMs: 30_000 });
      return { acks: set.states.join('>'), reserve_pct: value };
    });
  },
};
