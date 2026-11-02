# 20 — RTA Data

**Service.** The Radio Telescope Array: 100 dishes in up to 4 sub-arrays, normal telemetry every
120 s, scan telemetry at 1 Hz, and a two-dimensional image reconstructed from per-dish pointing
offsets.

**Component.** Everything from the wire to a usable image and a persisted history: what is
captured, how it is normalised, how samples become pixels, and which derived measures answer a
researcher's questions.

**Owner files.** `server/src/services/rta.ts`, `web/src/lib/imaging.ts`,
`web/src/pages/Rta.tsx` (data half), `web/src/lib/live.ts` (§ scan accumulation).

**Rubric.** Data 30 % of the service score.

**Depends on.** `02`, `03`, `04`, `10`, `11`.

---

## 1. The authoritative data model

From `arl-rta-spec.pdf` §1–§3. Nothing below may be invented; anything not listed must not be
relied on.

### 1.1 Entities

| Kind | Ids | Notes |
| :--- | :--- | :--- |
| `dish` | `dish-001` … `dish-100` | 10 rows of 10 numbered from the north-west; `meta` carries `row`, `col`, `lat`, `lon` |
| `subarray` | `main` plus up to 3 others | Names match `[a-z][a-z0-9-]{0,15}`, may not start with `dish-`, may not be `global`; sub-arrays appear and disappear, so `$topology` must be watched |
| `service` | `global` | `active_dishes`, `wind_stow`, alert summary |

### 1.2 Telemetry

**`arl/rta/<dish>/telemetry/normal` every 120 s, dishes not scanning**

| Key | Type / unit | Meaning |
| :--- | :--- | :--- |
| `temperature_k` | float, K | Dish structure temperature; rises in sunshine and while slewing |
| `elevation_rad` | float, rad | Elevation above horizon |
| `azimuth_rad` | float, rad | Azimuth, clockwise from north |
| `power_w` | integer, W | Electrical draw; higher while slewing/scanning |
| `system_temperature_k` | float, K | Receiver noise temperature; grows with calibration age and at low elevation |
| `fault_code` | enum | `none`, `drive_stall`, `overheat`, `receiver_fault`, `power_fault`, `comms_loss`, `encoder_error` |
| `status` | boolean | `enabled && (fault_code == none || fault_code == encoder_error)` — i.e. in service |

**`arl/rta/<dish>/telemetry/scan` every 1 s while scanning — all of the above, plus**

| Key | Type / unit | Meaning |
| :--- | :--- | :--- |
| `scan_id` | string | e.g. `scan-0007` |
| `pointing_offset_ra_rad` | float, rad or **null** | Offset of this sample from the target centre; null when no sample |
| `pointing_offset_dec_rad` | float, rad or **null** | as above |
| `signal_strength` | float, relative | Brightness at that offset; null when no sample |
| `snr_db` | float, dB or null | Quality of the sample |
| `band_hz` | float, Hz | Observing frequency of the scan |
| `scan_progress` | float 0–1 | Fraction of this dish's share done; holds still while paused |

### 1.3 Retained state

| Topic | Type | Meaning |
| :--- | :--- | :--- |
| `<dish>/state/commanded` | `{azimuth_rad, elevation_rad}` | Where the dish was told to point; differs from reported while slewing; updated every 10 s while tracking |
| `<dish>/state/subarray` | string | Current sub-array |
| `<dish>/state/last_calibration` | timestamp ms | Last successful calibration |
| `<dish>/state/enabled` | boolean | Enabled |
| `<dish>/state/stowed` | boolean | Stowed by command or by wind |
| `<subarray>/state/members` | string[] | Dishes in the sub-array |
| `<subarray>/state/scan_state` | enum | `idle`, `scheduled`, `running`, `paused`, `cancelled`, `complete` |
| `<subarray>/state/target` | string \| `{ra_rad, dec_rad, fov_rad}` \| null | Catalogue id or custom position |
| `<subarray>/state/observation_frequency` | float, Hz | Observing frequency |
| `<subarray>/state/next_scan` | timestamp ms | 0 if none |
| `<subarray>/state/scan_id` | string \| null | Current or most recent scan |
| `global/state/active_dishes` | integer | Dishes in service |
| `global/state/wind_stow` | boolean | Wind stow engaged |
| `global/state/online`, `global/state/active_alerts` | boolean, string[] | Mandatory for every service |

When a sub-array is removed its retained state topics are cleared with an empty message.

### 1.4 Events

**`arl/rta/events/scan`** — `{ scan: <scan_id>, event: started|paused|resumed|completed|cancelled|failed, reason? }`
where `reason` is `wind` for a wind pause and one of `target_set`, `too_few_dishes`, `wind`,
`no_target`, `unknown_target` for a failure.

The `started` event additionally carries: `target`, `ra_rad`, `dec_rad`, `fov_rad`, `band_hz`,
`grid_size`, `overlap`, `dishes[]`, `expected_duration_s`, `origin` (`command` | `schedule`).

**`arl/rta/events/alert`** — see `23`.

### 1.5 Machine facts that shape the design

| Fact | Consequence for the data layer |
| :--- | :--- |
| 80–90 dishes in service; the rest disabled for maintenance | `active_dishes` is the number to trust, never a count of `entity` rows |
| A scan divides the target into a 128×128 grid, sampling each cell **3 times** with different dishes; with 90 dishes a scan takes ~9 minutes | Grid and overlap come from the `started` event, never the catalogue (README D8) |
| A dish that drops out leaves its remaining samples untaken | The image has **holes**; do not interpolate by default |
| Wind stow above 15 m/s gust for 60 s; releases below 10 m/s for 10 min | A paused scan can last many minutes; `scan_progress` holds |
| Scan needs the target ≥ 15° above the horizon; fails if it sets below 5° | Absence of scan data can be legitimate; distinguish "not scanning" from "no data" |
| Scans may be scheduled by the service every 45–90 min with `origin: "schedule"` | The console must not assume a researcher caused every scan |
| Data is noisy; faulty dishes produce outliers or nothing | Cleaning is mandatory (`14` §4.3.3) and the count of rejected samples is a first-class readout |
| ~1 msg/s idle, ~90 msg/s while main scans | The batching and coalescing decisions in `03`/`09` exist for this |

---

## 2. Capture requirements (Data criterion)

### 2.1 Completeness checklist

| Requirement | Where it is satisfied |
| :--- | :--- |
| Every dish's normal stream captured | `03` wildcard subscription |
| Every dish's scan stream captured at 1 Hz | same, with `MAX_SAMPLES_PER_KEY = 4` so no sample is merged away (`09` §4.2.1) |
| All 7 telemetry fields per stream, including `null` | `03` §4.2.2 preserves nulls |
| All 11 state items | `03` §4.3.2 with structural de-duplication |
| Scan lifecycle events with full start details | `03` → `event` table; the geometry is read from the `started` payload |
| Alerts with dish metadata | `05` §4.1.1 |
| Survives speedup | `03` §4.4.2 back pressure; `04` batched transaction |
| No unrecorded loss | `ingest_gap` on every `seq` discontinuity; footer counters |

### 2.2 Elevated speedup

RTA's `max_speedup` is **50**, so at 50× a scan reports ~4 500 messages/s. The platform must
therefore:

1. Pause and resume the MQTT subscription rather than buffer unboundedly (`03` §4.4.2).
2. Write batches of 1 000 rows every 250 ms — at 4 500/s that is a batch every ~220 ms, so the
   timer fires before the row cap. Confirm with a load test.
3. Keep `MAX_SAMPLES_PER_KEY`-bounded coalescing so the browser is not asked to render 4 500
   samples/s. At 50× the mosaic fills 50× faster, which is the point.
4. Never use wall clock for ordering: at 50× the sim clock advances 50 s per wall second, and the
   mosaic would otherwise appear to fill in the wrong order.

**Acceptance.** A 5-minute 50× run over `tgt-cen` produces a complete image, `ingest_gap` count
zero, `dropped` zero, and a replay of that window reconstructs the same image.

---

## 3. Normalisation pipeline

```
wire → classify → decode → gap check → orphan/topology → batch → SQLite
                                              │
                                              └→ bus → WS frames → live store → raster
```

### 3.1 Envelope → row

- `ts` → `telemetry.ts` (ordering, charting, replay).
- `recv_ts` → ingestion health only.
- `seq` → gap tracking, then stored for audit.
- Everything else → `data` JSON, nulls preserved.

### 3.2 Scan geometry capture

- **Responsibility.** Bind every sample to the geometry that produced it.
- **Contract.** On a `scan` event with `event === 'started'`, store
  `ScanGeometry { scanId, target, raRad, decRad, fovRad, gridSize, overlap, bandHz, dishes,
  expectedDurationS, origin, startTs }` in the store's `rta.scanHistory` map.
- **Steps.** Keyed by `scanId`. If a sample arrives for an unknown `scanId`, hold it in a small
  pending buffer (capacity 2 000) until the event arrives; if it never does, fall back to the
  sub-array's `state/target` and the service configuration's defaults, and mark the image
  `geometry: 'inferred'` in the HUD.
- **Acceptance.** Every sample in a completed scan resolves to exactly one geometry, and the HUD
  never shows `grid 128` for a scan whose `started` event said `grid 256`.

### 3.3 Sample → pixel

The spec's formula, implemented exactly (already present in `imaging.ts`):

```
x = floor(N × ( Δα/θ + 1/2 ))
y = floor(N × ( 1/2 − Δδ/θ ))
```

and the inverse for the centre of pixel `(x, y)`:

```
Δα = ((x + 0.5)/N − 0.5) × θ
Δδ = (0.5 − (y + 0.5)/N) × θ
```

Offsets range over `[−θ/2, θ/2]`; for even `N` the target centre falls between the four middle
pixels. North is at the top (row 0), west is at the left (column 0).

- **Acceptance.** A unit test asserts the pixel for `(+θ/4, 0)` is `(3N/4, N/2)`, the pixel for
  `(0, +θ/4)` is `(N/2, N/4)`, and out-of-range offsets are rejected rather than clamped.

### 3.4 Pixel value

```
I(x, y) = (1/n) Σ sᵢ        for the n accepted samples on that pixel, n ≤ k
```

- Samples with null offsets or null signal are skipped (dish still acquiring, or scan paused).
- A pixel with no accepted samples is a **hole**.
- Rejected-by-cleaning samples do not contribute but are counted.

**Acceptance.** Mean accumulation is exact for a synthetic 3-sample pixel; a hole renders black
and is counted in `coverage`.

---

## 4. Image reconstruction and cleaning

The spec warns explicitly: *"an image built directly from the raw samples may therefore look
grainy, patchy or almost completely dark. Do not assume your first image is correct."* The
cleaning pipeline is therefore a graded requirement, not an optimisation.

### 4.1 Acceptance rules (in order)

| # | Rule | Rationale |
| :--- | :--- | :--- |
| 1 | `pointing_offset_ra_rad`, `pointing_offset_dec_rad`, `signal_strength` all non-null | The spec's own rule |
| 2 | `Math.abs(Δα) ≤ θ/2 && Math.abs(Δδ) ≤ θ/2` | A sample outside the field is a positioning error, not a pixel |
| 3 | dish `fault_code ∈ {none, encoder_error}` | `encoder_error` keeps the dish in service; the others corrupt data |
| 4 | `snr_db` is null **or** `≥ scan.min_snr_db` (API limit, default 3 dB) | A sample the instrument itself rates as noise is not signal |
| 5 | `|s − median_dish(s)| ≤ 5 × MAD_dish` | Faulty receivers produce isolated extreme values; a robust bound removes them without flattening real structure |
| 6 | `scan_id === geometry.scanId` | Never mix two scans into one image |

### 4.2 Display normalisation

- Compute `p2` and `p995` over accepted sample values for the scan.
- Map `t = clamp((s − p2) / (p995 − p2), 0, 1)`, then `v = t^(1/gamma)` with `gamma = 2.2`
  default, then through the ramp
  `#0f172a → #0284c7 → #38bdf8 → #f59e0b → #ffffff`.
- Expose `gain` (multiplier on `t` before gamma) and `black` (subtracted before `t`) as HUD
  sliders, because the spec says different bands of the same target show different structure and
  a fixed stretch will hide one of them.

**Acceptance.** The rendered `tgt-cen` L-band image, at its catalogue position and `fov_rad`,
reproduces the reference image's *shape and relative brightness* (not absolute scale), by eye at
128×128. This is the single image-quality check that matters.

### 4.3 Hole policy

- **Default.** Holes stay black and are counted. The HUD shows `coverage`.
- **Optional "fill holes".** A 3×3 mean over filled neighbours, only for pixels with ≥ 3 filled
  neighbours, with a persistent `INTERPOLATED` badge in the HUD. Never on by default; never in
  replay of an archived scan without the badge.

---

## 5. Derived measures (the 100 % Data band)

Declared in `11` §3.3 and surfaced in the RTA workspace's derived strip.

| Measure | The question it answers | Readout |
| :--- | :--- | :--- |
| `rta.image_quality` | Is this image as deep as it should be? | coverage %, mean SNR dB, rejected sample count, verdict |
| `rta.scan_progress` | Will this scan finish in time? | progress %, projected completion time vs `expected_duration_s` |
| `rta.dish_health` | Which dishes are degrading the array? | worst 5 dishes by composite score, each with the reason |
| `rta.array_thermal` | Is it a hot day or one hot dish? | mean K, p95 K, count above the warn limit |
| `rta.band_contrast` | How different is this source between bands? | per-band mean/p95/range plus pixel-wise correlation |
| `rta.pointing_error` | Is the array actually on target? | mean and max angular error between commanded and reported |
| `rta.uptime` | Are we holding ≥ 80 dishes? | count vs `availability.min_active` |

**Acceptance.** Each measure is reachable as a card in the derived strip and at
`/api/measure/rta/<key>`; each returns a verdict that matches the corresponding alert state.

---

## 6. Persistence and replay specifics

| Concern | Decision |
| :--- | :--- |
| Scan samples volume | ~13 000 rows per 9-minute scan; keep them all. A 26 h retention window holds ~6 scans per sub-array, which is enough for the exam and keeps `HARD_ROW_LIMIT` safe |
| Replay reconstruction | The client rebuilds the mosaic from replayed samples using the same `ScanRaster`; the `started` event recreates the geometry (`07` §4.3.2) |
| Scan comparison across sessions | `rta.band_contrast` needs two scans; keep `scanHistory` bounded to 8 scans per service in the client and read older ones from the store |
| `commanded` state churn | 10 s per dish while tracking → 10 rows/s. De-duplication keeps it to actual changes; the store's `state_change` is small |
| Backfilled samples | Marked; excluded from ingestion-health charts, included in images (they are real measurements) |

---

## 7. Failure modes specific to RTA data

| Failure | Detection | Behaviour |
| :--- | :--- | :--- |
| A sub-array disappears | `$topology` changes; retained state cleared | Remove it from the UI, keep its history; the scan it was running is marked `abandoned` locally |
| Scan event lost | Samples arrive for an unknown `scanId` | Pending buffer, then inferred geometry flagged in the HUD |
| `grid_size` differs from the default | `started` event | Raster re-created at the new size; the previous image is kept in history |
| Whole scan null-heavy (dish acquiring) | High `rejected` count with reason `null` | HUD says "acquiring"; not an error |
| Two scans on two sub-arrays at once | Two distinct `scanId`s | The workspace shows the *selected* sub-array's image and offers the other as a thumbnail |
| `band_hz` changes mid-scan | Should not happen; assert | If it does, keep the first band and log |

---

## 8. Test plan

- Fixture: a recorded `$topology` + 200 scan samples for `tgt-cen`; assert image checksum,
  coverage, rejected counts by reason.
- Unit: pixel mapping (3 cases), inverse mapping (3 cases), out-of-range rejection.
- Unit: mean accumulation with 1, 2 and 3 samples; hole counting.
- Unit: each cleaning rule independently.
- Integration: 50× replay of a recorded scan produces byte-identical pixel data to the 1× run.
- Manual: visual comparison against the spec's reference images for `tgt-cen`, `tgt-ori`,
  `tgt-vel`, `tgt-lmc` at the matching band.

---

## 9. Open decisions

- **Do we clean on the server?** No. Cleaning is a display decision (the researcher may want the
  raw view), so it lives in `imaging.ts` with a toggle. The *rejected counts* are surfaced so the
  decision is visible.
- **Do we store the reconstructed image?** No. Images are derived; storing them would multiply the
  database and would go stale if the cleaning improves.