/**
 * RT-0 (v3 §7): BVH over terrain tiles + static tree proxies.
 *
 * Topology is built on the CPU at first use (one-time; the scene is fully
 * static — wind is handled by proxy inflation, not refit; see DEVIATIONS
 * D-6) from a one-time readback of the scatter instance buffers plus the
 * resident cpuHeights mirror. Traversal runs in raw WGSL compute (RtTrace).
 *
 * Primitive model:
 *  - terrain: res/TILE × res/TILE tiles, AABB from the tile's height range;
 *    a leaf hit ray-marches the heightfield inside the tile span.
 *  - tree: trunk capsule + crown ellipsoid derived per class from the
 *    instance scale (crown radii mirror the canopy-map table; crownRxz is
 *    inflated ×1.04 so wind sway stays inside the proxy).
 *
 * Buffer layout (all f32 indices — counts < 2^24, exact):
 *  - nodes: 2×vec4 per node. [minX,minY,minZ,a] [maxX,maxY,maxZ,count]
 *    count==0 → interior, a = left child (right = a+1); count>0 → leaf,
 *    a = first slot in primIdx.
 *  - primIdx: leaf-ordered permutation → ORIGINAL prim index. Original
 *    order is [0..tileCount) terrain tiles then trees, so a prim's type is
 *    just `origIdx < tileCount` (no tag bits).
 *  - primA/primB: per-prim data in ORIGINAL order.
 *    terrain: A=(wx0, wz0, wx1, wz1) B=(minY, maxY, 0, 0)
 *    tree:    A=(x, baseY, z, trunkR) B=(trunkH, crownCy, crownRxz, crownRy)
 */

import type { StorageBufferNode } from 'three/webgpu';
import { instancedArray } from 'three/tsl';
import type { Heightfield } from '../world/Heightfield';
import { WORLD_SIZE } from '../world/WorldConst';

/** terrain tile edge in texels (32 → 128×128 tiles at HEIGHT_RES 4096) */
export const RT_TILE = 32;
/** max prims per leaf */
const LEAF_MAX = 4;
/** SAH bins */
const BINS = 16;

/** crown radius (m at scale 1) by tree class — mirrors buildCanopyMap */
const CROWN_R = [2.9, 2.7, 3.8, 2.7, 3.2, 0.9];
/** fallback tree height (m at scale 1) by class; overridden by pool dims */
const TREE_H = [17, 15, 14, 11, 9, 8];
/** wind sway stays inside the proxy (v3 §7 RT-0: proxy inflation) */
const WIND_INFLATE = 1.04;

export interface RtBvhBuffers {
  nodes: StorageBufferNode<'vec4'>;
  primIdx: StorageBufferNode<'uint'>;
  primA: StorageBufferNode<'vec4'>;
  primB: StorageBufferNode<'vec4'>;
  nodeCount: number;
  primCount: number;
  tileCount: number;
  treeCount: number;
  buildMs: number;
  /** max leaf depth reached (traversal stack sizing sanity — must be <64) */
  maxDepth: number;
}

/** per-class proxy dims at instance scale 1 (heights may come from pools) */
export interface TreeProxyDims {
  heights: number[];
}

/** CPU-side prim soup for the builder */
interface PrimSoup {
  n: number;
  minx: Float32Array;
  miny: Float32Array;
  minz: Float32Array;
  maxx: Float32Array;
  maxy: Float32Array;
  maxz: Float32Array;
  cx: Float32Array;
  cy: Float32Array;
  cz: Float32Array;
}

function makeSoup(n: number): PrimSoup {
  return {
    n,
    minx: new Float32Array(n),
    miny: new Float32Array(n),
    minz: new Float32Array(n),
    maxx: new Float32Array(n),
    maxy: new Float32Array(n),
    maxz: new Float32Array(n),
    cx: new Float32Array(n),
    cy: new Float32Array(n),
    cz: new Float32Array(n),
  };
}

/**
 * Build the BVH from the heightfield CPU mirror + a tree-instance readback.
 *
 * @param treesAB raw readbacks of the scatter trees bufA/bufB (vec4 f32)
 * @param treeCount live instance count (scatter counter readback)
 */
export function buildRtBvh(
  hf: Heightfield,
  treesA: Float32Array,
  treesB: Float32Array,
  treeCount: number,
  dims?: TreeProxyDims,
): RtBvhBuffers {
  const t0 = performance.now();
  const heights = hf.cpuHeights;
  if (!heights) throw new Error('RtBvh: cpuHeights not resident');
  const res = hf.res;
  const nt = Math.floor(res / RT_TILE);
  const tileCount = nt * nt;
  const primCount = tileCount + treeCount;
  const soup = makeSoup(primCount);
  const primA = new Float32Array(primCount * 4);
  const primB = new Float32Array(primCount * 4);
  const texel = WORLD_SIZE / res;

  // --- terrain tiles: min/max over TILE+1 texels (bilinear shares edges);
  // world rect padded half a texel to cover the sampler's -0.5 shift
  for (let ty = 0; ty < nt; ty++) {
    for (let tx = 0; tx < nt; tx++) {
      let mn = Infinity;
      let mx = -Infinity;
      const x1 = Math.min(tx * RT_TILE + RT_TILE, res - 1);
      const y1 = Math.min(ty * RT_TILE + RT_TILE, res - 1);
      for (let y = ty * RT_TILE; y <= y1; y++) {
        const row = y * res;
        for (let x = tx * RT_TILE; x <= x1; x++) {
          const h = heights[row + x];
          if (h < mn) mn = h;
          if (h > mx) mx = h;
        }
      }
      const wx0 = (tx * RT_TILE / res - 0.5) * WORLD_SIZE - texel * 0.5;
      const wz0 = (ty * RT_TILE / res - 0.5) * WORLD_SIZE - texel * 0.5;
      const wx1 = wx0 + RT_TILE * texel + texel;
      const wz1 = wz0 + RT_TILE * texel + texel;
      const i = ty * nt + tx;
      soup.minx[i] = wx0;
      soup.miny[i] = mn;
      soup.minz[i] = wz0;
      soup.maxx[i] = wx1;
      soup.maxy[i] = mx;
      soup.maxz[i] = wz1;
      soup.cx[i] = (wx0 + wx1) * 0.5;
      soup.cy[i] = (mn + mx) * 0.5;
      soup.cz[i] = (wz0 + wz1) * 0.5;
      primA[i * 4] = wx0;
      primA[i * 4 + 1] = wz0;
      primA[i * 4 + 2] = wx1;
      primA[i * 4 + 3] = wz1;
      primB[i * 4] = mn;
      primB[i * 4 + 1] = mx;
    }
  }

  // --- tree proxies
  const hTab = dims?.heights ?? TREE_H;
  for (let k = 0; k < treeCount; k++) {
    const x = treesA[k * 4];
    const y = treesA[k * 4 + 1];
    const z = treesA[k * 4 + 2];
    const s = treesA[k * 4 + 3];
    const idF = treesB[k * 4 + 3];
    const cls = Math.min(5, Math.max(0, Math.floor(idF / 8)));
    const H = (hTab[cls] ?? 14) * s;
    const crownRxz =
      Math.min(11, Math.max(1, (CROWN_R[cls] ?? 2.8) * s)) * WIND_INFLATE;
    const isSnag = cls === 5;
    const trunkR = Math.max(0.06, 0.022 * H);
    const trunkH = isSnag ? 0.9 * H : 0.55 * H;
    const crownCy = isSnag ? 0.75 * H : 0.62 * H;
    const crownRy = isSnag ? 0.2 * H : 0.42 * H;
    const i = tileCount + k;
    const rxz = Math.max(trunkR, isSnag ? Math.min(crownRxz, 1.2 * s) : crownRxz);
    soup.minx[i] = x - rxz;
    soup.miny[i] = y - 0.5;
    soup.minz[i] = z - rxz;
    soup.maxx[i] = x + rxz;
    soup.maxy[i] = y + Math.max(trunkH + trunkR, crownCy + crownRy);
    soup.maxz[i] = z + rxz;
    soup.cx[i] = x;
    soup.cy[i] = y + crownCy * 0.5;
    soup.cz[i] = z;
    primA[i * 4] = x;
    primA[i * 4 + 1] = y;
    primA[i * 4 + 2] = z;
    primA[i * 4 + 3] = trunkR;
    primB[i * 4] = trunkH;
    primB[i * 4 + 1] = crownCy;
    primB[i * 4 + 2] = isSnag ? Math.min(crownRxz, 1.2 * s) : crownRxz;
    primB[i * 4 + 3] = crownRy;
  }

  const { nodes, order, nodeCount, maxDepth } = buildTopology(soup);

  const buildMs = performance.now() - t0;
  return {
    nodes: instancedArray(nodes.subarray(0, nodeCount * 8), 'vec4'),
    primIdx: instancedArray(order, 'uint'),
    primA: instancedArray(primA, 'vec4'),
    primB: instancedArray(primB, 'vec4'),
    nodeCount,
    primCount,
    tileCount,
    treeCount,
    buildMs,
    maxDepth,
  };
}

/** binned-SAH top-down build over the prim soup (median-split fallback) */
function buildTopology(soup: PrimSoup): {
  nodes: Float32Array;
  order: Uint32Array;
  nodeCount: number;
  maxDepth: number;
} {
  const n = soup.n;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  // ≤ 2n-1 nodes for a binary tree with ≥1 prim per leaf; children are
  // allocated in pairs so the bound holds
  const nodes = new Float32Array((2 * n) * 8);
  let nextFree = 1;
  let maxDepth = 0;

  // explicit stack: [nodeSlot, start, end, depth]
  const stack: number[] = [0, 0, n, 1];
  const binMin = new Float32Array(BINS);
  const binMax = new Float32Array(BINS);
  const binMinY = new Float32Array(BINS);
  const binMaxY = new Float32Array(BINS);
  const binMinZ = new Float32Array(BINS);
  const binMaxZ = new Float32Array(BINS);
  const binCnt = new Uint32Array(BINS);

  while (stack.length > 0) {
    const depth = stack.pop() as number;
    const end = stack.pop() as number;
    const start = stack.pop() as number;
    const slot = stack.pop() as number;
    if (depth > maxDepth) maxDepth = depth;
    const count = end - start;

    // node AABB + centroid bounds over the range
    let mnx = Infinity, mny = Infinity, mnz = Infinity;
    let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
    let cmn0 = Infinity, cmn1 = Infinity, cmn2 = Infinity;
    let cmx0 = -Infinity, cmx1 = -Infinity, cmx2 = -Infinity;
    for (let i = start; i < end; i++) {
      const p = order[i];
      if (soup.minx[p] < mnx) mnx = soup.minx[p];
      if (soup.miny[p] < mny) mny = soup.miny[p];
      if (soup.minz[p] < mnz) mnz = soup.minz[p];
      if (soup.maxx[p] > mxx) mxx = soup.maxx[p];
      if (soup.maxy[p] > mxy) mxy = soup.maxy[p];
      if (soup.maxz[p] > mxz) mxz = soup.maxz[p];
      if (soup.cx[p] < cmn0) cmn0 = soup.cx[p];
      if (soup.cy[p] < cmn1) cmn1 = soup.cy[p];
      if (soup.cz[p] < cmn2) cmn2 = soup.cz[p];
      if (soup.cx[p] > cmx0) cmx0 = soup.cx[p];
      if (soup.cy[p] > cmx1) cmx1 = soup.cy[p];
      if (soup.cz[p] > cmx2) cmx2 = soup.cz[p];
    }
    const o = slot * 8;
    nodes[o] = mnx;
    nodes[o + 1] = mny;
    nodes[o + 2] = mnz;
    nodes[o + 4] = mxx;
    nodes[o + 5] = mxy;
    nodes[o + 6] = mxz;

    const ex = cmx0 - cmn0;
    const ey = cmx1 - cmn1;
    const ez = cmx2 - cmn2;
    const axis = ex > ey ? (ex > ez ? 0 : 2) : ey > ez ? 1 : 2;
    const cmn = axis === 0 ? cmn0 : axis === 1 ? cmn1 : cmn2;
    const cext = axis === 0 ? ex : axis === 1 ? ey : ez;
    const cent = axis === 0 ? soup.cx : axis === 1 ? soup.cy : soup.cz;

    let mid = -1;
    if (count > LEAF_MAX && cext > 1e-6) {
      // bin the range
      binCnt.fill(0);
      binMin.fill(Infinity);
      binMax.fill(-Infinity);
      binMinY.fill(Infinity);
      binMaxY.fill(-Infinity);
      binMinZ.fill(Infinity);
      binMaxZ.fill(-Infinity);
      const k = BINS / cext;
      for (let i = start; i < end; i++) {
        const p = order[i];
        let b = Math.floor((cent[p] - cmn) * k);
        if (b >= BINS) b = BINS - 1;
        if (b < 0) b = 0;
        binCnt[b]++;
        // bin AABB tracked on all axes (surface area needs the full box);
        // reuse per-axis arrays: Min/Max = x, MinY/MaxY = y, MinZ/MaxZ = z
        const a0 = Math.min(soup.minx[p], binMin[b]);
        binMin[b] = a0;
        if (soup.maxx[p] > binMax[b]) binMax[b] = soup.maxx[p];
        if (soup.miny[p] < binMinY[b]) binMinY[b] = soup.miny[p];
        if (soup.maxy[p] > binMaxY[b]) binMaxY[b] = soup.maxy[p];
        if (soup.minz[p] < binMinZ[b]) binMinZ[b] = soup.minz[p];
        if (soup.maxz[p] > binMaxZ[b]) binMaxZ[b] = soup.maxz[p];
      }
      // sweep SAH: cost(split) = NL*SA(L) + NR*SA(R)
      let best = Infinity;
      let bestBin = -1;
      const laX = new Float32Array(BINS);
      const laY = new Float32Array(BINS);
      const laZ = new Float32Array(BINS);
      const lbX = new Float32Array(BINS);
      const lbY = new Float32Array(BINS);
      const lbZ = new Float32Array(BINS);
      const lc = new Uint32Array(BINS);
      {
        let ax = Infinity, ay = Infinity, az = Infinity;
        let bx = -Infinity, by = -Infinity, bz = -Infinity;
        let c = 0;
        for (let b = 0; b < BINS - 1; b++) {
          if (binCnt[b] > 0) {
            ax = Math.min(ax, binMin[b]);
            ay = Math.min(ay, binMinY[b]);
            az = Math.min(az, binMinZ[b]);
            bx = Math.max(bx, binMax[b]);
            by = Math.max(by, binMaxY[b]);
            bz = Math.max(bz, binMaxZ[b]);
            c += binCnt[b];
          }
          laX[b] = ax; laY[b] = ay; laZ[b] = az;
          lbX[b] = bx; lbY[b] = by; lbZ[b] = bz;
          lc[b] = c;
        }
      }
      {
        let ax = Infinity, ay = Infinity, az = Infinity;
        let bx = -Infinity, by = -Infinity, bz = -Infinity;
        let c = 0;
        for (let b = BINS - 1; b >= 1; b--) {
          if (binCnt[b] > 0) {
            ax = Math.min(ax, binMin[b]);
            ay = Math.min(ay, binMinY[b]);
            az = Math.min(az, binMinZ[b]);
            bx = Math.max(bx, binMax[b]);
            by = Math.max(by, binMaxY[b]);
            bz = Math.max(bz, binMaxZ[b]);
            c += binCnt[b];
          }
          const nl = lc[b - 1];
          const nr = c;
          if (nl === 0 || nr === 0) continue;
          const sa = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number => {
            const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
            return dx * dy + dy * dz + dz * dx;
          };
          const cost =
            nl * sa(laX[b - 1], laY[b - 1], laZ[b - 1], lbX[b - 1], lbY[b - 1], lbZ[b - 1]) +
            nr * sa(ax, ay, az, bx, by, bz);
          if (cost < best) {
            best = cost;
            bestBin = b;
          }
        }
      }
      if (bestBin > 0) {
        // in-place partition by bin
        const splitPos = cmn + bestBin / k;
        let a = start;
        let b = end - 1;
        while (a <= b) {
          if (cent[order[a]] < splitPos) a++;
          else {
            const t = order[a];
            order[a] = order[b];
            order[b] = t;
            b--;
          }
        }
        if (a > start && a < end) mid = a;
      }
    }
    if (count > LEAF_MAX && mid < 0 && cext > 0) {
      // median fallback: sort the subrange by centroid
      const sub = Array.from(order.subarray(start, end));
      sub.sort((p, q) => cent[p] - cent[q]);
      order.set(sub, start);
      mid = start + (count >> 1);
    }

    if (mid > start && mid < end) {
      const left = nextFree;
      nextFree += 2;
      nodes[o + 3] = left;
      nodes[o + 7] = 0;
      stack.push(left, start, mid, depth + 1);
      stack.push(left + 1, mid, end, depth + 1);
    } else {
      nodes[o + 3] = start;
      nodes[o + 7] = count;
    }
  }

  return { nodes, order, nodeCount: nextFree, maxDepth };
}
