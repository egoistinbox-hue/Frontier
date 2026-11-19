# Frontier Celestial Atmosphere · Solar Lens Flare · Global Illumination Port Plan

**Status:** Active — P0 delivered, P1–P6 sequenced
**Target branch:** `arena/f56476ff-frontier` (baseline tree imported from `streamlinkinbox/Frontier@arena/587b292c-frontier`, `fedd00d`)
**Reference branch:** `SultanAladin/Frontier-1@arena/39c6910b-frontier-1` (`2d3b92b`)
**Dual-app contract:** `Experimental/FrontierWorldMirror/` (HTML/JS prototype) is the visual ground truth; `Engine/GeometricRaster/` (ISO C++20 + `.slang`) is the native mirror. Every parameter added to one app lands in the other under the same name.

---

## 1. Objective

| # | Goal | HTML (`Experimental/FrontierWorldMirror`) | Native (`Engine/` + `Exhibits/`) |
| :- | :--- | :--- | :--- |
| 1 | Physical sky (Rayleigh + Mie + ozone) with sun, moons, starfield, clouds, fog | `AtmosphereSky.js` + `GtxWorldViewport.jsx` sky pass | `Engine/GeometricRaster/Atmosphere/*` + `Engine/Shaders/Atmosphere/*.slang` |
| 2 | Solar lens flare (anamorphic / streaks / halos) | flare composite in viewport + `Optics` card | `LensFlareSequence` + `LensFlareCompute.slang` + `LensFlareBakeCompute.slang` |
| 3 | Card-driven authoring of every sky / sun / flare parameter | `InspectorDepot/panels/{sun,clouds,fog,moon}.js`, `Inspectors.jsx` Sun · Atmosphere · Environment/Optics cards | `Engine/Components/Panes/InspectorPanel` sections |
| 4 | Global illumination + reflections "Unreal-like" but deterministic (cone radiosity + BVH trace, zero Monte Carlo boiling) | `ShowcaseGalleryScene.js` render settings + `GtxWorldViewport.jsx` GI/reflection passes | `TieredWorldRenderSequence` 5-engine ladder + `IrradianceLatticeSequence` + `SpecularReflectionSequence` |
| 5 | Both apps run and are verifiable from a browser and from the editor | `Serve.py` :8098, raw.githack | `FrontierEditor` executable + `Exhibits/*Validation` |

---

## 2. Delivered in This Turn (P0)

| Item | Result | Evidence |
| :--- | :--- | :--- |
| Baseline tree imported | 1 744 tracked files from `src/arena/587b292c-frontier` committed on `arena/f56476ff-frontier` | `git log` |
| HTML mirror served | `python3 Experimental/FrontierWorldMirror/Serve.py 8098` on `0.0.0.0:8098` — `HTTP 200`, `5 368 252` bytes | live preview |
| Self-contained check | zero external `<script src>`, `<link href>`, `<img src>`; only optional `cdn.fontshare.com` `@font-face` fallbacks | `grep` audit |
| Bundle reproducible | `node Experimental/FrontierWorldMirror/Build.mjs` rebuilds a **byte-identical** `index.html` (`md5 12588967…`) using `esbuild@0.25.12` from `Experimental/FrontierEditor/node_modules` | build log |
| Mirror self-test | `node Experimental/FrontierWorldMirror/WorldMirrorValidation.mjs` → **ALL 14 SUITES PASSED** | log |
| raw.githack route | single-file bundle means raw.githack needs no asset hosting | §12 |

> Reproducible rebuild is the key enabler: every HTML-side feature below can be authored in `.jsx/.js` sources, compiled here, and diff-verified instead of hand-edited into the 5.1 MiB bundle.

---

## 3. Capability Audit — Target vs Reference

| Capability | Target (`587b292c`) | Reference (`39c6910b`) | Port action |
| :--- | :--- | :--- | :--- |
| `Engine/GeometricRaster/Atmosphere/` | absent | 12 files (sky LUT, ephemeris, flare, moons, clouds, fog, wind) | copy + adapt includes |
| `Engine/Shaders/Atmosphere/` | absent | 6 `.slang` compute units | copy + register in `PrepareShaderToolchain.py` |
| Sky in viewport | analytic `evalSky()` gradient (`GtxWorldViewport.jsx:632`) | Bruneton/Hillaire sky-view LUT + transmittance + aerial perspective | replace analytic pass |
| Sun/ephemeris | `Solar.mjs` solar position only, cards static | `CelestialEphemerisSolver` (tint source, cycle speed, azimuth/elevation) wired both sides | add solver usage + card wiring |
| Lens flare | "Lens Flare" optics card with disabled tiles | `LensFlareSequence` + 3 baked styles + gain/occlusion projection | implement + wire |
| Clouds | `CloudDeckPanel.jsx` static shell | 12 `CloudCategoryType`, wind advection, cloud shadows | adopt |
| GI engines | 2 tiers (`Tier1GtxCalibrated`, `Tier2RtxDeterministic`) | 5 engines (`MatCap`, `OpenPbrDirect`, `DdgiRaytracing`, `SdfGlobalIllumination`, `DeterministicPathTrace`) | extend enum + dispatch |
| GI card | none (flags only, `Inspectors.jsx:623`) | `Global Quality Tier` · `Global Illumination` · `Reflections` cards + `GI_ALGORITHMS` / `REFLECTION_ALGORITHMS` / `QUALITY_PRESETS` | add |
| Reflection control | single-bounce hard-wired | `SpecularReflectionSource::{WideTreeRaytrace, SkyEnvironment}` + rays/bounces/quality | add |
| Determinism | contact clip + 6-cone SDF | adds `DeterministicIntegrators.h`, Sobol (0,2), VoxelSdfClipmap compute | copy |

---

## 4. Shared Parameter Model (single source of truth)

`Experimental/FrontierWorldMirror/ShowcaseGalleryScene.js` gains the canonical settings record already proven in the reference; the native mirror gains the same fields in `WorldRenderConfiguration`.

```js
// ShowcaseGalleryScene.js  (HTML)
export const SHADOW_ALGORITHMS     = [{ id: "contact_pcss" | "pcss" | "smrt" | "pcf" | "bvh", … }]
export const GI_ALGORITHMS         = [{ id: "sdf" | "bvh" | "off", … }]
export const REFLECTION_ALGORITHMS = [{ id: "bvh" | "env", … }]
export const QUALITY_PRESETS       = [Low, Medium (GTX), High, Ultra, Reference]
export const CanonicalRenderSettings = { ShadowAlgorithm, GiAlgorithm, GiQuality, GiCones, GiSamples,
                                         ReflectionAlgorithm, ReflectionQuality, ReflectionRays,
                                         ReflectionBounces, FillBoost, … }
export function ResolveRenderSettings(Subject, Values) { … }   // migrated-save safety
```

```cpp
// TieredWorldRenderSequence.h  (C++)
enum class WorldRenderEngine : uint8_t { MatCap, OpenPbrDirect, DdgiRaytracing, SdfGlobalIllumination, DeterministicPathTrace };
struct WorldRenderConfiguration {
    WorldRenderEngine Engine = WorldRenderEngine::SdfGlobalIllumination;
    SolarShadowAlgorithm ShadowAlgorithm = SolarShadowAlgorithm::ContactPcss;
    SpecularReflectionSource ReflectionSource = SpecularReflectionSource::WideTreeRaytrace;
    bool GlobalIlluminationEnabled = true, ReflectionsEnabled = true, RaytracingEnabled = true;
    uint32_t QualityTier = 1u, PathTraceSamples = 16u, PathTraceMaxBounces = 5u;
};
```

**Parity gate:** `WorldMirrorValidation.mjs` asserts each card identifier resolves to a `CanonicalRenderSettings` key whose name matches the C++ field (`GiAlgorithm ↔ Engine`, `ReflectionAlgorithm ↔ ReflectionSource`, `GiQuality ↔ QualityTier`).

---

## 5. Phase Ledger

| Phase | Scope | Exit criteria |
| :--- | :--- | :--- |
| **P0 ✅** | Import target tree, serve HTML, prove rebuild + validation, raw.githack route | HTTP 200 · byte-identical rebuild · 14 suites pass |
| **P1** | Atmosphere source: copy `Engine/GeometricRaster/Atmosphere/` + 6 `.slang`, add `SkyViewTransmittanceCompute` bindings, port `AtmosphereSky.js` | sky renders day→night cycle; `Exhibits/AtmosphereAuditProof` green |
| **P2** | Sun/ephemeris authoring: `CelestialEphemerisSolver` usage, sun card live bindings (azimuth, elevation, illuminance, tint source, cycle speed, disc size) | sun card moves sun in both apps; sun azimuth parity ±0.01° |
| **P3** | Lens flare: `LensFlareSequence` + atlas bake + projection, flare card (style, intensity, threshold, ghost count, halo radius, tint, occlusion fade) | three styles render; occlusion attenuates gain |
| **P4** | GI + reflections model in HTML: `CanonicalRenderSettings`, three cards, `GtxWorldViewport` SDF-cone / BVH-GI / reflection passes, `CpuGtxFallbackRenderer` parity | card change alters render; fallback matches GPU within pixel gate |
| **P5** | Native GI: 5-engine ladder, `DeterministicIntegrators`, `VoxelSdfClipmap`, upgraded `IrradianceLatticeSequence` + `SpecularReflectionSequence` | `TieredWorldRenderValidation` + `GtxReflectionBenchmark` within 5 % delta |
| **P6** | Native inspector cards in `InspectorPanel` (sky, sun, flare, GI, reflections) composed from existing `Engine/Components` kit | `.png` parity capture vs HTML |
| **P7** | Proofs: `Exhibits/Images/{Atmosphere,GlobalIllumination}/*.png`, tracker update, performance table | all exhibits deterministic |

---

## 6. File-Level Port Manifest

### 6.1 Atmosphere (P1–P3)

| Reference file | Target destination | Notes |
| :--- | :--- | :--- |
| `Engine/GeometricRaster/Atmosphere/AtmosphericSkySequence.{h,cpp}` | same | medium configuration (13 fields), sky-view LUT 96×48 |
| `…/CelestialEphemerisSolver.{h,cpp}` | same | `SolarTintSource`, `DayCycleSpeedPreset`, azimuth/elevation outcome |
| `…/LensFlareSequence.{h,cpp}` | same | 3 styles, 512×256 atlas, gain/occlusion projection |
| `…/LunarStarfieldSequence.{h,cpp}` | same | 6 moon presets, catalog stars |
| `…/VolumetricCloudSequence.{h,cpp}` | same | 12 cloud categories, wind advection, cloud shadow config |
| `…/VolumetricFogSequence.{h,cpp}` | same | height fog, aerial fog, local volumes |
| `…/AtmosphericWindSolver.{h,cpp}` | same | shared wind for clouds/fog |
| `Engine/Shaders/Atmosphere/*.slang` (6) | same | register in `Automation/PrepareShaderToolchain.py` |
| `Experimental/FrontierWorldMirror/AtmosphereSky.js` | same | CPU parity of the LUT + starfield |
| `Experimental/FrontierWorldMirror/InspectorDepot/panels/sun.js` | same | drive from live settings, not static shell |

### 6.2 Global illumination + reflections (P4–P5)

| Reference file | Target action |
| :--- | :--- |
| `GeometricRaster/GlobalIllumination/DeterministicIntegrators.h` | new |
| `…/TieredWorldRenderSequence.{h,cpp}` | replace 2-tier with 5-engine dispatch (keep tier aliases) |
| `…/IrradianceLatticeSequence.{h,cpp}` | upgrade (Fibonacci ray count, bounce passes) |
| `…/SpecularReflectionSequence.{h,cpp}` | upgrade (raytraced + sky-environment sources) |
| `…/VulkanWorldRenderSequence.{h,cpp}` | upgrade GPU path |
| `Engine/Shaders/GlobalIllumination/{DistanceEvaluation,SpecularGlassRaytrace,VoxelSdfClipmapCompute}.slang` | new; note `SpecularAndGlassRaytrace.slang` is superseded |
| `Experimental/FrontierWorldMirror/ShowcaseGalleryScene.js` | add settings + algorithm tables |
| `Experimental/FrontierWorldMirror/GtxWorldViewport.jsx` | cone GI, BVH GI, reflection passes, GI debug views |
| `Experimental/FrontierWorldMirror/CpuGtxFallbackRenderer.js` | CPU mirror of the same math |
| `Experimental/FrontierWorldMirror/ShadowPipeline.js` | new (contact/PCSS/SMRT/PCF/BVH ladder feeds GI visibility) |

---

## 7. Inspector Card Specification

### 7.1 Sun card (`panels/sun.js` → Sun · Sun illumination section)

| Control | Range / unit | Backing field |
| :--- | :--- | :--- |
| Clock rate | `1…600 ×` | `DayCycleSpeedPreset` / `CycleMultiplier` |
| Illuminance at noon | `0…160 klx` | `SolarCelestialConfiguration.IntensityKlux` |
| Tint source | RGB swatch · Kelvin | `SolarTintSource::{RgbTint, KelvinTemperature}` |
| Disc diameter | `0.5…2.0 °` | `SunAngularRadiusDegrees` |
| Azimuth / Elevation | `0…360 °` / `-90…90 °` | `SolarEphemerisOutcome.{AzimuthDegrees, ElevationDegrees}` |
| Sun direction gizmo (`SunGizmo`) | hemisphere drag | `WorldDirectionToSun` |
| Flare subcomponent row | opens Optics card | `LensFlareStyle` |

### 7.2 Environment / Optics — Lens Flare card

| Control | Range | Backing field |
| :--- | :--- | :--- |
| Style | Anamorphic · Streaks · Halos | `LensFlareStyle` |
| Intensity / Gain | `0…4 ×` | `FlareGain` |
| Threshold | `0…4` | `OcclusionThreshold` |
| Ghost count | `0…12` | `GhostCount` |
| Halo radius | `0.05…1.0` | `HaloRadius` |
| Tint | linear RGB | `SourceTint` |
| Occlusion fade | `0…1` | `EffectiveGain` falloff |

### 7.3 Render — Global Quality Tier · Global Illumination · Reflections

| Card | Controls | Backing field |
| :--- | :--- | :--- |
| Global Quality Tier | Low · Medium (GTX) · High · Ultra · Reference | `QualityTier` (+ derived rays/taps) |
| Global Illumination | Algorithm `SDF Cone GI` / `BVH Raytraced GI` / `Off (Ambient Fill)`; GI Quality; Cone GI Directions `4…14`; BVH GI Samples `2…20`; Sky & Ambient Fill `0.2…2.5 ×` | `GiAlgorithm`, `GiCones`, `GiSamples`, `FillBoost` |
| Reflections | Mode `BVH Raytraced Refl` / `Sky / Env Only`; Reflection Quality; Rays/Pixel `1…8`; Max Bounces `1…3` | `ReflectionAlgorithm`, `ReflectionRays`, `ReflectionBounces` |

Quality preset mapping (identical on both sides):

| Preset | BVH rays | SMRT rays | PCSS taps | GI samples | GI cones | Refl rays |
| :--- | --: | --: | --: | --: | --: | --: |
| Low | 1 | 2 | 8 | 4 | 4 | 1 |
| Medium (GTX) | 2 | 4 | 16 | 6 | 6 | 2 |
| High | 4 | 6 | 24 | 10 | 8 | 4 |
| Ultra | 8 | 8 | 32 | 14 | 10 | 6 |
| Reference | 16 | 12 | 48 | 20 | 14 | 8 |

---

## 8. Rendering Sequence (both apps, same order)

```text
Visibility (cluster cull, Hi-Z)
   └─► Atmosphere: sky-view LUT + transmittance + clouds + fog + starfield + moons
        └─► Direct: OpenPBR + LTC area lights + shadow ladder (contact / PCSS / SMRT / PCF / BVH)
             └─► Indirect GI: SDF cone radiosity (default) | BVH hemisphere (reference) | ambient fill
                  └─► Specular: BVH raytrace + glass peel | sky-environment probe
                       └─► Lens flare composite (occlusion-weighted, HDR before tonemap)
                            └─► ACES filmic + sRGB  →  viewport
```

Deterministic rules inherited from the reference: fixed Sobol (0,2) sequences, no temporal jitter across frames, no blind Monte Carlo (see [RenderingRaytracingArchitecturePlan.md](RenderingRaytracingArchitecturePlan.md), `MaximumOptimizationPixelDelta = 0.05f`).

---

## 9. Native Integration Points

| File | Change |
| :--- | :--- |
| `Engine/GeometricRaster/GlobalIllumination/TieredWorldRenderSequence.{h,cpp}` | 5-engine dispatch + atmosphere inputs (`AtmosphericMediumConfiguration`, `CloudDeckConfiguration`, `AtmosphericFogConfiguration`, `ProjectedLensFlareFrame`) |
| `Engine/GeometricRaster/GlobalIllumination/ShowcaseGalleryScene.{h,cpp}` | solar emitter fields fed by `CelestialEphemerisSolver`, flare source binding |
| `Engine/Components/Panes/ViewportProjectionPane.{h,cpp}` | composite flare after specular, before tonemap |
| `Engine/Components/Panes/InspectorPanel.{h,cpp}` | four new card sections (§7) built from `CapsuleButton`, `DropdownSelector`, `ScalarSlider`, `ColourSwatchPicker` |
| `Engine/Codecs/ProjectCodec.{h,cpp}` | persist sky/sun/flare/GI settings in `.ProjectSpace` |
| `CMakeLists.txt` | add `Atmosphere` sources to `FrontierEngine`, add `AtmosphereAuditProof` exhibit |

Repository mandates that apply: GPU-only overlays (CLAUDE.md §2.1), `.slang`-only shaders (§2.2), three build profiles (§2.4), HTML ground truth + `.png` parity (§2.5), plan/report in Markdown Studio (§2.6), no `And` conjunctions in filenames (§2.7).

---

## 10. Verification Matrix

| Gate | Command | Pass condition |
| :--- | :--- | :--- |
| HTML self-test | `node Experimental/FrontierWorldMirror/WorldMirrorValidation.mjs` | 14 suites pass (baseline today) |
| HTML rebuild determinism | `node Experimental/FrontierWorldMirror/Build.mjs` | `git diff --exit-code Experimental/FrontierWorldMirror/index.html` clean after commit |
| Sky day cycle | `Exhibits/AtmosphereAuditProof` | dawn · sunrise · sunset · noon · orbital · six moons · starfield `png` diffs stable |
| GI ladder | `Exhibits/TieredWorldRenderValidation` | each engine produces distinct, deterministic buffers |
| Reflections | `Exhibits/GtxReflectionBenchmark` | ≤ 5 % mean pixel delta vs reference |
| UI parity | `FrontierEditor --frames=4 --capture-png=…` | panel bounds match HTML capture |
| Native build | `cmake -DFRONTIER_PROFILE=Editor … && cmake --build build` | editor target links |

---

## 11. Risks

| Risk | Impact | Mitigation |
| :--- | :--- | :--- |
| Branches diverged by ~200 k lines / 1 064 files | blind copy breaks includes | port subsystem-by-subsystem; compile after each phase |
| Shader toolchain needs `slangc` + `ExternalPackages` (not in sandbox) | native P1–P5 cannot be compiled here | author + verify by inspection; compile gate on user's machine |
| 5.1 MiB single-file HTML bundle | merge conflicts unreadable | never hand-edit `index.html`; always rebuild from sources |
| GI algorithms change look of the calibrated gallery | visual regression | keep `Tier1GtxCalibrated` naming alias, ship `SdfGlobalIllumination` as default |
| Lens flare atlas bake cost | first-frame hitch | bake lazily on style change, cache 3 tiles |

---

## 12. Run & Serve Commands

```bash
# HTML prototype (this turn's live preview)
python3 Experimental/FrontierWorldMirror/Serve.py 8098      # http://0.0.0.0:8098/

# Rebuild the standalone bundle after editing .jsx/.js sources
cd Experimental/FrontierEditor && npm install esbuild@0.25.12
cd ../.. && node Experimental/FrontierWorldMirror/Build.mjs

# raw.githack (works because the bundle embeds every asset)
#   branch URL : https://raw.githack.com/egoistinbox-hue/Frontier/arena/f56476ff-frontier/Experimental/FrontierWorldMirror/index.html
#   SHA URL    : https://raw.githack.com/egoistinbox-hue/Frontier/<commit-sha>/Experimental/FrontierWorldMirror/index.html
#   (prefer the SHA form after the branch moves; "www." host adds CDN caching)

# Markdown Studio (plan review)
python3 Automation/BuildMarkdownViewer.py
python3 Automation/ServeMarkdownStudio.py --host 0.0.0.0 --port 8080

# Native editor mirror (deferred to the next turn)
python3 Automation/PrepareDependencies.py && python3 Automation/PrepareShaderToolchain.py && python3 Automation/PrepareFonts.py
cmake -S . -B build -DFRONTIER_PROFILE=Editor -DCMAKE_BUILD_TYPE=RelWithDebInfo
cmake --build build --target FrontierEditor
./build/FrontierEditor --frames=4 --capture-png=Exhibits/Images/WorldMirror/editor.png
```

---

## 13. Open Decisions for the User

| # | Question | Recommended |
| :- | :--- | :--- |
| 1 | Default GI engine shipped to users | `SdfGlobalIllumination` (GTX-safe, deterministic, noiseless) |
| 2 | Flare default style | `Halos` (photographic, least distracting in the gallery) |
| 3 | Should the physical sky replace the analytic gallery sky entirely, or stay a switchable `Studio` fallback | Switchable — keeps existing calibrated proofs valid |
| 4 | Port order | HTML first (P1–P4) then native (P5–P6), matching the HTML-ground-truth mandate |
