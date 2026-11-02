// storm (52 §4.6): one weather event, three services on one clock. What each service does with the
// storm was found by preroll before this drill was written (seed 1, this start, this scenario):
//
//   RTA  wind_stow true at +22:53, the `wind_stow` warning (gust 27 m/s, limit 15), false at +57:31
//   OPG  solar irradiance ~730 W/m² before, ~170 during (from +10, the cloud ahead of the storm),
//        ~860 again from +70; no OPG alert, because the bank carries the shortfall at midday
//   MHE  no visible response: the habitat's power draw and rooms do not see the weather
//
// So the assertions are those three facts in order, each on its own service's clock, plus the
// platform surviving the burst without dropping or failing to parse a message.

import { assert, iso } from './lib.mjs';

const START = '2027-03-02T11:00:00+02:00';
const T0 = Date.parse(START);
const at = (min) => T0 + min * 60_000;
const LONG = { timeoutMs: 300_000 };

export default {
  name: 'storm',
  services: ['rta', 'mhe', 'opg'],
  speedup: 50,
  crossService: true,
  startTime: START,
  scenario: 'drill-storm.toml',

  async run(ctx) {
    const meanIrradiance = (fromMin, toMin) => {
      const row = ctx.db()
        .prepare(
          `SELECT AVG(json_extract(data,'$.irradiance_wm2')) AS mean, COUNT(*) AS n FROM telemetry
            WHERE service='opg' AND entity='solar' AND stream='power' AND ts >= ? AND ts < ?`,
        )
        .get(at(fromMin), at(toMin));
      return { mean: row.mean == null ? null : Math.round(row.mean), n: row.n };
    };
    const stowChanges = () =>
      ctx.db()
        .prepare(`SELECT ts, value FROM state_change WHERE service='rta' AND entity='global' AND item='wind_stow' ORDER BY ts, id`)
        .all()
        .map((r) => ({ ts: r.ts, value: JSON.parse(r.value) }));

    let baseline = null;
    await ctx.step('before the storm: dishes not stowed, the array in sunshine', async () => {
      await ctx.waitSim('opg', at(9), LONG);
      baseline = meanIrradiance(0, 9);
      assert(baseline.n > 0 && baseline.mean > 400, 'no midday irradiance before the storm', baseline);
      const stow = ctx.state('rta', 'global', 'wind_stow');
      assert(stow === false, `wind_stow is ${stow} before the storm`);
      return { irradiance: baseline.mean, frames: baseline.n, wind_stow: stow };
    });

    let engaged = null;
    await ctx.step('wind_stow engages after the storm arrives (+20 min)', async () => {
      engaged = await ctx.waitFor('wind_stow = true', () => stowChanges().find((c) => c.value === true), LONG);
      assert(engaged.ts >= at(20), `wind_stow engaged at ${iso(engaged.ts)}, before the storm`, engaged);
      const alert = await ctx.waitAlert('the wind_stow alert', { service: 'rta', type: 'wind_stow' });
      assert(alert.value > alert.limit_value, 'wind_stow alert value is not above its limit', alert);
      return { atMin: Math.round((engaged.ts - T0) / 60_000), alert: `${alert.severity} ${alert.value}/${alert.limit_value} ${alert.unit ?? ''}`.trim() };
    });

    let storm = null;
    await ctx.step('solar irradiance falls under the storm', async () => {
      await ctx.waitSim('opg', at(50), LONG);
      storm = meanIrradiance(20, 50);
      assert(storm.n > 0, 'no OPG solar frames in the storm window', storm);
      assert(storm.mean < baseline.mean / 2, `irradiance ${storm.mean} is not under half of ${baseline.mean}`, { baseline, storm });
      return { before: baseline.mean, during: storm.mean, frames: storm.n };
    });

    await ctx.step('wind_stow releases before the storm ends (+110 min)', async () => {
      const released = await ctx.waitFor(
        'wind_stow = false after engaging',
        () => stowChanges().find((c) => c.value === false && c.ts > engaged.ts),
        LONG,
      );
      assert(released.ts <= at(110), `wind_stow held until ${iso(released.ts)}`, released);
      const cleared = await ctx.waitAlert('the wind_stow alert to clear', { service: 'rta', type: 'wind_stow', status: 'cleared' });
      return { atMin: Math.round((released.ts - T0) / 60_000), alert: cleared.status };
    });

    await ctx.step('the array recovers after the storm', async () => {
      await ctx.waitSim('opg', at(85), LONG);
      const after = meanIrradiance(75, 85);
      assert(after.n > 0 && after.mean > storm.mean * 2, `irradiance ${after.mean} has not recovered from ${storm.mean}`, { storm, after });
      return { during: storm.mean, after: after.mean };
    });

    await ctx.step('MHE kept reporting through the storm', async () => {
      const row = ctx.db()
        .prepare(`SELECT COUNT(*) AS n FROM telemetry WHERE service='mhe' AND stream='environment' AND ts >= ? AND ts < ?`)
        .get(at(20), at(50));
      assert(row.n > 0, 'no MHE environment frames inside the storm window');
      const alerts = await ctx.alerts({ service: 'mhe' });
      ctx.facts.mheAlerts = alerts.map((a) => `${a.type}:${a.severity}`);
      return { environmentFrames: row.n, alerts: ctx.facts.mheAlerts };
    });

    await ctx.step('the platform took the burst without loss', async () => {
      const { body } = await ctx.get('/api/health');
      assert(body.ingest.dropped === 0 && body.ingest.unparsed === 0, 'ingest dropped or failed to parse messages', body.ingest);
      const { body: services } = await ctx.get('/api/services');
      const offline = services.filter((s) => !s.online).map((s) => s.code);
      assert(offline.length === 0, `offline after the storm: ${offline.join(', ')}`, services);
      return { received: body.ingest.received, dropped: 0, unparsed: 0, gaps: body.ingest.gaps, wsPeakDepth: ctx.ws?.state.peakDepth };
    });
  },
};
