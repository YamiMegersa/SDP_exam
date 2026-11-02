import { useMemo, useState } from 'react';
import { Activity, Droplets, HeartPulse, Leaf, Lock, Thermometer, Wind, Users } from 'lucide-react';
import { LineChart, MicroMeter } from '../components/charts';
import { CommandFeedback, CommandLog, useCommand } from '../components/commands';
import { DerivedDatum, useMeasures } from '../components/derived';
import { Button, Datum, Field, Panel, PanelHead, Pill, SectionLabel, Select, TextInput } from '../components/ui';
import { clockTime, kelvinToC, num, pct, toNumber } from '../lib/format';
import { useLive, useResearcher, useSeries } from '../lib/hooks';
import { live } from '../lib/live';

/**
 * Mars Habitation Experiment workspace.
 *
 * The interesting reading is not any single room, it is the *relationship*: CO2
 * rising in a sealed room with no ventilation is a different situation from the
 * same CO2 with the scrubbers running. The plan view therefore colours by hazard
 * and the detail panel always shows the setpoint that the room is being held
 * against, so "is this bad?" is answerable without a second screen.
 */

const CO2_WARN = 1000;
const CO2_CRIT = 1200;

interface RoomBox {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Room geometry lifted verbatim from the supplied
 * `mars-habitation-experiment-room-layout.svg`, so the console matches the
 * archived facility drawing. Doors are omitted: at this scale they are noise.
 */
const ROOMS: RoomBox[] = [
  { id: 'quarters-1', label: 'Q1', x: 40, y: 40, width: 120, height: 120 },
  { id: 'quarters-2', label: 'Q2', x: 170, y: 40, width: 120, height: 120 },
  { id: 'quarters-3', label: 'Q3', x: 300, y: 40, width: 120, height: 120 },
  { id: 'quarters-4', label: 'Q4', x: 430, y: 40, width: 120, height: 120 },
  { id: 'quarters-5', label: 'Q5', x: 560, y: 40, width: 120, height: 120 },
  { id: 'common', label: 'Common', x: 40, y: 160, width: 380, height: 200 },
  { id: 'lab', label: 'Lab', x: 420, y: 160, width: 260, height: 200 },
  { id: 'hydroponics', label: 'Hydroponics', x: 40, y: 360, width: 490, height: 160 },
  { id: 'airlock', label: 'Airlock', x: 530, y: 360, width: 150, height: 160 },
];

export function MhePage() {
  useLive();
  const service = live.services.get('mhe');
  const measures = useMeasures('mhe');
  const [selected, setSelected] = useState<string | null>(null);

  if (!service?.topology) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-ink-500">
        waiting for the MHE topology&hellip;
      </div>
    );
  }

  const missionState = String(live.state('mhe', 'global', 'mission_state') ?? 'unknown');
  const crew = service.topology.entities.filter((entity) => entity.kind === 'crew');

  return (
    <div className="grid min-h-0 flex-1 gap-2 overflow-y-auto p-2 xl:grid-cols-[minmax(0,1fr)_350px] xl:overflow-hidden">
      <div className="flex min-h-0 flex-col gap-2 xl:overflow-y-auto scroll-thin">
        <Panel>
          <PanelHead
            title="Habitat plan"
            hint="9 compartments · live hazard colouring"
            icon={<Users size={13} />}
            right={
              <>
                <Pill tone={service.online ? 'ok' : 'crit'}>{service.online ? 'online' : 'offline'}</Pill>
                <Pill tone="mhe">{missionState}</Pill>
              </>
            }
          />
          <HabitatPlan selected={selected} onSelect={setSelected} />
          <div className="mt-2 flex flex-wrap items-center gap-3 text-2xs text-ink-500">
            <LegendSwatch className="bg-ok/50" label="nominal" />
            <LegendSwatch className="bg-warn/50" label={`CO2 > ${CO2_WARN} ppm`} />
            <LegendSwatch className="bg-crit/60" label={`CO2 > ${CO2_CRIT} ppm`} />
            <LegendSwatch className="bg-inhand/40" label="sealed / depressurised" />
            <span className="ml-auto flex items-center gap-1">
              <Lock size={11} /> airlock state drives the sealed overlay
            </span>
          </div>
        </Panel>

        <div className="grid gap-2 lg:grid-cols-2">
          <RoomDetail room={selected} />
          <CrewStrip crew={crew.map((entity) => entity.id)} />
        </div>
      </div>

      <div className="flex min-h-0 flex-col gap-2 xl:overflow-y-auto scroll-thin">
        <Panel>
          <PanelHead title="Derived" hint="occupancy, stress, air" icon={<Activity size={13} />} />
          <DerivedDatum measure={measures.get('mhe.headcount')} label="headcount" />
          <DerivedDatum measure={measures.get('mhe.stress_index')} label="stress index" />
          <DerivedDatum measure={measures.get('mhe.co2_mean')} label="mean co2" />
        </Panel>
        <HabitatControls room={selected} />
        <Panel>
          <PanelHead title="Command log" hint="last 8" />
          <CommandLog service="mhe" />
        </Panel>
      </div>
    </div>
  );
}

function LegendSwatch({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`h-2 w-2 rounded-sm ${className}`} />
      {label}
    </span>
  );
}

function HabitatPlan({ selected, onSelect }: { selected: string | null; onSelect: (id: string) => void }) {
  useLive();

  return (
    <div className="rounded border border-base-700 bg-base-950/60 p-1">
      <svg viewBox="0 0 720 560" className="h-auto w-full" role="img" aria-label="Habitat floor plan">
        <rect x="30" y="30" width="660" height="500" rx="12" fill="none" stroke="#283548" strokeWidth="4" />
        {ROOMS.map((room) => {
          const env = live.sample('mhe', 'environment', room.id)?.data;
          const airlock = live.sample('mhe', 'airlock', room.id)?.data;
          const sealed = live.state('mhe', room.id, 'sealed') === true;
          const co2 = toNumber(env?.co2_ppm);
          const depressurised = room.id === 'airlock' && airlock?.airlock_state === 'depressurized';

          const fill =
            co2 === null
              ? '#151d2b'
              : co2 >= CO2_CRIT
                ? 'rgba(239,68,68,0.34)'
                : co2 >= CO2_WARN
                  ? 'rgba(245,158,11,0.28)'
                  : 'rgba(16,185,129,0.16)';
          const stroke =
            co2 === null
              ? '#1f293d'
              : co2 >= CO2_CRIT
                ? '#ef4444'
                : co2 >= CO2_WARN
                  ? '#f59e0b'
                  : '#10b981';
          const isSelected = selected === room.id;
          const temp = toNumber(env?.temperature_k);
          const occupancy = toNumber(env?.crew_count) ?? 0;

          return (
            <g
              key={room.id}
              onClick={() => onSelect(room.id)}
              className="cursor-pointer"
              role="button"
              aria-label={room.id}
            >
              <rect
                x={room.x}
                y={room.y}
                width={room.width}
                height={room.height}
                rx="3"
                fill={fill}
                stroke={isSelected ? '#38bdf8' : stroke}
                strokeWidth={isSelected ? 4 : 2}
              />
              {sealed || depressurised ? (
                <rect
                  x={room.x + 6}
                  y={room.y + 6}
                  width={room.width - 12}
                  height={room.height - 12}
                  fill="none"
                  stroke="#6366f1"
                  strokeWidth="1.5"
                  strokeDasharray="6 4"
                />
              ) : null}

              <text
                x={room.x + 10}
                y={room.y + 26}
                fill="#f1f5f9"
                fontSize="19"
                fontWeight="600"
                fontFamily="Inter, system-ui, sans-serif"
              >
                {room.label}
              </text>

              {room.width > 140 ? (
                <>
                  <text
                    x={room.x + 10}
                    y={room.y + 52}
                    fill="#cbd5e1"
                    fontSize="17"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    {kelvinToC(temp, 0)}
                  </text>
                  <text
                    x={room.x + 10}
                    y={room.y + 76}
                    fill={co2 !== null && co2 >= CO2_WARN ? '#fbbf24' : '#94a3b8'}
                    fontSize="17"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    {num(co2, 0)} ppm
                  </text>
                  <text
                    x={room.x + 10}
                    y={room.y + 100}
                    fill="#64748b"
                    fontSize="16"
                    fontFamily="JetBrains Mono, monospace"
                  >
                    {num(env?.humidity_pct, 0)}% rh &middot; {num(env?.pressure_kpa, 1)} kPa
                  </text>
                  {occupancy > 0 ? (
                    <g>
                      <circle cx={room.x + room.width - 26} cy={room.y + 24} r="14" fill="#1f293d" stroke="#38bdf8" />
                      <text
                        x={room.x + room.width - 26}
                        y={room.y + 30}
                        fill="#e2e8f0"
                        fontSize="16"
                        textAnchor="middle"
                        fontFamily="JetBrains Mono, monospace"
                      >
                        {occupancy}
                      </text>
                    </g>
                  ) : null}
                </>
              ) : null}

              {room.id === 'airlock' && airlock ? (
                <text
                  x={room.x + room.width / 2}
                  y={room.y + room.height - 18}
                  fill={airlock.airlock_state === 'pressurized' ? '#10b981' : '#fbbf24'}
                  fontSize="15"
                  textAnchor="middle"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {String(airlock.airlock_state)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function RoomDetail({ room }: { room: string | null }) {
  useLive();
  if (!room) {
    return (
      <Panel>
        <PanelHead title="Compartment detail" />
        <p className="rounded border border-dashed border-base-700 px-2 py-6 text-center text-2xs text-ink-500">
          select a compartment in the plan
        </p>
      </Panel>
    );
  }

  const env = live.sample('mhe', 'environment', room)?.data ?? {};
  const hydro = live.sample('mhe', 'hydroponics', room)?.data;
  const airlock = live.sample('mhe', 'airlock', room)?.data;
  const equipment = live.sample('mhe', 'equipment', room)?.data;
  const setpoints = (live.state('mhe', room, 'setpoints') ?? {}) as Record<string, unknown>;
  const co2 = toNumber(env.co2_ppm);
  const tempTrend = useSeries({ service: 'mhe', stream: 'environment', entity: room, field: 'temperature_k' });
  const co2Trend = useSeries({ service: 'mhe', stream: 'environment', entity: room, field: 'co2_ppm' });

  return (
    <Panel>
      <PanelHead
        title={room}
        icon={<Thermometer size={13} />}
        right={
          <>
            <Pill tone={co2 !== null && co2 >= CO2_CRIT ? 'crit' : co2 !== null && co2 >= CO2_WARN ? 'warn' : 'ok'}>
              {co2 !== null && co2 >= CO2_WARN ? 'co2 high' : 'atmosphere ok'}
            </Pill>
            {live.state('mhe', room, 'sealed') === true ? <Pill tone="inhand">sealed</Pill> : null}
          </>
        }
      />
      <div className="grid grid-cols-2 gap-x-3">
        <Datum label="temperature" value={kelvinToC(env.temperature_k)} />
        <Datum label="setpoint" value={kelvinToC(setpoints.temperature_k)} />
        <Datum label="humidity" value={pct(env.humidity_pct)} />
        <Datum label="sp rh" value={pct(setpoints.humidity_pct)} />
        <Datum label="co2" value={`${num(env.co2_ppm, 0)} ppm`} tone={co2 !== null && co2 >= CO2_WARN ? 'warn' : 'ok'} />
        <Datum label="o2" value={`${num(env.oxygen_ppm, 0)} ppm`} />
        <Datum label="pressure" value={`${num(env.pressure_kpa, 1)} kPa`} />
        <Datum label="ventilation" value={`${num(env.ventilation_m3h, 0)} m3/h`} />
        <Datum label="lighting" value={`${num(env.lighting_lux, 0)} lx`} />
        <Datum label="occupancy" value={num(env.crew_count, 0)} />
      </div>

      <div className="mt-1.5 grid grid-cols-2 gap-2">
        <div>
          <div className="mb-0.5 text-2xs uppercase tracking-wider text-ink-400">co2 ppm</div>
          <LineChart points={co2Trend.points} color="#f59e0b" height={38} threshold={{ value: CO2_WARN }} digits={0} />
        </div>
        <div>
          <div className="mb-0.5 text-2xs uppercase tracking-wider text-ink-400">temperature</div>
          <LineChart points={tempTrend.points} color="#fb923c" height={38} digits={0} />
        </div>
      </div>

      {hydro ? (
        <>
          <SectionLabel>Hydroponics</SectionLabel>
          <div className="grid grid-cols-2 gap-x-3">
            <Datum label="water" value={`${num(hydro.water_level_l, 0)} L`} />
            <Datum label="ec" value={`${num(hydro.nutrient_ec_mscm, 2)} mS/cm`} />
            <Datum label="ph" value={num(hydro.water_ph, 2)} />
            <Datum label="stage" value={String(hydro.growth_stage ?? '\u2014')} />
            <Datum label="est. yield" value={`${num(hydro.estimated_yield_kg, 1)} kg`} />
          </div>
        </>
      ) : null}

      {airlock ? (
        <>
          <SectionLabel>Airlock</SectionLabel>
          <div className="grid grid-cols-2 gap-x-3">
            <Datum
              label="state"
              value={String(airlock.airlock_state)}
              tone={airlock.airlock_state === 'pressurized' ? 'ok' : 'warn'}
            />
            <Datum label="inner door" value={String(airlock.inner_door)} />
            <Datum label="outer door" value={String(airlock.outer_door)} />
            <Datum label="eva" value={airlock.eva_in_progress ? 'in progress' : 'none'} tone={airlock.eva_in_progress ? 'warn' : 'neutral'} />
          </div>
        </>
      ) : null}

      {equipment ? (
        <>
          <SectionLabel>Equipment</SectionLabel>
          <p className="telemetry-readout text-2xs text-ink-300">{String(equipment.equipment_status ?? '\u2014')}</p>
        </>
      ) : null}
    </Panel>
  );
}

function CrewStrip({ crew }: { crew: string[] }) {
  useLive();
  const survey = useMemo(() => {
    const service = live.services.get('mhe');
    const event = service?.events.find((entry) => entry.name === 'survey');
    return (event?.payload.surveys ?? event?.payload ?? null) as Record<string, unknown> | null;
  }, [live.getVersion()]);

  return (
    <Panel>
      <PanelHead title="Crew biometrics" hint={`${crew.length} crew`} icon={<HeartPulse size={13} />} />
      <div className="flex flex-col gap-1.5">
        {crew.map((id) => {
          const vitals = live.sample('mhe', 'vitals', id)?.data ?? {};
          const hr = toNumber(vitals.heart_rate_bpm);
          const temp = toNumber(vitals.body_temperature_k);
          const spo2 = toNumber(vitals.spo2_pct);
          const elevated = hr !== null && (hr > 110 || hr < 50);
          const febrile = temp !== null && temp > 310.15;
          const own = (survey?.[id] ?? {}) as Record<string, unknown>;
          return (
            <div key={id} className="rounded border border-base-700 bg-base-950/50 px-2 py-1.5">
              <div className="flex items-center gap-2">
                <span className="telemetry-readout text-2xs font-bold text-mhe">{id}</span>
                <Pill tone={elevated ? 'crit' : 'ok'}>{num(hr, 0)} bpm</Pill>
                <Pill tone={febrile ? 'warn' : 'neutral'}>{kelvinToC(temp, 1)}</Pill>
                <Pill tone={spo2 !== null && spo2 < 94 ? 'warn' : 'neutral'}>SpO2 {num(spo2, 0)}%</Pill>
                <span className="ml-auto telemetry-readout text-2xs text-ink-500">
                  {String(vitals.location ?? '\u2014')}
                </span>
              </div>
              <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
                <MicroMeter label="mood" value={toNumber(own.mood)} />
                <MicroMeter label="stress" value={toNumber(own.stress)} />
                <MicroMeter label="fatigue" value={toNumber(own.fatigue)} />
                <MicroMeter label="sleep" value={toNumber(own.sleep_quality)} />
              </div>
            </div>
          );
        })}
      </div>
      {!survey ? (
        <p className="mt-1.5 text-2xs text-ink-500">
          survey metrics appear with the next <span className="telemetry-readout">events/survey</span> emission
        </p>
      ) : null}
    </Panel>
  );
}

function HabitatControls({ room }: { room: string | null }) {
  const { send, pending, error, message } = useCommand();
  const [code] = useResearcher();
  const [temperature, setTemperature] = useState('295');
  const [humidity, setHumidity] = useState('45');
  const [ventilation, setVentilation] = useState('120');
  const target = room ?? 'common';
  const disabled = code.trim().length < 3;

  return (
    <Panel>
      <PanelHead
        title="Environmental control"
        hint={room ? room : 'defaulting to common'}
        icon={<Wind size={13} />}
      />
      <div className="grid gap-2">
        <Field label="Temperature" hint="285 - 300 K">
          <div className="flex gap-1.5">
            <TextInput value={temperature} onChange={(event) => setTemperature(event.target.value)} inputMode="decimal" />
            <Button
              tone="primary"
              busy={pending === `${target}/adjust_temperature`}
              disabled={disabled}
              onClick={() =>
                void send({
                  service: 'mhe',
                  entity: target,
                  control: 'adjust_temperature',
                  value: Number(temperature),
                  researcher: code,
                })
              }
            >
              set
            </Button>
          </div>
        </Field>

        <Field label="Humidity" hint="20 - 80 %">
          <div className="flex gap-1.5">
            <TextInput value={humidity} onChange={(event) => setHumidity(event.target.value)} inputMode="decimal" />
            <Button
              busy={pending === `${target}/adjust_humidity`}
              disabled={disabled}
              onClick={() =>
                void send({
                  service: 'mhe',
                  entity: target,
                  control: 'adjust_humidity',
                  value: Number(humidity),
                  researcher: code,
                })
              }
            >
              set
            </Button>
          </div>
        </Field>

        <Field label="Ventilation" hint="0 - 400 m3/h">
          <div className="flex gap-1.5">
            <TextInput
              value={ventilation}
              onChange={(event) => setVentilation(event.target.value)}
              inputMode="decimal"
            />
            <Button
              busy={pending === `${target}/ventilation`}
              disabled={disabled}
              onClick={() =>
                void send({
                  service: 'mhe',
                  entity: target,
                  control: 'ventilation',
                  value: Number(ventilation),
                  researcher: code,
                })
              }
            >
              set
            </Button>
          </div>
        </Field>

        <SectionLabel>Systems</SectionLabel>
        <div className="grid grid-cols-2 gap-1.5">
          <Button
            tone={live.state('mhe', target, 'environmental_systems') === false ? 'warn' : 'default'}
            busy={pending === `${target}/environmental_systems`}
            disabled={disabled}
            onClick={() =>
              void send({
                service: 'mhe',
                entity: target,
                control: 'environmental_systems',
                value: live.state('mhe', target, 'environmental_systems') === false,
                researcher: code,
              })
            }
          >
            <Activity size={12} /> {live.state('mhe', target, 'environmental_systems') === false ? 'restore ecs' : 'stop ecs'}
          </Button>
          <Button
            tone={live.state('mhe', target, 'sealed') === true ? 'warn' : 'default'}
            busy={pending === `${target}/seal_room`}
            disabled={disabled}
            onClick={() =>
              void send({
                service: 'mhe',
                entity: target,
                control: 'seal_room',
                value: live.state('mhe', target, 'sealed') !== true,
                researcher: code,
              })
            }
          >
            <Lock size={12} /> {live.state('mhe', target, 'sealed') === true ? 'unseal' : 'seal'}
          </Button>
        </div>

        <SectionLabel>Airlock</SectionLabel>
        <div className="grid grid-cols-2 gap-1.5">
          <Button
            busy={pending === 'airlock/cycle_airlock'}
            disabled={disabled}
            onClick={() =>
              void send({
                service: 'mhe',
                entity: 'airlock',
                control: 'cycle_airlock',
                value: 'pressurise',
                researcher: code,
              })
            }
          >
            <Droplets size={12} /> pressurise
          </Button>
          <Button
            tone="warn"
            busy={pending === 'airlock/cycle_airlock'}
            disabled={disabled}
            onClick={() =>
              void send({
                service: 'mhe',
                entity: 'airlock',
                control: 'cycle_airlock',
                value: 'depressurise',
                researcher: code,
              })
            }
          >
            <Wind size={12} /> depressurise
          </Button>
        </div>

        <SectionLabel>Hydroponics</SectionLabel>
        <Button
          busy={pending === 'hydroponics/irrigation_schedule'}
          disabled={disabled}
          onClick={() =>
            void send({
              service: 'mhe',
              entity: 'hydroponics',
              control: 'irrigation_schedule',
              value: { start: '06:00', end: '06:20', volume_l: 40 },
              researcher: code,
            })
          }
        >
          <Leaf size={12} /> schedule irrigation (06:00, 40 L)
        </Button>

        <SectionLabel>Crew</SectionLabel>
        <Field label="Wellness check" hint="all crew">
          <Select
            value=""
            disabled={disabled}
            onChange={(event) => {
              if (!event.target.value) return;
              void send({
                service: 'mhe',
                entity: event.target.value,
                control: 'crew_wellness_check',
                value: true,
                researcher: code,
              });
            }}
          >
            <option value="">select crew member&hellip;</option>
            {['crew-1', 'crew-2', 'crew-3', 'crew-4', 'crew-5'].map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </Select>
        </Field>

        <div className="rounded border border-base-700 bg-base-950/60 px-2 py-1.5 text-2xs text-ink-500">
          <div className="flex justify-between">
            <span>mission day</span>
            <span className="telemetry-readout text-ink-300">
              {String(live.latestField('mhe', 'habitat', 'mission_day') ?? '\u2014')}
            </span>
          </div>
          <div className="mt-0.5 flex justify-between">
            <span>habitat draw</span>
            <span className="telemetry-readout text-ink-300">
              {num(live.latestField('mhe', 'habitat', 'power_w'), 0)} W
            </span>
          </div>
          <div className="mt-0.5 flex justify-between">
            <span>last survey</span>
            <span className="telemetry-readout text-ink-300">
              {clockTime(live.services.get('mhe')?.events.find((e) => e.name === 'survey')?.ts)}
            </span>
          </div>
        </div>

        <CommandFeedback error={error} message={message} />
      </div>
    </Panel>
  );
}
