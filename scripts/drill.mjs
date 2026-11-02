#!/usr/bin/env node
// The drill runner (Planning Docs/52 §4.4): one command per drill, from cold to a verdict.
//
//   node scripts/drill.mjs <name|all> [--keep] [--record] [--seed N]
//
// Exit 0 means every assertion held. Artefacts go to .logs/drills/<id>/ whatever the outcome.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  DRILL_PORT,
  DrillContext,
  DrillFailure,
  ROOT,
  ensureBuilt,
  ensureDir,
  healthSampler,
  portInUse,
  say,
  serviceClock,
  stack,
  startPlatform,
  validateScenario,
  wsMonitor,
} from './drills/lib.mjs';

const ORDER = ['storm', 'controls-rta', 'controls-mhe', 'controls-opg', 'faults', 'replay', 'reconcile', 'controls-disabled'];
const RESULTS_DOC = join(ROOT, 'Planning Docs/52-SIMULATOR-HARNESS.md');
const PLACEHOLDER = /^\| — \| \| \| \| \| \| \| \*\(no run recorded yet[^\n]*\n/m;
// Each service's `max_speedup`. Above it the service does not clamp: it exits at start-up and
// compose restarts it in a loop (observed: RTA at 1000x, "speedup_multiplier 1000 is outside 0.1 to 50").
const CEILING = { rta: 50, mhe: 2000, lwm: 500, opg: 500, owt: 500 };

function parseArgs(argv) {
  const args = { names: [], keep: false, record: false, seed: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--keep') args.keep = true;
    else if (a === '--record') args.record = true;
    else if (a === '--seed') args.seed = Number(argv[(i += 1)]);
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else args.names.push(a);
  }
  if (args.names.length === 0) throw new Error(`usage: drill.mjs <${ORDER.join('|')}|all> [--keep] [--record] [--seed N]`);
  if (args.names.includes('all')) args.names = ORDER;
  for (const n of args.names) if (!ORDER.includes(n)) throw new Error(`unknown drill '${n}' (known: ${ORDER.join(', ')})`);
  if (!Number.isInteger(args.seed)) throw new Error('--seed takes an integer');
  return args;
}

const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' }).stdout.trim();
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const fileSize = (p) => (existsSync(p) ? statSync(p).size : 0);

let active = null; // what to tear down if the operator interrupts

async function teardown({ platform, drill, ctx, keep }) {
  await platform?.stop();
  try {
    await drill?.cleanup?.(ctx);
  } catch (error) {
    say(`cleanup failed: ${error.message}`);
  }
  ctx?.close();
  if (!keep && drill?.stack !== false) {
    try {
      stack('down');
    } catch (error) {
      say(`stack down failed: ${error.message}`);
    }
  }
}

let interrupted = false;
process.on('SIGINT', async () => {
  // A second ^C while the first teardown runs must not start another one.
  if (interrupted) return;
  interrupted = true;
  say('interrupted: tearing down');
  if (active) await teardown(active);
  process.exit(130);
});

async function runOne(name, args) {
  const drill = (await import(`./drills/${name}.mjs`)).default;
  const id = `${name}-${stamp()}`;
  const dir = ensureDir(join(ROOT, '.logs/drills', id));
  const dbPath = join(dir, 'arl.sqlite');
  const ctx = new DrillContext({ drill, id, dir, dbPath });
  const services = drill.services;
  const scenario = drill.scenario ?? null;
  const record = {
    drill: name,
    id,
    date: new Date().toISOString(),
    commit: git('rev-parse', '--short', 'HEAD') + (git('status', '--porcelain') ? '+dirty' : ''),
    seed: args.seed,
    startTime: drill.startTime ?? null,
    requestedSpeedup: drill.speedup ?? null,
    effective: {},
    scenario,
    services,
  };
  say(`${id}: ${services.join(',')} seed=${args.seed} speedup=${drill.speedup ?? '-'} start=${drill.startTime ?? '-'} scenario=${scenario ?? 'none'}`);
  say(`artefacts: ${relative(ROOT, dir)}/`);

  let platform = null;
  let health = null;
  let ws = null;
  active = { platform, drill, ctx, keep: args.keep };
  try {
    await ctx.step('preflight', async () => {
      const problems = scenario ? validateScenario(scenario) : [];
      if (drill.crossService && drill.speedup > 50) problems.push(`cross-service drill at ${drill.speedup}x: the rule is ≤ 50 (52 §4.2.1)`);
      for (const svc of drill.startServices ?? services) {
        if ((drill.speedup ?? 1) > CEILING[svc]) problems.push(`${svc} refuses ${drill.speedup}x (its ceiling is ${CEILING[svc]}x); it would exit, not clamp`);
      }
      if (await portInUse(DRILL_PORT)) problems.push(`port ${DRILL_PORT} is in use; the drill platform needs it`);
      if (problems.length) throw new DrillFailure(problems.join('; '), { problems });
      ensureBuilt();
      return { scenario: scenario ?? 'none' };
    });

    const simEnv = {
      ARL_SEED: String(args.seed),
      ARL_SPEEDUP: String(drill.speedup ?? 1),
      ARL_START_TIME: drill.startTime ?? 'now',
      ARL_SCENARIO: scenario ? `/scenarios/${scenario}` : '',
    };
    if (drill.stack !== false) {
      // Broker and API first, the platform next, the simulators last: an event is not retained,
      // and at 200x the first simulated minutes go by before a late subscriber connects.
      await ctx.step('lab up (broker, API)', async () => {
        if (drill.reset) stack('reset');
        stack('infra', [], simEnv);
        return {};
      });
    }

    if (drill.prepare) await ctx.step('prepare', () => drill.prepare(ctx));

    await ctx.step('platform up', async () => {
      const prepared = drill.dbPath ? await drill.dbPath(ctx) : null;
      platform = startPlatform({ dir, dbPath, services, env: drill.platformEnv ?? {} });
      active.platform = platform;
      await ctx.waitFor('the platform to answer', async () => {
        if (platform.exited) throw new Error(`platform exited ${JSON.stringify(platform.exited)}; see platform.log`);
        const h = await ctx.get('/api/health').catch(() => null);
        return h?.status === 200 && (drill.stack === false || h.body.broker === true);
      }, { timeoutMs: 30_000 });
      return { pid: platform.pid, port: DRILL_PORT, db: relative(ROOT, dbPath), seededFrom: prepared };
    });

    const startServices = drill.startServices ?? services;
    if (drill.stack !== false && startServices.length) {
      await ctx.step('simulators up', async () => {
        stack('start', startServices, simEnv);
        for (const svc of startServices) record.effective[svc] = serviceClock(`arl-harness_${svc}_1`)?.speedup ?? null;
        return { effective: record.effective };
      });
    }
    if (drill.afterStart) await ctx.step('after start', () => drill.afterStart(ctx));
    // A drill that starts a service itself (not through compose) reports that service's clock here.
    if (ctx.facts.effective) Object.assign(record.effective, ctx.facts.effective);

    if (drill.gate !== false) {
      await ctx.step('topologies retained', async () => {
        const list = await ctx.waitFor('every service to publish $topology and online', async () => {
          const { body } = await ctx.get('/api/services');
          return body.every((s) => s.topology && s.online === true) ? body : null;
        }, { timeoutMs: 90_000 });
        return Object.fromEntries(list.map((s) => [s.code, `${s.topology.entities} entities v${s.version}`]));
      });
    }

    if (!ctx.failed) {
      health = healthSampler(ctx.http);
      ws = wsMonitor();
      await ws.ready().catch(() => {});
      ctx.ws = ws;
      ctx.health = health;
      await drill.run(ctx);
    }
  } catch (error) {
    // A step records its own failure; reaching here is the runner's own fault.
    ctx.failed = true;
    ctx.steps.push({ name: 'runner', status: 'fail', error: error.message, detail: error.detail ?? { stack: error.stack } });
    say(`runner error: ${error.message}`);
  } finally {
    health?.stop();
    ws?.close();
    await capture(ctx, record, { health, ws, services, dir, dbPath, stackUsed: drill.stack !== false });
    await teardown({ platform, drill, ctx, keep: args.keep });
    active = null;
  }

  const passed = ctx.steps.filter((s) => s.status === 'pass').length;
  const failedStep = ctx.steps.find((s) => s.status === 'fail');
  record.result = failedStep ? `FAIL ${passed}/${ctx.steps.length} at “${failedStep.name}”` : `pass ${passed}/${ctx.steps.length}`;
  writeFileSync(join(dir, 'results.json'), `${JSON.stringify({ ...record, steps: ctx.steps, facts: ctx.facts }, null, 2)}\n`);
  say(`${id}: ${record.result}`);
  say(`artefacts: ${relative(ROOT, dir)}/`);
  if (args.record) appendResult(record, ctx);
  return !failedStep;
}

async function capture(ctx, record, { health, ws, services, dir, dbPath, stackUsed }) {
  const save = (file, value) => writeFileSync(join(dir, file), `${JSON.stringify(value, null, 2)}\n`);
  try {
    const alerts = await ctx.get('/api/alerts?status=all&limit=1000');
    if (alerts.status === 200) save('alerts.json', alerts.body);
    const commands = await ctx.get('/api/commands?limit=500');
    if (commands.status === 200) save('commands.json', commands.body);
    const h = await ctx.get('/api/health');
    if (h.status === 200) save('health.json', h.body);
    record.alertTypes = summariseAlerts(alerts.body?.alerts ?? []);
  } catch {
    record.alertTypes = record.alertTypes ?? '—';
  }
  if (stackUsed) {
    for (const svc of services) {
      const out = spawnSync('podman', ['logs', `arl-harness_${svc}_1`], { encoding: 'utf8' });
      writeFileSync(join(dir, `${svc}.log`), `${out.stdout ?? ''}${out.stderr ?? ''}`);
    }
  }
  record.peakMsgPerS = health?.peak ?? null;
  record.wsPeakDepth = ws?.state.peakDepth ?? null;
  record.dbBytes = fileSize(dbPath) + fileSize(`${dbPath}-wal`);
}

function summariseAlerts(alerts) {
  const seen = new Map();
  for (const a of alerts) seen.set(`${a.service}.${a.type}`, new Set([...(seen.get(`${a.service}.${a.type}`) ?? []), a.severity]));
  return [...seen].map(([k, sev]) => `${k} (${[...sev].join('/')})`).join(', ') || 'none';
}

/** 52 §4.7 is append-only: the first run replaces the placeholder, every later run adds a row. */
function appendResult(record, ctx) {
  const speed = Object.keys(record.effective).length
    ? Object.entries(record.effective).map(([s, v]) => `${s} ${v ?? '?'}×`).join(', ')
    : '— (no stack)';
  const mb = (record.dbBytes / 1_048_576).toFixed(1);
  const result = [
    `**${record.result}**`,
    `alerts: ${record.alertTypes ?? '—'}`,
    `peak ${record.peakMsgPerS ?? '—'} msg/s`,
    `WS peak depth ${record.wsPeakDepth ?? '—'}`,
    `DB ${mb} MB`,
    ...(ctx.facts.note ? [ctx.facts.note] : []),
  ].join('; ');
  const cells = [
    `\`${record.drill}\``,
    record.date.slice(0, 16).replace('T', ' '),
    `\`${record.commit}\``,
    record.seed,
    record.startTime ? `\`${record.startTime}\`` : '—',
    speed,
    record.scenario ? `\`${record.scenario}\`` : '—',
    result.replace(/\|/g, '\\|'),
    `\`.logs/drills/${record.id}/\``,
  ];
  const row = `| ${cells.join(' | ')} |\n`;
  let doc = readFileSync(RESULTS_DOC, 'utf8');
  if (PLACEHOLDER.test(doc)) {
    doc = doc.replace(PLACEHOLDER, row);
  } else {
    const header = doc.indexOf('| Drill | Date | Commit |');
    if (header === -1) throw new Error('52 §4.7 results table not found');
    let end = doc.indexOf('\n\n', header);
    if (end === -1) end = doc.length;
    doc = `${doc.slice(0, end + 1)}${row}${doc.slice(end + 1)}`;
  }
  writeFileSync(RESULTS_DOC, doc);
  say('recorded in Planning Docs/52 §4.7');
}

const args = (() => {
  try {
    return parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
})();

let ok = true;
for (const name of args.names) ok = (await runOne(name, args)) && ok;
process.exit(ok ? 0 : 1);
