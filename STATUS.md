# PROJECT LAAS — STATUS (source of truth)

> **Rehydration protocol** (for an agent resuming with no context): read this file fully, then
> `PROJECT_LAAS_v3.md` (the spec — binding; supersedes v2, which stays as history), then
> `docs/THREE-NOTES.md` (API gotchas for the
> pinned three.js), then the **Current focus** section below. Reference images: `reference/`.
> Never re-plan from scratch; continue from "Next actions". Update this file after every
> meaningful step. Commit per milestone with descriptive messages.

## Mission (1 paragraph)

Fully procedural 4×4 km open world in the browser. WebGPU only (three.js WebGPURenderer + TSL +
raw WGSL compute), TypeScript strict, zero `any`, zero external assets, deterministic by
`?seed=N`. Visual bar: the four UE5-class reference images in `reference/` (noon forest ravine
w/ cobbled streambed; gully close-up; karst tower forest in haze; golden-hour serrated alpine
vista w/ snow + cloud sea below summits — "Witcher" frame). 8 gated phases; verification by
Playwright screenshots compared against references; `DELTA.md` loop each phase. Must ALSO be
smooth + explorable interactively by the user (fly camera, ToD control, bookmarks) — user
feedback comes in chat; the two-frame test is the agent-side acceptance only.

**GAME ERA (2026-07-02): `PROJECT_LAAS_v3.md` adopted, supersedes v2.** The world becomes a
wildlife-photography game: fauna program (birds → aquatic → small mammals → ungulates, all
procedural, photograph-bar quality gate), photo mode + album/field journal, landmarks/map/
trails + journey intro, full procedural audio (blind lifelike gate), hybrid compute-shader RT
(reflections first), K-list bug burndown, 120 fps base + toggleable quality tiers. Roadmap =
milestones M1–M8 (v3 §14), stabilize-first; M1 absorbs the old Phase 7. v2's pillars, floors,
and bans remain law via v3 §0/§5.

## Hard rules digest (full text = spec §)

- No black/gray shadows (Pillar B); no bare terrain within 10 m (Pillar A/§9); no cloned trees;
  no smooth silhouettes on hero rock/tree; no fog-as-cover; no `MeshBasicMaterial`; no CPU
  per-instance updates; no one-file architecture; never ask user to lower the bar.
- Floors (§2): ≥5M tris forest hero / ≥3M vista post-culling; 4096² heightfield sim; erosion
  ≥500 iters @ ≥2048²; ≥6 tree species w/ per-instance uniqueness; hero tree ≥100k tris; hero
  rock ≥200k tris; grass ≥800k blades; debris ≥80k; particles ≥100k; visible range ≥4 km;
  ≥5 biomes incl. alpine snow; probes ≥24×24×6 per chunk; CSM 4×≥2048² + PCSS + contact
  shadows; raymarched 2-layer clouds + cloud shadows; Hillaire atmosphere; 60 fps @ 1440p
  target hardware class.
- Infeasible item → nearest feasible alternative + entry in `DEVIATIONS.md`. A closed phase has
  zero TODOs in its code.

## Verified environment facts

- macOS 26.4 (Darwin 25.4.0), Apple **M1 Max 32-core GPU**, Metal 4, 3456×2234 display.
- Node v22.12.0, npm 10.9.0. Git repo initialized on `main` (no remote).
- three.js pinned: **0.184.0** (latest on npm as of 2026-06-10). VERIFY APIs against
  `node_modules/three/` source before use — do not trust memory for TSL surface.
- **Playwright WebGPU recipe (SOLVED)**: `chromium.launch({ headless: true, channel: 'chromium' })`
  → apple/metal-3 adapter. Two traps: (1) WebGPU only exists on secure contexts — probe on
  http://localhost:5173, never about:blank; (2) default Playwright headless = GPU-less
  "headless shell"; `channel:'chromium'` selects full Chromium new-headless. Cached in
  `.cache/webgpu-flags.json` by tools/launch.ts.
- Dev server: `npm run dev` (background, port 5173 strict). Shots:
  `npx tsx tools/shoot.ts --scene X --cam "..." --out shots/x.png [--hud 1] [--stats f.json]`.
  Compare: `npx tsx tools/compare.ts --a ours.png --b reference/sceneN.png --out cmp.png`.
  Pixel sampling (shadow-color test): `--sample img.png --px "x,y;x,y"`.
- Sanity scene measured (1080p, M1 Max): 3.1M tris @ 117 fps, render 7.2 ms — lots of headroom.

## Phase checklist

- [x] **Phase 0** — DONE 2026-06-10. Scaffold, WebGPU init + fail-loud diagnostics, HUD, fly
      camera, params, Playwright shot harness (headless WebGPU working), compare tool. Gate
      passed: `shots/phase-0/cmp_sanity_vs_scene1.png`. Proven: compute→storage→instanced draw,
      compute→StorageTexture→sampling, TSL vertex displacement, CPU procedural geometry,
      GPU timestamps, deterministic seeding.
- [x] **Phase 1** — DONE 2026-06-11. 4096² synth (macro layout: NE massif/valley/karst/lake w/
      outlet), pipe erosion 640 it @2048 (hardness-aware thermal), multigrid lake fill, particle
      flow accumulation → carved rivers, moisture, biome+snow classify (coarse-slope hold +
      couloirs + ledges + dither), CDLOD instanced tiles + far shell w/ analytic normals +
      far-detail normal synthesis, PBR splat material (strata/iron bands/lichen/macro variation/
      wet darkening/snow), erosion split view, ground-clamped camera (`x/z/alt/yaw`), CPU height
      readback. Gates passed; see docs/DELTA.md Phase 1. Artifacts: shots/phase-1/.
- [x] **Phase 2** — DONE 2026-06-11. Hillaire LUT atmosphere + aerial perspective (post-pass
      camera-uniform bug fixed — explicit uCamPos/uProjInv/uCamWorld); GPU auto-exposure
      (key 0.125); hemisphere ambient (IBL env path dead → Phase 3 probes); CSM×4 + PCSS +
      screen-space contact shadows (12-step depth march, near-field, floored); volumetric
      clouds (half-res RTT march, baked weather, cloud sea below summits + cloud shadow map);
      TRAA, GTAO (depth-derived normals, distance-faded), bloom, per-ToD grade (strong
      teal-orange golden split). Gates PASSED: golden vista vs Witcher (DELTA.md Phase 2,
      ~70% of ref without vegetation), shadow-color test (chroma 18.3/255, no gray).
      Artifacts: shots/phase-2/. Known debts → DELTA items 1,4,7–10.
- [x] **Phase 3** — DONE 2026-06-11 (vegetation-dependent parts deferred w/ DEVIATIONS).
      Irradiance probe field: 256×256×6 TERRAIN-RELATIVE layers (1.5–105 m above ground),
      heightfield ray-march gather (16 dirs × 16 steps, sun horizon test + albedo proxy +
      sky LUT misses), SH-L1 → 3×rgba16f 3D textures, time-sliced 3072/frame (~2 s refresh,
      invalidate() fast-converge on ToD jumps), injected via IrradianceNode (setupLightMap
      patch); hemisphere dimmed to 0.15× floor. GTAO: depth-derived normals + distance fade
      + luminance-masked 'indirect-only' approx (DEVIATIONS D-1). Screen-space bounce +
      foliage translucency → Phase 4 (D-2). Probe density vs spec floor → D-3.
      VERIFIED: no-black-shadows at golden hour (darkest-20 lum 61.8, chroma 20.1 — AgX-toe
      desat fixed); ?view=probes ambient-only debug view; +3 ms GPU. Forest-interior gate
      re-judged after Phase 4 (no forest exists). Artifacts: shots/phase-3/.
- [x] **Phase 4** — DONE 2026-06-11. Growth grammar (tropisms, whorl/spiral/PLANAR phyllotaxis,
      crown envelopes, light-competition asym, per-instance lean/age/bias = D5); 6 tree species
      (spruce/pine/beech/birch/karst-gnarl/snag) + 3 shrubs (incl. PINK FLOWERING) + fern + 4
      flowers; foliage CLUSTER-CARD pipeline (real leaf/needle meshes captured to per-species
      2×2 atlases — the ez-tree look, zero assets) + hero HYBRID mode (cards + real-mesh
      foliage; hero spruce 1.18M / beech 1.26M tris); bark synthesis 6 recipes (2048² compute,
      albedo/cavity + normal/rough/height, aoNode wired = D-1); rocks (welded icosphere +
      strata ledges + fracture cuts; hero 327k craggy, cliffFace preset, wall, cobbles); grass
      (clumped instanced blades, 260k shown), debris kit (cobbles/pebbles/twigs/chips/litter
      reusing leaf atlas), deadfall (logs ×3 decay + stumps + shelf/cap fungi), dressing
      (moss/lichen/streaks by upness+cavity, hanging vines, ledge ferns, litter ring); foliage
      translucency + SS bounce (D-2), octahedral impostor capture 8×8 albedo+normal+depth +
      relit preview (runtime → D-4/Phase 5). Gate: gallery sheet shots/phase-4/ + macro-meso-
      micro audit in DELTA.md (top-3 deltas fixed: foliage hue variance, log moss, blossoms).
      Forest-interior gate re-judge happens after Phase-5 assembly (no forest yet).
- [x] **Phase 5** — DONE 2026-06-11. GPU scatter (162k trees/467k under/451k stones), per-frame
      instance cull (frustum + terrain-march occlusion + ring classify) → compact indirect draws,
      LOD rings hero≤26/R1≤150/R2≤460/octahedral impostors (dithered crossfades, vegViewPos),
      PER-CASCADE shadow caster culling + fitted crown shadow proxies (world-anchored dither,
      impostor-band casters to 1.1 km) + world-metric PCSS, canopy-aware chromatic probe GI
      (green crown slab + glow), grass/debris probe GI + shade coloring, terrain micro-
      displacement (fbm+ridged creases, biome/gravel-gated, shared DISP table, ?dispdbg=1),
      gorge wall greening, river boulder affinity, grass 5/3-blade clumps + 3-plane tufts +
      near scruff floor. GATE PASSED: floors hero 19.5M / vista 6.8M veg tris / grass ~1.0M
      blades (shots/phase-5/floor-*), repetition strip clean (strip-1..5), DELTA Phase-5
      top-10 logged + top-3 fixed, DEVIATIONS D-5. Shadow regression user-reported and FIXED
      (blobby/flicker/circle — see gotchas). Carried: geometric wall plants, moss volume geo,
      noon-dapple gap-framing re-judge, perf 50–151 ms GPU veg-heavy (Phase 7).
- [x] **Phase 6** — BUILT 2026-06-12, all six systems live + verified (gate notes below):
      stream/lake water (clipmap + SSR + caustics + wet margins + strict hydrology),
      hierarchical wind (trees/understory/grass + shadows), froxel volumetrics (canopy
      shafts + valley fog), GPU particles (131k snow/pollen/leaves), weather motion
      (clouds drift+churn, shadow map follows). Lakes use SSR (spec: "SSR or planar");
      planar pass logged as optional polish. Gate DELTA written (docs/DELTA.md Phase 6):
      motion checks PASSED, remaining items are art-direction/composition (fg boulders,
      wall-veg density, overhang framing) folded into Phase 7's composed-bookmark pass.
- [x] **Phase 7** — CLOSED 2026-07-03 as part of M1 (M1 absorbed Phase 7 per v3 §14).
      Landed: per-pass HUD/GPU profiler (?prof=1), 9 composed bookmarks (bm7 re-posed),
      90 s flythrough (clearance-fixed tour), full battery (6/6 — pops amber resolved by
      user free-flight confirm; karst near-pass slice documented informational), two-frame
      test logged in DELTA M1-close, cooled fps report table (2026-07-03). Perf: the spec's
      60fps@1440p floor is superseded by the binding 120fps-at-native directive, which
      carries into M2 as ranked background work (self-score rubric = M8 per v3).
- [ ] **Tier 3** — only after battery passes (see spec §11).

## Current focus

**M2 — RT foundation + reflections (as of 2026-07-03; M1 closed with K-1 carried).**
See the M2 SCAFFOLD entry at the top of "Next actions" for the order of attack.
Everything below this line in Current focus is historical phase-era context.

**Phase 2 — atmosphere, shadows, clouds, post** + USER FEEDBACK BATCH 1 (2026-06-11).

User feedback (all four addressed, commits e939266/575b621/next):
1. PERF "~40fps before objects": root-caused via new `?ablate=` + `--gpusample` median
   harness → terrain splat material was ~52 ms of a 73.5 ms GPU frame (35 live noise
   evals/px). Fixed: `NoiseBake.ts` baked value/fbm/ridged + PRE-DERIVED GRADIENT
   textures; GTAO samples 16→8 (defaults cost ~50 ms on vistas); clouds half-res RTT +
   baked weather; 3D-distance quadtree split; castShadowPositionNode (nearest, no morph);
   CSM maxFar 3200. NOW: 19–23 ms GPU @1080p all views (was 73–134). Phase 7 finishes
   (vsync-real fps; spikes re-check on live flythrough).
2. EROSION "sharp diagonal/straight 1-cell trenches, predictable lake patterns": particle
   trace was D8 (8-direction snap) → continuous bilinear-gradient descent w/ inertia;
   strength field blurred before carve (channels have width); carve faded inside lakes;
   particles STOP on filled flats (ε-tilt alignment printed parallel lines) and in lakes;
   hardness-aware talus relax (26 it) post-carve rounds trench walls, towers protected;
   trench enforcement got V-profile (was rectangular select) + fine meander warp octave
   (61 m / ±16 m) so spline trenches aren't ruler-straight; kettle ponds render dark
   (were gravel-gray dots). VERIFIED shots/wip/fix-round2-*.png.
3. LOD "center always high detail": VERIFIED FALSE for the quadtree (live setPose test:
   rings follow camera; `?view=lod` debug added). Real causes user saw: far shell beyond
   world edge + coarse cliffs (see 4). 3D split distance stops altitude over-refine.
4. MESHING "stretched verts on slopes": skirted patches (PlaneGeometry +2 ring, clamp +
   drop in shader → crack-proof) + error-biased splits (height-range mip pyramid; rough
   tiles split earlier and down to 32 m → 0.5 m quads on cliff close-ups). Snow dither
   gated near boundary (white speckle on rock fixed).

Phase 2 items: 1–5 BUILT as before (atmosphere LUTs, SunSky, CSM+PCSS, clouds, post).
CLOUDS NOW VISIBLE AND CORRECT — root causes were (a) quad-pass camera uniforms
(cameraPosition/WorldMatrix/ProjectionMatrixInverse are the POST QUAD camera inside
RenderPipeline.outputNode → explicit uCamPos/uProjInv/uCamWorld uniforms now) and
(b) depth convention is CLASSIC here (sky d=1.0, not reversed) → isSky + maxD fixed.
Aerial perspective only became truly distance-correct with the same fix.
`?cloudview=1..9` probe ladder kept (tone mapping auto-off when probing).

PHASE 2 CLOSED 2026-06-11 (see checklist + DELTA.md). All listed items landed: cloud art
pass (contrast-stretched weather, isotropic phase floor, base-darkened ambient, default
cov 0.62), contact shadows (?ablate=contact to A/B), black facets root-caused to GTAO
(NOT PCSS — depth-derived normals fixed it), gate + shadow-color test PASSED.

**Phase 5 — BUILT, gate pending.** The world is planted end-to-end:
- `Scatter.ts`: boot GPU clustered-Poisson (162k trees / 467k understory /
  7.4k extras at seed 1), per-class density fns (biome/slope/treeline/moisture/
  snow/rockExp/water), ecotone warp, parent-clump field doubling as canopy
  proxy for understory (ferns under crowns, flowers in gaps, pink shrubs at
  clump EDGES). pcg2d integer hash (pure expression — usable in materials).
  + `buildCanopyMap`: crowns splatted to a 1024² coverage field; attenuates
  probe ambient under canopy (terrain ×0.55, veg ×0.4) = forest interiors no
  longer sky-bright (user "washed out" + shadow-visibility fix).
- `VegLibrary.ts`: K=4 variants/species; R1/R2 ring geoms from the SAME
  skeleton (no-pop LODs); ring diet in TreeBuilder (bark stops below anchor
  level; cards thin+enlarge ≈ sqrt(stride)) → R1 avg 8.4k tris, R2 1.8k.
  Impostor capture per species.
- `Forests.ts`: per-frame clear→cull→indirect computes. Cull = per-class
  dist bound + 6-plane frustum + terrain-occlusion march (camera→crown-top
  against height buffer) + ring classify w/ overlap bands → atomic append
  into per-(pool,ring) compact regions → `geometry.setIndirect` draws (one
  shared IndirectStorageBufferAttribute, byte offsets). Rings: R1 cards
  ≤150 m → R2 ≤460 m → octahedral impostors (D-4 runtime: 4-tile hemi-oct
  bilinear blend, relit normals, per-instance yaw/tint) — IGN-dithered
  crossfades. Tree rings 1+2 cast shadows; terrain casts via `ShadowProxy`
  (512² grid; CDLOD castShadow=false; saved ~54 ms).
- `GroundRing.ts`: toroidal-clipmap grass (3072², 136 slots/m², 4/2-blade
  CLUMP geoms near/mid + tuft cross far; ≈520k blades visible at meadow
  framings) + debris ring (cobble/pebble/twig/chip/litter; streambed
  override density — beds read cobbled). `CanopyShell.ts`: far forests as a
  lit lumpy aggregate beyond 620 m.
- Veg materials: GI-patched (IrradianceNode), canopy-attenuated, per-instance
  tint, vec4-alpha shadow contract + maskShadowNode cutouts,
  castShadowPositionNode, instance NORMAL rotation (normalLocal.assign).

## Next actions (always keep current)

- **M1 CLOSED WITH ONE EXCEPTION (2026-07-03) — USER K-CONFIRMS IN.
  Current focus → M2 (RT foundation + reflections).**
  User live confirms (their viewport, in motion — K-list rule):
  - K-2 PASS: no rim at any hour. NEW separate observation logged: up
    close the water surface "isn't quite level with the ground" at the
    shore (fine at normal distance) → ranked M2 water item below.
  - K-3 PASS. K-4 PASS (free flight + ridge crossing clean) — this also
    satisfies the battery pops stage's amber acceptance path ("covered
    by user free-flight"): pops stage now effectively GREEN, battery
    6/6 with the karst near-pass slice documented informational.
  - **K-1 FAIL — REOPENED.** User: tuning traa_far0/traa_gammastill
    "didn't really change much". SAME-DAY ATTRIBUTION (probe-temporal
    rest @bm3 T19 native): control mean 0.414/p95 1.52 == the
    2026-07-02 post-fix baseline (0.411/1.49, build stable);
    `--ablate gi` reads WORSE (0.452/1.70) = pure content confound →
    **probe-GI refresh grid EXONERATED, dotted-ring hypothesis dead.**
    Worst tiles in BOTH runs sit in the frame's bottom band
    (y 1224-1560, luma 3.3-6.5): the NEAR-MID CANOPY INSIDE THE WIND
    GATE — the γ ramp requires low velocity AND dist>traa_far0, so
    near static foliage keeps γ=1 (stock-tight) at ANY knob value.
    That's why the user's tuning was a no-op. This is the intentional
    wind-crispness trade re-judged as not good enough live.
    **CANDIDATE FIX (M2-carried, first K-1 work item): per-pixel
    history-confidence accumulation — count consecutive low-velocity
    frames in the history alpha channel and widen γ on confidence
    REGARDLESS of distance; wind-swaying pixels carry real velocity and
    reset the counter, so wind crispness survives by construction.
    Gate: probe-temporal rest mean at bm3 bottom-band tiles + no pan
    regression + wind-sway shot judged; then user re-confirm.**
    M1 closes on user direction with K-1 carried as the single open
    exception (v3 M5 re-couples to K-1 verification regardless).
  M1 GATE LEDGER (v3 §14): battery ✓ (6/6 w/ documented informational
  slice), probes ✓ (temporal green, pops attributed + user-covered),
  ABAB fps report ✓ (table below), user K-confirms 3/4 ✓ + K-1 carried.

- **M2 SCAFFOLD (v3 §14 row 2) — deliverables: RT-0 BVH + Mrays/s
  benchmark; RT-1 water reflections (high tier); base-tier SSR fallback
  fix. Gate: Mrays/s table in STATUS; bm2 grazing shot clean; base tier
  framealign-identical.** Order of attack when picked up:
  1. RT-0: compute-shader BVH over the heightfield + veg proxies,
     Mrays/s benchmark at native on the M1 Max (v3 §RT: "this number
     calibrates everything after") — new probe tool + STATUS table.
  2. K-1 carried fix (history-confidence TRAA clip — see above) —
     small, high-user-value, do it early in M2.
  3. RT-1: water reflections on the high tier (kills the K-2 family
     structurally); base tier must stay framealign-identical.
  4. NEW (user 2026-07-03): shore close-up — water surface not quite
     level with the ground; investigate waterline vs clipmap height at
     the margin (suspects: rSurf cap vs terrain sample offset, wet-
     margin fringe width). Judge up-close at bm2 + a stream bank.
  5. Background perf (120 fps directive, ranked queue): post merges,
     cpu.submit cuts (~10 ms at native), GPU 42-43 ms at bm4/bm7.

- **M1 GATE: ABAB FPS REPORT vs BASELINE — DONE (2026-07-03). No
  regression anywhere; new post-M1 baseline table established.**
  Cooled single-session run (180 s idle → one boot → `bench <bm> 10`
  per bookmark), native 2592×1676, prof=1 (same as the 2026-06-13
  baseline era — the 58.3/91.7 ms p90 spike modes are the documented
  profiler timestamp serialization, NOT frame-pacing regressions):
  | bm | p50 wall | fps | cpu.submit | gpu-sum | 2026-06-13 cooled |
  |----|---------|-----|-----------|---------|-------------------|
  | 1 gorge stream    | 25.0 | 34.4 | 9.4  | 41.0 | 29.1 (−4.1) |
  | 3 golden vista    | 17.6 | 39.2 | 9.5  | 31.5 | 25.3 (re-posed*) |
  | 4 meadow shafts   | 41.7 | 21.4 | 10.2 | 42.5 | 42.8 (−1.1) |
  | 7 forest interior | 41.7 | 20.9 | 10.3 | 43.4 | 38.0 (re-posed*) |
  | 9 valley aerial   | 25.0 | 35.0 | 9.4  | 32.0 | (re-posed*) |
  *bm3/bm9 old numbers were ground-level framings (walk-snap bug, fixed
  2026-07-02) and bm7 was re-posed to the backlit interior — these rows
  are NEW baselines, not comparisons. Comparable rows (bm1, bm4) are at
  or better than baseline. THIS TABLE = the reference for all M2+ perf
  claims (via `bench ab`, methodology law). 120 fps directive remains
  open work: heaviest rows are GPU-bound (gpu-sum 42-43 ms at bm4/bm7)
  with cpu.submit ~10 ms — the ranked queue (post merges, submit cuts)
  carries into M2 as background perf work.

- **bm1 HOT-READ ANOMALY RESOLVED — THERMAL, NO REGRESSION (2026-07-03,
  commit 0803ee7+). The cooled-ABAB blocker on M1 is CLEARED; the gate now
  waits on user K-confirms only.**
  Ran the prescribed cooled ABAB at bm1 native 2592×1676 (180 s idle →
  boot → `bench 12` → both knob ABABs → closing `bench 12`, one session):
  - ABSOLUTE COOLED: p50 25.0 ms wall (~35 fps), cpu.submit 10.2,
    gpu-sum 41.0 — identical first and last row (thermally stable run).
    vs baselines: 29.1 (2026-06-13 cooled, prof-era) / 27.2 (prof-fix
    verification, no-prof). Today's run is prof=1 (harness default), so
    the true no-prof wall is ≤25.0 — bm1 is FASTER than every baseline.
    (The p90 58.3 spike mode ≈ every 3-4 frames is the KNOWN ?prof=1
    timestamp-resolve serialization — see the 2026-07-02 prof entry;
    don't mistake it for a regression when reading bench rows.)
  - `bench ab stonedetail 3 2 8`: Δp50 −0.00 ms (25.0 → 25.0). The K-3
    StoneL d2 2→3 vertex-density bump costs NOTHING at bm1 (gpu median
    41.0→~40.0 in the B rounds — not the wall bottleneck).
  - `bench ab castercap 24576 8192 8`: Δp50 0.00 ms. The K-4 caster-cap
    fix (restored ~half the far crown shadows) costs NOTHING at bm1.
  - VERDICT: the mid-session 75 ms read was thermal saturation, exactly
    the failure mode the methodology law predicts. Both suspects
    exonerated by direct experiment.
  NEW INSTRUMENTS (all committed):
  - `stonedetail` cvar (+?stonedetail= boot): pre-K-3 d2=2 StoneL R2
    twin draws (hidden siblings, same compact groups, main + 4 cascade
    casters per variant), visibility-swapped live; groupTris follows so
    veg.tris stays truthful. Default = pixel-identical (722 draws /
    16.78M tris unchanged at bm1).
  - `castercap` cvar (+?castercap= boot): live uniform clamp on the
    impostor-band crown-proxy caps in the INDIRECT kernel only — appends
    still fill the boot allocation, so the drawn set reproduces the
    pre-fix append-order drop exactly. effCap mirrored in veg.capOver +
    debugCounters (capOver > 0 while lowered is EXPECTED, by design).
  - tools/knob-check.ts: same-boot A→B→A knob verification. Cross-boot
    shot diffs at bm1/bm4 are 2-7% >12/255 of pure noise (caustic
    wall-clock phase — SURVIVES ?ablate=water, needs ?ablate=caustics;
    exposure convergence; wind sways under ?freeze). Rest recipe
    (wind 0 + lockexp + ablate caustics + frame%1024 alignment + 320-
    frame GI pre-roll) collapses the floor to ~0.2% (worst residual tile
    = the fps HUD chip). Knob proof: veg.tris 12,925,270 → 12,780,310 →
    back (Δ 144,960 = the twin swap); castercap readback 24576 → 8192 →
    back with 3 imp-band groups overflowing at 8192.
  - tools/bench-run.ts: headless driver typing bench/bench-ab lines into
    the dev console (`--shot N --w --h --cooldown S --cmds "line@marker;…"`)
    — the binding ABAB methodology, scriptable.
  NEXT AGENT WORK (when picked up): the 120 fps directive ranked queue
  (cpu.submit cuts — 10.2 ms at bm1 native is the biggest CPU term);
  K-1 residual probes (`--ablate gi` dotted-ring attribution) per the
  K-1 entry below.

- **M1 CLOSE — AGENT-SIDE COMPLETE (2026-07-02 evening session, commits
  14f2e0a..HEAD). AWAITING: user K-confirms (cooled bm1 ABAB DONE
  2026-07-03 — no regression, see entry above).**
  FINAL BATTERY: 5/6 PASS (contact, floors 15.3M/13.6M, shadowcolor
  luma 26.7/chroma 17.3, temporal bm3 0.412/bm9 0.228 vs ≤0.6 gate,
  HF 92.6% of 4×SSAA). Pops stage AMBER, fully attributed: the karst
  near-pass slice (u .62–.68) is un-probeable at tile level (tour passes
  within meters of spires; flow-check at slow-16 PROVED magnitudes grow,
  not shrink → informational, covered by user free-flight); the 10 gated
  events at u<.015 are the K-1 RESIDUAL shimmer class, NOT transitions
  (verified: alternating-sign per-frame flicker, 2–3× WORSE under
  ?traa=stock — a real transition would be resolve-invariant). That
  hotspot was already on K-1's remaining list; acceptance path stays
  "tune traa_far0 live with user".
  ALSO THIS SESSION: K-3 ROUND 2 (bm4 vinyl blob = StoneL vertex-density
  root cause, d1 5/d2 3 + fscale + scatter context gate; bm1/bm6
  streambeds re-judged clean); bm7 RE-POSED (backlit interior dapple,
  12-candidate sweep; floors 15.3M ✓); TWO-FRAME TEST run + logged in
  DELTA.md M1-close section (vista: pass-with-notes, smooth far peaks
  standing; ravine: honest fail on bank-vegetation density — M8 owns
  final acceptance); contact sheet re-judged (bm5 green shards + bm8
  contre-jour = ranked open items in DELTA).
  PERF: hot-loop spot checks mid-session: bm4 p50 41.7 ms at native
  WHILE thermally saturated (cooled baseline 42.8–50) — no regression
  signal at bm4; bm1 read anomalously heavy hot (75 ms vs 27–29
  baseline) — ATTRIBUTION REQUIRES COOLED ABAB (methodology law).
  [DONE 2026-07-03: cooled ABAB ran with the new ?stonedetail=/
  ?castercap= knobs — both suspects exonerated, bm1 cooled p50 25.0 ms,
  anomaly was thermal. See the 2026-07-03 entry above.] The 120 fps
  directive work continues per the ranked queue (cpu.submit cuts).
  USER CONFIRM CHECKLIST (K-list rule — live, in motion, your viewport):
  (1) K-1 far flicker: bm3/bm9 at rest + slow pan; also the descent
      canopy shimmer (tour start, look down) — tune traa_far0 live.
  (2) K-2 lake rim: bm2 grazing angles through the day.
  (3) K-3 blob rocks: bm4 foreground + fieldstone gallery + streambeds.
  (4) K-4 pops: free flight, especially shoreline descents and the
      karst ridge crossing — dolly+tour clean agent-side (swap class
      21→0 on the fixed battery).

- **K-4 ROOT-CAUSED AND FIXED (2026-07-02, commit 14f2e0a) — BATTERY RE-RUN + USER CONFIRM PENDING.**
  The deterministic dolly pops were SHADOWS: tree R1 caster onset was
  binary (fade:null) — entering the R1 band swapped a crown's shadow from
  the ~75%-density dithered proxy to FULL card+trunk casters in ONE frame;
  a grove row crossing together landed a ~60 m shadow mass instantly
  (dolly f=920, Δ27/255). Proven by frame-exact single-boot scan
  (tools/pop-scan.ts): Δ dies with ?ablate=shadows, veg.r1:+3 at the flip
  every run, and the fix (world-anchored hash density ramp on R1 caster
  onset, Forests.ts — same anti-swim law as proxyCasterMat) takes f=920
  from −26.9 to +0.00 with the same trees still crossing.
  ALSO FOUND + FIXED: impostor-band crown-proxy CASTER caps silently
  overflowed ~2× (spruce c3 15,927/8,192 — an append-order-dependent HALF
  of far crown shadows was dropped and reshuffled; caps → 24576,
  ~+1.6 MB). `veg.capOver` HUD counter now flags ANY over-cap group —
  a nonzero value is a correctness bug. ImpostorRuntime fade now obeys
  the vegViewPos law (was TSL cameraPosition). NOTE: restored far crown
  shadows CHANGE far-field pixels vs the pre-fix baseline (missing
  content restored — judged improvement; re-judge at the Phase-7 sheet).
  New instruments: pop-pair/pop-scan/pop-groups (single-boot, frame-exact,
  per-group counter diffs w/ CAP! markers), ?clsdbg=2 ring colors,
  ?vegocc, ?castpad. Eliminated by direct experiment: grass ring, GI,
  contact, cascade count/stagger/cache, caster pad, occlusion march,
  prepass, canopy shell, pose error, main-view caps, TRAA.
  DOLLY BATTERY POST-FIX (same 3000-frame push, --ablate water,particles;
  particles = wall-clock movers, same documented confound as water):
  vs pre-fix baseline (dolly-bigcaps): max sustained Δ 49.7→17.6, max
  score 83→20, events Δ≥20/255 21→ZERO, score≥15 68→3 — and all 3
  survivors are jump≪sustained (4-5 vs 13-15) = crossfade RAMPS working
  as designed in low-noise corner tiles, NOT swaps. Flashes 0. The
  instant-swap class (jump≈sustained, Δ38-50) is ERADICATED on the dolly.
  TOUR u 0-0.24 RE-RUN + THE u≈0.237 MYSTERY SOLVED (same day): the
  "noon-only repeating ~78-tile flashes" are NOT a defect — tour-mode
  pop-scan at the flash zone shows smooth ±1-2/frame luma WAVES
  (~20-frame period), phase-locked to camera position across THREE
  different boots/ablation sets (caustics ✗, froxels ✗, water+particles
  ✗) with zero 1-frame steps: coherent noon DAPPLE-SWEEP rows sliding
  under the descending camera, tripping the >2%-tiles flash heuristic.
  probe-pops flashes now record meanJ; battery gates only STEP-flashes
  (meanJ ≥ 0.5·meanS). Tour early-segment (u<0.013) floor-dapple "swaps"
  = GI convergence tail after the 120-frame pre-roll → pre-roll now 300
  (GI slice refresh ≈240 frames; onset-check discriminator: segment
  starting at u=0.05 shows ZERO swaps at its own start with the new
  pre-roll). Battery swap gate calibrated on measured class separation:
  pre-fix pops Δ38–50 at jump/Δ ≥0.85 vs benign tail Δ≤21 at ≤0.66 →
  gate Δ≥25 AND jump≥0.65·Δ. Tour raw detections rose 15.9k→37.2k
  post-fix — expected: the caster-cap fix RESTORED ~half the far crown
  shadows, so there is legitimately more dapple to sweep.
  REMAINING FOR K-4 CLOSE: battery pops gate green + USER free-flight
  confirm (K-list rule).

- **K-4 DEEP TRIAGE — STATE + EXACT CONTINUATION (2026-07-02 end of session).**
  Instruments now in place: pop probe (tour + DOLLY mode + flash class +
  fail-loud arg guards), probe-clearance, pop-crop. FINDINGS, all verified:
  (a) tour path fixed (was underground/through-canopy — biggest visible
  "pop" source, whole-frame flashes, DEAD post-fix per valid tour runs);
  (b) golden-hour tile events are dominated by WORLD-FIXED SHADOW-BOUNDARY
  SWEEPS under camera motion (crop-verified) — real image motion, NOT pops:
  tile-level detection can't separate them, hence probe default T=12;
  (c) noon dapple-arrival is the analogous noon confound;
  (d) a REAL instant-pop class exists: DETERMINISTIC per-object transitions
  (dolly repro at fixed frames f=58/329/643/920 from cam
  "-11,283,1330,1.27,-0.06" speed 0.06, Δ 38-50/255, crops saved in
  shots/wip/pops/dolly-*) — INVARIANT to occlusion march, compact caps,
  cascade stagger, TRAA resolve, and band widths (all tested by direct
  experiment this session). Suspects remaining: understory/extras single-
  ring fades, grass-ring cell quantization, per-instance variant state.
  (e) noon-only repeating flashes at u≈0.237 (~78 tiles, Δ20-26): NOT
  stagger, NOT exposure (lockexp verified airtight) — unexplained.
  CONTINUATION (next session): (1) SINGLE-BOOT pair capture at dolly f=918
  vs 924 (two-boot shots confound grass-torus init center — the chunky
  two-boot diffs in shots/wip/pops/dolly-f920-pair.png may be boot
  artifacts; the single-boot dolly delta is single-shrub-sized);
  (2) ?clsdbg=1 at that framing to identify the popping class; (3) fix that
  class's transition, re-run the dolly battery. K-4 acceptance: dolly
  pushes clean + tour flash-free + user free-flight confirm.

- **K-1 TOP CONTRIBUTOR FIXED — CUSTOM TRAA RESOLVE (2026-07-02, commit fe846ac).**
  `src/render/TraaResolve.ts` replaces stock TRAANode (`?traa=stock` = A/B
  escape hatch; identical halton sequence + view-offset lifecycle + analytic-
  velocity seam — framealign law). Three changes: (1) REST-WIDENED VARIANCE
  CLIP — γ ramps 1→3 (cvar traa_gammastill) where velocity is low (≤4 px/
  frame ramp; far content reprojects exactly under slow pan — no parallax/
  disocclusion) AND beyond the wind-fade distance (traa_far0/1 = 260/440 m),
  so near swaying foliage + fast motion keep stock-tight behavior;
  (2) CATMULL-ROM history (5-tap renormalized cross, exact center tap at
  rest); (3) PING-PONG history targets (kills stock's two full-res copies/
  frame + separate resolve RT; prev-depth disocclusion test dropped —
  variance clip covers it, verified by motion-stop probe).
  MEASURED (bm3, native, frame-aligned): rest flicker mean 0.998→0.411
  (−59%), p95 4.85→1.49, >5/255 px 4.85→1.50%; flythrough-speed pan
  3.94→3.50; fast-pan + motion-stop parity (cloudlag 9.35 vs 8.98%).
  **HF LAPLACIAN vs fresh 4×SSAA ground truth (tools/hf-energy.ts):
  custom 86.5% (textbook reconstruction band) vs stock 59.1% — the stock
  resolve was destroying ~40% of real detail at rest; this is a quality
  GAIN on both axes.** GPU parity (resolve 4.92 vs 4.85 ms encoder span,
  wall identical) — the queued "leaner resolve" perf item is NOT closed by
  this; post-chain merges continue separately.
  K-1 REMAINING: residual hotspots = near-mid canopy inside the wind gate
  (intentional — protects wind crispness; tune traa_far0 live with user),
  clouds region, far-massif speckle, and unexplained dotted-ring patterns
  (suspect probe-GI refresh grid — run `--ablate gi` probe when picked up).
  Probe pass thresholds still to calibrate once bm-sweep numbers exist
  (bake into battery + `--maxmean/--maxtile`). USER CONFIRM outstanding
  (fly camera live look — K-list rule).

- **BENCH + DEMO CONSOLE COMMANDS LANDED (2026-07-02, commit 25f6f98).**
  `bench [secs]` / `bench <bm 1-9> [secs]`: wall-dt percentiles p50-p99/max,
  fps, spike count (probe-spikes rule), cpu.update/submit + gpu medians.
  `bench ab <cvar> <a> <b> [secs]`: automated in-session ABAB — 4 alternating
  rounds with warmup, per-round rows + Δp50; the binding methodology as one
  command (use this for ALL perf claims from now on). `demo record/play/
  stop/list/delete`: 60 Hz pose track + ToD + seed in localStorage; playback
  drives the camera (fly input off), refuses seed mismatch; `demo play x`
  then `bench 30` = measured replay of a user-seen scenario. Weather is NOT
  recorded — pin manually before record AND play (documented in Demo.ts).
  E2E: tools/probe-bench.ts, 8/8 (replay end Δx=0.0). Console.findCommand
  exported (programmatic knob driving).

- **FLYTHROUGH PATH WAS BROKEN + K-4 FIRST RESULTS (2026-07-02, commit 1a6447f).**
  The pop probe's full-tour run produced huge whole-frame "flash" events;
  triage: the camera flew THROUGH tree crowns, and tools/probe-clearance.ts
  (new) showed the raw tour spline 28 m / 146 m UNDERGROUND in two spans
  (karst ridge crossing) — the live flythrough only survived via the fly
  rig's soft clamp, skimming canopy. Tour curve now rebuilt with two-pass
  arc-uniform clearance clamping (+28 m headroom → ~20 m delivered) blending
  to authored altitude within ±110 m of waypoints (composed low moments
  keep their framing; approaches read as swoops). probe-pops classifies
  simultaneous >2%-of-tiles steps as FLASH events, separate stream.
  **CORRECTION (same day): the first "ZERO events" segment results were a
  HARNESS NO-OP** — the zsh `for … in "a b c"; set -- $seg` loop doesn't
  word-split, the probe got `--u0 "0.0 0.24 a"` → frames=NaN → the capture
  loop ran zero iterations and printed a clean "0 events"; the grep filter
  hid the `flying u NaN` line. probe-pops now throws on malformed spans
  (fail-loud guard added). VALID re-runs: u 0-0.24 at defaults = 15,893 raw
  detections / 400+ events — real per-tree transition events exist (crops:
  individual crowns brightening / silhouette-shifting in sustained steps
  mid-flight, Δ 25-45/255, score 30-50). The canopy-FLASH class is still
  genuinely dead post-path-fix (valid single-run evidence + crop triage).
  Discriminating matrix in flight on u 0.14-0.24: baseline vs shadowcache=0
  (cascade stagger steps under motion are a prime suspect: c2/c3 re-fit
  every 4/8 frames — discrete far-shadow snaps while flying) vs traa=stock
  (is the far-rest widened clip box LAGGING legitimate change under slow
  flight?). Re-tune follows the verdict. Battery pops stage stays
  INFORMATIONAL until this closes. USER free-flight confirm still required.

- **K-4 INSTRUMENTED — POP PROBE BUILT (2026-07-02, commit c384700).**
  `tools/probe-pops.ts` (v3 §12.2): deterministic flythrough (Bookmarks now
  exposes `__laasDbg.flyPose(u)` — the live flythrough integrates wall dt and
  is NOT headless-reproducible), per-32px-tile sustained-step detector scored
  against each tile's own motion noise (MAD floor), run at `--slow 4`
  (quarter speed): transitions are path-POSITION-driven, so real ring swaps
  keep full step magnitude while arrival/parallax shrink 4× (raw detections
  15004→1228 on the descent segment). Online detection + quarter-res frame
  ring → every event saves a before|at|after crop strip (self-triaging).
  LIMITS (documented): water must stay `--ablate water` (wall-clock ripples
  flood the detector — lake segments produced ~90% of raw events); near
  LATERAL content at high optical flow is un-probeable without depth — the
  user's free-flight confirm covers that slice. Event taxonomy so far:
  jump≈sustained = instant swap (the K-4 target), jump≫sustained =
  single-frame transient (cascade/firefly class), jump≪sustained = fast
  crossfade ramp. Full-tour acceptance run in flight; band re-tune next.
  Threshold calibration for probe-temporal continues at bm9.

- **K-3 FIXED AT ASSET LEVEL (2026-07-02, commit 7082c4f) — PENDING USER CONFIRM.**
  StoneM 'cobble'→'fieldstone' (new preset: strata + worn facets + creases +
  grain; detail 2→3), StoneS detail 1→2, 'boulder' preset surface-geology
  bump (silhouette stays rounded — streambed art preserved, bm1/bm6 judged
  clean), rockMaterial fine mineral mottle (~12 cm octave; existing tint/
  grain wavelengths were constant across a 0.5–1 m stone → uniform gray
  vinyl). Gallery gained a fieldstone exhibit row at WORLD detail+scale
  (shots/wip/k3/gallery-fieldstone2.png — the K-3 review surface); bm4
  before/after in shots/wip/k3/. bm4 15.1M tris / 722 draws — tri delta
  bounded (+960/StoneM R1 instance). NOTE: rockMaterial mottle touches ALL
  rocks (hero/cliff included) — judged improvement, macro-meso-micro law;
  re-judge at the Phase-7 contact sheet.

- **K-2 NOT REPRODUCIBLE IN CURRENT BUILD (2026-07-02) — PENDING USER CONFIRM.**
  bm2 grazing shots at T 7.5/12/15/18.5, 1728×1117 AND native 2592×1676
  (shots/wip/k2/): no far-rim black stripe, no white tent-row shards, no
  faceted swells at any time. The 2026-06-12 fix stack (GTAO bilateral-
  collapse fallback + water fresnel flatten + horizon-tested SSR fallback +
  crowned-horizon occlusion) collectively killed the visible symptoms; the
  K-2 seed report predates user play on THIS build. Discipline: K-2 closes
  only when the user confirms live (their viewport, in motion). If they
  still see it: next documented step is the ?waterdbg=5 thick-channel rerun
  with ?lockexp=1 at T=12 (STATUS 2026-06-12 bm2 entry); the structural
  kill remains RT-1 (M2). TOOLING FIX en route: explicit ?T now overrides a
  ?shot bookmark's composed ToD (was silently ignored — pose × ToD sweeps
  were impossible; Params.timeOfDayExplicit).

- **M1 STARTED — TEMPORAL-STABILITY PROBE BUILT + K-1 ATTRIBUTED (2026-07-02).**
  `tools/probe-temporal.ts` (v3 §12.1): records CONSECUTIVE frames in-page
  (node-side screenshots skip ~15 frames — capture is drawImage→getImageData
  after each settle(1), frame counter verified +1 per step), frame-aligned to
  absolute frame anchors (rest @512, pan @800). Two modes: `rest` (frozen
  world, wind 0, lockexp — residual per-frame change = frame-indexed effects
  only) and `pan` (frame-locked yaw pan with EXACT constant-homography
  reprojection onto the previous frame — pure rotation has no parallax/
  disocclusion; absolute pan numbers carry a bilinear-resampling floor, use
  them RELATIVELY). Metric: flicker energy = mean |Δluma|/pair (8-bit units)
  per pixel + temporal std; outputs heatmap PNG, worst-48px-tile ranking,
  histogram percentiles, metrics JSON (shots/wip/temporal/). Pass thresholds
  (--maxmean/--maxtile) left uncalibrated until after the K-1 fix.
  **K-1 BASELINE (bm3, T19, native 2592×1676): mean 0.998/255, p95 4.85,
  4.85% of pixels >5/255 at REST.** Heatmap: dominant source = mid-distance
  forest canopy (R2-ring band, saturated ≥8/255), secondary = clouds region,
  far-massif rock speckle, and curious dotted-ring patterns (possibly probe-GI
  refresh grid — attribute after the fix). ABLATION MATRIX (all rest, same
  frame window): taa OFF 1.923/p95 12.87 (p50 collapses to 0.01 — statics are
  bit-stable without jitter; raw content instability is 2× what ships);
  shadowcache0 0.885; contact OFF 0.897; clouds OFF 0.930; ao OFF 1.128 and
  water OFF 1.086 (both HIGHER — luminance/content confounds: ablations that
  brighten or swap content inflate |Δ|; compare small deltas with care).
  **CONCLUSION: no auxiliary system explains the canopy shimmer — the top
  K-1 contributor is the STOCK TRAA RESOLVE at rest (varianceGamma=1.0 clips
  converged history to each frame's momentary 3×3 stats → jitter-frequency
  ping-pong on sub-pixel foliage; TRAANode.js:699). Cascade stagger and
  contact hash are real but secondary (~0.1 mean each).** NEXT: custom TRAA
  resolve (one component kills K-1's top term AND the queued 4.4 ms post
  whale + 2 full-res copies/frame): rest-widened variance clip
  (gamma motion→still ramp), Catmull-Rom history, ping-pong history targets,
  keep the halton sequence + analytic-velocity seam EXACTLY (framealign law).
  Gates: temporal probe ABAB rest+pan, HF-energy vs 4×SSAA (no softening),
  judged shots at 3 bookmarks, perf ABAB.

- **V3 SPEC ADOPTED (2026-07-02, collaborative session).** `PROJECT_LAAS_v3.md` written via
  structured interview with the user. Their calls, for the record: wildlife photography is
  the core loop (album + field journal, NO scoring/quests for now); fauna = all four classes,
  risk-ordered birds → trout → marmot/hare/fox → deer/ibex hero tier; journey-as-intro
  (~15 min) + free-roam trail network; hybrid compute RT (reflections first — kills the lake
  rim); perf contract = 120 fps base at native + console-toggleable RT/quality tiers that may
  never alter base-tier pixels; audio = full procedural with a blind "sounds recorded" gate,
  CC0 fallback per failed sound (audio ONLY — visual zero-assets law unchanged); realism pass
  order: light&color → close-up → water → distance. All four seeded K-list bugs (v3 §6)
  user-confirmed: K-1 far flicker, K-2 lake rim, K-3 blob rocks, K-4 LOD pop.
  Pointers updated: STATUS rehydration header, README, DEVIATIONS header.
  **NEXT UP: M1 — Stabilize & close v2 (v3 §14).** Order of attack: (1) build the
  temporal-stability probe FIRST (K-1's measuring stick + regression guard for all later
  TRAA/impostor work), (2) K-1…K-4, (3) queued perf (TRAA custom resolve, post merges,
  cpu.submit/draw cuts), (4) `bench`/`demo` console commands, (5) v2 Phase-7 close-out
  (bookmarks re-pose incl. bm7, 90 s flythrough, per-pass HUD, full battery, two-frame test).

- **PHASE 7 PERF — CHOPPINESS ROOT-CAUSED AND FIXED (2026-07-02).** User
  report: "choppy fps" on the M1 Max. New probe (tools/probe-spikes.ts:
  boots unfrozen, records per-frame dt via engine.onUpdate, reports
  percentiles + spike cadence) showed a metronomic hitch: EVERY 3rd frame
  ran 83–100 ms (exact 8.33 ms vsync multiples) vs a 41.7 ms median at
  bm4 user-viewport — p95 91.7 ms. NOT the CSM stagger (persisted with
  ?shadowcache=0). ROOT CAUSE: `trackTimestamp: true` + the per-frame
  `resolveTimestampsAsync` pair in Engine — timestamp writes on ~100
  passes/frame plus the query-resolve/readback serialized the pipeline
  every ~3 frames. FIX: profiling is now OPT-IN (`?prof=1`, implied by
  `?hud=1`); tools/launch.ts laasUrl() always appends prof=1 so the whole
  measurement harness is unchanged (pass extra prof='0' to measure the
  no-profiler wall). HUD without prof shows a reload hint. RESULT (bm4,
  2592×1676, ABAB): p95 91.7 → 50.0 ms, max 100 → 50.5, spikes/15 s
  65 → ZERO; bm1 mean 27.2 max 34.3. Median unchanged (GPU raster is
  untouched) — the 120 fps directive still needs the queued GPU/CPU cuts.
  ALSO LANDED (same session):
  - STATIC-MATRIX SWEEP (CPU ROUND 2 item b — DONE): main.ts freezes
    matrixAutoUpdate on every mesh/points/group after scene build (world
    transforms live in instance buffers / positionNode; movers = lights
    only, which stay auto). Anything moved later must call updateMatrix().
  - CASCADE RE-STAGGER: PERIODS [1,2,3,6]→[1,2,4,8], PHASES
    [0,1,2,5]→[0,1,2,4] — the period-3 c2 landed on c1's odd frames half
    the time and every 6th frame rendered c0+c1+c2+c3 together (frame-time
    sawtooth); powers-of-two phases are disjoint: max TWO cascade renders
    per frame. c2/c3 latency 3/6→4/8 frames = still sub-texel (far content
    rigid). VERIFIED frame-aligned vs ?shadowcache=0 ground truth: 0.05%
    pixels >12/255, mean delta 0.76 (below the ≤0.2% deterministic floor).
  - Measurement note for future sessions: any wall-time comparison against
    pre-2026-07-02 numbers must account for prof overhead — old interactive
    numbers INCLUDED the timestamp serialization hitches.

- **DEVELOPER CONSOLE LANDED (2026-07-02, user-requested — "a console
  similar to the Source engine so I can noclip and alter time scale /
  time of day").** src/debug/Console.ts: backquote drop-down overlay,
  MODULE-LEVEL command registry (registerCommand / registerCvar /
  numCvar / boolCvar — the ConVar pattern: any system contributes its
  own knobs, before or after the UI exists), Tab completion (commands +
  per-command arg completers), ↑/↓ history persisted to localStorage,
  `;` chaining, quoted args. Input handling: stopPropagation on the
  input keeps EVERY window-level game hotkey (WASD/V/F/1-9/[ ]/F3) from
  firing while typing — verified by probe. Core commands (Console.ts):
  help/find/clear/echo, noclip (fly + collision off — new
  FlyCamera.noclip skips the soft floor), fly/walk, speed, setpos/getpos
  (accepts a pasted ?cam= string), fov (new FlyCamera.setFov — CsmCached
  refits via its fov check), timescale 0.05-10 (new Engine.timeScale —
  scales updateFn dt + worldTime, re-capped at 0.25 s so ×10 can't feed
  1 s steps into walk physics; water's wall-clock TSL time is the known
  exception, same as ?freeze), freeze, stat, hud, dpr (runtime
  setPixelRatio + synthetic resize — post RTs and cascade refits follow;
  verified error-free 0.5→1.5), quit. Scene commands: time (hh:mm /
  decimal / ±relative → hooks.setTimeOfDay) + fog + wind + winddir in
  TerrainScene; shot 1-9 + flythrough in Bookmarks. E2E probe:
  tools/probe-console.ts (12 checks incl. input isolation + history +
  completion). Console open disables the fly rig (restores prior state —
  flythrough interplay) and releases pointer lock; close discards
  pending input. README updated.

- **WEATHER + CONTINUOUS DAY/NIGHT CYCLE (2026-07-02, user feature ask).**
  - DAY CYCLE (src/sky/DayCycle.ts): ToD advances on WORLD time (composes
    with `timescale`, halts under ?freeze=1 — tooling deterministic).
    Default 30 real-min/day; ?daylen=N minutes (0 = off), console
    `daylength`. Cost-tiered continuous path: EVERY FRAME sun dir/
    intensity/color + hemisphere + grade (SunSky.setTimeOfDayFast /
    applySunState refactor; Atmosphere.setSunDirOnly); sky-view LUT rebake
    strided 0.02 game-h (rebakeSkyView, no await); IBL/PMREM strided
    0.1 game-h (refreshEnvironment). Probe GI needs NO invalidate (<1 s
    slice refresh tracks the sun); cloud shadow rides its 2.5 s bake.
    Discrete jumps (console `time`, bookmarks) keep the full path.
  - CSM SUN-JUMP GATE (CsmCached): full invalidate only on a single-frame
    sun-dir delta² > 2e-4 (≈0.8°); below it each cascade adopts the
    current sun at ITS scheduled refresh (pose+map still freeze together
    → no swim; ≤8-frame far-cascade lag = sub-texel at sane day rates).
    ABAB in-session (bm1, user viewport): daylen 30 vs static
    50.3/50.1 ms p50; daylen 1 EXTREME vs static 32.8/33.2 — the cycle
    costs ~nothing. (Cross-boot A/Bs that afternoon read 2× — THERMAL,
    the methodology note stands.)
  - WEATHER (src/sky/Weather.ts): states {clear fair overcast fog rain
    storm snow} lerp (exp τ=14 world-s) cloud coverage+density, froxel
    fogK, windU.strength, and precipitation uniforms (weatherU — module
    pattern like windU). Seeded auto-Markov wander (rng stream 'weather',
    dwell 3–8 game-min; snow manual-only). `fair` == the verified art
    baseline EXACTLY: default-boot framealign diff vs pre-feature =
    0.07% (deterministic floor). Console `weather <state|auto>`; fog/wind
    cvars write through weather (stick until next state); ?weather=
    pins, ?weather=off = legacy direct knobs. Boot overrides re-apply
    post-constructor + one cloud-shadow re-bake (frozen boots never run
    update()).
  - OVERCAST FLOOR (Clouds.sampleDensity): the baked weather field's
    clear lanes are HARD ZEROS — no coverage threshold closes the deck;
    coverage > 0.7 now ramps a lane-filling floor (storm 1.0 → solid).
    ≤ 0.7 is bit-identical (default 0.62 untouched).
  - RAIN PARTICLES (Particles.ts): T_RAIN type — weather roll with canopy
    shelter ×(1−0.75·cov), falls −8.5..−10.5 m/s wind-carried, streak
    billboards along the wind-tilted fall dir, GAME-EXAGGERATED
    1.2 cm × 15–30 cm @ α 0.55 (physically-sized streaks are invisible).
    Global snow via weatherU.snow. NEW DEBUG ?partdbg=3 = TYPE CENSUS
    (emissive quads colored by type: pollen green/snow white/leaf red/
    rain blue) — proved the roll worked and visibility was the problem.
    Type-band fix: isLeaf checks were open-ended (>T_LEAF−0.5) — rain(3)
    would have classed as leaf.
  - NIGHT CLOUD EMBERS FIXED (pre-existing, surfaced by the cycle): the
    cloud march sampled sun transmittance at NEGATIVE sun elevation →
    LUT edge deep-red → midnight ember deck. Sun term now gated by the
    same above-horizon ramp as the sun light. Residual faint red horizon
    afterglow at deep night = the sun-elevation floor (−0.085) in
    SunSky.sunDirection — reads as lingering dusk, left as-is.
  - **?shot=N WALK-SNAP BUG FIXED (pre-existing, affects OLD NUMBERS):**
    the default-spawn branch set initialPoseMode='walk'; installBookmarks
    overwrote only the pose → every ?shot=N boot WALK-SNAPPED to ground.
    bm3/bm9 "vista" measurements in this file were actually GROUND-LEVEL
    framings — re-baseline before comparing. Bookmarks now set
    initialPoseMode='fly' per the programmatic-pose contract.
  - Probes: tools/probe-weather.ts (cycle rate + pacing asserts, 4-state
    transition asserts driven through the console). Shots:
    shots/wip/{weather-*,storm-final,night-clouds2,daycycle-*}.png.

- **USER DETOUR COMPLETE (2026-06-14, commit e790e07): WALK MODE +
  SPAWN + MINIMAL HUD.** FlyCamera is now a walk/fly rig — walk is the
  interactive default (spawn = first dry low-slope spot from map center,
  eye 1.7 m, facing NE massif), V toggles fly. Gravity/jump (input-
  buffered)/sprint + industry camera effects (stride-phased bob, landing
  dip spring, sprint FOV kick — CsmCached refits cascades on fov change).
  CONTRACTS: every programmatic pose (setPose/?cam/?shot/bookmarks/
  flythrough) auto-switches to FLY; getPose/P strip effect offsets; the
  fly soft-collision + underwater guard moved from TerrainScene into the
  rig. ?walk=0 escape hatch. HUD: debug panel now HIDDEN by default
  (always-on fps chip instead; F3 toggles; ?hud=1 boots open — shoot.ts
  passes hud explicitly so tooling is unaffected). PENDING USER CONFIRM:
  walk feel (speeds/bob amplitude/jump height/FOV kick are constants at
  the top of FlyCamera.ts).
  FOLLOW-UP FIXED (2026-06-12): clicks during the browser's ~1.25 s
  post-ESC pointer-lock cooldown were dropped with a console SecurityError
  ("pointer lock cannot be acquired immediately after exiting") — the rig
  now records unlockAt on pointerlockchange, DEFERS in-cooldown clicks to
  the cooldown's end (the click's transient activation still authorizes
  the deferred call), and retries bounded (3.5 s intent window) on
  pointerlockerror/rejection. Verified HEADED via tools/probe-pointerlock.ts:
  first-click lock 2 ms; click-right-after-exit re-locks unaided in
  1270 ms; no unhandled rejections.
  BROWSER GATE ADDED (2026-06-12, user-requested — Safari/Firefox fail
  to boot): src/core/BrowserGate.ts runs BEFORE any engine work:
  (1) mobile/tablet → "a computer is required" (userAgentData.mobile,
  classic UA markers, iPadOS Macintosh-UA + maxTouchPoints masquerade —
  never screen size); (2) non-Chromium → "Google Chrome is required"
  (UA-CH brands first, "Chrome/" UA token fallback — HeadlessChrome
  passes both, tooling unaffected, verified by a headless sanity boot);
  (3) Chromium without navigator.gpu → actionable checklist (update /
  hardware acceleration / chrome://gpu / Linux Vulkan flag). Adapter-null
  keeps the richer probeWebGPU diagnostics overlay (Safari 26+ claims
  dropped from its text). ?nogate=1 escape hatch. PENDING USER CONFIRM:
  live Safari/Firefox/mobile messaging (user testing themselves).

- **USER FEEDBACK BATCH 2 — COMPLETE (2026-06-12, commits f245787..ca941b9).**
  All 11 items + 3 live follow-ups landed, each verified by shots and
  committed separately:
  1. WIND REWORK (f245787→7fa4fc3): fake-skeletal hierarchy — mean lean
     ∝ strength²·exposure (cantilever (y/(y+h0))²), per-instance natural
     frequency sway 0.15–0.45 Hz/√scale (amplitude ∝ gust, NEVER
     frequency; no time×varying-freq anywhere — the phase-explosion bug
     and the shared sine tempo are gone by construction), branch motion
     lags via downwind-offset gust sampling, aperiodic flutter from
     advected fbm GRADIENT channels, all motion fades 380–480 m
     (impostors rigid). Pools: trees{1,1,6}, understory{1,1.8,0.9},
     snags stiff{0.45,0.8,6}. Grass keeps its feel + lean² rule.
     LIVE FOLLOW-UP (b9badf8): "leaves shaking wildly" — flutter was
     ±11 cm @ ~3.4 Hz decorrelation → ±2.5 cm @ ~0.75 Hz (6 m features,
     4.5 m/s advection, amp 0.3→0.07). Cards translate rigidly (vdata
     phase is per-card — verified).
  2. FOG (bce5013): fogK 1.0→0.4, noon near-zero (todK floor 0.12),
     ground-hug dominates (0.8 w, 20 m scale) vs altitude blanket (0.2),
     moisture-selective m²+0.25 floor, ambient in-scatter 0.045→0.018
     × (0.4+0.6·sunVis). Morning meadow no longer whites out at 50 m;
     dawn-lake mist survives (thinner — judge live).
  3. CAUSTIC TILING (9186b2f): tile 6→11 m w/ lattice scaled ×1.83 (same
     physical k-band), 9 waves (2 diagonals break lattice symmetry),
     STATIC fbm-gradient domain warp ±0.9 m. No repeat along 40 m of
     channel (?view=caust2 top-down).
     LIVE FOLLOW-UP (ca941b9): "horribly strong in shallow water" —
     FOCAL RAMP smoothstep(0.04,0.5,depth) (cm-deep water can't focus
     0.3–1.1 m waves); gains terrain 2.2→1.7, rocks/debris 1.6→1.3.
  5. IMPOSTOR HALO (5233b8d): capture clears to transparent BLACK and
     edge taps mixed it in → per-tile ring-BFS RGB dilation (albedo +
     normal + depth) into the empty space before composing the atlas.
  6. LOD DITHER HOLES (f245787): COMPLEMENTARY dither — fade-IN edges
     draw IGN ≥ 1−fade so paired rings partition pixels exactly; bands
     must MATCH across each boundary (ring2 got inBand=BAND1/band=BAND2
     for the impostor edge). Grass cull now double-appends boundary-band
     cells to BOTH layers (single-list assignment halved density even
     with complementary dither); caps 512k/1M/1.75M.
  10. SUN DISC (1431777): 0.014 rad (3× physical), softer limb, radiance
     120→50 SUN_E (flux ×3.7, not ×9).
  11. SILVER WASH (51e5d0d): user flagged trees, then terrain too — F0
     0.04 Schlick saturation at glancing sun. MeshPhysicalNodeMaterial
     + specularIntensity: cards 0.18 / hero leaves 0.3 / impostors 0.25
     / canopy shell 0.2 / terrain 0.35 / rock 0.4 / bark+deadwood 0.45.
     (MeshStandardNodeMaterial hardcodes F0 — physical variant is the
     sanctioned hook, same lighting model, zero cost.)
  7+9. GRASS NORMALS (a1d664f): half-cylinder rounding BAKED into
     blade/tuft vertex normals (±38°), material yaw-rotates the normal
     (was unrotated!) and blends toward TERRAIN normal 0.5→0.85 with
     distance. Sward lights like its hillside; shadows drape smoothly.
  8. FAR GRASS (a1d664f): g3 layer — coarse toroidal grid (768²×0.7 m =
     ±269 m, the fine grid physically ends at ±161 m) of wide
     super-tufts 150→265 m, kernel-density ramp-in, full terrain-normal
     shading, bend-only wind; grassThin far-collapse (120/d)^1.6; splat
     gains view-dependent directional sheen (forward-scatter toward sun,
     gated >60 m). veg.g3 counter added.
  4. SNOW: fine per user — untouched.
- **EXPOSED while fixing fog (was fog-covered; ablate-discriminated
  2026-06-12): large-lake FAR RIM = solid black stripe at grazing.**
  NOT caustics/biofilm (survives ?ablate=caustics), IS water pixels
  (vanishes with ?ablate=water): grazing fresnel mirrors the flat dark
  SSR-miss fallback where off-screen trees can't be hit. This RAISES the
  planar-lake-pass priority (was optional polish) — the old "thin dark
  band" diagnosis (min-reduced far field) is the same symptom family but
  the dominant term at bookmark 2 is the reflection fallback.
- **BLOB ROCKS — DIAGNOSED (2026-06-12), fix queued as polish.** The
  smooth featureless gray blobs (bm4 foreground, meadow top-down) are
  cls 20/21 scatter stones — ?clsdbg=1 flat-colored them hue-220 blue =
  StoneL/StoneM. They sit WITHIN the detailed ring (≤120 m), so it's the
  source geometry, not an LOD swap: VegLibrary stonePools build StoneM
  with the 'cobble' preset (d1:2/d2:1) and StoneL 'boulder' — a smooth
  river-rounded cobble at 0.5–1 m scale on a meadow reads as a shaded
  blob. FIX (when picked up): meadow-scale stones need the craggy/
  boulder-style surface (strata + fracture detail) or a detail-level
  bump in buildRock for 'cobble' ≥ ~0.4 m; verify vs bm4 foreground.
  Predates batch 2 (visible in the first fog-before shot). Also: bm7
  (forest interior) frames a trunk close-up — re-pose during Phase-7
  bookmark polish.
- **PHASE 6 COMPLETE (2026-06-12, commits eef662f..51aba85) — all six
  systems built, verified by shots, gate DELTA written.** What landed
  this session (beyond the user-confirmed water v1):
  (a) CAUSTICS: per-frame analytic bake (7 integer-lattice gravity waves,
  closed-form inverse-Jacobian — Caustics.ts), sampled by terrain + rocks
  + debris albedo w/ sun-refraction parallax, flow advection, depth
  defocus; wet waterline fringe + submerged biofilm/algae darkening;
  underwater camera guard (cpuWaterY mirror); ?caustk/?view=caust(2)/
  ?caustlit probes; tools/find-water.ts finds shallow framings from the
  CPU hydrology mirrors.
  (b) WATER LOOK FIXES: fresnel on FLATTENED normal (ripple-steep normals
  saturated Schlick → every stream mirrored noon sky as a white sheet —
  ?waterdbg=1..6 ladder diagnosed it); ripple amp to physical range; SSR
  miss fallback now terrain-horizon-tested (4 nearest height probes) w/
  probe-GI irradiance toward the ray (gorge water reflects WALLS); foam
  keyed to ≥3% grade steps; STRICT HYDROLOGY (user mandate): WATER_T
  220→320, rSurf sat 1.5/pow 2.2/cap 1.5 m — water only in channel cores,
  washes stay dry cobbled scars (shots/phase-6/aerial-strict.png).
  (c) BANK/BED DRESSING: grass/debris gates moved off the blurred
  riverDepth apron onto the ACTUAL water surface (gorge floors regrew),
  channel-scar grass thinning, cobbles persist through ≤0.55 m water,
  submerged organics float off, cobble-core boost.
  (d) HIERARCHICAL WIND (Wind.ts): gust fronts = 2 advected fbm octaves;
  whole-plant sway scaled by BAKED vdata.y flex + 3–5 Hz flutter via
  vdata.z phase (fades by 220 m); shadows share the node; trees+understory
  sway, deadfall/stones/proxies rigid (cls<15); grass tip² cantilever in
  GroundRing; canopy map = shelter. ?wind/?winddir/?ablate=wind.
  (e) FROXELS (Froxels.ts): 160×90×64 grid → scatter (height fog +
  moisture + wind billows; sun vis = terrain horizon march × canopy
  crown-band pierce × cloud shadow; HG g=0.5) + per-column closed-form
  integrate → 3D LUT composited BEFORE aerial. Dawn lake mist + glow
  verified. ?fog/?ablate=froxels.
  (f) PARTICLES (Particles.ts): 131,072 (floor 100k ✓) in ±36/±24 m
  camera box; type re-rolls from environment (snow biome / canopy leaves /
  pollen); lit quads + probe-GI ambient; ?partdbg=1/2.
  (g) WEATHER MOTION: cloud field translates downwind 22 m/s, detail
  churns at 1.35×; shadow map re-bakes every 2.5 s w/ residual-drift
  lookup; world-time driven (freeze-deterministic).
  Lakes: SSR satisfies spec ("SSR or planar"); planar pass = optional
  polish if user flags lake reflections.
- **NEXT: PHASE 7 (task #8)** — perf pass (60fps@1440p / reduced preset;
  current ~25–45 ms GPU at 1080p mixed framings), HUD per-pass GPU
  timings (fix timestamp-query overflow warning), 9 composed bookmarks
  (fold in the gate's art-direction deltas: fg hero boulders, overhang
  framing, wall-veg density, shallow-trickle reach for the final
  two-frame test — see DELTA.md Phase 6 top-10), 90 s flythrough, full
  verification battery, final two-frame test, self-score rubric.
- Phase 5/6 carried debts (fold into 7 where natural): geometric wall
  plants, moss volume geometry, noon-dapple gap re-judge, impostor depth
  parallax (D-4), distant-forest felt at vistas, 2nd cloud layer + god
  rays (froxel shafts partially cover; judge at golden-hour bookmarks),
  lake planar reflections (optional).
- PENDING USER CONFIRM: water look after fresnel/strict-hydrology rework
  (esp. river width/coverage now matching their "too much water" ask);
  wind feel (amplitude/speed live); fog density taste (?fog=N); particle
  visibility. Shadow-flicker live check still outstanding from Phase 5.
- **PHASE 7 PERF — USER DIRECTIVE (2026-06-12, BINDING; overrides the
  spec's 60fps@1440p floor upward):**
  - User: "Performance is dogshit. On my M1 max the FPS is around
    10-15." (their live interactive session; headless 1080p shots
    measured 22-30 ms GPU = 33-45 fps — gap is likely window size/DPR
    ~1.5-2 on the 3456×2234 display + TRAA history + motion. REPRODUCE
    THEIR SETUP FIRST when measuring.)
  - "Maximise performance WITHOUT sacrificing any of the visible
    detail." A UE5 scene of this complexity "would easily hit 120FPS —
    the issue isn't the scene or visible detail complexity. Everything
    in the render pipe must be optimized the hell out of WITHOUT
    sacrificing ANY quality."
  - FORBIDDEN optimization class (their example): pulling the far
    field / impostor distances closer — ANY change that reduces visible
    detail, density, draw distance, or resolution. (So: no LOD-distance
    pulls, no upscalers/dynamic res, no density cuts, no fog-as-cover.)
  - "You WILL be iterating on non-quality-decreasing optimizations
    until we hit 120FPS on my m1 max. This is not up to debate."
    Target = 120 fps ≈ 8.3 ms frame (GPU AND CPU-submit) on M1 Max.
  - PLAN (measure → rank → fix → re-measure, loop until 8.3 ms):
    1. INSTRUMENT FIRST: finish HUD per-pass GPU timings (fix the
       timestamp-query overflow warning); add per-pass labels around
       every render/compute (cascades×casters, veg rings, water, froxel
       scatter/integrate, GTAO+upsample, TRAA, bloom chain, grade,
       caustics bake, particles, probe GI slices). --gpusample medians;
       measure at the USER's real viewport (big window, DPR 2) AND
       1440p, at the heaviest bookmarks (forest hero, gorge, vista).
    2. CPU side: frame-loop profile (three.js submit overhead, 905
       draws, per-frame uniform churn, indirect-draw validation) —
       10-15 fps could be partly CPU-bound at DPR 2 + TRAA.
    3. Candidate quality-preserving whales (validate against
       measurements, not assumptions):
       - VEG RASTER: depth-only ALPHA-TESTED PREPASS for cards/grass,
         then color at depth-EQUAL → fragment shading runs ~once/px
         (classic overdraw killer, zero visual change); tighter card
         geometry hulls (trim transparent border off the quads — same
         texels, less raster); front-to-back draw order per ring.
       - SHADOWS: cache cascades — far cascades re-render every N
         frames (sun static between ToD edits; identical output),
         caster compaction already per-cascade.
       - POST: merge bloom downsample chain into compute w/ shared
         memory; merge grade/vignette/composite passes; GTAO already
         half-res+bilateral.
       - WATER: SSR hierarchical march / early-exit (same result,
         fewer steps); skip SSR entirely on pixels with no water
         (stencil/mask).
       - FROXELS: skip scatter march where T≈0 early-exit; halve Z
         slices ONLY if output-identical (verify by diff).
       - WIND/VERTEX: consolidate the 5 texture taps (gust/lag/
         exposure/flutter share fetches where math-identical).
       - Probe GI time-slicing budget; caustics bake is 0.05 ms (fine).
    4. After EACH change: tsc, visual diff at 3 bookmarks (must be
       pixel-equivalent or imperceptible), --gpusample re-measure,
       commit with numbers.
  - STATUS of pass 1 (pre-directive): 48→32 ms at forest-hero 1080p
    (half-res GTAO + bilateral, ring-1 casters to near cascades only,
    ?ablate=casters). Both changes quality-checked.
- PHASE 7 PROGRESS (2026-06-12): perf pass 1 DONE — 48→32 ms GPU at the
  forest-hero framing (half-res GTAO + joint-bilateral upsample −12 ms;
  ring-1 casters to near cascades only −4 ms; ?ablate=casters knob).
  BOOKMARKS + FLYTHROUGH DONE: keys 1–9 / ?shot=N (pose + per-bookmark
  ToD), ?fly=1 or F = 92 s Catmull-Rom tour (src/debug/Bookmarks.ts).
  Remaining Phase 7: more perf (below), reduced preset wiring, full
  battery, final two-frame test + self-score rubric, fold gate
  art-direction deltas into the bookmarks, re-pose bm7.
- **PHASE 7 PERF PASS 2 (2026-06-13, commits 0a86032..bac5cff) — landed:**
  1. PER-PASS GPU PROFILER (GpuProfiler.ts): labels every render/compute
     timestamp uid (tagGpu / ComputeNode.name / RT texture names /
     shadow.cN); Engine resolves timestamps EVERY frame (the 10-frame
     cadence overflowed the 2048-query pool — that WAS the overflow
     warning; boot world-gen still overflows once, harmless). HUD top-16
     passes; shoot.ts --gpusample prints per-pass medians.
  2. CASCADE SHADOW CACHING (CsmCached.ts): cascade i re-fits+re-renders
     every [1,2,3,6] frames, staggered phases; light pose + map freeze
     TOGETHER (a moved light over a cached map translates every shadow);
     forced refresh on sun move / >4%-span fit drift / updateFrustums.
     ?shadowcache=0. −3.9 ms avg, fps 20.1→22.2 at bm4 user-viewport.
  3. VERTEX-STAGE SHADING HOISTS: grass (albedo/normal-blend/translucency/
     AO + ring fetches), cards (hue×age factor — hueShift is LINEAR in
     base; translucency; edge fade), hero leaves, probe-GI varying in both
     patchGI's (probe grid 16 m, canopy residual 4 m ⇒ vertex eval is
     sub-quantization on ≤2 m primitives). bm4 scene −1.4, bm7 −0.5.
  4. DEPTH PREPASS (VegPrepass.ts): depth-only twins for GRASS layers +
     CARD parts (alphaTest>0), sharing geometry/indirect slot + the live
     position/mask/opacity nodes; color pass at depthFunc=EQUAL.
     Requires WGSL @invariant on clip position (installPositionInvariance
     patches the builder prototype) or Metal FMA-fuses depths apart.
     bm4 GPU 49.6→39.4 ms (r.scene 16.4→6.4). bm7 neutral (hero-ring
     vertex ×2 offsets it). Opaque bark/rock twins REMOVED — wall loss.
  5. SHADOW-PASS HASH STORM KILLED (ThreePatches.ts, d1aeb48): CDP
     profile showed ~328 FULL material node-graph hashes/frame
     (getMaterialCacheKey + cyrb53 + _getNodeChildren = top JS cost,
     scaling with cascade renders). Root cause: Renderer mutates the
     shared per-light shadow override material PER OBJECT and Material's
     alphaTest accessor bumps `version` on every 0↔cutout crossing
     (bark=0 / cards=0.32 alternate) → every shadow render object
     sharing the material re-validates + re-hashes per frame. Fixes:
     instance-own PLAIN alphaTest on shadow-pass materials (value stays
     live for the per-draw uniform; version stops thrashing) + a
     per-RenderObject getMaterialCacheKey memo keyed (material identity,
     version, contextNode.version). NOTE: a material-keyed memo COLLIDES
     builder states across geometries (getAttributes crash) — must be
     per render object. Verified: hash functions absent from a 200-frame
     profile; cpu.submit bm7 15.7→11.7 ms.
  - **FINAL COOLED BASELINE this pass (user viewport 2592×1676, 24-sample
    averages): bm1 wall 29.1 ms (~34 fps) · bm3 25.3 (~40) · bm4 42.8
    (~23) · bm7 38.0 (~26); cpu.submit 11.4-14.2; cpu.update 0.4.
    Session start (hot, bm4): 85.4 ms ≈ 12 fps. GPU-sums exceed wall
    where passes overlap (TBDR).**
  - **BUG RESOLVED (2026-06-14, commit 9728eee): CLOUDS LAG CAMERA
    MOTION** — root-caused to THREE stacked mechanisms (probe:
    tools/probe-cloudlag.ts — frame-locked orbit runs, same absolute
    frame across runs so jitter index + frameU phase match; unaligned
    in-session captures were 20-27% phase noise and useless):
    (1) TRAA SKY VELOCITY ZERO (candidate a — confirmed): sky pixels
    rasterize nothing, velocity MRT = clear 0 → resolve reprojected
    history from the same screen UV at 95% weight → clouds smeared and
    caught up over ~20 frames. Mid-pan-stop sky-band diff vs converged:
    12.24% (TAA) vs 0.17% (ablate=taa) = conviction; fixed → clouds
    region reads BLACK in the motion-stop diff.
    (2) STALE CAMERA UNIFORMS (candidate b — real, different mechanism
    than guessed): subsystems copy camera state in their own updateFns,
    but FlyCamera registered LAST in main.ts — every copy (uCamPos/
    uCamWorld/uProjInv/uView in PostStack; same pattern elsewhere) read
    the PREVIOUS frame's pose during interactive motion while the
    renderer posed geometry fresh at render time → clouds/aerial/
    froxels/contact shifted against geometry by one frame of rotation.
    setPose-driven probes can't reproduce this (they mutate between
    frames) — it's interactive-only. FIX: PostStack syncs its camera
    uniforms at render() time (after ALL updateFns, immune to order),
    FlyCamera registers FIRST and calls updateMatrixWorld() in
    update()/setPose(). NOTE the jitter half of (b) was structurally
    false: TRAA clears the view offset after every pipeline render, so
    between-frame copies are always unjittered.
    (3) DISCOVERED EN ROUTE — GEOMETRY VELOCITY GARBAGE: the velocity
    MRT is broken for ALL positionNode-displaced geometry (terrain
    CDLOD morph, instanced veg, canopy shell): three's VelocityNode
    projects raw undisplaced positionLocal, so the buffer reads
    |v|~0.5-1 NDC with a STATIC camera (?skyveldbg=raw paints it) →
    TRAA history was REJECTED (weight→1) on most geometry pixels all
    along — TAA was silently OFF for geometry. FIX: TRAA's velocity
    input is now full analytic camera reprojection from each pixel's
    own depth (exact for the static world incl. translation parallax;
    far-plane limit covers sky, no branch; wind-sway/water self-motion
    falls to variance clipping as before, now with valid history).
    VERIFIED vs 4×SSAA ground truth (HF Laplacian energy, 3 crops):
    HEAD read ~144-198% of reference (aliasing posing as sharpness),
    fixed reads 82-91% — textbook TAA reconstruction, big net quality
    win. Residual softness recovery (Catmull-Rom history sampling)
    folds into the TRAA-resolve audit below. Velocity MRT attachment
    dropped from the default path (unread rg16f write+clear saved);
    ?skyveldbg=raw|ana|err keeps the diagnostic. ?lockexp=1 freezes
    auto-exposure (pitch-orbit probes were exposure-confounded).
    FOLLOW-UPS: (i) pixel-equivalence floors RE-BASELINE after this
    commit (TAA accumulating on geometry changes converged output);
    (ii) optional future: per-material object motion vectors for wind
    sway (proper velocity instead of variance-clip rescue);
    (iii) user live-confirm the lag is gone (interactive mechanism 2
    can't be probed headless).
    1. POST-CHAIN CONSOLIDATION — DONE 2026-06-14 (commits c21867c,
       955d9ab): (a) contact-shadow march first-hit-wins early exit
       (contribution strictly decreases with step index ⇒ identical
       output; megaquad 1.64→1.51 ms at bm7 1728×1117); (b) clouds +
       GTAO + bounce merged into ONE half-res MRT pass (HalfResMrt.ts;
       Gtao.ts = faithful GTAONode port — sky discard becomes ao=1;
       attachments map by TEXTURE NAME; fragmentNode must be the MRTNode
       DIRECTLY or the WGSL output struct loses members). Per-pass at
       bm4 2592×1676: clouds.half 2.75 + GTAO 2.42 + bounce ~0.5 →
       half.mrt 2.75 (−2.4 ms encoder spans, one raster). All ablate
       combos verified. Bloom stays stall-dominated phantom — skipped.
    2. RE-ATTRIBUTION DONE (2026-06-14, user viewport, warm): NO
       per-bookmark whale — r.scene ≈ 11.8-12.3 ms at bm1/bm3/bm4 alike
       (water SSR and impostor far-field are NOT standouts); GPU passes
       overlap heavily (TBDR) and wall tracks ~24 ms while GPU-sum reads
       28-44. **cpu.submit ≈ 12-15 ms IS the binding constraint for the
       120 fps directive** (resolution-independent, draw-count driven).
    3. CPU ROUND 2 — IN PROGRESS. CDP re-profile (bm4, 200 frames):
       Bindings._update 2.64 + UniformsGroup.update 1.1 + nodes
       updateForRender 1.6 + updateMatrixWorld 0.67 (static objects
       recomposing matrices!) + _projectObject 0.51 ms/frame.
       LANDED (0f73791): runiform() = uniform().setGroup(renderGroup) —
       per-object group walks become once-per-shader-per-render-call;
       audited render-only set tagged (wind/vegViewPos/instancing
       bases/water clipmap/sun override/post+gtao uniforms). Effect at
       this slice size within thermal noise — the BULK of material
       uniforms is still object-group. NEXT STEPS, ranked:
       (a) expanded runiform sweep: audit the compute-shared set
       (camU cull copies, cloud density/drift→shadow bake, particle
       respawn, probe gather, caustics focusK) — either split material
       vs compute uniforms or verify compute update ordering, then move
       the heavy per-material params (probe-GI patch uniforms, species
       params are CONSTANTS — ideal); measure with cooled ABAB only.
       (b) matrixAutoUpdate=false sweep for static meshes (veg pools,
       terrain tiles, prepass twins) — 0.67 ms/frame of pure waste.
       (c) draw-count reduction: hand-rolled bundle path (BundleGroup
       broken in 0.184: records before async compiles, ignores
       renderOrder, bypassed per-cascade caster layers — REVERTED).
    4. TRAA CUSTOM RESOLVE (~4.4 ms at user viewport + the largest
       remaining post item): now DOUBLY motivated — leaner resolve AND
       Catmull-Rom history sampling to recover the last ~10-18% HF vs
       the SSAA reference (see cloud-lag entry). Quality-risk item:
       full shot battery + HF-energy checks against 4×SSAA required.
    5. shadow.c0 renders EVERY frame (period-1 cascade): 4.5-7.9 ms
       encoder span at user viewport — investigate quality-invariant
       reductions (caster set already compacted; check span vs stall).
    6. The 120 fps directive at 2592×1676 native on M1 Max is ~8.3 ms
       wall — after exhausting 3-5 plus format/bandwidth passes
       (R11G11B10 post RTs, f16 math in post), present the data; the
       user pre-authorized a 60 fps floor ONLY once every
       quality-invariant path is exhausted.
  - Post-chain floor after scene fixes ≈ TRAA resolve 4.4 + megaquad
    (aerial/AO-apply/contact/bounce) 3.9 + GTAO 2.4 + clouds.half 2.5 +
    bloom-real ~1-2 + screen ~0.4 ≈ 15 ms at this viewport — the next
    GPU tier once CPU is fixed: merge half-res passes (GTAO+bounce+
    clouds one MRT pass), contact-march early-exit, leaner TRAA resolve.
  - MEASUREMENT METHODOLOGY (BINDING for all Phase-7 numbers):
    (a) M1 Max THERMAL DRIFT: cross-run medians drift +50% when hot —
    only ABAB pairs / in-session 24-sample averages count; cool-downs
    between batches; (b) per-pass GPU timestamps are ENCODER WALL SPANS
    incl. dependency stalls (bloom 'cost' 9-13 ms ablated to ~1 ms wall:
    fps flat) — rank with them, VERIFY with wall fps + ablation deltas;
    (c) pixel-equivalence checks MUST use tools/shoot.ts --framealign N
    + --wind 0 + --lockexp 1: unaligned captures differ 20-27% from
    frame-indexed jitter alone, and WITHOUT lockexp the auto-exposure
    feedback amplifies wall-clock particle/water drift between capture
    times into whole-frame shifts (a 0.04%-real diff read 9.85% — flat
    surfaces cross the threshold coherently and look like a lighting
    change). Deterministic floor when fully pinned: ≤0.2%. Water itself
    still animates on wall-clock TSL time — exclude or accept;
    (d) headless fps ≈ wall only when GPU-bound; with the prepass, bm4
    became CPU-submit-bound and 10 ms GPU savings moved fps <1.
- **BUG RESOLVED (2026-06-12): HORIZON TURNS FULL BLACK — was the GTAO
  path, not aerial/CSM.** (User screenshot: shots/wip/horizon-black-user.png.)
  REPRO: lake-basin ground poses (eye ~131 m) — solid RGB(0,0,0) band at
  the far-rim/horizon line at 6 of 8 yaws (tools/probe-horizon.ts: one-boot
  yaw sweep + --scan flat-sightline finder + auto band-scan). Highland and
  spawn poses were CLEAN at every yaw — the band needs long grazing
  sightlines inside the basin, which is why bookmark sweeps never caught it.
  BISECT at the repro cam (-1400,131.6,1250,yaw45,T11): persists under
  ?ablate=water (terrain pixels — the user was right), vanishes under
  ?postmin=1 (post chain), persists under ?ablate=contact, vanishes under
  ?ablate=ao ⇒ GTAO. TWO STACKED MECHANISMS, each sufficient for black:
  (1) JOINT-BILATERAL UPSAMPLE COLLAPSE (PostStack aoFaded): tap weights
  exp2(−3.5·|Δz|) — near the horizon one half-res texel spans 10s–100s m
  of view depth, ALL four taps reject, wsum stays at its 1e-4 seed, and
  aoRaw = acc/1e-4 → 0: the upsampler FABRICATED ao=0 for every grazing
  far surface. Black is then guaranteed: the band sits INSIDE the 700 m AO
  fade-in (from a 1.7 m eye the flat-ground "horizon" is only ~300–700 m
  away ⇒ k≈0) and the dim strip gets no sun-lit exemption (directK=0) →
  aerial × 0 AFTER the haze composes — which is why it beat the atmosphere
  (Pillar D inverted). FIX: gated fallback — wsum > 0.02 (any tap within
  ~2 m) keeps the bilateral result EXACT; support-free pixels fall back to
  the plain 4-tap average. (A global +0.01 weight floor was tried first
  and REJECTED: amp-diff showed a ~1% AO wash across the bm7 hero trunk.)
  (2) GTAO KERNEL SUB-TEXEL DEGENERACY (Gtao.ts; stock GTAONode carries
  the same hazard): past a few hundred meters the 1.6 m world radius
  projects below one depth texel — samples land on the center's OWN texel,
  pass the thickness test with quantization-dominated directions
  (normalize(≈0)) and drive cosHorizons → 1 = "fully occluded". FIX:
  same-texel samples rejected (no horizon information; near-field offsets
  span many texels — unaffected) + f32 guard clamping cosHorizons to
  [−1,1] before sqrt(1−cos²) (NaN at grazing).
  VERIFIED: repro cam black-rows 5→0, min channel 0→105; 8-yaw lakeshore
  sweep 0 black rows (was 6/8); frame-aligned A/B vs pre-fix (--framealign
  200 --wind 0 --lockexp 1, 1280×720): bm7 mean-abs 0.336% with the hero
  trunk BIT-EXACT in the amp-diff (residual = sparse distant-foliage
  speckle where sub-texel noise-occlusion became valid samples — a
  correction, not a loss), bm4 0.275% pond-excluded (pond = wall-clock
  water drift vs a 40-min-old baseline, the known methodology confound).
  bm2 far-rim re-judge: see the entry below.
- KNOWN LIMITATION RE-JUDGED (2026-06-12, after the GTAO horizon-black
  fix above): the far-rim BLACK-stripe component shared that root and is
  FIXED — grazing water hits the same bilateral collapse (verified:
  lakeshore 8-yaw sweep 0 black rows, was 6/8 with solid RGB 0 bands).
  The older diagnosis trail (min-reduced far field dips, SSR-miss
  fallback at grazing fresnel) remains valid for residual NON-black
  dimming; planar-lake pass stays queued as polish.
  **NEW BUG SURFACED by the re-judge shot (NEXT IN QUEUE):** bm2
  (dawn lake, alt 9, T 7.5) renders the near water as giant faceted
  swells with bright white triangular shards at the frame edges
  (shots/wip/bm2-rejudge.png). NOT this session's AO work — ?ablate=ao
  renders identically (shots/wip/bm2-ablao.png) — and NOT present at
  noon lakeshore framings (same lake, dead flat in this session's
  sweeps: shots/wip/horizon-yaw*.png). BISECTED (same day):
  (a) ?ablate=water at bm2 — the dark swells PERSIST (they are wet
  TERRAIN: hummocky wetland-margin/bed geometry with moisture darkening,
  not water; whether that look is acceptable is an art-direction
  question, separate item) while the white shards VANISH ⇒ shards are
  water-surface fragments; (b) same pose at noon (shots/wip/bm2-noon.png)
  — identical tent row along the far shore ⇒ not ToD-specific.
  HYPOTHESIS 1 (margin salt-and-pepper wetness → coarse-vertex tents)
  REFUTED by CPU probes (tools/probe-wetmargin.ts): the area is 93.5%
  wet with ZERO isolated wet texels, and a transect along the bm2 ray
  (--transect) shows a textbook flat lake — W smooth 271.35→271.22
  over 460 m, no adjacent-sample jumps > 0.6 m, fully wet, ground
  10–26 m below W. NOTE: the bm2 water body is an UPPER lake at fill
  ~271 m, not the 131 m SW lake (and FlyCamera's fly-mode ground clamp
  silently lifts too-low --cam y values — a "y=140" probe shot
  actually rendered from ~253 m; harmless here, but remember when
  posing probes). CURRENT BEST CANDIDATE: the documented min-reduced
  FAR-FIELD DIP — levels with cell ≥ 12 m sample block minima, and
  shore-overlapping blocks pull surface patches meters below the fill
  level; those PIT WALLS seen edge-on are tilted facets that now read
  WHITE under sky fresnel. The original bm2 "thin dark band" was
  diagnosed as these same dips — the Phase-6 fresnel/SSR reworks
  plausibly flipped their read from dark to white. The tent row's
  range sits in the level-12 annulus (±384–768 m). CONFIRMATION NEXT:
  add a water-surface GEOMETRY debug (?waterdbg=7: paint
  positionWorld.y minus a reference level as emissive) at the bm2
  framing — tents colocated with min-reduce block boundaries ⇒
  confirmed. FIX SKETCH (test against the documented regression set):
  replace far-level min-reduce sampling with full-field + a
  mixed-footprint vertex gate (5 taps at ±cell/3; spread > ~1.5 m ⇒
  collapse) — polarity needs care: dry-dive values sit BELOW W on
  beaches but ABOVE W on tall banks (terrain depth-test already clips
  banks, so collapse-to-min may suffice). Regression set: tall banks,
  dry land below fill level behind the outlet dam, the inlet
  lens/dome cases that killed min-of-wet, narrow channels at
  distance, level-boundary pop. Alternatively the long-queued
  planar-lake pass / per-water-body far field solves it structurally.
  ROUND 3 (2026-06-12): the min-reduce-dip hypothesis was TESTED AND
  REFUTED for the visible shards — the mixed-footprint vertex gate
  (full-field sampling all levels + 5-tap collapse for cell ≥ 6) was
  implemented, verified present in the served module, and the white
  shards at bm2 AND both SW-lakeshore framings were UNCHANGED. The
  gate was REVERTED (never committed) per ship discipline: it didn't
  fix the target and its own benefit (flat far lakes) was never
  independently verified — re-derive from this entry if the far-dip
  item is picked up again. NEW EVIDENCE, foam channel (?waterdbg=1
  at bm2): foam SATURATES in a broad gradient across the far half of
  the lake exactly where the slabs sit ⇒ the white slabs are
  SHORE-FOAM (colorNode = white × foam, sun-lit) painted far beyond
  any real shallow zone. shoreFoam keys on vDepth =
  thick·max(|viewDir.y|, 0.06) — suspects: (a) the 0.06 grazing
  floor manufacturing "shallow" at grazing views; (b) thick =
  fragZ − zScene collapsing where the opaque depth behind far-rim
  water belongs to the BANK at the waterline (ray-thin ≠ shallow);
  (c) something zeroing thick wholesale at this framing — the
  ?waterdbg=5 (thick/vDepth) probe at bm2 painted the ENTIRE lake
  black (thick ≈ 0 everywhere?!) but that frame is UNREADABLE: the
  near-zero emissive debug dragged auto-exposure way up and the dawn
  grade washed the rest red. RERUN ?waterdbg=5 with exposure killed
  (NoToneMapping like the ?cloudview path, or ?lockexp=1, and at
  T=12 — bm2-noon shows the slabs too) before trusting any thick
  conclusion. ALSO RE-EXPLAINED: the "dark hummocky swells" — the
  waterdbg opacity-1 view shows the water mesh covering that whole
  area, so the swells are the BED REFRACTED through near-transparent
  water (opacityNode keys on the same vDepth → one false-shallow
  root, two symptoms: foam white + see-through). The earlier
  "swells persist under ablate=water ⇒ terrain" read needs
  re-judging — the bed may itself be hummocky AND the water may be
  wrongly transparent; both can be true.

## Key decisions log

- **D1** Pin three@0.184.0; mitigation for API drift: read installed source, keep notes in
  docs/THREE-NOTES.md. Downgrade to 0.180.x only if 0.184 breaks something structural.
- **D2** Tracking: STATUS.md (this file) = source of truth; harness task list mirrors phases
  (tasks #1–#8 = phases 0–7); git commit per milestone. DELTA.md / DEVIATIONS.md per spec.
- **D3** World macro-layout is code-guided for art direction (composed, per Pillar E): main
  glacial U-valley NE→SW with river → lake in SW low corner; serrated alpine massif N/NE
  (Witcher frame); tower-karst forest ravine biome center-S (scene1/3); meadows + rolling
  forest between; wetland margin at lake. Detail fully procedural + seed-driven.
- **D4** Verification screenshots: prefer headless Playwright Chromium with WebGPU/Metal flags;
  fall back to headed if headless adapter unavailable. (Resolved Phase 0 → record flags above.)
- **D5** Per-instance tree uniqueness strategy: K structural variants per species per LOD ring
  + continuous per-instance GPU deformation (lean/droop/crown asymmetry/age/hue) + bespoke
  unique meshes for nearest hero trees (background-generated, cached). Document in DEVIATIONS.
- **D6** Erosion default 2048² active grid (spec floor) on 4096² synth field; `?quality=ultra`
  runs 4096². Decide final default by measured load time (~budget ≤15 s gen).

## Architecture map (planned; update as built)

```
src/core/      Engine, Diagnostics, Params, Seed, Profiler, Quality presets
src/gpu/       passes/ (Heightfield, Erosion, Flow, Biome, Scatter, Cull, Probes, Clouds,
               Froxel, Wind, Particles, TexSynth), HiZ, indirect helpers, noise lib (TSL+WGSL)
src/world/     Heightfield(owner of terrain textures), TerrainTiles(quadtree+meshlets),
               Streaming, Biomes, Rivers, Lakes, Snow
src/vegetation/ TreeBuilder + species/, RockBuilder, GrassSystem, Shrubs, Flowers, Ferns,
               Debris, Deadfall, Dressing, Impostors
src/render/    Materials (terrain/bark/foliage/rock/water TSL), ShadowSetup(CSM+PCSS+contact),
               GIProbes, PostStack (TAA/GTAO/bloom/grade/DoF), AutoExposure
src/sky/       AtmosphereLUTs, SkyModel, SunIBL, Clouds
src/debug/     HUD, Scenes (gallery/terrain/...), Bookmarks, Flythrough, Compare overlay
tools/         shoot.ts, compare.ts, battery.ts (Playwright verification battery)
shots/         screenshot output (gitignored except curated phase closes → shots/phase-N/)
docs/          THREE-NOTES.md (API gotchas), DELTA.md, DEVIATIONS.md, COLOR-SCRIPT.md
```

## Reference image analysis (art targets)

- `scene1.png` 1920×1080-class, noon ravine: cobbled dry streambed w/ trickle, rounded mossy
  boulders, dark cliff overhangs framing top corners, lush karst towers midground, luminous
  white-blue haze bg. Shadows: blue-gray on rock, green-filled in foliage. Value structure:
  dark frame → lit mid → bright bg.
- `scene2.png` gully close-up: deadfall logs across cobbles, deep-green mossy overhang (shadowed
  but COLORFUL), sunlit tower behind.
- `scene3.png` karst forest vista: dozens of vegetated rock towers receding through 4+ haze
  layers; canopy sea between towers; soft broken-cloud toplight.
- `02_Silver_Demo_Wallpaper...png` (Witcher IV, 3840×2160): golden hour alpine; dark foreground
  outcrop + figure (silhouette framing); serrated rust-red peaks w/ slope-correct snow; conifer
  slopes down to huge hazy valley; cloud sea BELOW summits wrapping ridges; god rays from
  upper-left sun; teal-orange split (warm rock/lit conifers vs cool snow shadows/valley haze);
  scattered dead snags on right slope.
- Implied landforms: serrated ridged massif + vertical-walled tower karst + glacial valley.
  Terrain synthesis needs an explicit tower/mesa formation term, not just ridged fBm.

## Phase 1 progress snapshot (2026-06-10)

Done: synthesis (macro layout + karst towers + anisotropic ridges), pipe-model erosion
(hardness-aware thermal), multigrid lake fill, particle flow accumulation, river carve +
channel enforcement, lake w/ outlet, moisture; debug hillshade preview + `?view=hydro`.
Remaining for phase close: TerrainTiles (CDLOD quadtree + far shell), real PBR terrain
material (triplanar/splats/snow/macro variation), biome+snow classify pass, `?scene=terrain`
split view, ground-clamped camera helper, silhouette/tiling gate + DELTA.md.

## Gotchas / lessons learned (append-only)

- zsh `for x in "a b c"; do set -- $x` does NOT word-split $x (bash does) —
  $1 becomes the whole string and numeric args parse to NaN. Worse: a probe
  fed NaN can no-op cleanly ("0 events" from a zero-iteration loop) and a
  grep filter on its output hides the tell. Rules: (1) probes VALIDATE
  numeric args and throw (probe-pops does now); (2) never grep-filter a
  probe's output without keeping its parameter-echo line; (3) prefer
  explicit sequential commands over shell loops for measurement runs.
- WebGPU secure-context + headless-shell traps → see "Verified environment facts".
- TSL `.assign()/.addAssign()/.toVar()` require an active stack (inside `Fn()`); material node
  graphs are NOT inside Fn → shared TSL helpers must be pure expression builders (NoiseTSL is).
- @types/three 0.184 types nodes generically: use `Node<'vec3'>` aliases from `src/gpu/TSLTypes.ts`
  (`NF/NV2/NV3/NV4…`); bare `Node` has no operators/swizzles.
- `three` and `three/webgpu` both re-export from `three.core.js` — safe to mix imports.
- `StorageTexture` defaults rgba8unorm + `mipmapsAutoUpdate=true` (auto mips after compute
  writes when generateMipmaps). For float data set `.type = FloatType` etc.
- Verify cast shadows w/ custom `positionNode` on instanced meshes when real shadows land
  (Phase 2) — sanity scene shadows looked absent; may need `material.shadowPositionNode`.
- Compute storage-buffer limit: default 8 per stage — request more via
  `requiredLimits` (done in Engine; adapter max here = 10) AND keep kernels lean.
- TSL atomics: `instancedArray(n,'uint').toAtomic()`; then ALL access via
  atomicStore/atomicAdd/atomicLoad; `float(atomicLoad(...) as unknown as NU)` for reads
  (AtomicFunctionNode lacks value-typed methods in @types).
- mx_noise/mx_fractal outputs are SIGNED — remap explicitly or lowlands sink below
  lake level ("puddle plague").
- Relaxation-style fills propagate ~1 cell/iter: ALWAYS multigrid them.
- A lake without an outlet river floods its valley to the spill saddle.
- Endless-loop debug rule: when iterating visual passes "with no effect", first verify the
  served code changed (curl the module), THEN check upstream state assumptions.
- Per-component Rng streams (seed.rng('x')): adding draws must never re-roll other systems.
- 1D dispatch >65535 workgroups: three auto-splits to 2D and instanceIndex stays linear —
  but pad-guard every kernel (`If(i >= N) Return()`).
- RenderPipeline.outputNode runs on a QUAD camera: `cameraPosition`/`cameraWorldMatrix`/
  `cameraProjectionMatrixInverse` resolve to THAT camera (silently wrong values, no error).
  Pass scene-camera uniforms explicitly (this is why three's GTAO/TRAA take `camera`).
- Depth here is CLASSIC convention (sky/clear = 1.0). Verify per pass — don't assume
  reversed-z. Probe in-shader (paint values) rather than reasoning from docs.
- Tooling traps: vite fsevents misses tool-driven writes → `server.watch.usePolling` in
  vite.config; esbuild strips comments from served TS → grep served code for IDENTIFIERS
  only; numeric literals get rewritten (1000 → 1e3).
- `fps` in headless ≠ GPU throughput (CPU submits ahead). Use gpuPasses timestamps,
  median over many samples (`tools/shoot.ts --gpusample N`), plus `?ablate=` attribution.
- GTAONode defaults (16 samples) cost ~50 ms on 1080p terrain vistas; resolutionScale 0.5
  produced row-streak artifacts — keep full res, 8 samples.
- Filled-DEM flats have a UNIFORM ε-tilt: particles crossing them all align to it and
  print parallel straight lines. Stop particles below ~2× the ε slope (and in lakes).
- device.onuncapturederror is wired in Engine — silent black frames usually mean a
  LOGIC bug (wrong uniforms), not a validation error.
- WebGPU `readRenderTargetPixelsAsync` rows are TOP-left origin — flipRows()
  before building DataTextures or every capture is v-flipped (was invisible on
  near-symmetric sprays, obvious on trees).
- Capture scenes MUST use DoubleSide materials — leaf blades facing away from
  the ortho camera get backface-culled and the atlas comes out empty (bit the
  broadleaf tiles; conifer needles survived by accident of normal tilt).
- Real-geometry needles at true scale are sub-pixel at review distance — they
  vanish under TRAA. The ez-tree lesson: lushness = BIG captured cluster cards
  (one card = a whole painted spray); real needle geometry is for the hero ring
  where pixels exist. Hybrid (cards + mesh) wins close-up.
- Tree structure realism (user feedback): foliage must sit on a FINE twig level
  (planar two-sided branchlet lattices for conifer boughs / distichous beech
  twigs), never directly on primaries — `planar` LevelParams flag.
- Auto-exposure note again for assets: albedo tweaks barely move the frame;
  judge materials by RELATIVE contrast (bark vs foliage vs ground).
- 8-bit capture of dark albedos bands — sqrt-encode at write, square at sample
  (foliage atlases, bark, impostors all do this).
- Broken-trunk taper: trunk points span only the kept length — taper must use
  t×brokenTop or the break ends in a spike and the jagged cap never triggers
  (also: don't double-cull children above a break that's already shortened).
- TSL toVar/assign (incl. inside helper fns like a hash!) need a Fn() stack —
  material node graphs DON'T have one. Shared helpers must be PURE expression
  chains (pcg2d was rewritten for this).
- WGSL buffer indices must be i32/u32: a float select-chain `.toInt()` can
  still emit an f32 var as index — use int(0).toVar() + If-assigns.
- sim-res hydrology vs full-res height: W−h and riverDepth comparisons need
  generous thresholds (≥0.25 m) or interpolation mismatch flags whole
  floodplains as "under water" (silently deleted 53k trees + all grass there).
- three shadow contract for custom materials: shadow alpha = colorNode.a ×
  alphaTest copy — vec3 colorNodes silently discard ALL caster fragments.
  Pin vec4(rgb,1) + maskShadowNode for alpha-tested cutouts. Instanced
  positionNode ALSO needs castShadowPositionNode set explicitly.
- Custom instancing must rotate normals: assign normalLocal inside the
  positionNode Fn (three's own InstanceNode mechanism). "Quasi-radial normals
  don't need rotation" is wrong — per-fragment lighting flips sides.
- frontFacing-based debugging on DoubleSide cards is ambiguous (rolled quads
  show both faces) — verify winding on closed tubes or single-sided geo only.
- FlyCamera owns camera orientation: scenes can't lookAt; pass spawn pose via
  hooks.initialPose (applied after the rig exists). ?pitch= now works.
- Indirect-draw stack that works on three 0.184/WebGPU: Mesh (not
  InstancedMesh) + geometry.setIndirect(attr, byteOffset) + instanceIndex
  reads via compact list; counts written by compute into the SAME
  IndirectStorageBufferAttribute via storage(); frustumCulled=false.
- CSMShadowNode (three 0.184): cascade shadows CLONE light.shadow — set
  sun.shadow.camera.near/far EXPLICITLY (defaults near .5/far 500 <
  lightMargin → empty maps, no errors). Lazy _init samples the projection
  at first material build (TRAA jitter/boot transients → NaN extents cached
  forever); apps must call updateFrustums() after camera changes — we
  refresh jitter-stripped + verify finite + resize hook (ShadowSetup).
- Shadow-debug traps that burned hours: (1) judge shadow PRESENCE only with
  the sun positioned so shadows fall TOWARD the camera (they hide behind
  casters otherwise — false "doesn't cast" reads); (2) FlyCamera owns
  orientation — debug scenes MUST set hooks.initialPose or every shot frames
  the wrong spot; forward = (−sin yaw, 0, −cos yaw); (3) headless static
  shots ≠ user's interactive session (DPR 1.5, window resizes, continuous
  motion, TRAA history) — verify BOTH before declaring lighting fixed;
  (4) ablate evidence goes STALE after upstream fixes — re-run the matrix.
- vdata trick for artifact triage: ?clsdbg=1 flat-colors every veg class
  (hue = cls·47°) — identified "dark slabs" as beech cards in minutes after
  hours of wrong guesses (they were SPECULAR-washed cards: one flat normal
  per card ⇒ uniform silver sheen at glancing sun; foliage cards must be
  near-diffuse, roughness .92).
- **TSL `cameraPosition` is PER-PASS** — in the shadow pass it's the cascade
  shadow camera (~lightMargin away from everything). ANY camera-distance
  logic that discards/collapses geometry (LOD fades, distance culls,
  billboard shrink) silently deletes those casters from EVERY cascade map
  while the main view stays perfect ("vegetation casts no shadows" bug —
  weeks of misdirected CSM debugging). Route fade distances through an
  explicit main-camera uniform (vegViewPos in VegInstance).
- maskNode vs maskShadowNode (three 0.184): maskNode discards in the MAIN
  pass; the shadow pass uses maskShadowNode ?? maskNode. Dither-fades belong
  in maskNode with maskShadowNode pinned (cutout or bool(true)) — if both
  rings of an LOD crossfade dither the SHADOW pass with the same IGN,
  correlated texel holes thin the shadow exactly at every ring band.
- Differential debugging beats layer-bisection when a system "half works":
  the user's "terrain casts, vegetation doesn't" + "stones cast, trees
  don't" observations localized in minutes what ablate-matrix bisection
  (filter/post/GI/material/cascades) couldn't — ask WHICH objects differ,
  not WHICH pipeline stage.
- Shadow-proxy lessons (user-reported "small objects, massive flickery
  shadows in a circle"): (1) proxy dims must FIT the pool's real geometry
  (class-max cull bounds oversize small variants ~2×); (2) NEVER dither
  shadow casters with screen-space IGN — cascade boxes refit every frame
  so the pattern swims = flicker; anchor dither in WORLD space
  (hash12(positionWorld)); (3) texel-metric PCSS penumbra caps are
  cascade-relative — 14 texels = 28 cm near, 21 m far; convert blur to
  WORLD meters via reference('left/right/near/far', shadow.camera);
  (4) any caster-reach cutoff by camera distance prints a visible CIRCLE
  on the ground from altitude — fade casters out (impostor-band proxies
  to 1.1 km), never hard-stop them.
- An "identical render" after a lighting change usually means auto-exposure
  re-normalized it away: judge lighting work by ablate A/B DIFFS and the
  ?view=probes ambient view, not by absolute frame brightness.
- MeshGrower enforces NO winding convention — every generator owns its own.
  Tube basis (N, B=T×N) needs base-ring-first quads (a[k], a[k+1], b[k+1],
  b[k]) for outward fronts; an x/z lathe param (cos a, ·, sin a) is LEFT-
  handed → the MIRROR order; caps advancing along −T flip handedness again.
  DoubleSide masks reversed winding silently (bark "insurance" hid the tube
  bug for two phases) — FrontSide materials (deadwood/mushroom/rock) expose
  it. User-reported on logs/stumps/branches; fixed at source 1a80f86.
  Also: tubes have no ring-0 cap — fine attached to a parent, an OPEN HOLE
  on free-lying deadfall (capBase opt). Verify new closed geometry with
  ?facedbg=1 (front green / back red) before shipping it.
- flowStrength is a SHARED driver (carve depth, moisture, splat beds, veg
  gates, boulder affinity). NEVER retune its threshold for rendering — the
  whole world re-layouts (rivers move, forests shift). Split thresholds:
  RIVER_T = terrain texture, WATER_T = visible water (FlowRivers).
- Pond/lake water surface must be the FILL LEVEL W (flat per pond, meets
  terrain at the true shoreline). bed + blurred(depth) builds 30 m faceted
  water towers wherever deep pots abut high ground (blur smears depth onto
  ridge cells). Dry cells in the render field sink below the 3×3
  NEIGHBORHOOD-MIN bed (own-bed−2 still stands above channel water on tall
  banks = water walls). Wet cells get 2 smoothing iterations (wet-masked)
  or cascades render as 2 m staircase shards.
- Water clipmap traps: (a) far levels MUST sample a min-reduced field —
  coarse verts on the full field stretch one wet texel across a 48 m cell
  ("mountains half under water" from afar, gone up close); (b) clamp-to-
  border sampling extends any wet border texel into an infinite off-world
  sheet — hard world-bounds mask in the material; (c) animated foam must
  advect with the TWO-PHASE flowmap like the normals — linear time
  advection slides thresholded fbm level sets into hard white stripes.
- Water fresnel MUST use a flattened normal (n.xz × ~0.3): per-pixel
  ripple tilt explodes (1−cosθ)^5 at ANY view angle → 100% sky mirror =
  "white sheet over every stream". Ripples shape WHAT reflects (rdir),
  the MEAN surface decides HOW MUCH. Debug ladder ?waterdbg=1..6.
- SSR sky fallback must be terrain-horizon-tested: a gorge stream "sees"
  walls in its mirror, not open sky — 4 nearest height probes along the
  reflected ray + probe-GI irradiance toward the ray as the occluded
  fallback (the probe field already knows wall/canopy brightness).
- Veg/debris water gating must key on the ACTUAL water surface (waterY),
  never the riverDepth apron (widen-blurred ~0.12 m floor flags whole
  gorge floors "river" → bald banks). Generous ≥0.25 m thresholds only
  apply to W−h comparisons (sim-res interpolation), not waterY−h.
- Per-frame StorageTexture mips DO auto-regenerate after renderer.compute
  (mipmapsAutoUpdate default) — .bias() depth-defocus on the caustic tile
  works; verify mips with a forced-bias debug view before trusting them.
- AUTO-EXPOSURE eats naive emissive debug probes: a 131k-quad emissive-40
  wall crushed the whole scene black and read as "particles broken" — when
  a debug overlay must be judged, render it DIM (≤2) or kill exposure
  (?cloudview-style NoToneMapping path), and remember transparent quads
  behind water depth-fail (water writes depth).
- TSL `time` is NOT frozen by ?freeze=1 (only engine worldTime is): two
  shots with different --settle counts sample different wind/water phases
  — that's the cheap motion A/B; anything that must stay deterministic
  per-shot (cloud drift) must run on WORLD time via a CPU uniform.
- UPDATE-ORDER CONTRACT (cloud-lag postmortem): updateFns run in
  registration order; anything that MOVES the camera must register before
  anything that COPIES camera state, and movers must updateMatrixWorld()
  (matrixWorld otherwise recomposes only at render). FlyCamera registers
  first in main.ts; PostStack ignores the contract entirely by syncing at
  render() time. The flythrough (installBookmarks, registered late in the
  scene build) still moves the camera after earlier-registered subsystem
  copies (cull/water/froxels) — one-frame staleness there is bounded
  (overlap bands absorb it) but don't add new screen-space consumers to
  onUpdate; sync them at render time like PostStack.
- Headless setPose probes CANNOT reproduce interactive camera-motion bugs
  in updateFn-order territory: setPose mutates between frames, so every
  updateFn sees the fresh pose. Mid-update mutation only happens via
  FlyCamera/flythrough — reason from code order, verify live.
- Pointer-lock verification traps: headless Chromium rejects EVERY
  requestPointerLock with WrongDocumentError ("root document not valid") —
  pointer-lock UX is only probeable HEADED (chromium.launch headless:false),
  and the window needs page.bringToFront() or macOS never grants focus and
  the request silently never resolves. A Playwright-synthesized Escape does
  NOT reach the browser's pointer-lock accelerator — exercise the cooldown
  via document.exitPointerLock() instead. Also: tsx/esbuild injects a
  `__name` helper around named function expressions inside page.evaluate
  callbacks → ReferenceError in the page; pass big instrumented blocks as
  STRING evaluates (tools/probe-pointerlock.ts documents the pattern).
