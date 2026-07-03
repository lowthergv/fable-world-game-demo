/**
 * Headless driver for the in-page `bench` console command — runs a sequence
 * of console commands at a bookmark and prints the console output, so the
 * BINDING perf methodology (`bench ab`, in-session ABAB) is scriptable:
 *
 *   npx tsx tools/bench-run.ts --shot 1 --w 2592 --h 1676 \
 *     --cmds "bench 10@p50;bench ab stonedetail 3 2 8@Δp50"
 *
 * Each ;-separated entry is `<console line>@<completion marker>` — the tool
 * types the line into the dev console and waits until the marker appears
 * (again) in the console log. Boots UNFROZEN (bench measures live wall dt).
 */

import { launchWebGPU, laasUrl } from './launch';
import type { Page } from 'playwright';

function arg(k: string, d: string): string {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
}

async function consoleText(page: Page): Promise<string> {
  return page.evaluate(() => document.getElementById('console')?.textContent ?? '');
}

async function main(): Promise<void> {
  const shot = arg('shot', '');
  const width = Number(arg('w', '2592'));
  const height = Number(arg('h', '1676'));
  const cmdsRaw = arg('cmds', '');
  if (!cmdsRaw) throw new Error('--cmds "line@marker;line@marker" required');
  const cmds = cmdsRaw.split(';').map((s) => {
    const at = s.lastIndexOf('@');
    if (at < 0) throw new Error(`missing @marker in "${s}"`);
    return { line: s.slice(0, at).trim(), marker: s.slice(at + 1).trim() };
  });

  // cooled-ABAB protocol: idle the machine BEFORE boot so the absolute
  // baseline row is comparable to session-start numbers (in-session ABAB
  // deltas are drift-proof either way)
  const cooldown = Number(arg('cooldown', '0'));
  if (cooldown > 0) {
    console.log(`[bench-run] cooling ${cooldown}s before boot…`);
    await new Promise((r) => setTimeout(r, cooldown * 1000));
  }

  const { browser } = await launchWebGPU();
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  const extra: Record<string, string> = {};
  if (shot) extra['shot'] = shot;
  await page.goto(laasUrl({ scene: 'world', freeze: false, extra }), {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 240000, polling: 250 },
  );
  const err = await page.evaluate(() => window.__laas.error);
  if (err) throw new Error(err);
  // warm past boot transients (GI convergence, pipeline compiles)
  await page.evaluate(async () => window.__laas.settle && (await window.__laas.settle(320)));

  await page.keyboard.press('`');
  await page.waitForTimeout(200);
  for (const { line, marker } of cmds) {
    const before = (await consoleText(page)).split(marker).length - 1;
    console.log(`[bench-run] > ${line}`);
    await page.keyboard.type(line, { delay: 5 });
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      ([m, n]) =>
        (document.getElementById('console')?.textContent ?? '').split(m as string).length - 1 >
        (n as number),
      [marker, before] as const,
      { timeout: 600000, polling: 500 },
    );
  }
  // dump the console log (skip the banner/dim help lines)
  const lines = await page.evaluate(() => {
    const el = document.getElementById('console');
    return [...(el?.querySelectorAll('div > div') ?? [])].map((n) => n.textContent ?? '');
  });
  console.log('---- console ----');
  for (const l of lines) console.log(l);
  await browser.close();
}

void main();
