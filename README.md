# Frontier

## remastered

`remastered/index.html` — from-scratch, single-file HTML demo (no build step). All painting and
rendering run in WebGPU: strokes deposit into a 1024x1024 UV atlas via a compute pass, and the
scene is shaded with plain Blinn-Phong + one directional shadow map. No ReSTIR / reservoirs /
SDF / BVH / PBR code — open the file directly or serve the folder statically.
