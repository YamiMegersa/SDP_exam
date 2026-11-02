import { useMemo, useState } from 'react';
import {
  Antenna,
  Crosshair,
  Gauge,
  Pause,
  Play,
  Power,
  Radio,
  RotateCw,
  Square,
  Thermometer,
  Wind,
} from 'lucide-react';
import { ScanCanvas, type ScanStatus } from '../components/ScanCanvas';
import { LineChart } from '../components/charts';
import { CommandFeedback, CommandLog, useCommand } from '../components/commands';
import { measureText, useMeasures, verdictTone } from '../components/derived';
import { Button, Datum, Field, Panel, PanelHead, Pill, Readout, SectionLabel, Select, TextInput } from '../components/ui';
import { clockTime, hz, kelvinToC, num, pct, radiansToDeg, since, toNumber } from '../lib/format';
import { targetLabel } from '../lib/catalogue';
import { useLimits, useLive, useResearcher, useSeries, useTargets } from '../lib/hooks';
import { live, type ServiceRuntime } from '../lib/live';
import type { EntityDef } from '../lib/types';

/**
 * Radio Telescope Array workspace.
 *
 * The array is 100 dishes in a 10x10 field, publishing a fast `normal` stream and,
 * while scanning, a 1 Hz `scan` stream instead. Two things matter to an operator:
 * the state of the individual dishes, and whether the mosaic being assembled is
 * actually converging. Both are visible at once - matrix on the bottom left,
 * raster on top, controls on the right - so a fault has a face (a red tile) and a
 * consequence (a hole in the image).
 */

/**
 * Temperature bands from `GET /api/alert-limits/rta`. Either may be `null` when the limits could not
 * be read; the matrix then draws no temperature band at all rather than guessing one.
 */
interface ThermalLimits {
  warnK: number | null;
  critK: number | null;
}

function thermalBand(temp: number | null, limits: ThermalLimits): 'ok' | 'warn' | 'crit' | null {
  if (temp === null || limits.warnK === null || limits.critK === null) return null;
  return temp >= limits.critK ? 'crit' : temp >= limits.warnK ? 'warn' : 'ok';
}

const FAULT_FAULT = new Set([
  'drive_stall',
  'overheat',
  'receiver_fault',
  'power_fault',
  'comms_loss',
  'encoder_error',
]);

export function RtaPage() {
  useLive();
  const service = live.services.get('rta');
  const [selected, setSelected] = useState<string | null>(null);
  // Subscribes to the catalogue so the pointing is re-labelled once it arrives.
  useTargets();
  const measures = useMeasures('rta');
  const limits = useLimits('rta');
  const thermal: ThermalLimits = {
    warnK: limits.value('dish_temperature.warn_k'),
    critK: limits.value('dish_temperature.crit_k'),
  };
  const minActive = limits.value('availability.min_active');

  if (!service?.topology) {
    return (
      <div className="flex flex-1 items-center justify-center text-xs text-ink-500">
        waiting for the RTA topology&hellip;
      </div>
    );
  }

  const dishes = service.topology.entities.filter((entity) => entity.kind === 'dish');
  const active = toNumber(live.state('rta', 'global', 'active_dishes')) ?? dishes.length;
  const windStow = live.state('rta', 'global', 'wind_stow') === true;
  const online = service.online;
  const observing = live.state('rta', 'main', 'scan_state');
  const target = stateObject(service, 'main', 'target');
  const mainStowed = live.state('rta', 'main', 'stowed') === true;
  const scanStatus: ScanStatus = windStow || mainStowed ? 'stowed' : observing === 'running' ? 'scanning' : 'idle';
  const hotCount =
    thermal.critK === null
      ? null
      : dishes.filter((d) => (toNumber(live.sample('rta', 'normal', d.id)?.data.system_temperature_k) ?? 0) >= thermal.critK!)
          .length;

  return (
    <div className="grid min-h-0 flex-1 gap-2 overflow-y-auto p-2 xl:grid-cols-[minmax(0,1fr)_350px] xl:overflow-hidden">
      <div className="flex min-h-0 flex-col gap-2 xl:overflow-y-auto scroll-thin">
        <Panel>
          <PanelHead
            title="Scan mosaic"
            hint={`${dishes.length} dishes \u00b7 grid from the started event`}
            icon={<Antenna size={13} />}
            right={
              <>
                <Pill tone={online ? 'ok' : 'crit'}>{online ? 'array online' : 'array offline'}</Pill>
                <Pill tone="rta">{String(observing ?? 'idle')}</Pill>
                {windStow ? <Pill tone="warn">wind stow</Pill> : null}
              </>
            }
          />
          <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_170px]">
            <ScanCanvas
              raster={service.raster}
              target={targetLabel(target) ?? service.scan.target}
              bandHz={service.scan.bandHz}
              status={scanStatus}
            />
            <div className="grid grid-cols-2 gap-x-3 gap-y-2 lg:grid-cols-1">
              <Readout
                label={minActive === null ? 'active dishes' : `active dishes \u00b7 min ${minActive}`}
                value={`${active}/${dishes.length}`}
                tone={minActive === null ? 'inert' : active >= minActive ? 'ok' : 'crit'}
              />
              <Readout
                label="pointing error"
                value={measureText(measures.get('rta.pointing_error'))}
                size="sm"
                tone={verdictTone(measures.get('rta.pointing_error'))}
              />
              <Readout
                label="scan id"
                value={service.scan.scanId ?? '\u2014'}
                size="sm"
                tone="neutral"
              />
              <Readout
                label="mosaic filled"
                value={pct(service.raster.coverage * 100, 1)}
                size="sm"
                tone={service.raster.coverage > 0.6 ? 'ok' : 'warn'}
              />
              <Readout
                label="integration"
                value={service.scan.expectedDurationS ? `${service.scan.expectedDurationS}s` : '\u2014'}
                size="sm"
              />
              <Readout
                label="band"
                value={hz(service.scan.bandHz)}
                size="sm"
              />
              <Readout
                label="target"
                value={targetLabel(target) ?? '\u2014'}
                size="sm"
                tone="neutral"
              />
              <TrendStrip service={service} />
            </div>
          </div>
        </Panel>

        <Panel>
          <PanelHead
            title="Dish matrix"
            hint="click a dish to bring it into the control sidebar"
            icon={<Gauge size={13} />}
            right={<MatrixLegend />}
          />
          <DishMatrix dishes={dishes} thermal={thermal} selected={selected} onSelect={setSelected} />
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-2xs text-ink-400 sm:grid-cols-4">
            <Datum label="enabled" value={`${dishes.filter((d) => live.state('rta', d.id, 'enabled') !== false).length}`} />
            <Datum label="stowed" value={`${dishes.filter((d) => live.state('rta', d.id, 'stowed') === true).length}`} />
            <Datum
              label="faulted"
              value={`${dishes.filter((d) => {
                const sample = live.sample('rta', 'normal', d.id) ?? live.sample('rta', 'scan', d.id);
                const fault = sample?.data.fault_code;
                return typeof fault === 'string' && FAULT_FAULT.has(fault);
              }).length}`}
            />
            <Datum
              label={thermal.critK === null ? 'over crit' : `over ${kelvinToC(thermal.critK, 0)}`}
              value={hotCount === null ? '\u2014' : `${hotCount}`}
              tone={hotCount === null ? 'inert' : hotCount > 0 ? 'crit' : 'neutral'}
            />
          </div>
        </Panel>
      </div>

      <div className="flex min-h-0 flex-col gap-2 xl:overflow-y-auto scroll-thin">
        <ArrayControls service={service} dishes={dishes} />
        <DishControls dish={selected} thermal={thermal} />
        <Panel>
          <PanelHead title="Command log" hint="last 8" />
          <CommandLog service="rta" />
        </Panel>
      </div>
    </div>
  );
}

function TrendStrip({ service }: { service: ServiceRuntime }) {
  const power = useSeries({ service: 'rta', stream: 'normal', field: 'power_w' });
  const temp = useSeries({ service: 'rta', stream: 'normal', field: 'system_temperature_k' });
  const avgPower = service.latest.size > 0 ? live.aggregate(service, 'normal', 'power_w') : null;
  const avgTemp = service.latest.size > 0 ? live.aggregate(service, 'normal', 'system_temperature_k') : null;

  return (
    <div className="col-span-2 lg:col-span-1">
      <div className="mb-0.5 flex items-baseline justify-between">
        <span className="text-2xs uppercase tracking-wider text-ink-400">mean dish power</span>
        <span className="telemetry-readout text-2xs text-ink-300">{num(avgPower?.value, 0)} W</span>
      </div>
      <LineChart points={power.points} color="var(--rta)" height={44} unit="W" digits={0} />
      <div className="mb-0.5 mt-1 flex items-baseline justify-between">
        <span className="text-2xs uppercase tracking-wider text-ink-400">mean receiver temp</span>
        <span className="telemetry-readout text-2xs text-ink-300">{kelvinToC(avgTemp?.value)}</span>
      </div>
      <LineChart points={temp.points} color="var(--caution)" height={44} digits={0} />
    </div>
  );
}

function MatrixLegend() {
  return (
    <div className="flex items-center gap-1.5 text-2xs text-ink-500">
      <LegendSwatch className="bg-ok/70" label="in service" />
      <LegendSwatch className="bg-warn/70 stow-pulse" label="stowed" />
      <LegendSwatch className="bg-crit/70" label="hot / fault" />
      <LegendSwatch className="bg-inert/70" label="disabled" />
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

/**
 * 10x10 tile grid, positioned from the topology's own `meta.row` / `meta.col`
 * rather than array order - the field is a real geometry, and tiles should stay
 * where the dishes are even if the topology is republished in a different order.
 *
 * Cells are the guide's fixed 24 px squares, so the matrix is a square of squares. Fill carries the
 * status, the border the temperature band, and only a stowed dish pulses (with a corner marker so
 * stow survives a greyscale screenshot). At 24 px the id is hover-only, in the four-fact tooltip.
 */
function DishMatrix({
  dishes,
  thermal,
  selected,
  onSelect,
}: {
  dishes: EntityDef[];
  thermal: ThermalLimits;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  useLive();
  const rows = useMemo(() => {
    const grid = new Map<number, EntityDef[]>();
    dishes.forEach((dish, index) => {
      const row = toNumber(dish.meta.row) ?? Math.floor(index / 10);
      const bucket = grid.get(row) ?? [];
      bucket.push(dish);
      grid.set(row, bucket);
    });
    return [...grid.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, bucket]) =>
        bucket.sort((a, b) => (toNumber(a.meta.col) ?? 0) - (toNumber(b.meta.col) ?? 0)),
      );
  }, [dishes]);

  return (
    <div className="flex flex-col gap-[3px]" role="grid" aria-label="Dish matrix">
      {rows.map((row) => (
        <div key={row[0]?.id} className="flex gap-[3px]" role="row">
          {row.map((dish) => {
            const sample = live.sample('rta', 'normal', dish.id) ?? live.sample('rta', 'scan', dish.id);
            const enabled = live.state('rta', dish.id, 'enabled') !== false;
            const stowed = live.state('rta', dish.id, 'stowed') === true;
            const temp = toNumber(sample?.data.system_temperature_k);
            const fault = typeof sample?.data.fault_code === 'string' ? sample.data.fault_code : 'none';
            const isFault = FAULT_FAULT.has(fault);
            const band = thermalBand(temp, thermal);
            const hot = band === 'crit';
            const state = !enabled ? 'disabled' : isFault ? 'fault' : hot ? 'overheat' : stowed ? 'stowed' : 'in service';
            const fill =
              state === 'in service'
                ? 'bg-ok/25 hover:bg-ok/40'
                : state === 'stowed'
                  ? 'bg-warn/30 hover:bg-warn/45 stow-pulse'
                  : state === 'fault'
                    ? 'bg-crit/45 shadow-alarm hover:bg-crit/60'
                    : state === 'overheat'
                      ? 'bg-crit/25 hover:bg-crit/40'
                      : 'bg-inert/25 hover:bg-inert/40';
            const border =
              band === 'crit' ? 'border-crit' : band === 'warn' ? 'border-warn' : band === 'ok' ? 'border-ok/50' : 'border-base-600';
            const subarray = live.state('rta', dish.id, 'subarray');
            const ra = toNumber(sample?.data.pointing_offset_ra_rad);
            const dec = toNumber(sample?.data.pointing_offset_dec_rad);
            const offset =
              ra !== null && dec !== null ? `offset ${num(ra * 1000, 2)} / ${num(dec * 1000, 2)} mrad` : 'offset \u2014';
            const tooltip = [
              dish.id,
              `sub-array ${String(subarray ?? '\u2014')}`,
              `${kelvinToC(temp)}${band ? ` (${band})` : ''}`,
              offset,
            ].join(' \u00b7 ');
            const isSelected = selected === dish.id;
            return (
              <button
                key={dish.id}
                onClick={() => onSelect(dish.id)}
                title={`${tooltip}${state !== 'in service' ? ` \u00b7 ${state}${fault !== 'none' ? ` (${fault})` : ''}` : ''}`}
                aria-label={tooltip}
                className={`relative h-6 w-6 flex-none rounded-sm border transition-colors ${fill} ${border} ${
                  isSelected ? 'ring-2 ring-rta ring-offset-1 ring-offset-base-900' : ''
                }`}
              >
                {stowed ? (
                  <span
                    className="absolute right-0 top-0 h-0 w-0 border-l-4 border-t-4 border-l-transparent border-t-warn"
                    aria-hidden
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function ArrayControls({ service, dishes }: { service: ServiceRuntime; dishes: EntityDef[] }) {
  const { send, pending, error, message, clear } = useCommand();
  const [code] = useResearcher();
  const { targets } = useTargets();
  const [targetId, setTargetId] = useState<string>('');
  const [fovMrad, setFovMrad] = useState<string>('');

  const chosen = targets.find((target) => target.id === targetId) ?? targets[0] ?? null;
  const currentTarget = stateObject(service, 'main', 'target');
  const frequency = toNumber(live.state('rta', 'main', 'observation_frequency'));
  const [frequencyGhz, setFrequencyGhz] = useState<string>('');

  const fovValue = fovMrad === '' ? chosen?.fov_rad : Number(fovMrad) / 1000;
  const band = chosen ? chosen.fov_rad : null;

  const disabledReason = !code || code.trim().length < 3 ? 'researcher code required' : null;

  return (
    <Panel>
      <PanelHead title="Array control" hint="sub-array: main" icon={<Radio size={13} />} />
      <div className="grid gap-2">
        <Field
          label="Observation target"
          hint={chosen ? `${radiansToDeg(chosen.ra_rad)} / ${radiansToDeg(chosen.dec_rad)}` : 'ARL catalogue'}
        >
          <Select value={chosen?.id ?? ''} onChange={(event) => setTargetId(event.target.value)}>
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.id} · {target.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="Field of view"
          hint={band ? `catalogue ${(band * 1000).toFixed(1)} mrad` : 'mrad'}
        >
          <TextInput
            value={fovMrad}
            onChange={(event) => setFovMrad(event.target.value)}
            placeholder={band ? (band * 1000).toFixed(2) : '10'}
            inputMode="decimal"
          />
        </Field>

        <Button
          tone="primary"
          busy={pending === 'main/set_target'}
          disabled={!chosen || disabledReason !== null}
          onClick={() => {
            if (!chosen) return;
            void send({
              service: 'rta',
              entity: 'main',
              control: 'set_target',
              value: {
                ra_rad: chosen.ra_rad,
                dec_rad: chosen.dec_rad,
                fov_rad: fovValue ?? chosen.fov_rad,
              },
              researcher: code,
            });
          }}
        >
          <Crosshair size={12} /> slew to target
        </Button>

        <SectionLabel>Scan lifecycle</SectionLabel>
        <div className="grid grid-cols-3 gap-1.5">
          <Button
            tone="primary"
            busy={pending === 'main/start_scan'}
            disabled={disabledReason !== null}
            onClick={() =>
              void send({ service: 'rta', entity: 'main', control: 'start_scan', value: true, researcher: code })
            }
          >
            <Play size={12} /> start
          </Button>
          <Button
            busy={pending === 'main/pause_scan'}
            disabled={disabledReason !== null}
            onClick={() =>
              void send({ service: 'rta', entity: 'main', control: 'pause_scan', value: true, researcher: code })
            }
          >
            <Pause size={12} /> pause
          </Button>
          <Button
            tone="danger"
            busy={pending === 'main/cancel_scan'}
            disabled={disabledReason !== null}
            onClick={() =>
              void send({ service: 'rta', entity: 'main', control: 'cancel_scan', value: true, researcher: code })
            }
          >
            <Square size={12} /> cancel
          </Button>
        </div>

        <SectionLabel>Receiver</SectionLabel>
        <Field label="Observation frequency" hint={hz(frequency)}>
          <div className="flex gap-1.5">
            <TextInput
              value={frequencyGhz}
              onChange={(event) => setFrequencyGhz(event.target.value)}
              placeholder={frequency ? (frequency / 1e9).toFixed(2) : '1.42'}
              inputMode="decimal"
            />
            <Button
              busy={pending === 'main/set_observation_frequency'}
              disabled={disabledReason !== null || frequencyGhz.trim() === ''}
              onClick={() =>
                void send({
                  service: 'rta',
                  entity: 'main',
                  control: 'set_observation_frequency',
                  value: Number(frequencyGhz) * 1e9,
                  researcher: code,
                })
              }
            >
              set
            </Button>
          </div>
        </Field>
        <p className="text-2xs text-ink-500">
          band is chosen by the service: L 1&ndash;2 GHz, C 4&ndash;8 GHz, K 18&ndash;26 GHz
        </p>

        <div className="rounded border border-base-700 bg-base-950/60 px-2 py-1.5">
          <div className="flex items-center justify-between text-2xs">
            <span className="uppercase tracking-wider text-ink-400">current target</span>
            <span className="telemetry-readout text-ink-200">
              {String(currentTarget?.id ?? currentTarget?.name ?? '\u2014')}
            </span>
          </div>
          <div className="mt-0.5 flex items-center justify-between text-2xs text-ink-500">
            <span>{dishes.length} dishes available</span>
            <span className="telemetry-readout">
              last command {service.events[0] ? clockTime(service.events[0].ts) : '\u2014'}
            </span>
          </div>
        </div>

        <CommandFeedback error={error} message={message} />
        {error ? (
          <button onClick={clear} className="text-2xs text-ink-500 underline">
            dismiss
          </button>
        ) : null}
      </div>
    </Panel>
  );
}

function DishControls({ dish, thermal }: { dish: string | null; thermal: ThermalLimits }) {
  const { send, pending, error, message } = useCommand();
  const [code] = useResearcher();
  const [azimuth, setAzimuth] = useState('');
  const [elevation, setElevation] = useState('');
  useLive();

  if (!dish) {
    return (
      <Panel>
        <PanelHead title="Dish control" icon={<Antenna size={13} />} />
        <p className="rounded border border-dashed border-base-700 px-2 py-4 text-center text-2xs text-ink-500">
          select a dish in the matrix to inspect and command it
        </p>
      </Panel>
    );
  }

  const sample = live.sample('rta', 'normal', dish) ?? live.sample('rta', 'scan', dish);
  const commanded = live.state('rta', dish, 'commanded');
  const subarray = live.state('rta', dish, 'subarray');
  const enabled = live.state('rta', dish, 'enabled') !== false;
  const stowed = live.state('rta', dish, 'stowed') === true;
  const calibration = toNumber(live.state('rta', dish, 'last_calibration'));
  const fault = String(sample?.data.fault_code ?? 'none');
  const temp = toNumber(sample?.data.system_temperature_k);
  const band = thermalBand(temp, thermal);
  const hot = band === 'crit';
  const disabled = code.trim().length < 3;

  const commandedObject = (commanded ?? {}) as Record<string, unknown>;

  return (
    <Panel>
      <PanelHead
        title={`Dish ${dish.replace('dish-', '#')}`}
        icon={<Antenna size={13} />}
        right={
          <>
            <Pill tone={hot ? 'crit' : enabled ? 'ok' : 'inert'}>{hot ? 'overheat' : enabled ? 'enabled' : 'disabled'}</Pill>
            {stowed ? <Pill tone="warn">stowed</Pill> : null}
          </>
        }
      />
      <div className="mb-2 grid grid-cols-2 gap-x-3">
        <Datum label="system temp" value={kelvinToC(temp)} tone={band ?? 'inert'} />
        <Datum label="receiver temp" value={kelvinToC(sample?.data.temperature_k)} />
        <Datum label="azimuth" value={radiansToDeg(sample?.data.azimuth_rad)} />
        <Datum label="elevation" value={radiansToDeg(sample?.data.elevation_rad)} />
        <Datum label="power" value={`${num(sample?.data.power_w, 0)} W`} />
        <Datum label="fault" value={fault} tone={fault === 'none' ? 'ok' : 'crit'} />
        <Datum label="subarray" value={String(subarray ?? '\u2014')} />
        <Datum label="calibrated" value={calibration ? since(calibration, Date.now()) : '\u2014'} />
      </div>

      {sample ? (
        <div className="mb-2 grid grid-cols-2 gap-2 rounded border border-base-700 bg-base-950/50 px-2 py-1.5">
          <div>
            <div className="text-2xs uppercase tracking-wider text-ink-500">commanded az/el</div>
            <div className="telemetry-readout text-2xs text-ink-200">
              {radiansToDeg(commandedObject.azimuth_rad)} / {radiansToDeg(commandedObject.elevation_rad)}
            </div>
          </div>
          <div>
            <div className="text-2xs uppercase tracking-wider text-ink-500">scan offset</div>
            <div className="telemetry-readout text-2xs text-ink-200">
              {sample.data.pointing_offset_ra_rad !== undefined
                ? `${num(sample.data.pointing_offset_ra_rad, 4)} / ${num(sample.data.pointing_offset_dec_rad, 4)}`
                : '\u2014'}
            </div>
          </div>
        </div>
      ) : null}

      <div className="grid gap-1.5">
        <div className="flex gap-1.5">
          <TextInput
            value={azimuth}
            onChange={(event) => setAzimuth(event.target.value)}
            placeholder="az rad"
            inputMode="decimal"
          />
          <Button
            busy={pending === `${dish}/adjust_azimuth`}
            disabled={disabled || azimuth.trim() === ''}
            onClick={() =>
              void send({
                service: 'rta',
                entity: dish,
                control: 'adjust_azimuth',
                value: Number(azimuth),
                researcher: code,
              })
            }
          >
            az
          </Button>
        </div>
        <div className="flex gap-1.5">
          <TextInput
            value={elevation}
            onChange={(event) => setElevation(event.target.value)}
            placeholder="el rad (0.087 - 1.571)"
            inputMode="decimal"
          />
          <Button
            busy={pending === `${dish}/adjust_elevation`}
            disabled={disabled || elevation.trim() === ''}
            onClick={() =>
              void send({
                service: 'rta',
                entity: dish,
                control: 'adjust_elevation',
                value: Number(elevation),
                researcher: code,
              })
            }
          >
            el
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-1.5">
          <Button
            tone={enabled ? 'default' : 'primary'}
            busy={pending === `${dish}/enable_dish`}
            disabled={disabled}
            onClick={() =>
              void send({ service: 'rta', entity: dish, control: 'enable_dish', value: !enabled, researcher: code })
            }
          >
            <Power size={12} /> {enabled ? 'disable' : 'enable'}
          </Button>
          <Button
            tone={stowed ? 'warn' : 'default'}
            busy={pending === `${dish}/stow_dish`}
            disabled={disabled}
            onClick={() =>
              void send({ service: 'rta', entity: dish, control: 'stow_dish', value: !stowed, researcher: code })
            }
          >
            <Wind size={12} /> {stowed ? 'unstow' : 'stow'}
          </Button>
        </div>
        <Button
          busy={pending === `${dish}/request_recalibration`}
          disabled={disabled}
          onClick={() =>
            void send({
              service: 'rta',
              entity: dish,
              control: 'request_recalibration',
              value: true,
              researcher: code,
            })
          }
        >
          <RotateCw size={12} /> request recalibration
        </Button>
        <p className="flex items-center gap-1 text-2xs text-ink-500">
          <Thermometer size={11} />{' '}
          {thermal.critK === null
            ? 'overheat limit unavailable (ARL limits unreadable)'
            : `overheat limit ${kelvinToC(thermal.critK, 0)}`}{' '}
          · commands are verified against the ARL researcher directory
        </p>
        <CommandFeedback error={error} message={message} />
      </div>
    </Panel>
  );
}

function stateObject(service: ServiceRuntime, entity: string, item: string): Record<string, unknown> | null {
  const entry = service.states.get(`${entity}|${item}`);
  if (!entry || typeof entry.value !== 'object' || entry.value === null) return null;
  return entry.value as Record<string, unknown>;
}
