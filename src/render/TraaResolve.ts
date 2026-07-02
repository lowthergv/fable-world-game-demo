/**
 * Custom TRAA resolve — replaces three's stock TRAANode (still available via
 * ?traa=stock for A/B). Same jitter mechanics (identical halton sequence and
 * view-offset lifecycle — framealign law) and the same analytic-velocity
 * seam; the differences are the resolve shader and the history plumbing:
 *
 * 1. K-1 KILLER — rest-widened variance clipping. Stock clips history to the
 *    current frame's 3×3 mean±1σ even at rest, so converged history of
 *    sub-pixel content (distant canopy, ridgelines) ping-pongs at jitter
 *    frequency (probe-temporal attribution, STATUS 2026-07-02). Here the
 *    clip box widens (γ→traa_gammastill) ONLY where velocity ≈ 0 AND the
 *    content is beyond the wind-animation fade (traa_far0..1 — nothing
 *    self-moves out there except wall-clock water, which the widening also
 *    calms), so near swaying foliage keeps stock-crisp behavior and motion
 *    keeps the stock tight box (no new ghosting regime).
 * 2. Catmull-Rom history sampling (5-tap renormalized cross) — recovers the
 *    ~10-18% HF energy the bilinear history resample loses (cloud-lag entry,
 *    4×SSAA audit). Degenerates to an exact center tap at rest (f = 0).
 * 3. Ping-pong history — resolve renders INTO history[write] while sampling
 *    history[read]: kills stock's two full-res per-frame copies (resolve→
 *    history blit + depth→history-depth) and the separate resolve RT.
 * 4. Disocclusion handling folds into variance clipping (stock's previous-
 *    depth test + per-frame depth copy dropped — under motion the box is
 *    tight, γ 0.5..1, which bounds revealed-background ghosting to ~1 frame
 *    of tint; verified by pan shots + the temporal probe).
 *
 * Registered console knobs: traa_gammastill, traa_far0, traa_far1, traa_wmin.
 */

import { HalfFloatType, Matrix4, Vector2 } from 'three';
import type { PerspectiveCamera } from 'three';
import type { NodeBuilder, NodeFrame, Renderer, TextureNode } from 'three/webgpu';
import {
  NodeMaterial,
  NodeUpdateType,
  QuadMesh,
  RenderTarget,
  RendererUtils,
  TempNode,
} from 'three/webgpu';
import {
  Fn,
  If,
  add,
  clamp,
  convertToTexture,
  float,
  floor,
  ivec2,
  luminance,
  max,
  mix,
  passTexture,
  perspectiveDepthToViewZ,
  smoothstep,
  sqrt,
  texture,
  uniform,
  uv,
  vec2,
  vec4,
  velocity,
} from 'three/tsl';
import { tagGpu } from '../core/GpuProfiler';
import { numCvar } from '../debug/Console';
import type { NF, NV2, NV4 } from '../gpu/TSLTypes';

type RendererState = unknown;

interface VelocityLoader {
  load(texel: unknown): NV4;
}

interface RttLike {
  isRTTNode?: boolean;
  renderTarget?: RenderTarget;
  passNode?: { renderTarget: RenderTarget };
}

interface VelocityNodeLike {
  setProjectionMatrix(m: Matrix4 | null): void;
}

interface PipelineContext {
  context?: {
    renderPipeline?: {
      context: {
        onBeforeRenderPipeline?: () => void;
        onAfterRenderPipeline?: () => void;
      };
    };
    velocity?: VelocityNodeLike;
  };
  renderer: Renderer;
}

function halton(index: number, base: number): number {
  let fraction = 1;
  let result = 0;
  while (index > 0) {
    fraction /= base;
    result += fraction * (index % base);
    index = Math.floor(index / base);
  }
  return result;
}

/** EXACT stock sequence (TRAANode.js) — framealign comparability */
const HALTON_OFFSETS: readonly [number, number][] = Array.from(
  { length: 32 },
  (_, index) => [halton(index + 1, 2), halton(index + 1, 3)],
);

export class TraaResolveNode extends TempNode {
  private readonly beautyNode: TextureNode;
  private readonly depthNode: TextureNode;
  private readonly velocityLoader: VelocityLoader;
  private readonly camera: PerspectiveCamera;

  /** rest-state clip-box width on wind-static distant content */
  gammaStill = 3.0;
  /** distance band (m) over which rest-widening ramps in */
  far0 = 260;
  far1 = 440;
  /** minimum current-frame weight at far-rest (stock floor is 0.05) */
  wMin = 0.03;
  maxVelocityLength = 128;

  private readonly uGammaStill = uniform(3.0);
  private readonly uFar0 = uniform(260);
  private readonly uFar1 = uniform(440);
  private readonly uWMin = uniform(0.03);
  private readonly uCameraNearFar = uniform(new Vector2(0.3, 30000));

  private readonly history: [RenderTarget, RenderTarget];
  private read = 0;
  private readonly historyTexNode: TextureNode;
  private readonly resolveMaterial = new NodeMaterial();
  private readonly quad = new QuadMesh();
  private readonly textureNode: TextureNode;
  private readonly originalProjectionMatrix = new Matrix4();
  private jitterIndex = 0;
  private needsPostProcessingSync = false;
  private velocityNode: VelocityNodeLike | null = null;
  private rendererState: RendererState;

  constructor(
    beauty: unknown,
    depthNode: TextureNode,
    velocityLoader: VelocityLoader,
    camera: PerspectiveCamera,
  ) {
    super('vec4');
    this.updateBeforeType = NodeUpdateType.FRAME;
    this.beautyNode = convertToTexture(
      beauty as Parameters<typeof convertToTexture>[0],
    ) as unknown as TextureNode;
    this.depthNode = depthNode;
    this.velocityLoader = velocityLoader;
    this.camera = camera;

    const mk = (i: number): RenderTarget => {
      const rt = new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType });
      rt.texture.name = `traa.history${i}`;
      tagGpu(rt, 'traa.resolve');
      return rt;
    };
    this.history = [mk(0), mk(1)];
    this.historyTexNode = texture(this.history[0].texture) as unknown as TextureNode;
    this.textureNode = passTexture(
      this as unknown as Parameters<typeof passTexture>[0],
      this.history[1].texture,
    ) as unknown as TextureNode;
    this.resolveMaterial.name = 'TRAA.resolve';

    numCvar('traa_gammastill', 'TRAA rest-state clip width on far content (1=stock)',
      () => this.gammaStill, (n) => { this.gammaStill = n; }, 1, 8);
    numCvar('traa_far0', 'TRAA rest-widening ramp start (m)',
      () => this.far0, (n) => { this.far0 = n; }, 0, 5000);
    numCvar('traa_far1', 'TRAA rest-widening ramp full (m)',
      () => this.far1, (n) => { this.far1 = n; }, 0, 5000);
    numCvar('traa_wmin', 'TRAA min current-frame weight at far-rest',
      () => this.wMin, (n) => { this.wMin = n; }, 0.005, 0.2);
  }

  getTextureNode(): TextureNode {
    return this.textureNode;
  }

  private setViewOffset(width: number, height: number): void {
    // save the unjittered projection for the velocity pass (skyveldbg path)
    this.camera.updateProjectionMatrix();
    this.originalProjectionMatrix.copy(this.camera.projectionMatrix);
    this.velocityNode?.setProjectionMatrix(this.originalProjectionMatrix);

    const offset = HALTON_OFFSETS[this.jitterIndex] ?? [0.5, 0.5];
    this.camera.setViewOffset(
      width, height,
      offset[0] - 0.5, offset[1] - 0.5,
      width, height,
    );
  }

  private clearViewOffset(): void {
    this.camera.clearViewOffset();
    this.velocityNode?.setProjectionMatrix(null);
    this.jitterIndex++;
    this.jitterIndex = this.jitterIndex % (HALTON_OFFSETS.length - 1);
  }

  override updateBefore(frame: NodeFrame): boolean | undefined {
    const renderer = (frame as unknown as { renderer: Renderer }).renderer;

    this.uGammaStill.value = this.gammaStill;
    this.uFar0.value = this.far0;
    this.uFar1.value = this.far1;
    this.uWMin.value = this.wMin;
    this.uCameraNearFar.value.set(this.camera.near, this.camera.far);

    const rtt = this.beautyNode as unknown as RttLike;
    const beautyRT = rtt.isRTTNode === true ? rtt.renderTarget : rtt.passNode?.renderTarget;
    if (!beautyRT) throw new Error('TraaResolve: beauty node has no render target');
    const width = beautyRT.texture.width;
    const height = beautyRT.texture.height;

    if (this.needsPostProcessingSync) {
      this.setViewOffset(width, height);
      this.needsPostProcessingSync = false;
    }

    this.rendererState = RendererUtils.resetRendererState(
      renderer,
      this.rendererState as Parameters<typeof RendererUtils.resetRendererState>[1],
    );

    const h0 = this.history[0];
    const needsRestart = h0.width !== width || h0.height !== height;
    this.history[0].setSize(width, height);
    this.history[1].setSize(width, height);
    if (needsRestart) {
      // fresh history after resize: seed the READ target with the current
      // beauty so the first resolves don't fade up from black
      renderer.initRenderTarget(this.history[0]);
      renderer.initRenderTarget(this.history[1]);
      renderer.copyTextureToTexture(
        beautyRT.texture,
        (this.history[this.read] as RenderTarget).texture,
      );
    }

    const write = 1 - this.read;
    (this.historyTexNode as unknown as { value: unknown }).value =
      (this.history[this.read] as RenderTarget).texture;
    renderer.setRenderTarget(this.history[write] as RenderTarget);
    this.quad.material = this.resolveMaterial;
    this.quad.name = 'TRAA';
    this.quad.render(renderer);
    renderer.setRenderTarget(null);
    (this.textureNode as unknown as { value: unknown }).value =
      (this.history[write] as RenderTarget).texture;
    this.read = write;

    RendererUtils.restoreRendererState(
      renderer,
      this.rendererState as Parameters<typeof RendererUtils.restoreRendererState>[1],
    );
    return undefined;
  }

  override setup(builder: NodeBuilder): TextureNode {
    const ctx = builder as unknown as PipelineContext;
    const renderPipeline = ctx.context?.renderPipeline;
    if (renderPipeline) {
      this.needsPostProcessingSync = true;
      renderPipeline.context.onBeforeRenderPipeline = (): void => {
        const size = builder.renderer.getDrawingBufferSize(_size);
        this.setViewOffset(size.width, size.height);
      };
      renderPipeline.context.onAfterRenderPipeline = (): void => {
        this.clearViewOffset();
      };
    }
    this.velocityNode =
      ctx.context?.velocity ?? (velocity as unknown as VelocityNodeLike);

    const beautyNode = this.beautyNode;
    const depthNode = this.depthNode;
    const historyNode = this.historyTexNode;

    // playdead AABB clip, ported verbatim from stock
    const clipAABB = (
      currentColor: NV4, historyColor: NV4, minColor: NV4, maxColor: NV4,
    ): NV4 => {
      const pClip = maxColor.rgb.add(minColor.rgb).mul(0.5);
      const eClip = maxColor.rgb.sub(minColor.rgb).mul(0.5).add(1e-7);
      const vClip = historyColor.sub(vec4(pClip, currentColor.a));
      const vUnit = vClip.xyz.div(eClip);
      const absUnit = vUnit.abs();
      const maxUnit = max(absUnit.x, absUnit.y, absUnit.z);
      return maxUnit.greaterThan(1).select(
        vec4(pClip, currentColor.a).add(vClip.div(maxUnit)),
        historyColor,
      ) as unknown as NV4;
    };

    // Karis luminance-weighted blend (stock flickerReduction, verbatim)
    const lumBlend = (currentColor: NV4, historyColor: NV4, currentWeight: NF): NV4 => {
      const historyWeight = currentWeight.oneMinus().toVar();
      const cw = currentWeight.toVar();
      const compressedCurrent = currentColor.mul(
        float(1).div(max(currentColor.r, currentColor.g, currentColor.b).add(1)),
      );
      const compressedHistory = historyColor.mul(
        float(1).div(max(historyColor.r, historyColor.g, historyColor.b).add(1)),
      );
      cw.mulAssign(float(1).div(luminance(compressedCurrent.rgb).add(1)));
      historyWeight.mulAssign(float(1).div(luminance(compressedHistory.rgb).add(1)));
      return add(currentColor.mul(cw), historyColor.mul(historyWeight))
        .div(max(cw.add(historyWeight), 0.00001)) as unknown as NV4;
    };

    const resolve = Fn((): NV4 => {
      const uvNode = uv();
      const textureSize = (beautyNode as unknown as { size(): unknown }).size() as NV2;
      const sizeF = vec2(textureSize);
      const positionTexel = uvNode.mul(sizeF);

      // ONE fused 3×3 loop: color moments + min/max depth dilation
      const closestDepth = float(2).toVar();
      const closestPositionTexel = vec2(0, 0).toVar();
      const currentColor = (beautyNode.load(
        positionTexel as unknown as Parameters<TextureNode['load']>[0],
      ) as unknown as NV4).max(0).toVar();
      const moment1 = currentColor.toVar();
      const moment2 = currentColor.pow2().toVar();
      for (let x = -1; x <= 1; x++) {
        for (let y = -1; y <= 1; y++) {
          const neighbor = positionTexel.add(vec2(x, y)).toVar();
          const depth = (depthNode.load(
            neighbor as unknown as Parameters<TextureNode['load']>[0],
          ) as unknown as NV4).r.toVar();
          If(depth.lessThan(closestDepth), () => {
            closestDepth.assign(depth);
            closestPositionTexel.assign(neighbor);
          });
          if (x !== 0 || y !== 0) {
            // max() prevents NaN propagation (stock)
            const c = ((beautyNode as unknown as {
              offset(o: unknown): { load(p: unknown): unknown };
            })
              .offset(ivec2(x, y))
              .load(positionTexel) as NV4)
              .max(0);
            moment1.addAssign(c);
            moment2.addAssign(c.pow2());
          }
        }
      }

      // velocity at the closest-depth texel (silhouette dilation), NDC→UV
      const offsetUV = (this.velocityLoader.load(closestPositionTexel) as unknown as NV4)
        .xy.mul(vec2(0.5, -0.5)).toVar();
      const historyUV = uvNode.sub(offsetUV);
      const isValidUV = historyUV.x.greaterThanEqual(0)
        .and(historyUV.y.greaterThanEqual(0))
        .and(historyUV.x.lessThanEqual(1))
        .and(historyUV.y.lessThanEqual(1));

      // Catmull-Rom history (5-tap renormalized cross) — exact center tap
      // at rest, recovers bilinear-resample HF loss under motion
      const samplePos = historyUV.mul(sizeF);
      const texPos1 = floor(samplePos.sub(0.5)).add(0.5);
      const f = samplePos.sub(texPos1);
      const f2 = f.mul(f);
      const f3 = f2.mul(f);
      const w0 = f2.sub(f3.mul(0.5)).sub(f.mul(0.5));
      const w1 = f3.mul(1.5).sub(f2.mul(2.5)).add(1);
      const w2 = f2.mul(2).sub(f3.mul(1.5)).add(f.mul(0.5));
      const w3 = f3.mul(0.5).sub(f2.mul(0.5));
      const w12 = w1.add(w2);
      const off12 = w2.div(w12);
      const tp0 = texPos1.sub(1).div(sizeF);
      const tp3 = texPos1.add(2).div(sizeF);
      const tp12 = texPos1.add(off12).div(sizeF);
      const hSample = (u: NV2, w: NF): NV4 =>
        (historyNode.sample(u as unknown as Parameters<TextureNode['sample']>[0]) as unknown as NV4)
          .mul(w) as unknown as NV4;
      const crSum = hSample(vec2(tp12.x, tp0.y), w12.x.mul(w0.y))
        .add(hSample(vec2(tp0.x, tp12.y), w0.x.mul(w12.y)))
        .add(hSample(vec2(tp12.x, tp12.y), w12.x.mul(w12.y)))
        .add(hSample(vec2(tp3.x, tp12.y), w3.x.mul(w12.y)))
        .add(hSample(vec2(tp12.x, tp3.y), w12.x.mul(w3.y)));
      const crW = w12.x.mul(w0.y)
        .add(w0.x.mul(w12.y))
        .add(w12.x.mul(w12.y))
        .add(w3.x.mul(w12.y))
        .add(w12.x.mul(w3.y));
      const historyColor = crSum.div(crW).max(0).toVar();

      // motion metrics
      const velPx = offsetUV.mul(sizeF).length().toVar();
      const motionFactor = velPx.div(this.maxVelocityLength).saturate();
      // low-motion detector × wind-static distance gate: widening only
      // applies where nothing self-moves (wind fades by ~440 m; water calms
      // too). The ramp reaches ~4 px/frame because far content under slow
      // pan/flight reprojects exactly (no parallax, no disocclusion) — a
      // 0.5 px rest-only gate left flythrough-speed shimmer at stock level
      // (probe: flyspeed pan 3.81 ≈ stock 3.94).
      const stillness = velPx.div(4).saturate().oneMinus();
      const dist = perspectiveDepthToViewZ(
        closestDepth,
        this.uCameraNearFar.x as unknown as NF,
        this.uCameraNearFar.y as unknown as NF,
      ).negate();
      const farK = smoothstep(
        this.uFar0 as unknown as NF,
        this.uFar1 as unknown as NF,
        dist as unknown as NF,
      );
      const widen = stillness.pow2().mul(farK).toVar();

      // subpixel correction (stock): raise current weight when the velocity
      // is mid-texel — reduces blur under motion
      const phase = offsetUV.mul(sizeF).fract().abs();
      const subW = max(phase, phase.oneMinus());
      const subpixel = subW.x.mul(subW.y).oneMinus().div(0.75);

      const currentWeight = float(0.05).add(subpixel.mul(0.25)).toVar();
      currentWeight.assign(mix(currentWeight, this.uWMin as unknown as NF, widen));
      currentWeight.assign(
        isValidUV.select(currentWeight.add(motionFactor).saturate(), float(1)),
      );

      // variance clip: stock gamma under motion, widened at far-rest
      const N = float(9);
      const mean = moment1.div(N);
      const sigma = sqrt(
        moment2.div(N).sub(mean.pow2()).max(0) as unknown as NF,
      ) as unknown as NV4;
      const gammaBase = mix(0.5, 1, motionFactor.oneMinus().pow2());
      const gamma = gammaBase.add(
        (this.uGammaStill as unknown as NF).sub(1).mul(widen),
      );
      const minColor = mean.sub(sigma.mul(gamma)) as unknown as NV4;
      const maxColor = mean.add(sigma.mul(gamma)) as unknown as NV4;
      const clipped = clipAABB(
        clamp(mean, minColor, maxColor) as unknown as NV4,
        historyColor,
        minColor,
        maxColor,
      );

      return lumBlend(currentColor, clipped, currentWeight as unknown as NF);
    });

    this.resolveMaterial.colorNode = resolve();
    this.resolveMaterial.needsUpdate = true;

    return this.textureNode;
  }

  override dispose(): void {
    this.history[0].dispose();
    this.history[1].dispose();
    this.resolveMaterial.dispose();
  }
}

export function traaResolve(
  beauty: unknown,
  depthNode: TextureNode,
  velocityLoader: VelocityLoader,
  camera: PerspectiveCamera,
): TraaResolveNode {
  return new TraaResolveNode(beauty, depthNode, velocityLoader, camera);
}

const _size = new Vector2();
