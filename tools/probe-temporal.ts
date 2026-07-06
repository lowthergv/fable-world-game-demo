/**
 * Temporal-stability probe (v3 §12.1) — K-1's measuring stick and the
 * regression guard for every TRAA/impostor/shadow change after it.
 *
 * Records CONSECUTIVE frames in-page (node-side screenshots advance the
 * frame counter unpredictably) and computes per-pixel temporal metrics:
 *
 *   rest  — frozen world (wind 0, exposure locked, world time frozen),
 *           camera static. After convergence the only frame-to-frame
 *           changes are frame-indexed effects: TRAA jitter resolve error,
 *           cascade-stagger swim, contact-shadow hash — exactly K-1's
 *           domain (wall-clock water is the known exception; judge tiles).
 *           Metric: flicker energy = mean |Δluma| per frame pair (8-bit),
 *           plus temporal std per pixel.
 *   pan   — deterministic frame-locked yaw pan (setPose per frame, the
 *           probe-cloudlag pattern). Pure rotation has NO parallax and NO
 *           disocclusion, so frame t is reprojected onto frame t-1 with an
 *           EXACT constant homography; the residual |Δluma| on valid
 *           pixels is flicker-under-motion. Absolute values include a
 *           resampling floor — compare runs RELATIVELY (before/after).
 *
 * Outputs: metrics JSON, flicker-energy heatmap PNG (per mode), one
 * reference frame PNG, ranked worst 48-px tiles (attribution), histogram
 * percentiles. Runs are frame-aligned to absolute frame numbers so two
 * builds produce comparable sequences (STATUS measurement methodology).
 *
 *   npx tsx tools/probe-temporal.ts [--shot 3] [--T 19] [--mode both|rest|pan]
 *     [--frames 96] [--panframes 72] [--step 0.01] [--w 2592] [--h 1676]
 *     [--tag name] [--scale 4] [--maxmean X] [--maxtile Y] [--cam "..."]
 *     [--seed N] [--<anything>=v forwarded as page param, e.g. --ablate taa]
 *
 * Pass criteria (when --maxmean/--maxtile given, applied to REST metrics):
 * exit 1 on breach — wire into the battery once calibrated.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import type { Page } from 'playwright';
import { launchWebGPU, laasUrl } from './launch';

interface Args {
  [k: string]: string | boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[a.slice(2)] = next;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

interface TileMetric {
  cx: number;
  cy: number;
  mean: number;
}

interface RunMetrics {
  mode: string;
  W: number;
  H: number;
  frames: number;
  pairs: number;
  misaligned: number;
  startFrame: number;
  endFrame: number;
  meanFlicker: number;
  p50: number;
  p95: number;
  p99: number;
  pctOver1: number;
  pctOver2: number;
  pctOver5: number;
  meanStd: number | null;
  validPct: number;
  tiles: TileMetric[];
  heat: string;
}

/** absolute-frame anchors: identical sequences across runs of the same build */
const REST_START = 512;
const PAN_START = 800;

/**
 * In-page recording protocol. Passed as a STRING evaluate — tsx/esbuild
 * injects a `__name` helper around function expressions inside evaluate
 * callbacks (ReferenceError in page; see probe-pointerlock).
 */
function pageScript(opts: {
  mode: 'rest' | 'pan';
  frames: number;
  step: number;
  preRoll: number;
  heatScale: number;
}): string {
  return `(async () => {
  const O = ${JSON.stringify(opts)};
  const hk = window.__laas;
  if (!hk || !hk.settle || !hk.stats || !hk.getPose || !hk.setPose) throw new Error('hooks missing');
  const canvas = document.querySelector('#app canvas');
  if (!canvas) throw new Error('no #app canvas');
  const W = canvas.width, H = canvas.height, N = W * H;
  const stage = document.createElement('canvas');
  stage.width = W; stage.height = H;
  const ctx = stage.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2d ctx');

  const lum = new Float32Array(N);
  const prev = new Float32Array(N);
  const sumD = new Float32Array(N);
  const sumL = new Float64Array(N);
  const sumL2 = O.mode === 'rest' ? new Float64Array(N) : null;

  const capture = () => {
    ctx.drawImage(canvas, 0, 0);
    const d = ctx.getImageData(0, 0, W, H).data;
    for (let i = 0, j = 0; i < N; i++, j += 4) {
      lum[i] = 0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2];
    }
  };

  // pan: constant pure-yaw homography, precomputed once (bilinear map)
  let mIdx = null, mW00 = null, mW10 = null, mW01 = null, mW11 = null, mValid = null;
  if (O.mode === 'pan') {
    const p = hk.getPose().pitch, s = O.step;
    const cp = Math.cos(p), sp = Math.sin(p), cs = Math.cos(s), ss = Math.sin(s);
    // M = Rx(-p)·Ry(s)·Rx(p): current-camera dir -> previous-camera dir
    const m00 = cs, m01 = ss * sp, m02 = ss * cp;
    const m10 = -sp * ss, m11 = cp * cp + sp * sp * cs, m12 = sp * cp * (cs - 1);
    const m20 = -cp * ss, m21 = sp * cp * (cs - 1), m22 = sp * sp + cp * cp * cs;
    const fovY = 55 * Math.PI / 180;
    const tanV = Math.tan(fovY / 2), tanH = tanV * W / H;
    mIdx = new Int32Array(N); mValid = new Uint8Array(N);
    mW00 = new Float32Array(N); mW10 = new Float32Array(N);
    mW01 = new Float32Array(N); mW11 = new Float32Array(N);
    for (let y = 0; y < H; y++) {
      const yn = (1 - 2 * (y + 0.5) / H) * tanV;
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const xn = (2 * (x + 0.5) / W - 1) * tanH;
        const dx = m00 * xn + m01 * yn - m02;
        const dy = m10 * xn + m11 * yn - m12;
        const dz = m20 * xn + m21 * yn - m22;
        if (dz >= -1e-6) continue;
        const sx = ((dx / -dz) / tanH + 1) * 0.5 * W - 0.5;
        const sy = (1 - (dy / -dz) / tanV) * 0.5 * H - 0.5;
        if (sx < 0 || sy < 0 || sx > W - 2 || sy > H - 2) continue;
        const x0 = Math.floor(sx), y0 = Math.floor(sy);
        const fx = sx - x0, fy = sy - y0;
        mIdx[i] = y0 * W + x0; mValid[i] = 1;
        mW00[i] = (1 - fx) * (1 - fy); mW10[i] = fx * (1 - fy);
        mW01[i] = (1 - fx) * fy; mW11[i] = fx * fy;
      }
    }
  }

  const p0 = hk.getPose();
  const startFrame = hk.stats.frame;
  let misaligned = 0;
  // pan pre-roll: put TRAA history into panning steady state before recording
  if (O.mode === 'pan') {
    for (let k = 0; k < O.preRoll; k++) {
      hk.setPose({ p: p0.p, yaw: p0.yaw + (k + 1) * O.step, pitch: p0.pitch });
      await hk.settle(1);
    }
  }
  const yawBase = O.mode === 'pan' ? p0.yaw + O.preRoll * O.step : p0.yaw;
  let pairs = 0;
  for (let f = 0; f < O.frames; f++) {
    if (O.mode === 'pan') {
      hk.setPose({ p: p0.p, yaw: yawBase + (f + 1) * O.step, pitch: p0.pitch });
    }
    const before = hk.stats.frame;
    await hk.settle(1);
    if (hk.stats.frame !== before + 1) misaligned++;
    capture();
    if (f === 0) {
      let m = 0;
      for (let i = 0; i < N; i += 997) m += lum[i];
      if (m / (N / 997) < 1) throw new Error('canvas capture is black — drawImage readback failed');
    }
    for (let i = 0; i < N; i++) sumL[i] += lum[i];
    if (sumL2) for (let i = 0; i < N; i++) sumL2[i] += lum[i] * lum[i];
    if (f > 0) {
      pairs++;
      if (O.mode === 'rest') {
        for (let i = 0; i < N; i++) sumD[i] += Math.abs(lum[i] - prev[i]);
      } else {
        for (let i = 0; i < N; i++) {
          if (!mValid[i]) continue;
          const k = mIdx[i];
          const s = mW00[i] * prev[k] + mW10[i] * prev[k + 1]
                  + mW01[i] * prev[k + W] + mW11[i] * prev[k + W + 1];
          sumD[i] += Math.abs(lum[i] - s);
        }
      }
    }
    prev.set(lum);
  }
  const endFrame = hk.stats.frame;

  // aggregates over counted pixels (pan: valid reprojection only)
  const counted = (i) => O.mode === 'rest' || (mValid && mValid[i] === 1);
  let nC = 0, sum = 0, over1 = 0, over2 = 0, over5 = 0;
  const BINS = 4096, BIN_MAX = 64; // flicker 0..64 (8-bit luma units)
  const hist = new Float64Array(BINS);
  for (let i = 0; i < N; i++) {
    if (!counted(i)) continue;
    const f = sumD[i] / pairs;
    nC++; sum += f;
    if (f > 1) over1++;
    if (f > 2) over2++;
    if (f > 5) over5++;
    hist[Math.min(BINS - 1, Math.floor(f / BIN_MAX * BINS))]++;
  }
  const pctile = (q) => {
    let acc = 0; const target = q * nC;
    for (let b = 0; b < BINS; b++) { acc += hist[b]; if (acc >= target) return (b + 0.5) * BIN_MAX / BINS; }
    return BIN_MAX;
  };
  let meanStd = null;
  if (sumL2) {
    let s = 0;
    for (let i = 0; i < N; i++) {
      const m = sumL[i] / O.frames;
      s += Math.sqrt(Math.max(0, sumL2[i] / O.frames - m * m));
    }
    meanStd = s / N;
  }

  // 48-px tile ranking for attribution
  const TS = 48, tw = Math.ceil(W / TS), th = Math.ceil(H / TS);
  const tSum = new Float64Array(tw * th), tCnt = new Float64Array(tw * th);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!counted(i)) continue;
    const t = Math.floor(y / TS) * tw + Math.floor(x / TS);
    tSum[t] += sumD[i] / pairs; tCnt[t]++;
  }
  const tiles = [];
  for (let t = 0; t < tw * th; t++) {
    if (tCnt[t] < TS * TS * 0.5) continue;
    tiles.push({ cx: (t % tw) * TS + TS / 2, cy: Math.floor(t / tw) * TS + TS / 2, mean: tSum[t] / tCnt[t] });
  }
  tiles.sort((a, b) => b.mean - a.mean);

  // heatmap: flicker ramp over a faint mean-luma underlay
  const img = ctx.createImageData(W, H);
  for (let i = 0; i < N; i++) {
    const g = (sumL[i] / O.frames) * 0.25;
    let r = g, gg = g, b = g;
    if (counted(i)) {
      const v = Math.min(1, (sumD[i] / pairs) / O.heatScale);
      r += 255 * Math.min(1, v * 2.4);
      gg += 255 * Math.max(0, Math.min(1, v * 2.4 - 0.9));
      b += 255 * Math.max(0, v * 3 - 2.3);
    } else { b += 40; }
    img.data[i * 4] = Math.min(255, r);
    img.data[i * 4 + 1] = Math.min(255, gg);
    img.data[i * 4 + 2] = Math.min(255, b);
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const heat = stage.toDataURL('image/png');

  return JSON.stringify({
    mode: O.mode, W, H, frames: O.frames, pairs, misaligned, startFrame, endFrame,
    meanFlicker: sum / nC, p50: pctile(0.5), p95: pctile(0.95), p99: pctile(0.99),
    pctOver1: over1 / nC * 100, pctOver2: over2 / nC * 100, pctOver5: over5 / nC * 100,
    meanStd, validPct: nC / N * 100, tiles: tiles.slice(0, 10), heat,
  });
})()`;
}

async function settleToFrame(page: Page, target: number): Promise<number> {
  return page.evaluate(async (t) => {
    const hk = window.__laas;
    if (!hk.settle || !hk.stats) throw new Error('hooks missing');
    // tolerate overshoot (screenshots between runs advance frames): fall
    // forward to the next 64-frame boundary past the current frame
    let goal = t;
    if (hk.stats.frame > t) goal = Math.ceil((hk.stats.frame + 1) / 64) * 64;
    for (let guard = 0; guard < 5000 && hk.stats.frame < goal; guard++) await hk.settle(1);
    return hk.stats.frame;
  }, target);
}

function printRun(m: RunMetrics): void {
  console.log(
    `[temporal:${m.mode}] frames ${m.startFrame}→${m.endFrame} (${m.pairs} pairs` +
      `${m.misaligned ? `, MISALIGNED ${m.misaligned}` : ''}) valid ${m.validPct.toFixed(1)}%`,
  );
  console.log(
    `[temporal:${m.mode}] flicker mean=${m.meanFlicker.toFixed(3)} p50=${m.p50.toFixed(2)} ` +
      `p95=${m.p95.toFixed(2)} p99=${m.p99.toFixed(2)} /255 · ` +
      `>1: ${m.pctOver1.toFixed(2)}% · >2: ${m.pctOver2.toFixed(2)}% · >5: ${m.pctOver5.toFixed(3)}%` +
      (m.meanStd !== null ? ` · meanStd=${m.meanStd.toFixed(3)}` : ''),
  );
  console.log(`[temporal:${m.mode}] worst tiles (48px, center px):`);
  for (const t of m.tiles.slice(0, 8)) {
    console.log(`    (${t.cx},${t.cy})  ${t.mean.toFixed(2)}`);
  }
}

function saveHeat(m: RunMetrics, path: string): void {
  const b64 = m.heat.split(',')[1];
  if (!b64) throw new Error('bad heatmap data URL');
  writeFileSync(path, Buffer.from(b64, 'base64'));
  console.log(`[temporal] wrote ${path}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const width = Number(str(args['w']) ?? 2592);
  const height = Number(str(args['h']) ?? 1676);
  const mode = str(args['mode']) ?? 'both';
  const frames = Number(str(args['frames']) ?? 96);
  const panFrames = Number(str(args['panframes']) ?? 72);
  const step = Number(str(args['step']) ?? 0.01);
  const heatScale = Number(str(args['scale']) ?? 4);
  const shot = str(args['shot']) ?? '3';
  const tag = str(args['tag']) ?? `shot${shot}`;
  const dir = 'shots/wip/temporal';
  mkdirSync(dir, { recursive: true });

  const consumed = new Set([
    'w', 'h', 'mode', 'frames', 'panframes', 'step', 'scale', 'shot', 'tag',
    'maxmean', 'maxtile', 'cam', 'seed', 'T', 'base',
  ]);
  const extra: Record<string, string> = { wind: '0', lockexp: '1' };
  if (!str(args['cam'])) extra['shot'] = shot;
  for (const [k, v] of Object.entries(args)) {
    if (!consumed.has(k)) extra[k] = v === true ? '1' : String(v);
  }
  const urlOpts: Parameters<typeof laasUrl>[0] = {
    scene: 'world', width, height, extra, T: Number(str(args['T']) ?? 19),
  };
  if (str(args['cam'])) urlOpts.cam = str(args['cam']);
  if (args['seed'] !== undefined) urlOpts.seed = Number(str(args['seed']));

  const { browser } = await launchWebGPU();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`[page:error] ${msg.text()}`);
  });
  const url = laasUrl(urlOpts, str(args['base']) ?? undefined);
  console.log(`[temporal] ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 240000, polling: 250 },
  );
  const bootErr = await page.evaluate(() => window.__laas.error);
  if (bootErr) throw new Error(bootErr);

  const results: RunMetrics[] = [];

  if (mode === 'both' || mode === 'rest') {
    const at = await settleToFrame(page, REST_START);
    console.log(`[temporal] rest run from frame ${at} (${frames} frames)…`);
    const raw = await page.evaluate(
      pageScript({ mode: 'rest', frames, step, preRoll: 0, heatScale }),
    );
    const m = JSON.parse(raw as string) as RunMetrics;
    results.push(m);
    printRun(m);
    saveHeat(m, `${dir}/${tag}-rest-heat.png`);
    await page.screenshot({ path: `${dir}/${tag}-frame.png` });
    console.log(`[temporal] wrote ${dir}/${tag}-frame.png`);
  }

  if (mode === 'both' || mode === 'pan') {
    const at = await settleToFrame(page, PAN_START);
    console.log(`[temporal] pan run from frame ${at} (step ${step} rad/frame, ${panFrames} frames)…`);
    const raw = await page.evaluate(
      pageScript({ mode: 'pan', frames: panFrames, step, preRoll: 24, heatScale }),
    );
    const m = JSON.parse(raw as string) as RunMetrics;
    results.push(m);
    printRun(m);
    saveHeat(m, `${dir}/${tag}-pan-heat.png`);
  }

  await browser.close();

  const metricsPath = `${dir}/${tag}-metrics.json`;
  writeFileSync(
    metricsPath,
    JSON.stringify(
      results.map(({ heat: _heat, ...rest }) => rest),
      null,
      2,
    ),
  );
  console.log(`[temporal] wrote ${metricsPath}`);

  // pass/fail (rest metrics) once thresholds are calibrated
  const maxMean = str(args['maxmean']);
  const maxTile = str(args['maxtile']);
  const rest = results.find((r) => r.mode === 'rest');
  if (rest && (maxMean !== undefined || maxTile !== undefined)) {
    const worstTile = rest.tiles[0]?.mean ?? 0;
    const meanFail = maxMean !== undefined && rest.meanFlicker > Number(maxMean);
    const tileFail = maxTile !== undefined && worstTile > Number(maxTile);
    if (meanFail || tileFail) {
      console.error(
        `[temporal] FAIL: mean ${rest.meanFlicker.toFixed(3)} (max ${maxMean ?? '—'}) · ` +
          `worst tile ${worstTile.toFixed(2)} (max ${maxTile ?? '—'})`,
      );
      process.exit(1);
    }
    console.log('[temporal] PASS');
  }
}

main().catch((e: unknown) => {
  console.error('[temporal] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
