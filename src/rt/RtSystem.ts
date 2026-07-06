/**
 * RT-0 system — owns the BVH, the rt_debug ray-cast view and the Mrays/s
 * benchmark (v3 §7). Lazy: constructing this costs nothing; the BVH builds
 * on first use (rt_debug view, `rt build`, or a bench call) from a one-time
 * readback of the tree scatter buffers. Base-tier pixels are untouched
 * unless ?view=rt is up (PostStack then displays the debug texture).
 *
 * Console: `rt build|stats|bench [mode]`, cvar rt_debug (1 hit-shade,
 * 2 BVH heatmap, 3 prim kind). Tooling: __laasDbg.rt.bench(mode) → JSON row.
 */

import { Matrix4, Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import type { Renderer, StorageBufferNode } from 'three/webgpu';
import { StorageTexture } from 'three/webgpu';
import {
  Fn,
  If,
  Return,
  atomicAdd,
  atomicStore,
  float,
  instanceIndex,
  instancedArray,
  ivec2,
  mix,
  textureStore,
  uint,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import type { NB, NF, NU, NV3, NV4 } from '../gpu/TSLTypes';
import type { Heightfield } from '../world/Heightfield';
import type { ScatterLayer } from '../gpu/passes/Scatter';
import { buildRtBvh, type RtBvhBuffers } from './RtBvh';
import { rtNormalFn, rtTraceFn } from './RtTrace';
import { numCvar, registerCommand } from '../debug/Console';
import { sunU } from '../render/VegMaterials';

export type RtBenchMode = 'primary' | 'shadow' | 'reflect' | 'ao' | 'incoh';
export const RT_BENCH_MODES: RtBenchMode[] = ['primary', 'shadow', 'reflect', 'ao', 'incoh'];

export interface RtBenchRow {
  mode: RtBenchMode;
  w: number;
  h: number;
  /** rays actually traced (secondary modes trace only primary-hit lanes) */
  rays: number;
  msMed: number;
  msMin: number;
  mrays: number;
}

interface KernelRec {
  kernel: Parameters<Renderer['compute']>[0];
  w: number;
  h: number;
}

interface SetupState {
  w: number;
  h: number;
  hitPos: StorageBufferNode<'vec4'>;
  /** xyz = geometric normal, w = hit t */
  hitNrm: StorageBufferNode<'vec4'>;
  kernel: Parameters<Renderer['compute']>[0];
  countKernel: Parameters<Renderer['compute']>[0];
  counter: ReturnType<StorageBufferNode<'uint'>['toAtomic']>;
  /** primary-hit lane count from the LAST dispatch */
  hits: number;
}

/** per-class mean pool height (m at scale 1) for proxy sizing */
export interface RtPoolDims {
  heights: number[];
}

const TMAX = 8000;
const SINK = 8192;

type Mat4Mul = { mul: (v: NV4) => NV4 };

export class RtSystem {
  private bvh: RtBvhBuffers | null = null;
  private buildPromise: Promise<RtBvhBuffers> | null = null;
  debugTex: StorageTexture | null = null;
  private debugKernel: KernelRec | null = null;
  private benchKernels = new Map<string, KernelRec>();
  private setup: SetupState | null = null;

  /** rt_debug mode: 1 hit-shade, 2 BVH heatmap, 3 prim kind */
  readonly uMode = uniform(1);
  private uCamPos = uniform(new Vector3());
  private uProjInv = uniform(new Matrix4());
  private uCamWorld = uniform(new Matrix4());
  /** racy sink — forces traversal results to be observable (no dead-code);
   * also the per-dispatch completion fence (32 KB readback) */
  private sink = instancedArray(SINK, 'float');

  constructor(
    private hf: Heightfield,
    private trees: ScatterLayer,
    private poolDims: RtPoolDims | null,
    private stats: { counters: Record<string, number> },
    /** engine frame-loop hold — scene frames otherwise interleave with the
     * timed dispatches and dominate the wall clock (~40 ms/frame at native) */
    private holdCtl: { set(on: boolean): void } | null = null,
  ) {}

  /** one-time CPU topology build from instance readbacks (idempotent) */
  build(renderer: Renderer): Promise<RtBvhBuffers> {
    if (this.buildPromise) return this.buildPromise;
    this.buildPromise = (async () => {
      const [abA, abB] = await Promise.all([
        renderer.getArrayBufferAsync(this.trees.bufA.value),
        renderer.getArrayBufferAsync(this.trees.bufB.value),
      ]);
      const bvh = buildRtBvh(
        this.hf,
        new Float32Array(abA),
        new Float32Array(abB),
        this.trees.count,
        this.poolDims ?? undefined,
      );
      if (bvh.maxDepth >= 64) {
        throw new Error(`RtBvh: depth ${bvh.maxDepth} exceeds the 64-slot traversal stack`);
      }
      this.bvh = bvh;
      this.stats.counters['rt.nodes'] = bvh.nodeCount;
      this.stats.counters['rt.prims'] = bvh.primCount;
      this.stats.counters['rt.buildMs'] = Math.round(bvh.buildMs);
      return bvh;
    })();
    return this.buildPromise;
  }

  get built(): boolean {
    return this.bvh !== null;
  }

  statsLine(): string {
    const b = this.bvh;
    if (!b) return 'rt: BVH not built (run `rt build`)';
    return (
      `rt: ${b.nodeCount} nodes / ${b.primCount} prims ` +
      `(${b.tileCount} terrain tiles + ${b.treeCount} tree proxies), ` +
      `depth ${b.maxDepth}, built in ${b.buildMs.toFixed(0)} ms CPU`
    );
  }

  /** camera uniforms for ray-gen kernels (call right before dispatch) */
  private syncCamera(camera: PerspectiveCamera): void {
    camera.updateMatrixWorld();
    this.uCamPos.value.copy(camera.position);
    this.uProjInv.value.copy(camera.projectionMatrixInverse);
    this.uCamWorld.value.copy(camera.matrixWorld);
  }

  /** primary ray dir through pixel (px,py) of a w×h grid (classic depth) */
  private rayDir(px: NF, py: NF, w: number, h: number): NV3 {
    const ndcX = px.add(0.5).div(w).mul(2).sub(1);
    const ndcY = py.add(0.5).div(h).mul(2).sub(1).negate();
    const clip = vec4(ndcX, ndcY, 0.5, 1);
    const vpos = (this.uProjInv as unknown as Mat4Mul).mul(clip);
    const vdir = vpos.xyz.div(vpos.w);
    const wdir = (this.uCamWorld as unknown as Mat4Mul).mul(vec4(vdir, 0));
    return wdir.xyz.normalize();
  }

  private trace(bvh: RtBvhBuffers, ro: NV3, rd: NV3, tmax: NF, anyHit: number): NV4 {
    return rtTraceFn({
      nodes: bvh.nodes,
      pidx: bvh.primIdx,
      pa: bvh.primA,
      pb: bvh.primB,
      hb: this.hf.height,
      ro,
      rd,
      tmax0: tmax,
      tileCount: uint(bvh.tileCount),
      res: float(this.hf.res),
      anyHit: uint(anyHit),
    }) as NV4;
  }

  private normalAt(bvh: RtBvhBuffers, oi: NU, p: NV3): NV3 {
    return rtNormalFn({
      pa: bvh.primA,
      pb: bvh.primB,
      hb: this.hf.height,
      oi,
      tileCount: uint(bvh.tileCount),
      res: float(this.hf.res),
      p,
    }) as NV3;
  }

  // ---- rt_debug view --------------------------------------------------

  ensureDebugTex(w: number, h: number): StorageTexture {
    const im = this.debugTex?.image as { width: number; height: number } | undefined;
    if (this.debugTex && im && im.width === w && im.height === h) {
      return this.debugTex;
    }
    const t = new StorageTexture(w, h);
    t.generateMipmaps = false;
    this.debugTex = t;
    this.debugKernel = null;
    return t;
  }

  /** dispatch the debug ray-cast for the current camera (engine.onUpdate) */
  tickDebug(renderer: Renderer, camera: PerspectiveCamera): void {
    const bvh = this.bvh;
    const tex = this.debugTex;
    if (!tex) return;
    if (!bvh) {
      void this.build(renderer);
      return;
    }
    const im = tex.image as { width: number; height: number };
    const w = im.width;
    const h = im.height;
    if (!this.debugKernel) {
      const kernel = Fn(() => {
        const i = instanceIndex;
        If(i.greaterThanEqual(uint(w * h)), () => {
          Return();
        });
        const px = float(i.mod(uint(w)));
        const py = float(i.div(uint(w)));
        const ro = vec3(this.uCamPos);
        const rd = this.rayDir(px, py, w, h);
        const res = this.trace(bvh, ro, rd, float(TMAX), 0);
        const t = res.x;
        const hit = (t.greaterThan(0) as NB).toVar();
        // mode 2: BVH heatmap — node iterations, dark→green→yellow→red
        const heat = res.z.div(160);
        const heatCol = vec3(
          heat.smoothstep(0.5, 1.0),
          heat.smoothstep(0.0, 0.5).sub(heat.smoothstep(1.0, 1.5).mul(0.6)),
          heat.smoothstep(1.2, 2.0),
        );
        // mode 1: hit shade — n·sun on a kind-tinted albedo, distance-fogged
        const sky = vec3(0.55, 0.68, 0.85);
        const p = ro.add(rd.mul(t));
        const n = this.normalAt(bvh, uint(res.y.max(0)), p);
        const isTree = res.y.greaterThanEqual(bvh.tileCount) as NB;
        const albedo = isTree.select(vec3(0.16, 0.34, 0.12), vec3(0.42, 0.38, 0.33));
        const ndl = n.dot(vec3(sunU.dir)).max(0).mul(0.85).add(0.15);
        const fogK = t.div(TMAX).pow(0.7).min(1);
        const shade = mix(albedo.mul(ndl), sky, fogK);
        const lit = hit.select(shade, sky);
        // mode 3: prim kind — terrain gray / tree green / miss blue
        const kind = hit.select(
          isTree.select(vec3(0.1, 0.8, 0.2), vec3(0.6, 0.6, 0.6)),
          vec3(0.1, 0.15, 0.6),
        );
        const m = this.uMode;
        const col = m
          .greaterThan(2.5)
          .select(kind, m.greaterThan(1.5).select(heatCol, lit));
        textureStore(tex, ivec2(px.toInt(), py.toInt()), vec4(col, 1)).toWriteOnly();
      })().compute(w * h, [64]);
      (kernel as { setName?: (n: string) => void }).setName?.('rtDebug');
      this.debugKernel = { kernel: kernel as KernelRec['kernel'], w, h };
    }
    this.syncCamera(camera);
    renderer.compute(this.debugKernel.kernel);
  }

  // ---- benchmark -------------------------------------------------------

  /**
   * Half-res primary pre-pass for the secondary-ray modes: stores hit
   * position (w = hit flag) and normal + t per lane. Untimed; re-dispatched
   * every bench call so hit points track the current camera.
   */
  private async runSetup(renderer: Renderer, w: number, h: number): Promise<void> {
    const bvh = this.bvh;
    if (!bvh) throw new Error('rt: bench before build');
    if (!this.setup || this.setup.w !== w || this.setup.h !== h) {
      this.benchKernels.clear(); // secondary kernels bake the setup buffers in
      const hitPos = instancedArray(w * h, 'vec4');
      const hitNrm = instancedArray(w * h, 'vec4');
      const counter = instancedArray(1, 'uint').toAtomic();
      const kernel = Fn(() => {
        const i = instanceIndex;
        If(i.greaterThanEqual(uint(w * h)), () => {
          Return();
        });
        const px = float(i.mod(uint(w)));
        const py = float(i.div(uint(w)));
        const ro = vec3(this.uCamPos);
        const rd = this.rayDir(px, py, w, h);
        const res = this.trace(bvh, ro, rd, float(TMAX), 0);
        const hit = res.x.greaterThan(0) as NB;
        const p = ro.add(rd.mul(res.x));
        const n = this.normalAt(bvh, uint(res.y.max(0)), p);
        hitPos.element(i).assign(vec4(p, hit.select(float(1), float(0))));
        hitNrm.element(i).assign(vec4(n, res.x));
        If(hit, () => {
          atomicAdd(counter.element(0), uint(1));
        });
      })().compute(w * h, [64]);
      (kernel as { setName?: (n: string) => void }).setName?.('rtBenchSetup');
      const countKernel = Fn(() => {
        If(instanceIndex.equal(uint(0)), () => {
          // clear the hit counter before each setup pass
          atomicStore(counter.element(0), uint(0));
        });
      })().compute(1);
      this.setup = {
        w,
        h,
        hitPos,
        hitNrm,
        kernel: kernel as KernelRec['kernel'],
        countKernel: countKernel as KernelRec['kernel'],
        counter,
        hits: 0,
      };
    }
    const s = this.setup;
    await renderer.computeAsync(s.countKernel);
    await renderer.computeAsync(s.kernel);
    const ab = await renderer.getArrayBufferAsync(s.counter.value);
    s.hits = new Uint32Array(ab)[0] ?? 0;
  }

  private buildBenchKernel(mode: RtBenchMode, w: number, h: number): KernelRec {
    const bvh = this.bvh;
    if (!bvh) throw new Error('rt: bench before build');
    const key = `${mode}:${w}x${h}`;
    const cached = this.benchKernels.get(key);
    if (cached) return cached;
    const sink = this.sink;
    const setup = this.setup;
    const kernel = Fn(() => {
      const i = instanceIndex;
      If(i.greaterThanEqual(uint(w * h)), () => {
        Return();
      });
      let out: NV4;
      if (mode === 'primary') {
        const px = float(i.mod(uint(w)));
        const py = float(i.div(uint(w)));
        const ro = vec3(this.uCamPos);
        const rd = this.rayDir(px, py, w, h);
        out = this.trace(bvh, ro, rd, float(TMAX), 0);
      } else {
        if (!setup) throw new Error('rt: secondary bench mode without setup');
        const lane = setup.hitPos.element(i);
        If(lane.w.lessThan(0.5), () => {
          Return();
        });
        const n = setup.hitNrm.element(i).xyz;
        const p = lane.xyz.add(n.mul(0.05));
        let rd: NV3;
        let tmax = float(TMAX);
        let anyHit = 1;
        if (mode === 'shadow') {
          rd = vec3(sunU.dir).normalize();
        } else if (mode === 'reflect') {
          const inc = lane.xyz.sub(vec3(this.uCamPos)).normalize();
          rd = inc.sub(n.mul(inc.dot(n).mul(2))).normalize();
          anyHit = 0;
        } else {
          // hash-seeded dir per lane; ao = hemisphere around n (short rays),
          // incoh = full sphere at TMAX (worst-case incoherence)
          const s0 = i.mul(uint(747796405)).add(uint(2891336453));
          const s1 = s0.shiftRight(uint(13)).bitXor(s0).mul(uint(1274126177));
          const a = float(s1.bitAnd(uint(1023))).div(1023).mul(6.28318);
          const z = float(s1.shiftRight(uint(10)).bitAnd(uint(1023))).div(1023).mul(2).sub(1);
          const r = z.mul(z).oneMinus().max(1e-4).sqrt();
          const sph = vec3(r.mul(a.cos()), z, r.mul(a.sin()));
          if (mode === 'ao') {
            rd = sph.add(n).normalize();
            tmax = float(50);
          } else {
            rd = sph;
            anyHit = 0;
          }
        }
        out = this.trace(bvh, p, rd, tmax, anyHit);
      }
      sink.element(i.bitAnd(uint(SINK - 1))).assign(out.x.add(out.z.mul(1e-5)));
    })().compute(w * h, [64]);
    (kernel as { setName?: (n: string) => void }).setName?.(`rtBench_${mode}`);
    const rec = { kernel: kernel as KernelRec['kernel'], w, h };
    this.benchKernels.set(key, rec);
    return rec;
  }

  /**
   * Timed benchmark. Each SAMPLE enqueues `batch` dispatches back-to-back
   * (synchronously — nothing else can slot into the queue between them) and
   * fences once with the 32 KB sink readback; ms = wall/batch. The engine
   * frame loop is held for the whole timed section so scene renders don't
   * serialize against the compute queue. Median + min across samples.
   */
  async bench(
    renderer: Renderer,
    camera: PerspectiveCamera,
    mode: RtBenchMode,
    opts?: { w?: number; h?: number; runs?: number; batch?: number },
  ): Promise<RtBenchRow> {
    await this.build(renderer);
    const canvas = renderer.domElement as HTMLCanvasElement;
    const full = mode === 'primary';
    const dw = opts?.w ?? canvas.width;
    const dh = opts?.h ?? canvas.height;
    const w = full ? dw : Math.floor(dw / 2);
    const h = full ? dh : Math.floor(dh / 2);
    this.syncCamera(camera);
    const samples = opts?.runs ?? 8;
    const batch = opts?.batch ?? 8;
    const times: number[] = [];
    this.holdCtl?.set(true);
    try {
      if (!full) await this.runSetup(renderer, w, h);
      const rec = this.buildBenchKernel(mode, w, h);
      for (let k = 0; k < 1 + samples; k++) {
        const t0 = performance.now();
        for (let j = 0; j < batch; j++) renderer.compute(rec.kernel);
        await renderer.getArrayBufferAsync(this.sink.value);
        const ms = (performance.now() - t0) / batch;
        if (k >= 1) times.push(ms); // sample 0 = warmup (pipeline compile)
      }
    } finally {
      this.holdCtl?.set(false);
    }
    times.sort((a, b) => a - b);
    const msMed = times[times.length >> 1] ?? 0;
    const msMin = times[0] ?? 0;
    const rays = full ? w * h : this.setup?.hits ?? 0;
    return { mode, w, h, rays, msMed, msMin, mrays: rays / (msMed * 1000) };
  }
}

// ?view=rt display — module context so PostStack (built later in boot) can
// pick the debug texture up without a hard dependency, same pattern as
// setCausticContext / setWindContext
let rtViewTex: StorageTexture | null = null;
export function setRtViewTexture(t: StorageTexture | null): void {
  rtViewTex = t;
}
export function getRtViewTexture(): StorageTexture | null {
  return rtViewTex;
}

/** console + __laasDbg wiring (called once from TerrainScene) */
export function registerRtConsole(
  rt: RtSystem,
  renderer: Renderer,
  camera: PerspectiveCamera,
): void {
  numCvar(
    'rt_debug',
    'rt debug view mode: 1 hit shade, 2 BVH heatmap, 3 prim kind (needs ?view=rt)',
    () => rt.uMode.value as number,
    (n) => {
      rt.uMode.value = Math.round(n);
    },
    1,
    3,
  );
  registerCommand({
    name: 'rt',
    help: 'ray tracing: `rt build` | `rt stats` | `rt bench [mode|all]` (modes: primary shadow reflect ao incoh)',
    complete: () => ['build', 'stats', 'bench', ...RT_BENCH_MODES],
    run: (args, con) => {
      const sub = args[0] ?? 'stats';
      if (sub === 'stats') {
        con.print(rt.statsLine(), 'dim');
        return;
      }
      if (sub === 'build') {
        void rt.build(renderer).then(
          () => con.print(rt.statsLine()),
          (e: unknown) => con.print(`rt build failed: ${String(e)}`, 'err'),
        );
        con.print('rt: building BVH…', 'dim');
        return;
      }
      if (sub === 'bench') {
        const which =
          args[1] === undefined || args[1] === 'all'
            ? RT_BENCH_MODES
            : [args[1] as RtBenchMode];
        void (async () => {
          for (const m of which) {
            if (!RT_BENCH_MODES.includes(m)) {
              con.print(`rt: unknown mode '${m}'`, 'err');
              continue;
            }
            const r = await rt.bench(renderer, camera, m);
            con.print(
              `rt ${r.mode.padEnd(7)} ${r.w}x${r.h} rays=${r.rays} ` +
                `med=${r.msMed.toFixed(2)}ms min=${r.msMin.toFixed(2)}ms ` +
                `→ ${r.mrays.toFixed(0)} Mrays/s`,
            );
          }
        })().catch(() => undefined);
        con.print('rt: benching…', 'dim');
        return;
      }
      con.print('usage: rt build|stats|bench [mode|all]', 'err');
    },
  });
}
