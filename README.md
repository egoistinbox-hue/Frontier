# Frontier

General Purpose Editor — Experimental Studios.

## Open-World SDF Terrain Studio (`Experimental/TerrainWorldEditor`)

**Phase L1 shipped: Universal SDF Basic Landform Primitives + Interactive 3D Landform Gizmos.**

- 29 parametric landform archetypes across 6 geological families (peaks & volcanoes, plateaus & mesas,
  valleys & canyons, ridges/faults/folds, aeolian/karst/impact, coastal & islands) — every surface is
  analytic Pure-SDF (`0 Mesh → SDF`).
- 4 generator / placement modes: single 3D gizmo, 3D spline chain, ridge range array, seeded scatter field.
- Interactive 3D gizmos: centre move, RX/RZ footprint, apex height, strike azimuth, and draggable A → B
  path knots for canyons / ridges / dikes / spits.
- True-3D undercut tier for overhanging walls (> 90° slant) → slot canyons, cenote shafts and wave-cut
  sea notches feed the existing sparse 3D brick Dual-Surface-Nets mesher.
- Zero dead controls, enforced by Suite 39.

### Run

Serve the `Experimental` folder over HTTP and open `TerrainWorldEditor/?ws=landform`.

```
cd Experimental && python3 -m http.server 8080
```

### Validate

```
node Experimental/TerrainWorldEditor/TerrainWorldValidation.mjs            # 36/36 legacy suites
node Experimental/TerrainWorldEditor/TerrainWorldLandformValidation.mjs   # 8/8 Phase L1 suites
node Experimental/TerrainWorldEditor/TerrainWorldUILandformSmoke.mjs      # 4/4 studio UI smoke checks
```

Architecture & roadmap: `Documentation/Plans/Phase-L1-UniversalLandformPrimitives.md`.
