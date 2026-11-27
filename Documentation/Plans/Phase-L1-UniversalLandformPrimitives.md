# Phase L1 · Universal SDF Basic Landform Primitives — Architecture & Status

> Status: **L1 shipped · L4 shipped** on `arena/87cceed7-frontier`.
> Headless QA: `36/36` legacy terrain + rock suites, `11/11` landform + RockFormation 2.0 engine suites,
> `6/6` studio UI smoke checks.

Phase L1 is the foundation of the 5-phase plan to finish the 3D SDF Landscape Studio. Noise layers alone cannot
author real-world landforms; every noise mountain looks like noise unless it sits on top of controllable geometric
SDF landform primitives **with interactive 3D viewport gizmos**.

---

## 1 · What Shipped

### 1a · `Engine/Landforms/TerrainLandformPrimitives.js` (new, Pure-SDF, dependency-free)

A single source of truth for parametric landforms — no mesh→SDF conversion anywhere, every surface is analytic.

| Piece | Detail |
|---|---|
| 29 archetypes / 6 families | Peaks & Volcanoes (5) · Plateaus & Mesas (4) · Valleys & Canyons (5) · Ridges, Faults & Folds (4) · Aeolian, Karst & Impact (7) · Coastal & Islands (4) |
| Analytic profile `h(x,z)` | Each archetype solves its own signed relief (`mode: 'add'`) or absolute elevation (`mode: 'snap'`) from the local footprint frame |
| Parametric schema | `LANDFORM_PARAM_SCHEMA` — one declarative table (label, range, step, decimals, unit, and a **validation probe**) drives the whole inspector UI *and* the zero-dead-controls test |
| Generator / placement modes | `single` (3D gizmo) · `chain` (3D spline knots) · `ridge_range` (parallel belt array) · `scatter` (seeded deterministic field, golden-angle packing) |
| Superellipse + polygon footprints | `footprintPow` (squareness) and `footprintSides` (arbitrary n-gon) with fractal **boundary wobble** |
| Talus aprons | Angle-of-repose debris wedges (`32°–38°`) with rim-anchored cone fans, so `talusAngleDeg` is physical, never cosmetic |
| True-3D undercut emitter | `BuildLandformVolumetricOps` emits analytical carve capsules for overhanging walls (`> 90°` slant) — slot canyon rims, cenote lips, wave-cut sea notches, karst basal notches |

Family/archetype catalog:

| Family | Archetypes |
|---|---|
| 1 · Peaks, Cones & Volcanoes | `alpine_horn`, `shield_volcano`, `strato_volcano`, `batholith_dome`, `cinder_cone` |
| 2 · Plateaus, Mesas & Benches | `mesa_tepui`, `stepped_butte`, `cuesta_escarpment`, `alluvial_bench` |
| 3 · Valleys, Canyons & Grabens | `v_gorge`, `u_glacial_valley`, `slot_canyon`, `rift_graben`, `meander_channel` |
| 4 · Ridges, Faults & Folds | `thrust_scarp`, `fold_belt`, `hogback_range`, `knife_arete` |
| 5 · Aeolian, Karst & Impact | `barchan_dune`, `star_dune`, `transverse_dune_field`, `impact_maar`, `karst_sinkhole`, `cenote_shaft`, `karst_tower` |
| 6 · Coastal & Islands | `atoll_ring`, `sea_cliff_headland`, `barrier_spit`, `shelf_dropoff` |

### 1b · `Engine/TerrainLayerStack.js` integration

- New layer type `landform_primitive` (`LAYER_TYPE_META`, `CreateTerrainLayer`).
- Per-layer preparation block builds instances + bounds once per region evaluation (cheap bounding-sphere rejects per cell).
- Inside the main grid loop the landform contributes:
  - `add` → `CurH + h(x,z)` blended by coverage & falloff;
  - `snap` → absolute caprock / plateau / bench elevation;
  - honouring `add / sub / max / min / lerp` combine modes, opacity, boundary falloff and the elevation/slope `heightMask`.
- `Region.landform3DOps` is rebuilt from scratch every evaluation (no stale carve geometry) and is merged into
  `BuildVolumetric3DBricks`, so the **existing sparse 3D brick Dual-Surface-Nets tier** produces genuine overhangs.
- `ComputeRegionBaseSignature` hashes every landform control + path knot, so editing a landform correctly flags a
  baked erosion pass as stale.

### 1c · `Engine/TerrainOceanViewport.js` — interactive 3D landform gizmos

- `computeLandformGizmoGeometry` projects the full handle set: **centre disc (planar move)**, **RX / RZ footprint
  arrows**, **H apex arrow** (peak/rim height, inverted for carve archetypes), **STRIKE azimuth ring**, teal
  **A → B path knots** and generator **instance markers**.
- `hitTestLandformGizmo` + a dedicated `landform-drag` pointer state translate screen drags through ray/plane math
  into exact non-destructive layer writes (`worldX/worldZ`, `radiusX/radiusZ`, `heightM`, `strikeDeg`, `pathPoints`).
- Crisp overlay: dashed yawed footprint ellipse, elevation stalk, live readout badge (`MESA · 620×480 m · H 240 m`).

### 1d · `TerrainWorldEditor.js` — zero-dead-control authoring UI

- **Landforms inspector tab**: family-grouped archetype picker, identity (archetype / placement / combine),
  3D gizmo placement card, archetype signature controls (only controls that archetype actually reads), generator
  instance controls, A → B per-knot width/depth scaling, surface detail, and the 3D undercut toggle.
- **Quick-add library**: all 29 archetypes as cards with bespoke glyphs.
- Outliner rows show `SHORT · Rx × Rz m · placement`, jump straight to the landform tab, and the new
  **Landform Gizmo** tool (`L`) joins the 3D rail.

### 1e · Validation

| Command | Coverage |
|---|---|
| `node Experimental/TerrainWorldEditor/TerrainWorldValidation.mjs` | 36/36 legacy suites (no regressions) |
| `node Experimental/TerrainWorldEditor/TerrainWorldLandformValidation.mjs` | Suites 37–44: catalog, all archetypes build, **zero dead controls**, 4 placement modes, A → B gizmo paths & undercut, terrain stamp / mesh / JSON round-trip, hydrology compatibility. Suites 45–47: RockFormation 2.0 hero stamp instancing + QEF 0-Mesh→SDF proof, scatter placement gates (slope / ridge / coast / altitude) + determinism + talus rings, scatter grounding & bedrock fusion & JSON round-trip |
| `node Experimental/TerrainWorldEditor/TerrainWorldUILandformSmoke.mjs` | Boots the real studio in a DOM shim, stamps all 29 archetypes from the UI, drives every gizmo handle, undo/redo & workspace switching. Suites 49–50: Rock Scatter tab + quick-add cards, all hero stamp starters & scatter rules through the UI, layer toggle, undo/redo and JSON round-trip |

---

### 1f · Phase L4 · RockFormation 2.0 hero stamps & procedural scatter on terrain (shipped)

`Engine/Landforms/TerrainRockStampEngine.js` turns the whole RockFormation 2.0 stack authoring model into a terrain
layer type — the rock stacks authored in the `rock2` workspace can now be stamped **into** the landscape.

| Piece | Detail |
|---|---|
| `type: 'rock2_stamp'` | One authored RockFormation 2.0 document (`rock2StarterId` or a full `rock2Doc`) stamped at `worldX/worldZ`, `yawDeg`, `worldScaleM`. The stack is compiled once (`CompileTerrainRockStamp` → `compileRock2Stack`) and baked by `bakeRock2StackQefMesh`, then instanced through `BuildTerrainRockStampInstances`. |
| `type: 'rock2_scatter'` | Deterministic seeded rock field. Placement rules `cliffs · ridges · coast · altitude · even` gate each candidate by local slope (`scatterSlopeDeg`), ridge curvature, shoreline SDF band or altitude window; archetypes come from `ROCK_SCATTER_ARCHETYPES`. |
| Anchoring | The transform is derived from the **baked mesh AABB** (`MeshBounds`), so every rock's lowest vertex lands on `surfaceY − embedDepthM` — no floating outcrops, no sinks. |
| Talus skirt fusion | `BuildRockTalusSkirt` emits a world-space debris ring per scattered rock (tagged `kind: 'skirt'`), fused straight into the terrain volume. |
| Bedrock fusion | `RockStampFootprintCoverage` lifts the heightfield under a hero stamp so the rock is rooted in the terrain slab, blended by the layer mask. |
| 0 Mesh → SDF | Asserted in suites 45 & 47: `bakeRock2StackQefMesh(...).sdfStats.meshToSdfCount === 0` for both stamp and scatter archetypes. |

Authoring UX: quick-add cards **Rock2.0 Hero Stamp** / **Rock2.0 Scatter**, a dedicated **Rock Scatter** inspector tab
(`?ws=rockscatter` / `?tab=rockstamp` deep links) with starter chips, placement rules, slope/altitude gates, size
jitter, world placement, embed depth, talus width, QEF resolution and live compile telemetry.

---

## 2 · Phase L2 · Hybrid 2.5D + Sparse True-3D Volumetric Terrain Kernel

The **base 2.5D tier** (`f0(x,y,z) = y − H(x,z)`) is already the studio's fast path and now includes landforms.
The **true-3D tier** already exists for caves/tunnels/overhangs — this port starts feeding it:

- [x] Landform-emitted analytical undercut ops (`Region.landform3DOps`) merged into brick building.
- [x] Watertight Dual-Surface-Nets patch stitching + collapsed top-quad suppression inside brick footprints.
- [ ] Graduated brick allocation policy (bricks only inside landform bounding volumes — partially done: brick AABBs
      derive from op bounds, but a per-landform resolution hint would cut VRAM further).
- [ ] Seamless transition audit across every archetype family + footprint interior/exterior crack tests.

## 3 · Remaining Roadmap

- **L3** · Terrain sculpt/erase polish on top of landforms (raise / lower / flatten / terrace / erode brushes already
  work over landforms; true-3D tunnel/overhang brushes exist — needs a dedicated landform-aware brush pass).
- **L4** · ✅ **Shipped** — live RockFormation 2.0 hero stamp (`rock2_stamp`) & procedural scatter (`rock2_scatter`)
  terrain layers with analytic talus skirt + bedrock footprint fusion and slope / ridge / coast / altitude gates
  (`Engine/Landforms/TerrainRockStampEngine.js`). Remaining polish: per-stack gizmo handles in the 3D viewport and
  streaming the full `rock2` document JSON in/out of the terrain project. The legacy `type: 'rock_formation'`
  (Rock Formation 1.0 presets) is untouched and still supported.
- **L5** · Hydrology/erosion coupling polish per landform family (crater lakes, hogback water gaps, talus below mesas),
  triplanar strata shading, and multi-tile `.GLB` / `.OBJ` / `.STL` + 16-bit heightmap + splat/flow/AO export.
