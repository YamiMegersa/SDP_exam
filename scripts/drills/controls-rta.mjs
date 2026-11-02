// controls-rta (52 §4.6): the platform's refusals first, then set_target → start_scan → raster →
// cancel_scan, with every ack sequence checked for order. Night start, so the sky has a choice.

import { assert, elevation, iso } from './lib.mjs';

const DEG = Math.PI / 180;

export default {
  name: 'controls-rta',
  services: ['rta'],
  speedup: 50,
  startTime: '2027-03-02T22:00:00+02:00',
  scenario: 'drill-rta-scan.toml',

  async run(ctx) {
    const refused = async (label, body, status, error) =>
      ctx.step(label, async () => {
        const r = await ctx.command(body.service ?? 'rta', body.entity, body.control, body.value, body.researcher);
        assert(r.status === status && r.body?.error === error, `expected ${status} ${error}, got ${r.status} ${r.body?.error}`, r.body);
        return { status: r.status, error: r.body.error };
      });

    await refused('mhe-only researcher is refused', { entity: 'main', control: 'start_scan', value: true, researcher: 'arl-e8r' }, 403, 'not_permitted');
    await refused('defunct researcher is refused', { entity: 'main', control: 'start_scan', value: true, researcher: 'arl-k9q' }, 403, 'defunct');
    await refused('unknown researcher is refused', { entity: 'main', control: 'start_scan', value: true, researcher: 'arl-zzz' }, 403, 'unknown');
    await refused('out-of-range frequency is refused', { entity: 'main', control: 'set_observation_frequency', value: 1e8, researcher: 'arl-as3' }, 400, 'invalid_value');
    await refused('unknown dish is refused', { entity: 'dish-999', control: 'stow_dish', value: true, researcher: 'arl-as3' }, 422, 'unknown_target');
    await refused('unknown control is refused', { entity: 'main', control: 'explode', value: true, researcher: 'arl-as3' }, 422, 'unknown_control');
    await ctx.step('no refused command reached the broker', async () => {
      const { body } = await ctx.get('/api/commands?limit=500');
      assert(body.length === 0, `${body.length} commands were published`, body);
      return { published: 0 };
    });

    const { body: targets } = await ctx.get('/api/targets');
    const asTarget = (t) => ({ ra_rad: t.ra_rad, dec_rad: t.dec_rad, fov_rad: t.fov_rad });

    await ctx.step('a target below 15° is set but cannot be scanned', async () => {
      const low = targets.find((t) => t.id === 'tgt-cas');
      assert(low, 'tgt-cas is not in the catalogue', targets);
      const now = ctx.simNow('rta');
      const elev = elevation(low, now) / DEG;
      assert(elev < 15, `tgt-cas is at ${elev.toFixed(1)}° at ${iso(now)}; pick another low target`);
      const set = await ctx.sendAndSettle('rta', 'main', 'set_target', asTarget(low), 'arl-as3');
      assert(set.row.state === 'completed', `set_target ended ${set.row.state}`, set.row);
      const scan = await ctx.sendAndSettle('rta', 'main', 'start_scan', true, 'arl-as3');
      assert(scan.row.state === 'rejected', `start_scan below the horizon ended ${scan.row.state}`, scan.row);
      return { elevationDeg: Number(elev.toFixed(1)), set: set.states.join('>'), scan: scan.states.join('>'), reason: scan.row.reason, detail: scan.row.detail };
    });

    let scanId = null;
    let sinceTs = 0;
    await ctx.step('the highest target is set and a scan starts', async () => {
      const now = ctx.simNow('rta');
      const best = targets
        .map((t) => ({ t, elev: elevation(t, now) / DEG }))
        .sort((a, b) => b.elev - a.elev)[0];
      assert(best.elev > 20, `no catalogue target is above 20° at ${iso(now)}`, { best });
      ctx.facts.target = { id: best.t.id, elevationDeg: Number(best.elev.toFixed(1)) };
      const set = await ctx.sendAndSettle('rta', 'main', 'set_target', asTarget(best.t), 'arl-as3');
      assert(set.row.state === 'completed', `set_target ended ${set.row.state}`, set.row);
      sinceTs = ctx.simNow('rta');
      const scan = await ctx.sendAndSettle('rta', 'main', 'start_scan', true, 'arl-as3');
      assert(scan.row.state === 'completed', `start_scan ended ${scan.row.state}`, scan.row);
      scanId = scan.row.detail;
      assert(scanId, 'start_scan completed without a scan id in its detail', scan.row);
      return { target: best.t.id, elevationDeg: Number(best.elev.toFixed(1)), scanId, acks: scan.states.join('>') };
    });

    await ctx.step('the scan publishes started, fills the raster and completes', async () => {
      const done = await ctx.waitFor('the scan to complete', () =>
        ctx.events('rta', 'scan', sinceTs).find((e) => e.payload.scan_id === scanId && ['completed', 'failed', 'cancelled'].includes(e.payload.event)),
      { timeoutMs: 180_000 });
      const lifecycle = ctx.events('rta', 'scan', sinceTs).filter((e) => e.payload.scan_id === scanId).map((e) => e.payload.event);
      assert(lifecycle[0] === 'started', `the first scan event was ${lifecycle[0]}`, lifecycle);
      assert(done.payload.event === 'completed', `the scan ended ${done.payload.event}`, done.payload);
      const samples = ctx.db()
        .prepare("SELECT COUNT(*) AS n, COUNT(DISTINCT entity) AS dishes FROM telemetry WHERE service='rta' AND stream='scan' AND json_extract(data,'$.scan_id') = ?")
        .get(scanId);
      assert(samples.n > 0, 'no scan-stream samples carry the scan id');
      const started = ctx.events('rta', 'scan', sinceTs).find((e) => e.payload.scan_id === scanId && e.payload.event === 'started');
      const grid = started.payload.grid_size ?? 128;
      const overlap = started.payload.overlap ?? 3;
      ctx.facts.raster = { samples: samples.n, dishes: samples.dishes, grid, overlap };
      // N² pixels with k samples each; the platform must have stored at least the raster once.
      assert(samples.n >= grid * grid, `${samples.n} samples cannot fill a ${grid}×${grid} raster`, ctx.facts.raster);
      return { lifecycle: lifecycle.join('>'), ...ctx.facts.raster };
    });

    await ctx.step('a second scan is cancelled while it runs', async () => {
      const since = ctx.simNow('rta');
      const scan = await ctx.sendAndSettle('rta', 'main', 'start_scan', true, 'arl-as3');
      assert(scan.row.state === 'completed', `start_scan ended ${scan.row.state}`, scan.row);
      const cancel = await ctx.sendAndSettle('rta', 'main', 'cancel_scan', true, 'arl-as3');
      assert(cancel.row.state === 'completed', `cancel_scan ended ${cancel.row.state}`, cancel.row);
      const ended = await ctx.waitFor('the cancelled event', () =>
        ctx.events('rta', 'scan', since).find((e) => e.payload.scan_id === scan.row.detail && e.payload.event !== 'started'));
      assert(ended.payload.event === 'cancelled', `the scan ended ${ended.payload.event}`, ended.payload);
      await ctx.waitFor('scan_state to leave running', () => ctx.state('rta', 'main', 'scan_state') !== 'running', { timeoutMs: 30_000 });
      return { scanId: scan.row.detail, cancel: cancel.states.join('>'), event: ended.payload.event, scanState: ctx.state('rta', 'main', 'scan_state') };
    });

    await ctx.step('cancelling with nothing to cancel is rejected by the service', async () => {
      const cancel = await ctx.sendAndSettle('rta', 'main', 'cancel_scan', true, 'arl-as3');
      assert(cancel.row.state === 'rejected', `cancel_scan when idle ended ${cancel.row.state}`, cancel.row);
      return { reason: cancel.row.reason, detail: cancel.row.detail };
    });
  },
};
