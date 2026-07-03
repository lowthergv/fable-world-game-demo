/**
 * `demo` — record/replay camera runs (v3 §13; lands with M1). A user who
 * sees a bug records a demo; the demo replays the same path + time of day,
 * so the bug becomes a shot/bench/probe target.
 *
 *   demo record <name>   start recording pose track (60 Hz, ≤120 s)
 *   demo stop            stop recording (saves) or stop playback
 *   demo play <name>     replay: drives the camera + ToD; fly input off
 *   demo list            saved demos (localStorage, keyed by seed)
 *   demo delete <name>
 *
 * Recorded: pose track (position/yaw/pitch, absolute path-time), time of
 * day at record start, world seed (playback refuses a seed mismatch —
 * different world). Weather: pin it manually (`weather <state>`) before
 * record AND play if the run depends on it; the auto-Markov wander is
 * seeded but time-phase-dependent.
 * Playback interpolates on wall dt (composes with `timescale`). Combine
 * with `bench` to measure over a demo: `demo play x` then `bench 30`.
 */

import type { Engine } from '../core/Engine';
import type { LaasHooks } from '../core/Hooks';
import { registerCommand } from './Console';

interface DemoFile {
  v: 1;
  seed: number;
  tod: number;
  /** [t, x, y, z, yaw, pitch] rows, t in seconds from start */
  track: number[][];
}

const KEY_PREFIX = 'laas.demo.';
const MAX_SECONDS = 120;
const SAMPLE_HZ = 60;

export function installDemo(engine: Engine, hooks: LaasHooks, seed: number): void {
  let recording: { name: string; t: number; last: number; track: number[][] } | null = null;
  let playing: { name: string; t: number; track: number[][]; end: number } | null = null;

  const todNow = (): number => {
    const s = (engine as unknown as { sunSky?: { timeOfDay?: number } }).sunSky;
    return s?.timeOfDay ?? 12;
  };

  engine.onUpdate((dt) => {
    if (recording && hooks.getPose) {
      recording.t += dt;
      if (recording.t >= MAX_SECONDS) {
        recording = null; // guard: never grow unbounded
        return;
      }
      if (recording.t - recording.last >= 1 / SAMPLE_HZ) {
        recording.last = recording.t;
        const p = hooks.getPose();
        recording.track.push([
          Math.round(recording.t * 1000) / 1000,
          Math.round(p.p[0] * 100) / 100,
          Math.round(p.p[1] * 100) / 100,
          Math.round(p.p[2] * 100) / 100,
          Math.round(p.yaw * 1e4) / 1e4,
          Math.round(p.pitch * 1e4) / 1e4,
        ]);
      }
    }
    if (playing && hooks.setPose) {
      playing.t += dt;
      const tr = playing.track;
      if (playing.t >= playing.end) {
        const lastRow = tr[tr.length - 1];
        if (lastRow) {
          hooks.setPose({
            p: [lastRow[1] ?? 0, lastRow[2] ?? 0, lastRow[3] ?? 0],
            yaw: lastRow[4] ?? 0,
            pitch: lastRow[5] ?? 0,
          });
        }
        playing = null;
        hooks.flyCamEnabled?.(true);
        return;
      }
      // binary search the bracketing samples, lerp
      let lo = 0;
      let hi = tr.length - 1;
      while (lo < hi - 1) {
        const mid = (lo + hi) >> 1;
        if ((tr[mid]?.[0] ?? 0) <= playing.t) lo = mid;
        else hi = mid;
      }
      const A = tr[lo];
      const B = tr[hi];
      if (!A || !B) return;
      const span = Math.max(1e-4, (B[0] ?? 0) - (A[0] ?? 0));
      const f = Math.min(1, Math.max(0, (playing.t - (A[0] ?? 0)) / span));
      const mix = (a: number, b: number): number => a + (b - a) * f;
      hooks.setPose({
        p: [mix(A[1] ?? 0, B[1] ?? 0), mix(A[2] ?? 0, B[2] ?? 0), mix(A[3] ?? 0, B[3] ?? 0)],
        yaw: mix(A[4] ?? 0, B[4] ?? 0),
        pitch: mix(A[5] ?? 0, B[5] ?? 0),
      });
    }
  });

  const names = (): string[] => {
    const out: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(KEY_PREFIX)) out.push(k.slice(KEY_PREFIX.length));
    }
    return out.sort();
  };

  registerCommand({
    name: 'demo',
    help: 'demo record <name> | demo play <name> | demo stop | demo list | demo delete <name>',
    complete: () => ['record', 'play', 'stop', 'list', 'delete'],
    run: (args, con) => {
      const sub = args[0];
      const name = args[1];
      if (sub === 'record') {
        if (!name) {
          con.print('usage: demo record <name>', 'err');
          return;
        }
        if (recording || playing) {
          con.print('demo busy — `demo stop` first', 'err');
          return;
        }
        recording = { name, t: 0, last: -1, track: [] };
        con.print(`recording "${name}"… (\`demo stop\` to save, cap ${MAX_SECONDS}s)`);
        return;
      }
      if (sub === 'stop') {
        if (recording) {
          const file: DemoFile = { v: 1, seed, tod: todNow(), track: recording.track };
          try {
            localStorage.setItem(KEY_PREFIX + recording.name, JSON.stringify(file));
            con.print(
              `saved "${recording.name}": ${recording.track.length} samples, ` +
                `${recording.t.toFixed(1)}s`,
            );
          } catch {
            con.print('save failed (localStorage quota?) — demo discarded', 'err');
          }
          recording = null;
          return;
        }
        if (playing) {
          playing = null;
          hooks.flyCamEnabled?.(true);
          con.print('playback stopped');
          return;
        }
        con.print('nothing to stop', 'dim');
        return;
      }
      if (sub === 'play') {
        if (!name) {
          con.print('usage: demo play <name>', 'err');
          return;
        }
        if (recording || playing) {
          con.print('demo busy — `demo stop` first', 'err');
          return;
        }
        const raw = localStorage.getItem(KEY_PREFIX + name);
        if (!raw) {
          con.print(`no demo "${name}" (see \`demo list\`)`, 'err');
          return;
        }
        const file = JSON.parse(raw) as DemoFile;
        if (file.seed !== seed) {
          con.print(`demo "${name}" was recorded on seed ${file.seed} (this is ${seed})`, 'err');
          return;
        }
        if (file.track.length < 2) {
          con.print(`demo "${name}" is empty`, 'err');
          return;
        }
        hooks.flyCamEnabled?.(false);
        hooks.setTimeOfDay?.(file.tod);
        playing = {
          name,
          t: 0,
          track: file.track,
          end: file.track[file.track.length - 1]?.[0] ?? 0,
        };
        con.print(`playing "${name}" (${playing.end.toFixed(1)}s, ToD ${file.tod.toFixed(1)})`);
        return;
      }
      if (sub === 'list') {
        const all = names();
        if (all.length === 0) {
          con.print('no saved demos', 'dim');
          return;
        }
        for (const n of all) {
          const raw = localStorage.getItem(KEY_PREFIX + n);
          try {
            const f = raw ? (JSON.parse(raw) as DemoFile) : null;
            const secs = f?.track[f.track.length - 1]?.[0] ?? 0;
            con.print(`  ${n}  ${secs.toFixed(1)}s  seed ${f?.seed} ToD ${f?.tod.toFixed(1)}`, 'dim');
          } catch {
            con.print(`  ${n}  (corrupt)`, 'dim');
          }
        }
        return;
      }
      if (sub === 'delete') {
        if (!name) {
          con.print('usage: demo delete <name>', 'err');
          return;
        }
        localStorage.removeItem(KEY_PREFIX + name);
        con.print(`deleted "${name}"`);
        return;
      }
      con.print('usage: demo record|play|stop|list|delete', 'err');
    },
  });
}
