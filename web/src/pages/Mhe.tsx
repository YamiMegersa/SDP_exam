import { useMemo, useState } from 'react';
import { Activity, Droplets, HeartPulse, Leaf, Lock, Thermometer, Wind, Users } from 'lucide-react';
import { LineChart, MicroMeter } from '../components/charts';
import { CommandFeedback, CommandLog, useCommand } from '../components/commands';
import { DerivedDatum, useMeasures } from '../components/derived';
import { Button, Datum, Field, Panel, PanelHead, Pill, SectionLabel, Select, TextInput } from '../components/ui';
import { clockTime, kelvinToC, num, pct, toNumber } from '../lib/format';
import { useLimits, useLive, useResearcher, useSeries } from '../lib/hooks';
import { live } from '../lib/live';

/**
 * Mars Habitation Experiment workspace.
 *
 * The interesting reading is not any single room, it is the *relationship*: CO2
 * rising in a sealed room with no ventilation is a different situation from the
 * same CO2 with the scrubbers running. The plan view therefore colours by hazard
 * and the detail panel always shows the setpoint that the room is being held
 * against, so "is this bad?" is answerable without a second screen.
 *
 * Every hazard band is read from `GET /api/alert-limits/mhe`; the design system's CO2 figure is an
 * illustration, not a threshold. With the limits unreadable the values are drawn `inert`, unbanded.
 */

interface AirLimits {
  co2Warn: number | null;
  co2Crit: number | null;
  o2Min: number | null;
}

interface CrewLimits {
  hrMax: number | null;
  tempMaxK: number | null;
  spo2Min: number | null;
}

type Band = 'ok' | 'warn' | 'crit';

/** A room's air band: CO2 against its warn/crit limits, and O2 below its minimum is critical. */
function airBand(co2: number | null, o2: number | null, limits: AirLimits): Band | null {
  if (co2 === null || limits.co2Warn === null || limits.co2Crit === null) return null;
  if (co2 >= limits.co2Crit || (o2 !== null && limits.o2Min !== null && o2 < limits.o2Min)) return 'crit';
  return co2 >= limits.co2Warn ? 'warn' : 'ok';
}

const BAND_VAR: Record<Band, string> = { ok: 'var(--nominal)', warn: 'var(--caution)', crit: 'var(--alarm)' };
const BAND_FILL_OPACITY: Record<Band, number> = { ok: 0.16, warn: 0.28, crit: 0.34 };

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
  const limits = useLimits('mhe');
  const air: AirLimits = {
    co2Warn: limits.value('air.co2_warn_ppm'),
    co2Crit: limits.value('air.co2_crit_ppm'),
    o2Min: limits.value('air.o2_min_ppm'),
  };
  const crewLimits: CrewLimits = {
    hrMax: limits.value('crew.hr_max'),
    tempMaxK: limits.value('crew.temp_max_k'),
    spo2Min: limits.value('crew.spo2_min'),
  };

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
        {/* shrink-0: a fixed-aspect drawing cannot be squeezed, so the column
            scrolls instead of letting the plan spill over its neighbours. */}
        <Panel className="shrink-0">
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
          <HabitatPlan selected={selected} onSelect={setSelected} air={air} />
          <div className="mt-2 flex flex-wrap items-center gap-3 text-2xs text-ink-500">
            {air.co2Warn !== null && air.co2Crit !== null ? (
              <>
                <LegendSwatch className="bg-ok/50" label="nominal" />
                <LegendSwatch className="bg-warn/50" label={`CO\u2082 \u2265 ${air.co2Warn} ppm`} />
                <LegendSwatch
                  className="bg-crit/60"
                  label={`CO\u2082 \u2265 ${air.co2Crit} ppm${air.o2Min !== null ? ` or O\u2082 < ${air.o2Min} ppm` : ''}`}
                />
              </>
            ) : (
              <LegendSwatch className="bg-inert/50" label="ARL limits unavailable \u2014 hazard bands suppressed" />
            )}
            <LegendSwatch className="bg-inhand/40" label="sealed / depressurised" />
            <span className="ml-auto flex items-center gap-1">
              <Users size={11} /> badge = crew in the room
            </span>
          </div>
        </Panel>

        <div className="grid gap-2 lg:grid-cols-2">
          <RoomDetail room={selected} air={air} />
          <CrewStrip crew={crew.map((entity) => entity.id)} limits={crewLimits} />
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

const MONO = 'JetBrains Mono, monospace';

function HabitatPlan({
  selected,
  onSelect,
  air,
}: {
  selected: string | null;
  onSelect: (id: string) => void;
  air: AirLimits;
}) {
  useLive();

  return (
    <div className="rounded border border-base-700 bg-base-950/60 p-1">
      {/* The plan is a fixed aspect drawing: without the cap it grows to the full
          column width and overflows the panel it sits in, painting over the
          compartment detail and crew strip below. */}
      <svg
        viewBox="0 0 720 560"
        className="mx-auto h-auto max-h-[44vh] w-full max-w-[620px]"
        role="img"
        aria-label="Habitat floor plan"
      >
        <rect x="30" y="30" width="660" height="500" rx="12" fill="none" style={{ stroke: 'var(--panel-edge)' }} strokeWidth="4" />
        {ROOMS.map((room) => {
          const env = live.sample('mhe', 'environment', room.id)?.data;
          const airlock = live.sample('mhe', 'airlock', room.id)?.data;
          const sealed = live.state('mhe', room.id, 'sealed') === true;
          const co2 = toNumber(env?.co2_ppm);
          const o2 = toNumber(env?.oxygen_ppm);
          const band = airBand(co2, o2, air);
          const airlockState = airlock ? String(airlock.airlock_state ?? '') : null;
          const depressurised = room.id === 'airlock' && airlockState === 'depressurized';

          const fill = band ? BAND_VAR[band] : 'var(--panel-deep)';
          const fillOpacity = band ? BAND_FILL_OPACITY[band] : 1;
          const stroke = band ? BAND_VAR[band] : 'var(--panel-edge)';
          const isSelected = selected === room.id;
          const temp = toNumber(env?.temperature_k);
          const occupancy = toNumber(env?.crew_count);
          const wide = room.width > 140;
          const readingInk = band === 'warn' || band === 'crit' ? BAND_VAR[band] : band ? 'var(--ink-300)' : 'var(--inert)';

          return (
            <g
              key={room.id}
              onClick={() => onSelect(room.id)}
              className="cursor-pointer"
              role="button"
              aria-label={room.id}
            >
              <title>
                {band ? `${room.id}: ${band}` : `${room.id}: ARL alert limits unavailable, hazard band suppressed`}
              </title>
              <rect
                x={room.x}
                y={room.y}
                width={room.width}
                height={room.height}
                rx="3"
                style={{ fill, fillOpacity, stroke: isSelected ? 'var(--mhe)' : stroke }}
                strokeWidth={isSelected ? 4 : 2}
              />
              {sealed || depressurised ? (
                <rect
                  x={room.x + 6}
                  y={room.y + 6}
                  width={room.width - 12}
                  height={room.height - 12}
                  fill="none"
                  style={{ stroke: 'var(--in-hand)' }}
                  strokeWidth="1.5"
                  strokeDasharray="6 4"
                />
              ) : null}

              <text
                x={room.x + 10}
                y={room.y + 26}
                style={{ fill: 'var(--ink-100)' }}
                fontSize="19"
                fontWeight="600"
                fontFamily="Inter, system-ui, sans-serif"
              >
                {room.label}
              </text>

              {/* Occupancy badge on every compartment, not only the wide ones. */}
              <g opacity={occupancy && occupancy > 0 ? 1 : 0.45}>
                <circle
                  cx={room.x + room.width - 22}
                  cy={room.y + 20}
                  r="13"
                  style={{ fill: 'var(--elev)', stroke: occupancy && occupancy > 0 ? 'var(--mhe)' : 'var(--panel-edge)' }}
                />
                <text
                  x={room.x + room.width - 22}
                  y={room.y + 26}
                  style={{ fill: 'var(--ink-100)' }}
                  fontSize="15"
                  fontWeight="700"
                  textAnchor="middle"
                  fontFamily={MONO}
                >
                  {occupancy === null ? '\u2014' : occupancy}
                </text>
              </g>

              <text x={room.x + 10} y={room.y + 50} style={{ fill: 'var(--ink-200)' }} fontSize="15" fontFamily={MONO}>
                {kelvinToC(temp, 0)}
              </text>
              <text x={room.x + 10} y={room.y + 72} style={{ fill: readingInk }} fontSize="15" fontFamily={MONO}>
                {wide ? `CO\u2082 ${num(co2, 0)} ppm` : `CO\u2082 ${num(co2, 0)}`}
              </text>
              <text
                x={room.x + 10}
                y={room.y + 94}
                style={{
                  fill:
                    o2 !== null && air.o2Min !== null && o2 < air.o2Min
                      ? 'var(--alarm)'
                      : air.o2Min === null
                        ? 'var(--inert)'
                        : 'var(--ink-300)',
                }}
                fontSize="15"
                fontFamily={MONO}
              >
                {wide ? `O\u2082 ${num(o2, 0)} ppm` : `O\u2082 ${num(o2 === null ? null : o2 / 1000, 0)}k`}
              </text>
              {wide ? (
                <text x={room.x + 10} y={room.y + 116} style={{ fill: 'var(--ink-400)' }} fontSize="14" fontFamily={MONO}>
                  {num(env?.humidity_pct, 0)}% rh &middot; {num(env?.pressure_kpa, 1)} kPa
                </text>
              ) : null}

              {room.id === 'airlock' && airlockState ? (
                <AirlockPill x={room.x + room.width / 2} y={room.y + room.height - 30} state={airlockState} />
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/**
 * The guide's airlock pill: `PRESSURIZED` on an emerald fill, `DEPRESSURIZED` in an amber outline,
 * uppercase. A transitional state (cycling) is shown in caps on a neutral outline.
 */
function AirlockPill({ x, y, state }: { x: number; y: number; state: string }) {
  const pressurised = state === 'pressurized';
  const depressurised = state === 'depressurized';
  const label = state.toUpperCase();
  const width = Math.max(96, label.length * 9 + 18);
  return (
    <g>
      <rect
        x={x - width / 2}
        y={y - 14}
        width={width}
        height={22}
        rx="11"
        strokeWidth="1.5"
        style={{
          fill: pressurised ? 'var(--ok)' : 'none',
          stroke: pressurised ? 'var(--ok)' : depressurised ? 'var(--caution)' : 'var(--ink-500)',
        }}
      />
      <text
        x={x}
        y={y + 2}
        textAnchor="middle"
        fontSize="13"
        fontWeight="700"
        letterSpacing="0.5"
        fontFamily={MONO}
        style={{ fill: pressurised ? 'var(--void)' : depressurised ? 'var(--caution)' : 'var(--ink-300)' }}
      >
        {label}
      </text>
    </g>
  );
}

function RoomDetail({ room, air }: { room: string | null; air: AirLimits }) {
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
  // Keyed so the series hooks below always run for exactly one room.
  return <RoomDetailBody key={room} room={room} air={air} />;
}

function RoomDetailBody({ room, air }: { room: string; air: AirLimits }) {
  useLive();
  const env = live.sample('mhe', 'environment', room)?.data ?? {};
  const hydro = live.sample('mhe', 'hydroponics', room)?.data;
  const airlock = live.sample('mhe', 'airlock', room)?.data;
  const equipment = live.sample('mhe', 'equipment', room)?.data;
  const setpoints = (live.state('mhe', room, 'setpoints') ?? {}) as Record<string, unknown>;
  const co2 = toNumber(env.co2_ppm);
  const o2 = toNumber(env.oxygen_ppm);
  const band = airBand(co2, o2, air);
  const o2Low = o2 !== null && air.o2Min !== null && o2 < air.o2Min;
  const tempTrend = useSeries({ service: 'mhe', stream: 'environment', entity: room, field: 'temperature_k' });
  const co2Trend = useSeries({ service: 'mhe', stream: 'environment', entity: room, field: 'co2_ppm' });

  return (
    <Panel>
      <PanelHead
        title={room}
        icon={<Thermometer size={13} />}
        right={
          <>
            <Pill tone={band ?? 'inert'}>
              {band === null ? 'limits unavailable' : band === 'ok' ? 'atmosphere ok' : o2Low ? 'o2 low' : 'co2 high'}
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
        <Datum
          label={air.co2Warn === null ? 'co2' : `co2 \u00b7 warn ${air.co2Warn}`}
          value={`${num(env.co2_ppm, 0)} ppm`}
          tone={co2 === null || air.co2Warn === null || air.co2Crit === null ? 'inert' : co2 >= air.co2Crit ? 'crit' : co2 >= air.co2Warn ? 'warn' : 'ok'}
        />
        <Datum
          label={air.o2Min === null ? 'o2' : `o2 \u00b7 min ${air.o2Min}`}
          value={`${num(env.oxygen_ppm, 0)} ppm`}
          tone={o2 === null || air.o2Min === null ? 'inert' : o2Low ? 'crit' : 'ok'}
        />
        <Datum label="pressure" value={`${num(env.pressure_kpa, 1)} kPa`} />
        <Datum label="ventilation" value={`${num(env.ventilation_m3h, 0)} m3/h`} />
        <Datum label="lighting" value={`${num(env.lighting_lux, 0)} lx`} />
        <Datum label="occupancy" value={num(env.crew_count, 0)} />
      </div>

      <div className="mt-1.5 grid grid-cols-2 gap-2">
        <div>
          <div className="mb-0.5 text-2xs uppercase tracking-wider text-ink-400">co2 ppm</div>
          <LineChart
            points={co2Trend.points}
            color="var(--caution)"
            height={38}
            threshold={air.co2Warn === null ? null : { value: air.co2Warn }}
            digits={0}
          />
        </div>
        <div>
          <div className="mb-0.5 text-2xs uppercase tracking-wider text-ink-400">temperature</div>
          <LineChart points={tempTrend.points} color="var(--mhe)" height={38} digits={0} />
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
              value={String(airlock.airlock_state ?? '\u2014').toUpperCase()}
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

const SURVEY_FIELDS = ['mood', 'stress', 'fatigue', 'sleep_quality'] as const;

/**
 * The latest survey scores per crew member (D-9).
 *
 * Survey events are one per crew member with flat scores, and the event payload is the raw envelope,
 * so its `entity` names the crew member. Each field takes the newest value seen for that person:
 * `sleep_quality` only arrives in the start-of-day survey and must not be blanked by the evening one.
 * A legacy `{surveys: {crew-n: {...}}}` map is still accepted.
 */
function latestSurveys(): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const events = live.services.get('mhe')?.events ?? [];
  for (const event of events) {
    if (event.name !== 'survey') continue;
    const payload = event.payload;
    const entries: Array<[string, Record<string, unknown>]> = [];
    if (payload.surveys && typeof payload.surveys === 'object') {
      for (const [crew, scores] of Object.entries(payload.surveys as Record<string, unknown>)) {
        if (scores && typeof scores === 'object') entries.push([crew, scores as Record<string, unknown>]);
      }
    } else {
      const crew = payload.entity ?? payload.crew_id ?? payload.crew;
      const body = (payload.data && typeof payload.data === 'object' ? payload.data : payload) as Record<string, unknown>;
      if (typeof crew === 'string') entries.push([crew, body]);
    }
    // Events are newest first, so a field already set is the more recent reading.
    for (const [crew, scores] of entries) {
      const merged = out.get(crew) ?? {};
      for (const field of SURVEY_FIELDS) {
        if (merged[field] === undefined && scores[field] !== undefined && scores[field] !== null) merged[field] = scores[field];
      }
      out.set(crew, merged);
    }
  }
  return out;
}

/**
 * A heartbeat trace whose period is the *sampled* heart rate: the trace holds two beats and scrolls
 * one beat per `60 / bpm` seconds. With no reading it is drawn flat and still.
 */
function PulseLine({ bpm, tone }: { bpm: number | null; tone: string }) {
  // One beat is exactly 40 units wide, the width of the viewBox.
  const beat = 'l6 0 l2 -3 l2 3 l3 0 l2 -9 l2 15 l2 -8 l2 2 l4 0 l3 -2 l3 2 l9 0';
  const beating = bpm !== null && bpm > 0;
  return (
    <svg viewBox="0 0 40 20" className="h-4 w-16 flex-none overflow-hidden" aria-hidden>
      <path
        className={beating ? 'pulse-trace' : undefined}
        style={{ stroke: tone, animationDuration: beating ? `${(60 / (bpm ?? 60)).toFixed(3)}s` : undefined }}
        d={beating ? `M0 10 ${beat} ${beat}` : 'M0 10 l80 0'}
        fill="none"
        strokeWidth="1.4"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function CrewStrip({ crew, limits }: { crew: string[]; limits: CrewLimits }) {
  useLive();
  const surveys = useMemo(latestSurveys, [live.getVersion()]);

  return (
    <Panel>
      <PanelHead title="Crew biometrics" hint={`${crew.length} crew`} icon={<HeartPulse size={13} />} />
      <div className="flex flex-col gap-1.5">
        {crew.map((id) => {
          const vitals = live.sample('mhe', 'vitals', id)?.data ?? {};
          const hr = toNumber(vitals.heart_rate_bpm);
          const temp = toNumber(vitals.body_temperature_k);
          const spo2 = toNumber(vitals.spo2_pct);
          const hrTone = hr === null || limits.hrMax === null ? 'inert' : hr > limits.hrMax ? 'crit' : 'ok';
          const tempTone = temp === null || limits.tempMaxK === null ? 'inert' : temp > limits.tempMaxK ? 'crit' : 'neutral';
          const spo2Tone = spo2 === null || limits.spo2Min === null ? 'inert' : spo2 < limits.spo2Min ? 'crit' : 'neutral';
          const own = surveys.get(id) ?? {};
          return (
            <div key={id} className="rounded border border-base-700 bg-base-950/50 px-2 py-1.5">
              <div className="flex items-center gap-2">
                <span className="telemetry-readout text-2xs font-bold text-mhe">{id}</span>
                <PulseLine
                  bpm={hr}
                  tone={hrTone === 'crit' ? 'var(--alarm)' : hrTone === 'ok' ? 'var(--nominal)' : 'var(--inert)'}
                />
                <Pill tone={hrTone}>{num(hr, 0)} bpm</Pill>
                <Pill tone={tempTone}>{kelvinToC(temp, 1)}</Pill>
                <Pill tone={spo2Tone}>SpO2 {num(spo2, 0)}%</Pill>
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
      {surveys.size === 0 ? (
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
