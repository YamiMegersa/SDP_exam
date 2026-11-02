import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

/** The four required keys, with the shape the exam hand-out publishes. */
const base = {
  MQTT_BROKER_ADDRESS: 'wmc.ms.wits.ac.za',
  MQTT_BROKER_PORT: '1883',
  ARL_API_ADDRESS: 'http://wmc.ms.wits.ac.za',
  ARL_API_PORT: '8080',
};

const cfg = (overrides: Record<string, string> = {}) => loadConfig({ ...base, ...overrides });

describe('address normalisation', () => {
  it('strips the hand-out scheme from the broker address', () => {
    // The brief hands out `http://wmc.ms.wits.ac.za` for a broker dialled over mqtt://, so the
    // scheme is address decoration, not transport information.
    expect(cfg().mqtt.address).toBe('wmc.ms.wits.ac.za');
    expect(cfg({ MQTT_BROKER_ADDRESS: 'http://wmc.ms.wits.ac.za/' }).mqtt.address).toBe(
      'wmc.ms.wits.ac.za',
    );
    expect(cfg({ MQTT_BROKER_ADDRESS: 'mqtt://wmc.ms.wits.ac.za:1883' }).mqtt.address).toBe(
      'wmc.ms.wits.ac.za:1883',
    );
  });

  it('builds one scheme and one port into the API base URL', () => {
    expect(cfg().arl.baseUrl).toBe('http://wmc.ms.wits.ac.za:8080');
    expect(cfg({ ARL_API_ADDRESS: 'http://wmc.ms.wits.ac.za:8081' }).arl.baseUrl).toBe(
      'http://wmc.ms.wits.ac.za:8081',
    );
    expect(cfg({ ARL_API_ADDRESS: 'http://host:8080/' }).arl.baseUrl).toBe('http://host:8080');
  });

  it('keeps the broker port the hand-out supplies, and the credentials beside it', () => {
    const c = cfg({ MQTT_BROKER_USER: 'student', MQTT_BROKER_PASSWORD: 'secret' });
    expect(c.mqtt.port).toBe(1883);
    expect(c.mqtt.user).toBe('student');
    expect(c.mqtt.password).toBe('secret');
    // Empty credentials mean an anonymous broker, which is how the local bundle runs.
    expect(cfg().mqtt.user).toBe('');
    expect(cfg().mqtt.password).toBe('');
  });
});

describe('validation', () => {
  it('names every missing required variable at once', () => {
    expect(() => loadConfig({})).toThrow(
      /MQTT_BROKER_ADDRESS, MQTT_BROKER_PORT, ARL_API_ADDRESS, ARL_API_PORT/,
    );
  });

  it('rejects a non-numeric port instead of connecting to nowhere', () => {
    expect(() => cfg({ MQTT_BROKER_PORT: 'eighteen-eighty-three' })).toThrow(
      /MQTT_BROKER_PORT must be a number/,
    );
  });

  it('defaults the services to the three the platform implements', () => {
    expect(cfg().services).toEqual(['rta', 'mhe', 'opg']);
    expect(cfg({ ARL_SERVICES: 'rta, OPG ,' }).services).toEqual(['rta', 'opg']);
  });
});
