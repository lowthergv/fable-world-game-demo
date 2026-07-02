/**
 * Continuous day/night cycle — advances the time of day on WORLD time
 * (composes with `timescale` and freezes under ?freeze=1) and re-lights the
 * scene through a cost-tiered path:
 *
 *   every frame   sun direction/intensity/color + hemisphere uniforms and
 *                 the ToD film grade (pure CPU math + uniform writes)
 *   ~0.02 game-h  sky-view LUT rebake (192×108 compute — the sky gradient
 *                 lags the sun direction imperceptibly between strides)
 *   ~0.10 game-h  IBL environment cube + PMREM refresh
 *   free          cloud-shadow map re-bakes every 2.5 s anyway (weather
 *                 motion) and picks up the current sun; probe GI re-gathers
 *                 fully in <1 s of time slices; CSM cascades adopt the sun
 *                 at their own refresh cadence (CsmCached sun-jump gate)
 *
 * Discrete jumps (console `time`, bookmarks) still use the full
 * hooks.setTimeOfDay path — LUT + IBL + cloud shadow + GI invalidate at
 * once; the cycle just continues from the new hour.
 */

import type { PostStack } from '../render/PostStack';
import type { SunSky } from './SunSky';

const SKYVIEW_STRIDE_H = 0.02;
const IBL_STRIDE_H = 0.1;

/** minimal circular distance between two hours-of-day */
function todDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 24;
  return Math.min(d, 24 - d);
}

export class DayCycle {
  /** world-seconds per full 24 h day; 0 disables the cycle */
  daySeconds: number;
  private sunSky: SunSky;
  private post: PostStack;
  private lastSkyViewTod: number;
  private lastIblTod: number;

  constructor(sunSky: SunSky, post: PostStack, daySeconds: number) {
    this.sunSky = sunSky;
    this.post = post;
    this.daySeconds = daySeconds;
    this.lastSkyViewTod = sunSky.timeOfDay;
    this.lastIblTod = sunSky.timeOfDay;
  }

  /** dt is world time (already timescale-scaled; caller gates on freeze) */
  update(dt: number): void {
    if (this.daySeconds <= 0 || dt <= 0) return;
    const tod = (this.sunSky.timeOfDay + (dt * 24) / this.daySeconds) % 24;
    const skyView = todDelta(tod, this.lastSkyViewTod) > SKYVIEW_STRIDE_H;
    if (skyView) this.lastSkyViewTod = tod;
    this.sunSky.setTimeOfDayFast(tod, skyView);
    this.post.setTimeOfDay(tod);
    if (todDelta(tod, this.lastIblTod) > IBL_STRIDE_H) {
      this.lastIblTod = tod;
      void this.sunSky.refreshEnvironment();
    }
  }
}
