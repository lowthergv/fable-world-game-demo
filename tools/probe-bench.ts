/**
 * E2E probe for the `bench` and `demo` console commands (M1):
 *  1. `bench 2` prints a percentile row (fps + p50..max + cpu/gpu fields)
 *  2. `bench ab timescale 1 1 1` runs 4 ABAB rounds and prints Δp50
 *  3. `demo record` → flythrough motion → `demo stop` saves N samples
 *  4. `demo play` drives the camera (pose changes without input) and ends
 *     by re-enabling the fly rig; replayed pose lands near the recorded end
 *
 *   npx tsx tools/probe-bench.ts
 */

import { launchWebGPU, laasUrl } from './launch';
import type { Page } from 'playwright';

let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

async function consoleText(page: Page): Promise<string> {
  return page.evaluate(() => document.getElementById('console')?.textContent ?? '');
}

async function type(page: Page, cmd: string): Promise<void> {
  await page.keyboard.type(cmd, { delay: 5 });
  await page.keyboard.press('Enter');
}

async function main(): Promise<void> {
  const { browser } = await launchWebGPU();
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  await page.goto(laasUrl({ scene: 'world', freeze: false }), {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 240000, polling: 250 },
  );
  const err = await page.evaluate(() => window.__laas.error);
  if (err) throw new Error(err);
  await page.evaluate(async () => window.__laas.settle && (await window.__laas.settle(30)));

  await page.keyboard.press('`');

  // 1. bench current view
  await type(page, 'bench 2');
  await page.waitForFunction(
    () => (document.getElementById('console')?.textContent ?? '').includes('view'),
    undefined,
    { timeout: 30000 },
  );
  let text = await consoleText(page);
  check('bench prints percentile row', /view\s+[\d.]+ fps · p50 [\d.]+/.test(text));
  check('bench prints cpu/gpu row', /cpu\.update [\d.]+ · cpu\.submit [\d.]+/.test(text));

  // 2. bench ab (same value both sides — mechanics test, ~16 s)
  await type(page, 'bench ab timescale 1 1 2');
  await page.waitForFunction(
    () => (document.getElementById('console')?.textContent ?? '').includes('Δp50'),
    undefined,
    { timeout: 90000 },
  );
  text = await consoleText(page);
  check('bench ab runs 4 rounds', (text.match(/timescale=1/g) ?? []).length >= 4);
  check('bench ab prints delta', /Δp50 timescale 1→1: [-\d.]+ ms/.test(text));

  // 3. demo record during flythrough motion
  await type(page, 'demo record probetest');
  await page.keyboard.press('Escape');
  await page.keyboard.press('F'); // flythrough on (moves the camera)
  await page.waitForTimeout(2500);
  await page.keyboard.press('F'); // flythrough off
  await page.keyboard.press('`');
  await type(page, 'demo stop');
  text = await consoleText(page);
  const m = /saved "probetest": (\d+) samples, ([\d.]+)s/.exec(text);
  check('demo record saves samples', Number(m?.[1] ?? 0) > 60, `${m?.[1] ?? 0} samples`);
  const endPose = await page.evaluate(() => window.__laas.getPose?.() ?? null);

  // 4. teleport away, then replay — camera must be driven back along the path
  await type(page, 'setpos 0 400 0');
  await type(page, 'demo play probetest');
  await page.waitForFunction(
    () => (document.getElementById('console')?.textContent ?? '').includes('playing "probetest"'),
    undefined,
    { timeout: 10000 },
  );
  await page.waitForTimeout(1200);
  const midPose = await page.evaluate(() => window.__laas.getPose?.() ?? null);
  check(
    'demo play drives the camera',
    midPose !== null && Math.abs((midPose as { p: number[] }).p[1]! - 400) > 1,
  );
  await page.waitForTimeout(2200);
  const donePose = await page.evaluate(() => window.__laas.getPose?.() ?? null);
  const dx = Math.abs(
    ((donePose as { p: number[] } | null)?.p[0] ?? 1e9) -
      ((endPose as { p: number[] } | null)?.p[0] ?? 0),
  );
  check('demo play ends at recorded end pose', dx < 5, `Δx=${dx.toFixed(1)}`);
  text = await consoleText(page);
  check('playback announced', text.includes('playing "probetest"'));

  // cleanup
  await type(page, 'demo delete probetest');

  await browser.close();
  console.log(failures === 0 ? '[probe-bench] ALL PASS' : `[probe-bench] ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e: unknown) => {
  console.error('[probe-bench] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
