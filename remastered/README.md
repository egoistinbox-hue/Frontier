# Frontier — Remastered Preview

Single-file HTML preview that paints in **WebGPU**. Simple **Blinn-Phong** lighting + **basic shadows**. No ReSTIR, no PBR, no GI, no SDF, no BVH — by design.

## Run

WebGPU needs a secure context (HTTPS or localhost). Don't open `index.html` via `file://`.

```bash
cd remastered
python3 -m http.server 8000 --bind 0.0.0.0
# open http://localhost:8000/  (or the Arena live preview)
```

Requires a recent Chrome/Edge (or Firefox with WebGPU enabled). If WebGPU is unavailable the page shows an error overlay instead of a blank canvas.

## What's in the scene

- Ground plane + 1 center cube, 4 spheres, 4 small cubes, 2 cylinders (~10k triangles, baked once at startup).
- One directional light: ambient + diffuse + Blinn specular (`H = normalize(L + V)`, `pow(max(dot(N,H),0), shininess)`).
- One shadow map (512/1024/2048), single `textureSampleCompare` sample + small depth bias, strength slider.
- Orbit camera: drag to orbit, wheel/pinch to zoom. Auto-rotate toggle.

## Performance design (why this avoids the old 10 FPS trap)

The lighting formula alone doesn't guarantee speed. This preview is fast because of the *rendering path*, not just the shading math:

- **Bake once, draw cheap:** geometry is built once into a single static vertex buffer. The render loop does zero CPU geometry work.
- **1–2 passes per frame:** shadow pass (depth only) + main pass. No extra passes, no post-processing.
- **No readbacks in the hot loop:** no `mapAsync`, no `copyTextureToBuffer`, no per-frame sync. Uniform updates are a single 192-byte `writeBuffer`, and only when the camera/light actually changed.
- **Capped resolution:** `devicePixelRatio` capped at 2. Shadow size is selectable; drop to 512 if fill-bound.
- **No per-frame DOM thrash:** FPS text updates at most twice per second.
- **High-performance adapter:** `powerPreference: "high-performance"`.

If you still see low FPS with this, suspect (in order): wrong GPU selected, very high resolution, oversized shadow map, or browser throttling — not the Blinn formula.

## Controls

| Input | Action |
|---|---|
| Drag | Orbit |
| Wheel / pinch | Zoom |
| `R` | Reset camera |
| `Space` | Pause / resume |
| `S` | Toggle shadows |

Panel sliders: light azimuth/elevation/color/intensity, ambient, shininess, shadow size/strength, auto-rotate speed.

## Intentionally NOT included

ReSTIR, PBR (metallic/roughness, IBL), global illumination, SDF, BVH, compute-based culling, instancing, post FX. This is the clean baseline to measure against before adding anything back.
