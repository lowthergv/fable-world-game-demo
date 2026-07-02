# PROJECT LAAS — v3
### The living world — from procedural showcase to wildlife-photography game
*(laas — Estonian: old-growth forest)*

---

## 0. Standing on v2

v2 built the world: Phases 0–6 are closed (terrain, atmosphere, GI, vegetation, scattering,
water/wind/particles), Phase 7 (perf + composition) is open. **v3 supersedes v2 as the binding
spec.** Everything v2 established remains law unless this document amends it: the six pillars,
the §2 floors (now regression floors — see §5), the banned outcomes, the surface & asset laws,
the verification discipline. `PROJECT_LAAS_v2.md` stays in the repo as history. `STATUS.md`
remains the operational source of truth and rehydration protocol; its pointer moves to this file.

v3's mission: **turn the world into a game.** The player is a wildlife photographer. The world
gets inhabitants worth photographing, sound worth listening to, places worth finding, and the
stability and frame rate that make all of it feel real under the hand.

---

## 1. The bar

Two bars now, judged independently:

**The world bar (inherited).** Current-generation UE5 showcase footage; the four reference
images in `/reference`. The two-frame test from v2 still stands and still gates final acceptance.

**The photograph bar (new).** The player's in-game photos are the new judged artifact. A
captured photo of an animal in its habitat is placed beside a real wildlife photograph of the
same class of subject (raptor in flight, ibex on a ridgeline, deer in forest light). The test is
unchanged in spirit: does the eye snag on a *category* error within one second — robotic pose,
dead eye, fur that reads as noise, feet floating off the ground? **An animal that cannot survive
its photograph does not ship.** It stays in the gallery until it passes.

**Reference-delta loop (mandatory, every milestone):** unchanged from v2 — closest matching
shot, side-by-side, `DELTA.md` top-ten ranked by impact, fix the top three, re-render, then close.
Fauna milestones run the same loop against real wildlife photography.

---

## 2. The nine pillars

A–F inherited from v2 verbatim: **A. Geometry, not textures. B. Light transport. C. Nothing is
bare. D. Distance holds. E. Art direction. F. The world moves.** Three new:

**G. Alive, not decorated.** Animals are inhabitants, not props. They perceive (sight, sound,
wind-carried scent), decide, and move with weight — feet plant on the actual terrain, bodies
breathe at rest, ears flick, gaits blend with speed and slope. A deer that slides, teleports,
pops into view, or ignores the player standing upwind has failed this pillar regardless of how
good its mesh is. *Rule: watch any animal for ten seconds — if nothing about it surprises you,
its behavior is too simple; if anything about it reminds you of a video game, its motion has
failed.*

**H. Playable first.** Frame pacing is part of the art. A hitch during a pan ruins the photograph
and the illusion; input latency ruins the hand-feel. The base experience holds the performance
contract (§6) at all times — no feature ships by making the world stutter. UI is quiet, minimal,
and hideable: the game should photograph well with zero HUD pixels.

**I. Heard before seen.** The world has a voice: wind that moves with the trees you see moving,
water that sounds like its flow rate, weather you can hear arriving, and animals that announce
themselves before they show themselves. Sound is a gameplay sense, not decoration — the marmot's
whistle is how you find the marmot. *Rule: close your eyes for thirty seconds anywhere in the
world — if you cannot tell roughly where you are and what the weather is, audio has failed.*

---

## 3. Operating instructions

Inherited: build, don't describe; between two approaches build the more ambitious; no stubs; a
`TODO` in a closed milestone fails it; never ask the user to lower the bar; infeasible item →
nearest feasible alternative + `DEVIATIONS.md` entry. New and amended:

- **STATUS.md protocol is binding.** Read its top + "Next actions" before working; append dated
  entries after milestones; commit per milestone with descriptive messages.
- **Measurement methodology is binding** (STATUS.md "MEASUREMENT METHODOLOGY"): performance
  claims use in-session ABAB pairs only — cross-boot medians drift up to 2× with thermals on
  this machine. Pixel-identity checks use `--framealign N --wind 0 --lockexp 1`.
- **The no-quality-loss law:** optimizations must never reduce visible detail, density, or
  resolution. Enforcement is mechanical where possible: frame-aligned pixel diff vs the
  pre-change baseline at the deterministic floor (≤ ~0.2% pixels), judged shots where not.
- **User feedback jumps the queue.** The user plays between sessions; their reports enter the
  Known-defect list (§5) with repro notes and outrank planned work. A user-reported defect
  closes only with user confirmation.
- **Console-first instrumentation.** Every new system registers its knobs in the ConVar
  registry (`src/debug/Console.ts`) the day it lands — debug views, toggles, tuning values.
  If it can't be poked from the console, it isn't finished.
- **Determinism extends to everything new.** `?seed=N` reproduces fauna populations, behavior
  streams (per-system named rng streams, as `'weather'` does today), landmark names, and audio
  variation. Tooling escape hatches follow the `?weather=off` pattern: `?fauna=off`,
  `?audio=off`, `?rt=off` — frozen boots must stay bit-comparable for the framealign law.

## 4. Fixed constraints

| Constraint | Value |
|---|---|
| Language | TypeScript, `strict: true`, zero `any` |
| Build | Vite |
| Renderer | three.js WebGPURenderer + TSL; raw WGSL compute wherever TSL limits you. **No WebGPU ray-tracing API exists — all RT in §7 is compute-shader RT over our own BVH.** |
| Fallback | None. Chrome/WebGPU only, pre-boot gate as shipped. Fail loudly. |
| Assets | **Zero external assets** for everything visual: meshes, textures, atlases, LUTs, noise — generated by code. **Audio-only amendment (§11):** procedural synthesis first, always; a sound that fails the lifelike gate after documented iteration MAY be replaced by a public-domain/CC0 field recording, logged in `DEVIATIONS.md` with provenance. Visual assets get no such exception. |
| Determinism | `?seed=N` reproduces the entire world including fauna and toponyms. |
| Persistence | Player data (album, journal, map reveal, settings, binds) in IndexedDB/localStorage, keyed by seed. No servers. |
| Target hardware | The user's machine is the primary target: Apple M1 Max, Chrome, 120 Hz, native viewport 2592×1676. Secondary aspiration: 60 fps @ 1440p on RTX-3060-class. |

## 5. Floors

**Inherited floors (v2 §2) are now regression floors.** Triangle throughput, species counts,
grass/debris/particle budgets, GI/shadow/cloud/atmosphere requirements, draw-in discipline —
all remain binding minimums. Optimization work that dips under any of them is a failed
optimization (no-quality-loss law).

**New floors — the game era:**

| Dimension | Floor |
|---|---|
| Fauna roster | ≥ 12 species by M7: ≥ 4 birds (incl. a hero raptor), 2 ungulates (forest deer + alpine ibex), ≥ 3 small ground mammals (incl. alpine marmot), ≥ 1 stream fish, ≥ 2 ambient insect classes (butterflies, dragonflies). Every individual unique: per-instance size/coat/age/antler variation from its own seed. |
| Fauna fidelity | Hero ungulate ≥ 250k tris effective incl. fur shells; hero bird ≥ 60k tris + layered feather cards with anisotropic sheen; eyes are wet, catchlit spheres, never flat texture. Macro–meso–micro law applies to hide, feather, and fur. |
| Animation | Terrain-adaptive IK foot placement (no foot-sliding, no floating — ever); ≥ 3 blended gaits per ground species; idle secondary motion (breathing, ear/tail flicks, head turns); birds get flap/glide/soar morph + banking; GPU skinning, instance data on GPU (CPU per-instance updates stay banned). |
| Behavior | Perception model: vision cone + hearing (player noise level: crouch/walk/sprint) + wind-carried scent using the live wind field. ≥ 5 states (rest/forage/alert/flee/travel) + ≥ 1 species-special (marmot sentinel whistle, heron strike, raptor thermal-circling). Species-correct flight distances. Spawning is ecology-driven: biome × time-of-day × weather (deer at forest edges at dawn; marmots sunning on warm rock; trout rising in rain). |
| Photo mode | Focal 24–600 mm; aperture-driven DoF; exposure compensation; manual/auto focus; capture renders at ≥ native res with a supersampled high-quality still option (the still may spend 200+ ms). Capture detection via species-ID mask render at shutter time (subject %, focus, occlusion) — no heuristics. Photos carry metadata (species, ToD, weather, location). |
| Journal & map | Album + field journal: per-species pages (discovery state, best shot, observed behaviors) and landmark pages. ≥ 20 named landmarks with seeded Estonian-flavored toponyms. Procedural cartographic map (contours from the heightfield, biome washes, hand-drawn styling) revealed by exploration; vantage points reveal regions. |
| Audio | ≥ 20 distinct procedural sources across wind/water/weather/footsteps/species; HRTF spatialization; terrain/canopy occlusion filtering; no audible loop shorter than ~2 perceived minutes; every shipped sound has passed the blind lifelike gate (§11) or carries a DEVIATIONS fallback entry. |
| Ray tracing | BVH over terrain + static instances with refit budget ≤ 2 ms/frame (or a static+proxy scheme that hits the same visual gate); RT water reflections ≥ half-res with TRAA integration on lakes and wide streams. |
| Stability | Temporal-stability probe (§12) passes at rest and in flight; zero perceptible LOD pops at ≤ 300 m (inherited) and no distant flicker at any range (new — see K-1). |

## 6. Known-defect burndown (the K-list)

Live list; user reports append here with repro and rank first. Each closes only with
user confirmation. Seeded from user play through 2026-07-02:

- **K-1 — Far-distance flicker.** In the fly camera, distant features shimmer/flicker.
  Suspects, in investigation order: TRAA resolve on sub-pixel geometry (impostor fields,
  serrated ridgelines), impostor dither crossfade at range, cascade shadow swim on far
  content, z-precision on the far shell. Fix requires a *metric*, not a vibe: build the
  temporal-stability probe (§12) first, then attack the top contributor. Acceptance: probe
  passes at rest and at flythrough speed on the worst vista; user confirms.
- **K-2 — Lake far-rim black stripe.** Grazing-angle fresnel mirrors the flat dark SSR-miss
  fallback on the large lake (STATUS 2026-06-12). Planned kill: RT reflections (§7). Interim
  mitigation acceptable (sky-fallback from the LUT instead of flat dark) if RT slips a
  milestone. Acceptance: bookmark-2 grazing shot clean at all ToD.
- **K-3 — Blob rocks.** Meadow-foreground scatter stones (StoneL/StoneM, cobble preset) read
  as smooth gray blobs at 0.5–1 m scale (bm4). Fix: craggy/boulder-style detail for cobble
  preset ≥ ~0.4 m, per the diagnosis in STATUS. Acceptance: bm4 foreground survives the
  silhouette test.
- **K-4 — LOD pop / visible transitions.** Impostor and grass-ring transitions visible in
  flight despite dithered crossfades. Instrument first (`?view=lod` exists; add a pop probe —
  §12), widen/re-tune the offending bands. Acceptance: repetition flight shows zero
  perceptible pops; user confirms during free flight.

## 7. Performance contract

- **Base tier: 120 fps at native viewport (2592×1676) with zero visible quality loss** —
  the standing directive. Everything shipped through v2 belongs to the base tier. This is a
  target with teeth: misses are never silently accepted; every perf session ends with an ABAB
  table, per-pass GPU budgets, and the ranked next cuts in STATUS.md.
- **Feature tiers:** RT and realism features that cannot fit the base budget land as
  console-selectable tiers (`quality base|high|ultra`, plus per-feature cvars — §13). A tier
  may cost frames; the base tier may not. Every tier documents its measured cost per bookmark
  in STATUS.md. A tiered feature that alters base-tier pixels is a bug (framealign law).
- **Queued base-tier work** (from STATUS, in rank order): TRAA custom resolve, post-pass
  merges, cpu.submit/draw-count reduction — plus whatever the K-1 investigation surfaces.
- **Frame pacing is a first-class metric:** p95 and spike cadence (tools/probe-spikes.ts)
  matter as much as the median. A 120 median with every-Nth-frame hitches fails (we've had
  exactly this bug; the probe exists because of it).
- New systems budget up front: fauna (skinning + behavior + fur overdraw), audio (worklet CPU),
  RT (ray + refit) each get an explicit ms budget at design time and an ABAB check at land time.

## 8. Ray tracing — hybrid, compute-shader, staged

Honesty first: WebGPU exposes no ray-tracing hardware API. We build our own — LBVH construction
and WGSL traversal in compute. This is proven territory but every ray is paid in compute; rays go
only where raster demonstrably fails.

- **RT-0 — Foundation.** GPU LBVH over terrain tiles + static instance AABBs (trees as
  coarse proxies: trunk capsule + crown ellipsoid; wind excluded from geometry, handled by
  proxy inflation). Debug views (`rt_debug`: BVH heatmap, ray-hit view). A benchmark scene
  measuring Mrays/s on the M1 Max at native — this number calibrates everything after.
  Gate: measured budget table in STATUS.md.
- **RT-1 — Water reflections.** Ray-traced reflections on lakes and wide streams at ≥ half
  res, TRAA-integrated, replacing the SSR fallback (kills K-2). Off-screen trees, correct
  grazing behavior, cloud reflections from the sky LUT on miss. Tier: high (base keeps
  improved SSR + LUT fallback). Gate: bookmark-2 grazing shot + reflection side-by-side vs
  reference 4's water.
- **RT-2 — Shadow rays.** Targeted rays where CSM is weakest: distant terrain self-shadowing
  beyond cascade range, and contact-shadow replacement on hero subjects (an animal's grounding
  shadow in a photograph must be exact). Tier: high/ultra. Gate: shadow side-by-side battery
  + zero regression on the shadow-color test.
- **RT-3 — RT ambient/GI assist (stretch).** Short AO/bounce rays on hero surfaces (rock
  faces, animal fur occlusion) to deepen the probe-GI result up close. Tier: ultra. Only if
  RT-0's numbers say it fits.

## 9. The realism pass — four domains

Ranked by user priority; all four matter. Each domain runs its own reference-delta loop and
closes with a judged side-by-side. The photograph bar (§1) applies: test frames are *photos
taken in-game*, compared against real photographs, not just against the four references.

1. **Light & color.** The photographic feel: film-response tone curve evaluation (current AgX
   vs alternatives), exposure behavior under scene changes (no pumping), golden-hour and
   overcast moods hitting the color script, night believability. Sun disc/limb, horizon
   science near dusk. This domain multiplies every other — it goes first.
2. **Close-up ground & materials.** The 0–10 m read under a 600 mm-equivalent stare: micro
   shadowing, moisture response, translucency depth on foliage, litter density, tiling
   invisibility. Silhouette test at macro distance.
3. **Water.** RT-1 reflections + depth color, foam behavior at obstacles and shores, flow
   line believability, rain response on surfaces (ties to weather + audio).
4. **Distance & mountains.** Peak crispness through TRAA (couples to K-1), aerial perspective
   correctness at all ToD, canopy-sea texture at 1–4 km, cloud/summit interplay.

## 10. Fauna — the inhabitant program

The hardest new asset class in the project, held to the highest bar (§1: an animal that cannot
survive its photograph does not ship). All procedural: mesh generation (parametric body plans →
species parameters), fur as shells+fins near / cards far, feathers as layered cards, GPU skinning,
behavior on GPU-friendly data. Per-individual seeds (the tree law applies to animals: no clones).

**The gallery is the gate.** `?scene=gallery` grows a fauna wing: every species × 3 seeds on
pedestals, plus a **gait treadmill** (`?scene=gaits`) — each species cycling through its gait
blends on adjustable slope, the primary review surface for motion quality before any animal
enters the world.

Waves, ordered by risk (each wave = generator + animation + behavior + audio voice + journal
entry + gallery + reference-delta vs real wildlife photos):

- **W1 — Birds + insects** (with M3). Distant flocking (starling-cloud class), corvid/chough
  flocks riding ridgelift, 2–3 songbird species in canopy, **hero raptor** circling thermals
  (the first hero photo subject — soar/bank/flap morph, feather detail). Butterflies in
  meadows, dragonflies over water. Birds animate the sky and prove the pipeline.
- **W2 — Aquatic** (with M4). Brown trout holding station in stream current (visible through
  the refraction you built), darting on disturbance; rise rings on lakes in rain/dusk.
  Cheap, and it makes the water system pay rent.
- **W3 — Small ground fauna** (with M6). **Alpine marmot** (sentinel posture, whistle — the
  audio-gameplay icon), mountain hare (bound gait, freeze behavior), red fox (patrol,
  pounce). First terrain-IK ground animals.
- **W4 — Ungulates, hero tier** (with M7). Forest red deer (herds at forest edges, dawn/dusk
  activity, antler variation, bellow) and **alpine ibex** (cliff-capable locomotion on the
  steep faces, ridgeline silhouettes — the golden-hour money shot). Full fur pipeline,
  multi-gait blends, herd behavior. The program's final exam.

**Perception & stealth (lands with W3, retrofits W1/W2):** animals sense the player via vision
cone (with foliage concealment), noise (crouch/walk/sprint levels), and scent carried by the
live wind field — approach upwind and you get closer; the wind system becomes a gameplay verb.
Alert states cascade through nearby animals (the jay scolds, the deer lift their heads).

## 11. Audio — the procedural soundscape

WebAudio + AudioWorklet DSP, synthesized from world state. Zero samples, with the audio-only
fallback clause of §4.

- **Ambient bed:** wind synthesis modulated by local canopy density and the live gust field
  (the trees you see move are the trees you hear); water by flow speed/depth/width (riffle vs
  pool vs fall); rain differentiated by surface (canopy patter vs open ground vs water);
  thunder with correct flash-to-rumble delay (storms gain lightning flashes — visual lands
  with this); snow silence (storm states duck the world naturally).
- **Contact:** footsteps by surface class (rock/soil/litter/grass/snow/shallow water) and
  gait; foliage brush-past.
- **Voices:** per-species synthesized calls — songbird motifs with variation grammar (no two
  phrases identical), marmot whistle, corvid rasp, raptor cry, deer bellow, woodpecker knock
  as a forest clock. Distance, HRTF panning, terrain/canopy occlusion filtering.
- **The lifelike gate (blind test, binding):** each sound class is A/B'd blind against a real
  field recording by the user. Clearly-synthetic verdict → iterate (documented attempts);
  still failing → the CC0 fallback clause activates for that sound only, with provenance
  logged in `DEVIATIONS.md`. The bar is "I'd believe this was recorded outdoors," not
  "impressive for synthesis."
- **Audio as gameplay:** hear-before-see is a design requirement — species voices are
  locators; the journal can cite "heard" as a discovery state before "seen."

## 12. Verification battery v3

Inherited from v2, still run at milestone close: reference-delta loop, silhouette test,
shadow-color test, bare-ground test, repetition flight, throughput floors, contact sheet. New:

1. **Temporal-stability probe** (builds on tools/probe-spikes.ts patterns): frame-aligned
   sequences at rest and at flythrough speed; per-pixel temporal variance heatmap + flicker
   energy metric on distant regions. This is K-1's measuring stick and the regression guard
   for every TRAA/impostor/shadow change after.
2. **Pop probe:** flythrough capture, frame-pair perceptual-diff spikes flag transition events;
   zero above threshold ≤ 300 m, none *perceptible* at any range.
3. **Fauna gallery sheet + gait review:** species × seeds contact sheet; treadmill capture per
   gait; IK foot-plant verification on slope (zero slide frames).
4. **The photograph test:** staged in-game wildlife photos vs real photographs, `DELTA.md`
   discipline, per fauna wave.
5. **Audio blind protocol:** per §11, logged per sound class.
6. **Playtest protocol:** user plays between milestones; feedback lands as dated STATUS
   entries → K-list. A milestone with an unaddressed user-reported regression does not close.
7. **Perf gate:** ABAB tables per bookmark for base tier + each quality tier; frame-pacing
   percentiles, not just medians; framealign pixel-identity for anything claiming
   "no visual change."

## 13. Console expansion

The registry pattern (`src/debug/Console.ts`) is the delivery vehicle; every family below is
just registrations. Existing commands (noclip, fly/walk, speed, setpos/getpos, fov, timescale,
freeze, stat, hud, dpr, time, fog, wind, winddir, weather, daylength, shot, flythrough) remain.

- **World & sandbox:** `spawn <species> [n]` (at crosshair), `tp <landmark|bm N|biome>`,
  `animals <census|freeze|attract|shoo>`, `god` (no stamina/fall limits), `lightning`
  (trigger a strike), `daylength`/`weather`/`time` (existing) as the sandbox trio.
- **Graphics tiers & RT:** `quality <base|high|ultra>`, `rt_reflections <0|1|2>`,
  `rt_shadows <0|1>`, `rt_debug <off|bvh|rays>`, `fur <0|1|2>`, per-system toggles
  (`clouds`, `volumetrics`, `particles`, `grassdensity` etc. as numeric cvars), `fps_max`.
- **Tooling & benchmarks:** `demo record <name>` / `demo play <name>` / `demo stop`
  (deterministic camera+time+weather replay — feeds the probes and makes any user-seen bug
  replayable), `bench <bm|demo> [secs]` (prints the ABAB-ready percentile table),
  `bench ab <cvar> <a> <b>` (automated in-session ABAB), `screenshot [name]`, `photo`
  (opens photo mode), `perfdump` (JSON download), `stat fauna|audio|rt` (new panels).
- **Input & UX:** `bind <key> <cmd>` / `unbind` / `bindlist`, `alias`, `exec <name>` +
  `autoexec` (configs in localStorage), `sens <x>`, persisted `fov`.

`bench` and `demo` land in M1 — they are how everything after gets measured and how user
reports become reproducible.

## 14. Roadmap — milestone-gated

Stabilize first; the game exists by M3; hero content lands on proven ground. Each milestone
closes like a v2 phase: build → verify (battery v3 subset) → `DELTA.md` → fix top three →
STATUS entry → user plays it.

| M | Deliverable | Gate |
|---|---|---|
| **M1 — Stabilize & close v2** | K-1…K-4 fixed; temporal-stability + pop probes built; queued base-tier perf work (TRAA resolve, post merges, submit cuts); `bench`/`demo` console tooling; v2 Phase-7 close-out (9 bookmarks, 90 s flythrough, per-pass HUD, full v2 battery, two-frame test) | v2 battery passes; probes green; ABAB fps report vs 2026-07-02 baseline; user confirms all four K's dead |
| **M2 — RT foundation + reflections** | RT-0 BVH + benchmark; RT-1 water reflections (high tier); base-tier SSR fallback fix (K-2 interim) | Mrays/s table in STATUS; bm2 grazing shot clean; base tier framealign-identical |
| **M3 — The game exists** | Photo mode v1 (full camera model + capture detection); album + journal shell; fauna W1 (birds + insects); ambient audio bed (wind/water/weather + lightning); crouch + noise levels | Photograph a raptor in flight → journal entry created; wind/water pass the blind audio gate; 10-minute user play session |
| **M4 — Somewhere to go** | ≥ 20 named landmarks + toponym generator; procedural map with exploration reveal; vantage points; trail network v1 (worn paths, cairns); fauna W2 (aquatic) | Find-and-photograph loop works across 3+ biomes; map fills as user explores; user session |
| **M5 — The realism pass** | §9 domains in order: light & color → close-up → water → distance (couples to K-1 verification) | Photograph test per domain; self-score +2 on the four target rows; no base-tier perf regression |
| **M6 — The world speaks** | Fauna W3 (marmot/hare/fox) + perception/stealth model; species voices + hear-before-see; journey intro (~15 min authored walk: movement → camera → first capture → vista → free roam, skippable); footsteps | User locates an unseen marmot by sound alone; intro playtest; gait review passes (zero foot-slide) |
| **M7 — Hero tier** | Fauna W4 (red deer, alpine ibex) + full fur pipeline + herds; RT-2 shadow rays (high tier); journal/map complete | The ibex-on-a-ridgeline-at-golden-hour photograph passes the one-second glance; fauna floors (§5) met |
| **M8 — Acceptance** | Full battery v3; self-score rubric; RT-3 if budget allows; polish backlog burn | The five-minute test (below) + the standing two-frame test + user sign-off |

Always-on lanes, every milestone: user-feedback batches outrank the plan; STATUS.md discipline;
perf ABAB on anything touching the frame; console registration for anything new.

## 15. Banned outcomes — v3 additions

All v2 §9 bans stand. New instant fails:

- An animal in the world that fails the photograph test — robotic gait, foot-sliding, floating,
  pose-popping, dead eyes, teleporting or in-view (de)spawning. Gallery purgatory exists for a
  reason.
- Fauna behavior that ignores the perception model — animals as static props, or as
  omniscient flee-bots. Both read as game-y.
- Audio that reads as a synth demo shipped without the fallback clause; audible loop seams;
  sound that contradicts the visible world (wind audio calm while trees thrash).
- HUD/UI clutter: compasses, minimaps-by-default, quest markers, XP toasts. The journal and
  map are things you *open*; the world is the interface.
- A tiered feature that changes base-tier pixels or costs base-tier frames (framealign law).
- Perf work that dips under any v2 floor or visibly reduces detail (no-quality-loss law).
- Closing a user-reported defect without user confirmation.

## 16. Self-score rubric — v3 rows

v2's twelve rows stand (anchored to the references). New rows, same 2/4/7/10 anchors, anchored
to real wildlife photography and real field recordings: **animal fidelity (still)** · **animal
motion & behavior** · **soundscape** · **photo-mode feel** · **exploration pull** (does the
world make you want to see what's over the ridge?) · **game feel** (input latency, pacing,
frame stability under hand). Score at every milestone; per row write "what raises this by 2";
implement the two cheapest before proceeding.

## 17. Beyond v3 (unranked parking lot)

Seasons (autumn beech forests, winter lake ice, spring melt); dynamic snow accumulation during
snowfall; more species (lynx as an ultra-rare "white whale" photo subject, owls + a night-
photography loop, eagles taking marmots — predation events); photo-sharing export sheets
(EXIF-style metadata cards); aurora nights; FFT lake water; surfel/voxel GI upgrade; the v2
Tier-3 leftovers (procedural landmark silhouettes, grass displacement wakes, photogrammetry-
style hero-rock detail).

---

## Final acceptance — the five-minute test

Hand the game to someone who has never seen it. Give them nothing but the intro journey.
Within five minutes they should have: moved through the world without being told how, heard
something and turned to look, found an animal, photographed it, and seen it enter their
journal — and the photo they took should be one they'd show someone else. If any link in that
chain breaks — they got lost in UI, the animal read as fake, the world stuttered, the silence
felt dead — that link is the next milestone's top of queue.

The two-frame test of v2 still stands beneath it: the world must look real. v3 adds the harder
question: is it *alive*, and is being in it worth the player's evening. The final gate, as
always, is the user saying so.
