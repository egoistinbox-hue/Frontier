# Frontier World Mirror — Tier 1 GTX (`C++20 <-> HTML` Bidirectional Mirror)

Duplicated from `Experimental/ProjectZeroEditor/` (which remains untouched as the clean UI shell specification) to serve as the **1:1 live HTML mirror** of the native ISO C++20 editor (`Engine/GeometricRaster/GlobalIllumination/ShowcaseGalleryScene.{h,cpp}`, `TieredWorldRenderSequence.{h,cpp}`, `Engine/DistanceFieldSpace/VoxelSdfClipmap.{h,cpp}`, `Engine/GeometricRaster/Atmosphere/`, `OutlinerPanel`, `ViewportPanel`, and `InspectorPanel`).

## Synchronized Capabilities

- **Cornell-Studio Gallery Outliner (24 rows)**:
  - `Showcase` (`10` OpenPBR specimens: `Gallery Floor`, `Gallery Back Wall`, `Crimson Left Wall`, `Emerald Right Wall`, `Clearcoat Roof Baffle`, `Anisotropic Gold Pedestal`, `Mirror Chrome Sphere`, `Plaster Specimen West`, `Plaster Specimen East`, `Abbe Crown Glass Orb`) + `ControlVehicle`
  - `Cameras` (`Editor Camera` at `(0.00, -3.55, 0.42)` targeting `(0.00, 0.55, 0.15)`, `43.0°` vertical FOV) and `Render Settings`
  - `World` (`Sun` directional solar emitter at `normalize(0.42, -0.55, 0.72)`, `Lens Flare` optical subcomponent, `Atmosphere`, `Volumetric Clouds`, `Moon`, `Stars`)
  - `Lighting` (`Ceiling Softbox` clipped-horizon LTC polygonal area quad at `(0.55, 0.35, 1.82)`, `1.70 × 1.30 m`)
- **Calibrated WebGL2 Tier 1 GTX World Renderer (`GtxWorldViewport.jsx`)**:
  - OpenPBR surface scattering (Fujii Oren-Nayar, Anisotropic GGX, Adobe F82 conductor tint, Turquin energy compensation, Dielectric Clearcoat)
  - Solar directional shadow with GTX Contact-Clip + SDF Cone Penumbra (zero VSM)
  - Clipped-horizon Polygonal Quad LTC area light integration
  - Physical Rayleigh/Mie/Ozone sky-view LUT with multi-scatter, ground-albedo bounce, volumetric clouds, lunar phase and a deterministic starfield
  - Photosphere authoring: **Limb Darkening** and **Aureole** on the Sun ▸ *Sun disc* card (`uSunDiscCfg`)
  - **Lens Flare optical composite** — depth-occluded ghosts, aperture halo, anamorphic streak and starburst screen-blended in the blit pass (`LensFlare.js` + `OUTLINE_FRAGMENT_SHADER`)
  - **2-cascade Voxel SDF Clipmap GI + multi-bounce surface-cache radiosity** and **SDF clipmap reflections** (`VoxelSdfClipmapGi.js`), Unreal-style distance-field GI with no RTX requirement
  - Cone GI / 2-bounce BVH GI / BVH reflections / Sky-only reflections remain selectable alongside the clipmap modes
  - 2-layer Abbe (`Abbe = 26`, `IOR = 1.52`) dispersive crown glass peel + ACES filmic tonemap
- **Interactive `EditorCamera` + Outliner/Inspector Sync**:
  - Orbit (`Drag`), Pan (`Shift+Drag` / `Middle-Drag`), Free-Look (`Right-Drag`), Dolly (`Wheel`), Fly (`Right+WASD`/`QE`), Frame Selected (`Focus` button), Click-to-Pick 3D viewport selection, and bidirectional `Position` / `Target` / `Focal Length` editing in the Inspector.

## Inspector wiring

| Card | Controls that reach the renderer |
| :--- | :--- |
| Sun ▸ Sun disc | Angular Diameter, Limb Darkening, Aureole |
| Sun ▸ Lens Flare subcomponent | Live link to the Lens Flare row |
| Lens Flare | Enabled, Type, Intensity, Ghosts, Halo Radius/Brightness/Width, Chromatic, Aperture Blades, Streak gain, Anamorphic/Streaks/Starburst, Spread, Rotation, Ray pairs, Ghost brightness/spacing/shape |
| Atmosphere | Rayleigh, Mie, Mie Anisotropy, Ozone, Rayleigh/Mie scale heights, Atmosphere top, Horizon Glow, Sky Tint, Sky Brightness, Ground Albedo |
| Render Settings ▸ Global Illumination | Algorithm (Clipmap / Cone / BVH / Off), Quality, Cone directions, BVH spp, Clipmap cascades, Voxel resolution, Radiosity bounces, Radiance gain, Sky-occlusion weight, Occlusion steps, Bounce intensity, Fill |
| Render Settings ▸ Reflections | Mode (SDF Clipmap / BVH / Sky-Env), Quality, Rays/pixel, Bounces, SDF trace steps |

## Rebuild & Serve

```bash
# 1. dependencies (esbuild + @napi-rs/canvas), once per clone
cd Experimental/FrontierEditor && npm install && cd ../..

# 2. rebuild the single-file bundle
node Experimental/FrontierWorldMirror/Build.mjs

# 3. serve (binds 0.0.0.0 so previews work)
python3 Experimental/FrontierWorldMirror/Serve.py 8098

# 4. validate every mirrored subsystem (20 suites, no GPU needed)
node Experimental/FrontierWorldMirror/WorldMirrorValidation.mjs
```

Useful URL parameters:

* `?backend=webgpu` — A/B the WebGPU renderer (no flare/clipmap passes there; WebGL2 is the calibrated default)
* `?backend=cpu-gtx` — force the CPU GTX fallback

## Run from raw.githack (no server)

`index.html` is a **single self-contained bundle** (CSS, JS, icons, glyphs, fonts, moon tiles and the shader-ball mesh are all inlined), so it runs directly from the CDN:

```
https://raw.githack.com/<owner>/<repo>/<commit-sha>/Experimental/FrontierWorldMirror/index.html
```

Always prefer the commit-SHA form: `raw.githack` path parsing is ambiguous for branch names that contain `/`. The only relative fetch left is the ControlVehicle BVH (`../ShadowAlgorithmLab/Assets/VehicleBenchmarkAssets.bin`), which raw.githack serves with CORS; if blocked, the vehicle degrades to its primitive proxy.

## Documentation

* Architecture, uniform map, validation matrix and the C++ parity plan: `Documentation/Plans/FrontierWorldMirrorSkySunFlareGiPlan.md`
