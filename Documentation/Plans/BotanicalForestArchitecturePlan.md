# 🧩 Botanical Forest Architecture Plan — Slate Port, Unified WindField, Clusters, Fracture, UV & Wind-SDF

> **TL;DR**: Port all **37 Weber & Penn botanical presets** from `unassignedinbox/Slate` (`arena/01a096c9-slate`) into `Engine/GeometrySpace/Botanical/` and wire them into `Projects/Untitled/` reusing Frontier's **existing** `OutlinerPanel`, `InspectorPanel`, `ForceFieldRegister` (1 shared WindField), `ClusterPyramid` + `VisibilityClusterRasterization` (128-tri HW/SW VisBuffer — no separate Nanite rewrite needed), `UVWorkspace`, `FractureWorkspace`, `VertexAtlasFleetTable`, and `VulkanWorldRenderSequence` 3D Global Distance Field (`GdfFineImage3D` / `GdfCoarseImage3D`). Drive **all** wood sway, leaf shuffle, VAT playback, hero XPBD impulses, and **wind-displaced analytical SDF capsules + canopy sphere lobes** from the **exact same 1 WindField**.

**Interactive HTML Reference Workbench (Project Zero Editor UI):** [`Experimental/BotanicalWorkbench/index.html`](../../Experimental/BotanicalWorkbench/index.html) (`37` Slate species · `1` shared WindField · `128`-tri Clusters · UV Checker · Interactive Voronoi Fracture · `10,240`-instance GPU Forest · Live Wind-Synced GDF Section).

---

## 🏷️ 1. End-to-End Frontier Integration Layout

```
                        ┌──────────────────────────────────────────────────────┐
                        │   1 SHARED WINDFIELD (ForceFieldRegister + Uploader) │
                        │   Prevailing Vector · Traveling Gust Wave · Vortex   │
                        └──────┬───────────────┬──────────────┬───────────┬────┘
                               │               │              │           │
           ┌───────────────────▼───┐   ┌───────▼────────┐  ┌──▼────────┐ ┌▼────────────────────────┐
           │ WeberPennBotanical    │   │ Leaf Shuffle   │  │ Fracture  │ │ Analytical Wind-SDF     │
           │ (37 Slate Presets)    │   │ Tiered Solver  │  │ Coupling  │ │ 12 Wood Capsules +      │
           │ · Cylindrical Bark UV │   │ · Hero: XPBD   │  │ · Voronoi │ │ 16 Canopy Sphere Lobes  │
           │ · Foliage Alpha Sheet │   │ · Mid:  VAT    │  │   Collar  │ │ (1.76 KB / specimen)    │
           │ · aWind + aPivot      │   │ · Far:  Analyt │  │ · Jolt RB │ │ Displaced by WindField  │
           └──────────┬────────────┘   └───────┬────────┘  └──┬────────┘ └┬────────────────────────┘
                      │                        │              │           │
                      ▼                        ▼              ▼           ▼
           ┌────────────────────────────────────────────────────────┐  ┌───────────────────────────┐
           │ Existing Frontier ClusterPyramid (128-Tri Clusters)    │  │ Existing GDF 64³ Clipmap  │
           │ + ClusterCullEncoder (Hi-Z) + VisibilityClusterRaster  │  │ (GdfFine3D / GdfCoarse3D) │
           │ + VisibilityMaterialResolve (Zero G-Buffer OpenPBR)    │  │ Splat Capsules + smin     │
           └───────────────────────────┬────────────────────────────┘  └───────────────────────────┘
                                       │
                                       ▼
           ┌────────────────────────────────────────────────────────┐
           │ Projects/Untitled/MainWorld.WorldSpace                 │
           │ · Existing Engine/Components/Panes/OutlinerPanel       │
           │ · Existing Engine/Components/Panes/InspectorPanel      │
           └────────────────────────────────────────────────────────┘
```

---

## 🏆 2. Decision 1 — Leaf Shuffle & Sway for 10,000+ Forest Specimens (`VAT` vs. `XPBD` vs. `Analytic`)

Legend: **GPU Cost / Memory:** `✔️` = Lowest (best), `🚩` = Medium, `🔴` = Highest · **Visual Fidelity / Wind Coupling:** `🔴` = Highest (best) · **Overall Quality:** `⭐` (more = better).

| Option | GPU Cost (`10,000` Specimens) | VRAM Footprint | WindField Coupling | Physical Collision | Overall |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **A. Pure GPU XPBD Everywhere** (`XpbdConstraintSolver`) | 🔴 `> 45 ms` (unusable) | 🔴 `~1.8 GB` | 🔴 Exact force intake | 🔴 Full branch/leaf | `⭐⭐` |
| **B. Pure Baked VAT Everywhere** (`VertexAtlasFleetTable`) | 🚩 `~1.8 ms` | 🚩 `~120–360 MB` | 🚩 Phase/blend only (cannot change wind direction freely) | ✔️ None | `⭐⭐⭐` |
| **C. Pure Analytic 3-Tier Wind Shader** (Cantilever + Pivot + Flutter) | ✔️ `~0.4 ms` | ✔️ `0 MB` extra (per-vertex `aWind` + `aPivot`) | 🔴 Exact 3D vector, traveling gusts & vortex | ✔️ None | `⭐⭐⭐⭐` |
| **🥇 D. Distance-Tiered Combo Driven by 1 WindField** *(Recommended)* | ✔️ `~1.1 ms` total | ✔️ `< 24 MB` total | 🔴 **100% unified 1 WindField across all 3 tiers** | 🔴 On nearby heroes (`0–25 m`) | `⭐⭐⭐⭐⭐` 🏆 |

### 💡 Recommended Tier Assignment (`Projects/Untitled/` Forest Budget)

| Distance Band | Instance Count | Trunk & Limb Motion | Leaf Shuffle Mechanism | Existing Frontier C++ Unit |
| :--- | :---: | :--- | :--- | :--- |
| **Tier 0 · Hero (`0–25 m`)** | `1 – 16` | Cantilever + Pivot Wind + optional Jolt/XPBD vehicle/character push | **GPU XPBD Elastic Whip** (or spring-damped twig bend + high-freq flutter) | `XpbdConstraintSolver` + `ParticleXpbdNetworkBuilder` |
| **Tier 1 · Midground (`25–120 m`)** | `16 – 1,500` | Exact `ForceFieldGpuUploader` 3-tier cantilever + limb bend | **VAT Loop Sheet (`VertexAtlasFleetTable`)** time-warped by local WindField speed & gust phase | `VertexMotionAtlasGpuBaker` + `VertexAtlasFleetTable` |
| **Tier 2 · Deep Forest (`120 m+`)** | `1,500 – 10,000+` | Exact `ForceFieldGpuUploader` traveling spatial wave front | **Zero-VRAM Analytic Multi-Harmonic Flutter** (`aWind.w` + world-origin phase) | `ForceFieldGpuUploader` + `WorldViewportRadiometricCompute.slang` |

📝 **Why not pure VAT for 10,000 trees?** A baked VAT clip locks in one wind direction and one gust profile. Modulating VAT playback rate with the shared WindField works well for secondary leaf flutter at `25–120 m`, while the macro trunk sway and limb bend stay **100% analytic** so a rotating wind or traveling vortex bends all `10,000` trees smoothly in any direction with zero popping!

---

## 🏆 3. Decision 2 — Should You Build Nanite From Scratch for 10,000+ Trees?

Legend: **Engineering Cost:** `✔️` = Lowest (best) · **10k Forest Performance / Visual Parity:** `🔴` = Highest (best).

| Option | Engineering Cost | 10,000+ Forest Perf | Alpha-Foliage Fidelity | Reuses Frontier Code | Overall |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **A. Traditional 4-Mesh Discrete LODs** | ✔️ Low | 🚩 High overdraw + LOD pop | 🚩 Thinning crowns | 🚩 Partial | `⭐⭐⭐` |
| **B. Brand-New Full Nanite Rewrite** (SW virtual streaming + foliage assemblies) | 🔴 Months | 🔴 Excellent | 🔴 High | 🔴 Duplicates VisBuffer | `⭐⭐⭐` |
| **🥇 C. Extend Existing `ClusterPyramid` + `VisibilityClusterRasterization`** *(Recommended)* | ✔️ **Focused** | 🔴 **Nanite-class (`>= 4 px` HW / `< 4 px` SW)** | 🔴 **Area-preserving clusters** | 🔴 **100% reuse** | `⭐⭐⭐⭐⭐` 🏆 |

### 💡 Frontier Already Has the Nanite Foundation Built

Do **not** build a second virtualized geometry architecture. Frontier already ships:
- `Engine/SpatialAcceleration/ClusterPyramid.{h,cpp}` — 128-triangle (`MaxTrianglesPerCluster = 128u`) hierarchical cluster pyramid with quadric error metrics (`SymmetricQuadric10`) preserving UVs, normals, and materials.
- `Engine/GeometricRaster/Visibility/ClusterCullEncoder.{h,cpp}` — Two-phase GPU/CPU cluster frustum + normal-cone + continuous screen-space LOD cut + Hi-Z occlusion culling.
- `Engine/GeometricRaster/Visibility/DepthPyramidSequence.{h,cpp}` — Conservative Reversed-Z Hi-Z pyramid.
- `Engine/GeometricRaster/Visibility/VisibilityClusterRasterization.{h,cpp}` — Exact 64-bit Visibility Buffer splitting `>= 4 px` clusters to HW raster and `< 4 px` micro-triangles to SW compute raster.
- `Engine/GeometricRaster/Visibility/VisibilityMaterialResolve.{h,cpp}` — Zero-G-Buffer analytic ray-differential UV Jacobian + 10-lobe OpenPBR resolve.

### 🔧 Exact 3 Additions Required for 10,000+ Botanical Forests

1. **Wind-Padded Conservative Cluster Bounds**: Expand each cluster bounding sphere in `ClusterCullEncoder` by `MaxTrunkSwayRadius = 0.042 * TrunkFlex * PeakWindStrength * Height` so swaying crowns are never falsely occluded by Hi-Z.
2. **Area-Preserving Foliage Cluster Simplification + Cutout Mask**: During `ClusterPyramid` decimation of foliage clusters, preserve total projected leaf cross-sectional area (scale surviving leaf quads up by `sqrt(N_before / N_after)`) so distant forests keep rich silhouette density instead of turning sparse, and route foliage clusters through an alpha-tested VisBuffer path (switching to octahedral impostor clusters beyond `250 m`).
3. **Instanced Cluster Indirect Compaction**: Add a per-instance `BotanicalInstanceGpuRecord` (`64 B`: `WorldPosScale`, `YawSeedPhase`, `SpeciesClusterOffset`, `FractureMask`) so `10,240` forest specimens cull into one GPU indirect draw buffer in `< 0.35 ms`.

---

## 🏆 4. Decision 3 — Wind-Deformed SDF & Global Distance Field (`Analytical Primitives` vs. `VAT/Warped 3D SDF` vs. `Re-Bake`)

Legend: **GPU Cost / VRAM:** `✔️` = Lowest (best) · **Metric SDF Exactness (`|∇d| = 1`) / Wind Sync:** `🔴` = Highest (best).

| Approach | Per-Frame GPU Cost | Memory (`10k` Forest) | WindField Sync | Metric SDF Validity (`|∇d| = 1`) | Overall |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **A. Re-Bake 3D Voxel SDF Per Frame** (`GpuSdfBaker`) | 🔴 `> 25 ms` (unusable) | 🔴 `48 MB × N` | 🔴 Exact | 🔴 Exact | `⭐` |
| **B. Domain-Warped / VAT-Deformed 3D Local SDF Texture** | 🚩 `~2.5 ms` | 🔴 `~16–48 MB` per species | 🚩 Inverse warp error on big bends | 🚩 **Breaks Lipschitz (`|∇d| ≠ 1`)** -> cone/ray banding | `⭐⭐⭐` |
| **🥇 C. Wind-Displaced Analytical Primitives Composited into GDF** *(Recommended)* | ✔️ **`~0.15 ms`** (`64³` Fine+Coarse) | ✔️ **`1.76 KB / specimen`** | 🔴 **100% exact 1 WindField** | 🔴 **Guaranteed `|∇d| <= 1`** (analytic capsules + `smin` spheres) | `⭐⭐⭐⭐⭐` 🏆 |

### 💡 How Wind-Driven Analytical SDF Integrates into Frontier's GDF (`VulkanWorldRenderSequence`)

Instead of baking a static 3D voxel brick per tree or warping a 3D texture (which breaks signed distance Lipschitz bounds under nonlinear limb rotation), extract **two ultra-compact analytical primitive lists directly from the Weber & Penn skeleton at generation time**:

| Primitive Layer | Count / Specimen | GPU Struct Size | Wind Update Formula | GDF Composition Role |
| :--- | :---: | :---: | :--- | :--- |
| **Tapered Wood Capsules** (`Trunk` + `Level-1 Boughs`) | `10 – 16` | `64 B` each (`a, b, rA, rB, windA, windB, pivot`) | Displace endpoints `A` and `B` using the **exact same `frontierApplyUnifiedWind()`** | Hard shadow / contact AO / trunk GI occlusion |
| **Soft-Union Canopy Lobes** (Ellipsoids / Spheres) | `8 – 16` | `48 B` each (`center, radius, windAttr, pivot, porosity`) | Displace lobe center `C` using the **exact same `frontierApplyUnifiedWind()`** | Soft sky AO, indirect bounce GI, dappled volumetric fog occlusion |

- **Total Proxy Memory:** `~28` primitives × `~60 B` = **`1.76 KB` per specimen** (versus `48 MB` for a `256³` voxel grid — a **`27,000×` memory reduction**!).
- **Single Compute Pass into Existing GDF:** Every frame (or whenever WindField delta exceeds threshold), dispatch a lightweight compute pass over the active `GdfFineImage3D` (`64³`, `3.5 m`–`16 m` span) and `GdfCoarseImage3D` (`64³`, `48 m`–`96 m` span) in `VulkanWorldRenderSequence`:
  1. Transform only the `~8–32` specimens intersecting the clipmap AABB using the **exact same `ForceFieldGpuUploader` WindField buffer**.
  2. Evaluate `min(dStaticWorld, smin(dWoodCapsules, dCanopyLobes, k))` directly into the `VK_IMAGE_TYPE_3D` clipmap.
  3. On **HighEnd** GPUs, pair this wind-synced GDF (for diffuse GI & sky occlusion) with **exact `BVH4` / `RayQuery`** (or VisBuffer contact shadows) for razor-sharp close-range leaf-silhouette shadows!

---

## 🧩 5. UV Unwrapping & PBR Texturing (`UVWorkspace` + `OpenPbrDirect`)

Slate's welded quad branch-collar geometry solves the hardest part of procedural bark texturing automatically:
1. **Continuous Cylindrical Trunk & Limb UVs**:
   - `U = (RingColumn / RadialSegments) * round(2 * pi * BaseRadius * BarkScale)` — guaranteed integer wrap count so bark textures tile seamlessly with **zero seam stretch**.
   - `V = CumulativeArcLengthMeters * VerticalBarkScale` — constant world-space texel density from buttress roots through level-3 twigs, so a single `2K` tileable bark PBR material (`BaseColor`, `Normal`, `Roughness`, `AO`) works across all 37 species.
2. **Branch Collar UV Blending**: Blend seam transition weights over `collarRings` (`2–3` rings around each branch fork) and expose the generated `PolygonNetwork` directly to `Engine/Workspaces/UV/` (`UVWorkspace`) if an artist wants to paint custom moss/scar decals or pack unique UDIM hero bark charts.
3. **Foliage Spray Alpha Sheet**: Each terminal leaf quad carries exact `[0,1] × [0,1]` UV coordinates mapped to a species-matched PBR botanical spray sheet (`BaseColor`, `AlphaCutout`, `Normal`, `SubsurfaceTranslucency`, `Roughness`), plus a per-leaf `TintVariation` attribute for natural crown color variance.

---

## 🧩 6. Fracture Integration (`FractureWorkspace` + `SimulationFractureCouplingBridge`)

Making procedural botanical specimens destructible (vehicle crash, storm wind-snap, felling) plugs directly into Frontier's existing fracture architecture:

| Stage | Mechanism | Existing Frontier C++ Module |
| :--- | :--- | :--- |
| **1. Pre-Authored Weak Seams** | Tag fracture collars at trunk base (`15–35%` H) and major Level-1 limb forks using Voronoi-jagged interior cross-section rings with a dedicated `HeartwoodSplinter` material slot. | `Engine/GeometrySpace/Fracture/EngineeringBakedFracture.{h,cpp}` |
| **2. Runtime Impact / Wind-Snap Trigger** | When vehicle impulse (Jolt `PhysicsExtension`) or WindField drag torque exceeds species `BreakMomentNm`, split the `ClusterPyramid` range into `RootedStump` + `DetachedCrown` + `16–32` convex splinter debris pieces. | `Engine/GeometrySpace/Fracture/FastRuntimeFracture.{h,cpp}` + `ConvexPartitioning.{h,cpp}` |
| **3. Rigid-Body Fall & Wind Torque** | Hand `DetachedCrown` (plus its compound convex hull from trunk+bough capsules!) to `RigidBodyDynamics` so it falls downwind, bounces on terrain, and sheds leaf particles via `ParticleGpuSimulation`. | `Engine/SimulationSpace/SimulationFractureCouplingBridge.{h,cpp}` + `RigidBodyDynamics.{h,cpp}` |
| **4. Live SDF / GDF Sync** | Clear the snapped upper-trunk capsules and canopy lobes from the standing proxy list and attach them to the falling rigid-body transform — so the GDF shadow and sky AO fall **with** the tree! | `VulkanWorldRenderSequence` GDF proxy uploader |

---

## 🧩 7. Porting All 37 Slate Presets & Reusing C++ Outliner + Inspector in `Projects/Untitled/`

### 7.1 Target C++20 Module Layout (100% Compliant with `FolderStructure.md`)

| New / Extended File | Responsibility |
| :--- | :--- |
| `Engine/GeometrySpace/Botanical/BotanicalParameters.h` | ISO C++20 structs mirroring Slate's `BotanyParams`, `SurfaceParams`, `RootParams`, `CrownEnvelope` enum (`8` shapes). |
| `Engine/GeometrySpace/Botanical/SpeciesPresetRegistry.{h,cpp}` | All **37 Slate botanical presets** (`8` Oaks · `7` Broadleaf · `4` Conifers · `3` Jungle · `4` Savanna · `9` Desert · `2` Rocky) + grass presets, serializable as canonical TOML `.BotanicalPreset`. |
| `Engine/GeometrySpace/Botanical/WeberPennSkeleton.{h,cpp}` | Deterministic C++20 port of Slate's `skeleton.ts` + `roots.ts` (multi-level stems, forks, collar emergence, tropism, buttress roots). |
| `Engine/GeometrySpace/Botanical/WeldedBarkBuilder.{h,cpp}` | Port of `mesher.ts` emitting Frontier `PolygonNetwork` (cylindrical UVs, `aWind`, `aPivot`, foliage quads) + `BotanicalSdfProxyList` (capsules + canopy lobes). |
| `Engine/Shaders/Botanical/BotanicalWindDeform.slang` | Shared `.slang` module imported by VisBuffer rasterization, shadow depth, and GDF proxy compute — reads `ForceFieldGpuUploader` WindField buffer directly. |
| `Projects/Untitled/Content/Worlds/MainWorld.WorldSpace` | Registers a `GlobalWindField` instance, `BotanicalSpecimen` hero entries, and an `InstancedForestField` entry discovered automatically by `WorldSpaceCodec`. |

### 7.2 Reusing Existing C++ `OutlinerPanel` & `InspectorPanel` (Project Zero Editor Parity)

- **Zero Custom Outliner Rewrite**: Register `BotanicalSpecimen`, `GlobalWindField`, and `InstancedForestField` as standard `WorldInstanceRegister` categories (`CategoryInstances`). `Engine/Components/Panes/OutlinerPanel.{h,cpp}` immediately renders them with Frontier's Project Zero obsidian styling, search pill, filter chips, `#ffb454` selection bar, `#34c759` live status indicator, and eye visibility toggles.
- **Inspector Section Extensions**: Extend `Engine/Components/Panes/InspectorPanel.{h,cpp}` with five Project Zero collapsible inspector sections matching `Experimental/BotanicalWorkbench/` (`Botany`, `Wind`, `Cluster · UV`, `Fracture`, `SDF · GDF`), reusing existing `CapsuleButton`, `ExclusiveSelector`, `DropdownSelector`, and `ScalarSlider`.

---

## 🏁 8. Interactive HTML Reference Workbench (`Experimental/BotanicalWorkbench/`)

Verified live interactive prototype built with **Project Zero Editor UI** (`#090909` obsidian shell, `#121212` docks, trapezoidal tab strip, top Notch, Frontier Outliner, and rounded-capsule Inspector):

| Feature | Verification Status | Where to Test in Workbench |
| :--- | :---: | :--- |
| **All 37 Slate Botanical Presets** (7 groups) | 🟢 Verified (`avg 37 ms`) | Right Inspector → **Botany** → `Botanical Species` dropdown / `Prev` / `Next` |
| **1 Shared WindField** (Direction, Speed, Gusts, Wavelength, Vortex) | 🟢 Verified | Right Inspector → **Wind** tab + `Wind Vectors` viewport mode |
| **Leaf Shuffle Modes** (`Analytic` · `VAT Sheet` · `Hero XPBD`) | 🟢 Verified | Right Inspector → **Botany** → `Leaf Shuffle Solver` selector |
| **128-Tri LOD Clusters + Bounding Spheres + LOD 0–3** | 🟢 Verified | Top Viewport Bar → **`Clusters`** + Right Inspector → **Cluster·UV** |
| **Cylindrical Bark UV + Leaf Alpha Sheet + UV Checker** | 🟢 Verified | Top Viewport Bar → **`UV Checker`** + Swatch previews in **Cluster·UV** |
| **Interactive Voronoi Trunk Fracture + Falling Crown + Splinters** | 🟢 Verified | Top Viewport Bar → **`Fracture`** → **`Snap Trunk`** / **`Restore`** |
| **Wind-Deformed Analytical SDF Capsules & Canopy Lobes + Live GDF Section** | 🟢 Verified | Top Viewport Bar → **`SDF Proxies`** + Bottom-Right **Live GDF Section** canvas |
| **10,240-Instance GPU Forest Driven by Traveling WindField Waves** | 🟢 Verified | Top Viewport Bar → **`Grove (64)`** / **`Forest (10,240)`** |
