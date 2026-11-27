/*==========================================================================================================================================
                                        TERRAINROCKSTAMPENGINE.JS
==========================================================================================================================================*/
// Phase L4 · Full RockFormation 2.0 -> 3D Landscape Integration.
//
// Turns the legacy single-mesh "fractured rock" terrain layer into a LIVE RockFormation 2.0 stamp & scatter layer:
// - Stamps single hero RockFormation 2.0 stacks (arch splines, crystal caves, basalt colonnade sea-cliffs, linear
//   volcanic dikes …) directly onto the terrain surface.
// - Procedural slope / altitude / curvature rock scatter: auto-populate steep cliffs, ridgelines and coastlines with
//   instanced RockFormation 2.0 outcrops.
// - Automatic Pure-SDF skirt / talus bedrock fusion: every instanced stamp is smooshed into the terrain volume with a
//   fractional-budget `smin` skirt, so nothing floats and there is still ZERO Mesh -> SDF conversion.
//
// Every stamp is compiled lazily from the RockFormation 2.0 layer stack document at a coarse resolution and cached,
// so live slider edits stay instant and only the affected layer recompiles.

import {
    compileRock2Stack,
    createDefaultRock2Document,
    serializeRock2Document,
    deserializeRock2Document
} from '../RockCliff/RockFormationStackEngine.js';

const QuatCache = new WeakMap();
const MeshBoundsCache = new WeakMap();

/** Exact bounds of a baked QEF mesh (cached) — the transform must follow the real geometry, not the stack AABB. */
function MeshBounds(Mesh)
{
    if (!Mesh || !Mesh.positions || Mesh.positions.length === 0) return null;
    let B = MeshBoundsCache.get(Mesh);
    if (B) return B;
    let MinX = Infinity, MinY = Infinity, MinZ = Infinity;
    let MaxX = -Infinity, MaxY = -Infinity, MaxZ = -Infinity;
    const P = Mesh.positions;
    for (let I = 0; I < P.length; I += 3)
    {
        if (P[I] < MinX) MinX = P[I];
        if (P[I] > MaxX) MaxX = P[I];
        if (P[I + 1] < MinY) MinY = P[I + 1];
        if (P[I + 1] > MaxY) MaxY = P[I + 1];
        if (P[I + 2] < MinZ) MinZ = P[I + 2];
        if (P[I + 2] > MaxZ) MaxZ = P[I + 2];
    }
    B = { minX: MinX, minY: MinY, minZ: MinZ, maxX: MaxX, maxY: MaxY, maxZ: MaxZ,
          extentX: Math.max(1e-3, MaxX - MinX), extentY: Math.max(1e-3, MaxY - MinY), extentZ: Math.max(1e-3, MaxZ - MinZ),
          centre: [(MinX + MaxX) * 0.5, (MinY + MaxY) * 0.5, (MinZ + MaxZ) * 0.5] };
    MeshBoundsCache.set(Mesh, B);
    return B;
}

/*==========================================================================================================================================
                                                       DETERMINISTIC NOISE
==========================================================================================================================================*/
function Hash2(Ix, Iz, Seed)
{
    let H = Math.imul(Ix | 0, 374761393) ^ Math.imul(Iz | 0, 668265263) ^ Math.imul(Seed | 0, 1442695041);
    H = Math.imul(H ^ (H >>> 13), 1274126177);
    return ((H ^ (H >>> 16)) >>> 0) / 4294967295.0;
}

function ValueNoise2D(X, Z, Seed)
{
    const X0 = Math.floor(X), Z0 = Math.floor(Z);
    const Fx = X - X0, Fz = Z - Z0;
    const Ux = Fx * Fx * (3.0 - 2.0 * Fx);
    const Uz = Fz * Fz * (3.0 - 2.0 * Fz);
    const N00 = Hash2(X0, Z0, Seed), N10 = Hash2(X0 + 1, Z0, Seed);
    const N01 = Hash2(X0, Z0 + 1, Seed), N11 = Hash2(X0 + 1, Z0 + 1, Seed);
    const Top = N00 + (N10 - N00) * Ux;
    const Bot = N01 + (N11 - N01) * Ux;
    return Top + (Bot - Top) * Uz;
}

function Rng(Seed)
{
    let A = Seed >>> 0;
    return () =>
    {
        A = (A + 0x6D2B79F5) >>> 0;
        let T = A;
        T = Math.imul(T ^ (T >>> 15), T | 1);
        T ^= T + Math.imul(T ^ (T >>> 7), T | 61);
        return ((T ^ (T >>> 14)) >>> 0) / 4294967296.0;
    };
}

/*==========================================================================================================================================
                                                   ROCK 2.0 STACK TEMPLATES
==========================================================================================================================================*/
// Cached starter stacks used by the "hero stamp" layer (users can then open the RockFormation 2.0 workspace to
// author the very same stack, and the terrain stamp follows it live through the shared document JSON).
export const ROCK2_TERRAIN_STAMP_STARTERS = [
    ['Canyon Cliff Outcrop', 'stack-cliff-outcrop'],
    ['Amethyst & Quartz Cluster', 'stack-crystal-cluster'],
    ["Giant's Causeway Colonnade", 'stack-basalt-colonnade'],
    ['Linear Volcanic Dike & Fins', 'stack-linear-dike-fins']
];

export function CreateRock2StampDocument(StarterId = 'stack-cliff-outcrop')
{
    let Doc = null;
    try
    {
        Doc = createDefaultRock2Document(StarterId);
    }
    catch (Err)
    {
        Doc = createDefaultRock2Document();
    }
    return Doc;
}

/*==========================================================================================================================================
                                          SCATTER FIELD (slope / altitude / curvature)
==========================================================================================================================================*/
export const ROCK_SCATTER_ARCHETYPES = [
    ['Big Boulder', 'big_boulder'],
    ['Hoodoo Pillar', 'hoodoo'],
    ['Pedestal Rock', 'pedestal'],
    ['Smooth Dome', 'smooth_rock'],
    ['Angular Monolith', 'angular_monolith'],
    ['Basalt Column', 'basalt_column'],
    ['Crystal Prism', 'crystal_prism'],
    ['Karst Organ Spire', 'karst_spire'],
    ['Canyon Cliff Stack', 'canyon_cliff']
];

export const ROCK_SCATTER_PLACEMENTS = [
    ['Steep Cliffs (slope gate)', 'cliffs'],
    ['Ridgelines & Crests', 'ridges'],
    ['Coastline Band', 'coast'],
    ['Altitude Band', 'altitude'],
    ['Even Seeded Scatter', 'even']
];

/**
 * Resolves the deterministic scatter field for a terrain rock layer.
 * `Sample` provides `{ height, slopeDeg, sdf2D, maxHeight }` at a world point.
 */
export function ResolveRockScatterInstances(Layer, World, Region, Rt, Sample = null)
{
    const Count = Math.max(0, Math.min(160, Math.round(Number(Layer.scatterCount) || 0)));
    if (Count <= 0) return [];

    const B = Region.bounds;
    const Seed = ((Layer.seed | 0) || 4029) ^ 0x5BF03635;
    const Rnd = Rng(Seed);
    const Radius = Math.max(8.0, Number(Layer.scatterRadiusM) || 60.0);
    const Placement = Layer.scatterPlacement || 'cliffs';
    const SlopeGate = Math.max(6.0, Number(Layer.scatterSlopeDeg) || 48.0);
    const AltMin = Number(Layer.scatterAltMinM) || 0.0;
    const AltMax = Number(Layer.scatterAltMaxM) || 4000.0;
    const ScaleJitter = Math.max(0.0, Math.min(0.9, Number(Layer.scatterScaleJitter) || 0.0));
    const Out = [];

    // Sample helper that tolerates a missing runtime (falls back to neutral terrain).
    const Probe = (Wx, Wz) =>
    {
        if (Sample) return Sample(Wx, Wz);
        const RtNow = Rt || Region.runtime;
        if (!RtNow || !RtNow.hasLand) return { height: 0, slopeDeg: 0, sdf2D: 0, maxHeight: 0 };
        const Ix = Math.max(0, Math.min(RtNow.nx - 1, Math.round((Wx - B.x) / RtNow.stepX)));
        const Iz = Math.max(0, Math.min(RtNow.nz - 1, Math.round((Wz - B.z) / RtNow.stepZ)));
        const I = Iz * RtNow.nx + Ix;
        const H = RtNow.heights[I];
        const Xm = Math.max(0, Ix - 1), Xp = Math.min(RtNow.nx - 1, Ix + 1);
        const Zm = Math.max(0, Iz - 1), Zp = Math.min(RtNow.nz - 1, Iz + 1);
        const DhDx = (RtNow.heights[Iz * RtNow.nx + Xp] - RtNow.heights[Iz * RtNow.nx + Xm]) / Math.max(1e-4, (Xp - Xm) * RtNow.stepX);
        const DhDz = (RtNow.heights[Zp * RtNow.nx + Ix] - RtNow.heights[Zm * RtNow.nx + Ix]) / Math.max(1e-4, (Zp - Zm) * RtNow.stepZ);
        const Slope = Math.acos(1.0 / Math.hypot(DhDx, 1.0, DhDz)) * 57.2957795;
        return { height: H, slopeDeg: Slope, sdf2D: RtNow.sdf2D[I], maxHeight: RtNow.maxHeight || H };
    };

    const MaxTries = Count * 42;
    let Tries = 0;
    while (Out.length < Count && Tries < MaxTries)
    {
        Tries++;
        const Wx = B.x + Rnd() * B.width;
        const Wz = B.z + Rnd() * B.depth;
        const P = Probe(Wx, Wz);
        if (P.sdf2D > 0.0) continue; // offshore

        if (Placement === 'cliffs' && P.slopeDeg < SlopeGate) continue;
        if (Placement === 'ridges')
        {
            if (P.slopeDeg < Math.max(14.0, SlopeGate * 0.55)) continue;
            // Crest bias: accept only locally high cells.
            const N = Probe(Wx + 40, Wz), S = Probe(Wx - 40, Wz), E = Probe(Wx, Wz + 40), W = Probe(Wx, Wz - 40);
            const AvgNeighbour = (N.height + S.height + E.height + W.height) * 0.25;
            if (P.height < AvgNeighbour - 1.5) continue;
        }
        if (Placement === 'coast' && P.sdf2D < -90.0) continue;
        if (Placement === 'altitude' && (P.height < AltMin || P.height > AltMax)) continue;

        const S = 1.0 - ScaleJitter * Rnd();
        Out.push({
            x: Wx, z: Wz, y: P.height,
            slopeDeg: P.slopeDeg,
            radius: Radius * S,
            scale: S,
            yawDeg: Rnd() * 360.0,
            tiltDeg: Math.min(38.0, P.slopeDeg * 0.42) * (Rnd() * 0.7 + 0.3),
            archetypeIndex: Math.floor(Rnd() * 1e6)
        });
    }
    return Out;
}

/*==========================================================================================================================================
                                        LAZY ROCK 2.0 STAMP COMPILATION & CACHING
=============================================================================================----==========================================*/
function LayerCacheKey(Layer)
{
    if (Layer.type === 'rock2_stamp')
    {
        return `stamp|${JSON.stringify(Layer.rock2Doc ? serializeRock2Document(Layer.rock2Doc) : (Layer.rock2StarterId || 'stack-cliff-outcrop'))}|${Layer.rock2Resolution || 40}`;
    }
    return `scatter|${Layer.scatterArchetype || 'big_boulder'}|${Layer.seed || 0}|${Layer.rock2Resolution || 32}|${Layer.scatterCount || 0}`;
}

/** Compiles (or reuses) a coarse RockFormation 2.0 stack for a terrain rock layer. */
export function CompileTerrainRockStamp(Layer)
{
    const Key = LayerCacheKey(Layer);
    let Cached = QuatCache.get(Layer);
    if (Cached && Cached.key === Key) return Cached;

    let Doc = null;
    let Resolution = 40;
    if (Layer.type === 'rock2_stamp')
    {
        Resolution = Math.max(18, Math.min(64, Math.round(Number(Layer.rock2Resolution) || 40)));
        if (Layer.rock2Doc)
        {
            try { Doc = deserializeRock2Document(typeof Layer.rock2Doc === 'string' ? Layer.rock2Doc : serializeRock2Document(Layer.rock2Doc)); }
            catch (Err) { Doc = null; }
        }
        if (!Doc) Doc = CreateRock2StampDocument(Layer.rock2StarterId || 'stack-cliff-outcrop');
    }
    else
    {
        // Scatter instanced archetype: a one-layer rock stack (still pure SDF, still RockFormation 2.0 code path).
        Resolution = Math.max(16, Math.min(48, Math.round(Number(Layer.rock2Resolution) || 32)));
        Doc = createDefaultRock2Document('stack-cliff-outcrop');
        if (Doc && Array.isArray(Doc.layers) && Doc.layers.length > 0)
        {
            Doc.layers = [{
                ...Doc.layers[0],
                type: Layer.scatterArchetype || 'big_boulder',
                generator: { type: 'none' }
            }];
        }
    }

    let Compiled = null;
    try
    {
        Compiled = compileRock2Stack(Doc);
    }
    catch (Err)
    {
        Compiled = null;
    }

    const ExtentX = Compiled?.bounds ? Math.max(1e-3, Compiled.bounds.maxX - Compiled.bounds.minX) : 1.0;
    const ExtentY = Compiled?.bounds ? Math.max(1e-3, Compiled.bounds.maxY - Compiled.bounds.minY) : 1.0;
    const ExtentZ = Compiled?.bounds ? Math.max(1e-3, Compiled.bounds.maxZ - Compiled.bounds.minZ) : 1.0;
    const Centre = Compiled?.bounds
        ? [(Compiled.bounds.minX + Compiled.bounds.maxX) * 0.5, (Compiled.bounds.minY + Compiled.bounds.maxY) * 0.5, (Compiled.bounds.minZ + Compiled.bounds.maxZ) * 0.5]
        : [0, 0, 0];

    Cached = {
        key: Key,
        compiled: Compiled,
        resolution: Resolution,
        extentX: ExtentX, extentY: ExtentY, extentZ: ExtentZ,
        centre: Centre,
        // Normalised height fraction of the stack (for surface embedding).
        heightFrac: ExtentY
    };
    QuatCache.set(Layer, Cached);
    return Cached;
}

/*==========================================================================================================================================
                                                SKIRT / TALUS BEDROCK FUSION GEOMETRY
=============================================================================================----==========================================*/
/**
 * Builds the pure-SDF talus skirt ring that fuses an instanced rock stamp into the terrain volume:
 * a jittered radial apron offset outward from the rock footprint, descending at the angle of repose.
 *
 * Returns `{ positions:[x,y,z,...], indices:[...] }` in WORLD space (already transformed).
 */
export function BuildRockTalusSkirt(Instance, YawRad = 0.0, SkirtWidth = 0.45, RingSegments = 20)
{
    const Height = Math.max(4.0, Instance.radius * 4.0);
    const SkirtM = Math.max(3.0, Instance.radius * SkirtWidth);
    const BaseY = Instance.y - Instance.radius * 1.10;
    const Positions = [];
    const Indices = [];
    const Rnd = Rng(Math.round(Instance.x * 13.0) ^ Math.round(Instance.z * 7.0) ^ 0x9e37);
    for (let I = 0; I < RingSegments; ++I)
    {
        const A = (I / RingSegments) * Math.PI * 2.0;
        const Jitter = 0.82 + 0.36 * Rnd();
        const Ro = Instance.radius * Jitter;
        const Wx = Instance.x + Math.cos(A + YawRad) * Ro;
        const Wz = Instance.z + Math.sin(A + YawRad) * Ro;
        // Inner lip tucked under the rock, outer toe flared onto the terrain (smooth SDF-fused talus).
        Positions.push(Wx * 0.86 + Instance.x * 0.14, BaseY + Instance.radius * 0.34, Wz * 0.86 + Instance.z * 0.14);
        Positions.push(Wx + Math.cos(A + YawRad) * SkirtM, BaseY - Instance.radius * 0.06, Wz + Math.sin(A + YawRad) * SkirtM);
    }
    for (let I = 0; I < RingSegments; ++I)
    {
        const A = I * 2, B = ((I + 1) % RingSegments) * 2;
        Indices.push(A, A + 1, B + 1, A, B + 1, B);
    }
    return { positions: Positions, indices: Indices };
}

/**
 * Emits every instanced RockFormation 2.0 stamp mesh for a terrain rock layer, already transformed into world space
 * and anchored on the terrain surface (with `embedDepthM` sink and optional talus skirt).
 *
 * The caller (TerrainLayerStack mesher) simply appends these vertices/indices — 0 Mesh -> SDF conversions.
 */
export function BuildTerrainRockStampInstances(Layer, Region, Rt, MeshSampler)
{
    const Cached = CompileTerrainRockStamp(Layer);
    if (!Cached || !Cached.compiled) return [];
    const Mesh = MeshSampler ? MeshSampler(Cached) : null;
    if (!Mesh || !Mesh.positions || !Mesh.indices || Mesh.indices.length === 0) return [];

    // The transform must follow the real baked geometry so every stamp is anchored by its own footprint.
    const MB = MeshBounds(Mesh);
    const B = Region.bounds;
    const Embed = Number(Layer.embedDepthM) ?? 6.0;
    const TargetSizeM = Math.max(4.0, Number(Layer.worldScaleM) || 165.0);
    const ScaleMul = TargetSizeM / Math.max(1e-3, Math.max(MB ? MB.extentX : Cached.extentX, MB ? MB.extentZ : Cached.extentZ));
    const SkirtOn = Layer.talusSkirt !== false;

    const Instances = [];
    if (Layer.type === 'rock2_stamp')
    {
        const Placements = Array.isArray(Layer.stampInstances) && Layer.stampInstances.length > 0
            ? Layer.stampInstances
            : [{ x: Number.isFinite(Layer.worldX) ? Layer.worldX : B.x + B.width * 0.5, z: Number.isFinite(Layer.worldZ) ? Layer.worldZ : B.z + B.depth * 0.5, scale: 1.0, yawDeg: Layer.yawDeg || 0 }];
        for (const P of Placements)
        {
            Instances.push({
                x: P.x, z: P.z, y: null,
                radius: TargetSizeM * 0.5 * (P.scale ?? 1.0),
                scale: P.scale ?? 1.0,
                yawDeg: P.yawDeg ?? (Layer.yawDeg || 0),
                tiltDeg: 0
            });
        }
    }
    else
    {
        const Field = ResolveRockScatterInstances(Layer, null, Region, Rt);
        for (const I of Field)
        {
            Instances.push({
                x: I.x, z: I.z, y: I.y,
                radius: TargetSizeM * 0.5 * I.scale,
                scale: I.scale,
                yawDeg: I.yawDeg,
                tiltDeg: I.tiltDeg
            });
        }
    }

    const Out = [];
    for (const Inst of Instances)
    {
        // Anchor the stamp on the actual terrain surface at its (x,z).
        const U = Region.runtime
            ? Math.max(0, Math.min(Region.runtime.nx - 1, Math.round((Inst.x - B.x) / Math.max(1e-4, Region.runtime.stepX))))
            : 0;
        const V = Region.runtime
            ? Math.max(0, Math.min(Region.runtime.nz - 1, Math.round((Inst.z - B.z) / Math.max(1e-4, Region.runtime.stepZ))))
            : 0;
        const SurfaceY = Region.runtime && Region.runtime.hasLand
            ? Region.runtime.heights[V * Region.runtime.nx + U]
            : (Number(Layer.worldY) || 0.0) + 20.0;
        const Y = Number.isFinite(Inst.y) ? Inst.y : SurfaceY;

        // Mesh-local centre & base (so tall stacks pivot about their own middle, not the world origin).
        const MC = (MB ? MB.centre : Cached.centre);
        const Cx = MC[0] * ScaleMul * Inst.scale;
        const Cy = MC[1] * ScaleMul * Inst.scale;
        const Cz = MC[2] * ScaleMul * Inst.scale;
        // Ground the mesh: shift so the lowest vertex lands exactly on (surface − embedDepth).
        const BaseOffsetY = (MB ? MB.minY : 0.0) * ScaleMul * Inst.scale;

        const Yaw = (Inst.yawDeg || 0.0) * Math.PI / 180.0;
        const Tilt = (Inst.tiltDeg || 0.0) * Math.PI / 180.0;
        const Cyw = Math.cos(Yaw), Syw = Math.sin(Yaw);
        const Ctl = Math.cos(Tilt), Stl = Math.sin(Tilt);

        // Terrain anchor: sink `Embed` metres so the rock is genuinely rooted in the terrain volume.
        const AnchorY = Y - Embed;

        const AppendMesh = (Pos, Norm, Col, Albedo, Idx) =>
        {
            const BaseVert = 0;
            const N = Pos.length / 3;
            const OutPos = new Array(N * 3);
            const OutNorm = new Array(N * 3);
            const OutCol = new Array(N * 3);
            for (let I = 0; I < N; ++I)
            {
                const P3 = I * 3;
                // scale + centre + tilt + yaw + translate
                let Lx = Pos[P3] * ScaleMul * Inst.scale - Cx;
                let Ly = Pos[P3 + 1] * ScaleMul * Inst.scale - Cy;
                const vy = Ly;
                let Lz = Pos[P3 + 2] * ScaleMul * Inst.scale - Cz;
                let Ty = Ly * Ctl - Lz * Stl;
                let Tz = Ly * Stl + Lz * Ctl;
                const Rx = Lx * Cyw + Tz * Syw;
                const Rz = -Lx * Syw + Tz * Cyw;
                OutPos[P3] = Inst.x + Rx;
                OutPos[P3 + 1] = AnchorY + (vy - BaseOffsetY) + Ty;
                OutPos[P3 + 2] = Inst.z + Rz;

                if (Norm)
                {
                    const Nx = Norm[P3], Ny = Norm[P3 + 1], Nz = Norm[P3 + 2];
                    // Same tilt → yaw rotation as the positions (normals ignore the scale/translation).
                    const NY = Ny * Ctl - Nz * Stl;
                    const NZ = Ny * Stl + Nz * Ctl;
                    OutNorm[P3] = Nx * Cyw + NZ * Syw;
                    OutNorm[P3 + 1] = NY;
                    OutNorm[P3 + 2] = -Nx * Syw + NZ * Cyw;
                }
                else
                {
                    OutNorm[P3] = 0; OutNorm[P3 + 1] = 1; OutNorm[P3 + 2] = 0;
                }

                if (Col) { OutCol[P3] = Col[P3]; OutCol[P3 + 1] = Col[P3 + 1]; OutCol[P3 + 2] = Col[P3 + 2]; }
                else { OutCol[P3] = Albedo[0]; OutCol[P3 + 1] = Albedo[1]; OutCol[P3 + 2] = Albedo[2]; }
            }
            Out.push({ kind: 'rock', positions: OutPos, normals: OutNorm, colors: OutCol, indices: Int32Array.from(Idx, I => I + BaseVert) });
        };

        AppendMesh(Mesh.positions, Mesh.normals, Mesh.colors, Mesh.albedos || [0.6, 0.56, 0.5], Mesh.indices);

        if (SkirtOn && Layer.type === 'rock2_scatter')
        {
            // The talus skirt is authored directly in world space (it is fused to the terrain, not to the rock).
            const Skirt = BuildRockTalusSkirt({ ...Inst, y: Y }, Yaw, Math.max(0.2, Number(Layer.talusWidth) || 0.45), 18);
            const SN = Skirt.positions.length / 3;
            const SNorm = new Array(SN * 3);
            for (let I = 0; I < SN; ++I) { SNorm[I * 3] = 0.0; SNorm[I * 3 + 1] = 1.0; SNorm[I * 3 + 2] = 0.0; }
            Out.push({
                kind: 'skirt',
                positions: Skirt.positions,
                normals: SNorm,
                colors: Array.from({ length: SN * 3 }, (M, I) => (I % 3 === 0 ? 0.42 : I % 3 === 1 ? 0.39 : 0.35)),
                indices: Int32Array.from(Skirt.indices)
            });
        }
    }
    return Out;
}

/*==========================================================================================================================================
                                                         TERRAIN SCATTER COVERAGE
=============================================================================================----==========================================*/
/**
 * Footprint coverage of the live rock stamps at a terrain cell — used by the heightfield kernel so the ground under a
 * boulder / colonnade / cliff outcrop is lifted & fused instead of spearing through it (zero floating rocks).
 */
export function RockStampFootprintCoverage(Layer, Wx, Wz)
{
    if (Layer.type === 'rock2_stamp')
    {
        const Placements = Array.isArray(Layer.stampInstances) && Layer.stampInstances.length > 0
            ? Layer.stampInstances
            : [{ x: Number(Layer.worldX) || 0, z: Number(Layer.worldZ) || 0, scale: 1.0 }];
        const R = Math.max(6.0, (Number(Layer.worldScaleM) || 165.0) * 0.5);
        let Best = 0.0;
        for (const P of Placements)
        {
            const Reach = R * (P.scale ?? 1.0) * (1.0 + Math.max(0.0, Number(Layer.talusWidth) || 0) * 0.6);
            const D = Math.hypot(Wx - P.x, Wz - P.z);
            if (D < Reach)
            {
                const T = 1.0 - D / Reach;
                const Cov = T * T * (3.0 - 2.0 * T);
                if (Cov > Best) Best = Cov;
            }
        }
        return Best;
    }
    return 0.0;
}

export const ROCK2_TERRAIN_LAYER_TYPES = ['rock2_stamp', 'rock2_scatter'];

export function IsRock2TerrainLayer(Layer)
{
    return !!Layer && ROCK2_TERRAIN_LAYER_TYPES.includes(Layer.type);
}
