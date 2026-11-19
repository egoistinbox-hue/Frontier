//==========================================================================================================================================
// FILE: VoxelSdfClipmapGi.js
// PURPOSE: CPU builder for the HTML mirror of Engine/DistanceFieldSpace/VoxelSdfClipmap.{h,cpp} plus the surface-cache radiosity pass added
//          by the "2-cascade Voxel SDF Clipmap GI, multi-bounce Surface Cache" commit. Produces two toroidal-style cascades of signed
//          distance samples (near: gallery interior, far: chamber shell) and a multi-bounce radiosity surface cache packed into the
//          same RGBA16F volume as (signedDistanceMeters, radiosityR, radiosityG, radiosityB).
//
//          The viewport sphere-traces these volumes for diffuse GI, sky occlusion and specular reflections — the same "SDF clipmap +
//          surface cache" model Unreal's distance-field GI/reflections use, resolved here in WebGL2 without an RTX pipeline.
//
//          Builds are pure and deterministic so the WorldMirrorValidation harness can assert cascade coverage, radiosity convergence and
//          the absence of NaN/Inf samples.
//==========================================================================================================================================

export const CLIPMAP_OPTIONS = {
  Cascades: 2,
  Resolution: 48,
  CascadeScale: 3.0,
  MinHalfExtent: 2.4,
  ScenePadding: 0.25,
  OcclusionSamples: 24,
  RadiosityBounces: 3,
  SunWeight: 1.0,
  SkyWeight: 1.0,
  EmissiveWeight: 2.4,
  SurfaceBand: 1.6,
};

const Clamp = (Value, Low, High) => Math.max(Low, Math.min(High, Value));

export function ResolveClipmapOptions(Settings = {}) {
  const Resolution = [32, 40, 48, 56, 64].includes(Math.round(Number(Settings.GiClipmapResolution)))
    ? Math.round(Number(Settings.GiClipmapResolution))
    : CLIPMAP_OPTIONS.Resolution;
  return {
    Cascades: Clamp(Math.round(Number(Settings.GiClipmapCascades ?? CLIPMAP_OPTIONS.Cascades)), 1, 2),
    Resolution,
    CascadeScale: Clamp(Number(Settings.GiClipmapCascadeScale ?? CLIPMAP_OPTIONS.CascadeScale), 1.6, 4),
    MinHalfExtent: CLIPMAP_OPTIONS.MinHalfExtent,
    ScenePadding: CLIPMAP_OPTIONS.ScenePadding,
    OcclusionSamples: Clamp(
      Math.round(Number(Settings.GiClipmapOcclusionSteps ?? CLIPMAP_OPTIONS.OcclusionSamples)),
      8,
      40,
    ),
    RadiosityBounces: Clamp(Math.round(Number(Settings.GiClipmapBounces ?? CLIPMAP_OPTIONS.RadiosityBounces)), 1, 4),
    SunWeight: CLIPMAP_OPTIONS.SunWeight,
    SkyWeight: CLIPMAP_OPTIONS.SkyWeight,
    EmissiveWeight: CLIPMAP_OPTIONS.EmissiveWeight,
    SurfaceBand: CLIPMAP_OPTIONS.SurfaceBand,
    RadiosityGain: Clamp(Number(Settings.GiClipmapGain ?? 1.0), 0, 3),
    SkyOcclusion: Clamp(Number(Settings.GiClipmapSkyOcclusion ?? 1.0), 0, 1),
    ReflectionSteps: Clamp(Math.round(Number(Settings.ReflectionSdfSteps ?? 36)), 12, 64),
  };
}

/** Local-space primitive distance — mirrors the analytic SDFs used by the scene shader's intersectPrimT. */
function PrimitiveDistance(LocalP, HalfExtents, Shape) {
  const [X, Y, Z] = LocalP;
  const [HX, HY, HZ] = HalfExtents;
  if (Shape === 1) {
    const R = (HX + HY + HZ) / 3;
    return Math.hypot(X, Y, Z) - R;
  }
  if (Shape === 2 || Shape === 5) {
    const R = (HX + HY) * 0.5;
    const Dx = Math.hypot(X, Y) - R;
    const Dz = Math.abs(Z) - HZ;
    const Out = Math.hypot(Math.max(Dx, 0), Math.max(Dz, 0));
    return Math.min(Math.max(Dx, Dz), 0) + Out;
  }
  if (Shape === 3) {
    const R = (HX + HY) * 0.5;
    const H = HZ * 2;
    const Q = Math.hypot(X, Y);
    const T = Clamp((H * 0.5 - Z) / Math.max(1e-4, H), 0, 1);
    const Radius = R * (1 - T);
    return Math.hypot(Q - Radius, Z - H * 0.5 + T * H * 0.5) - 0.002;
  }
  if (Shape === 4) {
    const Major = Math.max(0.05, (HX + HY) * 0.5 - HZ * 0.35);
    const Minor = Math.max(0.02, HZ * 0.35);
    const Q = Math.hypot(X, Y) - Major;
    return Math.hypot(Q, Z) - Minor;
  }
  const Qx = Math.abs(X) - HX;
  const Qy = Math.abs(Y) - HY;
  const Qz = Math.abs(Z) - HZ;
  return (
    Math.hypot(Math.max(Qx, 0), Math.max(Qy, 0), Math.max(Qz, 0)) +
    Math.min(Math.max(Qx, Math.max(Qy, Qz)), 0)
  );
}

/** Rotation columns identical to PackSceneDataBuffer so the clipmap cannot drift from the raster primitives. */
function PrimitiveColumns(RotationRad = [0, 0, 0]) {
  const [Rx, Ry, Rz] = RotationRad;
  const Cx = Math.cos(Rx), Sx = Math.sin(Rx);
  const Cy = Math.cos(Ry), Sy = Math.sin(Ry);
  const Cz = Math.cos(Rz), Sz = Math.sin(Rz);
  return [
    [Cz * Cy, Sz * Cy, -Sy],
    [Cz * Sy * Sx - Sz * Cx, Sz * Sy * Sx + Cz * Cx, Cy * Sx],
    [Cz * Sy * Cx + Sz * Sx, Sz * Sy * Cx - Cz * Sx, Cy * Cx],
  ];
}

function SceneBounds(Primitives) {
  const Min = [Infinity, Infinity, Infinity];
  const Max = [-Infinity, -Infinity, -Infinity];
  for (const P of Primitives) {
    const Radius = Math.max(P.HalfExtents[0], P.HalfExtents[1], P.HalfExtents[2]);
    for (let Axis = 0; Axis < 3; ++Axis) {
      Min[Axis] = Math.min(Min[Axis], P.Center[Axis] - Radius);
      Max[Axis] = Math.max(Max[Axis], P.Center[Axis] + Radius);
    }
  }
  if (!Number.isFinite(Min[0])) {
    return { Center: OscCenter(), HalfExtent: 3 };
  }
  return {
    Center: [(Min[0] + Max[0]) / 2, (Min[1] + Max[1]) / 2, (Min[2] + Max[2]) / 2],
    HalfExtent: Math.max(Max[0] - Min[0], Max[1] - Min[1], Max[2] - Min[2]) / 2,
  };
}

function OscCenter() {
  return [0, 0, 0.6];
}

/** Union SDF + nearest-primitive attribution, evaluated at one world sample. */
function SampleUnion(Prims, X, Y, Z, NearIndex) {
  let Distance = Infinity;
  let Nearest = -1;
  for (let I = 0; I < Prims.length; ++I) {
    const P = Prims[I];
    const Dx = X - P.Center[0];
    const Dy = Y - P.Center[1];
    const Dz = Z - P.Center[2];
    const [C0, C1, C2] = P.Columns;
    const Lx = C0[0] * Dx + C0[1] * Dy + C0[2] * Dz;
    const Ly = C1[0] * Dx + C1[1] * Dy + C1[2] * Dz;
    const Lz = C2[0] * Dx + C2[1] * Dy + C2[2] * Dz;
    let D = PrimitiveDistance([Lx, Ly, Lz], P.HalfExtents, P.Shape);
    if (P.GlassShell) D = Math.max(D, 0.012); // dispersive shells do not occlude diffuse transport
    if (D < Distance) {
      Distance = D;
      Nearest = I;
    }
  }
  if (Nearest >= 0 && NearIndex) NearIndex.Value = Nearest;
  return Distance;
}

/** Trilinear SDF fetch used by the CPU shadow/occlusion march. */
function SampleCascadeSdf(Cascade, X, Y, Z) {
  const N = Cascade.Resolution;
  const Inv = 1 / (2 * Cascade.HalfExtent);
  const U = (X - Cascade.Center[0]) * Inv + 0.5;
  const V = (Y - Cascade.Center[1]) * Inv + 0.5;
  const W = (Z - Cascade.Center[2]) * Inv + 0.5;
  if (U < 0 || U > 1 || V < 0 || V > 1 || W < 0 || W > 1) return Cascade.HalfExtent;
  const Fx = U * (N - 1), Fy = V * (N - 1), Fz = W * (N - 1);
  const X0 = Math.min(N - 2, Math.floor(Fx)), Y0 = Math.min(N - 2, Math.floor(Fy)), Z0 = Math.min(N - 2, Math.floor(Fz));
  const Tx = Fx - X0, Ty = Fy - Y0, Tz = Fz - Z0;
  const Sdf = Cascade.Sdf;
  const At = (Ix, Iy, Iz) => Sdf[(Iz * N + Iy) * N + Ix];
  const L00 = At(X0, Y0, Z0) * (1 - Tx) + At(X0 + 1, Y0, Z0) * Tx;
  const L10 = At(X0, Y0 + 1, Z0) * (1 - Tx) + At(X0 + 1, Y0 + 1, Z0) * Tx;
  const L01 = At(X0, Y0, Z0 + 1) * (1 - Tx) + At(X0 + 1, Y0, Z0 + 1) * Tx;
  const L11 = At(X0, Y0 + 1, Z0 + 1) * (1 - Tx) + At(X0 + 1, Y0 + 1, Z0 + 1) * Tx;
  return (L00 * (1 - Ty) + L10 * Ty) * (1 - Tz) + (L01 * (1 - Ty) + L11 * Ty) * Tz;
}

function CascadeSdf(Cascades, X, Y, Z) {
  const Near = Cascades[0];
  const Bounds = Math.max(
    Math.abs(X - Near.Center[0]),
    Math.abs(Y - Near.Center[1]),
    Math.abs(Z - Near.Center[2]),
  );
  if (Cascades.length > 1 && Bounds > Near.HalfExtent * 0.96) return SampleCascadeSdf(Cascades[1], X, Y, Z);
  return SampleCascadeSdf(Near, X, Y, Z);
}

function MarchSdf(Cascades, Origin, Direction, MaxDistance, Steps) {
  let T = 0.03;
  for (let Step = 0; Step < Steps; ++Step) {
    const X = Origin[0] + Direction[0] * T;
    const Y = Origin[1] + Direction[1] * T;
    const Z = Origin[2] + Direction[2] * T;
    const Distance = CascadeSdf(Cascades, X, Y, Z);
    if (Distance < 0.01 + 0.01 * T) return T;
    T += Math.max(0.03, Distance * 0.85);
    if (T > MaxDistance) break;
  }
  return -1;
}

function Normalize(V) {
  const L = Math.hypot(V[0], V[1], V[2]) || 1;
  return [V[0] / L, V[1] / L, V[2] / L];
}

function SdfGradient(Cascades, X, Y, Z, Epsilon) {
  const Gx = CascadeSdf(Cascades, X + Epsilon, Y, Z) - CascadeSdf(Cascades, X - Epsilon, Y, Z);
  const Gy = CascadeSdf(Cascades, X, Y + Epsilon, Z) - CascadeSdf(Cascades, X, Y - Epsilon, Z);
  const Gz = CascadeSdf(Cascades, X, Y, Z + Epsilon) - CascadeSdf(Cascades, X, Y, Z - Epsilon);
  return Normalize([Gx, Gy, Gz]);
}

const HEMI_DIRECTIONS = (() => {
  const Golden = Math.PI * (3 - Math.sqrt(5));
  const Out = [];
  for (let I = 0; I < 12; ++I) {
    const Z = 1 - (I + 0.5) / 12;
    const R = Math.sqrt(Math.max(0, 1 - Z * Z));
    Out.push([Math.cos(Golden * I) * R, Math.sin(Golden * I) * R, Z]);
  }
  return Out;
})();

/**
 * Builds the cascades. `Primitives` are the compiled gallery primitives, `Lighting` carries the resolved solar/sky terms so the cached
 * radiosity matches the frame the viewport is about to render.
 */
export function BuildVoxelSdfClipmap(Primitives = [], Lighting = {}, Settings = {}) {
  const Options = ResolveClipmapOptions(Settings);
  const Prims = (Primitives || [])
    .filter((P) => P && Array.isArray(P.Center) && Array.isArray(P.HalfExtents))
    .map((P) => ({
      Center: P.Center,
      HalfExtents: P.HalfExtents,
      Shape: Number(P.Shape) || 0,
      Columns: PrimitiveColumns(P.RotationRad || [0, 0, 0]),
      BaseColor: P.BaseColor || [0.7, 0.7, 0.7],
      Emission: Math.max(0, Number(P.Emission) || 0),
      GlassShell: Boolean(P.GlassShell),
      GiContributor: P.GiContributor !== false,
    }));

  if (!Prims.length) {
    return {
      Cascades: [],
      Center: OscCenter(),
      Options,
      Stats: { Primitives: 0, Voxels: 0, SurfaceVoxels: 0, BuildMs: 0, Cascades: 0, RadiosityBounces: Options.RadiosityBounces },
    };
  }

  const StartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  const Bounds = SceneBounds(Prims);
  const SunDir = Normalize(Lighting.SunDir || [0.42, -0.55, 0.72]);
  const SunIrradiance = Lighting.SunIrradiance || [5.4, 5.1, 4.65];
  const SkyRadiance = Lighting.SkyRadiance || [0.16, 0.23, 0.36];
  const SunAbove = Clamp(SunDir[2] * 4 + 0.25, 0, 1);
  const AmbientSky = [
    (SkyRadiance[0] * 0.55 + 0.02) * (0.25 + 0.75 * SunAbove),
    (SkyRadiance[1] * 0.55 + 0.025) * (0.25 + 0.75 * SunAbove),
    (SkyRadiance[2] * 0.55 + 0.04) * (0.25 + 0.75 * SunAbove),
  ];

  const Cascades = [];
  let SurfaceVoxels = 0;
  let Voxels = 0;
  for (let C = 0; C < Options.Cascades; ++C) {
    const HalfExtent = Math.max(
      Options.MinHalfExtent,
      Bounds.HalfExtent + Options.ScenePadding,
    ) * Math.pow(Options.CascadeScale, C);
    const Resolution = C === 0 ? Options.Resolution : Math.max(32, Math.round(Options.Resolution * 0.8));
    const VoxelSize = (2 * HalfExtent) / Resolution;
    const Cascade = BuildCascade({
      Prims,
      Center: Bounds.Center,
      HalfExtent,
      Resolution,
      VoxelSize,
      SunDir,
      SunIrradiance,
      AmbientSky,
      Options,
      Coarse: C > 0,
    });
    Cascades.push(Cascade);
    SurfaceVoxels += Cascade.SurfaceCount;
    Voxels += Resolution * Resolution * Resolution;
  }

  const FinishedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  return {
    Cascades,
    Center: Bounds.Center,
    Options,
    Stats: {
      Primitives: Prims.length,
      Voxels,
      SurfaceVoxels,
      BuildMs: FinishedAt - StartedAt,
      Cascades: Cascades.length,
      RadiosityBounces: Options.RadiosityBounces,
    },
  };
}

function BuildCascade({
  Prims,
  Center,
  HalfExtent,
  Resolution,
  VoxelSize,
  SunDir,
  SunIrradiance,
  AmbientSky,
  Options,
  Coarse,
}) {
  const N = Resolution;
  const Sdf = new Float32Array(N * N * N);
  const Albedo = new Float32Array(N * N * N * 3);
  const Emission = new Float32Array(N * N * N);
  const Normal = new Float32Array(N * N * N * 3);
  const Surface = new Uint8Array(N * N * N);
  const Nearest = new Int16Array(N * N * N);
  const Index = (X, Y, Z) => (Z * N + Y) * N + X;

  // 1. Signed distance + nearest-surface attribution
  for (let Z = 0; Z < N; ++Z) {
    const Wz = Center[2] - HalfExtent + (Z + 0.5) * VoxelSize;
    for (let Y = 0; Y < N; ++Y) {
      const Wy = Center[1] - HalfExtent + (Y + 0.5) * VoxelSize;
      for (let X = 0; X < N; ++X) {
        const Wx = Center[0] - HalfExtent + (X + 0.5) * VoxelSize;
        const Cursor = { Value: -1 };
        const D = SampleUnion(Prims, Wx, Wy, Wz, Cursor);
        const Idx = Index(X, Y, Z);
        Sdf[Idx] = D;
        Nearest[Idx] = Cursor.Value;
      }
    }
  }

  // 2. Surface mask, albedo and outward normal (central difference on the finished field)
  const Band = VoxelSize * Options.SurfaceBand;
  let SurfaceCount = 0;
  for (let Z = 1; Z < N - 1; ++Z) {
    for (let Y = 1; Y < N - 1; ++Y) {
      for (let X = 1; X < N - 1; ++X) {
        const Idx = Index(X, Y, Z);
        const D = Sdf[Idx];
        if (Math.abs(D) > Band) continue;
        Surface[Idx] = 1;
        ++SurfaceCount;
        const Prim = Prims[Nearest[Idx]] || Prims[0];
        Albedo[Idx * 3] = Prim.BaseColor[0];
        Albedo[Idx * 3 + 1] = Prim.BaseColor[1];
        Albedo[Idx * 3 + 2] = Prim.BaseColor[2];
        Emission[Idx] = Prim.Emission;
        const Gx = Sdf[Index(X + 1, Y, Z)] - Sdf[Index(X - 1, Y, Z)];
        const Gy = Sdf[Index(X, Y + 1, Z)] - Sdf[Index(X, Y - 1, Z)];
        const Gz = Sdf[Index(X, Y, Z + 1)] - Sdf[Index(X, Y, Z - 1)];
        const Len = Math.hypot(Gx, Gy, Gz) || 1;
        Normal[Idx * 3] = Gx / Len;
        Normal[Idx * 3 + 1] = Gy / Len;
        Normal[Idx * 3 + 2] = Gz / Len;
      }
    }
  }

  // 3. Direct radiosity: solar visibility by SDF march + sky visibility by cone occlusion
  const Direct = new Float32Array(N * N * N * 3);
  const CascadesRef = [{ Resolution, HalfExtent, Center, Sdf }];
  for (let Z = 1; Z < N - 1; ++Z) {
    const Wz = Center[2] - HalfExtent + (Z + 0.5) * VoxelSize;
    for (let Y = 1; Y < N - 1; ++Y) {
      const Wy = Center[1] - HalfExtent + (Y + 0.5) * VoxelSize;
      for (let X = 1; X < N - 1; ++X) {
        const Idx = Index(X, Y, Z);
        if (!Surface[Idx]) continue;
        const Wx = Center[0] - HalfExtent + (X + 0.5) * VoxelSize;
        const Nx = Normal[Idx * 3], Ny = Normal[Idx * 3 + 1], Nz = Normal[Idx * 3 + 2];
        const Origin = [Wx + Nx * VoxelSize * 1.1, Wy + Ny * VoxelSize * 1.1, Wz + Nz * VoxelSize * 1.1];
        const NdotL = Math.max(0, Nx * SunDir[0] + Ny * SunDir[1] + Nz * SunDir[2]);
        const SunVisible = NdotL > 0 && MarchSdf(CascadesRef, Origin, SunDir, HalfExtent * 1.4, Options.OcclusionSamples) < 0;
        // Sky visibility: 12 hemispherical cones; unoccluded cones weigh their cosine term.
        let SkyVisible = 0;
        let Weight = 0;
        for (const D of HEMI_DIRECTIONS) {
          const Dir = Normalize([
            Nx + D[0] * 0.9,
            Ny + D[1] * 0.9,
            Nz + D[2] * 0.9,
          ]);
          const Cos = Math.max(0, Dir[0] * Nx + Dir[1] * Ny + Dir[2] * Nz);
          Weight += Cos;
          const Hit = MarchSdf(CascadesRef, Origin, Dir, HalfExtent * 0.85, Math.max(8, Options.OcclusionSamples >> 1));
          if (Hit < 0) SkyVisible += Cos;
        }
        SkyVisible = Weight > 1e-4 ? SkyVisible / Weight : 1;
        const AlbedoR = Albedo[Idx * 3], AlbedoG = Albedo[Idx * 3 + 1], AlbedoB = Albedo[Idx * 3 + 2];
        const SunTerm = (SunVisible ? 1 : 0) * NdotL / Math.PI;
        Direct[Idx * 3] =
          AlbedoR * SunIrradiance[0] * SunTerm +
          AlbedoR * AmbientSky[0] * SkyVisible * Options.SkyWeight +
          AlbedoR * Emission[Idx] * Options.EmissiveWeight;
        Direct[Idx * 3 + 1] =
          AlbedoG * SunIrradiance[1] * SunTerm +
          AlbedoG * AmbientSky[1] * SkyVisible * Options.SkyWeight +
          AlbedoG * Emission[Idx] * Options.EmissiveWeight;
        Direct[Idx * 3 + 2] =
          AlbedoB * SunIrradiance[2] * SunTerm +
          AlbedoB * AmbientSky[2] * SkyVisible * Options.SkyWeight +
          AlbedoB * Emission[Idx] * Options.EmissiveWeight;
        Surface[Idx] = SkyVisible > 0.5 ? 1 : 2; // 2 = heavily occluded (kept for the AO channel)
      }
    }
  }

  // 4. Multi-bounce surface cache: Jacobi diffusion of the direct pass through the voxel surface shell.
  let Current = Direct;
  for (let Bounce = 0; Bounce < Options.RadiosityBounces; ++Bounce) {
    const Next = new Float32Array(Direct.length);
    Next.set(Current);
    for (let Z = 1; Z < N - 1; ++Z) {
      for (let Y = 1; Y < N - 1; ++Y) {
        for (let X = 1; X < N - 1; ++X) {
          const Idx = Index(X, Y, Z);
          if (!Surface[Idx]) continue;
          let R = 0, G = 0, Bl = 0, Count = 0;
          for (const [Dx, Dy, Dz] of NEIGHBOURS) {
            const NIdx = Index(X + Dx, Y + Dy, Z + Dz);
            if (!Surface[NIdx]) continue;
            R += Current[NIdx * 3];
            G += Current[NIdx * 3 + 1];
            Bl += Current[NIdx * 3 + 2];
            ++Count;
          }
          if (!Count) continue;
          const Gather = 0.62 / Count;
          Next[Idx * 3] = Direct[Idx * 3] + Albedo[Idx * 3] * R * Gather;
          Next[Idx * 3 + 1] = Direct[Idx * 3 + 1] + Albedo[Idx * 3 + 1] * G * Gather;
          Next[Idx * 3 + 2] = Direct[Idx * 3 + 2] + Albedo[Idx * 3 + 2] * Bl * Gather;
        }
      }
    }
    Current = Next;
  }

  // 5. Pack (signed distance in metres, radiosity RGB) into half floats for the WebGL2 RGBA16F volume.
  const Packed = new Uint16Array(N * N * N * 4);
  let Peak = 0;
  for (let I = 0; I < N * N * N; ++I) {
    const O = I * 4;
    const D = Sdf[I];
    Packed[O] = FloatToHalf(Number.isFinite(D) ? D : 0);
    const HasSurface = Surface[I] ? 1 : 0;
    const R = Current[I * 3] * HasSurface;
    const G = Current[I * 3 + 1] * HasSurface;
    const B = Current[I * 3 + 2] * HasSurface;
    Peak = Math.max(Peak, R, G, B);
    Packed[O + 1] = FloatToHalf(Clamp(Number.isFinite(R) ? R : 0, 0, 64));
    Packed[O + 2] = FloatToHalf(Clamp(Number.isFinite(G) ? G : 0, 0, 64));
    Packed[O + 3] = FloatToHalf(Clamp(Number.isFinite(B) ? B : 0, 0, 64));
  }

  return {
    Resolution: N,
    Center,
    HalfExtent,
    VoxelSize,
    Sdf,
    Albedo,
    Normal,
    Surface,
    Radiosity: Current,
    Direct,
    Packed,
    PeakRadiance: Peak,
    SurfaceCount,
    Coarse,
  };
}

const NEIGHBOURS = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
];

/** IEEE-754 binary32 → binary16 (round to nearest even), matching the shader's HALF_FLOAT upload. */
export function FloatToHalf(Value) {
  const Float = new Float32Array(1);
  const Int = new Int32Array(Float.buffer);
  Float[0] = Value;
  const X = Int[0];
  const Sign = (X >> 16) & 0x8000;
  let Exponent = (X >> 23) & 0xff;
  let Mantissa = X & 0x7fffff;
  if (Exponent === 255) return Sign | 0x7c00 | (Mantissa ? 0x0200 : 0);
  let E = Exponent - 127 + 15;
  if (E >= 31) return Sign | 0x7c00;
  if (E <= 0) {
    if (E < -10) return Sign;
    Mantissa = (Mantissa | 0x800000) >> (1 - E);
    return Sign | (Mantissa >> 13);
  }
  return Sign | (E << 10) | (Mantissa >> 13);
}

/** Half float → number, used by the validation harness to read back the packed volumes. */
export function HalfToFloat(Half) {
  const Sign = Half & 0x8000 ? -1 : 1;
  const Exponent = (Half >> 10) & 0x1f;
  const Mantissa = Half & 0x3ff;
  if (Exponent === 0) return Sign * Mantissa * Math.pow(2, -24);
  if (Exponent === 31) return Mantissa ? NaN : Sign * Infinity;
  return Sign * (1 + Mantissa / 1024) * Math.pow(2, Exponent - 15);
}

export default {
  CLIPMAP_OPTIONS,
  ResolveClipmapOptions,
  BuildVoxelSdfClipmap,
  FloatToHalf,
  HalfToFloat,
};
