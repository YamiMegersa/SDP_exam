// faults (52 §4.6): the scenario's RTA and MHE faults each reach the platform as the alert the
// specification names, escalate and clear under one alert id, and then carry an operator's
// acknowledgement and resolution with the audit trail in order.
//
// Run at 50x, RTA's ceiling: a service asked for more does not clamp, it exits (52 §4.2.1), and
// one ARL_SPEEDUP reaches every container. MHE's clears (+378, +419) would take another four minutes
// of wall time at 50x, so MHE is asserted to its escalation and the heater fault's raise; the clears
// are what `npm run fixtures` already pins from preroll. The sequence (seed 1, 22:00 start):
//
//   RTA  dish-017 dish_offline +5 → cleared +20 (the repair); availability critical +6 → cleared +76;
//        dish-042 dish_temperature warning +49 → critical +57 → cleared +82
//   MHE  quarters-3 air_concentration warning +57 → critical +97 → cleared +419;
//        quarters-2 room_condition warning +232 → cleared +378

import { assert } from './lib.mjs';

const START = '2027-03-02T22:00:00+02:00';
const LONG = { timeoutMs: 420_000 };

export default {
  name: 'faults',
  services: ['rta', 'mhe'],
  speedup: 50,
  startTime: START,
  scenario: 'drill-faults.toml',

  async run(ctx) {
    const one = async (label, filter) => ctx.waitAlert(label, filter, LONG);
    const transitions = async (id) => (await ctx.get(`/api/alerts/${encodeURIComponent(id)}`)).body.transitions.map((t) => t.action);

    /** Raised at `first`, escalated to `then` under the same id, and cleared if `cleared`. */
    const escalates = async (service, type, entity, first, then, { cleared = true } = {}) => {
      const label = `${service} ${type} ${entity} to ${cleared ? 'clear' : 'escalate'}`;
      const found = await ctx.waitFor(label, async () => {
        const [a] = await ctx.alerts({ service, type, entity, ...(cleared ? { status: 'cleared' } : { severity: then }) });
        return a;
      }, LONG);
      const { body } = await ctx.get(`/api/alerts/${encodeURIComponent(found.alert_id)}`);
      const actions = body.transitions.map((t) => t.action);
      // `raised` carries the service's severity in its payload; `escalated` records it as to_status.
      const severities = body.transitions
        .map((t) => (t.action === 'escalated' ? t.to_status : t.action === 'raised' ? t.payload?.severity : null))
        .filter(Boolean);
      assert(actions[0] === 'raised' && actions.includes('escalated'), `${type} ran ${actions.join(' > ')}`, body.transitions);
      if (cleared) assert(actions.at(-1) === 'cleared', `${type} ran ${actions.join(' > ')}`, body.transitions);
      assert(severities[0] === first && severities.includes(then), `${type} severities ${severities.join(' > ')}`, body.transitions);
      const all = await ctx.alerts({ service, type, entity });
      assert(all.length === 1, `${all.length} alert rows for one ${type} condition`, all);
      return { id: found.alert_id, actions: actions.join('>'), severities: [...new Set(severities)].join('>') };
    };

    await ctx.step('RTA: dish-017 goes offline and clears after the repair', async () => {
      const a = await one('dish_offline dish-017 to clear', { service: 'rta', type: 'dish_offline', entity: 'dish-017', status: 'cleared' });
      return { severity: a.severity, minutes: Math.round((a.cleared_ts - a.raised_ts) / 60_000) };
    });

    await ctx.step('RTA: array availability falls critical', async () => {
      const a = await one('availability', { service: 'rta', type: 'availability' });
      assert(a.severity === 'critical' && a.value < a.limit_value, 'availability is not a critical shortfall', a);
      return { severity: a.severity, value: a.value, limit: a.limit_value, status: a.status };
    });

    let overheat = null;
    await ctx.step('RTA: dish-042 dish_temperature escalates warning → critical and clears', async () => {
      overheat = await escalates('rta', 'dish_temperature', 'dish-042', 'warning', 'critical');
      return overheat;
    });

    const ack = (researcher) => ctx.post(`/api/alerts/${encodeURIComponent(overheat.id)}/acknowledge`, { researcher, note: 'drill' });
    const resolve = (researcher, resolution) =>
      ctx.post(`/api/alerts/${encodeURIComponent(overheat.id)}/resolve`, { researcher, resolution, cause: 'scenario overheat' });

    await ctx.step('acknowledge and resolve are refused out of turn', async () => {
      const unknown = await ack('arl-zzz');
      assert(unknown.status === 403 && unknown.body.error === 'unknown_researcher', `unknown code: ${unknown.status} ${unknown.body?.error}`, unknown.body);
      const early = await resolve('arl-as3', 'dish cooled');
      assert(early.status === 409 && early.body.error === 'alert_not_acknowledged', `resolve before ack: ${early.status} ${early.body?.error}`, early.body);
      const short = await resolve('arl-as3', 'ok');
      assert(short.status === 400 && short.body.error === 'invalid_resolution', `short resolution: ${short.status} ${short.body?.error}`, short.body);
      return { unknown: unknown.status, early: early.body.error, short: short.body.error };
    });

    await ctx.step('acknowledge once, then resolve once', async () => {
      const first = await ack('arl-as3');
      assert(first.status === 200 && first.body.alert.ack_by === 'arl-as3', `ack: ${first.status}`, first.body);
      const again = await ack('arl-f2l');
      assert(again.status === 409 && again.body.error === 'alert_already_acknowledged', `second ack: ${again.status} ${again.body?.error}`, again.body);
      const done = await resolve('arl-as3', 'dish-042 cooled after the scenario overheat ended');
      assert(done.status === 200 && done.body.alert.resolved_ts, `resolve: ${done.status}`, done.body);
      const twice = await resolve('arl-as3', 'again');
      assert(twice.status === 409 && twice.body.error === 'alert_already_resolved', `second resolve: ${twice.status} ${twice.body?.error}`, twice.body);
      return { ack: first.status, secondAck: again.body.error, resolve: done.status, secondResolve: twice.body.error };
    });

    await ctx.step('the audit trail reads raised > escalated > cleared > acknowledged > resolved', async () => {
      const actions = await transitions(overheat.id);
      const expected = ['raised', 'escalated', 'cleared', 'acknowledged', 'resolved'];
      assert(JSON.stringify(actions) === JSON.stringify(expected), `trail is ${actions.join(' > ')}`, actions);
      return { trail: actions.join('>') };
    });

    await ctx.step('MHE: air_concentration on quarters-3 escalates under one id', () =>
      escalates('mhe', 'air_concentration', 'quarters-3', 'warning', 'critical', { cleared: false }));

    await ctx.step('MHE: the quarters-2 heater fault raises room_condition', async () => {
      const a = await one('room_condition quarters-2', { service: 'mhe', type: 'room_condition', entity: 'quarters-2' });
      assert(a.value < a.limit_value, 'room_condition is not below its temperature limit', a);
      return { severity: a.severity, value: a.value, limit: a.limit_value, status: a.status };
    });
  },
};
