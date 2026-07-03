/**
 * Same-boot A→B→A verification for the perf-attribution cvars
 * (`stonedetail`, `castercap`) — the cross-boot shot floor at bm1/bm4 is
 * dominated by caustic phase + exposure convergence, so knob effects are
 * only provable with same-boot frame-aligned captures (pop-triage law).
 *
 * For each knob: boot the bookmark frozen, capture A, toggle to B via the
 * console, capture B, toggle back, capture A2. PASS = A↔A2 at the same-boot
 * floor (≈0) AND A↔B differs (the knob does something). castercap
 * additionally asserts the impostor-band caps read back clamped and that
 * overflow (raw > cap) exists at B — the pre-fix drop reproduced.
 *
 *   npx tsx tools/knob-check.ts
 */

import { mkdirSync } from 'node:fs';
import sharp from 'sharp';
import type { Page } from 'playwright';
import { launchWebGPU, laasUrl } from './launch';

const OUT = 'shots/wip/knobs';
let failures = 0;

function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

interface DiffStats {
  pct: number;
  mean: number;
  /** worst 32-px tile: fraction of its pixels >12 (localization evidence —
   *  a knob that changes distant stones/shadows spikes a few tiles hard
   *  while the frame-wide percentage stays at the rest floor) */
  tileMax: number;
  tileAt: string;
}

async function diffPct(aPath: string, bPath: string): Promise<DiffStats> {
  const a = await sharp(aPath).raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(bPath).raw().toBuffer({ resolveWithObject: true });
  const ch = a.info.channels;
  const W = a.info.width;
  const H = a.info.height;
  const n = W * H;
  const tw = Math.ceil(W / 32);
  const th = Math.ceil(H / 32);
  const tiles = new Uint32Array(tw * th);
  let changed = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let c = 0; c < Math.min(ch, 3); c++) {
      m = Math.max(m, Math.abs((a.data[i * ch + c] ?? 0) - (b.data[i * ch + c] ?? 0)));
    }
    if (m > 12) {
      changed++;
      const x = i % W;
      const y = (i / W) | 0;
      tiles[((y / 32) | 0) * tw + ((x / 32) | 0)]++;
    }
    sum += m;
  }
  let tileMax = 0;
  let tileAt = '';
  for (let t = 0; t < tiles.length; t++) {
    const f = (tiles[t] ?? 0) / 1024;
    if (f > tileMax) {
      tileMax = f;
      tileAt = `${(t % tw) * 32},${((t / tw) | 0) * 32}`;
    }
  }
  return { pct: (changed / n) * 100, mean: sum / n, tileMax, tileAt };
}

async function boot(shot: number, extra: Record<string, string> = {}): Promise<Page> {
  const { browser } = await launchWebGPU();
  const page = await browser.newPage({ viewport: { width: 1728, height: 1117 } });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  await page.goto(
    laasUrl({ scene: 'world', extra: { shot: String(shot), ...extra } }),
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () => window.__laas && (window.__laas.ready || window.__laas.error !== null),
    undefined,
    { timeout: 240000, polling: 250 },
  );
  const err = await page.evaluate(() => window.__laas.error);
  if (err) throw new Error(err);
  // GI slice-refresh pre-roll (probe-pops lesson: convergence tail reads as
  // change for ~240 frames) — captures compare against a stationary world
  await page.evaluate(async () => window.__laas.settle && (await window.__laas.settle(320)));
  return page;
}

/** settle to a fixed frame-index residue — pins TRAA jitter phase, cascade
 *  stagger phase and every frame-indexed hash (the framealign law; same
 *  contract as shoot.ts --framealign) */
async function frameAlign(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const s = window.__laas;
    if (!s.settle || !s.stats) return;
    for (let i = 0; i < 1100; i++) {
      if (s.stats.frame % 1024 === 512) break;
      await s.settle(1);
    }
  });
}

async function cmd(page: Page, line: string): Promise<void> {
  await page.keyboard.press('`');
  await page.waitForTimeout(150);
  await page.keyboard.type(line, { delay: 5 });
  await page.keyboard.press('Enter');
  await page.keyboard.press('`');
  // settle past the toggle (frozen world — a few frames re-converge TRAA)
  await page.evaluate(async () => window.__laas.settle && (await window.__laas.settle(45)));
}

async function shotTo(page: Page, path: string): Promise<void> {
  await frameAlign(page);
  await page.screenshot({ path });
}

/** veg.tris HUD counter (readStats runs every 90 frames — settle past one
 *  cadence first so the readback reflects the current knob state) */
async function vegTris(page: Page): Promise<number> {
  await page.evaluate(async () => window.__laas.settle && (await window.__laas.settle(190)));
  return page.evaluate(() => window.__laas.stats?.counters?.['veg.tris'] ?? -1);
}

async function impBandState(page: Page): Promise<{ cap: number; over: number; groups: number }> {
  return page.evaluate(async () => {
    const dbg = (
      window as unknown as {
        __laasDbg?: {
          engine?: { renderer: unknown };
          forests?: {
            debugCounters(r: unknown): Promise<{ counts: number[]; caps: number[] }>;
          };
        };
      }
    ).__laasDbg;
    if (!dbg?.forests || !dbg.engine) throw new Error('__laasDbg.forests missing');
    const snap: { counts: number[]; caps: number[] } = await dbg.forests.debugCounters(
      dbg.engine.renderer,
    );
    // impostor-band caster groups: locals 136..141 of each cascade block
    const MAIN = 170;
    const LOCALS = 142;
    let cap = 0;
    let over = 0;
    let groups = 0;
    for (let g = MAIN; g < snap.caps.length; g++) {
      if ((g - MAIN) % LOCALS < 136) continue;
      groups++;
      cap = Math.max(cap, snap.caps[g] ?? 0);
      if ((snap.counts[g] ?? 0) > (snap.caps[g] ?? 0)) over++;
    }
    return { cap, over, groups };
  });
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });

  // ---- stonedetail @ bm4 (foreground StoneL) --------------------------------
  // rest recipe from probe-temporal: wind sways on wall-clock even under
  // ?freeze (hence wind=0), auto-exposure drifts (lockexp), caustic phase is
  // wall-clock (ablate) — without these, same-boot captures differ 10-16%
  {
    const page = await boot(4, { wind: '0', lockexp: '1', ablate: 'caustics' });
    const trisA = await vegTris(page);
    await shotTo(page, `${OUT}/sd-A.png`);
    await cmd(page, 'stonedetail 2');
    const trisB = await vegTris(page);
    await shotTo(page, `${OUT}/sd-B.png`);
    await cmd(page, 'stonedetail 3');
    const trisA2 = await vegTris(page);
    await shotTo(page, `${OUT}/sd-A2.png`);
    const aa = await diffPct(`${OUT}/sd-A.png`, `${OUT}/sd-A2.png`);
    const ab = await diffPct(`${OUT}/sd-A.png`, `${OUT}/sd-B.png`);
    check(
      'stonedetail A↔A2 returns to baseline',
      aa.pct < 0.5 && Math.abs(trisA2 - trisA) / Math.max(trisA, 1) < 0.002,
      `${aa.pct.toFixed(3)}% >12; veg.tris ${trisA} → ${trisA2}`,
    );
    check(
      'stonedetail 2 sheds StoneL R2 tris',
      trisB < trisA && trisA - trisB > 50_000,
      `veg.tris ${trisA} → ${trisB} (Δ ${trisA - trisB})`,
    );
    // pixel delta is informational only: d2 3→2 beyond 120 m is visually
    // subtle by design (the knob prices vertex cost, not look), and the
    // floor's own worst tile is the fps HUD chip at 0,0
    console.log(
      `[stonedetail] A↔B ${ab.pct.toFixed(3)}% >12, worst tile ` +
        `${(ab.tileMax * 100).toFixed(1)}% @ ${ab.tileAt} ` +
        `(floor tile ${(aa.tileMax * 100).toFixed(1)}% @ ${aa.tileAt})`,
    );
    await page.context().browser()?.close();
  }

  // ---- castercap @ bm1 (gorge, far crown shadows) ---------------------------
  {
    const page = await boot(1, {
      wind: '0',
      lockexp: '1',
      ablate: 'water,particles,caustics',
    });
    const s0 = await impBandState(page);
    check('castercap boot cap = 24576', s0.cap === 24576, `cap ${s0.cap}, ${s0.groups} groups`);
    await shotTo(page, `${OUT}/cc-A.png`);
    await cmd(page, 'castercap 8192');
    const s1 = await impBandState(page);
    check('castercap live cap readback = 8192', s1.cap === 8192, `cap ${s1.cap}`);
    console.log(`[castercap] overflowing imp-band groups at 8192: ${s1.over}`);
    await shotTo(page, `${OUT}/cc-B.png`);
    await cmd(page, 'castercap 24576');
    await shotTo(page, `${OUT}/cc-A2.png`);
    const aa = await diffPct(`${OUT}/cc-A.png`, `${OUT}/cc-A2.png`);
    const ab = await diffPct(`${OUT}/cc-A.png`, `${OUT}/cc-B.png`);
    check(
      'castercap A↔A2 returns to baseline',
      aa.pct < 0.5,
      `${aa.pct.toFixed(3)}% >12 (mean ${aa.mean.toFixed(2)})`,
    );
    check(
      'castercap 8192 reproduces the pre-fix overflow drop',
      s1.over > 0,
      `${s1.over} imp-band groups over cap`,
    );
    // pixel delta is framing-dependent (the 620–1100 m band is largely
    // wall-occluded inside the gorge) — informational, not a gate
    console.log(
      `[castercap] A↔B ${ab.pct.toFixed(3)}% >12, worst tile ` +
        `${(ab.tileMax * 100).toFixed(1)}% @ ${ab.tileAt} ` +
        `(floor tile ${(aa.tileMax * 100).toFixed(1)}%)`,
    );
    await page.context().browser()?.close();
  }

  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
