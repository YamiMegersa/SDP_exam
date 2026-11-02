// controls-mhe (52 §4.6): sealing an occupied room is what raises its CO2 — the scenario is empty —
// and a crew wellness check completes, with `needs_support` taken as a result, not a failure.

import { assert } from './lib.mjs';

export default {
  name: 'controls-mhe',
  services: ['mhe'],
  speedup: 1000,
  startTime: '2027-03-02T22:00:00+02:00',
  scenario: 'drill-mhe-seal.toml',

  async run(ctx) {
    await ctx.step('an rta/opg-only researcher is refused', async () => {
      const r = await ctx.command('mhe', 'quarters-1', 'seal_room', true, 'arl-n0v');
      assert(r.status === 403 && r.body.error === 'not_permitted', `got ${r.status} ${r.body?.error}`, r.body);
      return { status: r.status, error: r.body.error };
    });

    await ctx.step('a setpoint outside 285–300 K is refused', async () => {
      const r = await ctx.command('mhe', 'quarters-1', 'adjust_temperature', 400, 'arl-as3');
      assert(r.status === 400 && r.body.error === 'invalid_value', `got ${r.status} ${r.body?.error}`, r.body);
      return { status: r.status, detail: r.body.detail };
    });

    let room = null;
    let baseline = null;
    await ctx.step('an occupied quarters is found', async () => {
      const found = await ctx.waitFor('a quarters with crew in it', () => {
        const rows = ctx.db()
          .prepare(
            `SELECT entity, json_extract(data,'$.crew_count') AS crew, json_extract(data,'$.co2_ppm') AS co2, ts
               FROM telemetry t WHERE service='mhe' AND stream='environment' AND entity LIKE 'quarters-%'
                AND id = (SELECT MAX(id) FROM telemetry WHERE service='mhe' AND stream='environment' AND entity = t.entity)
              ORDER BY entity`,
          )
          .all();
        return rows.find((r) => r.crew > 0 && r.co2 < 1200);
      });
      room = found.entity;
      baseline = found.co2;
      return { room, crew: found.crew, co2: baseline };
    });

    let sealedAt = null;
    await ctx.step('seal_room completes and the room reports sealed', async () => {
      const sealed = await ctx.sendAndSettle('mhe', room, 'seal_room', true, 'arl-as3');
      assert(sealed.row.state === 'completed', `seal_room ended ${sealed.row.state}`, sealed.row);
      sealedAt = ctx.simNow('mhe');
      await ctx.waitFor('state sealed=true', () => ctx.state('mhe', room, 'sealed') === true, { timeoutMs: 30_000 });
      return { acks: sealed.states.join('>'), sealed: true };
    });

    await ctx.step('CO2 rises in the sealed room', async () => {
      const peak = await ctx.waitFor('CO2 to rise 300 ppm', () => {
        const now = ctx.latest('mhe', room, 'environment');
        return now && now.ts > sealedAt && now.co2_ppm - baseline > 300 ? now : null;
      });
      return { from: baseline, to: peak.co2_ppm, crew: peak.crew_count };
    });

    await ctx.step('air_concentration is raised on that room', async () => {
      const alert = await ctx.waitAlert('air_concentration', { service: 'mhe', type: 'air_concentration', entity: room });
      assert(alert.raised_ts >= sealedAt, 'the alert predates the seal', alert);
      return { severity: alert.severity, value: alert.value, limit: alert.limit_value, sealed: alert.metadata?.sealed };
    });

    await ctx.step('unsealing completes and CO2 comes back down', async () => {
      const opened = await ctx.sendAndSettle('mhe', room, 'seal_room', false, 'arl-as3');
      assert(opened.row.state === 'completed', `seal_room false ended ${opened.row.state}`, opened.row);
      const peak = ctx.latest('mhe', room, 'environment').co2_ppm;
      const fallen = await ctx.waitFor('CO2 to fall', () => {
        const now = ctx.latest('mhe', room, 'environment');
        return now && now.co2_ppm < peak - 200 ? now : null;
      });
      return { peak, now: fallen.co2_ppm };
    });

    await ctx.step('crew_wellness_check runs in_progress and completes', async () => {
      const check = await ctx.sendAndSettle('mhe', 'crew-1', 'crew_wellness_check', true, 'arl-as3', { timeoutMs: 120_000 });
      assert(check.row.state === 'completed', `crew_wellness_check ended ${check.row.state}`, check.row);
      assert(check.states.includes('in_progress'), 'no in_progress ack before the result', check.states);
      assert(['ok', 'needs_support'].includes(check.row.detail), `unexpected result ${check.row.detail}`, check.row);
      return { acks: check.states.join('>'), result: check.row.detail };
    });
  },
};
