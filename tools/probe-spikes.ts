/**
 * Frame-time spike probe: boots the world UNFROZEN (real motion — clouds,
 * particles, probe GI slices all live), records per-frame dt for N seconds
 * via engine.onUpdate, then reports a histogram, the worst frames, and
 * spike cadence (gap between consecutive spikes) to attribute periodic
 * hitches (cloud-shadow re-bake ≈ 2.5 s, cascade stagger, GC…).
 *
 *   npx tsx tools/probe-spikes.ts [--seconds 20] [--w 2592] [--h 1676] [--shot 4]
 */

import { launchWebGPU, laasUrl } from './launch';

interface DbgWindow {
  __laasDbg?: { engine?: { onUpdate(fn: (dt: number) => void): void } };
  __rec?: number[];
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const seconds = Number(str(args['seconds']) ?? 20);
  const width = Number(str(args['w']) ?? 2592);
  const height = Number(str(args['h']) ?? 1676);

  const { browser } = await launchWebGPU();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on('console', (msg) => {
    if (msg.text().startsWith('[laas]')) console.log(`[page] ${msg.text()}`);
  });

  // forward any unconsumed flag as a raw page param (?shadowcache=0 etc.)
  const consumed = new Set(['seconds', 'w', 'h']);
  const extra: Record<string, string> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!consumed.has(k)) extra[k] = v === true ? '1' : String(v);
  }
  const url = laasUrl({ scene: 'world', width, height, freeze: false, extra });
  console.log(`[spikes] ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 180000, polling: 250 },
  );

  // warm up past boot transients (pipeline compiles, probe fast-converge)
  await page.evaluate(async () => window.__laas.settle && (await window.__laas.settle(120)));

  await page.evaluate(() => {
    const w = window as unknown as DbgWindow;
    w.__rec = [];
    w.__laasDbg?.engine?.onUpdate((dt: number) => {
      (w.__rec as number[]).push(dt * 1000);
    });
  });
  console.log(`[spikes] recording ${seconds}s…`);
  await page.waitForTimeout(seconds * 1000);
  const rec = await page.evaluate(() => (window as unknown as DbgWindow).__rec ?? []);
  await browser.close();

  const n = rec.length;
  const sorted = [...rec].sort((a, b) => a - b);
  const pct = (p: number): number => sorted[Math.min(n - 1, Math.floor(n * p))] ?? 0;
  const mean = rec.reduce((a, b) => a + b, 0) / Math.max(n, 1);
  console.log(`[spikes] frames=${n} mean=${mean.toFixed(1)}ms p50=${pct(0.5).toFixed(1)} p90=${pct(0.9).toFixed(1)} p95=${pct(0.95).toFixed(1)} p99=${pct(0.99).toFixed(1)} max=${sorted[n - 1]?.toFixed(1)}`);

  // spike = frame > 1.8× median; report index, ms, and time since previous spike
  const med = pct(0.5);
  const thresh = Math.max(med * 1.8, med + 8);
  let tAccum = 0;
  let lastSpikeT = -1;
  const spikes: { i: number; ms: number; t: number; gap: number }[] = [];
  for (let i = 0; i < n; i++) {
    const ms = rec[i] as number;
    tAccum += ms;
    if (ms > thresh) {
      spikes.push({ i, ms, t: tAccum / 1000, gap: lastSpikeT < 0 ? -1 : (tAccum / 1000 - lastSpikeT) });
      lastSpikeT = tAccum / 1000;
    }
  }
  console.log(`[spikes] threshold=${thresh.toFixed(1)}ms → ${spikes.length} spikes`);
  for (const s of spikes.slice(0, 40)) {
    console.log(`  t=${s.t.toFixed(2)}s  ${s.ms.toFixed(1)}ms  gap=${s.gap < 0 ? '—' : s.gap.toFixed(2) + 's'}`);
  }
}

main().catch((e: unknown) => {
  console.error('[spikes] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
