#!/usr/bin/env node
// Contract fixtures from the simulator's own `preroll` (Planning Docs/52 §4.5.1, 51 §2.3).
//
//   npm run fixtures            regenerate server/test/fixtures/<svc>.{topology,samples}.json
//   npm run fixtures -- --check exit 1 if a regeneration would change any committed file
//
// `preroll` runs a bounded simulated window without delays and publishes nothing, so this needs
// neither the broker nor the API. Same binary, seed, start time and scenario => same bytes.
// The only container use is copying RTA's site map and sky images out of arl/rta:0.1.0 once.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIM = join(ROOT, 'Services/arl-sim');
const WORK = join(ROOT, '.logs/harness');
const OUT = join(ROOT, 'server/test/fixtures');
const MAX_BYTES = 50_000;
const SEED = 1;

// One window per service, chosen so the scenario's faults have produced (and cleared) their
// alerts by the end. drill-faults is written for a 22:00 start (see the file's comments).
const WINDOWS = {
  rta: { start: '2027-03-02T22:00:00+02:00', end: '2027-03-03T00:00:00+02:00', scenario: 'drill-faults.toml' },
  mhe: { start: '2027-03-02T22:00:00+02:00', end: '2027-03-03T06:00:00+02:00', scenario: 'drill-faults.toml' },
  opg: { start: '2027-03-02T22:00:00+02:00', end: '2027-03-03T00:00:00+02:00', scenario: 'drill-opg-reserve.toml' },
};

const check = process.argv.includes('--check');
const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const services = only.length ? only : Object.keys(WINDOWS);

mkdirSync(WORK, { recursive: true });
mkdirSync(OUT, { recursive: true });

function rtaConfig() {
  const assets = join(WORK, 'assets');
  if (!existsSync(join(assets, 'arl.geojson'))) {
    console.log('[fixtures] copying /assets out of arl/rta:0.1.0');
    const id = execFileSync('podman', ['create', 'arl/rta:0.1.0'], { encoding: 'utf8' }).trim();
    try {
      execFileSync('podman', ['cp', `${id}:/assets`, WORK]);
    } finally {
      execFileSync('podman', ['rm', id], { stdio: 'ignore' });
    }
  }
  const path = join(WORK, 'rta.toml');
  writeFileSync(path, readFileSync(join(SIM, 'config/rta.toml'), 'utf8').replaceAll('"/assets', `"${assets}`));
  return path;
}

function preroll(svc) {
  const w = WINDOWS[svc];
  const config = svc === 'rta' ? rtaConfig() : join(SIM, `config/${svc}.toml`);
  const out = join(WORK, `${svc}.ndjson`);
  execFileSync(
    join(SIM, `bin/arl-${svc}`),
    ['--config', config, '--seed', String(SEED), '--start-time', w.start, '--scenario', join(SIM, 'scenarios', w.scenario),
      'preroll', '--from', w.start, '--to', w.end, '--out', out],
    {
      cwd: SIM,
      // Preroll publishes nothing; the addresses only have to parse. HEALTH_PORT keeps it off 9100.
      env: { PATH: process.env.PATH, MQTT_BROKER_ADDRESS: 'localhost', ARL_API_ADDRESS: 'localhost', HEALTH_PORT: '0', RUST_LOG: 'warn' },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  return readFileSync(out, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

const hasNull = (payload) => Object.values(payload).some((v) => v === null);

/** Slice a preroll into the smallest set that still exercises every shape the service publishes. */
function sample(svc, messages) {
  const topology = messages.find((m) => m.topic === `arl/${svc}/$topology`);
  if (!topology) throw new Error(`${svc}: preroll has no $topology`);

  // Telemetry is keyed by the topology's own stream pattern (`+/telemetry/normal`,
  // `solar/telemetry/power`): several entities can share a stream name with different fields.
  const patterns = topology.payload.streams.map((s) => ({
    key: s.topic.slice(`arl/${svc}/`.length),
    re: new RegExp(`^${s.topic.replaceAll('$', '\\$').replaceAll('+', '[^/]+')}$`),
    enums: s.fields.filter((f) => f.type === 'enum').map((f) => f.key),
  }));
  const telemetry = new Map(patterns.map((p) => [p.key, []]));
  const state = new Map();
  const events = new Map();
  for (const m of messages) {
    const parts = m.topic.split('/');
    if (parts[2] === 'events') {
      const p = m.payload;
      const key =
        parts[3] === 'alert' ? `alert:${p.type}:${p.severity}:${p.state}` : `${parts[3]}:${p.name ?? p.event ?? p.kind ?? ''}`;
      if (!events.has(key)) events.set(key, m);
    } else if (parts[3] === 'telemetry') {
      const pattern = patterns.find((p) => p.re.test(m.topic));
      if (!pattern) throw new Error(`${svc}: ${m.topic} matches no stream in $topology`);
      telemetry.get(pattern.key).push(m);
    } else if (parts[3] === 'state') {
      const key = parts[4];
      if (!state.has(key)) state.set(key, m);
    }
  }

  // Per stream: the first frame, the first carrying a null, the first whose enum fields differ
  // from the first frame's (a fault code, a supply mode), and the last.
  const frames = {};
  for (const [stream, list] of [...telemetry].sort(([a], [b]) => a.localeCompare(b))) {
    if (!list.length) continue;
    const { enums } = patterns.find((p) => p.key === stream);
    const differs = (m) => enums.some((k) => m.payload[k] !== list[0].payload[k]);
    const picks = [list[0], list.find((m) => hasNull(m.payload)), list.find(differs), list[list.length - 1]];
    frames[stream] = [...new Set(picks.filter(Boolean))].map((m) => ({ topic: m.topic, payload: m.payload }));
  }
  const pick = (map) =>
    Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b)).map(([k, m]) => [k, { topic: m.topic, retain: m.retain, payload: m.payload }]));

  const w = WINDOWS[svc];
  return {
    topology: topology.payload,
    samples: {
      source: { service: svc, seed: SEED, from: w.start, to: w.end, scenario: w.scenario, messages: messages.length },
      telemetry: frames,
      state: pick(state),
      events: pick(events),
    },
  };
}

let changed = 0;
for (const svc of services) {
  if (!WINDOWS[svc]) throw new Error(`unknown service '${svc}'`);
  const { topology, samples } = sample(svc, preroll(svc));
  for (const [name, body] of [[`${svc}.topology.json`, topology], [`${svc}.samples.json`, samples]]) {
    const text = `${JSON.stringify(body, null, 2)}\n`;
    const path = join(OUT, name);
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error(`${name} is ${Buffer.byteLength(text)} bytes (limit ${MAX_BYTES})`);
    const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
    if (before === text) {
      console.log(`[fixtures] ${name}: unchanged (${Buffer.byteLength(text)} B)`);
      continue;
    }
    changed += 1;
    if (check) {
      console.log(`[fixtures] ${name}: WOULD CHANGE`);
    } else {
      writeFileSync(path, text);
      console.log(`[fixtures] ${name}: written (${Buffer.byteLength(text)} B)`);
    }
  }
  const nulls = Object.values(samples.telemetry).flat().some((f) => hasNull(f.payload));
  console.log(
    `[fixtures] ${svc}: ${samples.source.messages} messages, ${Object.keys(samples.telemetry).length} streams, ` +
      `${Object.keys(samples.state).length} state items, ${Object.keys(samples.events).length} event shapes, ` +
      `null sample: ${nulls ? 'yes' : 'none in window'}`,
  );
}
if (check && changed) {
  console.error(`[fixtures] ${changed} file(s) differ from a fresh preroll`);
  process.exit(1);
}
