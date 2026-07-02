/**
 * Pop probe (v3 §12.2, K-4's measuring stick) — flags DISCRETE transition
 * events (LOD ring swaps, impostor crossfade jumps, shadow-band steps)
 * during a deterministic flythrough, separated from continuous camera-motion
 * change and from K-1-style shimmer.
 *
 * Drive: the SAME Catmull-Rom tour as the live flythrough, sampled at fixed
 * path-time per frame via __laasDbg.flyPose(u) + setPose + settle(1) (the
 * live flythrough integrates wall dt — not reproducible headless; the pure
 * sampler is). World frozen, wind 0, exposure locked: remaining frame-pair
 * change = camera motion (continuous) + transition events (steps).
 *
 * Discrimination against camera motion: run the path SLOWED (--slow N,
 * default 4 = quarter speed). Transitions are path-POSITION-driven — a
 * genuine ring swap stays a full-magnitude 1-frame step at any speed, while
 * arrival/parallax/rotation deltas all shrink N× under the MAD floor and
 * the ±4-frame step window (at ×4, rotation drift ≤0.1 tile per window).
 * Near lateral content at high flow remains un-probeable (documented
 * limitation — the user's free-flight confirm covers it).
 *
 * Detector: per 32-px tile, mean-luma time series x[t] (captured at 1/4 res).
 *   jump      J = |x[t] − median(x[t−4..t−1])|
 *   sustained S = |median(x[t+1..t+4]) − median(x[t−4..t−1])|
 *   score     = S / (MAD of recent Δx + 0.5)   ← a pop is a step ABOVE the
 *               tile's own motion noise; fast-moving near-field tiles have
 *               high MAD and self-suppress, distant stable tiles flag hard.
 * Global-median Δ subtracted per frame (guards residual exposure drift).
 * Events coalesce per tile within ±4 frames; 2-tile screen border excluded
 * (content influx at edges under translation).
 *
 *   npx tsx tools/probe-pops.ts [--frames 2760] [--u0 0] [--u1 1]
 *     [--w 2592] [--h 1676] [--score 8] [--sustain 3] [--tag name]
 *     [--maxevents N]  [--<k>=v forwarded to the page]
 *
 * Acceptance (K-4): zero events at default thresholds over the full tour;
 * user confirms in free flight.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
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

interface PopEvent {
  frame: number;
  u: number;
  /** tile center in full-res pixels */
  cx: number;
  cy: number;
  jump: number;
  sustained: number;
  score: number;
}

interface PopResult {
  frames: number;
  tilesX: number;
  tilesY: number;
  misaligned: number;
  events: PopEvent[];
  /** count of raw (pre-coalesce) detections */
  rawDetections: number;
  /** first ≤24 events with before/at/after crop strips (data URLs) */
  crops: (PopEvent & { png: string })[];
}

function pageScript(opts: {
  frames: number;
  u0: number;
  u1: number;
  scoreThresh: number;
  sustainThresh: number;
}): string {
  return `(async () => {
  const O = ${JSON.stringify(opts)};
  const hk = window.__laas;
  const dbg = window.__laasDbg;
  if (!hk || !hk.settle || !hk.stats || !hk.setPose) throw new Error('hooks missing');
  if (!dbg || typeof dbg.flyPose !== 'function') throw new Error('__laasDbg.flyPose missing');
  const canvas = document.querySelector('#app canvas');
  if (!canvas) throw new Error('no #app canvas');
  const W = canvas.width, H = canvas.height;
  const qw = Math.floor(W / 4), qh = Math.floor(H / 4);
  const stage = document.createElement('canvas');
  stage.width = qw; stage.height = qh;
  const ctx = stage.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2d ctx');
  const TQ = 8; // tile = 8 px at quarter res = 32 px full res
  const tw = Math.floor(qw / TQ), th = Math.floor(qh / TQ);
  const nT = tw * th;
  const series = []; // Float32Array(nT) per frame
  let misaligned = 0;

  const capture = () => {
    ctx.drawImage(canvas, 0, 0, qw, qh);
    const d = ctx.getImageData(0, 0, qw, qh).data;
    const tiles = new Float32Array(nT);
    for (let ty = 0; ty < th; ty++) {
      for (let tx = 0; tx < tw; tx++) {
        let s = 0;
        for (let y = 0; y < TQ; y++) {
          let j = ((ty * TQ + y) * qw + tx * TQ) * 4;
          for (let x = 0; x < TQ; x++, j += 4) {
            s += 0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2];
          }
        }
        tiles[ty * tw + tx] = s / (TQ * TQ);
      }
    }
    return tiles;
  };

  // quarter-res luma ring for event crops (before/at/after) — detection is
  // ONLINE at center t = f−4 so pixel context is still in the ring
  const nQ = qw * qh;
  const RING = 14;
  const lumaRing = []; // index f % 9 → Float32Array(nQ), last 9 frames
  for (let r = 0; r < 9; r++) lumaRing.push(new Float32Array(nQ));
  const lastQuarter = (f) => lumaRing[f % 9];

  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; };
  const events = [];
  const crops = [];
  let raw = 0;
  const B = 2; // border tiles excluded
  const lastEventAt = new Int32Array(nT).fill(-1000);
  const K = 4;
  const globalD = new Float32Array(O.frames);

  const cropStrip = (tf, tx, ty) => {
    // before (t−4) | at (t) | after (t+4), 96×72 quarter-res px each, ×3 zoom
    const CW = 96, CH = 72, Z = 3;
    const cxq = Math.min(Math.max(Math.round((tx + 0.5) * TQ), CW / 2), qw - CW / 2);
    const cyq = Math.min(Math.max(Math.round((ty + 0.5) * TQ), CH / 2), qh - CH / 2);
    const cnv = document.createElement('canvas');
    cnv.width = (CW * 3 + 8) * Z; cnv.height = CH * Z;
    const c2 = cnv.getContext('2d');
    if (!c2) return '';
    const img = c2.createImageData(CW, CH);
    const draw = (luma, slot) => {
      for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) {
        const v = luma[(cyq - CH / 2 + y) * qw + (cxq - CW / 2 + x)];
        const o = (y * CW + x) * 4;
        img.data[o] = v; img.data[o + 1] = v; img.data[o + 2] = v; img.data[o + 3] = 255;
      }
      const tmp = document.createElement('canvas');
      tmp.width = CW; tmp.height = CH;
      const t2 = tmp.getContext('2d');
      if (!t2) return;
      t2.putImageData(img, 0, 0);
      c2.imageSmoothingEnabled = false;
      c2.drawImage(tmp, slot * (CW + 8) * Z, 0, CW * Z, CH * Z);
    };
    draw(lumaRing[(tf - 4) % 9], 0);
    draw(lumaRing[tf % 9], 1);
    draw(lumaRing[(tf + 4) % 9], 2);
    // tile marker
    c2.strokeStyle = '#f00';
    for (let slot = 0; slot < 3; slot++) {
      c2.strokeRect(
        (slot * (CW + 8) + CW / 2 - TQ / 2) * Z, (CH / 2 - TQ / 2) * Z, TQ * Z, TQ * Z,
      );
    }
    return cnv.toDataURL('image/png');
  };

  const du = (O.u1 - O.u0) / O.frames;
  // pre-roll at the segment start: the pose jump from spawn re-converges
  // TRAA history (~33+ frames at the far-rest weight floor) — without this
  // the first events are fake
  hk.setPose(dbg.flyPose(O.u0));
  await hk.settle(120);
  for (let f = 0; f < O.frames; f++) {
    const pose = dbg.flyPose(O.u0 + f * du);
    hk.setPose(pose);
    const before = hk.stats.frame;
    await hk.settle(1);
    if (hk.stats.frame !== before + 1) misaligned++;
    series.push(capture());
    // quarter-res luma into the ring
    {
      const d = ctx.getImageData(0, 0, qw, qh).data;
      const L = lumaRing[f % 9];
      for (let i = 0, j = 0; i < nQ; i++, j += 4) {
        L[i] = 0.2126 * d[j] + 0.7152 * d[j + 1] + 0.0722 * d[j + 2];
      }
    }
    if (f === 0) {
      let m = 0;
      for (let i = 0; i < nT; i++) m += series[0][i];
      if (m / nT < 1) throw new Error('canvas capture is black');
    }
    if (f >= 1) {
      const dts = new Float32Array(nT);
      for (let i = 0; i < nT; i++) dts[i] = series[f][i] - series[f - 1][i];
      globalD[f] = med(dts);
    }
    // trim series memory outside the analysis window
    if (f - RING - 1 >= 0) series[f - RING - 1] = null;

    // online detection at center t = f − K
    const t = f - K;
    if (t < K) continue;
    for (let ty = B; ty < th - B; ty++) {
      for (let tx = B; tx < tw - B; tx++) {
        const i = ty * tw + tx;
        const pre = [], post = [];
        for (let k = 1; k <= K; k++) {
          pre.push(series[t - k][i]);
          post.push(series[t + k][i]);
        }
        const b = med(pre), a = med(post);
        const x = series[t][i] - globalD[t];
        const J = Math.abs(x - b);
        const S = Math.abs(a - b);
        if (S < O.sustainThresh || J < O.sustainThresh) continue;
        // motion-noise floor: MAD of the tile's recent frame deltas
        const dd = [];
        for (let k = 1; k <= 8 && t - k - 1 >= 0 && series[t - k - 1]; k++) {
          dd.push(Math.abs(series[t - k][i] - series[t - k - 1][i]));
        }
        if (dd.length < 4) continue;
        const mad = med(dd);
        const score = S / (mad + 0.5);
        if (score < O.scoreThresh) continue;
        raw++;
        if (t - lastEventAt[i] <= K) { lastEventAt[i] = t; continue; }
        lastEventAt[i] = t;
        const ev = {
          frame: t, u: O.u0 + t * du,
          cx: Math.round((tx + 0.5) * TQ * 4), cy: Math.round((ty + 0.5) * TQ * 4),
          jump: J, sustained: S, score,
        };
        events.push(ev);
        if (crops.length < 24) {
          crops.push({ ...ev, png: cropStrip(t, tx, ty) });
        }
      }
    }
  }
  events.sort((a, b) => b.score - a.score);
  return JSON.stringify({
    frames: O.frames, tilesX: tw, tilesY: th, misaligned,
    events: events.slice(0, 400), rawDetections: raw, crops,
  });
})()`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const width = Number(str(args['w']) ?? 2592);
  const height = Number(str(args['h']) ?? 1676);
  const u0 = Number(str(args['u0']) ?? 0);
  const u1 = Number(str(args['u1']) ?? 1);
  // real flythrough = 92 s × 120 fps = 11040 frames over u 0→1; --slow N
  // multiplies temporal sampling density (see header). --frames overrides.
  const slow = Number(str(args['slow']) ?? 4);
  const frames = args['frames'] !== undefined
    ? Number(str(args['frames']))
    : Math.max(16, Math.round((u1 - u0) * 11040 * slow));
  const scoreThresh = Number(str(args['score']) ?? 8);
  const sustainThresh = Number(str(args['sustain']) ?? 3);
  const tag = str(args['tag']) ?? 'tour';
  const dir = 'shots/wip/pops';
  mkdirSync(dir, { recursive: true });

  const consumed = new Set(['w', 'h', 'frames', 'u0', 'u1', 'score', 'sustain', 'tag', 'maxevents', 'slow']);
  const extra: Record<string, string> = { wind: '0', lockexp: '1' };
  for (const [k, v] of Object.entries(args)) {
    if (!consumed.has(k)) extra[k] = v === true ? '1' : String(v);
  }

  const { browser } = await launchWebGPU();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  const url = laasUrl({ scene: 'world', width, height, T: 19, extra });
  console.log(`[pops] ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 240000, polling: 250 },
  );
  const bootErr = await page.evaluate(() => window.__laas.error);
  if (bootErr) throw new Error(bootErr);
  await page.evaluate(async () => window.__laas.settle && (await window.__laas.settle(240)));

  console.log(`[pops] flying u ${u0}→${u1} over ${frames} frames…`);
  const t0 = Date.now();
  const raw = await page.evaluate(pageScript({ frames, u0, u1, scoreThresh, sustainThresh }));
  await browser.close();
  const res = JSON.parse(raw as string) as PopResult;
  console.log(
    `[pops] ${res.frames} frames in ${((Date.now() - t0) / 1000).toFixed(0)}s ` +
      `(${res.tilesX}×${res.tilesY} tiles${res.misaligned ? `, MISALIGNED ${res.misaligned}` : ''})`,
  );
  console.log(
    `[pops] events: ${res.events.length} (raw detections ${res.rawDetections}) ` +
      `at score≥${scoreThresh}, sustained≥${sustainThresh}/255`,
  );
  for (const e of res.events.slice(0, Number(str(args['maxevents']) ?? 25))) {
    console.log(
      `  u=${e.u.toFixed(4)} f=${e.frame}  (${e.cx},${e.cy})  ` +
        `Δ=${e.sustained.toFixed(1)} jump=${e.jump.toFixed(1)} score=${e.score.toFixed(1)}`,
    );
  }
  let ci = 0;
  for (const c of res.crops) {
    const b64 = c.png.split(',')[1];
    if (!b64) continue;
    const p = `${dir}/${tag}-crop${String(ci).padStart(2, '0')}-u${c.u.toFixed(4)}-s${c.score.toFixed(0)}.png`;
    writeFileSync(p, Buffer.from(b64, 'base64'));
    ci++;
  }
  if (ci > 0) console.log(`[pops] wrote ${ci} event crop strips (before|at|after)`);
  const outPath = `${dir}/${tag}-events.json`;
  writeFileSync(
    outPath,
    JSON.stringify({ ...res, crops: res.crops.map(({ png: _png, ...e }) => e) }, null, 2),
  );
  console.log(`[pops] wrote ${outPath}`);
  if (res.events.length > 0) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error('[pops] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
