/**
 * Identify scattered instances near a world point (K-3 triage): boots,
 * reads the scatter layer's instance buffers back from the GPU, decodes
 * (cls, variant, scale) for everything within --r of --at "x,z".
 *
 *   npx tsx tools/rock-id.ts --at "-870,862" [--r 15] [--layer stones]
 */

import { launchWebGPU, laasUrl } from './launch';

function str(v: string | undefined): string | undefined {
  return v;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const get = (k: string, d?: string): string | undefined => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 ? argv[i + 1] : d;
  };
  const at = (str(get('at')) ?? '').split(',').map(Number);
  const r = Number(get('r', '15'));
  const layer = get('layer', 'stones');
  if (at.length !== 2 || at.some((n) => !Number.isFinite(n))) {
    throw new Error('need --at "x,z"');
  }

  const { browser } = await launchWebGPU();
  const page = await browser.newPage({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 1 });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  const url = laasUrl({ scene: 'world', extra: { wind: '0' } });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 240000, polling: 250 },
  );
  const bootErr = await page.evaluate(() => window.__laas.error);
  if (bootErr) throw new Error(bootErr);

  const script = `(async () => {
  const dbg = window.__laasDbg;
  if (!dbg || !dbg.forests || !dbg.engine) throw new Error('__laasDbg.forests missing');
  const layer = dbg.forests.scatter[${JSON.stringify(layer)}];
  if (!layer) throw new Error('no scatter layer ${layer}');
  const rd = dbg.engine.renderer;
  const abA = await rd.getArrayBufferAsync(layer.bufA.value);
  const abB = await rd.getArrayBufferAsync(layer.bufB.value);
  const A = new Float32Array(abA);
  const B = new Float32Array(abB);
  const out = [];
  for (let i = 0; i < layer.count; i++) {
    const dx = A[i*4] - (${at[0]});
    const dz = A[i*4+2] - (${at[1]});
    if (dx*dx + dz*dz > ${r * r}) continue;
    const idF = B[i*4+3];
    const cls = Math.floor(idF / 8);
    const variant = idF - cls * 8;
    out.push({ i, x: A[i*4], y: A[i*4+1], z: A[i*4+2], scale: A[i*4+3], cls, variant });
  }
  return JSON.stringify(out);
})()`;
  const rows = JSON.parse((await page.evaluate(script)) as string) as {
    i: number; x: number; y: number; z: number; scale: number; cls: number; variant: number;
  }[];
  await browser.close();
  rows.sort((a, b) => b.scale - a.scale);
  console.log(`[rock-id] ${rows.length} ${layer} instances within ${r} m of (${at[0]},${at[1]}):`);
  for (const e of rows.slice(0, 20)) {
    console.log(
      `  cls=${e.cls} v=${e.variant} scale=${e.scale.toFixed(2)} at (${e.x.toFixed(1)}, ${e.y.toFixed(1)}, ${e.z.toFixed(1)})`,
    );
  }
}

main().catch((e: unknown) => {
  console.error('[rock-id] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
