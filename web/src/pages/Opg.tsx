import { useState } from 'react';
import { BatteryCharging, Fuel, Gauge, Power, Sun, Zap } from 'lucide-react';
import { LineChart } from '../components/charts';
import { CommandFeedback, CommandLog, useCommand } from '../components/commands';
import { DerivedDatum, measureText, useMeasures } from '../components/derived';
import { Button, Datum, Field, Panel, PanelHead, Pill, SectionLabel, Select, TextInput } from '../components/ui';
import { clockTime, num, pct, signed, toNumber as number, watts } from '../lib/format';
import { useLimits, useLive, useResearcher, useSeries } from '../lib/hooks';
import { live } from '../lib/live';

/**
 * On-demand Power Generation workspace.
 *
 * Power is the one service where the *derived* number matters more than any raw
 * one: generation minus load tells the operator in a glance whether the base is
 * charging or draining. That margin drives the gauge colour; everything else is
 * supporting evidence (irradiance, fuel, battery health).
 *
 * Flow animation speed is proportional to the power on that link, so a stalled
 * diesel generator is visibly idle rather than merely numerically zero.
 *
 * The SOC and fuel bands come from `GET /api/alert-limits/opg` (`battery.warn_pct`, `fuel.min_pct`)
 * and the live reserve setpoint; with the limits unreadable the values are drawn `inert`, unbanded.
 */

type SocBand = 'ok' | 'warn' | 'crit';

/** Emerald above the warn limit, amber down to the reserve, crimson below it; null without limits. */
function socBand(soc: number | null, warnPct: number | null, reservePct: number | null): SocBand | null {
  if (soc === null || warnPct === null) return null;
  if (reservePct !== null && soc < reservePct) return 'crit';
  return soc < warnPct ? 'warn' : 'ok';
}

const kw = (w: number) => `${(Math.abs(w) / 1000).toFixed(1)} kW`;

export function OpgPage() {
  useLive();
  const service = live.services.get('opg');
  const measures = useMeasures('opg');
  const limits = useLimits('opg');
  const warnPct = limits.value('battery.warn_pct');
  const fuelMin = limits.value('fuel.min_pct');

  if (!service?.topology) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-ink-500">
        waiting for the OPG topology&hellip;
      </div>
    );
  }

  const totalSample = live.sample('opg', 'power', 'global');
  const total = totalSample?.data ?? {};
  const solar = live.sample('opg', 'power', 'solar')?.data ?? {};
  const battery = live.sample('opg', 'power', 'batteries')?.data ?? {};
  const diesel = live.sample('opg', 'power', 'diesel')?.data ?? {};

  const generation = number(total.total_generation_w) ?? 0;
  const load = number(total.total_load_w) ?? 0;
  const margin = generation - load;
  const reservePct = number(live.state('opg', 'batteries', 'reserve_pct'));
  const dieselW = number(diesel.power_output_w) ?? 0;
  const dieselDormant = diesel.generator_status !== 'running' || Math.abs(dieselW) < 1;
  const fuel = number(diesel.fuel_level_pct);
  const fuelTone = fuel === null || fuelMin === null ? 'inert' : fuel < fuelMin ? 'crit' : 'neutral';

  return (
    <div className="grid min-h-0 flex-1 gap-2 overflow-y-auto p-2 xl:grid-cols-[minmax(0,1fr)_350px] xl:overflow-hidden">
      <div className="flex min-h-0 flex-col gap-2 xl:overflow-y-auto scroll-thin">
        {/* shrink-0: the fixed-aspect diagram cannot be squeezed, so the column scrolls instead of
            the flex parent clipping the diesel and load nodes under the row below. */}
        <Panel className="shrink-0">
          <PanelHead
            title="Energy flow"
            // An expression, not a plain attribute: JSX attribute literals keep the backslash,
            // so "\u2192" would render as text instead of an arrow.
            hint={'solar \u2192 bus \u2190 diesel, bus \u2194 battery, bus \u2192 lab load'}
            icon={<Zap size={13} />}
            right={
              <>
                <Pill tone={service.online ? 'ok' : 'crit'}>{service.online ? 'online' : 'offline'}</Pill>
                <Pill tone="opg">{String(total.supply_mode ?? 'unknown')}</Pill>
                {live.state('opg', 'global', 'load_shed') === true ? <Pill tone="warn">load shed</Pill> : null}
              </>
            }
          />
          <EnergyFlow
            generation={generation}
            load={load}
            solarW={number(solar.power_output_w) ?? 0}
            dieselW={dieselW}
            dieselDormant={dieselDormant}
            batteryW={number(battery.battery_power_w) ?? 0}
            soc={number(battery.state_of_charge_pct)}
            fuel={fuel}
          />
        </Panel>

        <div className="grid gap-2 md:grid-cols-3">
          <MarginHud generation={generation} load={load} margin={margin} known={totalSample !== undefined} />
          <SocGauge
            soc={number(battery.state_of_charge_pct)}
            batteryW={number(battery.battery_power_w)}
            warnPct={warnPct}
            reservePct={reservePct}
            remaining={measureText(measures.get('opg.autonomy'))}
          />
          <Panel>
            <PanelHead title="Generation sources" icon={<Sun size={13} />} />
            <div className="grid grid-cols-1 gap-x-3">
              <Datum label="solar output" value={watts(solar.power_output_w)} tone="opg" />
              <Datum label="irradiance" value={`${num(solar.irradiance_wm2, 0)} W/m2`} />
              <Datum label="panel temp" value={`${num(solar.panel_temperature_k, 1)} K`} />
              <Datum
                label="inverter"
                value={String(solar.inverter_status ?? '\u2014')}
                tone={solar.inverter_status === 'fault' ? 'crit' : 'neutral'}
              />
              <Datum label="diesel output" value={watts(diesel.power_output_w)} tone={dieselDormant ? 'inert' : 'opg'} />
              <Datum label="generator" value={String(diesel.generator_status ?? '\u2014')} tone={dieselDormant ? 'inert' : 'neutral'} />
              <Datum label="fuel" value={pct(diesel.fuel_level_pct)} tone={fuelTone} />
              <Datum label="runtime" value={`${num(diesel.runtime_h, 1)} h`} />
            </div>
          </Panel>
        </div>

        <Panel>
          <PanelHead title="Trends" hint="generation margin, load and state of charge" icon={<Gauge size={13} />} />
          <TrendGrid warnPct={warnPct} />
        </Panel>
      </div>

      <div className="flex min-h-0 flex-col gap-2 xl:overflow-y-auto scroll-thin">
        <PowerControls />
        <Panel>
          <PanelHead title="Battery detail" icon={<BatteryCharging size={13} />} />
          <div className="grid grid-cols-2 gap-x-3">
            <Datum label="state of charge" value={pct(battery.state_of_charge_pct, 1)} />
            <Datum
              label="current"
              value={watts(battery.battery_power_w)}
              tone={(number(battery.battery_power_w) ?? 0) < 0 ? 'warn' : 'ok'}
            />
            <Datum label="health" value={pct(battery.battery_health_pct)} />
            <Datum label="temperature" value={`${num(battery.battery_temperature_k, 1)} K`} />
            <Datum label="reserve setpoint" value={pct(live.state('opg', 'batteries', 'reserve_pct'))} />
            <Datum label="solar array" value={live.state('opg', 'solar', 'enabled') === false ? 'disabled' : 'enabled'} />
          </div>
          <div className="mt-1 border-t border-base-700 pt-1">
            <DerivedDatum measure={measures.get('opg.autonomy')} label="autonomy to reserve" />
            <DerivedDatum measure={measures.get('opg.net_margin')} label="net margin" />
            <DerivedDatum measure={measures.get('opg.renewable_share')} label="solar share" />
          </div>
        </Panel>
        <Panel>
          <PanelHead title="Command log" hint="last 8" />
          <CommandLog service="opg" />
        </Panel>
      </div>
    </div>
  );
}

/** One arrowhead per edge colour: a marker cannot inherit the stroke of the path that uses it. */
const ARROWS = ['opg', 'caution', 'nominal', 'rta', 'inert'] as const;
type Arrow = (typeof ARROWS)[number];

function EnergyFlow({
  generation,
  load,
  solarW,
  dieselW,
  dieselDormant,
  batteryW,
  soc,
  fuel,
}: {
  generation: number;
  load: number;
  solarW: number;
  dieselW: number;
  dieselDormant: boolean;
  batteryW: number;
  soc: number | null;
  fuel: number | null;
}) {
  const flowClass = (watts_: number) =>
    Math.abs(watts_) < 1 ? 'flow-line flow-line-idle' : Math.abs(watts_) > 4000 ? 'flow-line flow-line-fast' : 'flow-line';
  const batteryIdle = Math.abs(batteryW) < 1;
  const batteryArrow: Arrow = batteryIdle ? 'inert' : batteryW > 0 ? 'nominal' : 'caution';
  const batteryWord = batteryIdle ? 'idle' : batteryW > 0 ? 'charging' : 'discharging';
  const solarArrow: Arrow = Math.abs(solarW) < 1 ? 'inert' : 'opg';
  const dieselArrow: Arrow = dieselDormant ? 'inert' : 'caution';
  const edge = (arrow: Arrow) => ({ stroke: `var(--${arrow})` });

  return (
    <div className="rounded border border-base-700 bg-base-950/70">
      <svg viewBox="0 0 720 320" className="mx-auto h-auto max-h-[38vh] w-full" role="img" aria-label="Energy flow diagram">
        <defs>
          {ARROWS.map((arrow) => (
            <marker key={arrow} id={`arrow-${arrow}`} markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" style={{ fill: `var(--${arrow})` }} />
            </marker>
          ))}
        </defs>

        {/* Links first, so nodes draw over the ends. The battery link reverses when it discharges. */}
        <g fill="none" strokeWidth="3">
          <path d="M150 70 H300" className={flowClass(solarW)} style={edge(solarArrow)} markerEnd={`url(#arrow-${solarArrow})`} />
          <path d="M150 250 H330 V205" className={flowClass(dieselDormant ? 0 : dieselW)} style={edge(dieselArrow)} markerEnd={`url(#arrow-${dieselArrow})`} />
          <path
            d={batteryW >= 0 ? 'M420 160 H560' : 'M560 160 H420'}
            className={flowClass(batteryW)}
            style={edge(batteryArrow)}
            markerEnd={`url(#arrow-${batteryArrow})`}
          />
          <path d="M390 200 V265 H435" className={flowClass(load)} style={edge('rta')} markerEnd="url(#arrow-rta)" />
        </g>

        {/* Edge labels: the kW on every link, so the picture reads without hovering. */}
        <EdgeLabel x={225} y={60} text={kw(solarW)} arrow={solarArrow} />
        <EdgeLabel x={225} y={240} text={dieselDormant ? 'dormant' : kw(dieselW)} arrow={dieselArrow} />
        <EdgeLabel x={490} y={150} text={batteryIdle ? 'idle' : `${batteryWord} ${kw(batteryW)}`} arrow={batteryArrow} />
        <EdgeLabel x={420} y={226} text={kw(load)} arrow="rta" />

        <Node x={40} y={30} w={110} h={80} title="Solar PV" value={watts(solarW)} tone="var(--opg)" />
        <Node
          x={40}
          y={210}
          w={110}
          h={80}
          title="Diesel"
          value={dieselDormant ? 'dormant' : watts(dieselW)}
          tone={dieselDormant ? 'var(--inert)' : 'var(--caution)'}
          dim={dieselDormant}
          note={fuel !== null ? `${fuel.toFixed(0)}% fuel` : undefined}
        />
        <Node x={300} y={130} w={120} h={70} title="Inverter / bus" value={watts(generation)} tone="var(--rta)" note={`load ${watts(load)}`} />
        <Node
          x={560}
          y={120}
          w={120}
          h={80}
          title="Battery"
          value={watts(Math.abs(batteryW))}
          tone={`var(--${batteryArrow})`}
          note={`${batteryWord}${soc !== null ? ` \u00b7 ${soc.toFixed(0)}%` : ''}`}
        />
        <Node x={440} y={235} w={140} h={60} title="Lab load" value={watts(load)} tone="var(--ink-300)" />
      </svg>
    </div>
  );
}

function EdgeLabel({ x, y, text, arrow }: { x: number; y: number; text: string; arrow: Arrow }) {
  return (
    <text
      x={x}
      y={y}
      textAnchor="middle"
      style={{ fill: arrow === 'inert' ? 'var(--inert)' : 'var(--ink-300)' }}
      fontSize="11"
      fontFamily="JetBrains Mono, monospace"
    >
      {text}
    </text>
  );
}

function Node({
  x,
  y,
  w,
  h,
  title,
  value,
  note,
  tone,
  dim = false,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  value: string;
  note?: string;
  /** A CSS colour, normally `var(--token)`. */
  tone: string;
  /** Dormant source: the whole node goes `inert` rather than showing a live-looking zero. */
  dim?: boolean;
}) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx="6" style={{ fill: 'var(--panel)', stroke: tone }} strokeWidth="1.5" strokeDasharray={dim ? '4 3' : undefined} />
      <text x={x + 10} y={y + 20} style={{ fill: dim ? 'var(--inert)' : 'var(--ink-300)' }} fontSize="11" fontFamily="Inter, system-ui, sans-serif" letterSpacing="1">
        {title.toUpperCase()}
      </text>
      <text x={x + 10} y={y + 44} style={{ fill: dim ? 'var(--inert)' : 'var(--ink-100)' }} fontSize="17" fontWeight="700" fontFamily="JetBrains Mono, monospace">
        {value}
      </text>
      {note ? (
        <text x={x + 10} y={y + 62} style={{ fill: 'var(--ink-400)' }} fontSize="11" fontFamily="JetBrains Mono, monospace">
          {note}
        </text>
      ) : null}
    </g>
  );
}

/**
 * Binary by design (§5.3): sign, colour and word come from the one comparison, so they can never
 * disagree, and a small deficit is drawn exactly like a large one.
 */
function MarginHud({
  generation,
  load,
  margin,
  known,
}: {
  generation: number;
  load: number;
  margin: number;
  /** False until the first power sample: a missing reading is not a zero-kW surplus. */
  known: boolean;
}) {
  const deficit = margin < 0;
  const ink = !known ? 'text-ink-500' : deficit ? 'text-crit' : 'text-ok';
  return (
    <Panel>
      <PanelHead title="Power margin" hint={'\u0394P = generation \u2212 load'} icon={<Power size={13} />} />
      <div className={`telemetry-readout text-3xl font-bold leading-none ${ink}`}>
        {known ? signed(margin / 1000, 1) : '--'}
        <span className="ml-1 text-sm font-normal text-ink-400">kW</span>
      </div>
      <div className={`mt-1 text-2xs uppercase tracking-wider ${ink}`}>
        {!known ? 'no reading' : deficit ? 'deficit \u00b7 discharging' : 'surplus \u00b7 charging'}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <div className="h-2 flex-1 overflow-hidden rounded bg-base-800">
          <div
            className={`h-full ${deficit ? 'bg-crit' : 'bg-ok'}`}
            style={{ width: `${Math.min(100, Math.abs(margin / Math.max(1, generation)) * 100)}%` }}
          />
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-3">
        <Datum label="generation" value={watts(generation)} tone="ok" />
        <Datum label="load" value={watts(load)} tone="neutral" />
      </div>
    </Panel>
  );
}

const SOC_SEGMENTS = 10;
const SOC_FILL: Record<SocBand, string> = { ok: 'bg-ok', warn: 'bg-warn', crit: 'bg-crit soc-blink' };
const SOC_TEXT: Record<SocBand, string> = { ok: 'text-ok', warn: 'text-warn', crit: 'text-crit soc-blink' };

/**
 * Ten segments (a quantity, not a percentage bar), coloured by `socBand`. The warn and reserve
 * breaks are marked on the bar so a reserve change visibly moves the crimson boundary, and the
 * projected time to reserve is shown in every band, not only the lowest.
 */
function SocGauge({
  soc,
  batteryW,
  warnPct,
  reservePct,
  remaining,
}: {
  soc: number | null;
  batteryW: number | null;
  warnPct: number | null;
  reservePct: number | null;
  remaining: string;
}) {
  const band = socBand(soc, warnPct, reservePct);
  const filled = soc === null ? 0 : Math.round((Math.max(0, Math.min(100, soc)) / 100) * SOC_SEGMENTS);
  const fill = band ? SOC_FILL[band] : 'bg-inert';
  const idle = batteryW === null || Math.abs(batteryW) < 1;
  const mode = idle ? 'idle' : batteryW > 0 ? 'charging' : 'discharging';
  const breaks = [
    { at: reservePct, label: 'reserve', className: 'bg-crit' },
    { at: warnPct, label: 'warn', className: 'bg-warn' },
  ].filter((mark): mark is { at: number; label: string; className: string } => mark.at !== null);

  return (
    <Panel>
      <PanelHead
        title="Battery state of charge"
        icon={<BatteryCharging size={13} />}
        right={band === 'crit' ? <Pill tone="crit">below reserve</Pill> : warnPct === null ? <Pill tone="inert">no limits</Pill> : null}
      />
      <div
        className={`telemetry-readout text-3xl font-bold leading-none ${band ? SOC_TEXT[band] : 'text-ink-500'}`}
        title={band ? undefined : 'ARL alert limits unavailable, SOC band suppressed'}
      >
        {pct(soc, 1)}
      </div>
      <div className="relative mt-2">
        <div className="flex h-6 gap-0.5">
          {Array.from({ length: SOC_SEGMENTS }, (_, index) => (
            <span key={index} className={`flex-1 rounded-sm ${index < filled ? fill : 'bg-base-700 opacity-60'}`} />
          ))}
        </div>
        {breaks.map((mark) => (
          <span
            key={mark.label}
            className={`absolute -bottom-1 -top-1 w-px ${mark.className}`}
            style={{ left: `${Math.max(0, Math.min(100, mark.at))}%` }}
            title={`${mark.label} ${mark.at}%`}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-2xs text-ink-500">
        <span>{reservePct !== null ? `reserve ${num(reservePct, 0)}%` : 'reserve --'}</span>
        <span>{warnPct !== null ? `warn ${num(warnPct, 0)}%` : 'warn limit unavailable'}</span>
      </div>
      <div className="mt-1 grid grid-cols-2 gap-x-3">
        {/* ∞ while charging or idle: the battery is not heading for the reserve, so there is no projection. */}
        <Datum
          label="to reserve"
          value={remaining === '\u2014' && batteryW !== null && mode !== 'discharging' ? '\u221e' : remaining}
          tone={band ?? 'inert'}
        />
        <Datum label="mode" value={mode} tone={idle ? 'inert' : 'neutral'} />
      </div>
    </Panel>
  );
}

function TrendGrid({ warnPct }: { warnPct: number | null }) {
  const margin = useSeries({ service: 'opg', stream: 'power', field: 'total_generation_w' });
  const load = useSeries({ service: 'opg', stream: 'power', field: 'total_load_w' });
  const soc = useSeries({ service: 'opg', stream: 'power', entity: 'batteries', field: 'state_of_charge_pct' });

  return (
    <div className="grid gap-3 md:grid-cols-3">
      <div>
        <div className="mb-0.5 flex justify-between text-2xs uppercase tracking-wider text-ink-400">
          <span>generation mean</span>
          <span className="telemetry-readout">{watts(live.latestField('opg', 'power', 'total_generation_w'))}</span>
        </div>
        <LineChart points={margin.points} color="var(--opg)" height={60} digits={0} />
      </div>
      <div>
        <div className="mb-0.5 flex justify-between text-2xs uppercase tracking-wider text-ink-400">
          <span>load</span>
          <span className="telemetry-readout">{watts(live.latestField('opg', 'power', 'total_load_w'))}</span>
        </div>
        <LineChart points={load.points} color="var(--rta)" height={60} digits={0} />
      </div>
      <div>
        <div className="mb-0.5 flex justify-between text-2xs uppercase tracking-wider text-ink-400">
          <span>state of charge</span>
          <span className="telemetry-readout">{pct(live.latestField('opg', 'power', 'state_of_charge_pct'))}</span>
        </div>
        <LineChart
          points={soc.points}
          color="var(--nominal)"
          height={60}
          threshold={warnPct === null ? null : { value: warnPct }}
          digits={0}
        />
      </div>
    </div>
  );
}

function PowerControls() {
  const { send, pending, error, message } = useCommand();
  const [code] = useResearcher();
  const [reserve, setReserve] = useState('20');
  useLive();
  const disabled = code.trim().length < 3;
  const priority = String(live.state('opg', 'global', 'generation_priority') ?? 'solar_first');
  const generator = String(live.sample('opg', 'power', 'diesel')?.data.generator_status ?? '');

  return (
    <Panel>
      <PanelHead title="Dispatch control" hint="service-wide" icon={<Fuel size={13} />} />
      <div className="grid gap-2">
        <Field label="Generation priority" hint="policy">
          <Select
            value={priority}
            disabled={disabled}
            onChange={(event) =>
              void send({
                service: 'opg',
                entity: 'global',
                control: 'generation_priority',
                value: event.target.value,
                researcher: code,
              })
            }
          >
            <option value="solar_first">solar_first</option>
            <option value="battery_first">battery_first</option>
            <option value="diesel_first">diesel_first</option>
          </Select>
        </Field>

        <Button
          tone={live.state('opg', 'global', 'load_shed') === true ? 'warn' : 'default'}
          busy={pending === 'global/load_shed'}
          disabled={disabled}
          onClick={() =>
            void send({
              service: 'opg',
              entity: 'global',
              control: 'load_shed',
              value: live.state('opg', 'global', 'load_shed') !== true,
              researcher: code,
            })
          }
        >
          <Power size={12} /> {live.state('opg', 'global', 'load_shed') === true ? 'end load shed' : 'shed non-critical load'}
        </Button>

        <Button
          busy={pending === 'solar/enable_solar_array'}
          disabled={disabled}
          onClick={() =>
            void send({
              service: 'opg',
              entity: 'solar',
              control: 'enable_solar_array',
              value: live.state('opg', 'solar', 'enabled') !== true,
              researcher: code,
            })
          }
        >
          <Sun size={12} /> {live.state('opg', 'solar', 'enabled') !== true ? 'enable solar array' : 'disable solar array'}
        </Button>

        <SectionLabel>Battery reserve</SectionLabel>
        <Field label="Reserve floor" hint="10 - 80 %">
          <div className="flex gap-1.5">
            <TextInput value={reserve} onChange={(event) => setReserve(event.target.value)} inputMode="decimal" />
            <Button
              busy={pending === 'batteries/battery_reserve'}
              disabled={disabled}
              onClick={() =>
                void send({
                  service: 'opg',
                  entity: 'batteries',
                  control: 'battery_reserve',
                  value: Number(reserve),
                  researcher: code,
                })
              }
            >
              set
            </Button>
          </div>
        </Field>

        <SectionLabel>Diesel generator</SectionLabel>
        <div className="grid grid-cols-2 gap-1.5">
          <Button
            tone="primary"
            busy={pending === 'diesel/start_generator'}
            disabled={disabled || generator === 'running'}
            onClick={() =>
              void send({
                service: 'opg',
                entity: 'diesel',
                control: 'start_generator',
                value: true,
                researcher: code,
              })
            }
          >
            start
          </Button>
          <Button
            tone="danger"
            busy={pending === 'diesel/stop_generator'}
            disabled={disabled || generator === 'stopped'}
            onClick={() =>
              void send({
                service: 'opg',
                entity: 'diesel',
                control: 'stop_generator',
                value: true,
                researcher: code,
              })
            }
          >
            stop
          </Button>
        </div>

        <div className="rounded border border-base-700 bg-base-950/60 px-2 py-1.5 text-2xs text-ink-500">
          <div className="flex justify-between">
            <span>priority policy</span>
            <span className="telemetry-readout text-ink-300">{priority}</span>
          </div>
          <div className="mt-0.5 flex justify-between">
            <span>generator</span>
            <span className="telemetry-readout text-ink-300">{generator || '\u2014'}</span>
          </div>
          <div className="mt-0.5 flex justify-between">
            <span>last refuel</span>
            <span className="telemetry-readout text-ink-300">
              {clockTime(live.services.get('opg')?.events.find((e) => e.name === 'refuel')?.ts)}
            </span>
          </div>
        </div>

        <CommandFeedback error={error} message={message} />
      </div>
    </Panel>
  );
}
