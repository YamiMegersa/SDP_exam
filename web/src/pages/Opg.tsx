import { useState } from 'react';
import { BatteryCharging, Fuel, Gauge, Power, Sun, Zap } from 'lucide-react';
import { LineChart } from '../components/charts';
import { CommandFeedback, CommandLog, useCommand } from '../components/commands';
import { DerivedDatum, useMeasures } from '../components/derived';
import { Button, Datum, Field, Panel, PanelHead, Pill, SectionLabel, Select, TextInput } from '../components/ui';
import { clockTime, num, pct, signed, toNumber as number, watts } from '../lib/format';
import { useLive, useResearcher, useSeries } from '../lib/hooks';
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
 */

export function OpgPage() {
  useLive();
  const service = live.services.get('opg');
  const measures = useMeasures('opg');

  if (!service?.topology) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-ink-500">
        waiting for the OPG topology&hellip;
      </div>
    );
  }

  const total = live.sample('opg', 'power', 'global')?.data ?? {};
  const solar = live.sample('opg', 'power', 'solar')?.data ?? {};
  const battery = live.sample('opg', 'power', 'batteries')?.data ?? {};
  const diesel = live.sample('opg', 'power', 'diesel')?.data ?? {};

  const generation = number(total.total_generation_w) ?? 0;
  const load = number(total.total_load_w) ?? 0;
  const margin = generation - load;

  return (
    <div className="grid min-h-0 flex-1 gap-2 overflow-y-auto p-2 xl:grid-cols-[minmax(0,1fr)_350px] xl:overflow-hidden">
      <div className="flex min-h-0 flex-col gap-2 xl:overflow-y-auto scroll-thin">
        <Panel>
          <PanelHead
            title="Energy flow"
            hint="solar \u2192 bus \u2190 diesel, bus \u2194 battery, bus \u2192 base load"
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
            dieselW={number(diesel.power_output_w) ?? 0}
            batteryW={number(battery.battery_power_w) ?? 0}
            soc={number(battery.state_of_charge_pct)}
            fuel={number(diesel.fuel_level_pct)}
          />
        </Panel>

        <div className="grid gap-2 md:grid-cols-3">
          <MarginHud generation={generation} load={load} margin={margin} />
          <SocGauge soc={number(battery.state_of_charge_pct)} batteryW={number(battery.battery_power_w)} />
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
              <Datum label="diesel output" value={watts(diesel.power_output_w)} tone="opg" />
              <Datum label="generator" value={String(diesel.generator_status ?? '\u2014')} />
              <Datum label="fuel" value={pct(diesel.fuel_level_pct)} tone={number(diesel.fuel_level_pct) !== null && (number(diesel.fuel_level_pct) ?? 100) < 20 ? 'crit' : 'neutral'} />
              <Datum label="runtime" value={`${num(diesel.runtime_h, 1)} h`} />
            </div>
          </Panel>
        </div>

        <Panel>
          <PanelHead title="Trends" hint="generation margin, load and state of charge" icon={<Gauge size={13} />} />
          <TrendGrid />
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

function EnergyFlow({
  generation,
  load,
  solarW,
  dieselW,
  batteryW,
  soc,
  fuel,
}: {
  generation: number;
  load: number;
  solarW: number;
  dieselW: number;
  batteryW: number;
  soc: number | null;
  fuel: number | null;
}) {
  const flowClass = (watts_: number) =>
    Math.abs(watts_) < 1 ? 'flow-line flow-line-idle' : watts_ > 4000 ? 'flow-line flow-line-fast' : 'flow-line';

  return (
    <div className="rounded border border-base-700 bg-base-950/70">
      <svg viewBox="0 0 720 320" className="h-auto w-full" role="img" aria-label="Energy flow diagram">
        <defs>
          <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="#facc15" />
          </marker>
          <marker id="arrow-dim" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="#475569" />
          </marker>
        </defs>

        {/* Links first, so nodes draw over the ends. */}
        <g fill="none" strokeWidth="3" markerEnd="url(#arrow)">
          <path d="M150 70 H300" className={flowClass(solarW)} stroke="#facc15" />
          <path d="M150 250 H300" className={flowClass(dieselW)} stroke="#f59e0b" />
          <path d="M420 160 H560" className={flowClass(batteryW)} stroke={batteryW >= 0 ? '#10b981' : '#f59e0b'} />
          <path d="M360 200 V250 H300" className={flowClass(load)} stroke="#38bdf8" />
        </g>

        <Node x={40} y={30} w={110} h={80} title="Solar PV" value={watts(solarW)} tone="#facc15" />
        <Node x={40} y={210} w={110} h={80} title="Diesel" value={watts(dieselW)} tone="#f59e0b" note={fuel !== null ? `${fuel.toFixed(0)}% fuel` : undefined} />
        <Node x={300} y={130} w={120} h={70} title="Bus" value={watts(generation)} tone="#38bdf8" note={`load ${watts(load)}`} />
        <Node x={560} y={120} w={120} h={80} title="Battery" value={watts(Math.abs(batteryW))} tone="#10b981" note={soc !== null ? `${soc.toFixed(0)}% soc` : undefined} />
        <Node x={240} y={250} w={140} h={60} title="Base load" value={watts(load)} tone="#94a3b8" />

        <text x="215" y="60" fill="#64748b" fontSize="11" fontFamily="JetBrains Mono, monospace">
          DC
        </text>
        <text x="480" y="150" fill="#64748b" fontSize="11" fontFamily="JetBrains Mono, monospace">
          {batteryW >= 0 ? 'charge' : 'discharge'}
        </text>
      </svg>
    </div>
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
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  value: string;
  note?: string;
  tone: string;
}) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx="6" fill="#111827" stroke={tone} strokeWidth="1.5" />
      <text x={x + 10} y={y + 20} fill="#94a3b8" fontSize="11" fontFamily="Inter, system-ui, sans-serif" letterSpacing="1">
        {title.toUpperCase()}
      </text>
      <text x={x + 10} y={y + 44} fill="#f1f5f9" fontSize="17" fontWeight="700" fontFamily="JetBrains Mono, monospace">
        {value}
      </text>
      {note ? (
        <text x={x + 10} y={y + 62} fill="#64748b" fontSize="11" fontFamily="JetBrains Mono, monospace">
          {note}
        </text>
      ) : null}
    </g>
  );
}

function MarginHud({ generation, load, margin }: { generation: number; load: number; margin: number }) {
  const deficit = margin < 0;
  const severe = margin < -5000;
  return (
    <Panel>
      <PanelHead title="Power margin" icon={<Power size={13} />} />
      <div className={`telemetry-readout text-3xl font-bold leading-none ${severe ? 'text-crit' : deficit ? 'text-warn' : 'text-ok'}`}>
        {signed(margin / 1000, 1)}
        <span className="ml-1 text-sm font-normal text-ink-400">kW</span>
      </div>
      <div className="mt-1 text-2xs uppercase tracking-wider text-ink-500">
        {deficit ? 'discharging / deficit' : 'surplus / charging'}
      </div>
      <div className="mt-2 flex items-center gap-2">
        <div className="h-2 flex-1 overflow-hidden rounded bg-base-800">
          <div
            className={`h-full ${deficit ? 'bg-warn' : 'bg-ok'}`}
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

function SocGauge({ soc, batteryW }: { soc: number | null; batteryW: number | null }) {
  const value = soc ?? 0;
  const tone = value < 15 ? 'crit' : value < 25 ? 'warn' : value < 50 ? 'warn' : 'ok';
  const color = tone === 'crit' ? '#ef4444' : tone === 'warn' ? '#f59e0b' : '#10b981';
  const segments = 20;
  const filled = Math.round((value / 100) * segments);

  return (
    <Panel>
      <PanelHead
        title="Battery state of charge"
        icon={<BatteryCharging size={13} />}
        right={value < 15 ? <Pill tone="crit">critical</Pill> : null}
      />
      <div className={`telemetry-readout text-3xl font-bold leading-none ${tone === 'crit' ? 'animate-pulse text-crit' : tone === 'warn' ? 'text-warn' : 'text-ok'}`}>
        {pct(value, 1)}
      </div>
      <div className="mt-2 flex h-6 gap-0.5">
        {Array.from({ length: segments }, (_, index) => (
          <span
            key={index}
            className="flex-1 rounded-sm"
            style={{
              backgroundColor: index < filled ? color : '#1f293d',
              opacity: index < filled ? 1 : 0.6,
            }}
          />
        ))}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-3">
        <Datum label="flow" value={watts(batteryW === null ? null : Math.abs(batteryW))} tone={(batteryW ?? 0) >= 0 ? 'ok' : 'warn'} />
        <Datum label="mode" value={(batteryW ?? 0) >= 0 ? 'charging' : 'discharging'} tone="neutral" />
      </div>
    </Panel>
  );
}

function TrendGrid() {
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
        <LineChart points={margin.points} color="#facc15" height={60} digits={0} />
      </div>
      <div>
        <div className="mb-0.5 flex justify-between text-2xs uppercase tracking-wider text-ink-400">
          <span>load</span>
          <span className="telemetry-readout">{watts(live.latestField('opg', 'power', 'total_load_w'))}</span>
        </div>
        <LineChart points={load.points} color="#38bdf8" height={60} digits={0} />
      </div>
      <div>
        <div className="mb-0.5 flex justify-between text-2xs uppercase tracking-wider text-ink-400">
          <span>state of charge</span>
          <span className="telemetry-readout">{pct(live.latestField('opg', 'power', 'state_of_charge_pct'))}</span>
        </div>
        <LineChart points={soc.points} color="#10b981" height={60} threshold={{ value: 25 }} digits={0} />
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
