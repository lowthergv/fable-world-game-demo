/** capture two nearby tour poses and save crops around a tile (pop triage) */
import { mkdirSync } from 'node:fs';
import sharp from 'sharp';
import { launchWebGPU, laasUrl } from './launch';

async function main(): Promise<void> {
  const [uA, uB, cx, cy, tag] = process.argv.slice(2);
  const u1 = Number(uA), u2 = Number(uB), x = Number(cx), y = Number(cy);
  const { browser } = await launchWebGPU();
  const page = await browser.newPage({ viewport: { width: 2592, height: 1676 }, deviceScaleFactor: 1 });
  const url = laasUrl({ scene: 'world', T: 19, extra: { wind: '0', lockexp: '1', ablate: 'water' } });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined, { timeout: 240000, polling: 250 },
  );
  mkdirSync('shots/wip/pops', { recursive: true });
  const shoot = async (u: number, name: string): Promise<string> => {
    await page.evaluate(async (uu) => {
      const dbg = (window as unknown as { __laasDbg?: { flyPose?: (u: number) => never } }).__laasDbg;
      const hk = window.__laas;
      if (!dbg?.flyPose || !hk.setPose || !hk.settle) throw new Error('hooks missing');
      hk.setPose(dbg.flyPose(uu));
      await hk.settle(90);
    }, u);
    const p = `shots/wip/pops/${tag}-${name}.png`;
    await page.screenshot({ path: p });
    return p;
  };
  const a = await shoot(u1, 'A');
  const b = await shoot(u2, 'B');
  await browser.close();
  const crop = { left: Math.max(0, x - 160), top: Math.max(0, y - 120), width: 320, height: 240 };
  const [ca, cb] = await Promise.all([
    sharp(a).extract(crop).resize(640, 480, { kernel: 'nearest' }).toBuffer(),
    sharp(b).extract(crop).resize(640, 480, { kernel: 'nearest' }).toBuffer(),
  ]);
  await sharp({ create: { width: 1296, height: 480, channels: 3, background: { r: 10, g: 10, b: 10 } } })
    .composite([{ input: ca, left: 0, top: 0 }, { input: cb, left: 656, top: 0 }])
    .png().toFile(`shots/wip/pops/${tag}-crops.png`);
  console.log(`[pop-crop] wrote shots/wip/pops/${tag}-crops.png`);
}
main().catch((e: unknown) => { console.error(e); process.exit(1); });
