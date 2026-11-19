# Frontier World Mirror — Realistic Sky & Sun, Lens Flare, and Voxel SDF Clipmap GI / Reflections

**Status:** HTML prototype implemented and validated · C++ mirror parity scheduled for the next pass
**Branch:** `arena/312f8224-frontier`
**Scope:** `Experimental/FrontierWorldMirror/` (HTML Tier 1 GTX mirror) + documentation

---

## 1. What was imported

| Source | Commit / branch | Imported |
| :--- | :--- | :--- |
| `streamlinkinbox/Frontier` | `arena/587b292c-frontier` (`fedd00d`) | HTML prototype + C++20 mirror of the World Mirror, editor shell, inspector depot |
| `SultanAladin/Frontier-1` | `arena/39c6910b-frontier-1` (`2d3b92b`) | Atmosphere overhaul (`49ef5d9`), **2-cascade Voxel SDF Clipmap GI + multi-bounce Surface Cache** (`c6ed040`), baked optics/sky atlases, Component Class, Shadow/Parametric exhibits |

The second branch is a **superset** of the first: it already carries the World Mirror HTML prototype *and* the
C++20 engine, plus the native atmosphere and clipmap-GI work. The mirror was therefore based on the superset so
the GI commit lands natively instead of being cherry-picked into a diverged tree. The only files removed on
import are the multi-hundred-megabyte screenshot banks (`Exhibits/Images/`, `Audit Proof/`) and the stray
1.5 MB exported patch, which are documentation proofs rather than sources.

### Two versions of the application

| Version | Location | Run |
| :--- | :--- | :--- |
| **HTML prototype** | `Experimental/FrontierWorldMirror/` | `python3 Experimental/FrontierWorldMirror/Serve.py 8098` → `http://<host>:8098/` |
| **C++ mirror** | `Engine/GeometricRaster/GlobalIllumination/*`, `Engine/GeometricRaster/Atmosphere/*`, `Engine/Lifecycle/*`, CMake targets | `cmake -S . -B Build/Editor -G Ninja -DFRONTIER_PROFILE=Editor && cmake --build Build/Editor` |

This pass only builds, serves and validates the **HTML** version (as requested). The C++ target requires the
pinned Vulkan/Slang/ImGui toolchain (`Automation/PrepareDependencies.py`) and a GPU ICD, which the authoring
sandbox does not provide.

---

## 2. Realistic sky and sun

The sky is the existing Hillaire/Bruneton sky-view model, unchanged in structure:

* transmittance LUT (128×32) → sky-view LUT (96×48, RGBA16F, uploaded on `TEXTURE8`/`TEXTURE7`),
* Rayleigh + Mie + ozone absorption, multi-scatter approximation, ground albedo bounce,
* `ComputeSolarTransmittance()` drives the solar emitter colour/intensity through the same atmosphere.

New photosphere authoring (Sun ▸ **Sun disc** card):

| Card field | Record key | Shader | Effect |
| :--- | :--- | :--- | :--- |
| `Limb Darkening` | `Sun.Limb Darkening` (0–1, default 0.65) | `evalSkyPrimary()` → `uSunDiscCfg.x` | Hillaire limb profile `0.55 + 0.45·μ^0.45`, blended against a flat disc |
| `Aureole` | `Sun.Aureole` (0–2, default 0.35) | `evalSkyPrimary()` → `uSunDiscCfg.y` | Solar aureole/corona forward-scatter lobe (`cos^160`) |

Both are part of `ComputeNonCameraSceneSignature()`, so changing them invalidates the cached frame exactly
like a sun move. The atmosphere card continues to own Rayleigh/Mie/Mie-anisotropy/ozone/scale-height/top/
horizon glow/tint/brightness/ground albedo, all of which already flow into `BuildSkyViewLut()` and the
`uAtmoCfg*` uniforms.

---

## 3. Lens Flare — a real composite, not an illustration

Previously the Inspector had a "Lens Flare" card whose own copy admitted it was an *HTML optical
illustration, not the renderer composite*. It is now a renderer pass.

### Specification (`LensFlare.js`)

* `CanonicalFlare` — calibrated defaults identical to `NativePanels.json` (Cinematic, 1.0×, 6 ghosts,
  halo 0.28, chromatic 0.6, 6 blades, all three layers armed).
* `ResolveFlareSettings()` — clamps every authored value and folds row visibility/power into `enabled`.
* `EncodeFlareUniforms()` — packs five `vec4` blocks (`uFlareCfg0…4`).
* `ProjectSunToScreen()` — solar-disc UV + forward depth (rejects suns behind the camera).
* `BuildFlareGhostChain()` — the mirrored ghost chain (shared by the shader preview and the card).
* `SunDiscVisibility()` — disc coverage from the packed scene alpha.

### Composite (`OUTLINE_FRAGMENT_SHADER`, pass 2)

The blit pass now does silhouette outline **and** flare:

1. **Occlusion** — 21 taps around the projected disc read the packed scene alpha (0 = sky, >0 = surface).
   Coverage → visibility; a fully covered disc extinguishes the flare.
2. **Cloud/horizon attenuation** — the rendered luminance at the disc position gates the effect, so heavy
   cloud or a low sun fades it naturally.
3. **Ghosts** — up to 24 elements mirrored through the optical axis, aperture-polygon (round/hex/octagon)
   shaped, spectrally dispersed by the `Chromatic` amount.
4. **Aperture halo** — Airy ring at `Halo Radius`, widened by `Halo width`.
5. **Anamorphic streak** — cylindrical rear-element horizontal band (blue/cyan) with a hot core.
6. **Starburst** — `Ray pairs` diffraction spikes modulated by the aperture blade count and `Rotation`.
7. Screen-blended inside the graded image so the energy blooms instead of clipping; the innermost pixels are
   masked because the disc itself is already saturated by the scene pass.

### Outliner & Inspector

* Canonical `Lens Flare` row (icon `lens-flare`) parented under `Sun`; `EnsureLensFlare()` re-inserts it on
  documents authored before the pass existed.
* Sun card ▸ the **Lens Flare** subcomponent is now a live link that selects the flare row and states whether
  the optical path is bound.
* Flare card: `GPU COMPOSITE` status, live ghost/streak/starburst preview built from the *same* chain the
  shader draws, sun-binding card, and full authoring (types, layer toggles, spread, rotation, rays, ghost
  brightness/spacing/shape, halo, chromatic, aperture blades).

---

## 4. Global Illumination and Reflections (Unreal-style DFGI, zero RTX)

Ported from the referenced clipmap-GI commit into the HTML mirror:

* **`VoxelSdfClipmapGi.js`** builds **two cascades** of voxelised signed distance:
  * cascade 0 — near/gallery interior, default 48³ over ≈6 m,
  * cascade 1 — chamber shell, default 38³ over ≈18 m.
  * Union of analytic SDFs (box/sphere/capped cylinder/cone/torus) using the *same* rotation columns as
    `PackSceneDataBuffer`, so surfaces cannot drift from the raster primitives.
* **Surface cache + multi-bounce radiosity** — per voxel: albedo/emission from the nearest primitive, SDF
  gradient normal, solar visibility by SDF march, 12-cone sky visibility, then Jacobi diffusion for 1–4
  bounces. Colour bleed from the crimson/emerald walls and the emissive softbox therefore exists in the cache.
* **Packing** — RGBA16F volume, `.r = signed distance (metres)`, `.gba = radiosity`; two `TEXTURE_3D` volumes
  (`TEXTURE9`, `TEXTURE10`). Rebuilds are keyed on the scene signature + clipmap optics, so camera moves are free.
* **Shader** (`VOXEL_SDF_CLIPMAP_GI`):
  * `clipSdfWorld()` / `clipRadianceAt()` — cascade-selecting trilinear fetches,
  * `clipTrace()` — adaptive sphere tracing, `clipSurfaceNormal()` — gradient normal,
  * `evaluateClipmapGi()` — cached radiosity + 4-cone sky occlusion,
  * `traceClipmapReflection()` — up to 3 sphere-traced bounces reading the same cache, with solar highlight
    and solar visibility, falling back to `evalSky()` on a miss.
* **Mode codes** — `GiAlgorithm: "clipmap" → uGiAlg = 3`, `ReflectionAlgorithm: "sdf" → uReflAlg = 3`
  (`EncodeRenderSettingsUniforms`). Both are the new defaults; Cone GI, BVH GI, BVH reflections, Sky/Env and
  Off remain selectable.

Render Settings ▸ **Global Illumination** now exposes clipmap cascades, voxel resolution (32³…64³), radiosity
bounces, clipmap radiance gain, sky-occlusion weight and occlusion march steps; **Reflections** exposes the
SDF trace step count alongside rays/bounces. All values are clamped by `ResolveRenderSettings()`.

---

## 5. Inspector card ↔ uniform map

| Inspector card | Field | Uniform / buffer | Shader path |
| :--- | :--- | :--- | :--- |
| Sun ▸ Sun disc | Limb Darkening, Aureole | `uSunDiscCfg` | `evalSkyPrimary()` |
| Sun ▸ Sunlight intensity / Temperature / Direction | Intensity, Temperature, Direction | `uSunIrradiance`, `uSunDir` | direct lighting, sky LUT rebuild |
| Sun ▸ Lens Flare link | (selection) | — | opens the flare row |
| Lens Flare ▸ everything | Enabled/Type/Intensity/Ghosts/Halo/Chromatic/Blades/Streak/Spread/Rotation/Rays/Shapes | `uFlareCfg0…4` | `compositeLensFlare()` |
| Atmosphere | Rayleigh, Mie, Mie anisotropy, Ozone, scale heights, top, glow, tint, brightness, ground albedo | `uAtmoCfg0/1`, sky-view LUT | `BuildSkyViewLut()` + `evalSky()` |
| Render Settings ▸ GI | Algorithm, Quality, Cone dirs, BVH spp, Cascades, Voxel res, Radiosity bounces, Radiance gain, Sky occlusion, Occlusion steps, Bounce intensity, Fill | `uGiAlg`, `uGiCones`, `uGiSamples`, `uClipCfg0/1`, `uGiIntensity`, `uFillBoost` | `evaluateMultiModeGi()` |
| Render Settings ▸ Reflections | Mode, Quality, Rays, Bounces, SDF steps | `uReflAlg`, `uReflRays`, `uReflBounces`, `uClipCfg1.w` | `traceClipmapReflection()` / BVH |

---

## 6. Running it

### Local server (this pass)

```bash
python3 Experimental/FrontierWorldMirror/Serve.py 8098
# http://<host>:8098/            → the mirror
# http://<host>:8098/?backend=webgpu  → A/B the WebGPU path (no flare/clipmap pass there)
```

### raw.githack (no server)

The bundle is a **single self-contained `index.html`** (inline CSS, inline ES2019 bundle, inline icons, glyphs,
fonts, moon tiles and shader-ball mesh), which is what makes it raw.githack-safe:

```bash
node Experimental/FrontierWorldMirror/Build.mjs     # regenerates index.html
git add Experimental/FrontierWorldMirror/index.html && git commit -m "…" && git push
```

```
https://raw.githack.com/egoistinbox-hue/Frontier/<commit-sha>/Experimental/FrontierWorldMirror/index.html
# or, branch form (dev URL, ~5 min CDN refresh):
https://raw.githack.com/egoistinbox-hue/Frontier/arena%2F312f8224-frontier/Experimental/FrontierWorldMirror/index.html
```

Use the **commit SHA** form in production: branch names containing `/` are ambiguous for CDN path parsing.

The only repository-relative fetch left is the ControlVehicle BVH
(`../ShadowAlgorithmLab/Assets/VehicleBenchmarkAssets.bin`), which raw.githack serves with CORS. If it is
blocked, the vehicle degrades to its primitive proxy and every other feature is unaffected.

### Build notes

`Build.mjs` was hardened for reproducible clones: repository assets (icons, glyphs, fonts, moon tiles,
shader-ball mesh) are ingested **when present**, and the previous bundle supplies anything absent instead of
aborting with `ENOENT`. This is why `EngineContent/Fonts`, `CelestialTextures` and
`Exhibits/DistanceFieldGI/` — which are referenced but not committed on every branch — no longer break the
build.

---

## 7. Validation performed

| Check | Command | Result |
| :--- | :--- | :--- |
| Mirror suite (now **20** suites) | `node Experimental/FrontierWorldMirror/WorldMirrorValidation.mjs` | all pass |
| New suite 20 — flare & clipmap | included above | ghost chain, projection, occlusion, half-float round-trip, cascade finiteness, radiosity > 0, mode-code mapping, legacy-row re-insertion |
| GLSL ES 3.00 syntax | `@shaderfrog/glsl-parser` over every ``export const *_SHADER`` | all four programs parse |
| Bundle build | `node Experimental/FrontierWorldMirror/Build.mjs` | 5.33 MiB standalone `index.html` |
| DOM smoke test (jsdom, WebGL stubbed out) | jsdom + `runScripts` | editor mounts, zero console errors, Lens Flare + Render Settings present |
| HTTP serve | `curl http://127.0.0.1:8098/` | `200`, 5.59 MB, contains the clipmap + flare code |

Not verifiable in this sandbox: real GPU rasterisation (no browser/ICD), so pixel acceptance still needs one
human pass in Chrome/Firefox.

---

## 8. C++ mirror parity — next pass

1. `Engine/Components/Camera/VisualEffects/LensFlareEffect.h` already declares the native flare; wire
   `LensFlareSequence` + `EngineContent/Optics/LensFlareBakedAtlas.ImageSpace` to the same authored record and
   port the occlusion/composite ordering (`SceneDepth` → ghosts → halo → streak → starburst).
2. `VoxelSdfClipmap` already exists natively (2 cascades, surface cache, radiosity from `c6ed040`). Expose the
   HTML slider set 1:1 in the ImGui Render Settings card and mirror `GiClipmap*`/`ReflectionSdfSteps` names.
3. Add a native `FrontierWorldMirrorValidation` case per HTML suite 20 so both versions fail together.
4. Rebuild `Build/Editor` with `FRONTIER_PROFILE=Editor` once `Automation/PrepareDependencies.py` and a Vulkan
   ICD are available, then capture GPU proofs into `Exhibits/Images/`.

## 9. Known limits

* WebGPU and CPU backends do not carry the flare/clipmap passes yet; the mirror defaults to WebGL2 for parity
  and `?backend=webgpu` is diagnostic only.
* Clipmap builds are synchronous (~0.5 s at 40³, ~1 s at 64³) and only run when geometry/sun/optics change
  while a clipmap mode is selected. A worker-based build is the obvious follow-up if authoring scrubbing feels
  heavy.
* The clipmap is a coarse proxy: thin geometry under one voxel and the dispersive glass orb do not occlude
  radiosity (glass is deliberately non-occluding, matching the native clipmap).
