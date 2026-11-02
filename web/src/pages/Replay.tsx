import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Clock3,
  FastForward,
  History,
  Layers,
  Pause,
  Play,
  RotateCcw,
  Scissors,
  Square,
  Timer,
} from 'lucide-react';
import { ScanCanvas } from '../components/ScanCanvas';
import { Button, Datum, Empty, Panel, PanelHead, Pill, Readout, SectionLabel } from '../components/ui';
import { api, errorText, type RangeResponse } from '../lib/api';
import { targetLabel } from '../lib/catalogue';
import { clockTime, duration, hz, num, pct, toNumber, watts } from '../lib/format';
import { useTick } from '../lib/hooks';
import { ScanRaster } from '../lib/imaging';
import { live } from '../lib/live';
import type { AlertRecord, ReplayFrame, ReplaySnapshot } from '../lib/types';

/**
 * Replay workspace.
 *
 * Replay is not a second live view: it is the platform's own captured history,
 * replayed from SQLite at the requested multiple. The live socket carries the
 * frames (`replay-frame`) tagged with a session id, so the same decoding code
 * that folds live telemetry into the mosaic also rebuilds a historical scan.
 *
 * Because the mosaic is an accumulator, seeking cannot be "resumed" - the model
 * is reset and rebuilt from the new cursor. Everything else (counters, event
 * list, readouts) is rebuilt the same way, which keeps the page honest about
 * what happened between the cursor and now.
 */

const SPEEDS = [1, 2, 5, 10];
/**
 * How much simulated time to replay by default.
 *
 * Short on purpose: the array publishes a scan sample per dish per simulated
 * second, so a ten-minute window can be nearly empty at its start while a burst
 * sits at its end - the transport would sit at `0 rows` for minutes. Two minutes
 * almost always contains frames and still finishes at 1x within a coffee break.
 */
const DEFAULT_WINDOW_MS = 2 * 60_000;
const PRESETS: Array<{ label: string; ms: number | null }> = [
  { label: 'last 2 min', ms: DEFAULT_WINDOW_MS },
  { label: 'last 30 min', ms: 30 * 60_000 },
  { label: 'whole capture', ms: null },
];

interface ReplayEventRow {
  id: number;
  ts: number;
  service: string;
  name: string;
  text: string;
}

export function ReplayPage() {
  useTick(250); // frames are accumulated in refs; the page paints at 4 Hz

  const [services, setServices] = useState<string[]>(['rta', 'mhe', 'opg']);
  const [ranges, setRanges] = useState<Record<string, RangeResponse>>({});
  const [from, setFrom] = useState<number | null>(null);
  const [to, setTo] = useState<number | null>(null);
  const [speed, setSpeed] = useState(1);
  const [session, setSession] = useState<ReplaySnapshot | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seekDraft, setSeekDraft] = useState<number | null>(null);
  const [alertTicks, setAlertTicks] = useState<AlertRecord[]>([]);
  /** Bracketed window of the most recent scan, if the store holds one. */
  const [scanWindow, setScanWindow] = useState<{ from: number; to: number } | null>(null);

  // Accumulators live outside React: a 10x replay of the 100-dish scan stream
  // delivers far more frames than the reconciler should ever see.
  const rasterRef = useRef(new ScanRaster(128));
  const countersRef = useRef({ telemetry: 0, state: 0, event: 0 });
  const perServiceRef = useRef<Record<string, number>>({});
  const samplesRef = useRef(new Map<string, { ts: number; data: Record<string, unknown> }>());
  const statesRef = useRef(new Map<string, unknown>());
  const targetRef = useRef<string | null>(null);
  const eventsRef = useRef<ReplayEventRow[]>([]);
  const seqRef = useRef(0);
  const sessionRef = useRef<string | null>(null);
  /** The session this page is subscribed to. Kept apart from `sessionRef` so an
   * effect cleanup can never tear down a watch that `start()` just opened. */
  const watchedRef = useRef<string | null>(null);
  const createdRef = useRef<string[]>([]);

  // ------------------------------------------------------------------ capture

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const pairs = await Promise.all(services.map(async (code) => [code, await api.range(code)] as const));
        if (cancelled) return;
        const next: Record<string, RangeResponse> = {};
        for (const [code, range] of pairs) next[code] = range;
        setRanges(next);
      } catch (cause) {
        if (!cancelled) setError(errorText(cause));
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [services.join(',')]);

  const bounds = useMemo(() => {
    const rows = Object.values(ranges);
    if (rows.length === 0) return null;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    let total = 0;
    for (const row of rows) {
      if (row.minTs !== null) min = Math.min(min, row.minTs);
      if (row.maxTs !== null) max = Math.max(max, row.maxTs);
      total += row.rows;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
    return { min, max, total };
  }, [ranges]);

  // Default to the most recent couple of minutes of capture; keep an operator's
  // window when the selection changes but the bounds still contain it.
  useEffect(() => {
    if (!bounds) return;
    setFrom((prev) => (prev !== null && prev >= bounds.min && prev < bounds.max ? prev : Math.max(bounds.min, bounds.max - DEFAULT_WINDOW_MS)));
    setTo((prev) => (prev !== null && prev > bounds.min && prev <= bounds.max ? prev : bounds.max));
  }, [bounds]);

  /**
   * When did the array last actually scan?
   *
   * The `scan` stream only exists while a scan is running, so its first and last
   * timestamps bound the observation. Asking for a handful of rows across the
   * whole capture is enough to bracket it, and gives the operator a one-click
   * window that is guaranteed to contain a mosaic worth replaying.
   */
  useEffect(() => {
    const range = ranges.rta;
    if (!range || range.minTs === null || range.maxTs === null) return;
    let cancelled = false;
    api
      .series({ service: 'rta', stream: 'scan', from: range.minTs, to: range.maxTs, limit: 4 })
      .then((response) => {
        if (cancelled || response.rows.length === 0) return;
        const stamps = response.rows.map((row) => row.ts);
        setScanWindow({ from: Math.min(...stamps) - 60_000, to: Math.max(...stamps) + 60_000 });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ranges.rta?.minTs, ranges.rta?.maxTs]);

  // Alert ticks for the scrubber: where the platform shouted inside this window.
  useEffect(() => {
    api
      .alerts({ limit: 400 })
      .then((response) => setAlertTicks(response.alerts))
      .catch(() => undefined);
  }, []);

  // ---------------------------------------------------------------- decoding

  const resetAccumulators = useCallback(() => {
    countersRef.current = { telemetry: 0, state: 0, event: 0 };
    perServiceRef.current = {};
    samplesRef.current.clear();
    statesRef.current.clear();
    eventsRef.current = [];
    targetRef.current = null;
    rasterRef.current.reset({
      scanId: null,
      gridSize: 128,
      fovRad: 0.01,
      overlap: 3,
      bandHz: null,
      target: null,
      origin: null,
      startedTs: null,
      expectedDurationS: null,
      fromEvent: false,
    });
  }, []);

  const ingest = useCallback((frame: ReplayFrame) => {
    const per = perServiceRef.current;
    per[frame.service] = (per[frame.service] ?? 0) + 1;

    if (frame.kind === 'telemetry') {
      countersRef.current.telemetry += 1;
      samplesRef.current.set(`${frame.service}|${frame.stream}|${frame.entity}`, { ts: frame.ts, data: frame.data });

      if (frame.service === 'rta' && frame.stream === 'scan') {
        const raster = rasterRef.current;
        const scanId = typeof frame.data.scan_id === 'string' ? frame.data.scan_id : null;
        if (scanId && scanId !== raster.meta.scanId) {
          // Geometry comes from the started event, which has already been folded.
          raster.reset({
            scanId,
            gridSize: raster.meta.gridSize,
            fovRad: raster.meta.fovRad,
            overlap: raster.meta.overlap,
            bandHz: raster.meta.bandHz,
            target: raster.meta.target,
            origin: raster.meta.origin,
            startedTs: raster.meta.startedTs,
            expectedDurationS: raster.meta.expectedDurationS,
            fromEvent: raster.meta.fromEvent,
          });
        }
        const ra = toNumber(frame.data.pointing_offset_ra_rad);
        const dec = toNumber(frame.data.pointing_offset_dec_rad);
        const signal = toNumber(frame.data.signal_strength) ?? toNumber(frame.data.snr_db);
        if (ra !== null && dec !== null && signal !== null) raster.add(ra, dec, signal, frame.ts);
      }
      return;
    }

    if (frame.kind === 'state') {
      countersRef.current.state += 1;
      statesRef.current.set(`${frame.service}|${frame.entity}|${frame.item}`, frame.value);
      if (frame.service === 'rta' && frame.entity === 'main') {
        if (frame.item === 'scan_id' && typeof frame.value === 'string' && frame.value !== rasterRef.current.meta.scanId) {
          rasterRef.current.reset({
            scanId: frame.value,
            gridSize: rasterRef.current.meta.gridSize,
            fovRad: rasterRef.current.meta.fovRad,
            overlap: rasterRef.current.meta.overlap,
            bandHz: rasterRef.current.meta.bandHz,
            target: rasterRef.current.meta.target,
          });
        }
        if (frame.item === 'target') {
          const label = targetLabel(frame.value);
          if (label) {
            targetRef.current = label;
            rasterRef.current.meta.target = label;
          }
        }
      }
      return;
    }

    countersRef.current.event += 1;
    if (frame.service === 'rta' && frame.name === 'scan') {
      const payload = frame.payload;
      if (payload.event === 'started') {
        const label = targetLabel(payload.target);
        if (label) targetRef.current = label;
        rasterRef.current.reset({
          scanId: typeof payload.scan_id === 'string' ? payload.scan_id : null,
          gridSize: toNumber(payload.grid_size) ?? 128,
          fovRad: toNumber(payload.fov_rad) ?? 0.01,
          overlap: toNumber(payload.overlap) ?? 3,
          bandHz: toNumber(payload.band_hz),
          target: label,
          origin: typeof payload.origin === 'string' ? payload.origin : null,
          startedTs: frame.ts,
          expectedDurationS: toNumber(payload.expected_duration_s),
          fromEvent: true,
        });
      }
    }

    seqRef.current += 1;
    eventsRef.current = [
      { id: seqRef.current, ts: frame.ts, service: frame.service, name: frame.name, text: summarise(frame) },
      ...eventsRef.current,
    ].slice(0, 40);
  }, []);

  useEffect(() => {
    const offFrame = live.onReplayFrame((id, frame) => {
      if (id === sessionRef.current) ingest(frame);
    });
    const offStatus = live.onReplayStatus((id, snapshot) => {
      if (id === sessionRef.current) setSession(snapshot);
    });
    return () => {
      offFrame();
      offStatus();
    };
  }, [ingest]);

  // Detach on unmount only. Keying this on `session?.id` would also run the
  // cleanup when a session is created, tearing down the watch `start()` just
  // opened - the session then plays into the void and the page shows zero frames.
  useEffect(() => {
    return () => {
      const id = watchedRef.current;
      if (id) live.unwatchReplay(id);
      watchedRef.current = null;
      sessionRef.current = null;
    };
  }, []);

  // Leaving the page frees the server-side session.
  useEffect(() => {
    return () => {
      for (const id of createdRef.current) void api.deleteReplay(id).catch(() => undefined);
    };
  }, []);

  // ------------------------------------------------------------------ actions

  const running = session?.status === 'playing';

  /** Attach the socket to a session, releasing any previous one first. */
  const watchSession = (id: string) => {
    if (watchedRef.current && watchedRef.current !== id) live.unwatchReplay(watchedRef.current);
    watchedRef.current = id;
    sessionRef.current = id;
    live.watchReplay(id);
  };

  const unwatchSession = () => {
    const id = watchedRef.current;
    watchedRef.current = null;
    sessionRef.current = null;
    if (id) live.unwatchReplay(id);
  };

  const start = async () => {
    if (!from || !to || services.length === 0) return;
    setBusy('start');
    setError(null);
    try {
      const snapshot = await api.createReplay({ services, from, to, speed });
      createdRef.current.push(snapshot.id);
      resetAccumulators();
      setSeekDraft(null);
      setSession(snapshot);
      watchSession(snapshot.id);
      const playing = await api.replayAction(snapshot.id, 'play');
      setSession(playing);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const toggle = async () => {
    if (!session) return;
    setBusy('transport');
    try {
      setSession(await api.replayAction(session.id, running ? 'pause' : 'play'));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const changeSpeed = async (next: number) => {
    setSpeed(next);
    if (!session) return;
    try {
      setSession(await api.replaySpeed(session.id, next));
    } catch (cause) {
      setError(errorText(cause));
    }
  };

  const seekTo = async (ts: number) => {
    if (!session) return;
    setBusy('seek');
    try {
      // The mosaic is a running mean, so a jump invalidates it by construction.
      resetAccumulators();
      setSession(await api.replaySeek(session.id, ts));
      setSeekDraft(null);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const commitSeek = () => {
    if (seekDraft !== null) void seekTo(seekDraft);
  };

  const stop = async () => {
    const id = session?.id;
    setSession(null);
    setSeekDraft(null);
    resetAccumulators();
    unwatchSession();
    if (!id) return;
    createdRef.current = createdRef.current.filter((entry) => entry !== id);
    await api.deleteReplay(id).catch(() => undefined);
  };

  // ------------------------------------------------------------------- render

  const raster = rasterRef.current;
  const counters = countersRef.current;
  const perService = perServiceRef.current;
  const events = eventsRef.current;
  const cursor = session ? session.cursor : (from ?? null);

  const opgGlobal = samplesRef.current.get('opg|power|global')?.data ?? {};
  const battery = samplesRef.current.get('opg|power|batteries')?.data ?? {};
  const generation = toNumber(opgGlobal.total_generation_w) ?? 0;
  const load = toNumber(opgGlobal.total_load_w) ?? 0;

  let co2Sum = 0;
  let co2Count = 0;
  for (const [key, sample] of samplesRef.current) {
    if (!key.startsWith('mhe|environment|')) continue;
    const value = toNumber(sample.data.co2_ppm);
    if (value === null) continue;
    co2Sum += value;
    co2Count += 1;
  }

  const tickAlert = (alert: AlertRecord) => {
    if (!from || !to || to <= from) return null;
    if (alert.raised_ts < from || alert.raised_ts > to) return null;
    return ((alert.raised_ts - from) / (to - from)) * 100;
  };

  return (
    <div className="grid min-h-0 flex-1 gap-2 overflow-y-auto p-2 xl:grid-cols-[350px_minmax(0,1fr)_320px] xl:overflow-hidden">
      {/* ------------------------------------------------------------ capture */}
      <div className="flex min-h-0 flex-col gap-2 xl:overflow-y-auto scroll-thin">
        <Panel>
          <PanelHead
            title="Capture window"
            hint="from the platform's own store"
            icon={<Layers size={13} />}
            right={<Pill tone="replay">history</Pill>}
          />
          <div className="mb-2 flex flex-wrap gap-1">
            {['rta', 'mhe', 'opg'].map((code) => {
              const on = services.includes(code);
              return (
                <button
                  key={code}
                  onClick={() =>
                    setServices((prev) => (prev.includes(code) ? prev.filter((entry) => entry !== code) : [...prev, code]))
                  }
                  disabled={session !== null}
                  className={`rounded border px-2 py-1 text-2xs font-medium uppercase tracking-wide transition-colors disabled:opacity-40 ${
                    on ? 'border-replay/60 bg-replay/15 text-replay' : 'border-base-700 bg-base-800 text-ink-400'
                  }`}
                >
                  {code}
                </button>
              );
            })}
            <span className="ml-auto self-center text-2xs text-ink-500">
              {bounds ? `${bounds.total.toLocaleString('en-US')} rows stored` : 'no capture yet'}
            </span>
          </div>

          {bounds ? (
            <div className="flex flex-col gap-2">
              <div>
                <SectionLabel>from</SectionLabel>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={bounds.min}
                    max={bounds.max}
                    step={1000}
                    value={from ?? bounds.min}
                    disabled={session !== null}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      setFrom(next);
                      if (to !== null && next > to) setTo(next);
                    }}
                    className="accent-replay w-full"
                  />
                  <span className="telemetry-readout w-20 flex-none text-right text-2xs text-ink-300">
                    {clockTime(from)}
                  </span>
                </div>
              </div>
              <div>
                <SectionLabel>to</SectionLabel>
                <div className="flex items-center gap-2">
                  <input
                    type="range"
                    min={bounds.min}
                    max={bounds.max}
                    step={1000}
                    value={to ?? bounds.max}
                    disabled={session !== null}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      setTo(next);
                      if (from !== null && next < from) setFrom(next);
                    }}
                    className="accent-replay w-full"
                  />
                  <span className="telemetry-readout w-20 flex-none text-right text-2xs text-ink-300">
                    {clockTime(to)}
                  </span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-x-3">
                <Datum label="window" value={from !== null && to !== null ? duration((to - from) / 1000) : '\u2014'} tone="replay" />
                <Datum label="span stored" value={duration((bounds.max - bounds.min) / 1000)} />
                <Datum
                  label={`playback at ${speed}x`}
                  value={from !== null && to !== null ? duration((to - from) / 1000 / speed) : '\u2014'}
                />
              </div>

              <div className="flex gap-1">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    disabled={session !== null}
                    onClick={() => {
                      const start = preset.ms === null ? bounds.min : Math.max(bounds.min, bounds.max - preset.ms);
                      setFrom(start);
                      setTo(bounds.max);
                    }}
                    className="flex-1 rounded border border-base-700 bg-base-800 px-1.5 py-1 text-2xs uppercase tracking-wide text-ink-400 disabled:opacity-40"
                  >
                    {preset.label}
                  </button>
                ))}
                {scanWindow ? (
                  <button
                    disabled={session !== null}
                    onClick={() => {
                      setFrom(Math.max(bounds.min, scanWindow.from));
                      setTo(Math.min(bounds.max, scanWindow.to));
                      // A scan is ~12 minutes of simulated time; 10x keeps the demo
                      // inside a coffee break without losing any frames.
                      void changeSpeed(10);
                    }}
                    title="the window in which the array was actually scanning"
                    className="flex-1 rounded border border-rta/50 bg-rta/10 px-1.5 py-1 text-2xs uppercase tracking-wide text-rta disabled:opacity-40"
                  >
                    last scan
                  </button>
                ) : null}
              </div>

              <div>
                <SectionLabel>playback rate</SectionLabel>
                <div className="flex gap-1">
                  {SPEEDS.map((entry) => (
                    <button
                      key={entry}
                      onClick={() => void changeSpeed(entry)}
                      className={`flex-1 rounded border px-2 py-1 text-2xs font-bold uppercase tracking-wide ${
                        speed === entry
                          ? 'border-replay/60 bg-replay/15 text-replay'
                          : 'border-base-700 bg-base-800 text-ink-400'
                      }`}
                    >
                      {entry}x
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex gap-1.5">
                <Button tone="primary" onClick={() => void start()} busy={busy === 'start'} disabled={!from || !to || services.length === 0 || session !== null}>
                  <Play size={12} /> start replay
                </Button>
                {session ? (
                  <Button tone="ghost" onClick={() => void stop()}>
                    <Square size={12} /> stop
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <Empty>the store has no rows for this selection yet</Empty>
          )}

          {error ? (
            <p className="mt-2 rounded border border-crit/40 bg-crit/10 px-2 py-1.5 text-2xs text-crit">{error}</p>
          ) : null}
        </Panel>

        <Panel>
          <PanelHead title="Transport" icon={<Clock3 size={13} />} right={session ? <Pill tone={running ? 'ok' : 'neutral'}>{session.status}</Pill> : <Pill tone="inert">idle</Pill>} />
          <div className="telemetry-readout text-lg font-bold text-replay">{clockTime(cursor)}</div>
          <div className="text-2xs uppercase tracking-wider text-ink-500">replay cursor &middot; simulator time</div>

          <div className="relative mt-2 h-2 overflow-hidden rounded bg-base-800">
            <div className="absolute inset-y-0 left-0 bg-replay/50" style={{ width: `${(session?.progress ?? 0) * 100}%` }} />
            {alertTicks.map((alert) => {
              const left = tickAlert(alert);
              if (left === null) return null;
              return (
                <span
                  key={alert.alert_id}
                  title={`${alert.severity} \u00b7 ${alert.message ?? alert.type}`}
                  className={`absolute inset-y-0 w-0.5 ${alert.severity === 'critical' ? 'bg-crit' : 'bg-warn'}`}
                  style={{ left: `${left}%` }}
                />
              );
            })}
          </div>

          <div className="mt-2 flex items-center gap-1.5">
            <Button tone={running ? 'default' : 'primary'} onClick={() => void toggle()} busy={busy === 'transport'} disabled={!session}>
              {running ? <Pause size={12} /> : <Play size={12} />}
              {running ? 'pause' : 'play'}
            </Button>
            <Button
              tone="ghost"
              disabled={!session}
              onClick={() => {
                if (session) void seekTo(session.from);
              }}
              title="rewind to the start of the window"
            >
              <RotateCcw size={12} /> rewind
            </Button>
            <span className="telemetry-readout ml-auto text-2xs text-ink-400">
              {session ? `${session.emitted.toLocaleString('en-US')} of ${session.rows.toLocaleString('en-US')} rows` : 'no session'}
            </span>
          </div>

          <div className="mt-2">
            <SectionLabel>scrub</SectionLabel>
            <input
              type="range"
              min={session?.from ?? from ?? 0}
              max={session?.to ?? to ?? 1}
              step={1000}
              value={seekDraft ?? session?.cursor ?? from ?? 0}
              disabled={!session}
              onChange={(event) => setSeekDraft(Number(event.target.value))}
              onPointerUp={commitSeek}
              onKeyUp={commitSeek}
              className="accent-replay w-full"
            />
            <div className="flex justify-between text-2xs text-ink-500">
              <span className="telemetry-readout">{clockTime(session?.from ?? from)}</span>
              <span className="telemetry-readout">{clockTime(session?.to ?? to)}</span>
            </div>
          </div>
        </Panel>
      </div>

      {/* ------------------------------------------------------------ viewing */}
      <div className="flex min-h-0 flex-col gap-2 xl:overflow-y-auto scroll-thin">
        <Panel>
          <PanelHead
            title="Replayed mosaic"
            hint="rebuilt from the scan stream at the cursor"
            icon={<History size={13} />}
            right={
              <>
                <Pill tone="replay">{duration((raster.lastTs - (raster.meta.startedTs ?? raster.lastTs)) / 1000)} integrated</Pill>
                <Pill tone="neutral">{hz(raster.meta.bandHz)}</Pill>
              </>
            }
          />
          <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_170px]">
            <ScanCanvas raster={raster} target={targetRef.current} bandHz={raster.meta.bandHz} />
            <div className="grid grid-cols-2 gap-x-3 gap-y-2 lg:grid-cols-1">
              <Readout label="scan id" value={raster.meta.scanId ?? '\u2014'} size="sm" tone="replay" />
              <Readout label="filled" value={pct(raster.coverage * 100, 1)} size="sm" />
              <Readout label="samples" value={raster.samples.toLocaleString('en-US')} size="sm" />
              <Readout
                label="rta scan state"
                value={String(statesRef.current.get('rta|main|scan_state') ?? '\u2014')}
                size="sm"
              />
              <Readout label="target" value={targetRef.current ?? '\u2014'} size="sm" />
              <Readout
                label="mission state"
                value={String(statesRef.current.get('mhe|global|mission_state') ?? '\u2014')}
                size="sm"
                tone="mhe"
              />
              <Readout label="mean co2" value={co2Count ? num(co2Sum / co2Count, 0) : '--'} unit="ppm" size="sm" />
              <Readout
                label="battery soc"
                value={pct(battery.state_of_charge_pct, 1)}
                size="sm"
                tone="opg"
              />
            </div>
          </div>
        </Panel>

        <div className="grid gap-2 md:grid-cols-2">
          <Panel>
            <PanelHead title="Replayed power" hint="last frame at the cursor" icon={<FastForward size={13} />} />
            <div className="grid grid-cols-2 gap-x-3">
              <Datum label="generation" value={watts(generation)} tone="opg" />
              <Datum label="load" value={watts(load)} />
              <Datum label="margin" value={watts(generation - load)} tone={generation - load < 0 ? 'warn' : 'ok'} />
              <Datum label="soc" value={pct(battery.state_of_charge_pct, 1)} />
            </div>
            <p className="mt-2 text-2xs text-ink-500">
              Only the frames inside the window are replayed; the live stream keeps running independently behind this page.
            </p>
          </Panel>

          <Panel>
            <PanelHead title="Frames decoded" icon={<Timer size={13} />} />
            <div className="grid grid-cols-2 gap-x-3">
              <Datum label="telemetry" value={counters.telemetry.toLocaleString('en-US')} tone="replay" />
              <Datum label="state changes" value={counters.state.toLocaleString('en-US')} />
              <Datum label="events" value={counters.event.toLocaleString('en-US')} />
              <Datum label="mosaic samples" value={raster.samples.toLocaleString('en-US')} />
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {Object.entries(perService).map(([code, total]) => (
                <Pill key={code} tone={code === 'rta' ? 'rta' : code === 'mhe' ? 'mhe' : 'opg'}>
                  {code} {total.toLocaleString('en-US')}
                </Pill>
              ))}
              {Object.keys(perService).length === 0 ? <span className="text-2xs text-ink-500">no frames yet</span> : null}
            </div>
          </Panel>
        </div>
      </div>

      {/* -------------------------------------------------------------- events */}
      <div className="flex min-h-0 flex-col gap-2 xl:overflow-hidden">
        <Panel className="min-h-0 overflow-hidden">
          <PanelHead
            title="Replayed events"
            hint="newest first"
            icon={<Scissors size={13} />}
            right={session ? <Pill tone="replay">{session.id.slice(0, 8)}</Pill> : null}
          />
          <div className="min-h-0 flex-1 overflow-y-auto scroll-thin">
            {events.length === 0 ? (
              <Empty>start a replay to decode its events</Empty>
            ) : (
              <ul className="flex flex-col gap-1">
                {events.map((event) => (
                  <li key={event.id} className="border-b border-base-700/50 pb-1 last:border-0">
                    <div className="flex items-center gap-1.5 text-2xs">
                      <span className="telemetry-readout text-ink-500">{clockTime(event.ts)}</span>
                      <Pill tone={event.service === 'rta' ? 'rta' : event.service === 'mhe' ? 'mhe' : 'opg'}>
                        {event.service}
                      </Pill>
                      <span className="telemetry-readout text-ink-400">{event.name}</span>
                    </div>
                    <div className="telemetry-readout mt-0.5 break-words text-2xs text-ink-300">{event.text}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Panel>
      </div>
    </div>
  );
}

function summarise(frame: Extract<ReplayFrame, { kind: 'event' }>): string {
  const payload = frame.payload;
  const parts: string[] = [];
  for (const key of ['event', 'scan_id', 'state', 'severity', 'alert_id', 'message', 'origin', 'crew_id', 'band_hz']) {
    const value = payload[key];
    if (value === undefined || value === null || typeof value === 'object') continue;
    parts.push(`${key}=${String(value)}`);
  }
  return parts.length > 0 ? parts.join(' \u00b7 ') : JSON.stringify(payload).slice(0, 140);
}
