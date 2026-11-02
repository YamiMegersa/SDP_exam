// Shared machinery for the drills (Planning Docs/52 §4.4). No drill talks to the simulator's
// write paths: weather and faults come from the scenario file, controls go through the platform.

import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import WebSocket from 'ws';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const SIM = join(ROOT, 'Services/arl-sim');
export const DRILL_PORT = Number(process.env.DRILL_PORT ?? 3100);
export const ARL_API = 'http://localhost:8080';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const iso = (ts) => (ts == null ? null : new Date(ts).toISOString());
export const say = (...parts) => console.log('[drill]', ...parts);

export class DrillFailure extends Error {
  constructor(message, detail) {
    super(message);
    this.detail = detail;
  }
}

export function assert(condition, message, detail) {
  if (!condition) throw new DrillFailure(message, detail);
}

// ---------------------------------------------------------------- processes

export function stack(command, services = [], env = {}) {
  const result = spawnSync('bash', [join(ROOT, 'scripts/stack.sh'), command, ...services], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (output) for (const line of output.split('\n')) console.log(`  ${line}`);
  if (result.status !== 0) throw new DrillFailure(`stack.sh ${command} failed (exit ${result.status})`, { output });
  return output;
}

/** The effective (clamped) speedup and start a running service reports in its first log line. */
export function serviceClock(container) {
  const result = spawnSync('podman', ['logs', container], { encoding: 'utf8' });
  const line = `${result.stdout}${result.stderr}`.split('\n').find((l) => l.includes('"message":"running"'));
  if (!line) return null;
  const { fields } = JSON.parse(line);
  return { start: fields.start, speedup: fields.speedup };
}

export function portInUse(port) {
  return new Promise((done) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      done(true);
    });
    socket.once('error', () => done(false));
  });
}

function newestMtime(dir) {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(path) : statSync(path).mtimeMs);
  }
  return newest;
}

/** `server/dist` is what a drill runs; rebuild it when any source file is newer. */
export function ensureBuilt() {
  const entry = join(ROOT, 'server/dist/index.js');
  if (existsSync(entry) && statSync(entry).mtimeMs >= newestMtime(join(ROOT, 'server/src'))) return;
  say('server/dist is older than server/src: building');
  const result = spawnSync('npm', ['--workspace', 'server', 'run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) throw new DrillFailure('server build failed');
}

/**
 * The drill's own platform: a fresh database, port 3100, the local broker and API, empty broker
 * credentials. cwd is the artefact directory, so the repository's `.env` (which may name the shared
 * lab) is never read, and the environment is built from nothing rather than inherited.
 */
export function startPlatform({ dir, dbPath, services, port = DRILL_PORT, env = {} }) {
  const log = openSync(join(dir, 'platform.log'), 'a');
  const childEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'production',
    MQTT_BROKER_ADDRESS: 'localhost',
    MQTT_BROKER_PORT: '1883',
    MQTT_BROKER_USER: '',
    MQTT_BROKER_PASSWORD: '',
    MQTT_CLIENT_ID: `arl-drill-${process.pid}`,
    ARL_API_ADDRESS: 'localhost',
    ARL_API_PORT: '8080',
    ARL_SERVICES: services.join(','),
    PORT: String(port),
    DB_PATH: dbPath,
    ...env,
  };
  if (childEnv.MQTT_BROKER_ADDRESS !== 'localhost' || childEnv.ARL_API_ADDRESS !== 'localhost') {
    throw new DrillFailure('refusing to start a drill platform that is not pointed at localhost');
  }
  const child = spawn(process.execPath, [join(ROOT, 'server/dist/index.js')], {
    cwd: dir,
    env: childEnv,
    stdio: ['ignore', log, log],
  });
  closeSync(log);
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = { code, signal };
  });
  return {
    pid: child.pid,
    get exited() {
      return exited;
    },
    async stop() {
      if (exited) return;
      child.kill('SIGTERM');
      for (let i = 0; i < 100 && !exited; i += 1) await sleep(100);
      if (!exited) child.kill('SIGKILL');
    },
  };
}

// ---------------------------------------------------------------- monitors

/**
 * Peak ingest rate, sampled from the platform's own counters once a second. The interval is the
 * platform's uptime, not ours: a response delayed by a busy event loop would otherwise shrink the
 * denominator and report a burst that never happened.
 */
export function healthSampler(http) {
  let last = null;
  let peak = 0;
  let latest = null;
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const { body } = await http.get('/api/health');
      latest = body;
      if (last && body.uptimeMs > last.t) {
        peak = Math.max(peak, ((body.ingest.received - last.received) * 1000) / (body.uptimeMs - last.t));
      }
      last = { received: body.ingest.received, t: body.uptimeMs };
    } catch {
      // The platform may be restarting under a drill; a missed sample is not a failure.
    } finally {
      busy = false;
    }
  }, 1000);
  return {
    get peak() {
      return Math.round(peak);
    },
    get latest() {
      return latest;
    },
    stop: () => clearInterval(timer),
  };
}

/** A live-feed client: the peak number of frames the server had pending for one flush. */
export function wsMonitor(port = DRILL_PORT) {
  const socket = new WebSocket(`ws://localhost:${port}/ws`);
  const state = { messages: 0, peakDepth: 0, frames: 0, hello: false, handlers: new Set() };
  socket.on('message', (data) => {
    const message = JSON.parse(String(data));
    state.messages += 1;
    if (message.type === 'hello') state.hello = true;
    if (message.type === 'frames') {
      state.frames += message.frames.length;
      state.peakDepth = Math.max(state.peakDepth, message.frames.length);
    }
    for (const handler of state.handlers) handler(message);
  });
  socket.on('error', () => {});
  return {
    state,
    send: (message) => socket.send(JSON.stringify(message)),
    on: (handler) => {
      state.handlers.add(handler);
      return () => state.handlers.delete(handler);
    },
    ready: () =>
      new Promise((ok, fail) => {
        if (socket.readyState === WebSocket.OPEN) return ok();
        socket.once('open', ok);
        socket.once('error', fail);
      }),
    close: () => socket.close(),
  };
}

// ---------------------------------------------------------------- the context a drill sees

export function httpClient(base) {
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = text;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // CSV and plain-text bodies are returned as they are.
    }
    return { status: response.status, body: parsed };
  };
  return {
    get: (path) => call('GET', path),
    post: (path, body = {}) => call('POST', path, body),
    del: (path) => call('DELETE', path),
  };
}

const TERMINAL = new Set(['completed', 'rejected', 'failed', 'timeout']);

/**
 * Acks must arrive in a legal order: `rejected` alone, or `accepted`, any `in_progress`, then one
 * of `completed`/`failed`. Returns null when the sequence is legal, else what was wrong.
 */
export function ackOrderProblem(states) {
  if (!states.length) return 'no acks';
  if (states[0] === 'rejected') return states.length === 1 ? null : `acks after rejected: ${states.join(' > ')}`;
  if (states[0] !== 'accepted') return `first ack is ${states[0]}, not accepted`;
  const tail = states.slice(1);
  const end = tail.findIndex((s) => s === 'completed' || s === 'failed');
  if (end === -1) return tail.every((s) => s === 'in_progress') ? 'not settled' : `unexpected ${tail.join(' > ')}`;
  if (end !== tail.length - 1) return `acks after ${tail[end]}: ${states.join(' > ')}`;
  return tail.slice(0, end).every((s) => s === 'in_progress') ? null : `unexpected ${states.join(' > ')}`;
}

export class DrillContext {
  constructor({ drill, id, dir, dbPath, port = DRILL_PORT }) {
    this.drill = drill;
    this.id = id;
    this.dir = dir;
    this.dbPath = dbPath;
    this.port = port;
    this.http = httpClient(`http://localhost:${port}`);
    this.arl = httpClient(ARL_API);
    this.steps = [];
    this.facts = {};
    this.failed = false;
    this.commandIds = [];
  }

  get = (path) => this.http.get(path);
  post = (path, body) => this.http.post(path, body);

  /** One named, ordered assertion. After the first failure every later step is recorded as skipped. */
  async step(name, fn) {
    if (this.failed) {
      this.steps.push({ name, status: 'skipped' });
      console.log(`  - ${name} (skipped)`);
      return undefined;
    }
    const started = Date.now();
    try {
      const detail = (await fn()) ?? {};
      this.steps.push({ name, status: 'pass', ms: Date.now() - started, detail });
      console.log(`  ✓ ${name}${summarise(detail)}`);
      return detail;
    } catch (error) {
      this.failed = true;
      const detail = error instanceof DrillFailure ? error.detail : { stack: error.stack };
      this.steps.push({ name, status: 'fail', ms: Date.now() - started, error: error.message, detail });
      console.log(`  ✗ ${name}: ${error.message}`);
      if (detail) console.log(`    ${JSON.stringify(detail).slice(0, 600)}`);
      return undefined;
    }
  }

  /** Poll until `fn` returns something truthy. Time-outs are generous: assertions are on order. */
  async waitFor(label, fn, { timeoutMs = 120_000, intervalMs = 500 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await fn();
      if (last) return last;
      await sleep(intervalMs);
    }
    throw new DrillFailure(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${label}`, { last });
  }

  /** Read-only view of the drill platform's database (WAL allows it while the platform writes). */
  db() {
    if (!this._db) this._db = new Database(this.dbPath, { readonly: true, fileMustExist: true });
    return this._db;
  }

  /** A service's own simulated "now": the newest sample the platform has stored from it. */
  simNow(service) {
    const row = this.db().prepare('SELECT MAX(ts) AS ts FROM telemetry WHERE service = ?').get(service);
    return row?.ts ?? null;
  }

  /** The latest stored value of one state item, decoded. */
  state(service, entity, item) {
    const row = this.db()
      .prepare('SELECT ts, value FROM state_change WHERE service = ? AND entity = ? AND item = ? ORDER BY ts DESC, id DESC LIMIT 1')
      .get(service, entity, item);
    if (!row) return undefined;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }

  /** Stored events of one kind, payload decoded, oldest first. */
  events(service, kind, sinceTs = 0) {
    return this.db()
      .prepare('SELECT ts, entity, payload FROM event WHERE service = ? AND kind = ? AND ts >= ? ORDER BY ts, id')
      .all(service, kind, sinceTs)
      .map((r) => ({ ts: r.ts, entity: r.entity, payload: JSON.parse(r.payload) }));
  }

  /** The latest telemetry frame of one entity's stream, decoded. */
  latest(service, entity, stream) {
    const row = this.db()
      .prepare('SELECT ts, data FROM telemetry WHERE service = ? AND entity = ? AND stream = ? ORDER BY ts DESC, id DESC LIMIT 1')
      .get(service, entity, stream);
    return row ? { ts: row.ts, ...JSON.parse(row.data) } : undefined;
  }

  waitSim(service, ts, opts) {
    return this.waitFor(`${service} to reach ${iso(ts)}`, () => (this.simNow(service) ?? 0) >= ts, opts);
  }

  async alerts(filter = {}) {
    const query = new URLSearchParams({ status: 'all', limit: '1000', ...(filter.service ? { service: filter.service } : {}) });
    const { body } = await this.get(`/api/alerts?${query}`);
    return body.alerts.filter(
      (a) =>
        (!filter.type || a.type === filter.type) &&
        (!filter.entity || a.entity === filter.entity) &&
        (!filter.status || a.status === filter.status) &&
        (!filter.severity || a.severity === filter.severity),
    );
  }

  waitAlert(label, filter, opts) {
    return this.waitFor(label, async () => (await this.alerts(filter))[0], opts);
  }

  /** POST /api/commands exactly as the console does. */
  async command(service, entity, control, value, researcher) {
    const response = await this.post('/api/commands', { service, entity, control, value, researcher });
    if (response.status === 202) this.commandIds.push(response.body.command_id);
    return response;
  }

  async acks(commandId) {
    return (await this.get(`/api/commands/${commandId}/acks`)).body;
  }

  /** Wait for a command to reach a terminal state; returns the row and its ack sequence. */
  async settle(commandId, { timeoutMs = 60_000 } = {}) {
    const row = await this.waitFor(
      `command ${commandId.slice(0, 8)} to settle`,
      async () => {
        const { body } = await this.get('/api/commands?limit=500');
        const found = body.find((c) => c.command_id === commandId);
        return found && TERMINAL.has(found.state) ? found : null;
      },
      { timeoutMs, intervalMs: 250 },
    );
    const acks = await this.acks(commandId);
    return { row, acks, states: acks.map((a) => a.state) };
  }

  /** Send, require 202, wait for the terminal state, and check the ack order. */
  async sendAndSettle(service, entity, control, value, researcher, opts) {
    const sent = await this.command(service, entity, control, value, researcher);
    assert(sent.status === 202, `${control} was refused by the platform (${sent.status})`, sent.body);
    const settled = await this.settle(sent.body.command_id, opts);
    const problem = ackOrderProblem(settled.states);
    assert(!problem, `${control} acks out of order: ${problem}`, { states: settled.states });
    return settled;
  }

  close() {
    this._db?.close();
    this._db = null;
  }
}

function summarise(detail) {
  const text = JSON.stringify(detail);
  return text && text !== '{}' ? `  ${text.length > 160 ? `${text.slice(0, 157)}...` : text}` : '';
}

// ---------------------------------------------------------------- scenarios

/** The subset of TOML the scenario files use: `[[event]]` tables of `key = value` lines. */
export function parseScenario(text) {
  const events = [];
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (line === '[[event]]') {
      current = {};
      events.push(current);
      continue;
    }
    const match = /^(\w+)\s*=\s*(.+)$/.exec(line);
    if (!match || !current) throw new Error(`cannot parse scenario line: ${raw}`);
    current[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
  }
  return events;
}

const offsetMs = (at) => {
  const m = /^\+(\d+):(\d\d):(\d\d)$/.exec(at ?? '');
  return m ? ((Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 : null;
};

/**
 * 52 §4.3.2: every entity must exist (an unknown id is silently ignored by the simulator), and
 * every fault must end — by `duration`, `recover_after`, or a later `repair` of the same entity.
 */
export function validateScenario(file) {
  const path = join(SIM, 'scenarios', file);
  if (!existsSync(path)) return [`no such scenario file: ${path}`];
  const problems = [];
  const events = parseScenario(readFileSync(path, 'utf8'));
  const topologies = {};
  const entities = (service) => {
    if (!topologies[service]) {
      const fixture = join(ROOT, `server/test/fixtures/${service}.topology.json`);
      if (!existsSync(fixture)) return null;
      topologies[service] = new Set(JSON.parse(readFileSync(fixture, 'utf8')).entities.map((e) => e.id));
    }
    return topologies[service];
  };
  const instant = new Set(['repair', 'set_state', 'recalibrate', 'clear_sky']);
  events.forEach((event, index) => {
    const where = `${file} event ${index + 1} (${event.service}/${event.entity ?? '-'}/${event.fault})`;
    if (offsetMs(event.at) === null && Number.isNaN(Date.parse(event.at))) problems.push(`${where}: bad 'at' ${event.at}`);
    if (event.service !== 'env' && event.entity) {
      const known = entities(event.service);
      if (!known) problems.push(`${where}: no topology fixture for ${event.service} (npm run fixtures)`);
      else if (!known.has(event.entity)) problems.push(`${where}: entity '${event.entity}' is not in the ${event.service} topology`);
    }
    if (instant.has(event.fault) || event.duration || event.params?.includes?.('recover_after')) return;
    const repaired = events.some(
      (later, j) =>
        j > index && later.fault === 'repair' && later.service === event.service && later.entity === event.entity &&
        (offsetMs(later.at) ?? 0) > (offsetMs(event.at) ?? 0),
    );
    if (!repaired) problems.push(`${where}: no duration, recover_after or later repair — it would outlive the drill`);
  });
  return problems;
}

// ---------------------------------------------------------------- sky

/** Local sidereal time (radians) at the site, for choosing a target that is above the horizon. */
export function elevation({ ra_rad: ra, dec_rad: dec }, ts, site = { lat: -30.7, lon: 21.44 }) {
  const days = ts / 86_400_000 - 10_957.5; // days since J2000.0
  const gmst = ((280.46061837 + 360.98564736629 * days) % 360) * (Math.PI / 180);
  const lst = gmst + site.lon * (Math.PI / 180);
  const lat = site.lat * (Math.PI / 180);
  const hour = lst - ra;
  return Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(hour));
}

/** The latest drill directory (other than `except`) that left a database behind. */
export function latestDrillDb(except, prefer = []) {
  const base = join(ROOT, '.logs/drills');
  if (!existsSync(base)) return null;
  const dirs = readdirSync(base)
    .filter((d) => d !== except && existsSync(join(base, d, 'arl.sqlite')))
    .map((d) => ({ d, t: statSync(join(base, d, 'arl.sqlite')).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  const preferred = dirs.find(({ d }) => prefer.some((p) => d.startsWith(`${p}-`)));
  const pick = preferred ?? dirs[0];
  return pick ? join(base, pick.d, 'arl.sqlite') : null;
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}
