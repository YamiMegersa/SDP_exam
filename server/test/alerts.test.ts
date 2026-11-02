import { beforeEach, describe, expect, it } from 'vitest';
import { AlertEngine } from '../src/alerts/engine';
import { Store } from '../src/db/store';
import { Bus } from '../src/platform/bus';
import type { PlatformEvent } from '../src/platform/events';
import type { AlertPayload } from '../src/types';
import { SimClock } from '../src/util/clock';
import { alertPayload } from './helpers';

let store: Store;

beforeEach(() => {
  store = new Store(':memory:');
});

const event = (overrides: Record<string, unknown> = {}): AlertPayload =>
  alertPayload(overrides) as unknown as AlertPayload;

const apply = (payload: AlertPayload, ts = 1_000) =>
  store.applyAlertEvent('rta', payload, ts, 1_700_000_000_000, 'dish-001');

describe('service alert lifecycle', () => {
  it('records a raised alert as an append-only audit trail entry', () => {
    const { alert, change } = apply(event());

    expect(change).toBe('created');
    expect(alert).toMatchObject({
      alert_id: 'rta/dish-001/temperature',
      service: 'rta',
      entity: 'dish-001',
      type: 'temperature_high',
      severity: 'warning',
      status: 'raised',
      value: 71.5,
      limit_value: 70,
      unit: 'C',
      origin: 'service',
      raised_ts: 1_000,
      cleared_ts: null,
      ack_ts: null,
      resolved_ts: null,
    });

    const trail = store.listTransitions(alert.alert_id);
    expect(trail.map((t) => t.action)).toEqual(['raised']);
    expect(trail[0]).toMatchObject({ from_status: null, to_status: 'raised' });
  });

  it('escalates in place: one alert id, higher severity, a second audit entry', () => {
    apply(event());
    const { alert, change } = apply(
      event({ severity: 'critical', value: 88, message: 'Dish 1 critical' }),
      1_020,
    );

    expect(change).toBe('escalated');
    expect(alert.severity).toBe('critical');
    expect(alert.escalate_count).toBe(1);
    expect(alert.raised_ts).toBe(1_000);
    expect(alert.last_ts).toBe(1_020);

    const trail = store.listTransitions(alert.alert_id);
    expect(trail.map((t) => t.action)).toEqual(['raised', 'escalated']);
    expect(trail[1]).toMatchObject({ from_status: 'warning', to_status: 'critical' });
  });

  it('treats a repeat at the same severity as an update, not a transition', () => {
    apply(event());
    const { change } = apply(event({ value: 72.5 }), 1_010);
    expect(change).toBe('updated');
    expect(store.listTransitions('rta/dish-001/temperature')).toHaveLength(1);
  });

  it('clears on the service\'s own clear event and reopens without inventing a new id', () => {
    apply(event());
    const cleared = apply(event({ state: 'cleared' }), 1_100);
    expect(cleared.change).toBe('cleared');
    expect(cleared.alert.status).toBe('cleared');
    expect(cleared.alert.cleared_ts).toBe(1_100);

    expect(apply(event({ state: 'cleared' }), 1_110).change).toBe('noop');

    const reopened = apply(event({ value: 75 }), 1_200);
    expect(reopened.change).toBe('raised');
    expect(reopened.alert.status).toBe('raised');
    expect(reopened.alert.cleared_ts).toBeNull();
    expect(reopened.alert.raised_ts).toBe(1_200);
    expect(store.listTransitions(reopened.alert.alert_id).map((t) => t.action)).toEqual([
      'raised',
      'cleared',
      'raised',
    ]);
  });

  it('records a clear for an alert it never saw raised, flagged rather than dropped', () => {
    const { alert, change } = apply(event({ state: 'cleared' }), 1_500);
    expect(change).toBe('created');
    expect(alert.status).toBe('cleared');
    const [transition] = store.listTransitions(alert.alert_id);
    expect(transition.action).toBe('cleared');
    expect(String(transition.note)).toMatch(/first observed as cleared/);
  });

  it('clears audit fields when an alert is reopened', () => {
    // Raise, acknowledge, and resolve an alert
    apply(event());
    store.acknowledgeAlert({
      alertId: 'rta/dish-001/temperature',
      researcher: 'arl-as3',
      note: 'investigating',
      ts: 1_050,
      wallTs: 1_700_000_000_000,
    });
    store.resolveAlert({
      alertId: 'rta/dish-001/temperature',
      researcher: 'arl-as3',
      resolution: 'fixed',
      cause: 'hardware fault',
      ts: 1_100,
      wallTs: 1_700_000_000_000,
    });

    // Verify audit fields are populated
    let alert = store.getAlert('rta/dish-001/temperature')!;
    expect(alert.ack_ts).toBe(1_050);
    expect(alert.ack_by).toBe('arl-as3');
    expect(alert.resolved_ts).toBe(1_100);
    expect(alert.resolved_by).toBe('arl-as3');
    expect(alert.cause).toBe('hardware fault');

    // Clear the alert
    apply(event({ state: 'cleared' }), 1_200);

    // Reopen the alert
    apply(event({ value: 75 }), 1_300);

    // Verify all audit fields are cleared
    alert = store.getAlert('rta/dish-001/temperature')!;
    expect(alert.status).toBe('raised');
    expect(alert.ack_ts).toBeNull();
    expect(alert.ack_by).toBeNull();
    expect(alert.ack_note).toBeNull();
    expect(alert.resolved_ts).toBeNull();
    expect(alert.resolved_by).toBeNull();
    expect(alert.resolution).toBeNull();
    expect(alert.cause).toBeNull();
  });
});

describe('researcher acknowledgement and resolution', () => {
  const ack = (researcher = 'arl-as3') =>
    store.acknowledgeAlert({
      alertId: 'rta/dish-001/temperature',
      researcher,
      note: 'looking into it',
      ts: 1_050,
      wallTs: 1_700_000_000_000,
    });

  const resolve = (researcher = 'arl-as3', resolution = 'cooling pump restarted') =>
    store.resolveAlert({
      alertId: 'rta/dish-001/temperature',
      researcher,
      resolution,
      cause: 'pump failure',
      ts: 1_300,
      wallTs: 1_700_000_000_000,
    });

  it('acknowledges once, capturing who signed', () => {
    apply(event());
    const result = ack();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.alert.ack_by).toBe('arl-as3');
    expect(result.alert.ack_note).toBe('looking into it');
    expect(result.alert.ack_ts).toBe(1_050);

    const second = ack('arl-xy1');
    expect(second).toMatchObject({ ok: false, code: 409, error: 'alert_already_acknowledged' });
  });

  it('refuses to resolve an alert nobody acknowledged', () => {
    apply(event());
    expect(resolve()).toMatchObject({ ok: false, code: 409, error: 'alert_not_acknowledged' });
  });

  it('resolves only after acknowledgement, writing the note and the cause', () => {
    apply(event());
    ack();
    const result = resolve();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.alert.resolved_by).toBe('arl-as3');
    expect(result.alert.resolution).toBe('cooling pump restarted');
    expect(result.alert.cause).toBe('pump failure');
    expect(result.alert.resolved_ts).toBe(1_300);

    const trail = store.listTransitions(result.alert.alert_id);
    expect(trail.map((t) => t.action)).toEqual(['raised', 'acknowledged', 'resolved']);
    expect(trail.map((t) => t.actor)).toEqual([null, 'arl-as3', 'arl-as3']);

    expect(resolve()).toMatchObject({ ok: false, code: 409, error: 'alert_already_resolved' });
  });

  it('reports a missing alert rather than creating one', () => {
    expect(ack()).toMatchObject({ ok: false, code: 404, error: 'alert_not_found' });
    expect(resolve()).toMatchObject({ ok: false, code: 404, error: 'alert_not_found' });
  });
});

describe('annunciator counters and filters', () => {
  it('counts what is in alarm now, not everything unresolved', () => {
    apply(event({ alert_id: 'a-open' }));
    apply(event({ alert_id: 'a-critical', severity: 'critical' }));
    apply(event({ alert_id: 'a-cleared', state: 'cleared' }));
    apply(event({ alert_id: 'a-resolved' }));
    store.acknowledgeAlert({
      alertId: 'a-resolved',
      researcher: 'arl-as3',
      ts: 1_050,
      wallTs: 1_700_000_000_000,
    });
    store.resolveAlert({
      alertId: 'a-resolved',
      researcher: 'arl-as3',
      resolution: 'fixed',
      ts: 1_300,
      wallTs: 1_700_000_000_000,
    });

    expect(store.countAlerts()).toEqual({
      open: 2,
      critical: 1,
      unacknowledged: 2,
      cleared: 1,
      resolved: 1,
      total: 4,
    });
  });

  it('filters by lifecycle state', () => {
    apply(event({ alert_id: 'a1' }));
    apply(event({ alert_id: 'a2' }));
    store.acknowledgeAlert({
      alertId: 'a2',
      researcher: 'arl-as3',
      ts: 1_050,
      wallTs: 1_700_000_000_000,
    });

    const ids = (status: 'open' | 'raised' | 'unacknowledged' | 'acknowledged') =>
      store.listAlerts({ service: 'rta', status }).map((a) => a.alert_id);

    expect(ids('open').sort()).toEqual(['a1', 'a2']);
    expect(ids('unacknowledged')).toEqual(['a1']);
    expect(ids('acknowledged')).toEqual(['a2']);
    expect(ids('raised').sort()).toEqual(['a1', 'a2']);
    expect(store.listAlerts({ service: 'mhe' })).toHaveLength(0);
  });
});

describe('platform alerts', () => {
  it('raises once, refreshes quietly, then clears', () => {
    const base = {
      alertId: 'platform/rta/silent',
      service: 'rta',
      type: 'service_silent',
      severity: 'warning' as const,
      message: 'No data from rta for 200s',
      ts: 2_000,
      wallTs: 1_700_000_000_000,
    };

    const created = store.setPlatformAlert({ ...base, raised: true });
    expect(created?.change).toBe('created');
    expect(created?.alert.origin).toBe('platform');

    // A repeat while already raised must not add a second transition.
    expect(store.setPlatformAlert({ ...base, raised: true, ts: 2_100 })).toBeNull();
    expect(store.listTransitions(base.alertId)).toHaveLength(1);

    const cleared = store.setPlatformAlert({ ...base, raised: false, ts: 2_200 });
    expect(cleared?.change).toBe('cleared');
    expect(cleared?.alert.status).toBe('cleared');

    // Clearing what is already clear is a no-op, not an error.
    expect(store.setPlatformAlert({ ...base, raised: false, ts: 2_300 })).toBeNull();
  });
});

describe('alert engine', () => {
  const engine = () =>
    new AlertEngine(store, new Bus<PlatformEvent>(), new SimClock(), {
      services: ['rta'],
      silenceMs: 60_000,
    });

  it('ignores malformed service alerts instead of writing half an audit trail', () => {
    const alerts = engine();
    expect(alerts.serviceAlert('rta', event({ alert_id: '' }), null)).toBeNull();
    expect(alerts.serviceAlert('rta', event({ state: 'flapping' as never }), null)).toBeNull();
    expect(store.countAlerts().total).toBe(0);
  });

  it('records a valid service alert and broadcasts it', () => {
    const bus = new Bus<PlatformEvent>();
    const seen: PlatformEvent[] = [];
    bus.on((e) => seen.push(e));
    const alerts = new AlertEngine(store, bus, new SimClock(), {
      services: ['rta'],
      silenceMs: 60_000,
    });

    const result = alerts.serviceAlert('rta', event(), 'dish-001');
    expect(result?.change).toBe('created');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'alert', change: 'created' });
  });

  it('raises a platform alert when the service reports itself offline', () => {
    const alerts = engine();
    alerts.online('rta', false);

    const alert = store.getAlert('platform/rta/offline');
    expect(alert).toMatchObject({ status: 'raised', severity: 'critical', origin: 'platform' });

    alerts.online('rta', true);
    expect(store.getAlert('platform/rta/offline')?.status).toBe('cleared');
  });

  it('raises an ingest-gap alert and records the gap row', () => {
    const alerts = engine();
    alerts.ingestGap('rta', {
      service: 'rta',
      entity: 'dish-001',
      stream: 'scan',
      topic: 'rta/scan',
      expectedSeq: 11,
      receivedSeq: 20,
      missed: 8,
      ts: 1_000,
      wallTs: 1_700_000_000_000,
    });

    expect(store.getAlert('platform/rta/ingest-gap')?.status).toBe('raised');
    expect(store.db.prepare('SELECT missed FROM ingest_gap').get()).toEqual({ missed: 8 });
  });

  it('closes a broker alert a previous process left open on the first connect', () => {
    // What a restart looks like: the row is still raised, but this process has
    // not spoken to the broker yet.
    store.setPlatformAlert({
      alertId: 'platform/platform/broker',
      service: 'platform',
      type: 'broker_disconnected',
      severity: 'critical',
      raised: true,
      message: 'Lost the MQTT broker connection',
      ts: 1_000,
      wallTs: 1_700_000_000_000,
    });

    const alerts = engine();
    alerts.broker(true);

    expect(store.getAlert('platform/platform/broker')?.status).toBe('cleared');
    expect(
      store.listTransitions('platform/platform/broker').map((t) => t.action),
    ).toEqual(['raised', 'cleared']);

    // A second connect is not a second transition.
    alerts.broker(true);
    expect(store.listTransitions('platform/platform/broker')).toHaveLength(2);
  });
});
