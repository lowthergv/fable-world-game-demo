/**
 * Single-boot dolly pair capture (K-4 triage). Two-boot ?cam shots confound
 * the grass-torus init center (torus recenters around the BOOT camera —
 * chunky whole-field diffs that aren't the pop); this boots ONCE, poses the
 * dolly at frame A, settles, screenshots, poses at frame B, settles,
 * screenshots. The diff is then the pop alone.
 *
 *   npx tsx tools/pop-pair.ts --cam "-11,283,1330,1.27,-0.06" --speed 0.06 \
 *     --fa 918 --fb 924 --tag dolly-sb-f920 [--T 12] [--<k>=v → page]
 *
 * Outputs shots/wip/pops/<tag>-{A,B}.png, <tag>-diff.png (amplified |Δ|
 * heatmap), <tag>-crops.png (A|B around the max-diff cluster, nearest ×2),
 * and prints the top-diff 32-px tiles (full-res coords, same tiling as
 * probe-pops).
 */

import { mkdirSync } from 'node:fs';
import sharp from 'sharp';
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
  if (cam.length < 5 || cam.some((n) => !Number.isFinite(n))) {
    throw new Error('need --cam "x,y,z,yaw,pitch"');
  }
  if (!Number.isFinite(fa) || !Number.isFinite(fb)) throw new Error('need --fa/--fb frames');
  const tag = str(args['tag']) ?? `pair-f${fa}-${fb}`;
  const width = Number(str(args['w']) ?? 2592);
  const height = Number(str(args['h']) ?? 1676);
  const settle = Number(str(args['settle']) ?? 120);

  const consumed = new Set(['cam', 'speed', 'fa', 'fb', 'tag', 'w', 'h', 'T', 'settle']);
  const extra: Record<string, string> = { wind: '0', lockexp: '1' };
  for (const [k, v] of Object.entries(args)) {
    if (!consumed.has(k)) extra[k] = v === true ? '1' : String(v);
  }

  const dir = 'shots/wip/pops';
  mkdirSync(dir, { recursive: true });
  const { browser } = await launchWebGPU();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  const url = laasUrl({
    scene: 'world', width, height, T: Number(str(args['T']) ?? 12), extra,
  });
  console.log(`[pop-pair] ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 240000, polling: 250 },
  );
  const bootErr = await page.evaluate(() => window.__laas.error);
  if (bootErr) throw new Error(bootErr);

  const yaw = cam[3]!;
  const pitch = cam[4]!;
  const fwd = [
    -Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch),
  ];
  const poseAt = (f: number): { p: [number, number, number]; yaw: number; pitch: number } => ({
    p: [cam[0]! + fwd[0]! * f * speed, cam[1]! + fwd[1]! * f * speed, cam[2]! + fwd[2]! * f * speed],
    yaw,
    pitch,
  });

  const shoot = async (f: number, name: string): Promise<string> => {
    await page.evaluate(
      async ({ pose, n }) => {
        const hk = window.__laas;
        if (!hk.setPose || !hk.settle) throw new Error('hooks missing');
        hk.setPose(pose as { p: [number, number, number]; yaw: number; pitch: number });
        await hk.settle(n);
      },
      { pose: poseAt(f), n: settle },
    );
    const p = `${dir}/${tag}-${name}.png`;
    await page.screenshot({ path: p });
    return p;
  };
  console.log(`[pop-pair] single boot: f=${fa} then f=${fb} (Δ ${((fb - fa) * speed).toFixed(2)} m), settle ${settle}`);
  const pa = await shoot(fa, 'A');
  const pb = await shoot(fb, 'B');
  await browser.close();

  // diff + tile ranking (32-px tiles, matches probe-pops full-res coords)
  const [ra, rb] = await Promise.all([
    sharp(pa).raw().toBuffer({ resolveWithObject: true }),
    sharp(pb).raw().toBuffer({ resolveWithObject: true }),
  ]);
  const ch = ra.info.channels;
  const W = ra.info.width;
  const H = ra.info.height;
  const T = 32;
  const tw = Math.floor(W / T);
  const th = Math.floor(H / T);
  const tiles: { tx: number; ty: number; mean: number; max: number }[] = [];
  const diffPx = Buffer.alloc(W * H * 3);
  for (let ty = 0; ty < th; ty++) {
    for (let tx = 0; tx < tw; tx++) {
      let s = 0;
      let mx = 0;
      for (let y = 0; y < T; y++) {
        for (let x = 0; x < T; x++) {
          const i = ((ty * T + y) * W + tx * T + x) * ch;
          const la = 0.2126 * ra.data[i]! + 0.7152 * ra.data[i + 1]! + 0.0722 * ra.data[i + 2]!;
          const lb = 0.2126 * rb.data[i]! + 0.7152 * rb.data[i + 1]! + 0.0722 * rb.data[i + 2]!;
          const d = Math.abs(la - lb);
          s += d;
          if (d > mx) mx = d;
          const o = ((ty * T + y) * W + tx * T + x) * 3;
          const v = Math.min(255, d * 4);
          diffPx[o] = v;
          diffPx[o + 1] = v > 128 ? 255 - v : v;
          diffPx[o + 2] = 0;
        }
      }
      tiles.push({ tx, ty, mean: s / (T * T), max: mx });
    }
  }
  tiles.sort((a, b) => b.mean - a.mean);
  await sharp(diffPx, { raw: { width: W, height: H, channels: 3 } })
    .png()
    .toFile(`${dir}/${tag}-diff.png`);
  console.log('[pop-pair] top tiles (meanΔ/maxΔ per 32px tile, full-res px):');
  for (const t of tiles.slice(0, 12)) {
    console.log(
      `  (${t.tx * T + T / 2},${t.ty * T + T / 2})  mean=${t.mean.toFixed(1)}  max=${t.max.toFixed(0)}`,
    );
  }
  // A|B crop pair around the top tile cluster
  const top = tiles[0]!;
  const cx = top.tx * T + T / 2;
  const cy = top.ty * T + T / 2;
  const crop = {
    left: Math.min(Math.max(0, cx - 240), W - 480),
    top: Math.min(Math.max(0, cy - 180), H - 360),
    width: 480,
    height: 360,
  };
  const [ca, cb] = await Promise.all([
    sharp(pa).extract(crop).resize(960, 720, { kernel: 'nearest' }).toBuffer(),
    sharp(pb).extract(crop).resize(960, 720, { kernel: 'nearest' }).toBuffer(),
  ]);
  await sharp({
    create: { width: 1936, height: 720, channels: 3, background: { r: 10, g: 10, b: 10 } },
  })
    .composite([{ input: ca, left: 0, top: 0 }, { input: cb, left: 976, top: 0 }])
    .png()
    .toFile(`${dir}/${tag}-crops.png`);
  console.log(`[pop-pair] wrote ${tag}-{A,B,diff,crops}.png in ${dir}`);
}

main().catch((e: unknown) => {
  console.error('[pop-pair] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
