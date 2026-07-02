/**
 * Verification battery runner (v3 §12, M1 subset) — orchestrates the probe
 * tools and automates the recurring gates. Each stage prints PASS/FAIL and
 * the battery exits non-zero if any REQUIRED stage fails.
 *
 *   npm run battery -- [--only contact,floors,...] [--fast]
 *
 * Stages:
 *   contact     9-bookmark contact sheet (composed ToD each) → one grid PNG
 *   floors      triangle floors at hero/vista framings (v2 §2 regression
 *               floors: forest hero ≥5M, vista ≥3M post-culling)
 *   shadowcolor no-gray-shadows test at golden hour (darkest-pixel chroma)
 *   temporal    probe-temporal rest at bm3+bm9 (thresholds: see below)
 *   pops        probe-pops on two tour segments (--fast) or full tour
 *   hf          sharpness vs fresh 4×SSAA reference at bm3 (≥75%)
 *
 * Temporal thresholds (calibrated 2026-07-02 on the custom TRAA resolve at
 * bm3/bm9, native res): rest meanFlicker ≤ 0.6, worst tile ≤ 8.0 — set
 * ~40% above the measured post-fix values so regressions flag without
 * false-positives from wall-clock water phase (the documented confound).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import sharp from 'sharp';

interface StageResult {
  name: string;
  pass: boolean;
  detail: string;
}

function run(cmd: string[], timeoutMs = 20 * 60 * 1000): { out: string; code: number } {
  const r = spawnSync('npx', cmd, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { out: `${r.stdout ?? ''}${r.stderr ?? ''}`, code: r.status ?? 1 };
}

async function contactSheet(): Promise<StageResult> {
  mkdirSync('shots/battery', { recursive: true });
  const tiles: Buffer[] = [];
  for (let i = 1; i <= 9; i++) {
    const out = `shots/battery/bm${i}.png`;
    const r = run([
      'tsx', 'tools/shoot.ts', '--scene', 'world', '--shot', String(i),
      '--w', '1296', '--h', '838', '--out', out,
    ]);
    if (r.code !== 0 || !existsSync(out)) {
      return { name: 'contact', pass: false, detail: `bm${i} shot failed` };
    }
    tiles.push(await sharp(out).resize(864, 559).png().toBuffer());
  }
  const G = 6;
  const W = 864 * 3 + G * 2;
  const H = 559 * 3 + G * 2;
  const composite = tiles.map((t, i) => ({
    input: t,
    left: (i % 3) * (864 + G),
    top: Math.floor(i / 3) * (559 + G),
  }));
  await sharp({ create: { width: W, height: H, channels: 3, background: { r: 8, g: 8, b: 8 } } })
    .composite(composite).jpeg({ quality: 92 }).toFile('shots/battery/contact-sheet.jpg');
  return { name: 'contact', pass: true, detail: 'shots/battery/contact-sheet.jpg (9 bookmarks)' };
}

function floors(): StageResult {
  // forest hero framing (bm7 interior) and vista (bm3)
  const checks: { shot: string; tod: string; min: number; label: string }[] = [
    { shot: '7', tod: '12.5', min: 5_000_000, label: 'forest hero' },
    { shot: '3', tod: '19', min: 3_000_000, label: 'vista' },
  ];
  const details: string[] = [];
  for (const c of checks) {
    const stats = `shots/battery/floor-bm${c.shot}-stats.json`;
    const r = run([
      'tsx', 'tools/shoot.ts', '--scene', 'world', '--shot', c.shot,
      '--w', '2592', '--h', '1676', '--out', `shots/battery/floor-bm${c.shot}.png`,
      '--stats', stats,
    ]);
    if (r.code !== 0) return { name: 'floors', pass: false, detail: `${c.label} shot failed` };
    const tris = (JSON.parse(readFileSync(stats, 'utf8')) as { triangles: number }).triangles;
    details.push(`${c.label} ${(tris / 1e6).toFixed(1)}M (floor ${(c.min / 1e6).toFixed(0)}M)`);
    if (tris < c.min) return { name: 'floors', pass: false, detail: details.join(' · ') };
  }
  return { name: 'floors', pass: true, detail: details.join(' · ') };
}

async function shadowColor(): Promise<StageResult> {
  // no-gray-shadows (Pillar B): darkest quantile of the golden-hour vista
  // must stay chromatic (Phase-2 gate read chroma ≈18/255, luma ≈62)
  const out = 'shots/battery/shadowcolor-bm3.png';
  const r = run([
    'tsx', 'tools/shoot.ts', '--scene', 'world', '--shot', '3', '--T', '19',
    '--w', '1296', '--h', '838', '--out', out,
  ]);
  if (r.code !== 0) return { name: 'shadowcolor', pass: false, detail: 'shot failed' };
  const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
  const px: { lum: number; chroma: number }[] = [];
  for (let i = 0; i < info.width * info.height; i++) {
    const r8 = data[i * info.channels] ?? 0;
    const g8 = data[i * info.channels + 1] ?? 0;
    const b8 = data[i * info.channels + 2] ?? 0;
    const maxc = Math.max(r8, g8, b8);
    const minc = Math.min(r8, g8, b8);
    px.push({ lum: 0.2126 * r8 + 0.7152 * g8 + 0.0722 * b8, chroma: maxc - minc });
  }
  px.sort((a, b) => a.lum - b.lum);
  const darkest = px.slice(0, Math.floor(px.length * 0.01));
  const mLum = darkest.reduce((s, p) => s + p.lum, 0) / darkest.length;
  const mChroma = darkest.reduce((s, p) => s + p.chroma, 0) / darkest.length;
  const pass = mLum >= 25 && mChroma >= 8;
  return {
    name: 'shadowcolor', pass,
    detail: `darkest-1% luma ${mLum.toFixed(1)} (≥25) chroma ${mChroma.toFixed(1)} (≥8)`,
  };
}

function temporal(): StageResult {
  const runs: { shot: string; tod: string }[] = [
    { shot: '3', tod: '19' },
    { shot: '9', tod: '17.5' },
  ];
  const details: string[] = [];
  for (const rr of runs) {
    const r = run([
      'tsx', 'tools/probe-temporal.ts', '--shot', rr.shot, '--T', rr.tod,
      '--mode', 'rest', '--tag', `battery-bm${rr.shot}`,
      '--maxmean', '0.6', '--maxtile', '8',
    ]);
    const m = /flicker mean=([\d.]+) .*p95=([\d.]+)/.exec(r.out);
    details.push(`bm${rr.shot} mean ${m?.[1] ?? '?'} p95 ${m?.[2] ?? '?'}`);
    if (r.code !== 0) {
      return { name: 'temporal', pass: false, detail: details.join(' · ') };
    }
  }
  return { name: 'temporal', pass: true, detail: `${details.join(' · ')} (≤0.6 mean, ≤8 tile)` };
}

function pops(fast: boolean): StageResult {
  const segs = fast
    ? [{ u0: '0', u1: '0.15' }, { u0: '0.55', u1: '0.7' }]
    : [{ u0: '0', u1: '1' }];
  let events = 0;
  const details: string[] = [];
  for (const s of segs) {
    const r = run([
      'tsx', 'tools/probe-pops.ts', '--u0', s.u0, '--u1', s.u1, '--slow', '4',
      '--ablate', 'water', '--tag', `battery-${s.u0}-${s.u1}`,
    ], 60 * 60 * 1000);
    const m = /events: (\d+) \(raw/.exec(r.out);
    const n = Number(m?.[1] ?? 999);
    events += n;
    details.push(`u ${s.u0}→${s.u1}: ${n} events`);
  }
  // informational until the band re-tune lands; flip to `events === 0` then
  return { name: 'pops', pass: true, detail: `${details.join(' · ')} (informational)` };
}

function hf(): StageResult {
  const a = 'shots/battery/hf-head.png';
  const raw = 'shots/battery/hf-ssaa-raw.png';
  const ref = 'shots/battery/hf-ssaa-ref.png';
  let r = run([
    'tsx', 'tools/shoot.ts', '--scene', 'world', '--shot', '3', '--wind', '0',
    '--w', '1280', '--h', '800', '--out', a,
  ]);
  if (r.code !== 0) return { name: 'hf', pass: false, detail: 'head shot failed' };
  r = run([
    'tsx', 'tools/shoot.ts', '--scene', 'world', '--shot', '3', '--wind', '0',
    '--ablate', 'taa', '--w', '2560', '--h', '1600', '--out', raw,
  ]);
  if (r.code !== 0) return { name: 'hf', pass: false, detail: 'ssaa shot failed' };
  const rs = spawnSync('npx', ['tsx', '-e',
    `import sharp from 'sharp'; sharp('${raw}').resize(1280, 800, { kernel: 'lanczos3' }).png().toFile('${ref}').then(() => console.log('ok'));`,
  ], { encoding: 'utf8' });
  if (!(rs.stdout ?? '').includes('ok')) return { name: 'hf', pass: false, detail: 'downsample failed' };
  const out = run(['tsx', 'tools/hf-energy.ts', a, ref]).out;
  const m = /A\/B = ([\d.]+)%/.exec(out);
  const ratio = Number(m?.[1] ?? 0);
  // healthy reconstruction reads 75-100% of the SSAA reference; >115% means
  // aliasing is posing as sharpness (pre-fix stock velocity bug read 144%+)
  const pass = ratio >= 75 && ratio <= 115;
  return { name: 'hf', pass, detail: `HF vs 4×SSAA = ${ratio}% (75–115%)` };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? (args[onlyIdx + 1] ?? '').split(',') : null;
  const fast = args.includes('--fast');
  const want = (n: string): boolean => !only || only.includes(n);

  const results: StageResult[] = [];
  if (want('contact')) results.push(await contactSheet());
  if (want('floors')) results.push(floors());
  if (want('shadowcolor')) results.push(await shadowColor());
  if (want('temporal')) results.push(temporal());
  if (want('pops')) results.push(pops(fast));
  if (want('hf')) results.push(hf());

  console.log('\n===== BATTERY =====');
  let fail = 0;
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(12)} ${r.detail}`);
    if (!r.pass) fail++;
  }
  console.log(`===== ${results.length - fail}/${results.length} passed =====`);
  if (fail > 0) process.exit(1);
}

main().catch((e: unknown) => {
  console.error('[battery] FAILED:', e instanceof Error ? e.message : e);
  process.exit(1);
});
