/**
 * RT-0 traversal — raw WGSL (v3 §3: "raw WGSL compute wherever TSL limits
 * you"; a stackful BVH walk needs local arrays + while-loops TSL can't
 * express). Entry points are wgslFn wrappers callable from TSL kernels;
 * helpers live in one shared wgsl() include.
 *
 * Buffer contracts: see RtBvh.ts. All ptr params are declared read_write to
 * match the default StorageBufferNode access (the heightfield buffer is a
 * shared node that other passes write).
 */

import { wgsl, wgslFn } from 'three/tsl';
import { WORLD_SIZE } from '../world/WorldConst';
import { HEIGHT_RES } from '../world/WorldConst';

const W = WORLD_SIZE.toFixed(1);
const TEXEL = (WORLD_SIZE / HEIGHT_RES).toFixed(3);

/** shared helpers: slab test, primitive intersectors, heightfield march */
const rtHelpers = wgsl(/* wgsl */ `
fn rtSlab(ro: vec3<f32>, rdInv: vec3<f32>, mn: vec3<f32>, mx: vec3<f32>, tmax: f32) -> vec2<f32> {
  let t1 = (mn - ro) * rdInv;
  let t2 = (mx - ro) * rdInv;
  let tsm = min(t1, t2);
  let tbg = max(t1, t2);
  let tn = max(max(tsm.x, tsm.y), max(tsm.z, 0.0));
  let tf = min(min(tbg.x, tbg.y), min(tbg.z, tmax));
  return vec2<f32>(tn, tf);
}

// bilinear height sample — mirrors Heightfield.sampleHeightFrom exactly
// (uv = p/WORLD + 0.5; g = clamp(uv,0,1)*res - 0.5)
fn rtHeight(hb: ptr<storage, array<f32>, read_write>, res: f32, wx: f32, wz: f32) -> f32 {
  let ux = clamp(wx / ${W} + 0.5, 0.0, 1.0);
  let uz = clamp(wz / ${W} + 0.5, 0.0, 1.0);
  let gx = ux * res - 0.5;
  let gz = uz * res - 0.5;
  let ix = floor(gx);
  let iz = floor(gz);
  let fx = gx - ix;
  let fz = gz - iz;
  let r = i32(res);
  let x0 = clamp(i32(ix), 0, r - 1);
  let z0 = clamp(i32(iz), 0, r - 1);
  let x1 = clamp(i32(ix) + 1, 0, r - 1);
  let z1 = clamp(i32(iz) + 1, 0, r - 1);
  let h00 = (*hb)[z0 * r + x0];
  let h10 = (*hb)[z0 * r + x1];
  let h01 = (*hb)[z1 * r + x0];
  let h11 = (*hb)[z1 * r + x1];
  return mix(mix(h00, h10, fx), mix(h01, h11, fx), fz);
}

// terrain tile: clip to the tile box, texel-step march, 6-step bisect refine.
// a = (wx0, wz0, wx1, wz1), b = (minY, maxY, -, -)
fn rtTile(hb: ptr<storage, array<f32>, read_write>, res: f32,
          ro: vec3<f32>, rd: vec3<f32>, rdInv: vec3<f32>,
          a: vec4<f32>, b: vec4<f32>, tmax: f32) -> f32 {
  let s = rtSlab(ro, rdInv, vec3<f32>(a.x, b.x - 0.5, a.y), vec3<f32>(a.z, b.y + 0.5, a.w), tmax);
  if (s.x > s.y) { return -1.0; }
  let t0 = s.x;
  let t1 = s.y;
  let hspeed = max(length(rd.xz), 1e-6);
  let dt = ${TEXEL} / hspeed;
  let steps = min(i32((t1 - t0) / dt) + 1, 96);
  var tp = t0;
  var dp = ro.y + t0 * rd.y - rtHeight(hb, res, ro.x + t0 * rd.x, ro.z + t0 * rd.z);
  if (dp <= 0.0) { return t0; }
  for (var i = 1; i <= steps; i++) {
    let t = min(t0 + f32(i) * dt, t1);
    let d = ro.y + t * rd.y - rtHeight(hb, res, ro.x + t * rd.x, ro.z + t * rd.z);
    if (d <= 0.0) {
      var lo = tp;
      var hi = t;
      for (var j = 0; j < 6; j++) {
        let m = 0.5 * (lo + hi);
        let dm = ro.y + m * rd.y - rtHeight(hb, res, ro.x + m * rd.x, ro.z + m * rd.z);
        if (dm <= 0.0) { hi = m; } else { lo = m; }
      }
      return hi;
    }
    tp = t;
    dp = d;
    if (t >= t1) { break; }
  }
  return -1.0;
}

// vertical capsule from base, height h, radius r (iq's capIntersect,
// axis specialised to +Y)
fn rtCapsule(ro: vec3<f32>, rd: vec3<f32>, base: vec3<f32>, h: f32, r: f32) -> f32 {
  let oa = ro - base;
  let baba = h * h;
  let bard = h * rd.y;
  let baoa = h * oa.y;
  let rdoa = dot(rd, oa);
  let oaoa = dot(oa, oa);
  let a = baba - bard * bard;
  var bq = baba * rdoa - baoa * bard;
  var cq = baba * oaoa - baoa * baoa - r * r * baba;
  var hd = bq * bq - a * cq;
  if (hd >= 0.0) {
    let t = (-bq - sqrt(hd)) / max(a, 1e-8);
    let y = baoa + t * bard;
    if (y > 0.0 && y < baba && t > 0.0) { return t; }
    // sphere caps
    let oc = select(oa - vec3<f32>(0.0, h, 0.0), oa, y <= 0.0);
    bq = dot(rd, oc);
    cq = dot(oc, oc) - r * r;
    hd = bq * bq - cq;
    if (hd > 0.0) {
      let t2 = -bq - sqrt(hd);
      if (t2 > 0.0) { return t2; }
    }
  }
  return -1.0;
}

// axis-aligned ellipsoid: centre c, semi-axes (rxz, ry, rxz)
fn rtEllipsoid(ro: vec3<f32>, rd: vec3<f32>, c: vec3<f32>, rxz: f32, ry: f32) -> f32 {
  let ir = vec3<f32>(1.0 / rxz, 1.0 / ry, 1.0 / rxz);
  let o = (ro - c) * ir;
  let d = rd * ir;
  let qa = dot(d, d);
  let qb = dot(o, d);
  let qc = dot(o, o) - 1.0;
  let h = qb * qb - qa * qc;
  if (h < 0.0) { return -1.0; }
  let t = (-qb - sqrt(h)) / max(qa, 1e-12);
  return select(-1.0, t, t > 0.0);
}
`);

/**
 * Closest-hit / any-hit BVH traversal.
 * Returns vec4(t, primIdx, nodeIters, anyHitFlag); t < 0 = miss.
 * Stack depth 64 (builder asserts maxDepth < 64).
 */
export const rtTraceFn = wgslFn(
  /* wgsl */ `
fn rtTrace(
  nodes: ptr<storage, array<vec4<f32>>, read_write>,
  pidx: ptr<storage, array<u32>, read_write>,
  pa: ptr<storage, array<vec4<f32>>, read_write>,
  pb: ptr<storage, array<vec4<f32>>, read_write>,
  hb: ptr<storage, array<f32>, read_write>,
  ro: vec3<f32>,
  rd: vec3<f32>,
  tmax0: f32,
  tileCount: u32,
  res: f32,
  anyHit: u32,
) -> vec4<f32> {
  var tbest = tmax0;
  var prim = -1.0;
  var iters = 0.0;
  let rdSafe = select(vec3<f32>(1e-9), rd, abs(rd) > vec3<f32>(1e-9));
  let rdInv = 1.0 / rdSafe;
  var stack: array<u32, 64>;
  var sp: i32 = 0;
  var node: u32 = 0u;
  loop {
    iters += 1.0;
    if (iters > 8192.0) { break; }
    let n0 = (*nodes)[2u * node];
    let n1 = (*nodes)[2u * node + 1u];
    let cnt = u32(n1.w);
    if (cnt == 0u) {
      let l = u32(n0.w);
      let r = l + 1u;
      let l0 = (*nodes)[2u * l];
      let l1 = (*nodes)[2u * l + 1u];
      let r0 = (*nodes)[2u * r];
      let r1 = (*nodes)[2u * r + 1u];
      let sl = rtSlab(ro, rdInv, l0.xyz, l1.xyz, tbest);
      let sr = rtSlab(ro, rdInv, r0.xyz, r1.xyz, tbest);
      let hl = sl.x <= sl.y;
      let hr = sr.x <= sr.y;
      if (hl && hr) {
        var near = l;
        var far = r;
        if (sr.x < sl.x) { near = r; far = l; }
        stack[sp] = far;
        sp += 1;
        node = near;
        continue;
      } else if (hl) {
        node = l;
        continue;
      } else if (hr) {
        node = r;
        continue;
      }
    } else {
      let first = u32(n0.w);
      for (var j = 0u; j < cnt; j += 1u) {
        let oi = (*pidx)[first + j];
        var t = -1.0;
        if (oi < tileCount) {
          t = rtTile(hb, res, ro, rd, rdInv, (*pa)[oi], (*pb)[oi], tbest);
        } else {
          let A = (*pa)[oi];
          let B = (*pb)[oi];
          let t1 = rtCapsule(ro, rd, A.xyz, B.x, A.w);
          let t2 = rtEllipsoid(ro, rd, A.xyz + vec3<f32>(0.0, B.y, 0.0), B.z, B.w);
          t = t1;
          if (t2 > 0.0 && (t < 0.0 || t2 < t)) { t = t2; }
        }
        if (t > 0.0 && t < tbest) {
          tbest = t;
          prim = f32(oi);
          if (anyHit == 1u) {
            return vec4<f32>(tbest, prim, iters, 1.0);
          }
        }
      }
    }
    if (sp == 0) { break; }
    sp -= 1;
    node = stack[sp];
  }
  let hit = select(-1.0, tbest, prim >= 0.0);
  return vec4<f32>(hit, prim, iters, 0.0);
}
`,
  [rtHelpers],
);

/**
 * Geometric normal at a hit point (terrain gradient / capsule / ellipsoid).
 * Debug shading + RT-1 reflection dirs; recomputed from the prim, no G-buffer.
 */
export const rtNormalFn = wgslFn(
  /* wgsl */ `
fn rtNormal(
  pa: ptr<storage, array<vec4<f32>>, read_write>,
  pb: ptr<storage, array<vec4<f32>>, read_write>,
  hb: ptr<storage, array<f32>, read_write>,
  oi: u32,
  tileCount: u32,
  res: f32,
  p: vec3<f32>,
) -> vec3<f32> {
  if (oi < tileCount) {
    let e = 0.75;
    let hx0 = rtHeight(hb, res, p.x - e, p.z);
    let hx1 = rtHeight(hb, res, p.x + e, p.z);
    let hz0 = rtHeight(hb, res, p.x, p.z - e);
    let hz1 = rtHeight(hb, res, p.x, p.z + e);
    return normalize(vec3<f32>(hx0 - hx1, 2.0 * e, hz0 - hz1));
  }
  let A = (*pa)[oi];
  let B = (*pb)[oi];
  let crown = A.xyz + vec3<f32>(0.0, B.y, 0.0);
  let q = (p - crown) / vec3<f32>(B.z, B.w, B.z);
  if (abs(dot(q, q) - 1.0) < 0.12) {
    return normalize(q / vec3<f32>(B.z, B.w, B.z));
  }
  let y = clamp(p.y - A.y, 0.0, B.x);
  return normalize(p - vec3<f32>(A.x, A.y + y, A.z));
}
`,
  [rtHelpers],
);
