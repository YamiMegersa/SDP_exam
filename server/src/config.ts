import fs from 'node:fs';
import path from 'node:path';

/**
 * Configuration is env-only by design: the platform must start from the README with the
 * provided environment variables and must not carry hard-coded credentials.
 */
export interface Config {
  port: number;
  dbPath: string;
  services: string[];
  mqtt: {
    address: string;
    port: number;
    user: string;
    password: string;
    clientId: string;
    /** Outgoing queue while the broker is slow or unreachable. */
    queueLimit: number;
  };
  arl: {
    baseUrl: string;
    timeoutMs: number;
  };
  researcherCacheTtlMs: number;
  telemetryBatch: {
    maxRows: number;
    maxDelayMs: number;
  };
  /** A service with no message for this long is considered offline by the platform. */
  serviceSilenceMs: number;
  /** Retain raw telemetry for this many hours before compaction (0 keeps everything). */
  telemetryRetentionHours: number;
  /**
   * Plant and crew constants the derived measures need and the services do not publish.
   * They are configuration, not credentials, but still env-overridable so a differently sized
   * plant can be read from the same code.
   */
  derived: {
    batteryKwh: number;
    /** Rated crew; 0 counts the topology's `crew` entities instead. */
    crewExpected: number;
    stressRestBpm: number;
    stressMaxBpm: number;
  };
}

/** Minimal .env loader so the platform runs without extra tooling. */
export function loadDotEnv(file = path.resolve(process.cwd(), '.env')): void {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function num(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${key} must be a number, received "${raw}"`);
  }
  return parsed;
}

function str(env: NodeJS.ProcessEnv, key: string, fallback = ''): string {
  return env[key] ?? fallback;
}

/** Accepts either "host" or "http://host" and normalises to a base URL. */
function baseUrl(address: string, port: number): string {
  const withScheme = /^https?:\/\//i.test(address) ? address : `http://${address}`;
  const hasPort = /:\d+(\/|$)/.test(withScheme.replace(/^https?:\/\//i, ''));
  return hasPort ? withScheme.replace(/\/$/, '') : `${withScheme}:${port}`;
}

/**
 * Accepts "host", "host:1883", "mqtt://host" and the hand-out's "http://host", and returns the
 * bare host (or host:port). The scheme belongs to the address the exam supplies, not to the
 * transport the platform dials: mqtt.js is handed `mqtt://` in `Ingest`, so a second scheme left on
 * the front would become part of the hostname and never resolve.
 */
function brokerHost(address: string): string {
  return address
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/.*$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const missing: string[] = [];
  for (const key of ['MQTT_BROKER_ADDRESS', 'MQTT_BROKER_PORT', 'ARL_API_ADDRESS', 'ARL_API_PORT']) {
    if (!env[key]) missing.push(key);
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        'See .env.example and the README (Configuration).',
    );
  }

  const services = str(env, 'ARL_SERVICES', 'rta,mhe,opg')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  return {
    port: num(env, 'PORT', 3000),
    dbPath: str(env, 'DB_PATH', './data/arl.sqlite'),
    services,
    mqtt: {
      address: brokerHost(str(env, 'MQTT_BROKER_ADDRESS')),
      port: num(env, 'MQTT_BROKER_PORT', 1883),
      user: str(env, 'MQTT_BROKER_USER'),
      password: str(env, 'MQTT_BROKER_PASSWORD'),
      clientId: str(env, 'MQTT_CLIENT_ID', `arl-platform-${process.pid}`),
      queueLimit: num(env, 'MQTT_QUEUE_LIMIT', 50_000),
    },
    arl: {
      baseUrl: baseUrl(str(env, 'ARL_API_ADDRESS'), num(env, 'ARL_API_PORT', 8080)),
      timeoutMs: num(env, 'ARL_API_TIMEOUT_MS', 5_000),
    },
    researcherCacheTtlMs: num(env, 'RESEARCHER_CACHE_TTL_S', 60) * 1_000,
    telemetryBatch: {
      maxRows: num(env, 'TELEMETRY_BATCH_ROWS', 1_000),
      maxDelayMs: num(env, 'TELEMETRY_BATCH_MS', 250),
    },
    serviceSilenceMs: num(env, 'SERVICE_SILENCE_S', 180) * 1_000,
    telemetryRetentionHours: num(env, 'TELEMETRY_RETENTION_H', 0),
    derived: {
      batteryKwh: num(env, 'OPG_BATTERY_KWH', 4_000),
      crewExpected: num(env, 'MHE_CREW_EXPECTED', 0),
      stressRestBpm: num(env, 'STRESS_REST_BPM', 60),
      stressMaxBpm: num(env, 'STRESS_MAX_BPM', 110),
    },
  };
}
