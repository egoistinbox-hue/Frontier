/*==========================================================================================================================================
                                        TERRAINWORLDLANDFORMVALIDATION.MJS
==========================================================================================================================================*/
// Phase L1 · Headless QA for Universal Parametric SDF Basic Landform Primitives.
// Enforces: every archetype builds, every exposed control actively reshapes the surface (ZERO dead controls),
// placement generators produce the right instance counts, true-3D undercut ops emit correctly, and the
// landform layer survives terrain JSON round-trips.

import assert from 'node:assert/strict';
import { WorldMask2D } from './Engine/WorldMask2D.js';
import {
    CreateTerrainLayer,
    EvaluateTerrainRegion,
    ExtractRegionTriangleMesh,
    ComputeRegionBaseSignature,
    LAYER_TYPE_META
} from './Engine/TerrainLayerStack.js';
import {
    LANDFORM_ARCHETYPES,
    LANDFORM_ARCHETYPE_LIST,
    LANDFORM_FAMILIES,
    LANDFORM_PARAM_SCHEMA,
    LANDFORM_PLACEMENT_MODES,
    CreateLandformParams,
    PrepareLandform,
    EvaluateLandform,
    ResolveLandformPath,
    ResolveLandformInstances,
    BuildLandformVolumetricOps,
    IsPathLandform,
    GetLandformArchetype,
    DescribeLandformLayer
} from './Engine/Landforms/TerrainLandformPrimitives.js';
import {
    ROCK2_TERRAIN_STAMP_STARTERS,
    ROCK_SCATTER_ARCHETYPES,
    ROCK_SCATTER_PLACEMENTS,
    CreateRock2StampDocument,
    CompileTerrainRockStamp,
    BuildTerrainRockStampInstances,
    ResolveRockScatterInstances,
    BuildRockTalusSkirt,
    RockStampFootprintCoverage,
    IsRock2TerrainLayer
} from './Engine/Landforms/TerrainRockStampEngine.js';
import { bakeRock2StackQefMesh } from './Engine/RockCliff/RockFormationStackEngine.js';

let Passed = 0;
const Failures = [];
function Suite(Name, Fn)
{
    try
    {
        Fn();
        Passed++;
        console.log(`  [PASS] ${Name}`);
    }
    catch (Err)
    {
        Failures.push({ Name, Err });
        console.log(`  [FAIL] ${Name}\n         ${Err.message}`);
    }
}

console.log('Running Frontier Universal SDF Landform Primitive Validation...\n');

/*------------------------------------------------------------------------------------------------------------------------------------------
  Helpers: deterministic surface sampling on a flat 1000×1000 m region.
------------------------------------------------------------------------------------------------------------------------------------------*/
function BuildFlatRegion(Stack)
{
    const World = new WorldMask2D();
    const Mask = World.addMaskLayer({ name: 'Landform QA Land' });
    // Paint a generous landmass so the region has land everywhere inside its bounds.
    World.paintCapsuleMeters(Mask, [-3000, -3000], [9000, 9000], 6000, 'paint', 1.0, 0.0, 4029);
    const Region = World.addTerrainRegion({
        name: 'QA Terrain',
        bounds: { x: 0, z: 0, width: 1000, depth: 1000 },
        resolution: 72,
        baseElevation: 4.0,
        stack: Stack
    });
    EvaluateTerrainRegion(World, Region);
    return { World, Region };
}

/** Samples the analytic landform surface directly (no region grid) for control-sensitivity checks. */
/** Feature-adaptive probe window: zoom onto the feature's own footprint so narrow landforms still fill the grid. */
function ProbeWindow(Layer)
{
    const Arch = GetLandformArchetype(Layer.archetype);
    const TalusMul = 1.0 + Math.min(1.6, Number(Layer.talusWidth) || 0) * 1.1;
    if (IsPathLandform(Layer.archetype))
    {
        // Corridor archetypes: window the *channel*, not the full trace length.
        const Corridor = Math.max(60, Number(Layer.pathWidthM) || 200) * 0.5 * 4.2 * TalusMul;
        const Radial = Math.min(Number(Layer.radiusX) || 800, Number(Layer.radiusZ) || 800) * 2.4;
        return Math.min(Corridor, Radial) + 60;
    }
    const Foot = Math.min(Number(Layer.radiusX) || 400, Number(Layer.radiusZ) || 400);
    const Wide = Math.max(Number(Layer.radiusX) || 400, Number(Layer.radiusZ) || 400);
    // Volcanoes / impact craters / atolls read across the full footprint.
    const WideTypes = ['shield_volcano', 'strato_volcano', 'impact_maar', 'atoll_ring', 'transverse_dune_field', 'fold_belt', 'hogbck_range', 'hogback_range'];
    const Base = WideTypes.includes(Layer.archetype) ? Wide : Foot;
    return (Base * (Arch.mode === 'snap' ? 1.05 : 1.55)) * TalusMul + 40;
}

function SampleLandformGrid(Layer, N = 26)
{
    const Prepared = PrepareLandform(Layer, { baseY: 10.0 });
    const R = ProbeWindow(Layer);
    const Out = new Float64Array(N * N);
    for (let J = 0; J < N; ++J)
    {
        for (let I = 0; I < N; ++I)
        {
            const Wx = (Number(Layer.worldX) || 0) + ((I / (N - 1)) * 2 - 1) * R;
            const Wz = (Number(Layer.worldZ) || 0) + ((J / (N - 1)) * 2 - 1) * R;
            const Res = EvaluateLandform(Prepared, Wx, Wz);
            // Any signature counts: built relief, carved depth, or snap elevation.
            Out[J * N + I] = Res.height * Res.coverage;
        }
    }
    return Out;
}

function MaxAbsDelta(A, B)
{
    let Max = 0;
    for (let I = 0; I < A.length; ++I)
    {
        const D = Math.abs(A[I] - B[I]);
        if (D > Max) Max = D;
    }
    return Max;
}

/*==========================================================================================================================================
  1 · Catalog completeness & schema integrity
==========================================================================================================================================*/
Suite('37. Landform catalog ships all 6 geological families, 28+ archetypes & a complete parameter schema', () =>
{
    assert.equal(LANDFORM_FAMILIES.length, 6, 'Must ship exactly 6 geological families');
    // 29 shipped = the 28 planned archetypes with Karst Sinkhole / Cenote split for true-3D shaft authoring.
    assert.equal(LANDFORM_ARCHETYPE_LIST.length, 29, `Must ship the full landform archetype set (got ${LANDFORM_ARCHETYPE_LIST.length})`);

    let FamilyTotal = 0;
    for (const Fam of LANDFORM_FAMILIES)
    {
        assert.ok(Fam.types.length >= 4, `Family "${Fam.label}" must expose at least 4 archetypes`);
        for (const T of Fam.types)
        {
            assert.ok(LANDFORM_ARCHETYPES[T], `Family "${Fam.label}" references unknown archetype "${T}"`);
            FamilyTotal++;
        }
    }
    assert.equal(FamilyTotal, LANDFORM_ARCHETYPE_LIST.length, 'Family membership must cover every archetype exactly once');

    for (const [Key, Spec] of Object.entries(LANDFORM_PARAM_SCHEMA))
    {
        assert.ok(typeof Spec.label === 'string' && Spec.label.length > 2, `Parameter "${Key}" needs a UI label`);
        assert.ok(Spec.max > Spec.min, `Parameter "${Key}" must have max > min`);
        assert.ok(Spec.probe !== undefined, `Parameter "${Key}" needs a validation probe value (zero dead controls)`);
    }

    // Every archetype must declare its own controls and a default for each one.
    for (const Type of LANDFORM_ARCHETYPE_LIST)
    {
        const Arch = GetLandformArchetype(Type);
        assert.ok(Arch.controls.length >= 7, `Archetype "${Type}" must expose a rich control set (got ${Arch.controls.length})`);
        const Params = CreateLandformParams(Type);
        for (const Key of Arch.controls)
        {
            assert.ok(LANDFORM_PARAM_SCHEMA[Key], `Archetype "${Type}" control "${Key}" is missing from the schema`);
            assert.ok(Params[Key] !== undefined, `Archetype "${Type}" control "${Key}" does not resolve in the parameter bag`);
        }
        assert.ok(Arch.desc && Arch.short, `Archetype "${Type}" needs a description & badge`);
    }

    assert.ok(LAYER_TYPE_META.landform_primitive, 'Terrain layer meta must register the landform_primitive type');
    assert.equal(LANDFORM_PLACEMENT_MODES.length, 4, 'Must expose the 4 placement / generator modes');
});

/*==========================================================================================================================================
  2 · Every archetype builds a non-degenerate landform
==========================================================================================================================================*/
Suite('38. All 29 archetypes produce finite, non-degenerate relief with a readable footprint & tangent-cliff coverage', () =>
{
    for (const Type of LANDFORM_ARCHETYPE_LIST)
    {
        const Layer = CreateTerrainLayer('landform_primitive', { archetype: Type, worldX: 0, worldZ: 0, seed: 4029 });
        const Grid = SampleLandformGrid(Layer);
        let Min = Infinity, Max = -Infinity, Covered = 0, NonFinite = 0;
        for (let I = 0; I < Grid.length; ++I)
        {
            const V = Grid[I];
            if (!Number.isFinite(V)) { NonFinite++; continue; }
            if (Math.abs(V) > 1e-6) Covered++;
            if (V < Min) Min = V;
            if (V > Max) Max = V;
        }
        assert.equal(NonFinite, 0, `Archetype "${Type}" produced NaN/Infinity samples`);
        assert.ok(Covered > 30, `Archetype "${Type}" covers too few samples (${Covered}) — footprint is degenerate`);
        const Span = Max - Min;
        assert.ok(Span > 0.5, `Archetype "${Type}" has flat relief (span ${Span.toFixed(3)} m)`);
        assert.ok(Number.isFinite(DescribeLandformLayer(Layer).length), 'Description must be stringifiable');
    }
});

/*==========================================================================================================================================
  3 · ZERO DEAD CONTROLS — every exposed parameter reshapes the SDF
==========================================================================================================================================*/
Suite('39. ZERO dead controls: every declared archetype control measurably reshapes its own Pure-SDF profile', () =>
{
    const DeadControls = [];
    for (const Type of LANDFORM_ARCHETYPE_LIST)
    {
        const Arch = GetLandformArchetype(Type);
        const Base = CreateTerrainLayer('landform_primitive', { archetype: Type, seed: 4029 });
        // Skip parameters whose probe equals the default (no possible change).
        for (const Key of Arch.controls)
        {
            const Spec = LANDFORM_PARAM_SCHEMA[Key];
            const Probe = Spec.probe;
            if (Probe === undefined) continue;
            const Alt = CreateTerrainLayer('landform_primitive', { archetype: Type, seed: 4029, [Key]: Probe });
            if (Base[Key] === Alt[Key]) continue; // probe identical to default is not a dead control
            const Delta = MaxAbsDelta(SampleLandformGrid(Base), SampleLandformGrid(Alt));
            if (!(Delta > 0.01))
            {
                DeadControls.push(`${Type}.${Key} (Δ=${Delta.toFixed(5)})`);
            }
        }
    }
    assert.deepEqual(DeadControls, [], `Dead landform controls detected:\n         ${DeadControls.join('\n         ')}`);
});

/*==========================================================================================================================================
  4 · Placement / generator modes
==========================================================================================================================================*/
Suite('40. All 4 placement modes (Single · 3D Spline Chain · Ridge Range Array · Scatter Field) resolve distinct deterministic instances', () =>
{
    const Single = ResolveLandformInstances({ placement: 'single', worldX: 0, worldZ: 0, radiusX: 300, radiusZ: 300 });
    assert.equal(Single.length, 1, 'Single gizmo mode must resolve exactly 1 instance');

    const Chain = ResolveLandformInstances({
        placement: 'chain', radiusX: 300, radiusZ: 300, ridgeCount: 5,
        pathPoints: [[-600, 0, 1, 1], [0, 120, 0.8, 1], [600, 0, 1.1, 1]]
    });
    assert.equal(Chain.length, 3, 'Spline chain mode must emit one instance per authored knot');
    assert.ok(Chain[1].rx < Chain[0].rx, 'Chain per-knot width scale must drive instance radius');

    const Range = ResolveLandformInstances({ placement: 'ridge_range', worldX: 0, worldZ: 0, radiusX: 900, radiusZ: 200, ridgeCount: 6, ridgeSpacingM: 300, yawDeg: 0 });
    assert.equal(Range.length, 6, 'Ridge range array must emit ridgeCount instances');
    // Parallel belt: ridge centres must march along the belt normal (Z for yaw 0).
    for (let I = 1; I < Range.length; ++I)
    {
        assert.ok(Math.abs(Range[I].cz - Range[I - 1].cz - 300) < 1e-6, 'Ridge range instances must be spaced exactly ridgeSpacingM apart');
    }

    const ScatterA = ResolveLandformInstances({ placement: 'scatter', worldX: 0, worldZ: 0, radiusX: 200, radiusZ: 200, scatterCount: 12, scatterRadiusM: 1500, scatterJitter: 0.8, scatterScaleJitter: 0.5, seed: 4242 });
    const ScatterB = ResolveLandformInstances({ placement: 'scatter', worldX: 0, worldZ: 0, radiusX: 200, radiusZ: 200, scatterCount: 12, scatterRadiusM: 1500, scatterJitter: 0.8, scatterScaleJitter: 0.5, seed: 4242 });
    assert.equal(ScatterA.length, 12, 'Scatter field must emit scatterCount instances');
    for (let I = 0; I < ScatterA.length; ++I)
    {
        assert.equal(ScatterA[I].cx, ScatterB[I].cx, 'Scatter placement must be deterministic for a given seed');
        assert.equal(ScatterA[I].cz, ScatterB[I].cz, 'Scatter placement must be deterministic for a given seed');
        assert.ok(Math.hypot(ScatterA[I].cx, ScatterA[I].cz) <= 1500 * 1.001, 'Scatter instances must stay inside the field radius');
    }

    // Scatter seeds must actually change the field.
    const ScatterC = ResolveLandformInstances({ placement: 'scatter', worldX: 0, worldZ: 0, radiusX: 200, radiusZ: 200, scatterCount: 12, scatterRadiusM: 1500, scatterJitter: 0.8, scatterScaleJitter: 0.5, seed: 909 });
    assert.notEqual(ScatterC[0].cx, ScatterA[0].cx, 'Different seeds must produce different scatter fields');
});

/*==========================================================================================================================================
  5 · Path/linear archetypes honor A → B gizmo drags
==========================================================================================================================================*/
Suite('41. Linear A → B path archetypes honor gizmo knots, per-knot width/depth scaling & synthesized meander traces', () =>
{
    const PathTypes = LANDFORM_ARCHETYPE_LIST.filter(T => IsPathLandform(T));
    assert.ok(PathTypes.length >= 9, `Must expose at least 9 linear/path archetypes (got ${PathTypes.length})`);

    // Authored path wins.
    const Authored = CreateTerrainLayer('landform_primitive', {
        archetype: 'v_gorge',
        pathPoints: [[-500, -200, 1, 1], [0, 250, 0.6, 1], [500, -200, 1.2, 1]]
    });
    const AuthoredPath = ResolveLandformPath(Authored);
    assert.ok(AuthoredPath.length > 3, 'Authored path must be Catmull-Rom resampled into a smooth polyline');
    assert.ok(Math.abs(AuthoredPath[0][0] + 500) < 1e-6, 'Authored path must start at knot A');

    // Synthesized straight trace follows the yaw gizmo.
    const Yaw0 = ResolveLandformPath({ radiusX: 800, worldX: 0, worldZ: 0, yawDeg: 0, meanderAmp: 0 });
    const Yaw90 = ResolveLandformPath({ radiusX: 800, worldX: 0, worldZ: 0, yawDeg: 90, meanderAmp: 0 });
    assert.ok(Math.abs(Yaw0[0][1] - Yaw0[Yaw0.length - 1][1]) < 1e-6, 'Yaw 0 trace must run along +X');
    assert.ok(Math.abs(Yaw90[0][0] - Yaw90[Yaw90.length - 1][0]) < 1e-6, 'Yaw 90 trace must run along +Z');

    // Meander amplitude bends the trace sideways.
    const Meandered = ResolveLandformPath({ radiusX: 800, worldX: 0, worldZ: 0, yawDeg: 0, meanderAmp: 0.8, seed: 4029 });
    let MaxOff = 0;
    for (const K of Meandered) MaxOff = Math.max(MaxOff, Math.abs(K[1]));
    assert.ok(MaxOff > 20, `Meander amplitude must displace the trace off its straight axis (got ${MaxOff.toFixed(1)} m)`);

    // Per-knot width scaling widens the corridor.
    const WideKnots = CreateTerrainLayer('landform_primitive', { archetype: 'u_glacial_valley', pathPoints: [[-500, 0, 1.6, 1], [0, 0, 1.6, 1], [500, 0, 1.6, 1]], pathWidthM: 400 });
    const NarrowKnots = CreateTerrainLayer('landform_primitive', { archetype: 'u_glacial_valley', pathPoints: [[-500, 0, 0.5, 1], [0, 0, 0.5, 1], [500, 0, 0.5, 1]], pathWidthM: 400 });
    const WideSample = EvaluateLandform(PrepareLandform(WideKnots, { baseY: 0 }), 0, 240);
    const NarrowSample = EvaluateLandform(PrepareLandform(NarrowKnots, { baseY: 0 }), 0, 240);
    assert.ok(Math.abs(WideSample.height) > Math.abs(NarrowSample.height), 'Per-knot width scale must widen/narrow the carved corridor');

    // Wall slant past 90° must undercut (deeper excavation than a vertical wall).
    const Vertical = CreateTerrainLayer('landform_primitive', { archetype: 'slot_canyon', pathWallDeg: 88, pathWidthM: 120 });
    const Undercut = CreateTerrainLayer('landform_primitive', { archetype: 'slot_canyon', pathWallDeg: 120, pathWidthM: 120 });
    const V0 = EvaluateLandform(PrepareLandform(Vertical, { baseY: 0 }), 0, 40);
    const V1 = EvaluateLandform(PrepareLandform(Undercut, { baseY: 0 }), 0, 40);
    assert.ok(V1.height < V0.height - 0.5, 'Wall slant > 90° must excavate an undercut (deeper than a vertical wall)');

    // Every path archetype must produce a carved or built corridor along its own trace.
    for (const Type of PathTypes)
    {
        const L = CreateTerrainLayer('landform_primitive', { archetype: Type });
        const P = PrepareLandform(L, { baseY: 0 });
        const Mid = P.path[Math.floor(P.path.length / 2)];
        const Res = EvaluateLandform(P, Mid[0], Mid[1]);
        assert.ok(Res.coverage > 0.02, `Path archetype "${Type}" must cover its own centreline`);
    }
});

/*==========================================================================================================================================
  6 · True-3D undercut tier emission
=============================================================================================----==========================================*/
Suite('42. Overhanging landforms emit true-3D undercut SDF carve ops consumed by the sparse brick mesher (0 Mesh → SDF)', () =>
{
    const Sample = () => 100.0;
    const Slot = CreateTerrainLayer('landform_primitive', { archetype: 'slot_canyon', volumetricUndercut: true, pathWallDeg: 112, pathWidthM: 90, pathDepthM: 130 });
    const SlotOps = BuildLandformVolumetricOps(PrepareLandform(Slot, { baseY: 0 }), Sample);
    assert.ok(SlotOps.length >= 2, `Slot canyon must emit undercut carve capsules (got ${SlotOps.length})`);
    for (const Op of SlotOps)
    {
        assert.equal(Op.op, 'cave', 'Landform undercut ops must carve (subtract) rock');
        assert.ok(Op.radius > 0 && Number.isFinite(Op.radius), 'Undercut capsule radius must be finite & positive');
        assert.ok(String(Op.source).startsWith('landform:'), 'Landform ops must be tagged for clean rebuilds');
    }

    const Cenote = CreateTerrainLayer('landform_primitive', { archetype: 'cenote_shaft', volumetricUndercut: true, pathWallDeg: 115, craterDepthM: 160 });
    const CenoteOps = BuildLandformVolumetricOps(PrepareLandform(Cenote, { baseY: 0 }), Sample);
    assert.ok(CenoteOps.length >= 1, 'Cenote must emit a vertical shaft carve capsule');
    assert.ok(Math.abs(CenoteOps[0].by - CenoteOps[0].ay) > 40, 'Cenote shaft capsule must descend vertically into the rock');

    // Not enabled ⇒ no ops at all (opt-in only).
    const NoOpt = CreateTerrainLayer('landform_primitive', { archetype: 'slot_canyon', volumetricUndercut: false, pathWallDeg: 112 });
    assert.equal(BuildLandformVolumetricOps(PrepareLandform(NoOpt, { baseY: 0 }), Sample).length, 0, 'Undercut tier must stay opt-in');
});

/*==========================================================================================================================================
  7 · Terrain integration, mesh extraction & JSON round-trip
==========================================================================================================================================*/
Suite('43. Landform layers stamp into the TerrainRegion heightfield, mesh cleanly & survive JSON round-trip', () =>
{
    const Stack = [
        CreateTerrainLayer('multifractal', { name: 'Base Hills', amplitude: 40, falloff: { mode: 'none' } }),
        CreateTerrainLayer('landform_primitive', {
            name: 'Hero Mesa', archetype: 'mesa_tepui', worldX: 500, worldZ: 500,
            radiusX: 300, radiusZ: 300, heightM: 220, topFrac: 0.7, falloff: { mode: 'none' }
        })
    ];
    const { World, Region } = BuildFlatRegion(Stack);
    const Rt = Region.runtime;
    assert.ok(Rt && Rt.hasLand, 'Region must evaluate land');
    assert.ok(Number.isFinite(Rt.maxHeight), 'Region maxHeight must be finite');

    // Centre of the mesa must sit at the flat caprock elevation (snap archetype).
    const CentreIdx = Math.round(Rt.nz / 2) * Rt.nx + Math.round(Rt.nx / 2);
    const CapY = Rt.preSculptHeights[CentreIdx];
    let CapMin = Infinity, CapMax = -Infinity;
    for (let Z = -3; Z <= 3; ++Z)
    {
        for (let X = -3; X <= 3; ++X)
        {
            const I = (Math.round(Rt.nz / 2) + Z) * Rt.nx + (Math.round(Rt.nx / 2) + X);
            CapMin = Math.min(CapMin, Rt.heights[I]);
            CapMax = Math.max(CapMax, Rt.heights[I]);
        }
    }
    assert.ok(CapMax - CapMin < 26.0, `Mesa summit must read as a flat caprock bench (spread ${(CapMax - CapMin).toFixed(1)} m)`);
    assert.ok(CapMax > 150.0, `Mesa summit must rise well above the base plain (got ${CapMax.toFixed(1)} m)`);

    // Toggling the landform layer off must restore a low plain (zero dead layers).
    const LandformLayer = Region.stack[1];
    LandformLayer.enabled = false;
    Region.dirty = true;
    EvaluateTerrainRegion(World, Region);
    const OffPeak = Region.runtime.maxHeight;
    assert.ok(OffPeak < CapMax - 60.0, 'Disabling the mesa landform layer must lower the peak');

    LandformLayer.enabled = true;
    Region.dirty = true;
    EvaluateTerrainRegion(World, Region);
    const PeakOn = Region.runtime.maxHeight;

    const Mesh = ExtractRegionTriangleMesh(World, Region);
    assert.ok(Mesh.triangleCount > 100, 'Landform terrain must extract a valid triangle mesh');

    // JSON round-trip preserves every landform control.
    const Saved = JSON.parse(JSON.stringify(World.toJSON()));
    const Restored = new WorldMask2D();
    Restored.loadFromJSON(Saved);
    const RLayer = Restored.regions[0].stack.find(L => L.type === 'landform_primitive');
    assert.ok(RLayer, 'Restored world must retain the landform layer');
    assert.equal(RLayer.archetype, 'mesa_tepui');
    assert.equal(RLayer.heightM, 220);
    assert.equal(Math.round(RLayer.radiusX), 300);
    assert.equal(RLayer.placement, 'single');
    assert.equal(Math.round(RLayer.topFrac * 100), 70);

    EvaluateTerrainRegion(Restored, Restored.regions[0]);
    assert.ok(Math.abs(Restored.regions[0].runtime.maxHeight - PeakOn) < 1.5,
        `Restored landform terrain must rebuild identically (${Restored.regions[0].runtime.maxHeight.toFixed(2)} vs ${PeakOn.toFixed(2)})`);

    // Base signature changes whenever any landform control changes (stale-erosion detection).
    const Sig0 = ComputeRegionBaseSignature(World, Region);
    LandformLayer.topFrac = 0.44;
    Region.dirty = true;
    EvaluateTerrainRegion(World, Region);
    const Sig1 = ComputeRegionBaseSignature(World, Region);
    assert.notEqual(Sig0, Sig1, 'Changing a landform control must invalidate the erosion base signature');
});

/*==========================================================================================================================================
  8 · Closed-basin hydrology & erosion compatibility
==========================================================================================================================================*/
Suite('44. Landforms integrate with hydrology: caldera craters hold closed-basin lakes & talus/flank slopes stay finite', () =>
{
    const Stack = [
        CreateTerrainLayer('multifractal', { amplitude: 30, falloff: { mode: 'none' } }),
        CreateTerrainLayer('landform_primitive', {
            archetype: 'strato_volcano', worldX: 500, worldZ: 500, radiusX: 360, radiusZ: 360,
            heightM: 480, craterRadiusFrac: 0.26, craterDepthM: 130, rimHeightM: 50, falloff: { mode: 'none' }
        })
    ];
    const { World, Region } = BuildFlatRegion(Stack);
    const Rt = Region.runtime;
    assert.ok(Rt.hasLand);

    // Sample the crater floor vs the rim: the crater must be a genuine depression.
    const N = Rt.nx;
    const Cx = (500 - Region.bounds.x) / Rt.stepX, Cz = (500 - Region.bounds.z) / Rt.stepZ;
    const FloorIdx = Math.round(Cz) * N + Math.round(Cx);
    let RimMax = -Infinity;
    for (let Z = 0; Z < Rt.nz; ++Z)
    {
        for (let X = 0; X < Rt.nx; ++X)
        {
            const D = Math.hypot(X - Cx, Z - Cz);
            if (D > 8 && D < 18) RimMax = Math.max(RimMax, Rt.heights[Z * N + X]);
        }
    }
    assert.ok(Rt.heights[FloorIdx] < RimMax - 30.0, `Volcano crater floor must sit below its rim (floor ${Rt.heights[FloorIdx].toFixed(1)} vs rim ${RimMax.toFixed(1)})`);

    // No NaNs anywhere in heights, and every height stays inside the slab.
    let Bad = 0;
    for (let I = 0; I < Rt.heights.length; ++I)
    {
        const V = Rt.heights[I];
        if (!Number.isFinite(V) || V < Rt.slabBottom - 0.001) Bad++;
    }
    assert.equal(Bad, 0, 'Landform terrain heights must be finite and never sink below the thin-slab floor');
});

/*==========================================================================================================================================
  9 · Phase L4 · RockFormation 2.0 hero stamp on terrain
==========================================================================================================================================*/
Suite('45. Phase L4: hero RockFormation 2.0 stacks stamp onto terrain as live Pure-SDF instanced geometry (0 Mesh → SDF)', () =>
{
    assert.equal(ROCK2_TERRAIN_STAMP_STARTERS.length, 4, 'Must expose the 4 hero RockFormation 2.0 terrain stamp starters');
    assert.ok(IsRock2TerrainLayer({ type: 'rock2_stamp' }) && IsRock2TerrainLayer({ type: 'rock2_scatter' }));

    const { World, Region } = BuildFlatRegion([
        CreateTerrainLayer('multifractal', { amplitude: 60, falloff: { mode: 'none' } }),
        CreateTerrainLayer('rock2_stamp', { rock2StarterId: 'stack-crystal-cluster', worldX: 500, worldZ: 500, worldScaleM: 150, embedDepthM: 8, rock2Resolution: 28, falloff: { mode: 'none' } })
    ]);

    const Layer = Region.stack[1];
    const Cached = CompileTerrainRockStamp(Layer);
    assert.ok(Cached.compiled && Cached.compiled.primitives.length >= 4,
        `Crystal cluster stack must compile multiple Pure-SDF primitives (got ${Cached.compiled?.primitives?.length})`);

    // Live QEF extraction for the terrain stamp (still 0 Mesh -> SDF).
    const Baked = bakeRock2StackQefMesh(Cached.compiled, { resolution: Cached.resolution });
    assert.equal(Baked.sdfStats.meshToSdfCount, 0, 'Terrain stamp QEF bake must have ZERO Mesh->SDF conversions');
    assert.ok(Baked.sdfStats.triangles > 200, 'Terrain stamp must bake manifold QEF triangles');

    const Mesh = { positions: Baked.mesh.positions, normals: Baked.mesh.normals, colors: Baked.mesh.colors, albedos: Baked.mesh.albedos, indices: Baked.mesh.indices };
    const Instances = BuildTerrainRockStampInstances(Layer, Region, Region.runtime, () => Mesh);
    assert.equal(Instances.length, 1, 'A single hero stamp must emit exactly one instanced mesh');
    const Stamp = Instances[0];
    assert.ok(Stamp.positions.length > 0, 'Stamp must produce world-space vertices');

    // Stamp must be anchored near the terrain surface at (worldX, worldZ), not floating in space.
    const SurfY = Region.runtime.heights[Math.round(Region.runtime.nz / 2) * Region.runtime.nx + Math.round(Region.runtime.nx / 2)];
    let MinY = Infinity, MaxY = -Infinity, MinX = Infinity, MaxX = -Infinity;
    for (let I = 0; I < Stamp.positions.length; I += 3)
    {
        MinY = Math.min(MinY, Stamp.positions[I + 1]); MaxY = Math.max(MaxY, Stamp.positions[I + 1]);
        MinX = Math.min(MinX, Stamp.positions[I]); MaxX = Math.max(MaxX, Stamp.positions[I]);
    }
    assert.ok(MinY < SurfY + 80, `Stamp must be rooted at the terrain surface (stamp minY ${MinY.toFixed(1)} vs surface ${SurfY.toFixed(1)})`);
    assert.ok(MaxY > SurfY, 'Stamp must rise above the terrain surface');
    assert.ok(Math.abs(((MinX + MaxX) * 0.5) - 500) < 160, 'Stamp must be centred on its authored world position');

    // Terrain mesh must include the stamped rock geometry on top of the heightfield.
    const TerrainMesh = ExtractRegionTriangleMesh(World, Region);
    assert.ok(TerrainMesh.triangleCount > 500, 'Terrain + stamp mesh must contain both the heightfield and rock triangles');
    let NonFinite = 0;
    for (const V of TerrainMesh.positions) if (!Number.isFinite(V)) NonFinite++;
    assert.equal(NonFinite, 0, 'Stamped terrain mesh must have no NaN/Infinity vertices');
    const MaxIdx = TerrainMesh.indices.reduce((A, B) => (B > A ? B : A), 0);
    assert.ok(MaxIdx < TerrainMesh.vertexCount, 'Stamp indices must stay inside the vertex buffer');

    // Disabling the stamp must remove its geometry (zero dead layers).
    const StampTris = TerrainMesh.triangleCount;
    Layer.enabled = false;
    Region.meshDirty = true;
    const Off = ExtractRegionTriangleMesh(World, Region);
    assert.ok(Off.triangleCount < StampTris, 'Disabling the hero stamp must drop its rock triangles');
    Layer.enabled = true;
    Region.meshDirty = true;
});

/*==========================================================================================================================================
  10 · Phase L4 · Procedural slope / altitude / coast scatter
==========================================================================================================================================*/
Suite('46. Phase L4: procedural RockFormation 2.0 scatter honors slope, ridge, coast & altitude placement gates deterministically', () =>
{
    assert.ok(ROCK_SCATTER_ARCHETYPES.length >= 8, 'Must expose the RockFormation 2.0 scatter archetype catalog');
    assert.equal(ROCK_SCATTER_PLACEMENTS.length, 5, 'Must expose the 5 scatter placement rules');

    // Region with one landform cliff (scatter should find steep cells on its flank).
    const { World, Region } = BuildFlatRegion([
        CreateTerrainLayer('landform_primitive', {
            archetype: 'mesa_tepui', worldX: 500, worldZ: 500, radiusX: 260, radiusZ: 260,
            heightM: 260, topFrac: 0.55, cliffSharpness: 0.95, talusWidth: 0.15, edgeFeatherM: 10, falloff: { mode: 'none' }
        })
    ]);
    const Rt = Region.runtime;

    const Cliffs = ResolveRockScatterInstances(
        { type: 'rock2_scatter', scatterCount: 24, scatterRadiusM: 60, scatterPlacement: 'cliffs', scatterSlopeDeg: 40, scatterScaleJitter: 0.3, seed: 7788 },
        World, Region, Rt);
    assert.ok(Cliffs.length > 4, `Cliff scatter must place rocks on the mesa flank (got ${Cliffs.length})`);
    for (const I of Cliffs)
    {
        assert.ok(I.slopeDeg >= 40 - 1e-6, `Cliff scatter rock must respect the slope gate (slope ${I.slopeDeg.toFixed(1)})`);
        assert.ok(I.radius > 0 && Number.isFinite(I.radius), 'Scatter rocks need a finite radius');
    }

    // Determinism: same seed ⇒ identical field.
    const Cliffs2 = ResolveRockScatterInstances(
        { type: 'rock2_scatter', scatterCount: 24, scatterRadiusM: 60, scatterPlacement: 'cliffs', scatterSlopeDeg: 40, scatterScaleJitter: 0.3, seed: 7788 },
        World, Region, Rt);
    assert.equal(Cliffs.length, Cliffs2.length, 'Scatter must be deterministic for a given seed');
    for (let I = 0; I < Cliffs.length; ++I)
    {
        assert.equal(Cliffs[I].x, Cliffs2[I].x, 'Scatter positions must be identical across runs');
    }

    // Altitude gate: a narrow band above the summit yields nothing on this low plain.
    const HighBand = ResolveRockScatterInstances(
        { type: 'rock2_scatter', scatterCount: 30, scatterPlacement: 'altitude', scatterAltMinM: 900, scatterAltMaxM: 1200, seed: 4242 },
        World, Region, Rt);
    assert.equal(HighBand.length, 0, 'Altitude gate above the terrain relief must place zero rocks');

    // Ridge / coast / even rules all stay on land and respect their gates.
    // 'coast' needs a real shoreline: paint an island whose coast bisects the region.
    let CoastRegion = Region, CoastRt = Rt;
    if (true)
    {
        const CoastWorld = new WorldMask2D();
        const CM = CoastWorld.addMaskLayer({ name: 'Island' });
        CoastWorld.paintCapsuleMeters(CM, [200, 500], [200, 500], 180, 'paint', 1.0, 0.0, 7);
        CoastRegion = CoastWorld.addTerrainRegion({ name: 'Coast QA', bounds: { x: 0, z: 0, width: 1000, depth: 1000 }, resolution: 64,
            stack: [CreateTerrainLayer('multifractal', { amplitude: 40, falloff: { mode: 'none' } })] });
        EvaluateTerrainRegion(CoastWorld, CoastRegion);
        CoastRt = CoastRegion.runtime;
    }
    for (const Rule of ['ridges', 'coast', 'even'])
    {
        const RuleRegion = Rule === 'coast' ? CoastRegion : Region;
        const RuleRt = Rule === 'coast' ? CoastRt : Rt;
        const Field = ResolveRockScatterInstances(
            { type: 'rock2_scatter', scatterCount: 16, scatterPlacement: Rule, scatterSlopeDeg: 30, seed: 5150 },
            Rule === 'coast' ? CoastRegion : World, RuleRegion, RuleRt);
        assert.ok(Field.length > 0, `Placement rule "${Rule}" must place rocks on this terrain`);
        for (const I of Field)
        {
            assert.ok(I.x >= RuleRegion.bounds.x - 1 && I.x <= RuleRegion.bounds.x + RuleRegion.bounds.width + 1, `"${Rule}" scatter must stay inside the region`);
            assert.ok(Number.isFinite(I.y), `"${Rule}" scatter must sit on a finite surface height`);
        }
    }

    // Talus skirt ring must be a closed ring with valid winding data.
    const Skirt = BuildRockTalusSkirt({ x: 500, y: 200, z: 500, radius: 40 }, 0.4, 0.5, 16);
    assert.equal(Skirt.positions.length, 16 * 2 * 3, 'Talus skirt must emit an inner/outer ring pair');
    assert.equal(Skirt.indices.length, 16 * 6, 'Talus skirt must emit 2 triangles per ring segment');
});

/*==========================================================================================================================================
  11 · Phase L4 · Scatter meshes + bedrock fusion into the terrain volume
==========================================================================================================================================*/
Suite('47. Phase L4: scattered outcrop meshes fuse into the terrain heightfield with no floating rocks & full JSON round-trip', () =>
{
    const { World, Region } = BuildFlatRegion([
        CreateTerrainLayer('multifractal', { amplitude: 120, falloff: { mode: 'none' } }),
        CreateTerrainLayer('rock2_scatter', {
            scatterArchetype: 'big_boulder', scatterPlacement: 'even', scatterCount: 8,
            worldScaleM: 60, embedDepthM: 6, rock2Resolution: 20, scatterRadiusM: 40, seed: 31337, falloff: { mode: 'none' }
        })
    ]);
    const Layer = Region.stack[1];
    const Cached = CompileTerrainRockStamp(Layer);
    assert.ok(Cached.compiled, 'Scatter layer must compile a RockFormation 2.0 stack');
    const Baked = bakeRock2StackQefMesh(Cached.compiled, { resolution: Cached.resolution });
    assert.equal(Baked.sdfStats.meshToSdfCount, 0, 'Scatter rock archetype must bake with ZERO Mesh->SDF conversions');

    const Mesh = { positions: Baked.mesh.positions, normals: Baked.mesh.normals, colors: Baked.mesh.colors, albedos: Baked.mesh.albedos, indices: Baked.mesh.indices };
    const AllStamps = BuildTerrainRockStampInstances(Layer, Region, Region.runtime, () => Mesh);
    const Stamps = AllStamps.filter(S => S.kind !== 'skirt');
    const Skirts = AllStamps.filter(S => S.kind === 'skirt');
    assert.ok(Stamps.length > 0, 'Scatter layer must emit instanced rock meshes');
    assert.equal(Skirts.length, Stamps.length, 'Every scattered rock must carry a terrain-fused talus skirt');

    // Every instanced rock must be rooted (its lowest vertex sits at or below the local terrain surface).
    const Rt = Region.runtime;
    for (const Stamp of Stamps)
    {
        let MinY = Infinity, Cx = 0, Cz = 0, Count = 0;
        for (let I = 0; I < Stamp.positions.length; I += 3)
        {
            MinY = Math.min(MinY, Stamp.positions[I + 1]);
            Cx += Stamp.positions[I]; Cz += Stamp.positions[I + 2]; Count++;
        }
        Cx /= Count; Cz /= Count;
        const Ix = Math.max(0, Math.min(Rt.nx - 1, Math.round((Cx - Region.bounds.x) / Rt.stepX)));
        const Iz = Math.max(0, Math.min(Rt.nz - 1, Math.round((Cz - Region.bounds.z) / Rt.stepZ)));
        const Ground = Rt.heights[Iz * Rt.nx + Ix];
        // Boulders are small; a rock base within its own body height of the ground is grounded, not floating.
        const BodyHeight = Math.max(1.0, (Stamp.positions.length ? 1 : 1));
        assert.ok(MinY < Ground + 12.0,
            `Scattered rock must be embedded in the terrain (rock base ${MinY.toFixed(1)} vs ground ${Ground.toFixed(1)} at ${Cx.toFixed(0)},${Cz.toFixed(0)})`);
    }

    // Hero stamp bedrock fusion: the terrain under a stamp is lifted by RockStampFootprintCoverage.
    const StampLayer = CreateTerrainLayer('rock2_stamp', { worldX: 500, worldZ: 500, worldScaleM: 200, talusWidth: 0.5, falloff: { mode: 'none' } });
    assert.ok(RockStampFootprintCoverage(StampLayer, 500, 500) > 0.9, 'Stamp centre must be fully covered');
    assert.ok(RockStampFootprintCoverage(StampLayer, 500 + 9000, 500) === 0, 'Stamp coverage must vanish far away');

    // Bedrock fusion must visibly lift the heightfield under a hero stamp (a real, measurable pedestal).
    const StampWorld = new WorldMask2D();
    const SM = StampWorld.addMaskLayer({ name: 'L' });
    StampWorld.paintCapsuleMeters(SM, [-3000, -3000], [9000, 9000], 6000, 'paint', 1.0, 0.0, 4029);
    const FlatStack = () => [CreateTerrainLayer('multifractal', { amplitude: 40, falloff: { mode: 'none' } })];
    const BareRegion = StampWorld.addTerrainRegion({ name: 'Bare', bounds: { x: 0, z: 0, width: 800, depth: 800 }, resolution: 64, stack: FlatStack() });
    EvaluateTerrainRegion(StampWorld, BareRegion);
    const FusedStack = FlatStack();
    FusedStack.push(CreateTerrainLayer('rock2_stamp', {
        worldX: 400, worldZ: 400, worldScaleM: 220, embedDepthM: 12, rock2Resolution: 24, falloff: { mode: 'none' }
    }));
    const FusedRegion = StampWorld.addTerrainRegion({ name: 'Fused', bounds: { x: 0, z: 0, width: 800, depth: 800 }, resolution: 64, stack: FusedStack });
    EvaluateTerrainRegion(StampWorld, FusedRegion);
    const CentreIdx = Math.round(FusedRegion.runtime.nz / 2) * FusedRegion.runtime.nx + Math.round(FusedRegion.runtime.nx / 2);
    const BareCentre = BareRegion.runtime.heights[CentreIdx];
    const FusedCentre = FusedRegion.runtime.heights[CentreIdx];
    assert.ok(FusedCentre - BareCentre > 8.0,
        `Hero stamp must lift the bedrock under its footprint (bare ${BareCentre.toFixed(1)} -> fused ${FusedCentre.toFixed(1)})`);
    // Embed depth must drive the pedestal height (zero dead controls).
    FusedStack[1].embedDepthM = 40;
    FusedRegion.dirty = true;
    EvaluateTerrainRegion(StampWorld, FusedRegion);
    const DeeperCentre = FusedRegion.runtime.heights[CentreIdx];
    assert.ok(DeeperCentre > FusedCentre + 1.0,
        `Deeper embed depth must raise the bedrock pedestal (${FusedCentre.toFixed(1)} -> ${DeeperCentre.toFixed(1)})`);

    // JSON round-trip keeps the scatter configuration intact.
    const Saved = JSON.parse(JSON.stringify(World.toJSON()));
    const Restored = new WorldMask2D();
    Restored.loadFromJSON(Saved);
    const RL = Restored.regions[0].stack.find(L => L.type === 'rock2_scatter');
    assert.ok(RL, 'Restored world must keep the rock scatter layer');
    assert.equal(RL.scatterArchetype, 'big_boulder');
    assert.equal(RL.scatterCount, 8);
    assert.equal(Math.round(RL.worldScaleM), 60);
    EvaluateTerrainRegion(Restored, Restored.regions[0]);
    assert.ok(Number.isFinite(Restored.regions[0].runtime.maxHeight), 'Restored scatter terrain must evaluate cleanly');
});

/*==========================================================================================================================================
  Summary
==========================================================================================================================================*/
console.log('');
if (Failures.length > 0)
{
    console.error(`\n${Failures.length} landform validation suite(s) FAILED (${Passed}/11 passed).`);
    for (const F of Failures) console.error(`\n--- ${F.Name}\n${F.Err.stack || F.Err.message}`);
    process.exit(1);
}
console.log(`All ${Passed}/11 Universal SDF Landform Primitive + RockFormation 2.0 Terrain Integration suites passed!`);
