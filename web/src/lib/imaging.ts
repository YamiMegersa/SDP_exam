/**
 * RTA scan raster.
 *
 * The array does not publish images - it publishes, per dish, the pointing offset
 * it is currently integrating and the signal it measured there. Reconstructing
 * the image is the client's job:
 *
 *   x = floor(N * (dRa / theta + 1/2))
 *   y = floor(N * (1/2 - dDec / theta))
 *
 * where N is `grid_size`, theta is `fov_rad` and the offsets are bounded by
 * +/- theta/2 (see `arl-rta-spec.txt` 3.1-3.2). Several dishes land on the same
 * pixel, so each cell keeps a running mean rather than a last-write-wins value.
 *
 * The accumulator lives outside React on purpose: at 80 dishes x 1 Hz the image
 * receives ~80 updates a second, and pushing that through a reducer would re-render
 * the whole workspace for every sample. The canvas redraws on its own rAF loop and
 * reads this object directly.
 */

export interface ScanMeta {
  scanId: string | null;
  gridSize: number;
  fovRad: number;
  overlap: number;
  bandHz: number | null;
  target: string | null;
  origin: string | null;
  startedTs: number | null;
  expectedDurationS: number | null;
  /**
   * The scan event's geometry, not the catalogue's: the service announces the
   * fov it is actually going to use, and the two do not always agree.
   */
  fromEvent: boolean;
}

const RAMP: Array<[number, number, number]> = [
  [15, 23, 42], // #0f172a - noise floor
  [2, 132, 199], // #0284c7
  [56, 189, 248], // #38bdf8
  [245, 158, 11], // #f59e0b
  [255, 255, 255], // #ffffff - saturated
];

const RAMP_STEPS = 256;
const LUT = buildRamp();

function buildRamp(): Uint8ClampedArray {
  const table = new Uint8ClampedArray(RAMP_STEPS * 3);
  for (let i = 0; i < RAMP_STEPS; i += 1) {
    const t = (i / (RAMP_STEPS - 1)) * (RAMP.length - 1);
    const lower = Math.floor(t);
    const upper = Math.min(RAMP.length - 1, lower + 1);
    const mix = t - lower;
    const a = RAMP[lower]!;
    const b = RAMP[upper]!;
    table[i * 3] = a[0] + (b[0] - a[0]) * mix;
    table[i * 3 + 1] = a[1] + (b[1] - a[1]) * mix;
    table[i * 3 + 2] = a[2] + (b[2] - a[2]) * mix;
  }
  return table;
}

export class ScanRaster {
  size: number;
  private sum: Float32Array;
  private count: Uint16Array;

  meta: ScanMeta = {
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
  };

  /** Samples ingested for the current scan, and how many pixels they touched. */
  samples = 0;
  covered = 0;
  /** Running range, used to keep the colour ramp stable between redraws. */
  min = Number.POSITIVE_INFINITY;
  max = Number.NEGATIVE_INFINITY;
  lastTs = 0;
  /** Bumped on every accepted sample so the canvas knows there is something new. */
  version = 0;

  constructor(size = 128) {
    this.size = size;
    this.sum = new Float32Array(size * size);
    this.count = new Uint16Array(size * size);
  }

  get coverage(): number {
    return this.size > 0 ? this.covered / (this.size * this.size) : 0;
  }

  reset(meta: Partial<ScanMeta> & { scanId: string | null }): void {
    const size = clampGrid(meta.gridSize ?? this.meta.gridSize);
    if (size !== this.size) {
      this.size = size;
      this.sum = new Float32Array(size * size);
      this.count = new Uint16Array(size * size);
    } else {
      this.sum.fill(0);
      this.count.fill(0);
    }
    this.meta = { ...this.meta, ...meta, gridSize: size };
    this.samples = 0;
    this.covered = 0;
    this.min = Number.POSITIVE_INFINITY;
    this.max = Number.NEGATIVE_INFINITY;
    this.lastTs = 0;
    this.version += 1;
  }

  /**
   * Files one measurement. Returns false when the sample falls outside the field
   * of view (dead pixels are real: a dish can be slewing while the scan runs).
   */
  add(offsetRa: number, offsetDec: number, value: number, ts: number): boolean {
    const { size, meta } = this;
    const theta = meta.fovRad > 0 ? meta.fovRad : 0.01;
    const x = Math.floor(size * (offsetRa / theta + 0.5));
    const y = Math.floor(size * (0.5 - offsetDec / theta));
    if (x < 0 || y < 0 || x >= size || y >= size) return false;

    const index = y * size + x;
    if (this.count[index] === 0) this.covered += 1;
    this.sum[index] = (this.sum[index] ?? 0) + value;
    this.count[index] = Math.min(65_535, (this.count[index] ?? 0) + 1);
    this.samples += 1;
    this.lastTs = ts;
    this.version += 1;

    if (value < this.min) this.min = value;
    if (value > this.max) this.max = value;
    return true;
  }

  /** Mean value at a pixel, or null when the array has not looked there yet. */
  meanAt(x: number, y: number): number | null {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return null;
    const index = y * this.size + x;
    const n = this.count[index] ?? 0;
    if (n === 0) return null;
    return (this.sum[index] ?? 0) / n;
  }

  /** Mean signal per pixel, `null` for unhit pixels. Used by the renderer + HUD. */
  pixels(): Float32Array {
    const out = new Float32Array(this.size * this.size);
    for (let i = 0; i < out.length; i += 1) {
      const n = this.count[i] ?? 0;
      out[i] = n === 0 ? Number.NaN : (this.sum[i] ?? 0) / n;
    }
    return out;
  }

  /**
   * Rasterises the accumulator into an ImageData-ready buffer.
   *
   * Normalisation uses a square-root gamma over the observed range: radio signal
   * strength is heavy-tailed, so a linear ramp leaves everything but the brightest
   * handful of pixels looking like noise.
   */
  render(tearDown = 0.02): { data: Uint8ClampedArray; min: number; max: number } {
    const size = this.size;
    const data = new Uint8ClampedArray(size * size * 4);
    let low = Number.POSITIVE_INFINITY;
    let high = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < this.count.length; i += 1) {
      const n = this.count[i] ?? 0;
      if (n === 0) continue;
      const value = (this.sum[i] ?? 0) / n;
      if (value < low) low = value;
      if (value > high) high = value;
    }

    if (!Number.isFinite(low)) {
      return { data, min: 0, max: 0 };
    }

    const span = Math.max(1e-9, high - low);
    const lo = low + span * tearDown;
    const scale = 1 / Math.max(1e-9, high - lo);

    for (let i = 0; i < this.count.length; i += 1) {
      const n = this.count[i] ?? 0;
      const offset = i * 4;
      if (n === 0) {
        // Unobserved pixels stay true black: holes in the mosaic are information.
        data[offset + 3] = 255;
        continue;
      }
      const value = (this.sum[i] ?? 0) / n;
      const t = Math.sqrt(Math.min(1, Math.max(0, (value - lo) * scale)));
      const lut = Math.min(RAMP_STEPS - 1, Math.max(0, Math.round(t * (RAMP_STEPS - 1))));
      data[offset] = LUT[lut * 3] ?? 0;
      data[offset + 1] = LUT[lut * 3 + 1] ?? 0;
      data[offset + 2] = LUT[lut * 3 + 2] ?? 0;
      data[offset + 3] = 255;
    }

    return { data, min: low, max: high };
  }
}

function clampGrid(value: number): number {
  if (!Number.isFinite(value)) return 128;
  return Math.max(8, Math.min(512, Math.round(value)));
}

/** Colour for a normalised intensity, for legends and tooltips. */
export function rampColor(t: number): string {
  const index = Math.min(RAMP_STEPS - 1, Math.max(0, Math.round(t * (RAMP_STEPS - 1))));
  const r = LUT[index * 3] ?? 0;
  const g = LUT[index * 3 + 1] ?? 0;
  const b = LUT[index * 3 + 2] ?? 0;
  return `rgb(${r}, ${g}, ${b})`;
}
