/**
 * RT-0 Mrays/s benchmark (v3 §7 gate: "measured budget table in STATUS.md").
 *
 * Boots composed bookmarks frozen at native res, drives __laasDbg.rt.bench
 * per mode, prints a markdown table + writes JSON next to the shots.
 *
 *   npx tsx tools/probe-rt.ts [--base http://localhost:5173/]
 *     [--w 2592 --h 1676] [--runs 12] [--json shots/wip/rt/bench.json]
 *
 * Ray-set plan (mode × bookmark):
 *   bm1 gorge stream    — primary (coherent, mixed near geometry)
 *   bm3 golden vista    — primary, shadow, reflect, ao, incoh (full sweep)
 *   bm7 forest interior — primary, shadow, ao (deep canopy occupancy)
 *   bm2 lake grazing    — primary, reflect (the RT-1 water predictor)
 * Secondary modes trace only primary-hit lanes at half res (their `rays`
 * column is the honest traced count, not the grid size).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { launchWebGPU, laasUrl } from './launch';

interface Row {
  shot: number;
  mode: string;
  w: number;
  h: number;
  rays: number;
  msMed: number;
  msMin: number;
  mrays: number;
}

const PLAN: Array<{ shot: number; label: string; modes: string[] }> = [
  { shot: 1, label: 'gorge stream', modes: ['primary'] },
  { shot: 3, label: 'golden vista', modes: ['primary', 'shadow', 'reflect', 'ao', 'incoh'] },
  { shot: 7, label: 'forest interior', modes: ['primary', 'shadow', 'ao'] },
  { shot: 2, label: 'lake grazing', modes: ['primary', 'reflect'] },
];

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : dflt;
}

async function main(): Promise<void> {
  const base = arg('base', 'http://localhost:5173/');
  const W = Number(arg('w', '2592'));
  const H = Number(arg('h', '1676'));
  const runs = Number(arg('runs', '12'));
  const jsonOut = arg('json', 'shots/wip/rt/bench.json');

  const { browser } = await launchWebGPU();
  const rows: Row[] = [];
  const labels = new Map(PLAN.map((p) => [p.shot, p.label]));

  for (const spec of PLAN) {
    const page = await browser.newPage({ viewport: { width: W, height: H } });
    page.on('pageerror', (err) => console.error('[pageerror]', err.message));
    const url = laasUrl(
      { scene: 'world', freeze: true, extra: { shot: String(spec.shot) } },
      base,
    );
    console.log(`\n== bm${spec.shot} (${spec.label}) — ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
      undefined,
      { timeout: 240000, polling: 250 },
    );
    const err = await page.evaluate(() => window.__laas.error);
    if (err) throw new Error(`bm${spec.shot}: ${err}`);
    await page.evaluate(async () => window.__laas.settle && (await window.__laas.settle(20)));

    for (const mode of spec.modes) {
      const row = await page.evaluate(
        async ([m, r]) => {
          const dbg = (
            window as unknown as {
              __laasDbg?: {
                rt?: { bench: (mode: string, o: { runs: number }) => Promise<object> };
              };
            }
          ).__laasDbg;
          if (!dbg?.rt) throw new Error('__laasDbg.rt missing (veg ablated? old build?)');
          return dbg.rt.bench(m as string, { runs: r as number });
        },
        [mode, runs] as const,
      );
      const rec = { shot: spec.shot, ...(row as Omit<Row, 'shot'>) };
      rows.push(rec);
      console.log(
        `  ${mode.padEnd(7)} ${rec.w}x${rec.h}  rays=${rec.rays.toLocaleString()}  ` +
          `med=${rec.msMed.toFixed(2)}ms  min=${rec.msMin.toFixed(2)}ms  ` +
          `→ ${rec.mrays.toFixed(0)} Mrays/s`,
      );
    }
    await page.close();
  }
  await browser.close();

  // markdown table for STATUS
  console.log('\n| bm | mode | res | Mrays traced | ms (med) | Mrays/s |');
  console.log('|----|------|-----|-------------|----------|---------|');
  for (const r of rows) {
    console.log(
      `| ${r.shot} ${labels.get(r.shot) ?? ''} | ${r.mode} | ${r.w}×${r.h} | ` +
        `${(r.rays / 1e6).toFixed(2)} | ${r.msMed.toFixed(2)} | ${r.mrays.toFixed(0)} |`,
    );
  }
  mkdirSync(dirname(jsonOut), { recursive: true });
  writeFileSync(jsonOut, JSON.stringify({ date: new Date().toISOString(), W, H, runs, rows }, null, 2));
  console.log(`\nwrote ${jsonOut}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
