import { useEffect, useRef, useState } from 'react';
import type { ScanRaster } from '../lib/imaging';
import { clockTime, duration, toNumber } from '../lib/format';

/** The HUD's band is always in GHz, as the design system's Target Info HUD specifies (§5.1). */
function ghz(value: number | null): string {
  const n = toNumber(value);
  return n === null ? '\u2014 GHz' : `${(n / 1e9).toFixed(3)} GHz`;
}

export type ScanStatus = 'scanning' | 'stowed' | 'idle';

/**
 * The mosaic viewer.
 *
 * The raster is redrawn on its own animation frame loop, reading the accumulator
 * directly. Nothing here re-renders React per sample: at 80 dishes x 1 Hz the
 * component would otherwise be fighting the reducer for every pixel.
 *
 * `imageSmoothingEnabled = false` is deliberate. Smoothing would make a partially
 * filled mosaic look like a finished image; operators need to see the holes.
 *
 * The Target Info HUD (target id, band in GHz, integration time, and whether the array is scanning)
 * is overlaid inside the frame, so a screenshot of the canvas alone says what it is a picture of.
 */
export function ScanCanvas({
  raster,
  target,
  bandHz,
  status = null,
}: {
  raster: ScanRaster;
  target: string | null;
  bandHz: number | null;
  status?: ScanStatus | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const offscreen = useRef<HTMLCanvasElement | null>(null);
  const lastVersion = useRef(-1);
  const [hover, setHover] = useState<{ x: number; y: number; value: number | null; offset: [number, number] } | null>(
    null,
  );
  const [stats, setStats] = useState({ coverage: 0, samples: 0, min: 0, max: 0 });

  useEffect(() => {
    let frame = 0;
    const draw = () => {
      frame = requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const size = raster.size;
      if (raster.version === lastVersion.current && canvas.width === canvas.clientWidth) {
        return;
      }
      lastVersion.current = raster.version;

      if (!offscreen.current) offscreen.current = document.createElement('canvas');
      const buffer = offscreen.current;
      if (buffer.width !== size) {
        buffer.width = size;
        buffer.height = size;
      }
      const bufferCtx = buffer.getContext('2d');
      if (!bufferCtx) return;

      const { data, min, max } = raster.render();
      // Constructed empty and filled via `set` because `new ImageData(buffer, ..)`
      // rejects an `ArrayBufferLike`-backed view in the current DOM typings.
      const image = new ImageData(size, size);
      image.data.set(data);
      bufferCtx.putImageData(image, 0, 0);

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const css = Math.min(canvas.clientWidth, canvas.clientHeight) || 320;
      if (canvas.width !== Math.round(css * dpr)) {
        canvas.width = Math.round(css * dpr);
        canvas.height = Math.round(css * dpr);
      }
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(buffer, 0, 0, canvas.width, canvas.height);

      setStats({ coverage: raster.coverage, samples: raster.samples, min, max });
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [raster]);

  const onMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const fx = (event.clientX - rect.left) / rect.width;
    const fy = (event.clientY - rect.top) / rect.height;
    const x = Math.min(raster.size - 1, Math.max(0, Math.floor(fx * raster.size)));
    const y = Math.min(raster.size - 1, Math.max(0, Math.floor(fy * raster.size)));
    const theta = raster.meta.fovRad > 0 ? raster.meta.fovRad : 0.01;
    const offsetRa = (x + 0.5) / raster.size - 0.5;
    const offsetDec = 0.5 - (y + 0.5) / raster.size;
    setHover({ x, y, value: raster.meanAt(x, y), offset: [offsetRa * theta, offsetDec * theta] });
  };

  const progress =
    raster.meta.startedTs !== null && raster.meta.expectedDurationS
      ? Math.min(1, (raster.lastTs - raster.meta.startedTs) / 1000 / raster.meta.expectedDurationS)
      : null;
  const integrationS =
    raster.meta.startedTs !== null && raster.lastTs > 0 ? Math.max(0, (raster.lastTs - raster.meta.startedTs) / 1000) : null;
  const stowed = status === 'stowed';
  const shownTarget = stowed ? null : (target ?? raster.meta.target);
  const halfFov = (raster.meta.fovRad * 1000) / 2;

  return (
    <div className="relative aspect-square w-full overflow-hidden rounded border border-base-700 bg-black crt">
      <canvas
        ref={canvasRef}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        className="h-full w-full"
        style={{ imageRendering: 'pixelated' }}
        aria-label="Radio scan mosaic"
      />

      {/* Δx/Δy relative offset grid from the target centre, plus the centre reticle. */}
      <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
        {[25, 50, 75].map((at) => (
          <g key={at} stroke="white" strokeOpacity={at === 50 ? 0.16 : 0.07} strokeWidth="1" vectorEffect="non-scaling-stroke">
            <line x1={at} y1="0" x2={at} y2="100" vectorEffect="non-scaling-stroke" />
            <line x1="0" y1={at} x2="100" y2={at} vectorEffect="non-scaling-stroke" />
          </g>
        ))}
      </svg>
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-4 w-px -translate-x-1/2 -translate-y-1/2 bg-white/25" />
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-px w-4 -translate-x-1/2 -translate-y-1/2 bg-white/25" />
      <span className="telemetry-readout pointer-events-none absolute right-1 top-1/2 -translate-y-full text-2xs text-white/40">
        &Delta;x +{halfFov.toFixed(1)}
      </span>
      <span className="telemetry-readout pointer-events-none absolute left-1/2 top-1 translate-x-1 text-2xs text-white/40">
        &Delta;y +{halfFov.toFixed(1)} mrad
      </span>

      {/* Target Info HUD */}
      <div className="pointer-events-none absolute left-2 top-2 flex flex-col gap-0.5 text-2xs leading-tight">
        <span className="telemetry-readout flex items-center gap-1.5 rounded bg-black/70 px-1.5 py-0.5 text-xs2 font-bold text-white">
          {shownTarget ?? '\u2014'}
          {status ? (
            <span
              className={`rounded px-1 text-2xs font-bold uppercase tracking-wide ${
                status === 'scanning' ? 'bg-ok/20 text-ok' : status === 'stowed' ? 'bg-warn/20 text-warn' : 'bg-white/10 text-white/60'
              }`}
            >
              {status === 'scanning' ? 'SCANNING' : status === 'stowed' ? 'STOWED' : 'IDLE'}
            </span>
          ) : null}
        </span>
        <span className="telemetry-readout rounded bg-black/60 px-1.5 py-0.5 text-white/85">
          band {ghz(bandHz ?? raster.meta.bandHz)}
        </span>
        <span className="telemetry-readout rounded bg-black/60 px-1.5 py-0.5 text-white/85">
          integration {integrationS === null ? '\u2014' : duration(integrationS)}
          {raster.meta.expectedDurationS ? ` / ${duration(raster.meta.expectedDurationS)}` : ''}
        </span>
        <span className="telemetry-readout rounded bg-black/55 px-1.5 py-0.5 text-white/55">
          fov {(raster.meta.fovRad * 1000).toFixed(1)} mrad &middot; {raster.size}&times;{raster.size} &middot; k={raster.meta.overlap}
        </span>
      </div>

      <div className="pointer-events-none absolute bottom-2 left-2 right-2 flex items-end justify-between gap-2 text-2xs">
        <div className="rounded bg-black/65 px-1.5 py-0.5">
          <div className="telemetry-readout text-white/85">
            {raster.samples.toLocaleString('en-US')} samples &middot; {(stats.coverage * 100).toFixed(1)}% covered
          </div>
          <div className="telemetry-readout text-white/55">
            signal {stats.min.toFixed(2)} &ndash; {stats.max.toFixed(2)} &middot; scan {raster.meta.scanId ?? '\u2014'}
          </div>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          {progress !== null ? (
            <div className="h-1 w-32 overflow-hidden rounded bg-white/15">
              <div className="h-full bg-rta" style={{ width: `${progress * 100}%` }} />
            </div>
          ) : null}
          <span className="telemetry-readout rounded bg-black/55 px-1.5 py-0.5 text-white/60">
            {raster.lastTs ? `last pixel ${clockTime(raster.lastTs)}` : 'awaiting first pixel'}
          </span>
        </div>
      </div>

      {hover ? (
        <div className="pointer-events-none absolute right-2 top-2 rounded border border-white/15 bg-black/80 px-1.5 py-1 text-2xs">
          <div className="telemetry-readout text-white/80">
            px {hover.x},{hover.y}
          </div>
          <div className="telemetry-readout text-white/55">
            &Delta;x {(hover.offset[0] * 1000).toFixed(2)} &Delta;y {(hover.offset[1] * 1000).toFixed(2)} mrad
          </div>
          <div className="telemetry-readout text-white">
            {hover.value === null ? 'unobserved' : `signal ${hover.value.toFixed(2)}`}
          </div>
        </div>
      ) : null}
    </div>
  );
}
