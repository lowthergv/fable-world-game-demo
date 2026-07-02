/**
 * Weather — a state machine over the knobs the sky/air systems already
 * expose: cloud coverage + density (Clouds uniforms → the 2.5 s shadow
 * re-bake propagates darkening to terrain), froxel fog density, wind
 * strength (drives vegetation sway, particles, cloud drift), and a global
 * precipitation roll for the particle system (rain streaks / all-biome
 * snow via `weatherU` — module-level uniforms, same pattern as `windU`).
 *
 * States lerp smoothly (exp-damp, ~14 s time constant at default rates):
 * a storm rolls in, it doesn't switch on. AUTO mode wanders a seeded
 * Markov chain (deterministic per world seed) with 3–8 game-minute
 * dwells; `weather <state>` pins, `weather auto` resumes.
 *
 * Runs on WORLD time — composes with `timescale`, freezes under ?freeze=1.
 */

import { uniform } from 'three/tsl';
import type { Rng } from '../core/Seed';
import type { Froxels } from '../gpu/passes/Froxels';
import { windU } from '../render/Wind';
import type { Clouds } from './Clouds';

/** precipitation uniforms for the particle system (0..1 roll probability) */
export const weatherU = {
  rain: uniform(0),
  snow: uniform(0),
};

export interface WeatherParams {
  coverage: number;
  density: number;
  fog: number;
  wind: number;
  rain: number;
  snow: number;
}

/** `fair` IS the verified art baseline — boot defaults, exactly */
export const WEATHER_STATES: Record<string, WeatherParams> = {
  clear: { coverage: 0.3, density: 0.8, fog: 0.22, wind: 0.3, rain: 0, snow: 0 },
  fair: { coverage: 0.62, density: 0.85, fog: 0.4, wind: 0.45, rain: 0, snow: 0 },
  overcast: { coverage: 0.92, density: 1.25, fog: 0.75, wind: 0.8, rain: 0, snow: 0 },
  fog: { coverage: 0.55, density: 0.9, fog: 3.0, wind: 0.15, rain: 0, snow: 0 },
  rain: { coverage: 0.95, density: 1.5, fog: 1.1, wind: 1.1, rain: 0.65, snow: 0 },
  storm: { coverage: 1.0, density: 2.3, fog: 1.3, wind: 2.2, rain: 1.0, snow: 0 },
  snow: { coverage: 0.8, density: 1.1, fog: 0.9, wind: 0.7, rain: 0, snow: 0.85 },
};

/** auto-mode transition weights (snow is manual-only — see README) */
const AUTO_NEXT: Record<string, [string, number][]> = {
  clear: [['fair', 3], ['clear', 2]],
  fair: [['clear', 2], ['overcast', 2], ['fair', 2], ['fog', 1]],
  overcast: [['fair', 2], ['rain', 2], ['overcast', 1], ['fog', 1]],
  fog: [['fair', 2], ['overcast', 1]],
  rain: [['overcast', 2], ['storm', 1], ['rain', 1]],
  storm: [['rain', 2], ['overcast', 1]],
  snow: [['snow', 3], ['overcast', 1]],
};

/** exp-damp time constant toward the target state (world-seconds) */
const TRANS_TAU = 14;
const DWELL_MIN = 180;
const DWELL_SPAN = 300;

export class Weather {
  auto: boolean;
  private stateV: string;
  private cur: WeatherParams;
  /** instance copy — console cvars may write through it without touching
   *  the WEATHER_STATES table */
  private tgt: WeatherParams;
  private clouds: Clouds;
  private froxels: Froxels | null;
  private rng: Rng;
  private dwell: number;

  constructor(clouds: Clouds, froxels: Froxels | null, rng: Rng, initial: string, auto: boolean) {
    this.clouds = clouds;
    this.froxels = froxels;
    this.rng = rng;
    this.auto = auto;
    this.stateV = WEATHER_STATES[initial] ? initial : 'fair';
    this.cur = { ...(WEATHER_STATES[this.stateV] as WeatherParams) };
    this.tgt = { ...(WEATHER_STATES[this.stateV] as WeatherParams) };
    this.dwell = DWELL_MIN + this.rng.float() * DWELL_SPAN;
    this.apply();
  }

  get state(): string {
    return this.stateV;
  }

  /** live params — console `fog`/`wind` cvars write through these */
  get params(): WeatherParams {
    return this.cur;
  }

  get target(): WeatherParams {
    return this.tgt;
  }

  set(state: string): boolean {
    const s = WEATHER_STATES[state];
    if (!s) return false;
    this.stateV = state;
    this.tgt = { ...s };
    this.dwell = DWELL_MIN + this.rng.float() * DWELL_SPAN;
    return true;
  }

  /** push current params to the uniforms NOW — needed after boot-time
   *  param overrides under ?freeze=1, where update() never runs */
  applyNow(): void {
    this.apply();
  }

  /** dt is world time (caller gates on freeze) */
  update(dt: number): void {
    if (dt <= 0) return;
    if (this.auto) {
      this.dwell -= dt;
      if (this.dwell <= 0) {
        const table = AUTO_NEXT[this.stateV] ?? [['fair', 1] as [string, number]];
        let total = 0;
        for (const [, w] of table) total += w;
        let roll = this.rng.float() * total;
        for (const [name, w] of table) {
          roll -= w;
          if (roll <= 0) {
            this.set(name);
            break;
          }
        }
      }
    }
    const tgt = this.tgt;
    const k = 1 - Math.exp(-dt / TRANS_TAU);
    this.cur.coverage += (tgt.coverage - this.cur.coverage) * k;
    this.cur.density += (tgt.density - this.cur.density) * k;
    this.cur.fog += (tgt.fog - this.cur.fog) * k;
    this.cur.wind += (tgt.wind - this.cur.wind) * k;
    this.cur.rain += (tgt.rain - this.cur.rain) * k;
    this.cur.snow += (tgt.snow - this.cur.snow) * k;
    this.apply();
  }

  private apply(): void {
    this.clouds.coverage.value = this.cur.coverage;
    this.clouds.density.value = this.cur.density;
    if (this.froxels) this.froxels.fogK.value = this.cur.fog;
    windU.strength.value = this.cur.wind;
    weatherU.rain.value = this.cur.rain;
    weatherU.snow.value = this.cur.snow;
  }

  describe(): string {
    const c = this.cur;
    return (
      `weather: ${this.stateV}${this.auto ? ' (auto)' : ' (pinned)'}  ` +
      `cov ${c.coverage.toFixed(2)}  dens ${c.density.toFixed(2)}  fog ${c.fog.toFixed(2)}  ` +
      `wind ${c.wind.toFixed(2)}  rain ${c.rain.toFixed(2)}  snow ${c.snow.toFixed(2)}`
    );
  }
}
