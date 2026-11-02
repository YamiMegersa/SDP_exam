// reconcile (52 §4.6): every row the platform stored is in the ARL API's own backlog, and the
// counts agree exactly per stream, per entity, per simulated minute — the store is not silently
// lossy. The API subscribes to the same broker independently, so it is the only outside witness.
//
// `reset` first: the backlog volume otherwise holds whatever earlier runs recorded, and a window
// that happens to overlap one of them would compare two runs. The first and last simulated minute
// are excluded (the services' clocks start a few hundred ms apart, and the last minute may still be
// in flight on either side); nothing else is.

import { assert, iso, sleep } from './lib.mjs';

const START = '2027-03-05T00:00:00+02:00';
const T0 = Date.parse(START);
const MINUTES = 75;
const MIN = 60_000;

/** The first two columns are `ts,entity` for every kind; later columns may be quoted JSON. */
function parseCsv(text) {
  const lines = String(text ?? '').trim().split('\n');
  const header = lines.shift()?.split(',') ?? [];
  assert(header[0] === 'ts' && header[1] === 'entity', `unexpected backlog CSV header: ${header.join(',')}`);
  return lines.filter(Boolean).map((l) => {
    const [ts, entity] = l.split(',', 2);
    return { ts: Number(ts), entity };
  });
}

const bucket = (rows, keyOf) => {
  const m = new Map();
  for (const r of rows) m.set(keyOf(r), (m.get(keyOf(r)) ?? 0) + 1);
  return m;
};

function diff(ours, theirs) {
  const out = [];
  for (const k of new Set([...ours.keys(), ...theirs.keys()])) {
    const a = ours.get(k) ?? 0;
    const b = theirs.get(k) ?? 0;
    if (a !== b) out.push({ key: k, platform: a, backlog: b });
  }
  return out;
}

export default {
  name: 'reconcile',
  services: ['rta', 'mhe', 'opg'],
  speedup: 50,
  crossService: true,
  reset: true,
  startTime: START,

  async run(ctx) {
    const from = T0 + MIN;
    const to = T0 + (MINUTES - 1) * MIN;
    const minuteOf = (ts) => Math.floor((ts - T0) / MIN);

    /** One download at a time is the API's rule; a 429 means wait for the previous one. */
    const csv = async (service, query) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const r = await ctx.arl.get(`/v1/backlog/${service}.csv?${new URLSearchParams({ ...query, from: String(from), to: String(to) })}`);
        if (r.status === 200) return parseCsv(r.body);
        if (r.status !== 429) throw new Error(`backlog ${service} ${JSON.stringify(query)} → ${r.status} ${JSON.stringify(r.body)}`);
        await sleep(1000);
      }
      throw new Error(`backlog ${service} stayed busy (429)`);
    };

    await ctx.step(`${MINUTES} simulated minutes on every service`, async () => {
      for (const svc of this.services) await ctx.waitSim(svc, T0 + (MINUTES + 1) * MIN, { timeoutMs: 300_000 });
      return { window: `${iso(from)} … ${iso(to)}` };
    });

    const streams = {};
    await ctx.step('the backlog is not empty', async () => {
      for (const svc of this.services) {
        const { status, body } = await ctx.arl.get(`/v1/backlog/${svc}/streams`);
        assert(status === 200 && body.telemetry?.length > 0, `${svc}: the API recorded no telemetry (was it reset mid-run?)`, body);
        streams[svc] = body;
      }
      return Object.fromEntries(Object.entries(streams).map(([s, b]) => [s, b.telemetry.join(',')]));
    });

    const totals = {};
    for (const svc of this.services) {
      await ctx.step(`${svc}: telemetry counts agree per stream, entity and minute`, async () => {
        const ours = ctx.db()
          .prepare('SELECT stream, entity, ts FROM telemetry WHERE service = ? AND ts >= ? AND ts < ?')
          .all(svc, from, to);
        const platformStreams = [...new Set(ours.map((r) => r.stream))];
        const all = [...new Set([...streams[svc].telemetry, ...platformStreams])].sort();
        const mismatches = [];
        let compared = 0;
        for (const stream of all) {
          const theirs = await csv(svc, { kind: 'telemetry', stream });
          const mine = ours.filter((r) => r.stream === stream);
          compared += mine.length;
          const key = (r) => `${stream}|${r.entity}|+${minuteOf(r.ts)}`;
          mismatches.push(...diff(bucket(mine, key), bucket(theirs, key)));
        }
        totals[svc] = compared;
        assert(compared > 0, `${svc}: the platform stored nothing in the window`);
        assert(mismatches.length === 0, `${svc}: ${mismatches.length} stream/entity/minute counts differ`, mismatches.slice(0, 20));
        return { streams: all.join(','), rows: compared, mismatches: 0 };
      });
    }

    await ctx.step('alert events agree per minute', async () => {
      const out = {};
      for (const svc of this.services) {
        const theirs = await csv(svc, { kind: 'events', event: 'alert' });
        const mine = ctx.db().prepare("SELECT ts FROM event WHERE service = ? AND kind = 'alert' AND ts >= ? AND ts < ?").all(svc, from, to);
        const key = (r) => `+${minuteOf(r.ts)}`;
        const d = diff(bucket(mine, key), bucket(theirs, key));
        assert(d.length === 0, `${svc}: alert event counts differ`, d.slice(0, 20));
        out[svc] = mine.length;
      }
      return out;
    });

    await ctx.step('state items, recorded for comparison', async () => {
      // Observed, not asserted: the API records every state message, the platform its changes.
      const out = {};
      for (const svc of this.services) {
        let backlog = 0;
        for (const item of streams[svc].state ?? []) backlog += (await csv(svc, { kind: 'state', item })).length;
        const platform = ctx.db().prepare('SELECT COUNT(*) AS n FROM state_change WHERE service = ? AND ts >= ? AND ts < ?').get(svc, from, to).n;
        out[svc] = { platform, backlog };
      }
      ctx.facts.state = out;
      ctx.facts.note = `reconciled ${Object.values(totals).reduce((a, b) => a + b, 0)} telemetry rows`;
      return out;
    });
  },
};
