/**
 * Composed bookmarks + flythrough (Phase 7, spec §8: "9 bookmarks,
 * 90 s flythrough"). Showcase viewpoints are COMPOSED, not found
 * (Pillar E) — each pairs a verified framing with its best time of day.
 *
 * Keys 1–9 jump to a bookmark (pose + ToD); ?shot=N boots into one.
 * ?fly=1 (or key F) runs a looping ~90 s Catmull-Rom flythrough through
 * a subset of the bookmarks; the tour curve is clearance-enforced at build
 * time (see buildTourCurve — the raw spline used to tunnel terrain and
 * skim canopy, and the fly rig's soft clamp only masked it).
 */

import type { PerspectiveCamera } from 'three';
import { CatmullRomCurve3, Vector3 } from 'three';
import type { Engine } from '../core/Engine';
import type { LaasHooks } from '../core/Hooks';
import type { LaasParams } from '../core/Params';
import type { Heightfield } from '../world/Heightfield';
import { registerCommand } from './Console';

export interface Bookmark {
  name: string;
  x: number;
  z: number;
  /** meters above ground (water-guarded at apply time) */
  alt: number;
  yaw: number;
  pitch: number;
  tod: number;
}

/** nine composed viewpoints — verified framings from the phase shots */
export const BOOKMARKS: Bookmark[] = [
  { name: 'Gorge stream (scene1)', x: 620, z: 650, alt: 1.3, yaw: 0.5, pitch: -0.12, tod: 12.5 },
  { name: 'Dawn lake mist', x: 11, z: 1338, alt: 9, yaw: 1.2, pitch: -0.06, tod: 7.5 },
  { name: 'Golden vista (Witcher)', x: 1500, z: 1900, alt: 250, yaw: 0.65, pitch: -0.18, tod: 19 },
  { name: 'Morning meadow shafts', x: -870, z: 862, alt: 1.8, yaw: -1.45, pitch: 0.02, tod: 8.2 },
  { name: 'Alpine tarn', x: 805, z: -1464, alt: 2.2, yaw: 1.57, pitch: -0.4, tod: 15.5 },
  { name: 'Karst ravine mouth', x: 650, z: 700, alt: 5, yaw: 0.6, pitch: -0.06, tod: 15 },
  // re-posed 2026-07-02 (Phase-7 close-out): the old pose framed a trunk
  // close-up from inside a crown. Now a backlit interior: sun through the
  // canopy upper-left, layered trunks, dapple pools on a mixed grass floor
  // (judged from a 12-candidate sweep, shots/wip/bm7/)
  { name: 'Forest interior dapple', x: -864, z: 856, alt: 2.6, yaw: -1.45, pitch: 0.03, tod: 12.5 },
  { name: 'Lakeshore golden', x: -1400, z: 1250, alt: 2.5, yaw: 3.14, pitch: -0.12, tod: 18.5 },
  { name: 'Valley network aerial', x: -600, z: 700, alt: 260, yaw: -0.6, pitch: -0.5, tod: 17.5 },
];

function poseY(hf: Heightfield, b: Bookmark): number {
  const ground = hf.heightAtCpu(b.x, b.z) + b.alt;
  const water = hf.waterYAtCpu(b.x, b.z) + 0.6;
  return Math.max(ground, water);
}

export function installBookmarks(
  engine: Engine,
  hf: Heightfield,
  hooks: LaasHooks,
  params: LaasParams,
): void {
  const apply = (i: number): void => {
    const b = BOOKMARKS[i];
    if (!b) return;
    hooks.setPose?.({ p: [b.x, poseY(hf, b), b.z], yaw: b.yaw, pitch: b.pitch });
    hooks.setTimeOfDay?.(b.tod);
  };

  window.addEventListener('keydown', (e) => {
    const m = /^Digit([1-9])$/.exec(e.code);
    if (m) apply(Number(m[1]) - 1);
    if (e.code === 'KeyF') fly.toggle();
  });

  // ---- flythrough -------------------------------------------------------------
  const FLY_SECONDS = 92;
  // a tour that reads as one continuous shot: vista → descend the valley →
  // lake → meadow forest edge → gorge mouth → aerial pull-out
  const TOUR: { x: number; z: number; alt: number; yaw: number; pitch: number }[] = [
    { x: 1500, z: 1900, alt: 250, yaw: 0.65, pitch: -0.18 },
    { x: 900, z: 1500, alt: 120, yaw: 1.0, pitch: -0.12 },
    { x: 300, z: 1400, alt: 40, yaw: 1.35, pitch: -0.08 },
    { x: 11, z: 1338, alt: 12, yaw: 1.2, pitch: -0.05 },
    { x: -500, z: 1100, alt: 25, yaw: 2.0, pitch: -0.06 },
    { x: -870, z: 880, alt: 8, yaw: 2.6, pitch: -0.03 },
    { x: -600, z: 720, alt: 60, yaw: 3.5, pitch: -0.15 },
    { x: 100, z: 680, alt: 35, yaw: 4.3, pitch: -0.08 },
    { x: 620, z: 660, alt: 6, yaw: 4.9, pitch: -0.05 },
    { x: 900, z: 900, alt: 180, yaw: 5.6, pitch: -0.3 },
    { x: 1500, z: 1900, alt: 250, yaw: 0.65 + Math.PI * 2, pitch: -0.18 },
  ];

  /**
   * Clearance-enforced tour curve. The raw waypoint spline crossed terrain
   * (u≈0.41 −28 m, u≈0.70 −146 m through the karst ridge — probe-clearance)
   * and clipped tree crowns at lakeshore/forest-edge spans; the live
   * flythrough only survived via the fly rig's soft ground clamp, which
   * skimmed the camera through canopy (whole-frame flashes in probe-pops).
   * Rebuild: sample the raw spline arc-uniformly, clamp each sample to
   * ground/water + 22 m (crowns reach ~20 m), but blend back to the
   * AUTHORED altitude near waypoints — the composed low moments (gorge
   * 6 m, forest edge 8 m, dawn lake 12 m) keep their framing and the
   * approach reads as a swoop.
   */
  const buildTourCurve = (): CatmullRomCurve3 => {
    const raw = new CatmullRomCurve3(
      TOUR.map((w) => new Vector3(w.x, poseY(hf, { ...w, tod: 0, name: '' } as Bookmark), w.z)),
      false,
      'centripetal',
      0.5,
    );
    // arc-length parameter of each waypoint (uniform t → arc u)
    const L = raw.getLength();
    const lengths = raw.getLengths(400);
    const tToArcU = (t: number): number => {
      const idx = Math.min(399, Math.max(0, Math.round(t * 400)));
      return (lengths[idx] ?? 0) / L;
    };
    const wpU = TOUR.map((_w, j) => tToArcU(j / (TOUR.length - 1)));
    // clamp with headroom above the visual margin (22 m): the rebuilt
    // spline undershoots between control points on concave terrain, and
    // ridges spike between samples — two passes + neighborhood floor keep
    // the delivered clearance ≥ ~20 m everywhere off-waypoint
    const CLEAR = 28;
    const M = 320;
    const floorAt = (c: CatmullRomCurve3, u: number): number => {
      let fl = -Infinity;
      for (const du of [-1 / M / 2, 0, 1 / M / 2]) {
        const q = c.getPointAt(Math.min(1, Math.max(0, u + du)));
        fl = Math.max(fl, hf.heightAtCpu(q.x, q.z), hf.waterYAtCpu(q.x, q.z));
      }
      return fl;
    };
    const clampPass = (c: CatmullRomCurve3): CatmullRomCurve3 => {
      const pts: Vector3[] = [];
      for (let i = 0; i <= M; i++) {
        const u = i / M;
        const p = c.getPointAt(u);
        // nearest waypoint in arc-u; keep authored Y within ±0.015 (~110 m)
        let dNear = 1;
        for (const wu of wpU) dNear = Math.min(dNear, Math.abs(u - wu));
        let k = Math.max(0, 1 - dNear / 0.015);
        k = k * k * (3 - 2 * k);
        const clamped = Math.max(p.y, floorAt(c, u) + CLEAR);
        pts.push(new Vector3(p.x, clamped * (1 - k) + p.y * k, p.z));
      }
      return new CatmullRomCurve3(pts, false, 'centripetal', 0.5);
    };
    return clampPass(clampPass(raw));
  };
  const tourCurve = buildTourCurve();

  class Flythrough {
    private active = false;
    private t = 0;
    private curve: CatmullRomCurve3 | null = null;

    toggle(): void {
      this.active = !this.active;
      hooks.flyCamEnabled?.(!this.active);
      if (this.active && !this.curve) {
        this.curve = tourCurve;
      }
      if (!this.active) this.t = 0;
    }

    update(dt: number, cam: PerspectiveCamera): void {
      if (!this.active || !this.curve) return;
      this.t = (this.t + dt / FLY_SECONDS) % 1;
      const u = this.t;
      const p = this.curve.getPointAt(u);
      cam.position.copy(p);
      // yaw/pitch: linear over the waypoint list (yaws authored unwrapped)
      const seg = u * (TOUR.length - 1);
      const i0 = Math.min(Math.floor(seg), TOUR.length - 2);
      const f = seg - i0;
      const w0 = TOUR[i0];
      const w1 = TOUR[i0 + 1];
      if (!w0 || !w1) return;
      const yaw = w0.yaw + (w1.yaw - w0.yaw) * f;
      const pitch = w0.pitch + (w1.pitch - w0.pitch) * f;
      hooks.setPose?.({ p: [p.x, p.y, p.z], yaw, pitch });
    }
  }
  const fly = new Flythrough();
  engine.onUpdate((dt) => fly.update(dt, engine.camera));
  if (new URLSearchParams(window.location.search).get('fly') === '1') {
    fly.toggle();
  }

  // tooling: pure tour-pose sampler (u ∈ [0,1]) — the pop probe drives the
  // SAME path deterministically via setPose + settle(1) (the live flythrough
  // integrates wall dt, which headless stepping can't reproduce)
  const flyPose = (u01: number): { p: [number, number, number]; yaw: number; pitch: number } => {
    const u = Math.min(Math.max(u01, 0), 1);
    const p = tourCurve.getPointAt(u);
    const seg = u * (TOUR.length - 1);
    const i0 = Math.min(Math.floor(seg), TOUR.length - 2);
    const f = seg - i0;
    const w0 = TOUR[i0];
    const w1 = TOUR[i0 + 1];
    const yaw = w0 && w1 ? w0.yaw + (w1.yaw - w0.yaw) * f : 0;
    const pitch = w0 && w1 ? w0.pitch + (w1.pitch - w0.pitch) * f : 0;
    return { p: [p.x, p.y, p.z], yaw, pitch };
  };
  const dbg = (window as unknown as { __laasDbg?: Record<string, unknown> });
  dbg.__laasDbg = { ...(dbg.__laasDbg ?? {}), flyPose };

  // console: `shot N` mirrors keys 1-9, `flythrough` mirrors F
  registerCommand({
    name: 'shot',
    help: 'jump to a composed bookmark 1-9 (`shot` lists them)',
    complete: () => BOOKMARKS.map((_, i) => String(i + 1)),
    run: (args, con) => {
      if (!args[0]) {
        BOOKMARKS.forEach((b, i) => con.print(`  ${i + 1}  ${b.name}  (T ${b.tod})`, 'dim'));
        return;
      }
      const n = Number(args[0]);
      if (!Number.isInteger(n) || n < 1 || n > BOOKMARKS.length) {
        con.print(`usage: shot 1-${BOOKMARKS.length}`, 'err');
        return;
      }
      apply(n - 1);
      con.print(`→ ${BOOKMARKS[n - 1]?.name ?? ''}`);
    },
  });
  registerCommand({
    name: 'flythrough',
    help: 'toggle the 92 s cinematic tour (key F)',
    run: (_a, con) => {
      fly.toggle();
      con.print('flythrough toggled');
    },
  });

  // boot directly into a bookmark (?shot=N) — pose via initialPose (the
  // fly rig applies it after this scene finishes building)
  if (params.shot !== null && params.cam === null) {
    const b = BOOKMARKS[params.shot - 1];
    if (b) {
      hooks.initialPose = { p: [b.x, poseY(hf, b), b.z], yaw: b.yaw, pitch: b.pitch };
      // the default-spawn branch set 'walk' before us — a bookmark is a
      // programmatic pose and keeps FLY semantics (walk-snap silently
      // dropped high bookmarks like bm3's 250 m vista to the ground)
      hooks.initialPoseMode = 'fly';
    }
  }
}
