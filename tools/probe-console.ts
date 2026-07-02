/**
 * Developer-console E2E probe: boots the world, opens the console with `,
 * drives real commands through the input, and asserts their effects on
 * engine/sky/camera state. Screenshot at the end with the console open.
 *
 *   npx tsx tools/probe-console.ts
 */

import { launchWebGPU, laasUrl } from './launch';

async function main(): Promise<void> {
  const { browser } = await launchWebGPU();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
  page.on('console', (msg) => {
    if (msg.text().startsWith('[laas]')) console.log(`[page] ${msg.text()}`);
  });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));

  await page.goto(laasUrl({ scene: 'world', width: 1600, height: 1000 }), {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 180000, polling: 250 },
  );
  const fail = (msg: string): never => {
    throw new Error(msg);
  };

  // open
  await page.keyboard.press('`');
  await page.waitForTimeout(250);
  const visible = await page.evaluate(() => {
    const el = document.getElementById('console');
    return el !== null && getComputedStyle(el).visibility === 'visible';
  });
  if (!visible) fail('console did not open on backquote');
  console.log('[console] opens ✓');

  const run = async (cmd: string): Promise<void> => {
    await page.keyboard.type(cmd, { delay: 5 });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(120);
  };

  // timescale
  await run('timescale 0.25');
  const ts = await page.evaluate(
    () => (window as unknown as { __laasDbg: { engine: { timeScale: number } } }).__laasDbg.engine.timeScale,
  );
  if (ts !== 0.25) fail(`timescale: expected 0.25, got ${ts}`);
  console.log('[console] timescale ✓');
  await run('timescale 1');

  // noclip → mode fly (console prints, engine logs mode change)
  await run('noclip');

  // time of day
  await run('time 19');
  await page.waitForTimeout(600); // ToD rebake is async
  const tod = await page.evaluate(
    () => (window as unknown as { __laasDbg: { sunSky: { timeOfDay: number } } }).__laasDbg.sunSky.timeOfDay,
  );
  if (Math.abs(tod - 19) > 0.01) fail(`time: expected 19, got ${tod}`);
  console.log('[console] time ✓');

  // teleport
  await run('setpos 100 400 100 1.0 -0.2');
  const pose = await page.evaluate(() => window.__laas.getPose?.() ?? null);
  if (!pose || Math.abs(pose.p[0] - 100) > 0.01 || Math.abs(pose.p[1] - 400) > 0.01)
    fail(`setpos: pose=${JSON.stringify(pose)}`);
  console.log('[console] setpos ✓');

  // world knobs + info commands — just verify they don't error (output text)
  await run('fog 2');
  await run('wind 0.5');
  await run('speed 60');
  await run('fov 70');
  await run('stat');
  await run('shot 3');
  await page.waitForTimeout(400);
  const pose3 = await page.evaluate(() => window.__laas.getPose?.() ?? null);
  if (!pose3 || Math.abs(pose3.p[0] - 1500) > 1) fail(`shot 3: pose=${JSON.stringify(pose3)}`);
  console.log('[console] shot ✓');

  const text = await page.evaluate(() => document.getElementById('console')?.textContent ?? '');
  for (const needle of ['noclip ON', 'fog = 2', 'wind = 0.5', 'fps', 'Golden vista']) {
    if (!text.includes(needle)) fail(`console output missing "${needle}"\n---\n${text.slice(-1500)}`);
  }
  console.log('[console] command output ✓');

  // history: ArrowUp recalls the last command
  await page.keyboard.press('ArrowUp');
  const recalled = await page.evaluate(
    () => (document.querySelector('#console input') as HTMLInputElement).value,
  );
  if (recalled !== 'shot 3') fail(`history: expected "shot 3", got "${recalled}"`);
  console.log('[console] history ✓');
  await page.keyboard.press('Escape');

  // tab completion: "timesc" + Tab → "timescale "
  await page.keyboard.press('`');
  await page.waitForTimeout(200);
  await page.keyboard.type('timesc', { delay: 5 });
  await page.keyboard.press('Tab');
  const completed = await page.evaluate(
    () => (document.querySelector('#console input') as HTMLInputElement).value,
  );
  if (completed !== 'timescale ') fail(`tab-complete: got "${completed}"`);
  console.log('[console] tab completion ✓');
  for (let i = 0; i < 'timescale '.length; i++) await page.keyboard.press('Backspace');

  // game keys must NOT leak while typing: '3' in the input ≠ bookmark 3
  await page.keyboard.type('echo 3', { delay: 5 });
  const poseBefore = await page.evaluate(() => window.__laas.getPose?.() ?? null);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  const poseAfter = await page.evaluate(() => window.__laas.getPose?.() ?? null);
  if (JSON.stringify(poseBefore) !== JSON.stringify(poseAfter))
    fail('typing digits in the console moved the camera (key leak)');
  console.log('[console] input isolation ✓');

  await page.screenshot({ path: 'shots/wip/console-open.png' });

  // close
  await page.keyboard.press('`');
  await page.waitForTimeout(300);
  const hidden = await page.evaluate(() => {
    const el = document.getElementById('console');
    return el !== null && getComputedStyle(el).visibility === 'hidden';
  });
  if (!hidden) fail('console did not close on backquote');
  console.log('[console] closes ✓');

  await browser.close();
  console.log('[console] ALL CHECKS PASSED — screenshot: shots/wip/console-open.png');
}

main().catch((e: unknown) => {
  console.error('[console] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
