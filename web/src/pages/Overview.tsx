import { useMemo } from 'react';
import { Activity, Antenna, ArrowRight, Database, Radio, Satellite, Server, ShieldCheck, Zap } from 'lucide-react';
import { LineChart } from '../components/charts';
import { CommandStatePill } from '../components/commands';
import { Button, Datum, Empty, Panel, PanelHead, Pill, Readout } from '../components/ui';
import { clockTime, kelvinToC, num, pct, since, watts } from '../lib/format';
import { targetLabel } from '../lib/catalogue';
import { useLive, useSeries, useTick } from '../lib/hooks';
import { live } from '../lib/live';
import type { Route } from '../components/Shell';

/**
 * Facility overview.
 *
 * One screen that answers "is anything wrong right now?" without switching tabs:
 * service health, the three headline numbers, active alerts and the last commands
 * issued. Everything else is one click away.
 */
export function OverviewPage({ onRoute }: { onRoute: (route: Route) => void }) {
  const version = useLive();
  useTick(1000);

  const totals = useMemo(() => {
    const services = [...live.services.values()];
    return {
      services: services.length,
      online: services.filter((service) => service.online).length,
      samples: services.reduce((sum, service) => sum + service.samples, 0),
      entities: services.reduce((sum, service) => sum + (service.topology?.entities.length ?? 0), 0),
    };
  }, [version]);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-2 scroll-thin">
      <div className="grid gap-2 lg:grid-cols-3">
        <ServiceCard
          code="rta"
          title="Radio Telescope Array"
          icon={<Antenna size={14} />}
          onOpen={() => onRoute('rta')}
        />
        <ServiceCard
          code="mhe"
          title="Mars Habitation Experiment"
          icon={<Satellite size={14} />}
          onOpen={() => onRoute('mhe')}
        />
        <ServiceCard code="opg" title="On-demand Power Generation" icon={<Zap size={14} />} onOpen={() => onRoute('opg')} />
      </div>

      <div className="grid gap-2 lg:grid-cols-3">
        <Panel className="lg:col-span-2">
          <PanelHead
            title="Active alerts"
            hint={`${live.counts.open} in alarm \u00b7 ${live.counts.cleared} cleared awaiting resolution`}
            icon={<Activity size={13} />}
            right={
              <Button tone="ghost" onClick={() => onRoute('alerts')}>
                alert log <ArrowRight size={12} />
              </Button>
            }
          />
          <AlertTable onOpen={() => onRoute('alerts')} />
        </Panel>

        <Panel>
          <PanelHead title="Platform health" icon={<Database size={13} />} />
          <div className="grid grid-cols-1">
            <Datum label="services online" value={`${totals.online}/${totals.services}`} tone={totals.online === totals.services ? 'ok' : 'warn'} />
            <Datum label="entities tracked" value={String(totals.entities)} />
            <Datum label="samples this session" value={totals.samples.toLocaleString('en-US')} />
            <Datum label="ws batches" value={live.receivedFrames.toLocaleString('en-US')} />
            <Datum label="sequence gaps" value={String(live.ingest.gaps)} tone={live.ingest.gaps > 0 ? 'warn' : 'ok'} />
            <Datum label="broker" value={live.brokerOnline ? 'connected' : 'lost'} tone={live.brokerOnline ? 'ok' : 'crit'} />
            <Datum label="console link" value={live.connection} tone={live.connection === 'open' ? 'ok' : 'crit'} />
            <Datum label="sim clock" value={clockTime(live.simTime)} />
          </div>
          <div className="mt-2 rounded border border-base-700 bg-base-950/60 px-2 py-1.5 text-2xs text-ink-500">
            <div className="flex items-center gap-1.5">
              <ShieldCheck size={11} className="text-ok" />
              every control command is verified against the ARL researcher directory before it is published
            </div>
          </div>
        </Panel>
      </div>

      <div className="grid gap-2 lg:grid-cols-3">
        <Panel>
          <PanelHead title="Recent commands" icon={<Server size={13} />} />
          <CommandList />
        </Panel>
        <Panel>
          <PanelHead title="Event feed" hint="all services" icon={<Radio size={13} />} />
          <EventFeed />
        </Panel>
        <Panel>
          <PanelHead title="Cleared, unresolved" hint="service cleared the reading, operator still owes an action" />
          <ClearedList />
        </Panel>
      </div>
    </div>
  );
}

function ServiceCard({
  code,
  title,
  icon,
  onOpen,
}: {
  code: 'rta' | 'mhe' | 'opg';
  title: string;
  icon: React.ReactNode;
  onOpen: () => void;
}) {
  const service = live.services.get(code);
  const online = service?.online ?? null;
  const accent = code === 'rta' ? '#38bdf8' : code === 'mhe' ? '#fb923c' : '#facc15';
  const openAlerts = live.activeAlerts().filter((alert) => alert.service === code).length;

  return (
    <Panel>
      <PanelHead
        title={title}
        icon={icon}
        right={
          <>
            <Pill tone={online ? 'ok' : online === false ? 'crit' : 'inert'}>
              {online === null ? 'unknown' : online ? 'online' : 'offline'}
            </Pill>
            {openAlerts > 0 ? <Pill tone="warn">{openAlerts}</Pill> : null}
          </>
        }
      />
      <div className="grid grid-cols-2 gap-x-3 gap-y-2">
        {code === 'rta' ? <RtaMetrics /> : code === 'mhe' ? <MheMetrics /> : <OpgMetrics />}
      </div>
      <div className="mt-2">
        <MetricTrend code={code} accent={accent} />
      </div>
      <div className="mt-2 flex items-center justify-between text-2xs text-ink-500">
        <span className="telemetry-readout">
          {service ? `${service.samples.toLocaleString('en-US')} samples` : '\u2014'}
          {service?.lastRecvTs ? ` \u00b7 ${since(service.lastRecvTs, Date.now())}` : ''}
        </span>
        <Button tone="ghost" onClick={onOpen}>
          workspace <ArrowRight size={12} />
        </Button>
      </div>
      <div className="mt-1 h-0.5 rounded" style={{ backgroundColor: accent }} />
    </Panel>
  );
}

function MetricTrend({ code, accent }: { code: string; accent: string }) {
  const field = code === 'rta' ? 'system_temperature_k' : code === 'mhe' ? 'co2_ppm' : 'total_load_w';
  const stream = code === 'rta' ? 'normal' : code === 'mhe' ? 'environment' : 'power';
  const series = useSeries({ service: code, stream, field, max: 240 });
  return <LineChart points={series.points} color={accent} height={52} digits={0} />;
}

function RtaMetrics() {
  useLive();
  const service = live.services.get('rta');
  const temp = service ? live.aggregate(service, 'normal', 'system_temperature_k') : null;
  const observing = String(live.state('rta', 'main', 'scan_state') ?? 'idle');
  return (
    <>
      <Readout label="active dishes" value={String(live.state('rta', 'global', 'active_dishes') ?? '\u2014')} tone="rta" />
      <Readout label="mean receiver" value={kelvinToC(temp?.value)} size="sm" />
      <Readout label="scan state" value={observing} size="sm" />
      <Readout label="target" value={targetLabel(live.state('rta', 'main', 'target')) ?? '\u2014'} size="sm" />
    </>
  );
}

function MheMetrics() {
  useLive();
  const service = live.services.get('mhe');
  const co2 = service ? live.aggregate(service, 'environment', 'co2_ppm') : null;
  return (
    <>
      <Readout label="mission state" value={String(live.state('mhe', 'global', 'mission_state') ?? '\u2014')} tone="mhe" />
      <Readout label="mean co2" value={num(co2?.value, 0)} unit="ppm" size="sm" tone={co2 && co2.value > 1000 ? 'warn' : 'neutral'} />
      <Readout label="mean temp" value={kelvinToC(service ? live.aggregate(service, 'environment', 'temperature_k')?.value : null)} size="sm" />
      <Readout label="max co2" value={num(co2?.max, 0)} unit="ppm" size="sm" />
    </>
  );
}

function OpgMetrics() {
  useLive();
  const total = live.sample('opg', 'power', 'global')?.data ?? {};
  const generation = Number(total.total_generation_w ?? 0);
  const load = Number(total.total_load_w ?? 0);
  const margin = generation - load;
  return (
    <>
      <Readout label="generation" value={watts(generation)} tone="opg" />
      <Readout label="margin" value={watts(margin)} size="sm" tone={margin < 0 ? 'warn' : 'ok'} />
      <Readout label="soc" value={pct(live.sample('opg', 'power', 'batteries')?.data.state_of_charge_pct)} size="sm" />
      <Readout label="supply mode" value={String(total.supply_mode ?? '\u2014')} size="sm" />
    </>
  );
}

function AlertTable({ onOpen }: { onOpen: () => void }) {
  useLive();
  const alerts = live.activeAlerts().slice(0, 7);
  if (alerts.length === 0) {
    return <Empty>no active alarms &middot; the annunciator is clear</Empty>;
  }
  return (
    <table className="w-full border-collapse text-xs">
      <thead>
        <tr className="text-left text-2xs uppercase tracking-wider text-ink-500">
          <th className="pb-1 pr-2 font-medium">sev</th>
          <th className="pb-1 pr-2 font-medium">service</th>
          <th className="pb-1 pr-2 font-medium">source</th>
          <th className="pb-1 pr-2 font-medium">message</th>
          <th className="pb-1 pr-2 font-medium">raised</th>
          <th className="pb-1 font-medium">state</th>
        </tr>
      </thead>
      <tbody>
        {alerts.map((alert) => (
          <tr key={alert.alert_id} className="border-t border-base-700/60 hover:bg-base-800/40" onClick={onOpen}>
            <td className="py-1 pr-2">
              <Pill tone={alert.severity === 'critical' ? 'crit' : alert.severity === 'warning' ? 'warn' : 'neutral'}>
                {alert.severity}
              </Pill>
            </td>
            <td className="py-1 pr-2 text-2xs uppercase tracking-wide text-ink-300">{alert.service}</td>
            <td className="telemetry-readout py-1 pr-2 text-2xs text-ink-400">{alert.entity ?? alert.type}</td>
            <td className="max-w-[320px] truncate py-1 pr-2 text-ink-200">{alert.message ?? alert.type}</td>
            <td className="telemetry-readout py-1 pr-2 text-2xs text-ink-500">{clockTime(alert.raised_ts)}</td>
            <td className="py-1">
              {alert.ack_ts ? <Pill tone="inhand">ack</Pill> : <Pill tone="warn">unack</Pill>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CommandList() {
  useLive();
  const rows = live.commands.slice(0, 7);
  if (rows.length === 0) return <Empty>no commands issued this session</Empty>;
  return (
    <ul className="flex flex-col gap-1">
      {rows.map((command) => (
        <li key={command.command_id} className="flex items-center gap-2 border-b border-base-700/50 pb-1 last:border-0">
          <span className="telemetry-readout text-2xs text-ink-400">{command.service}</span>
          <span className="telemetry-readout truncate text-2xs text-ink-200">
            {command.entity}/{command.control}
          </span>
          <span className="ml-auto flex-none">
            <CommandStatePill state={command.state} />
          </span>
          <span className="telemetry-readout flex-none text-2xs text-ink-500">{clockTime(command.sent_ts)}</span>
        </li>
      ))}
    </ul>
  );
}

function EventFeed() {
  useLive();
  const events = [...live.services.values()]
    .flatMap((service) => service.events)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 8);
  if (events.length === 0) return <Empty>no service events yet</Empty>;
  return (
    <ul className="flex flex-col gap-1">
      {events.map((event) => (
        <li key={`${event.service}-${event.id}`} className="border-b border-base-700/50 pb-1 text-2xs last:border-0">
          <div className="flex items-center gap-1.5">
            <span className="font-bold uppercase tracking-wide text-ink-300">{event.service}</span>
            <span className="telemetry-readout text-ink-200">{event.name}</span>
            <span className="telemetry-readout ml-auto text-ink-500">{clockTime(event.ts)}</span>
          </div>
          <div className="telemetry-readout truncate text-ink-500">{summariseEvent(event.payload)}</div>
        </li>
      ))}
    </ul>
  );
}

function summariseEvent(payload: Record<string, unknown>): string {
  const interesting = ['scan_id', 'target', 'state', 'alert_id', 'severity', 'message', 'origin', 'band_hz', 'crew'];
  const parts: string[] = [];
  for (const key of interesting) {
    const value = payload[key];
    if (value === undefined || value === null) continue;
    parts.push(`${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`);
  }
  if (parts.length > 0) return parts.join(' ');
  return Object.keys(payload).slice(0, 6).join(', ');
}

function ClearedList() {
  useLive();
  const cleared = live.clearedAlerts().slice(0, 7);
  if (cleared.length === 0) return <Empty>nothing cleared and unclosed</Empty>;
  return (
    <ul className="flex flex-col gap-1">
      {cleared.map((alert) => (
        <li key={alert.alert_id} className="flex items-center gap-2 border-b border-base-700/50 pb-1 text-2xs last:border-0">
          <Pill tone="inert">{alert.service}</Pill>
          <span className="truncate text-ink-300">{alert.message ?? alert.type}</span>
          <span className="telemetry-readout ml-auto flex-none text-ink-500">{clockTime(alert.cleared_ts)}</span>
        </li>
      ))}
    </ul>
  );
}
