// replay (52 §4.6): played back from the database an earlier drill left, a window releases exactly
// the rows the store holds for it — in time order, none invented, none dropped — with the alert
// events at their own instants, and a seek (forward from cold, or backward mid-play) resumes from
// the cursor without repeating or skipping a row.
//
// No lab: the platform runs on a copy of the source database with the broker pointed at a closed
// port, so nothing live can enter the window while it is compared.

import { copyFileSync, existsSync } from 'node:fs';
import { relative } from 'node:path';
import Database from 'better-sqlite3';
import { ROOT, assert, iso, latestDrillDb } from './lib.mjs';

const SPEED = 64; // the session's own ceiling
const WINDOW_MS = 20 * 60_000;

const parse = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

/** One string per row, the same for a stored row and the frame replay made of it. */
const frameKey = (f) => {
  if (f.kind === 'telemetry') return `t|${f.service}|${f.entity}|${f.stream}|${f.ts}|${f.seq}`;
  if (f.kind === 'state') return `s|${f.service}|${f.entity}|${f.item}|${f.ts}|${JSON.stringify(f.value)}`;
  return `e|${f.service}|${f.name}|${f.ts}|${JSON.stringify(f.payload)}`;
};

function storedKeys(db, services, from, to) {
  const inList = services.map(() => '?').join(',');
  const where = `service IN (${inList}) AND ts BETWEEN ? AND ?`;
  const args = [...services, from, to];
  const keys = [
    ...db.prepare(`SELECT service, entity, stream, ts, seq FROM telemetry WHERE ${where}`).all(...args)
      .map((r) => frameKey({ kind: 'telemetry', ...r })),
    ...db.prepare(`SELECT service, entity, item, ts, value FROM state_change WHERE ${where}`).all(...args)
      .map((r) => frameKey({ kind: 'state', ...r, value: parse(r.value) })),
    ...db.prepare(`SELECT service, kind AS name, ts, payload FROM event WHERE ${where}`).all(...args)
      .map((r) => frameKey({ kind: 'event', ...r, payload: parse(r.payload) })),
  ];
  return keys.sort();
}

function sameMultiset(got, want) {
  const a = [...got].sort();
  if (a.length !== want.length) return `${a.length} frames, ${want.length} stored rows`;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== want[i]) return `first difference: got ${a[i]}, stored ${want[i]}`;
  return null;
}

export default {
  name: 'replay',
  services: ['rta', 'mhe', 'opg'],
  stack: false,
  gate: false,
  // A port nothing listens on: the copy must not grow while it is compared.
  platformEnv: { MQTT_BROKER_PORT: '1' },

  dbPath(ctx) {
    const source = latestDrillDb(ctx.id, ['faults', 'storm']);
    if (!source) throw new Error('no earlier drill database under .logs/drills/ (run `drill.sh faults` first)');
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(source + suffix)) copyFileSync(source + suffix, ctx.dbPath + suffix);
    ctx.facts.source = relative(ROOT, source);
    return ctx.facts.source;
  },

  async run(ctx) {
    const db = new Database(ctx.dbPath, { readonly: true });
    let services = null;
    let window = null;
    let alert = null;

    /** Create a session, watch it, and collect what it sends. `drive` plays it to the end. */
    const session = async (from, to, drive) => {
      const created = await ctx.post('/api/replay', { services, from, to, speed: SPEED });
      assert(created.status === 201, `POST /api/replay → ${created.status}`, created.body);
      const { id } = created.body;
      const log = []; // frames and status snapshots, in the order the socket delivered them
      let ended = null;
      const off = ctx.ws.on((m) => {
        if (m.id !== id) return;
        if (m.type === 'replay-frame') log.push({ frame: m.frame });
        if (m.type === 'replay-status') {
          log.push({ status: m.snapshot });
          if (m.snapshot.status === 'ended') ended = m.snapshot;
        }
      });
      ctx.ws.send({ type: 'watch', id });
      await ctx.waitFor('the watch to be acknowledged', () => log.some((e) => e.status), { timeoutMs: 10_000 });
      await drive(id, log);
      await ctx.waitFor(`replay ${id.slice(0, 8)} to end`, () => ended, { timeoutMs: 120_000 });
      off();
      return { id, log, ended, rows: created.body.rows };
    };
    const play = (id) => ctx.post(`/api/replay/${id}/play`);

    await ctx.step('the source database and a window around an alert', async () => {
      services = db.prepare('SELECT DISTINCT service FROM telemetry ORDER BY service').all().map((r) => r.service);
      assert(services.length > 0, 'the source database has no telemetry', { source: ctx.facts.source });
      // The first alert that escalated: its raise and its escalation both fall in one window.
      alert = db.prepare(
        `SELECT a.alert_id, a.service, a.type, a.entity, a.raised_ts FROM alert a
          WHERE EXISTS (SELECT 1 FROM alert_transition t WHERE t.alert_id = a.alert_id AND t.action = 'escalated')
          ORDER BY a.raised_ts LIMIT 1`,
      ).get() ?? db.prepare('SELECT alert_id, service, type, entity, raised_ts FROM alert ORDER BY raised_ts DESC LIMIT 1').get();
      assert(alert, 'the source database has no alert to centre the window on');
      const range = db.prepare('SELECT MIN(ts) AS a, MAX(ts) AS b FROM telemetry').get();
      const from = Math.max(range.a, alert.raised_ts - WINDOW_MS / 2);
      window = { from, to: Math.min(range.b, from + WINDOW_MS) };
      window.stored = storedKeys(db, services, window.from, window.to);
      assert(window.stored.length > 0, 'nothing stored in the window', window);
      return { source: ctx.facts.source, services, alert: `${alert.type} ${alert.entity}`, from: iso(window.from), to: iso(window.to), rows: window.stored.length };
    });

    let full = null;
    await ctx.step('a full play releases every stored row once, in time order', async () => {
      full = await session(window.from, window.to, (id) => play(id));
      const frames = full.log.filter((e) => e.frame).map((e) => e.frame);
      assert(full.rows === window.stored.length, `the session counted ${full.rows} rows, the store has ${window.stored.length}`);
      const backwards = frames.findIndex((f, i) => i > 0 && f.ts < frames[i - 1].ts);
      assert(backwards === -1, `frame ${backwards} goes back in time`, frames.slice(Math.max(0, backwards - 2), backwards + 1));
      const problem = sameMultiset(frames.map(frameKey), window.stored);
      assert(!problem, `replayed frames differ from the store: ${problem}`);
      assert(frames.every((f) => f.ts >= window.from && f.ts <= window.to), 'a frame outside the window');
      return { frames: frames.length, emitted: full.ended.emitted, kinds: [...new Set(frames.map((f) => f.kind))].join(',') };
    });

    await ctx.step('the alert events sit at their own instants', async () => {
      const frames = full.log.filter((e) => e.frame?.kind === 'event').map((e) => e.frame);
      const mine = frames.filter((f) => f.payload?.alert_id === alert.alert_id);
      assert(mine.length > 0, `no event frame for ${alert.alert_id}`, { events: frames.length });
      assert(mine[0].ts === alert.raised_ts && mine[0].payload.state === 'raised', 'the raise is not at raised_ts', { first: mine[0], raised_ts: alert.raised_ts });
      // Each event frame is released when the cursor reaches it: the status before it never runs ahead.
      let cursor = window.from;
      for (const entry of full.log) {
        if (entry.status) cursor = entry.status.cursor;
        else if (entry.frame.kind === 'event') assert(entry.frame.ts >= cursor, 'an event released behind the cursor', { frame: entry.frame, cursor });
      }
      return { alert: alert.alert_id, transitions: mine.map((f) => `${f.payload.state}@${iso(f.ts).slice(11, 19)}`).join(' ') };
    });

    await ctx.step('a seek before play starts exactly at the target', async () => {
      const mid = Math.round((window.from + window.to) / 2);
      const run = await session(window.from, window.to, async (id) => {
        const s = await ctx.post(`/api/replay/${id}/seek`, { ts: mid });
        assert(s.status === 200 && s.body.cursor === mid, `seek → ${s.status} cursor ${s.body?.cursor}`, s.body);
        await play(id);
      });
      const frames = run.log.filter((e) => e.frame).map((e) => e.frame);
      const problem = sameMultiset(frames.map(frameKey), storedKeys(db, services, mid, window.to));
      assert(!problem, `after the seek: ${problem}`);
      return { target: iso(mid), frames: frames.length };
    });

    await ctx.step('a backward seek mid-play replays from the target without duplicating', async () => {
      const quarter = Math.round(window.from + (window.to - window.from) / 4);
      let seekedAt = null;
      const run = await session(window.from, window.to, async (id, log) => {
        await play(id);
        await ctx.waitFor('half the window to play', () => log.filter((e) => e.frame).length >= window.stored.length / 2, { timeoutMs: 60_000, intervalMs: 50 });
        await ctx.post(`/api/replay/${id}/pause`);
        const s = await ctx.post(`/api/replay/${id}/seek`, { ts: quarter });
        assert(s.status === 200 && s.body.cursor === quarter, `seek → ${s.status}`, s.body);
        // The seek's own status message marks, in socket order, where the replayed part begins.
        await ctx.waitFor('the seek status', () => {
          seekedAt = log.findIndex((e) => e.status?.cursor === quarter && e.status.status === 'paused');
          return seekedAt !== -1;
        }, { timeoutMs: 10_000, intervalMs: 50 });
        await play(id);
      });
      const before = run.log.slice(0, seekedAt).filter((e) => e.frame).length;
      const after = run.log.slice(seekedAt).filter((e) => e.frame).map((e) => e.frame);
      const problem = sameMultiset(after.map(frameKey), storedKeys(db, services, quarter, window.to));
      assert(!problem, `after the backward seek: ${problem}`);
      return { playedBefore: before, target: iso(quarter), framesAfter: after.length };
    });

    db.close();
  },
};
