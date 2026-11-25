# Untitled → C++ vegetation generator: wind, clusters, UV, fracture, SDF, 10k forest

> **Scope of this branch.** `egoistinbox-hue/Frontier` starts from an empty initial commit, so this branch contains a *porting scaffold*, an interactive browser reference, and this decision document. It is not a drop-in patch to the full Frontier engine checkout: the engine units named below (`OutlinerPanel`, `ClusterPyramid`, `FastRuntimeFracture`, …) are identified by reading the referenced branches and are the integration points to target once this work lands there. Every claim about the existing engine comes from those two branches; every claim about the code in this branch can be verified with the commands in §10.

## 0. Decisions at a glance

| Question | Decision | Why |
| :-- | :-- | :-- |
| Port target | C++20 core with GPU `.slang` animation; JS stays the authoring reference | Slate already emits exactly the attributes a GPU wind program needs (`height, limb, phase, detail` + pivot); port that contract first, not the whole viewer |
| Wind | **One** `WindFieldSolver` instance in the world; every tree, leaf and SDF proxy samples it | superposed directional + gust components, altitude shear/veer, shared gust envelope; no per-tree wind objects |
| Presets | All **37 tree** and **14 grass** presets from Slate `params.ts` / `grassParams.ts`, grouped as in `PRESET_GROUPS` | one deterministic catalogue, keyed by name; full botanical parameter blocks migrate file-by-file |
| UV | Keep Slate's face-varying UVs; cylindrical bark strips + atlas leaves; split seams at export; lock seams in simplification | textures need stable texel density; crack-free clusters must share the same island borders |
| LOD | Reuse Frontier `ClusterPyramid` (128-tri clusters, monotone group error, UV-seam lock) + two-phase cull | do **not** build a second Nanite; inflate cluster bounds by max wind displacement or swaying trees get culled |
| Leaf shuffle | Hybrid: procedural vertex sway for trunk/limbs, **VAT** for leaves, **XPBD only for hero trees / fracture debris** | 10k trees × hundreds of leaves cannot run XPBD per frame; offline XPBD can *bake into* VAT |
| Nanite | No new Nanite implementation; extend the existing cluster pyramid | its cluster DAG already carries UV/material/normal data and error-monotone cuts |
| SDF | Static baked local volume + **animated analytic capsule/sphere proxies posed by the same wind sample**; no per-frame global rebake | rigid-proxy evaluation is a cheap inverse-transform; a 10k-tree grid re-bake every frame is not |
| Fracture | Offline baked cuts per species + near-field `FastRuntimeFracture`; shared cut tokens; fragments get their own SDF proxies | deterministic pieces, intact UVs, no global topology rebuild at runtime |

## 1. Source-of-truth mapping

| Slate (TS reference) | C++ target in this branch | Engine integration point |
| :-- | :-- | :-- |
| `src/tree/params.ts` (`PRESETS`, `PRESET_GROUPS`) | `Engine/Vegetation/VegetationPresetCatalog.{h,cpp}` | `Engine/Interchange/` preset codec; outliner construct sheet |
| `src/tree/skeleton.ts` (Weber–Penn turtle) | **not ported yet** — milestone B | `Engine/GeometrySpace/Network/PolygonNetwork` |
| `src/tree/mesher.ts` (welded collars, roots, `windAt`) | **not ported yet** — milestone B | same `PolygonNetwork`; export through `UVCodec` / `SceneCodec` |
| `src/tree/mesh.ts` (`VertexWind`, face-varying UVs) | `CanopyDeformer`, `ClusterLodSelector` | vertex layout: `POSITION`, `NORMAL`, `TEXCOORD_0`, `TEXCOORD_1`, `COLOR_0` |
| `src/viewer/shaders.ts` (`applyWind`) | `Engine/Shaders/Vegetation/TreeSway.slang` + `CanopyDeformer.cpp` | `Engine/GeometricRaster/` visibility/material channels |
| `src/plant/grassParams.ts` | `VegetationPresetCatalog` (grass entries) | same pipeline with ribbon mesher |
| ProjectZero `WindSpecification.js` / `WindInspector.cpp` | `WindFieldSolver.{h,cpp}` | `WindInstanceData`, `AtmosphericWindSolver` |

**Coordinate conversion.** Slate is Y-up; Frontier is right-handed +Z-up. Convert at the interchange boundary with `(X, Y, Z)_Slate → (X, -Z, Y)_Frontier` (this preserves handedness). The standalone C++ scaffold deliberately keeps Y-up locally so its deformer stays bit-comparable with `shaders.ts`; convert the whole mesh and all pivots once at insertion, *then* transform the wind direction into world space.

## 2. "Untitled": where the generator attaches to the editor

1. Create one outliner entry for the generator with `DomainTag = "vegetation:tree-generator"`, category `GeometryVolume`, editable title `Tree generator`, and a subtitle such as `Seed 1337 · 12 000 instances`. This reuses `OutlinerPanel` / `OutlinerRecordEntry` verbatim — no new tree pane.
2. Register a `VegetationInstanceRegister` (in `Engine/Vegetation/`) keyed by `OutlinerSlotToken`, matching the `InspectorInstanceRegister` pattern. The entry in the outliner is the *generator*; per-species entries become nested records with the same token namespace.
3. Extend `InspectorPanel` through `ConfigureCustomSectionCallback` (already provided) with the cards shown in §9: Generation, Wind field (bound to the existing `WindInstanceData`), Vegetation animation, Cluster LOD, Surface/UV, Fracture, Distance field. Do not fork `InspectorPanel`.
4. The wind entry is a **single** `WindInstanceData` in the world. Trees reference its token; the inspector shows "WindField shared". The SDF entry references the same token with an `ApplyToSdf` toggle.
5. Undo/redo stores `VegetationInstanceRecord` deltas plus the generator seed; geometry is derived data and can be rebuilt deterministically.

## 3. One wind field, three consumers

The field is the superposition implemented in ProjectZero `EvaluateWind` plus the atmosphere parameters from `AtmosphericWindSolver.h`:

```text
F(x,z,t)   = Σ Directional(strength, bearing)
           + Σ Gust(strength, bearing, radius, frequency) · falloff² · (0.65 + 0.35 sin(2πft))
           + Tornado / Radial components (only where authored)
speed     *= 1 + ShearPerKm · altitude_km
bearing   += VeerDegPerKm · altitude_km
gust       = GustStrength · (0.5 + 0.5 sin(2π f t)) · (0.35 + 0.65 · Steadiness)
turbulence = Turbulence · (1.05 - 0.45 · Steadiness)
```

`WindFieldSolver::Resolve(x, y, z, t)` returns velocity, direction, strength, gust and turbulence. Consumers:

| Consumer | Sample point | Cost | Notes |
| :-- | :-- | :-- | :-- |
| Trunk/limb vertex sway | once per **instance** (tree origin) → uploaded as instance uniform | O(1) per tree | height-dependent phase lag is applied from the vertex's `height` weight |
| Leaf flutter | same instance sample + per-leaf `phase` from the mesh | O(1) per vertex | procedural or VAT; see §6 |
| SDF proxies | same instance sample, evaluated on CPU at ~30 Hz for near trees only | O(near trees) | proxy joints rotate with the same gust envelope |
| Wind overlay / debug | grid of samples in the viewport | O(grid) | visualises the one field; no second field is created |

Per-tree variety comes from `WindFieldSolver::InstancePhase(token)` — a deterministic hash used for limb phase, LOD dither and leaf offset. **Never** clone the field per tree.

### Mesh deformation contract

Slate's welded mesh already stores what the GPU needs:

```text
COLOR_0    = (height ∈ [0,1], limb ∈ [0,1], phase ∈ [0,1], detail ∈ [0,1])
TEXCOORD_1 = (level / 4, junction flag)
aPivot     = limb-root position (vertex attribute in the viewer)
```

`TreeSway.slang` ports `applyWind()` exactly: cantilever trunk sway (`height²`), limb rotation about `aPivot`, and high-frequency twig/leaf flutter. `CanopyDeformer.cpp` is the CPU mirror used for verification and SDF proxy posing. Roots carry `(0,0,0,0)` and stay anchored.

## 4. All presets and the full botanical port

`VegetationPresetCatalog` contains the exact names and groups from Slate: Oaks, Forest·broadleaf, Forest·conifers, Jungle, Savanna, Desert, Rocky terrain, plus three grass groups. The runtime-authoring fields (height, height variance, levels, trunk ratio, per-level branch counts, leaves, leaf scale, root count) were extracted from `params.ts` and are checked in as data. `WindFlex` is a new authoring value for this port; it is not in Slate.

To reach visual parity, migrate these files in order and keep their tests:

1. `skeleton.ts` — turtle recursion, phyllotaxis, tropism, root flare. Preserve `seed` determinism.
2. `mesher.ts` — welded branch windows, collars, caps; preserve the topology validation from `validate.ts`.
3. `roots.ts` — environment-aware roots; preserve the collision/scatter contract from `env/environment.ts`.
4. `export.ts` — OBJ/glTF with seam splitting (`toGpuBuffers`) and the `extras.wind` documentation.

Acceptance gate: for a fixed seed, every preset produces the same vertex/quad counts and the same `wind` tuple statistics as the TS generator. The scaffold's 51-entry catalogue is the seed for that work, not a substitute for the mesher.

## 5. UV unwrapping and textures

- Slate UVs are **face-varying**: `quadUVs` / `triUVs` are per corner, so the cylindrical seam does not duplicate vertices; `toGpuBuffers()` splits only at export. Preserve this; do not re-unwrap the welded mesh unless texel density is wrong.
- Bark: cylindrical strips with U = circumference fraction and V = arc length / scale; repeat vertically. Leaves: five-vertex islands in an atlas (`mesher.ts` already emits `(0.4,0) … (0.5,1)` corners). Pack with the existing UV workspace (`UVCodec`, `IslandLayoutPacker`) and generate tangents from `TEXCOORD_0`.
- Materials: bark (opaque, roughness ~0.9) and leaf (double-sided, alpha-tested) are separate primitives/material slots, as in `toGLB()`. Keep `MaterialOrdinal` stable through cluster building.
- With cluster LOD set `ClusterPyramid.LockUvSeams = true` and `LockMaterialBoundaries = true`. Simplification that crosses an island border breaks texture continuity and causes popping.
- The demo's UV mode shows the seam overlay and an atlas preview; toggling textures changes the atlas fill only — it does not fetch images, so the demo stays self-contained.

## 6. Leaves: procedural, VAT or XPBD?

| Option | Per-frame cost | Quality | Verdict for 10k+ trees |
| :-- | :-- | :-- | :-- |
| Procedural vertex wind (Slate `shaders.ts`) | a few sine/cos per vertex | good trunk/limb motion, acceptable leaf flutter | **use** for bark and near leaves |
| VAT (texture of baked frames) | 1 texture fetch + lerp per leaf | authored turbulence, perfectly stable, no CPU cost | **use** for leaf shuffle; 16–32 frames is enough at 30 Hz playback with linear interpolation |
| XPBD (distance/bend constraints on each leaf) | O(leaves × iterations) per tree | best contact/response | **do not** run per frame on the forest; use for one hero tree and fracture debris, or offline to *generate* VAT |
| Rigid-body leaf cards | physics broadphase | exotic | unnecessary; leaf collisions are visually negligible at forest distance |

**Recommended hybrid.** Bake 16–32 frames of leaf motion per species into an RGBA16F VAT (XY = displacement, Z = extension, W = normal tilt), sampled with per-leaf phase and the shared wind strength/phase. XPBD solves 8–12 iterations offline for the bake and remains as a runtime solver only for the selected hero tree. Add a per-instance phase offset so 10k trees do not flutter in lockstep. Far LODs drop leaf flutter entirely and use a static canopy card — the leaf VAT is only sampled for L0/L1.

The demo's `leafModes` segmented control shows all three behaviours; "XPBD hero" limits the spring solve to the selected tree and reports that in the HUD.

## 7. Nanite-style clusters and the 10k forest

Frontier already owns the mechanism: `Engine/SpatialAcceleration/ClusterPyramid.h` (128-triangle clusters, monotone group error, UV/material/normal preservation, 128 B cluster headers) plus `ClusterCullEncoder` (frustum, normal cone, continuous cut, Hi-Z, two-phase rescue). **Extend these; do not build a separate Nanite.**

```text
per species (offline):
  welded mesh → 128-tri clusters → group 4 clusters → lock border → simplify interior 0.5×
  → store (error, sphere) once per group → repeat until triangle budget
per frame (GPU-driven):
  for instance in forest:
    wind = WindFieldSolver::Resolve(origin, height, t)       // 1 sample
    for cluster in instance:
      bound.radius += CanopyDeformer::MaximumDisplacement(wind)
      if error_px <= 1.25 && frustum && normalCone && !HiZ: draw(cluster)
      else if < 4 px: compute software raster path
```

Key details:

- **Wind-safe bounds.** Deform after the cut but cull using the inflated sphere; otherwise a swaying crown can be culled at the silhouette. `ClusterLodSelector::WindSafeRadius()` implements the inflation.
- **Stable cut.** Group error must be monotone (`group.error ≥ every child error`) and both sides of a group border must use the same sphere, or mixed LOD levels crack.
- **Wind attributes survive simplification.** Carry `TEXCOORD_1` / `COLOR_0` through quadric simplification; if a collapse would blend incompatible wind phases, lock that edge.
- **Instance layout.** `VegetationInstanceRecord` is 64 B aligned (token, preset ordinal, seed, position, scale, yaw, phase, LOD, flags). At 10 000 trees that is 640 kB — trivial for a storage buffer. No virtual calls and no per-tree wind component.
- **Update rates.** Wind uniform + instance LOD cut at 60 Hz; wind field solve per visible instance; SDF proxy poses at 30 Hz near field; VAT frames at 30 Hz; fracture simulation at 60 Hz for at most a handful of impacts.
- **Budget.** 10k trees × ~9 000 source triangles is 90 M triangles; cluster cuts reduce visible geometry by two orders of magnitude at forest distance. Keep far trees at 240–900 triangles and drop leaves beyond the mid LOD.

## 8. Fracture

Wire into `Engine/GeometrySpace/Fracture/`: `FastRuntimeFracture` for near-field cuts, `EngineeringBakedFracture` for deterministic per-species offline cuts, `FractureSimulationRunner` + `FractureMaterialRepository` for rigid fragments and materials.

1. Author cut planes on trunk and primary limbs only; `FractureSpecification::BuildTrunkCuts()` gives deterministic planes and shared `CutToken`s.
2. Bake fragment UVs and interior cap UVs with the same atlas; a cut face samples bark end-grain, not a black void.
3. Fragments inherit cluster LODs of their source triangles; after fracture, disable the original instance's cluster cut and draw fragment records instead.
4. Each moving fragment gets one analytic SDF proxy (capsule or convex shell) so shadows/occlusion follow it; remove the source tree's proxy at impact time.
5. Do not run runtime fracture on all 10k trees: cap active fracture sets to the near field (e.g. 8 trees) and stream pre-baked fracture variants for anything else.

## 9. SDF: how to let wind move it

| Option | Cost | Accuracy | Verdict |
| :-- | :-- | :-- | :-- |
| A. Rebake global distance field every frame from deformed meshes | huge (voxels × 10k trees) | exact | **reject** — does not scale |
| B. "VAT for SDF": bake a grid per frame and interpolate | 16–32 × grid memory, still no sparse update | approximate | **reject as the primary path**; too much memory for a forest, and interpolation smears contact |
| C. Analytic primitives (spheres/capsules) moved by the wind field | ~10 primitives per near tree | good for trunk/canopy | **use** |
| D. Static baked local volume + C for the animated part | one compact `LocalSignedDistanceVolume` per species + cheap proxies | good hybrid | **use** (recommended) |

### Recommended design

- **Static part.** Bake one compact local volume per species offline (`LocalSignedDistanceVolume::BakeSignedFromTrianglesAspect`, 48³ half-float) and place it rigidly per instance. It carries trunk/root detail that never moves much.
- **Dynamic part.** Build a `DistanceProxySet`: a tapered capsule for the trunk (`TaperedLimbCapsule32` layout), one per primary limb, a sphere for the canopy. `UpdatePose()` rotates each proxy with the *same* `WindSample` used by `TreeSway.slang`. Evaluate with smooth-min (`k ≈ 0.24 m`).
- **Shader trick.** For a rigid proxy, evaluate the SDF in the proxy's rest space by inverse-transforming the query point; this is the SDF equivalent of skinning and is much cheaper than re-voxelising.
- **Global field.** Only near-camera clipmap tiles include dynamic proxies; each tile keeps a short list of proxy indices, culled by bounding sphere. Update tiles at 30 Hz (or on camera movement), never the whole forest at 60 Hz. Far trees remain in the static baked layer.
- **Engine constraint.** In the referenced Frontier branch, local distance volumes are restricted to the `GtxLowEnd` tier and the former global SDF GI path was removed pending redo. Keep this vegetation SDF for collision/occlusion/AO on that tier; use the existing BVH4/ray-query path on high tier instead of reviving removed GI code.
- **Fracture.** Replace the source proxy with fragment proxies at impact and return them to the static layer once they come to rest.

The demo's SDF mode renders a live signed-distance slice around the selected tree, overlays the capsule proxies, and toggles between static/animated/hybrid behaviour; the "Apply to SDF" switch is the same `WindSample` coupling described here.

## 10. C++ scaffold, verification and the HTML demo

```bash
bash scripts/build_vegetation_core.sh     # compile + run the standalone checks
```

Covers: 51 presets, field superposition/shear, root anchoring vs crown displacement, monotone LOD cut, SDF inside/outside and pose update, fracture piece counts, and 10 000 instance records.

| File | Role |
| :-- | :-- |
| `Engine/Vegetation/VegetationMath.h` | vector math, deterministic hash, smooth-min, Rodrigues rotation |
| `Engine/Vegetation/WindFieldSolver.{h,cpp}` | shared field (component superposition + shear/veer/gust/turbulence) |
| `Engine/Vegetation/VegetationPresetCatalog.{h,cpp}` | all Slate tree/grass presets |
| `Engine/Vegetation/CanopyDeformer.{h,cpp}` | CPU mirror of the GPU wind program |
| `Engine/Vegetation/ClusterLodSelector.{h,cpp}` | screen-error cut + wind-safe bounds |
| `Engine/Vegetation/DistanceProxySet.{h,cpp}` | analytic SDF proxies posed from wind |
| `Engine/Vegetation/FractureSpecification.h` | deterministic cut planes and tokens |
| `Engine/Vegetation/VegetationInstanceRegister.h` | 64 B instance records keyed by outliner token |
| `Engine/Shaders/Vegetation/TreeSway.slang` | GPU deformer matching the CPU mirror |
| `tests/VegetationCoreTest.cpp` | standalone verification |

### Demo

Open `demos/tree-generator/index.html` (no server or build needed). It uses the same dark dock tokens, outliner rows and property cards as the Project Zero / Frontier editor reference; the Markdown Studio copy is `demos/tree-generator/markdown-studio.html`.

- **Outliner:** 10 groups, all 51 presets, search, tree/grass filter, per-species visibility, selection sync.
- **Viewport:** orbit drag, wheel zoom, click a tree to select; modes `1` sway, `2` LOD clusters, `3` UV atlas, `4` fracture, `5` SDF proxies; `F` fractures the selected tree; `Space` pauses.
- **Inspector:** live wind field sliders, flex weights, leaf-shuffle strategy, cluster error budget, UV atlas, fracture strength, SDF proxy mode. All sliders feed the same simulation the viewport draws.
- **Stats:** visible trees, active clusters, triangle estimate, wind at focus, LOD histogram and FPS, so the forest scale is visible rather than asserted.

The demo is a *behavioural reference*, not an engine render: it uses Canvas 2D for the forest, a pseudo-3D projection, and a low-resolution SDF slice. Its numbers and formulas mirror the C++ units, but it does not run Vulkan, Slang, or the real cluster rasteriser.

## 11. Migration sequence and acceptance gates

| Phase | Work | Gate |
| :--: | :-- | :-- |
| A | Land this scaffold, preset catalogue and HTML reference; screenshot each demo mode | C++ checks pass; all 51 presets selectable; each mode renders |
| B | Port `skeleton.ts` → C++ turtle, then welded `mesher.ts`, `roots.ts`, `validate.ts` | Fixed-seed vertex/quad counts match TS for all 37 tree presets |
| C | Wire generator into Untitled outliner + inspector cards via existing panels; one wind entry | Selection, visibility and undo round-trip; no new UI pane classes |
| D | GPU `TreeSway.slang` + preserve wind attributes through `ClusterPyramid`; wind-safe bounds | CPU/GPU deformer screenshots match; no cluster popping during gusts |
| E | VAT bake from offline XPBD; runtime XPBD limited to hero tree | 10k instanced trees at target budget; leaf phases decorrelated |
| F | Static local volumes + animated analytical proxies; near-field clipmap integration | Moving proxies track deformed silhouette; no per-frame global rebake |
| G | Offline fracture variants + near-field runtime solver + fragment proxies | Shared cut tokens; fragment UVs and SDF proxies stay consistent |

## Appendix: references consulted

- Slate `arena/01a096c9-slate`: `src/tree/{params,skeleton,mesher,mesh,export,validate}.ts`, `src/viewer/shaders.ts`, `src/plant/grassParams.ts`.
- Frontier `arena/d929ef36-frontier`: `Engine/Components/Panes/{OutlinerPanel,InspectorPanel}.h`, `Engine/Editor/Inspectors/WindInspector.{h,cpp}`, `Engine/GeometricRaster/Atmosphere/AtmosphericWindSolver.h`, `Engine/SpatialAcceleration/ClusterPyramid.h`, `Engine/GeometricRaster/Visibility/ClusterCullEncoder.h`, `Engine/GeometrySpace/Fracture/README.md`, `Engine/DistanceFieldSpace/README.md`, `Engine/DistanceFieldSpace/ArticulatedCapsuleRig.h`, `Experimental/ProjectZeroEditor/{WindSpecification.js,Editor.css,InspectorDepot/styles.css}`, `Documentation/Plans/{UVWorkspaceArchitecturePlan.md,MarkdownStudioViewer.html}`.
