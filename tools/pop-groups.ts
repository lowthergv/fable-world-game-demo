/**
 * Per-group compact-counter diff across a dolly pop (K-4 triage): single
 * boot, steps frame by frame, after each settle does a SYNCHRONOUS per-group
 * counter readback (Forests.debugCounters via __laasDbg.forests) plus the
 * luma of a window at --px. Prints, per frame, the luma delta and every
 * main-view group whose count changed — with decoded (pool, ring) labels and
 * a CAP! marker when a group sits at its capacity (silent drop zone).
 *
 *   npx tsx tools/pop-groups.ts --cam "-11,283,1330,1.27,-0.06" --speed 0.06 \
 *     --fa 914 --fb 926 --px "784,816" [--casters 1] [--<k>=v → page]
 */

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

const TREES = ['spruce', 'pine', 'beech', 'birch', 'karst', 'snag'];

/** mirror of Forests.groupOf layout for main-view groups */
function groupLabel(g: number): string {
  if (g < 48) {
    const pool = g >> 1;
    const cls = pool >> 2;
    const variant = pool & 3;
    return `${TREES[cls]}v${variant}.r${(g & 1) + 1}`;
  }
  if (g < 54) return `${TREES[g - 48]}.IMPOSTOR`;
  if (g < 82) {
    const u = g - 54;
    return `under${8 + (u >> 2)}v${u & 3}`;
  }
  if (g < 146) {
    const pe = (g - 82) >> 1;
    const cls = 16 + (pe >> 2);
    const variant = pe & 3;
    const names: Record<number, string> = {
      16: 'log', 17: 'stump', 18: 'slab', 19: 'snagEx',
      20: 'StoneL', 21: 'StoneM', 22: 'StoneS', 23: 'Branch',
    };
    return `${names[cls] ?? `cls${cls}`}v${variant}.r${((g - 82) & 1) + 1}`;
  }
  if (g < 170) {
    const h = g - 146;
    return `${TREES[h >> 2]}v${h & 3}.HERO`;
  }
  return `caster.g${g}`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cam = (str(args['cam']) ?? '').split(',').map(Number);
  const speed = Number(str(args['speed']) ?? 0.06);
  const fa = Number(str(args['fa']));
  const fb = Number(str(args['fb']));
  const px = (str(args['px']) ?? '').split(',').map(Number);
  if (cam.length < 5 || cam.some((n) => !Number.isFinite(n))) {
    throw new Error('need --cam "x,y,z,yaw,pitch"');
  }
  if (!Number.isFinite(fa) || !Number.isFinite(fb) || fb <= fa) {
    throw new Error('need --fa < --fb');
  }
  if (px.length !== 2 || px.some((n) => !Number.isFinite(n))) {
    throw new Error('need --px "x,y" (full-res)');
  }
  const includeCasters = str(args['casters']) === '1';
  const settle = Number(str(args['settle']) ?? 8);
  const width = Number(str(args['w']) ?? 2592);
  const height = Number(str(args['h']) ?? 1676);

  const consumed = new Set(['cam', 'speed', 'fa', 'fb', 'px', 'settle', 'w', 'h', 'T', 'casters']);
  const extra: Record<string, string> = { wind: '0', lockexp: '1' };
  for (const [k, v] of Object.entries(args)) {
    if (!consumed.has(k)) extra[k] = v === true ? '1' : String(v);
  }

  const { browser } = await launchWebGPU();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  const url = laasUrl({
    scene: 'world', width, height, T: Number(str(args['T']) ?? 12), extra,
  });
  console.log(`[pop-groups] ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 240000, polling: 250 },
  );
  const bootErr = await page.evaluate(() => window.__laas.error);
  if (bootErr) throw new Error(bootErr);

  const O = { cam, speed, fa, fb, px, settle };
  const script = `(async () => {
  const O = ${JSON.stringify(O)};
  const hk = window.__laas;
  const dbg = window.__laasDbg;
  if (!hk.setPose || !hk.settle) throw new Error('hooks missing');
  if (!dbg || !dbg.forests || !dbg.engine) throw new Error('__laasDbg.forests missing');
  const canvas = document.querySelector('#app canvas');
  if (!canvas) throw new Error('no #app canvas');
  const stage = document.createElement('canvas');
  const WIN = 64;
  stage.width = WIN; stage.height = WIN;
  const ctx = stage.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2d ctx');
  const yaw = O.cam[3], pitch = O.cam[4];
  const fwd = [
    -Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch),
  ];
  const poseAt = (f) => ({
    p: [O.cam[0] + fwd[0] * f * O.speed, O.cam[1] + fwd[1] * f * O.speed, O.cam[2] + fwd[2] * f * O.speed],
    yaw, pitch,
  });
  hk.setPose(poseAt(O.fa));
  await hk.settle(120);
  const out = [];
  for (let f = O.fa; f <= O.fb; f++) {
    hk.setPose(poseAt(f));
    await hk.settle(O.settle);
    // capture BEFORE the counter readback — the GPU sync in debugCounters
    // leaves the canvas post-present (drawImage reads black after it)
    ctx.drawImage(canvas, O.px[0] - WIN / 2, O.px[1] - WIN / 2, WIN, WIN, 0, 0, WIN, WIN);
    const d = ctx.getImageData(0, 0, WIN, WIN).data;
    const snap = await dbg.forests.debugCounters(dbg.engine.renderer);
    let s = 0;
    for (let i = 0; i < WIN * WIN * 4; i += 4) {
      s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    }
    out.push({ f, luma: s / (WIN * WIN), counts: snap.counts, caps: snap.caps });
  }
  return JSON.stringify(out);
})()`;
  const rows = JSON.parse(
    (await page.evaluate(script)) as string,
  ) as { f: number; luma: number; counts: number[]; caps: number[] }[];
  await browser.close();

  console.log(`[pop-groups] window 64px @(${px[0]},${px[1]}):`);
  let prev: { luma: number; counts: number[] } | null = null;
  for (const r of rows) {
    const dl = prev ? r.luma - prev.luma : 0;
    const changes: string[] = [];
    if (prev) {
      const lim = includeCasters ? r.counts.length : 170;
      for (let g = 0; g < lim; g++) {
        const a = prev.counts[g] ?? 0;
        const b = r.counts[g] ?? 0;
        if (a !== b) {
          const cap = r.caps[g] ?? 0;
          const atCap = b >= cap || a >= cap ? ' CAP!' : '';
          changes.push(`${groupLabel(g)}:${b - a >= 0 ? '+' : ''}${b - a}(${b}/${cap})${atCap}`);
        }
      }
    }
    console.log(
      `  f=${r.f}  luma=${r.luma.toFixed(2)}  Δ=${dl >= 0 ? '+' : ''}${dl.toFixed(2)}` +
        (changes.length ? `\n      ${changes.join('  ')}` : ''),
    );
    prev = r;
  }
}

main().catch((e: unknown) => {
  console.error('[pop-groups] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
