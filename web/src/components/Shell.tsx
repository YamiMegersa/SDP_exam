import { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Clock3,
  Database,
  Radio,
  RotateCcw,
  Satellite,
  Server,
  Terminal,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { api, type HealthResponse } from '../lib/api';
import { clockTime, since } from '../lib/format';
import { useLive, useResearcher, useTick } from '../lib/hooks';
import { live } from '../lib/live';
import { Annunciator } from './Annunciator';
import { Pill } from './ui';

export type Route = 'overview' | 'rta' | 'mhe' | 'opg' | 'alerts' | 'replay';

const ROUTES: Array<{ id: Route; label: string; icon: typeof Radio; accent: string }> = [
  { id: 'overview', label: 'Overview', icon: Activity, accent: 'text-ink-200' },
  { id: 'rta', label: 'Radio Telescopes', icon: Radio, accent: 'text-rta' },
  { id: 'mhe', label: 'Mars Habitat', icon: Satellite, accent: 'text-mhe' },
  { id: 'opg', label: 'Power Plant', icon: Server, accent: 'text-opg' },
  { id: 'alerts', label: 'Alert Log', icon: AlertTriangle, accent: 'text-warn' },
  { id: 'replay', label: 'Replay', icon: RotateCcw, accent: 'text-replay' },
];

export function Shell({
  route,
  onRoute,
  children,
}: {
  route: Route;
  onRoute: (route: Route) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-base-950">
      <Header route={route} onRoute={onRoute} />
      <Annunciator onOpenLog={() => onRoute('alerts')} />
      <Nav route={route} onRoute={onRoute} />
      <main className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</main>
      <Footer />
    </div>
  );
}

function Header({ route, onRoute }: { route: Route; onRoute: (route: Route) => void }) {
  const version = useLive();
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [code, setCode] = useResearcher();
  useTick(1000);
  void version;

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api
        .health()
        .then((payload) => {
          if (!cancelled) setHealth(payload);
        })
        .catch(() => {
          if (!cancelled) setHealth(null);
        });
    };
    load();
    const timer = window.setInterval(load, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const connection = live.connection;
  const connected = connection === 'open';
  const brokerUp = health?.broker ?? live.brokerOnline;
  const simNow = live.simTime;
  const replaying = route === 'replay';

  return (
    <header className="flex flex-none items-center gap-4 border-b border-base-700 bg-base-900 px-3 py-2">
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded border border-rta/40 bg-rta/10">
          <Radio size={16} className="text-rta" />
        </div>
        <div className="leading-tight">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-semibold tracking-tight text-ink-100">ARL Operations</span>
            {replaying ? (
              <Pill tone="replay">historical</Pill>
            ) : connected ? (
              <span className="flex items-center gap-1 text-2xs font-bold uppercase tracking-widest text-ok">
                <span className="led led-nominal" /> live
              </span>
            ) : (
              <Pill tone="crit">{connection}</Pill>
            )}
          </div>
          <div className="text-2xs text-ink-500">Carnarvon &middot; Karoo &middot; Northern Cape</div>
        </div>
      </div>

      <div className="hidden min-w-0 flex-1 items-center justify-end gap-4 lg:flex">
        <StatusItem
          icon={connected ? Wifi : WifiOff}
          label="console link"
          value={connected ? 'ws open' : connection}
          ok={connected}
        />
        <StatusItem icon={Database} label="broker" value={brokerUp ? 'up' : 'down'} ok={brokerUp} />
        <StatusItem
          icon={Server}
          label="arl api"
          value={health ? (health.arl.ok ? 'ok' : 'degraded') : '--'}
          ok={health?.arl.ok ?? false}
        />
        <StatusItem
          icon={Activity}
          label="ingest"
          value={`${(health?.ingest.received ?? live.ingest.received).toLocaleString('en-US')}`}
          note={health ? `${health.ingest.gaps} gaps` : undefined}
          ok={!health || health.ingest.gaps === 0}
        />
      </div>

      <div className="ml-auto flex flex-none items-center gap-3">
        <label className="flex items-center gap-1.5" title="Researcher code recorded against every control command">
          <Terminal size={13} className="text-ink-500" />
          <input
            value={code}
            onChange={(event) => setCode(event.target.value.toLowerCase())}
            spellCheck={false}
            className="telemetry-readout w-24 rounded border border-base-600 bg-base-950 px-1.5 py-1 text-2xs text-ink-200 focus:border-rta/60 focus:outline-none"
            aria-label="Researcher code"
          />
        </label>
        <div className="flex items-center gap-1.5 rounded border border-base-700 bg-base-950 px-2 py-1">
          <Clock3 size={13} className="text-ink-500" />
          <div className="leading-none">
            <div className="telemetry-readout text-sm font-bold text-ink-100">{clockTime(simNow)}</div>
            <div className="text-2xs text-ink-500">{health?.simulated ? 'simulator time' : 'wall clock'}</div>
          </div>
        </div>
      </div>
    </header>
  );
}

function StatusItem({
  icon: Icon,
  label,
  value,
  note,
  ok,
}: {
  icon: typeof Wifi;
  label: string;
  value: string;
  note?: string;
  ok: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5" title={`${label}: ${value}`}>
      <Icon size={12} className={ok ? 'text-ok' : 'text-crit'} />
      <div className="leading-none">
        <div className="text-2xs uppercase tracking-wider text-ink-500">{label}</div>
        <div className={`telemetry-readout text-2xs ${ok ? 'text-ink-200' : 'text-crit'}`}>
          {value}
          {note ? <span className="ml-1 text-ink-500">{note}</span> : null}
        </div>
      </div>
    </div>
  );
}

function Nav({ route, onRoute }: { route: Route; onRoute: (route: Route) => void }) {
  return (
    <nav className="flex flex-none items-stretch gap-0.5 border-b border-base-700 bg-base-900 px-2">
      {ROUTES.map((entry) => {
        const Icon = entry.icon;
        const active = route === entry.id;
        return (
          <button
            key={entry.id}
            onClick={() => onRoute(entry.id)}
            className={`group relative flex items-center gap-1.5 px-3 py-2 text-xs transition-colors ${
              active ? 'text-ink-100' : 'text-ink-400 hover:text-ink-200'
            }`}
          >
            <Icon size={13} className={active ? entry.accent : 'text-ink-500 group-hover:text-ink-300'} />
            {entry.label}
            {entry.id === 'alerts' ? <ServiceCode /> : null}
            {active ? <span className="absolute inset-x-1 -bottom-px h-0.5 rounded bg-current opacity-80" /> : null}
          </button>
        );
      })}
      <div className="ml-auto flex items-center gap-1.5 py-1">
        {(['rta', 'mhe', 'opg'] as const).map((code) => (
          <ServiceLed key={code} code={code} />
        ))}
      </div>
    </nav>
  );
}

function ServiceLed({ code }: { code: string }) {
  const service = live.services.get(code);
  const online = service?.online ?? null;
  const stale = service?.lastRecvTs ? Date.now() - service.lastRecvTs > 60_000 : true;
  const state = online === false ? 'crit' : stale ? 'warn' : online ? 'ok' : 'inert';
  const tone = code === 'rta' ? 'border-rta/40' : code === 'mhe' ? 'border-mhe/40' : 'border-opg/40';
  return (
    <span
      className={`flex items-center gap-1.5 rounded border ${tone} bg-base-950 px-1.5 py-0.5`}
      title={`${code.toUpperCase()} ${online === null ? 'unknown' : online ? 'online' : 'offline'} \u00b7 last message ${since(service?.lastRecvTs, Date.now())}`}
    >
      <span
        className={`led ${
          state === 'ok' ? 'led-nominal' : state === 'warn' ? 'led-caution' : state === 'crit' ? 'led-alarm' : 'led-inert'
        }`}
      />
      <span className="text-2xs font-bold uppercase tracking-wider text-ink-300">{code}</span>
    </span>
  );
}

function ServiceCode() {
  const version = useLive();
  void version;
  const total = live.activeAlerts().length;
  if (total === 0) return null;
  return (
    <span className="rounded-full bg-crit px-1 text-2xs font-bold text-white" aria-label={`${total} active alerts`}>
      {total}
    </span>
  );
}

function Footer() {
  const version = useLive();
  void version;
  const services = [...live.services.values()];
  const samples = services.reduce((sum, service) => sum + service.samples, 0);
  return (
    <footer className="flex flex-none items-center gap-4 border-t border-base-700 bg-base-900 px-3 py-1 text-2xs text-ink-500">
      <span className="telemetry-readout">{samples.toLocaleString('en-US')} samples ingested this session</span>
      <span className="telemetry-readout">
        {live.receivedFrames.toLocaleString('en-US')} ws batches &middot; {live.ingest.gaps} seq gaps
      </span>
      <span className="ml-auto flex items-center gap-3">
        {services.map((service) => (
          <span key={service.code} className="telemetry-readout">
            {service.code}:{service.samples}
          </span>
        ))}
        <span className="telemetry-readout uppercase tracking-widest">arl platform v0.1.0</span>
      </span>
    </footer>
  );
}
