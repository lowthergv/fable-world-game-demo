/**
 * Replay a user-recorded demo headless and measure per-frame flicker.
 *
 *   npx tsx demo-replay-probe.ts <laas-demos.json> [demoName]
 *
 * Injects the exported localStorage entries, `demo play <name>` via the
 * game console, captures quarter-res luma every frame during playback and
 * reports a flicker timeline (mean |Δluma| per frame pair + worst 48px
 * tile) so spikes can be correlated with the moments the user saw.
 * Weather is NOT part of a demo file (documented limitation).
 */
import { readFileSync } from 'node:fs';
import { launchWebGPU, laasUrl } from './launch';

interface DemoFile { seed: number; tod: number; track: [number, ...number[]][] }

async function main(): Promise<void> {
  const jsonPath = process.argv[2];
  if (!jsonPath) throw new Error('usage: demo-replay-probe.ts <laas-demos.json> [demoName]');
  const entries = JSON.parse(readFileSync(jsonPath, 'utf8')) as Record<string, string>;
  const demoKeys = Object.keys(entries).filter((k) => k.startsWith('laas.demo.'));
  if (demoKeys.length === 0) throw new Error('no laas.demo.* keys in the export');
  const wanted = process.argv[3];
  const key = wanted ? `laas.demo.${wanted}` : demoKeys[0]!;
  if (!entries[key]) throw new Error(`demo "${wanted}" not in export (have: ${demoKeys.join(', ')})`);
  const name = key.slice('laas.demo.'.length);
  const file = JSON.parse(entries[key]!) as DemoFile;
  const durS = file.track[file.track.length - 1]?.[0] ?? 0;
  console.log(`demo "${name}": seed ${file.seed}, ToD ${file.tod.toFixed(2)}, ${durS.toFixed(1)}s, ${file.track.length} samples`);

  const { browser } = await launchWebGPU();
  const page = await browser.newPage({ viewport: { width: 1728, height: 1117 }, deviceScaleFactor: 2 });
  page.on('pageerror', (err) => console.error('[pageerror]', err.message));
  // live-like boot: no wind/lockexp/freeze overrides; seed from the file
  await page.goto(laasUrl({ scene: 'world', seed: file.seed }), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined, { timeout: 240000, polling: 250 },
  );
  const err = await page.evaluate(() => window.__laas.error);
  if (err) throw new Error(err);
  await page.evaluate((kv) => {
    for (const [k, v] of Object.entries(kv)) localStorage.setItem(k, v);
  }, entries);
  await page.evaluate(async () => window.__laas.settle && (await window.__laas.settle(60)));

  await page.keyboard.press('`');
  await page.keyboard.type(`demo play ${name}`, { delay: 5 });
  await page.keyboard.press('Enter');
  await page.keyboard.press('`'); // close console; demo drives the camera
  const conText = await page.evaluate(() => document.getElementById('console')?.textContent ?? '');
  if (!conText.includes('playing')) throw new Error(`demo play failed: ...${conText.slice(-300)}`);

  const frames = Math.min(Math.ceil(durS * 62) + 30, 4000);
  const series = (await page.evaluate(`(async () => {
    const canvas = document.querySelector('canvas');
    const w = Math.floor(canvas.width / 4);
    const h = Math.floor(canvas.height / 4);
    const cap = document.createElement('canvas');
    cap.width = w; cap.height = h;
    const ctx = cap.getContext('2d', { willReadFrequently: true });
    const settle = window.__laas.settle;
    const T = 12; // 48px tiles at quarter res
    const tw = Math.floor(w / T), th = Math.floor(h / T);
    let prev = null;
    const rows = [];
    for (let i = 0; i < ${frames}; i++) {
      await settle(1);
      ctx.drawImage(canvas, 0, 0, w, h);
      const d = ctx.getImageData(0, 0, w, h).data;
      const luma = new Float32Array(w * h);
      for (let p = 0; p < w * h; p++) {
        luma[p] = 0.2126 * d[p * 4] + 0.7152 * d[p * 4 + 1] + 0.0722 * d[p * 4 + 2];
      }
      if (prev) {
        let sum = 0;
        const tiles = new Float32Array(tw * th);
        for (let y = 0; y < th * T; y++) {
          for (let x = 0; x < tw * T; x++) {
            const dd = Math.abs(luma[y * w + x] - prev[y * w + x]);
            sum += dd;
            tiles[Math.floor(y / T) * tw + Math.floor(x / T)] += dd;
          }
        }
        let worst = 0, wi = 0;
        for (let t = 0; t < tiles.length; t++) if (tiles[t] > worst) { worst = tiles[t]; wi = t; }
        rows.push([i, sum / (tw * T * th * T), worst / (T * T), wi % tw, Math.floor(wi / tw)]);
      }
      prev = luma;
    }
    return rows;
  })()`)) as [number, number, number, number, number][];

  // timeline: 1s buckets
  console.log('sec  mean|Δ|  p95frame  worstTileMean (x4 for full-res px)');
  const fps = series.length / Math.max(durS, 1);
  for (let s = 0; s * fps < series.length; s++) {
    const slice = series.slice(Math.floor(s * fps), Math.floor((s + 1) * fps));
    if (slice.length === 0) break;
    const means = slice.map((r) => r[1]).sort((a, b) => a - b);
    const worst = Math.max(...slice.map((r) => r[2]));
    console.log(
      `${String(s).padStart(3)}  ${(means[means.length >> 1] ?? 0).toFixed(2)}     ` +
      `${(means[Math.floor(means.length * 0.95)] ?? 0).toFixed(2)}      ${worst.toFixed(1)}`,
    );
  }
  const top = [...series].sort((a, b) => b[2] - a[2]).slice(0, 8);
  console.log('top spike frames (frame, meanΔ, worstTileΔ, tileX, tileY):');
  for (const r of top) console.log(`  f${r[0]} mean=${r[1].toFixed(2)} tile=${r[2].toFixed(1)} @(${r[3]},${r[4]})`);
  await browser.close();
}

main().catch((e: unknown) => { console.error(e); process.exit(1); });
