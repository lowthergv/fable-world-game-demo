/**
 * Flythrough path clearance report — walks the tour curve and prints ground
 * clearance minima (the pop probe found the tour clipping tree crowns:
 * whole-frame "flash" events at u≈0.27/0.47/0.48/0.64). Trees reach ~22 m;
 * spans with clearance under --margin (default 24) are flagged with their
 * segment indices so the TOUR waypoints can be re-tuned surgically.
 *
 *   npx tsx tools/probe-clearance.ts [--samples 512] [--margin 24]
 */

import { launchWebGPU, laasUrl } from './launch';

function arg(k: string, d: string): string {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
}

interface Sample {
  u: number;
  seg: number;
  x: number;
  z: number;
  y: number;
  ground: number;
  water: number;
  clearance: number;
}

async function main(): Promise<void> {
  const samples = Number(arg('samples', '512'));
  const margin = Number(arg('margin', '24'));
  const { browser } = await launchWebGPU();
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  await page.goto(laasUrl({ scene: 'world' }), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 240000, polling: 250 },
  );
  const err = await page.evaluate(() => window.__laas.error);
  if (err) throw new Error(err);

  const rows = await page.evaluate(`(() => {
    const hk = window.__laas;
    const dbg = window.__laasDbg;
    if (!hk.groundProbe || !dbg || typeof dbg.flyPose !== 'function') {
      throw new Error('groundProbe/flyPose missing');
    }
    const out = [];
    const N = ${samples};
    for (let i = 0; i <= N; i++) {
      const u = i / N;
      const pose = dbg.flyPose(u);
      const g = hk.groundProbe(pose.p[0], pose.p[2]);
      out.push({
        u, seg: u * 10, x: pose.p[0], z: pose.p[2], y: pose.p[1],
        ground: g.ground, water: g.water,
        clearance: pose.p[1] - Math.max(g.ground, g.water),
      });
    }
    return JSON.stringify(out);
  })()`);
  await browser.close();

  const data = JSON.parse(rows as string) as Sample[];
  let inSpan = false;
  console.log(`[clearance] ${samples} samples, margin ${margin} m — offending spans:`);
  let spanMin: Sample | null = null;
  const report = (s: Sample): void => {
    console.log(
      `  u ${s.u.toFixed(3)} (seg ${s.seg.toFixed(2)})  pos ${s.x.toFixed(0)},${s.z.toFixed(0)}` +
        `  y ${s.y.toFixed(1)}  ground ${s.ground.toFixed(1)}  clearance ${s.clearance.toFixed(1)} m`,
    );
  };
  for (const s of data) {
    if (s.clearance < margin) {
      if (!spanMin || s.clearance < spanMin.clearance) spanMin = s;
      if (!inSpan) {
        inSpan = true;
      }
    } else if (inSpan) {
      if (spanMin) report(spanMin);
      spanMin = null;
      inSpan = false;
    }
  }
  if (inSpan && spanMin) report(spanMin);
  const worst = [...data].sort((a, b) => a.clearance - b.clearance)[0];
  if (worst) {
    console.log(
      `[clearance] global min ${worst.clearance.toFixed(1)} m at u ${worst.u.toFixed(3)} (seg ${worst.seg.toFixed(2)})`,
    );
  }
}

main().catch((e: unknown) => {
  console.error('[clearance] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
