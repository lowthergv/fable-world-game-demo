/**
 * RT-1 — ray-traced water reflections (M2 SCAFFOLD item 3).
 *
 * Two independent pieces, both gated by `water_rt` (boolCvar, default off —
 * base tier must stay framealign-identical):
 *   1. WaterGBuffer: a half-res mesh-raster prepass over TWIN water meshes
 *      (WaterSurface's own geometry + per-level origin/innerRect uniforms —
 *      they track the camera-following clipmap for free, no extra sync code)
 *      with a lightweight material that reuses the exact displacement/
 *      ripple-normal/mask math from WaterMaterial.ts. TWO single-attachment
 *      passes (position, normal) rather than one MRT pass — `fragmentNode =
 *      mrt(...)` on a real Mesh (not three's own QuadMesh) reliably fails to
 *      compile here ("struct member m0 not found") regardless of how the
 *      value expressions are built; bare `colorNode`/`maskNode` on a plain
 *      `NodeMaterial` is the proven pattern in this codebase instead (see
 *      `VegPrepass.ts`'s `depthPrepassTwin`) — real discard, no MRT needed.
 *   2. WaterRtReflectPass: a compute kernel shaped exactly like
 *      RtSystem.tickDebug — lazy, no-ops until the RT-0 BVH resolves — that
 *      reads the G-buffer, traces each valid texel's reflection ray against
 *      the BVH, shades hits with RtSystem.hitShade, and writes a half-res
 *      StorageTexture (`rt_water_refl`) that WaterMaterial.reflection()
 *      samples.
 *
 * Miss handling is NOT this module's job: a miss (or "not built yet" or
 * "no water here") writes a zero-alpha sentinel; WaterMaterial's existing
 * crowned-horizon/sky fallback owns everything the RT pass doesn't hit.
 *
 * Debug views: ?waterrtdbg=pos|nrm|refl (PostStack bypass, same pattern as
 * ?view=rt) force the pass active regardless of the water_rt cvar so the
 * G-buffer/reflect texture can be inspected before anything reads it.
 */

import { HalfFloatType, Mesh, Scene, Vector3 } from 'three';
import type { PerspectiveCamera, Texture } from 'three';
import type { Renderer } from 'three/webgpu';
import { MeshBasicNodeMaterial, RenderTarget, StorageTexture } from 'three/webgpu';
import {
  Fn,
  If,
  Return,
  float,
  instanceIndex,
  ivec2,
  positionWorld,
  reflect,
  texture,
  textureStore,
  uint,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { boolCvar } from '../debug/Console';
import type { NV4 } from '../gpu/TSLTypes';
import type { RtBvhBuffers } from '../rt/RtBvh';
import { RtSystem, TMAX } from '../rt/RtSystem';
import type { Heightfield } from '../world/Heightfield';
import type { WaterSurface } from '../world/WaterSurface';
import { waterDisplacement, waterFlow, waterMask, waterRippleNormal } from './WaterMaterial';

/**
 * Half-res world-position(+validity) and world-normal G-buffer for the water
 * clipmap, rasterized from twin meshes sharing WaterSurface's geometry and
 * per-level uniforms (see WaterSurface.levelHandles()). Two passes (not one
 * MRT pass — see the module doc comment): `posRt` (rgb = world position,
 * a = validity) and `nrmRt` (rgb = world normal).
 */
class WaterGBuffer {
  readonly posRt: RenderTarget;
  readonly nrmRt: RenderTarget;
  private readonly posScene = new Scene();
  private readonly nrmScene = new Scene();

  constructor(hf: Heightfield, water: WaterSurface) {
    this.posRt = new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType });
    this.posRt.texture.name = 'rt_pos';
    this.nrmRt = new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType });
    this.nrmRt.texture.name = 'rt_nrm';

    for (const lvl of water.levelHandles()) {
      const disp = waterDisplacement(hf, lvl);
      const mask = waterMask(lvl);
      const { spd, fdir } = waterFlow(hf);
      const { n } = waterRippleNormal(hf, spd, fdir);

      const posMat = new MeshBasicNodeMaterial();
      posMat.name = 'WaterRtGBuffer.pos';
      posMat.positionNode = disp;
      posMat.maskNode = mask;
      posMat.colorNode = vec4(positionWorld, 1);
      posMat.toneMapped = false;
      posMat.depthWrite = false;
      posMat.depthTest = false;
      const posMesh = new Mesh(water.geometry, posMat);
      posMesh.frustumCulled = false;
      this.posScene.add(posMesh);

      const nrmMat = new MeshBasicNodeMaterial();
      nrmMat.name = 'WaterRtGBuffer.nrm';
      nrmMat.positionNode = disp;
      nrmMat.maskNode = mask;
      nrmMat.colorNode = vec4(n, 0);
      nrmMat.toneMapped = false;
      nrmMat.depthWrite = false;
      nrmMat.depthTest = false;
      const nrmMesh = new Mesh(water.geometry, nrmMat);
      nrmMesh.frustumCulled = false;
      this.nrmScene.add(nrmMesh);
    }
  }

  render(renderer: Renderer, camera: PerspectiveCamera, w: number, h: number): void {
    this.posRt.setSize(w, h); // no-op when unchanged
    this.nrmRt.setSize(w, h);
    const prevTarget = renderer.getRenderTarget();
    const prevAlpha = renderer.getClearAlpha();
    // zero-alpha clear: the reflect kernel reads posRt.a as "water here?" —
    // discarded (non-water) texels must read back invalid, not stale content.
    // RGB is irrelevant for invalid texels (never read) and gets overwritten
    // by the shader for valid ones, so only alpha needs save/restore.
    renderer.setClearAlpha(0);
    renderer.setRenderTarget(this.posRt);
    renderer.render(this.posScene, camera);
    renderer.setRenderTarget(this.nrmRt);
    renderer.render(this.nrmScene, camera);
    renderer.setRenderTarget(prevTarget);
    renderer.setClearAlpha(prevAlpha);
  }
}

export class WaterRtReflectPass {
  /** live toggle — the `water_rt` cvar (default off). */
  enabled = false;
  /** forced on via ?waterrtdbg=, independent of `enabled` (debug probing). */
  debugForced = false;

  private readonly gbuf: WaterGBuffer;
  private readonly uCamPos = uniform(new Vector3());
  private kernel: Parameters<Renderer['compute']>[0] | null = null;
  private readonly w: number;
  private readonly h: number;

  constructor(
    hf: Heightfield,
    private readonly rtSys: RtSystem,
    water: WaterSurface,
    /** shared with WaterMaterial — created once, before WaterSurface, so its
     * TSL graph holds a stable reference (a StorageTexture can't be resized/
     * recreated in place once embedded in a compiled shader — ensureDebugTex
     * carries the same constraint for RT-0's debug view). */
    readonly outTex: StorageTexture,
    /** shared numeric uniform (1/0) — WaterMaterial gates its RT-sample on
     * this so toggling `water_rt` off falls back to SSR immediately. */
    private readonly uEnabled: ReturnType<typeof uniform>,
  ) {
    this.gbuf = new WaterGBuffer(hf, water);
    const im = outTex.image as { width: number; height: number };
    this.w = im.width;
    this.h = im.height;
  }

  /** ?waterrtdbg=pos|nrm|refl — raw texture for PostStack's debug bypass. */
  debugTexture(mode: string): Texture | null {
    if (mode === 'pos') return this.gbuf.posRt.texture;
    if (mode === 'nrm') return this.gbuf.nrmRt.texture;
    if (mode === 'refl') return this.outTex;
    return null;
  }

  /** call every frame (engine.onUpdate) — cheap no-op when off. */
  tick(renderer: Renderer, camera: PerspectiveCamera): void {
    this.uEnabled.value = this.enabled ? 1 : 0;
    if (!this.enabled && !this.debugForced) return;
    this.gbuf.render(renderer, camera, this.w, this.h);

    const bvh = this.rtSys.builtBvh;
    if (!bvh) {
      void this.rtSys.build(renderer);
      return;
    }
    this.uCamPos.value.copy(camera.position);
    if (!this.kernel) {
      this.kernel = this.buildKernel(bvh, this.w, this.h);
    }
    renderer.compute(this.kernel);
  }

  private buildKernel(
    bvh: RtBvhBuffers,
    w: number,
    h: number,
  ): Parameters<Renderer['compute']>[0] {
    const outTex = this.outTex;
    const posTex = this.gbuf.posRt.texture;
    const nrmTex = this.gbuf.nrmRt.texture;
    const rtSys = this.rtSys;
    const camPos = vec3(this.uCamPos);
    const kernel = Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(uint(w * h)), () => {
        Return();
      });
      const px = i.mod(uint(w));
      const py = i.div(uint(w));
      const uv = vec2(float(px).add(0.5).div(w), float(py).add(0.5).div(h));
      const write = (col: NV4): void => {
        textureStore(outTex, ivec2(px.toInt(), py.toInt()), col).toWriteOnly();
      };
      const posSample = texture(posTex, uv) as unknown as NV4;
      If(posSample.w.lessThan(0.5), () => {
        write(vec4(0, 0, 0, 0));
        Return();
      });
      const nrmSample = texture(nrmTex, uv) as unknown as NV4;
      const hitPos = posSample.xyz;
      const nrm = nrmSample.xyz;
      const viewDir = hitPos.sub(camPos).normalize();
      // same xz-damped normal WaterMaterial's SSR path reflects against
      // (WaterMaterial.ts `rdir`) — keeps the RT cone consistent with SSR
      const nDamped = vec3(nrm.x.mul(0.55), nrm.y, nrm.z.mul(0.55)).normalize();
      const rd = reflect(viewDir, nDamped);
      const ro = hitPos.add(nrm.mul(0.08));
      const res = rtSys.trace(bvh, ro, rd, float(TMAX), 0);
      If(res.x.lessThanEqual(0), () => {
        write(vec4(0, 0, 0, 0));
        Return();
      });
      const shade = rtSys.hitShade(bvh, ro, rd, res);
      write(vec4(shade, 1));
    })().compute(w * h, [64]);
    (kernel as { setName?: (n: string) => void }).setName?.('waterRtReflect');
    return kernel as Parameters<Renderer['compute']>[0];
  }
}

export function registerWaterRtConsole(pass: WaterRtReflectPass): void {
  boolCvar(
    'water_rt',
    'RT-1: ray-traced water reflections (high tier; SSR/sky fallback when off or not built)',
    () => pass.enabled,
    (b) => {
      pass.enabled = b;
    },
  );
}

// ?waterrtdbg= display — module context so PostStack (built later in boot)
// can pick the pass up without a hard dependency, same pattern as
// setRtViewTexture/getRtViewTexture.
let dbgPass: WaterRtReflectPass | null = null;
export function setWaterRtDebugPass(p: WaterRtReflectPass | null): void {
  dbgPass = p;
}
export function getWaterRtDebugTexture(mode: string): Texture | null {
  return dbgPass ? dbgPass.debugTexture(mode) : null;
}
