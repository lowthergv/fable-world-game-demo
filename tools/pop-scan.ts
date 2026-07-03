/**
 * Frame-by-frame dolly scan across a suspected pop (K-4 triage): single
 * boot, steps the dolly one frame at a time from --fa to --fb, records the
 * mean luma of the 64×64 px window centered on --px "x,y" plus the veg HUD
 * counters each frame. Prints a per-frame table — a 1-frame luma step that
 * coincides with a counter change is a compact-membership event; a gradual
 * ramp is a crossfade.
 *
 *   npx tsx tools/pop-scan.ts --cam "-11,283,1330,1.27,-0.06" --speed 0.06 \
 *     --fa 910 --fb 930 --px "784,816" [--settle 8] [--<k>=v → page]
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
  const settle = Number(str(args['settle']) ?? 8);
  const width = Number(str(args['w']) ?? 2592);
  const height = Number(str(args['h']) ?? 1676);

  const consumed = new Set(['cam', 'speed', 'fa', 'fb', 'px', 'settle', 'w', 'h', 'T']);
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
  console.log(`[pop-scan] ${url}`);
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
  if (!hk.setPose || !hk.settle || !hk.stats) throw new Error('hooks missing');
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
  const dbg = window.__laasDbg;
  const out = [];
  for (let f = O.fa; f <= O.fb; f++) {
    const want = poseAt(f);
    hk.setPose(want);
    await hk.settle(O.settle);
    ctx.drawImage(canvas, O.px[0] - WIN / 2, O.px[1] - WIN / 2, WIN, WIN, 0, 0, WIN, WIN);
    const d = ctx.getImageData(0, 0, WIN, WIN).data;
    let s = 0;
    for (let i = 0; i < WIN * WIN * 4; i += 4) {
      s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    }
    const counters = {};
    for (const [k, v] of Object.entries(hk.stats.counters ?? {})) {
      if (typeof v === 'number') counters[k] = v;
    }
    // actual rendered camera vs requested pose (fly-rig soft floor triage)
    const cp = dbg && dbg.engine ? dbg.engine.camera.position : null;
    const poseErr = cp
      ? Math.hypot(cp.x - want.p[0], cp.y - want.p[1], cp.z - want.p[2])
      : -1;
    const camY = cp ? cp.y : NaN;
    out.push({ f, luma: s / (WIN * WIN), counters, poseErr, camY });
  }
  return JSON.stringify(out);
})()`;
  const rows = JSON.parse(
    (await page.evaluate(script)) as string,
  ) as {
    f: number;
    luma: number;
    counters: Record<string, number>;
    poseErr?: number;
    camY?: number;
  }[];
  await browser.close();

  const keys = Object.keys(rows[0]?.counters ?? {});
  console.log(`[pop-scan] window 64px @(${px[0]},${px[1]}) — luma + counter deltas:`);
  let prev: { luma: number; counters: Record<string, number> } | null = null;
  for (const r of rows) {
    const dl = prev ? r.luma - prev.luma : 0;
    const deltas = prev
      ? keys
          .filter((k) => (r.counters[k] ?? 0) !== (prev?.counters[k] ?? 0))
          .map((k) => `${k}:${(r.counters[k] ?? 0) - (prev?.counters[k] ?? 0)}`)
          .join(' ')
      : '';
    console.log(
      `  f=${r.f}  luma=${r.luma.toFixed(2)}  Δ=${dl >= 0 ? '+' : ''}${dl.toFixed(2)}` +
        (r.poseErr !== undefined && r.poseErr >= 0
          ? `  poseErr=${r.poseErr.toFixed(3)} camY=${(r.camY ?? NaN).toFixed(3)}`
          : '') +
        (deltas ? `  | ${deltas}` : ''),
    );
    prev = r;
  }
}

main().catch((e: unknown) => {
  console.error('[pop-scan] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
