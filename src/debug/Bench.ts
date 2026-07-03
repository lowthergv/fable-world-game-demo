/**
 * `bench` — in-session performance measurement (v3 §13; lands with M1 so
 * every perf claim after uses the BINDING methodology from STATUS.md:
 * in-session ABAB pairs, percentiles not just medians).
 *
 *   bench [secs]            sample the CURRENT view (default 8 s)
 *   bench <bm 1-9> [secs]   jump to a bookmark, warm up, sample
 *   bench ab <cvar> <a> <b> [secs]   automated in-session ABAB: alternates
 *       the cvar A→B→A→B (4 rounds, warmup between), prints per-value
 *       percentile rows + the median delta — thermal-drift-proof.
 *
 * Numbers reported: wall dt percentiles (p50/p90/p95/p99/max), fps, spike
 * count (frame > max(1.8×p50, p50+8 ms) — the probe-spikes rule), CPU
 * update/submit medians, GPU render+compute median when ?prof=1.
 */

import type { Engine } from '../core/Engine';
import { findCommand, registerCommand, type DevConsole } from './Console';

interface BenchSample {
  dt: number[];
  cpuU: number[];
  cpuS: number[];
  gpu: number[];
}

interface BenchRow {
  label: string;
  frames: number;
  fps: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  spikes: number;
  cpuU: number;
  cpuS: number;
  gpu: number;
}

function pct(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
}

function median(a: number[]): number {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)] ?? 0;
}

function summarize(label: string, s: BenchSample): BenchRow {
  const sorted = [...s.dt].sort((a, b) => a - b);
  const p50 = pct(sorted, 0.5);
  const spikeT = Math.max(p50 * 1.8, p50 + 8);
  const mean = s.dt.reduce((a, b) => a + b, 0) / Math.max(1, s.dt.length);
  return {
    label,
    frames: s.dt.length,
    fps: 1000 / Math.max(0.01, mean),
    p50,
    p90: pct(sorted, 0.9),
    p95: pct(sorted, 0.95),
    p99: pct(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
    spikes: s.dt.filter((d) => d > spikeT).length,
    cpuU: median(s.cpuU),
    cpuS: median(s.cpuS),
    gpu: median(s.gpu),
  };
}

function printRow(con: DevConsole, r: BenchRow): void {
  con.print(
    `  ${r.label.padEnd(10)} ${r.fps.toFixed(1).padStart(6)} fps · ` +
      `p50 ${r.p50.toFixed(1)} p90 ${r.p90.toFixed(1)} p95 ${r.p95.toFixed(1)} ` +
      `p99 ${r.p99.toFixed(1)} max ${r.max.toFixed(1)} ms · spikes ${r.spikes}`,
  );
  con.print(
    `  ${''.padEnd(10)} cpu.update ${r.cpuU.toFixed(1)} · cpu.submit ${r.cpuS.toFixed(1)}` +
      (r.gpu > 0 ? ` · gpu ${r.gpu.toFixed(1)} ms` : ' · gpu n/a (boot with ?prof=1)'),
  );
}

export function installBench(engine: Engine): void {
  let active: BenchSample | null = null;

  engine.onUpdate((dt) => {
    if (!active) return;
    active.dt.push(dt * 1000);
    active.cpuU.push((engine.stats.counters['cpu.updateMs100'] ?? 0) / 100);
    active.cpuS.push((engine.stats.counters['cpu.submitMs100'] ?? 0) / 100);
    const g = engine.stats.gpuPasses;
    active.gpu.push((g['render'] ?? 0) + (g['compute'] ?? 0));
  });

  const sample = async (secs: number): Promise<BenchSample> => {
    const s: BenchSample = { dt: [], cpuU: [], cpuS: [], gpu: [] };
    active = s;
    const t0 = performance.now();
    while (performance.now() - t0 < secs * 1000) await engine.settle(30);
    active = null;
    return s;
  };

  const exec = (con: DevConsole, line: string): boolean => {
    const [name, ...args] = line.split(/\s+/);
    const cmd = name ? findCommand(name) : undefined;
    if (!cmd) return false;
    cmd.run(args, con);
    return true;
  };

  let running = false;
  registerCommand({
    name: 'bench',
    help: 'bench [secs] | bench <bm 1-9> [secs] | bench ab <cvar> <a> <b> [secs]',
    run: (args, con) => {
      if (running) {
        con.print('bench already running', 'err');
        return;
      }
      void (async () => {
        running = true;
        try {
          if (args[0] === 'ab') {
            const [, cvar, a, b] = args;
            const secs = Number(args[4] ?? 4);
            if (!cvar || a === undefined || b === undefined) {
              con.print('usage: bench ab <cvar> <a> <b> [secs]', 'err');
              return;
            }
            if (!findCommand(cvar)) {
              con.print(`unknown cvar: ${cvar}`, 'err');
              return;
            }
            const rows: BenchRow[] = [];
            for (const v of [a, b, a, b]) {
              exec(con, `${cvar} ${v}`);
              await engine.settle(45); // warmup past transitions
              rows.push(summarize(`${cvar}=${v}`, await sample(secs)));
            }
            con.print(`bench ab ${cvar} ${a}↔${b} (${secs}s ×4, in-session ABAB):`);
            for (const r of rows) printRow(con, r);
            const av = median(rows.filter((_r, i) => i % 2 === 0).map((r) => r.p50));
            const bv = median(rows.filter((_r, i) => i % 2 === 1).map((r) => r.p50));
            con.print(
              `  Δp50 ${cvar} ${a}→${b}: ${(bv - av).toFixed(2)} ms ` +
                `(${av.toFixed(1)} → ${bv.toFixed(1)})`,
            );
            return;
          }
          let secs = 8;
          if (args[0] !== undefined) {
            const n = Number(args[0]);
            if (Number.isInteger(n) && n >= 1 && n <= 9 && args[1] !== undefined) {
              exec(con, `shot ${n}`);
              await engine.settle(90);
              secs = Number(args[1]);
            } else if (Number.isInteger(n) && n >= 1 && n <= 9 && findCommand('shot')) {
              // bare `bench <bm>` — bookmark + default duration
              exec(con, `shot ${n}`);
              await engine.settle(90);
            } else if (Number.isFinite(n)) {
              secs = n;
            }
          }
          secs = Math.min(Math.max(secs, 1), 120);
          con.print(`bench: sampling ${secs}s…`, 'dim');
          printRow(con, summarize('view', await sample(secs)));
        } finally {
          running = false;
        }
      })();
    },
  });
}
