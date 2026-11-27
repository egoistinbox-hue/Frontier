/*==========================================================================================================================================
                                                 TERRAINLANDFORMPRIMITIVES.JS
==========================================================================================================================================*/
// Phase L1 · Universal Parametric SDF Basic Landform Primitives for the Open-World SDF Terrain Studio.
//
// - 28 analytical landform archetypes across 6 geological families (Peaks & Volcanoes, Plateaus & Mesas,
//   Valleys & Canyons, Ridges & Faults, Aeolian/Karst/Impact, Coastal & Islands).
// - Every archetype exposes an analytic signed profile h(x,z) with ZERO dead controls: each exposed
//   parameter is read by that archetype's evaluator (verified by Suite 37 in TerrainWorldValidation.mjs).
// - 4 Generator / Placement modes: Single 3D Gizmo · 3D Spline Chain · Ridge Range Array · Scatter Field.
// - Optional true-3D volumetric SDF overhang emitters (undercut slot-canyon walls, cenote lips, wave-cut
//   sea notches) consumed by the sparse 3D brick Dual-Surface-Nets tier — 0 Mesh -> SDF.
//
// All functions are pure & deterministic (no Math.random) so QA / validation is bit-reproducible.

/*==========================================================================================================================================
                                                        SMALL MATH KERNELS
==========================================================================================================================================*/
export const LfClamp = (V, Lo, Hi) => (V < Lo ? Lo : V > Hi ? Hi : V);
export const LfMix = (A, B, T) => A + (B - A) * T;
export const LfSmoothstep = (E0, E1, X) =>
{
    const Span = Math.max(1e-5, E1 - E0);
    const T = LfClamp((X - E0) / Span, 0.0, 1.0);
    return T * T * (3.0 - 2.0 * T);
};
const DEG = Math.PI / 180.0;
const TAU = Math.PI * 2.0;

function LfHash(ix, iz, seed)
{
    let H = Math.imul(ix | 0, 374761393) ^ Math.imul(iz | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
    H = Math.imul(H ^ (H >>> 13), 1274126177);
    return ((H ^ (H >>> 16)) >>> 0) / 4294967295.0;
}

/** Smooth deterministic value noise in [-1..1]. */
export function LfNoise2D(X, Z, Seed = 4029)
{
    const X0 = Math.floor(X), Z0 = Math.floor(Z);
    const Fx = X - X0, Fz = Z - Z0;
    const Ux = Fx * Fx * (3.0 - 2.0 * Fx);
    const Uz = Fz * Fz * (3.0 - 2.0 * Fz);
    const N00 = LfHash(X0, Z0, Seed), N10 = LfHash(X0 + 1, Z0, Seed);
    const N01 = LfHash(X0, Z0 + 1, Seed), N11 = LfHash(X0 + 1, Z0 + 1, Seed);
    return LfMix(LfMix(N00, N10, Ux), LfMix(N01, N11, Ux), Uz) * 2.0 - 1.0;
}

/** Fractal value noise in roughly [-1..1]. */
export function LfFbm2D(X, Z, Octaves = 4, Seed = 4029)
{
    let Sum = 0.0, Amp = 0.5, Freq = 1.0, Norm = 0.0;
    const Oct = Math.max(1, Math.min(6, Octaves | 0));
    for (let I = 0; I < Oct; ++I)
    {
        Sum += Amp * LfNoise2D(X * Freq, Z * Freq, Seed + I * 131);
        Norm += Amp;
        Amp *= 0.5;
        Freq *= 2.03;
    }
    return Sum / Math.max(1e-6, Norm);
}

function LfQuantize(T, Steps, Strength)
{
    const N = Math.max(0, Math.round(Steps));
    if (N < 1 || Strength <= 1e-4) return T;
    const Q = Math.round(LfClamp(T, 0.0, 1.0) * N) / N;
    return LfMix(T, Q, LfClamp(Strength, 0.0, 1.0));
}

/** Deterministic PRNG for scatter fields (mulberry32). */
function LfRng(Seed)
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
                                                     ANALYTIC PROFILE KERNELS
==========================================================================================================================================*/
/** Sharp-crested ridge profile: 1 at the crest, 0 at both flanks (0..1). */
function LfRidgeProfile(T, Sharpness = 0.65)
{
    const A = 1.0 - Math.abs(LfClamp(T, -1.0, 1.0));
    return Math.pow(LfClamp(A, 0.0, 1.0), LfMix(2.6, 0.7, LfClamp(Sharpness, 0.0, 1.0)));
}

/** Asymmetric dune cross-section: gentle windward ramp to the crest, steep lee slipface. */
function LfDuneProfile(Along, WindwardDeg, SlipfaceDeg, CrestAt = 0.22)
{
    const TanW = Math.tan(LfClamp(WindwardDeg, 2.0, 40.0) * DEG);
    const TanS = Math.tan(LfClamp(SlipfaceDeg, 8.0, 55.0) * DEG);
    if (Along < -1.0 || Along > 1.0) return 0.0;
    const Crest = LfClamp(CrestAt, 0.05, 0.85);
    if (Along <= -1.0 + 1e-9) return 0.0;
    if (Along <= Crest)
    {
        const K = (Along + 1.0) / (Crest + 1.0);
        return LfClamp(K * (TanW / Math.max(TanW, TanS)) + K * (1.0 - TanW / Math.max(TanW, TanS)), 0.0, 1.0) * LfSmoothstep(0.0, 0.35, K) * 0.35 + K * 0.65 * (TanW / Math.max(TanW, TanS) * 0.4 + 0.6);
    }
    const K = (Along - Crest) / (1.0 - Crest);
    return LfClamp(1.0 - K * (TanS / Math.max(TanW, TanS)) * 0.92 - K * 0.08, 0.0, 1.0);
}

/**
 * Signed lateral distance from P to a polyline path, with the along-parameter and the per-knot
 * width/depth scale interpolation ([x, z, widthScale?, depthScale?] knots).
 */
export function LfSignedPathDistance(X, Z, Path)
{
    const N = Path.length;
    if (N === 0) return { dist: 1e9, along: 0.0, side: 0.0, widthScale: 1.0, depthScale: 1.0 };
    if (N === 1) return { dist: Math.hypot(X - Path[0][0], Z - Path[0][1]), along: 0.0, side: 0.0, widthScale: Path[0][2] ?? 1.0, depthScale: Path[0][3] ?? 1.0 };

    let BestSq = 1e18, BestAlong = 0.0, BestSide = 0.0, BestW = 1.0, BestD = 1.0;
    let AccLen = 0.0;
    const SegLens = [];
    let TotalLen = 0.0;
    for (let I = 0; I < N - 1; ++I)
    {
        const L = Math.hypot(Path[I + 1][0] - Path[I][0], Path[I + 1][1] - Path[I][1]);
        SegLens.push(L);
        TotalLen += L;
    }
    for (let I = 0; I < N - 1; ++I)
    {
        const Ax = Path[I][0], Az = Path[I][1];
        const Bx = Path[I + 1][0], Bz = Path[I + 1][1];
        const Ex = Bx - Ax, Ez = Bz - Az;
        const LenSq = Math.max(1e-6, Ex * Ex + Ez * Ez);
        const T = LfClamp(((X - Ax) * Ex + (Z - Az) * Ez) / LenSq, 0.0, 1.0);
        const Px = Ax + Ex * T, Pz = Az + Ez * T;
        const DSq = (X - Px) * (X - Px) + (Z - Pz) * (Z - Pz);
        if (DSq < BestSq)
        {
            BestSq = DSq;
            // Signed side: cross product of path direction with the offset vector (left = +, right = -)
            const Side = (Ex * (Z - Az) - Ez * (X - Ax)) / Math.max(1e-6, Math.sqrt(LenSq));
            BestSide = Side >= 0 ? 1.0 : -1.0;
            BestAlong = TotalLen > 1e-6 ? (AccLen + T * SegLens[I]) / TotalLen : 0.0;
            BestW = LfMix(Path[I][2] ?? 1.0, Path[I + 1][2] ?? 1.0, T);
            BestD = LfMix(Path[I][3] ?? 1.0, Path[I + 1][3] ?? 1.0, T);
        }
        AccLen += SegLens[I];
    }
    return { dist: Math.sqrt(BestSq), along: BestAlong, side: BestSide, widthScale: BestW, depthScale: BestD };
}

/** Catmull-Rom resample of a 2D path so canyon walls & ridges curve smoothly. */
export function LfResamplePath(Points, Subdivs = 8)
{
    if (!Points || Points.length < 2) return (Points || []).map(P => [P[0], P[1], P[2] ?? 1.0, P[3] ?? 1.0]);
    const Out = [];
    const N = Points.length;
    for (let I = 0; I < N - 1; ++I)
    {
        const P0 = Points[Math.max(0, I - 1)], P1 = Points[I], P2 = Points[I + 1], P3 = Points[Math.min(N - 1, I + 2)];
        const Steps = Math.max(1, Subdivs | 0);
        for (let S = 0; S < Steps; ++S)
        {
            const T = S / Steps;
            const T2 = T * T, T3 = T2 * T;
            const C = (A, B, Cc, D) => 0.5 * ((2 * B) + (-A + Cc) * T + (2 * A - 5 * B + 4 * Cc - D) * T2 + (-A + 3 * B - 3 * Cc + D) * T3);
            Out.push([
                C(P0[0], P1[0], P2[0], P3[0]),
                C(P0[1], P1[1], P2[1], P3[1]),
                LfMix(P1[2] ?? 1.0, P2[2] ?? 1.0, T),
                LfMix(P1[3] ?? 1.0, P2[3] ?? 1.0, T)
            ]);
        }
    }
    const Last = Points[N - 1];
    Out.push([Last[0], Last[1], Last[2] ?? 1.0, Last[3] ?? 1.0]);
    return Out;
}

/*==========================================================================================================================================
                                              PARAMETER SCHEMA (single source of truth)
==========================================================================================================================================*/
// `probe` is the validation value that must visibly reshape the SDF (Suite 37 enforces zero dead controls).
export const LANDFORM_PARAM_SCHEMA = {
    // ---- Placement & footprint -------------------------------------------------------------
    worldX:           { label: 'Center X',              min: -20000, max: 20000, step: 5,   dec: 0, unit: 'm',  probe: 240 },
    worldZ:           { label: 'Center Z',              min: -20000, max: 20000, step: 5,   dec: 0, unit: 'm',  probe: 240 },
    yawDeg:           { label: 'Yaw Orientation',       min: 0,      max: 360,   step: 1,   dec: 0, unit: '°',  probe: 55 },
    radiusX:          { label: 'Footprint Radius X',    min: 24,     max: 6000,  step: 5,   dec: 0, unit: 'm',  probe: 620 },
    radiusZ:          { label: 'Footprint Radius Z',    min: 24,     max: 6000,  step: 5,   dec: 0, unit: 'm',  probe: 620 },
    footprintPow:     { label: 'Superellipse Squareness', min: 1.2,  max: 8.0,   step: 0.1, dec: 2, unit: 'p',  probe: 6.0 },
    footprintSides:   { label: 'Polygon Footprint Sides', min: 0,    max: 12,    step: 1,   dec: 0, unit: 'side', probe: 5 },

    // ---- Relief & slope profile ------------------------------------------------------------
    heightM:          { label: 'Relief Height',         min: -400,   max: 1600,  step: 5,   dec: 0, unit: 'm',  probe: 480 },
    baseOffsetM:      { label: 'Base Elevation Offset', min: -400,   max: 500,   step: 2,   dec: 0, unit: 'm',  probe: 60 },
    profileGamma:     { label: 'Slope Profile (Concave ↔ Convex)', min: 0.25, max: 3.6, step: 0.05, dec: 2, unit: 'γ', probe: 2.6 },
    topFrac:          { label: 'Caprock / Crater Radius', min: 0.08, max: 0.95, step: 0.01, dec: 2, unit: 'r', probe: 0.42 },
    cliffSharpness:   { label: 'Cliff Sharpness',       min: 0.02, max: 1.0,   step: 0.01, dec: 2, unit: 's',  probe: 0.10 },
    edgeFeatherM:     { label: 'Footprint Edge Feather', min: 2,   max: 400,   step: 2,   dec: 0, unit: 'm',  probe: 120 },
    talusWidth:       { label: 'Talus Apron Width',     min: 0.0,  max: 1.6,   step: 0.02, dec: 2, unit: 'r',  probe: 1.15 },
    talusAngleDeg:    { label: 'Angle of Repose',       min: 18,   max: 46,    step: 0.5,  dec: 1, unit: '°',  probe: 40 },
    stepCount:        { label: 'Strata Ledge Count',    min: 0,    max: 16,    step: 1,    dec: 0, unit: 'bed', probe: 7 },
    stepStrength:     { label: 'Strata Ledge Crispness', min: 0.0, max: 1.0,   step: 0.01, dec: 2, unit: 'w',  probe: 0.92 },

    // ---- Attitude / deformation ------------------------------------------------------------
    dipDeg:           { label: 'Bedding / Dip Angle',   min: 0,     max: 62,    step: 0.5, dec: 1, unit: '°',  probe: 34 },
    strikeDeg:        { label: 'Strike Azimuth',        min: 0,     max: 360,   step: 1,   dec: 0, unit: '°',  probe: 118 },
    throwM:           { label: 'Fault Throw',           min: 0,     max: 600,   step: 2,   dec: 0, unit: 'm',  probe: 165 },
    rolloverM:        { label: 'Footwall Rollover Width', min: 2,   max: 500,   step: 2,   dec: 0, unit: 'm',  probe: 210 },
    foldWavelengthM:  { label: 'Fold Wavelength',       min: 60,    max: 3000,  step: 10,  dec: 0, unit: 'm',  probe: 900 },
    foldAmplitudeM:   { label: 'Fold Amplitude',        min: 2,     max: 400,   step: 2,   dec: 0, unit: 'm',  probe: 150 },
    foldAsymmetry:    { label: 'Fold Asymmetry',        min: -1.0,  max: 1.0,   step: 0.01, dec: 2, unit: 'w', probe: -0.7 },
    ridgeCount:       { label: 'Parallel Ridge Count',  min: 1,     max: 12,    step: 1,   dec: 0, unit: 'n',  probe: 6 },
    ridgeSpacingM:    { label: 'Ridge Spacing',         min: 40,    max: 2200,  step: 10,  dec: 0, unit: 'm',  probe: 700 },

    // ---- Volcanic / crater controls --------------------------------------------------------
    craterRadiusFrac: { label: 'Crater Rim Radius',     min: 0.02,  max: 0.9,   step: 0.01, dec: 2, unit: 'r',  probe: 0.60 },
    craterDepthM:     { label: 'Caldera / Crater Depth', min: 0,    max: 500,   step: 2,   dec: 0, unit: 'm',  probe: 190 },
    rimHeightM:       { label: 'Crater Rim Height',     min: 0,     max: 260,   step: 2,   dec: 0, unit: 'm',  probe: 120 },
    rimWidthFrac:     { label: 'Crater Rim Width',      min: 0.02,  max: 0.6,   step: 0.01, dec: 2, unit: 'r',  probe: 0.34 },
    resurgentDome:    { label: 'Resurgent Central Dome', min: 0,    max: 1.0,   step: 0.01, dec: 2, unit: 'w',  probe: 0.85 },
    radialFlutes:     { label: 'Radial Ridges / Cirques', min: 0,   max: 14,    step: 1,    dec: 0, unit: 'n',  probe: 7 },
    fluteDepth:       { label: 'Cirque Scoop Depth',    min: 0,     max: 1.0,   step: 0.01, dec: 2, unit: 'w',  probe: 0.75 },
    armCount:         { label: 'Dune Arm Count',        min: 2,     max: 8,     step: 1,    dec: 0, unit: 'n',  probe: 5 },
    armStrength:      { label: 'Dune Arm Strength',     min: 0,     max: 1.0,   step: 0.01, dec: 2, unit: 'w',  probe: 0.85 },

    // ---- Aeolian (wind) controls -----------------------------------------------------------
    azimuthDeg:       { label: 'Wind Azimuth',          min: 0,     max: 360,   step: 1,    dec: 0, unit: '°',  probe: 115 },
    windwardDeg:      { label: 'Windward Slope',        min: 3,     max: 28,    step: 0.5,  dec: 1, unit: '°',  probe: 24 },
    slipfaceDeg:      { label: 'Leeward Slipface',      min: 12,    max: 42,    step: 0.5,  dec: 1, unit: '°',  probe: 38 },
    hornLength:       { label: 'Crescent Horn Length',  min: 0,     max: 1.6,   step: 0.02, dec: 2, unit: 'r',  probe: 1.2 },

    // ---- Valley / canyon path controls -----------------------------------------------------
    pathWidthM:       { label: 'Corridor Width',        min: 10,    max: 2400,  step: 5,    dec: 0, unit: 'm',  probe: 460 },
    pathDepthM:       { label: 'Corridor Depth',        min: 4,     max: 900,   step: 2,    dec: 0, unit: 'm',  probe: 320 },
    pathWallDeg:      { label: 'Wall Slant (Under 90° ↔ Overhang)', min: 55, max: 125, step: 0.5, dec: 1, unit: '°', probe: 112 },
    pathFloorFrac:    { label: 'Flat Floor Width',      min: 0.0,   max: 0.95,  step: 0.01, dec: 2, unit: 'r',  probe: 0.80 },
    meanderAmp:       { label: 'Meander Amplitude',     min: 0.0,   max: 1.0,   step: 0.01, dec: 2, unit: 'w',  probe: 0.70 },
    meanderBank:      { label: 'Cut-Bank Asymmetry',    min: 0.0,   max: 1.0,   step: 0.01, dec: 2, unit: 'w',  probe: 0.80 },

    // ---- Coastal / ring controls -----------------------------------------------------------
    ringRadiusFrac:   { label: 'Ring / Lagoon Radius',  min: 0.15,  max: 0.95,  step: 0.01, dec: 2, unit: 'r',  probe: 0.48 },
    ringWidthFrac:    { label: 'Ring Reef Width',       min: 0.03,  max: 0.5,   step: 0.01, dec: 2, unit: 'r',  probe: 0.30 },
    lagoonDepthM:     { label: 'Lagoon Depth',          min: 0,     max: 220,   step: 2,    dec: 0, unit: 'm',  probe: 90 },
    ejectaRadiusFrac: { label: 'Ejecta Blanket Radius', min: 1.0,   max: 3.0,   step: 0.02, dec: 2, unit: 'r',  probe: 2.4 },
    ejectaHeightM:    { label: 'Ejecta Blanket Height', min: 0,     max: 120,   step: 1,    dec: 0, unit: 'm',  probe: 70 },

    // ---- Surface detail --------------------------------------------------------------------
    boundaryWobble:   { label: 'Footprint Boundary Wobble', min: 0, max: 0.9,   step: 0.01, dec: 2, unit: 'w',  probe: 0.70 },
    boundaryScaleM:   { label: 'Boundary Wobble Scale', min: 40,    max: 4000,  step: 10,   dec: 0, unit: 'm',  probe: 420 },
    roughnessAmpM:    { label: 'Flank Surface Roughness', min: 0,   max: 90,    step: 1,    dec: 0, unit: 'm',  probe: 55 },
    roughnessScaleM:  { label: 'Roughness Scale',       min: 20,    max: 1600,  step: 10,   dec: 0, unit: 'm',  probe: 260 },

    // ---- Generator / placement -------------------------------------------------------------
    scatterCount:     { label: 'Scatter Instance Count', min: 1,    max: 48,    step: 1,    dec: 0, unit: 'n',  probe: 11 },
    scatterRadiusM:   { label: 'Scatter Field Radius',  min: 60,    max: 6000,  step: 10,   dec: 0, unit: 'm',  probe: 1500 },
    scatterJitter:    { label: 'Scatter Jitter',        min: 0,     max: 1.0,   step: 0.01, dec: 2, unit: 'w',  probe: 0.85 },
    scatterScaleJitter: { label: 'Scatter Size Jitter', min: 0,     max: 0.9,   step: 0.01, dec: 2, unit: 'w',  probe: 0.70 }
};

export const LANDFORM_PLACEMENT_MODES = [
    ['Single 3D Gizmo (One Landform)', 'single'],
    ['3D Spline Chain (Knots → Landforms)', 'chain'],
    ['Ridge Range Array (Parallel Belt)', 'ridge_range'],
    ['Scatter Field (Seeded Cluster)', 'scatter']
];

export const LANDFORM_COMBINE_MODES = [
    ['Add (Uplift)', 'add'],
    ['Subtract (Carve)', 'sub'],
    ['Max (Union)', 'max'],
    ['Min (Clip)', 'min'],
    ['Blend (Lerp)', 'lerp']
];

/*==========================================================================================================================================
                                        ARCHETYPE CATALOG · 6 GEOLOGICAL FAMILIES
==========================================================================================================================================*/
// mode: 'add'  -> the archetype returns a signed relief delta applied on top of the incoming surface
//       'snap' -> the archetype returns an absolute target elevation (flat caprock / bench / plateau tops)
export const LANDFORM_ARCHETYPES = {
    /* ---------------------------- FAMILY 1 · PEAKS, CONES & VOLCANOES ---------------------------- */
    alpine_horn: {
        family: 'peaks', label: 'Alpine Pyramidal Horn', short: 'HORN', glyph: 'Mountain', mode: 'add',
        desc: 'Glacier-carved pyramidal horn with radial arêtes & cirque scoops',
        defaults: { radiusX: 460, radiusZ: 460, heightM: 380, profileGamma: 1.05, radialFlutes: 5, fluteDepth: 0.42, talusWidth: 0.55, talusAngleDeg: 36, boundaryWobble: 0.18, roughnessAmpM: 12, yawDeg: 0 },
        controls: ['heightM', 'radiusX', 'radiusZ', 'profileGamma', 'radialFlutes', 'fluteDepth', 'talusWidth', 'talusAngleDeg', 'boundaryWobble', 'boundaryScaleM', 'roughnessAmpM']
    },
    shield_volcano: {
        family: 'peaks', label: 'Shield Volcano', short: 'SHIELD', glyph: 'Volcano', mode: 'add',
        desc: 'Broad low-angle basaltic shield with a shallow summit caldera',
        defaults: { radiusX: 1300, radiusZ: 1200, heightM: 260, profileGamma: 2.4, craterRadiusFrac: 0.20, craterDepthM: 42, rimHeightM: 14, rimWidthFrac: 0.12, resurgentDome: 0.18, roughnessAmpM: 6 },
        controls: ['heightM', 'radiusX', 'radiusZ', 'profileGamma', 'craterRadiusFrac', 'craterDepthM', 'rimHeightM', 'rimWidthFrac', 'resurgentDome', 'roughnessAmpM']
    },
    strato_volcano: {
        family: 'peaks', label: 'Stratovolcano + Caldera', short: 'STRATO', glyph: 'Volcano', mode: 'add',
        desc: 'Steep composite cone, summit crater rim & resurgent central dome',
        defaults: { radiusX: 900, radiusZ: 900, heightM: 620, profileGamma: 1.45, craterRadiusFrac: 0.22, craterDepthM: 150, rimHeightM: 55, rimWidthFrac: 0.16, resurgentDome: 0.35, radialFlutes: 6, fluteDepth: 0.16, roughnessAmpM: 10 },
        controls: ['heightM', 'radiusX', 'radiusZ', 'profileGamma', 'craterRadiusFrac', 'craterDepthM', 'rimHeightM', 'rimWidthFrac', 'resurgentDome', 'radialFlutes', 'fluteDepth', 'roughnessAmpM']
    },
    batholith_dome: {
        family: 'peaks', label: 'Granite Batholith Dome', short: 'DOME', glyph: 'Mountain', mode: 'add',
        desc: 'Exfoliated half-dome with a sheer leeward face & rounded whaleback crown',
        defaults: { radiusX: 700, radiusZ: 560, heightM: 330, profileGamma: 2.9, talusWidth: 0.35, talusAngleDeg: 33, boundaryWobble: 0.12, roughnessAmpM: 8, yawDeg: 0 },
        controls: ['heightM', 'radiusX', 'radiusZ', 'profileGamma', 'talusWidth', 'talusAngleDeg', 'boundaryWobble', 'roughnessAmpM', 'yawDeg']
    },
    cinder_cone: {
        family: 'peaks', label: 'Cinder Cone', short: 'CINDER', glyph: 'Volcano', mode: 'add',
        desc: 'Small steep scoria cone with a crisp summit crater',
        defaults: { radiusX: 240, radiusZ: 240, heightM: 140, profileGamma: 1.15, craterRadiusFrac: 0.24, craterDepthM: 42, rimHeightM: 16, rimWidthFrac: 0.14, talusWidth: 0.45, talusAngleDeg: 38, roughnessAmpM: 4 },
        controls: ['heightM', 'radiusX', 'radiusZ', 'profileGamma', 'craterRadiusFrac', 'craterDepthM', 'rimHeightM', 'rimWidthFrac', 'talusWidth', 'talusAngleDeg', 'roughnessAmpM']
    },

    /* ------------------------------- FAMILY 2 · PLATEAUS, MESAS & BENCHES ------------------------------- */
    mesa_tepui: {
        family: 'plateaus', label: 'Flat-Topped Mesa / Tepui', short: 'MESA', glyph: 'Mesa', mode: 'snap',
        desc: 'Sheer caprock cliffs, flat summit, angle-of-repose talus apron',
        defaults: { radiusX: 620, radiusZ: 480, heightM: 240, topFrac: 0.72, cliffSharpness: 0.82, talusWidth: 0.55, talusAngleDeg: 34, edgeFeatherM: 26, footprintPow: 3.4, footprintSides: 0, roughnessAmpM: 3, yawDeg: 0 },
        controls: ['heightM', 'radiusX', 'radiusZ', 'topFrac', 'cliffSharpness', 'talusWidth', 'talusAngleDeg', 'edgeFeatherM', 'footprintPow', 'footprintSides', 'yawDeg', 'roughnessAmpM']
    },
    stepped_butte: {
        family: 'plateaus', label: 'Stepped Grand-Canyon Butte', short: 'BUTTE', glyph: 'Mesa', mode: 'snap',
        desc: 'Multi-storey stratified butte with crisp bedding ledges',
        defaults: { radiusX: 480, radiusZ: 440, heightM: 300, topFrac: 0.42, cliffSharpness: 0.75, stepCount: 6, stepStrength: 0.85, talusWidth: 0.48, talusAngleDeg: 33, edgeFeatherM: 20, roughnessAmpM: 2 },
        controls: ['heightM', 'radiusX', 'radiusZ', 'topFrac', 'cliffSharpness', 'stepCount', 'stepStrength', 'talusWidth', 'talusAngleDeg', 'dipDeg', 'strikeDeg', 'roughnessAmpM']
    },
    cuesta_escarpment: {
        family: 'plateaus', label: 'Tilted Cuesta / Escarpment', short: 'CUESTA', glyph: 'Mesa', mode: 'snap',
        desc: 'Gentle dip slope rising to a sheer scarp face along strike',
        defaults: { radiusX: 900, radiusZ: 520, heightM: 210, dipDeg: 12, strikeDeg: 30, cliffSharpness: 0.9, talusWidth: 0.32, talusAngleDeg: 32, talusAngleDeg: 32, edgeFeatherM: 40, roughnessAmpM: 5 },
        controls: ['heightM', 'radiusX', 'radiusZ', 'dipDeg', 'strikeDeg', 'cliffSharpness', 'talusWidth', 'talusAngleDeg', 'edgeFeatherM', 'roughnessAmpM']
    },
    alluvial_bench: {
        family: 'plateaus', label: 'Alluvial Bench / River Terrace', short: 'BENCH', glyph: 'Bench', mode: 'snap',
        desc: 'Low flat terrace with a riser step & gentle depositional tilt',
        defaults: { radiusX: 700, radiusZ: 420, heightM: 46, topFrac: 0.80, cliffSharpness: 0.5, stepCount: 2, stepStrength: 0.7, talusWidth: 0.5, talusAngleDeg: 30, dipDeg: 3, edgeFeatherM: 45, roughnessAmpM: 2 },
        controls: ['heightM', 'radiusX', 'radiusZ', 'topFrac', 'cliffSharpness', 'stepCount', 'stepStrength', 'dipDeg', 'strikeDeg', 'talusWidth', 'edgeFeatherM', 'roughnessAmpM']
    },

    /* ------------------------------- FAMILY 3 · VALLEYS, CANYONS & GRABENS ------------------------------ */
    v_gorge: {
        family: 'valleys', label: 'V-Shaped Fluvial Gorge', short: 'GORGE', glyph: 'Canyon', mode: 'add',
        desc: 'Sharp V-notch fluvial incision along a 3D spline path',
        defaults: { radiusX: 900, radiusZ: 520, pathWidthM: 260, pathDepthM: 150, pathWallDeg: 68, pathFloorFrac: 0.04, meanderAmp: 0.18, boundaryWobble: 0.2, roughnessAmpM: 6, yawDeg: 0 },
        controls: ['pathWidthM', 'pathDepthM', 'pathWallDeg', 'pathFloorFrac', 'meanderAmp', 'radiusX', 'yawDeg', 'boundaryWobble', 'roughnessAmpM']
    },
    u_glacial_valley: {
        family: 'valleys', label: 'U-Shaped Glacial Valley', short: 'U-VALLEY', glyph: 'Canyon', mode: 'add',
        desc: 'Trough with a flat floor, steep walls & hanging tributary shoulders',
        defaults: { radiusX: 1100, radiusZ: 620, pathWidthM: 420, pathDepthM: 190, pathWallDeg: 84, pathFloorFrac: 0.62, meanderAmp: 0.1, roughnessAmpM: 8, yawDeg: 0 },
        controls: ['pathWidthM', 'pathDepthM', 'pathWallDeg', 'pathFloorFrac', 'meanderAmp', 'radiusX', 'yawDeg', 'boundaryWobble', 'roughnessAmpM']
    },
    slot_canyon: {
        family: 'valleys', label: 'Slot Canyon (3D Overhang Walls)', short: 'SLOT', glyph: 'Canyon', mode: 'add',
        desc: 'Narrow true-3D undercut sandstone slot with a volumetric overhang tier',
        defaults: { radiusX: 800, radiusZ: 400, pathWidthM: 70, pathDepthM: 120, pathWallDeg: 104, pathFloorFrac: 0.30, meanderAmp: 0.35, volumetricUndercut: true, roughnessAmpM: 3, yawDeg: 0 },
        controls: ['pathWidthM', 'pathDepthM', 'pathWallDeg', 'pathFloorFrac', 'meanderAmp', 'radiusX', 'yawDeg', 'roughnessAmpM']
    },
    rift_graben: {
        family: 'valleys', label: 'Tectonic Rift Graben', short: 'GRABEN', glyph: 'Canyon', mode: 'add',
        desc: 'Down-dropped fault block bounded by two steep normal faults',
        defaults: { radiusX: 1600, radiusZ: 520, pathWidthM: 520, pathDepthM: 260, pathWallDeg: 78, pathFloorFrac: 0.55, throwM: 180, rolloverM: 90, roughnessAmpM: 10, yawDeg: 0 },
        controls: ['pathWidthM', 'pathDepthM', 'pathWallDeg', 'pathFloorFrac', 'throwM', 'rolloverM', 'radiusX', 'yawDeg', 'roughnessAmpM']
    },
    meander_channel: {
        family: 'valleys', label: 'Meandering River Channel', short: 'MEANDER', glyph: 'Water', mode: 'add',
        desc: 'Sinuous channel with an undercut cut-bank & gentle point-bar',
        defaults: { radiusX: 1500, radiusZ: 700, pathWidthM: 210, pathDepthM: 46, pathWallDeg: 96, pathFloorFrac: 0.34, meanderAmp: 0.62, meanderBank: 0.72, roughnessAmpM: 2, yawDeg: 0 },
        controls: ['pathWidthM', 'pathDepthM', 'pathWallDeg', 'pathFloorFrac', 'meanderAmp', 'meanderBank', 'radiusX', 'yawDeg', 'roughnessAmpM']
    },

    /* --------------------------------- FAMILY 4 · RIDGES, FAULTS & FOLD BELTS --------------------------- */
    thrust_scarp: {
        family: 'ridges', label: 'Tectonic Thrust Fault Scarp', short: 'SCARP', glyph: 'Fault', mode: 'add',
        desc: 'A → B fault trace with hanging-wall uplift & footwall rollover',
        defaults: { radiusX: 1400, radiusZ: 300, throwM: 160, rolloverM: 120, pathWallDeg: 72, roughnessAmpM: 6, yawDeg: 0 },
        controls: ['throwM', 'rolloverM', 'radiusX', 'radiusZ', 'yawDeg', 'pathWallDeg', 'roughnessAmpM']
    },
    fold_belt: {
        family: 'ridges', label: 'Anticline / Syncline Fold Belt', short: 'FOLD', glyph: 'Fold', mode: 'add',
        desc: 'Folded strata trains with wavelength, amplitude & asymmetry',
        defaults: { radiusX: 1800, radiusZ: 620, foldWavelengthM: 700, foldAmplitudeM: 110, foldAsymmetry: 0.25, roughnessAmpM: 8, yawDeg: 0 },
        controls: ['radiusX', 'radiusZ', 'foldWavelengthM', 'foldAmplitudeM', 'foldAsymmetry', 'yawDeg', 'roughnessAmpM']
    },
    hogback_range: {
        family: 'ridges', label: 'Hogback / Flatiron Range', short: 'HOGBACK', glyph: 'Ridge', mode: 'add',
        desc: 'Array of parallel strike ridges with steep dip-slope faces',
        defaults: { radiusX: 1800, radiusZ: 800, ridgeCount: 5, ridgeSpacingM: 260, heightM: 150, dipDeg: 42, roughnessAmpM: 7, yawDeg: 0 },
        controls: ['radiusX', 'radiusZ', 'ridgeCount', 'ridgeSpacingM', 'heightM', 'dipDeg', 'yawDeg', 'roughnessAmpM']
    },
    knife_arete: {
        family: 'ridges', label: 'Knife-Edge Arête', short: 'ARETE', glyph: 'Ridge', mode: 'add',
        desc: 'Razor crest sweeping along a 3D spline chain',
        defaults: { radiusX: 1300, radiusZ: 220, heightM: 260, pathWidthM: 120, profileGamma: 0.7, roughnessAmpM: 9, yawDeg: 0 },
        controls: ['heightM', 'radiusX', 'pathWidthM', 'radiusZ', 'profileGamma', 'yawDeg', 'roughnessAmpM']
    },

    /* --------------------------- FAMILY 5 · AEOLIAN, KARST & IMPACT FORMS ------------------------------ */
    barchan_dune: {
        family: 'aeolian', label: 'Crescent Barchan Dune', short: 'BARCHAN', glyph: 'Dune', mode: 'add',
        desc: 'Wind-aligned crescent with 12° stoss slope & 34° slipface, trailing horns',
        defaults: { radiusX: 320, radiusZ: 240, heightM: 42, azimuthDeg: 45, windwardDeg: 12, slipfaceDeg: 34, hornLength: 0.7, roughnessAmpM: 1 },
        controls: ['heightM', 'radiusX', 'radiusZ', 'azimuthDeg', 'windwardDeg', 'slipfaceDeg', 'hornLength', 'roughnessAmpM']
    },
    star_dune: {
        family: 'aeolian', label: 'Star Dune', short: 'STAR', glyph: 'Dune', mode: 'add',
        desc: 'Multi-armed radial dune with a high central peak',
        defaults: { radiusX: 300, radiusZ: 300, heightM: 68, armCount: 4, armStrength: 0.7, profileGamma: 1.3, azimuthDeg: 20, roughnessAmpM: 2 },
        controls: ['heightM', 'radiusX', 'radiusZ', 'armCount', 'armStrength', 'profileGamma', 'azimuthDeg', 'roughnessAmpM']
    },
    transverse_dune_field: {
        family: 'aeolian', label: 'Linear Transverse Dune Field', short: 'FIELD', glyph: 'Dune', mode: 'add',
        desc: 'Wind-perpendicular dune train with asymmetric slipfaces',
        defaults: { radiusX: 1800, radiusZ: 1200, heightM: 26, ridgeSpacingM: 180, ridgeCount: 8, azimuthDeg: 60, windwardDeg: 13, slipfaceDeg: 34, roughnessAmpM: 1 },
        controls: ['heightM', 'radiusX', 'radiusZ', 'ridgeSpacingM', 'ridgeCount', 'azimuthDeg', 'windwardDeg', 'slipfaceDeg', 'roughnessAmpM']
    },
    impact_maar: {
        family: 'aeolian', label: 'Impact / Maar Crater', short: 'MAAR', glyph: 'Crater', mode: 'add',
        desc: 'Bowl crater, raised rim & decaying ejecta blanket',
        defaults: { radiusX: 480, radiusZ: 480, heightM: 40, craterRadiusFrac: 0.62, craterDepthM: 130, rimHeightM: 46, rimWidthFrac: 0.18, ejectaRadiusFrac: 1.9, ejectaHeightM: 22, roughnessAmpM: 4 },
        controls: ['heightM', 'radiusX', 'radiusZ', 'craterRadiusFrac', 'craterDepthM', 'rimHeightM', 'rimWidthFrac', 'ejectaRadiusFrac', 'ejectaHeightM', 'roughnessAmpM']
    },
    karst_sinkhole: {
        family: 'aeolian', label: 'Karst Sinkhole / Doline', short: 'SINK', glyph: 'Crater', mode: 'add',
        desc: 'Solution doline with fluted funnel walls & a plugged throat',
        defaults: { radiusX: 260, radiusZ: 260, heightM: 0, craterDepthM: 90, profileGamma: 1.7, radialFlutes: 6, fluteDepth: 0.3, roughnessAmpM: 3 },
        controls: ['radiusX', 'radiusZ', 'craterDepthM', 'profileGamma', 'radialFlutes', 'fluteDepth', 'boundaryWobble', 'roughnessAmpM']
    },
    cenote_shaft: {
        family: 'aeolian', label: 'Karst Cenote / Vertical Shaft', short: 'CENOTE', glyph: 'Crater', mode: 'add',
        desc: 'Near-vertical dissolution shaft with an undercut lip & 3D overhang',
        defaults: { radiusX: 130, radiusZ: 120, heightM: 0, craterDepthM: 140, craterRadiusFrac: 0.72, pathWallDeg: 108, rimHeightM: 8, rimWidthFrac: 0.10, volumetricUndercut: true, roughnessAmpM: 2 },
        controls: ['radiusX', 'radiusZ', 'craterDepthM', 'craterRadiusFrac', 'pathWallDeg', 'rimHeightM', 'rimWidthFrac', 'roughnessAmpM']
    },
    karst_tower: {
        family: 'aeolian', label: 'Karst Tower / Organ Pinnacle', short: 'TOWER', glyph: 'Karst', mode: 'add',
        desc: 'Sheer-sided limestone tower with a rounded crown & basal notch',
        defaults: { radiusX: 170, radiusZ: 150, heightM: 210, profileGamma: 0.42, cliffSharpness: 0.9, roughnessAmpM: 3 },
        controls: ['heightM', 'radiusX', 'radiusZ', 'profileGamma', 'cliffSharpness', 'boundaryWobble', 'roughnessAmpM']
    },

    /* ------------------------------ FAMILY 6 · COASTAL & ISLAND FORMS --------------------------------- */
    atoll_ring: {
        family: 'coastal', label: 'Atoll Ring + Lagoon', short: 'ATOLL', glyph: 'Atoll', mode: 'add',
        desc: 'Coral ring reef enclosing a shallow lagoon basin',
        defaults: { radiusX: 1100, radiusZ: 1000, heightM: 26, ringRadiusFrac: 0.74, ringWidthFrac: 0.16, lagoonDepthM: 40, roughnessAmpM: 2 },
        controls: ['heightM', 'radiusX', 'radiusZ', 'ringRadiusFrac', 'ringWidthFrac', 'lagoonDepthM', 'roughnessAmpM']
    },
    sea_cliff_headland: {
        family: 'coastal', label: 'Sea-Cliff Headland + Wave-Cut Platform', short: 'HEADLAND', glyph: 'Coast', mode: 'snap',
        desc: 'Sheer coastal cliff, wave-cut notch & shore platform',
        defaults: { radiusX: 700, radiusZ: 520, heightM: 130, topFrac: 0.78, cliffSharpness: 0.94, talusWidth: 0.18, talusAngleDeg: 30, edgeFeatherM: 18, roughnessAmpM: 3 },
        controls: ['heightM', 'radiusX', 'radiusZ', 'topFrac', 'cliffSharpness', 'talusWidth', 'edgeFeatherM', 'yawDeg', 'roughnessAmpM']
    },
    barrier_spit: {
        family: 'coastal', label: 'Barrier Spit / Tombolo', short: 'SPIT', glyph: 'Coast', mode: 'add',
        desc: 'Low wave-built sand ridge attaching a headland to the mainland',
        defaults: { radiusX: 1500, radiusZ: 260, heightM: 16, pathWidthM: 180, profileGamma: 1.6, roughnessAmpM: 1, yawDeg: 0 },
        controls: ['heightM', 'radiusX', 'radiusZ', 'pathWidthM', 'profileGamma', 'yawDeg', 'roughnessAmpM']
    },
    shelf_dropoff: {
        family: 'coastal', label: 'Continental Shelf Drop-Off', short: 'SHELF', glyph: 'Coast', mode: 'add',
        desc: 'Shelf break rolling over into a steep continental slope',
        defaults: { radiusX: 1800, radiusZ: 900, heightM: 220, pathWallDeg: 62, rolloverM: 180, roughnessAmpM: 5, yawDeg: 0 },
        controls: ['heightM', 'radiusX', 'radiusZ', 'pathWallDeg', 'rolloverM', 'yawDeg', 'roughnessAmpM']
    }
};

export const LANDFORM_FAMILIES = [
    { id: 'peaks',    label: 'Family 1 · Peaks, Cones & Volcanoes',  types: ['alpine_horn', 'shield_volcano', 'strato_volcano', 'batholith_dome', 'cinder_cone'] },
    { id: 'plateaus', label: 'Family 2 · Plateaus, Mesas & Benches', types: ['mesa_tepui', 'stepped_butte', 'cuesta_escarpment', 'alluvial_bench'] },
    { id: 'valleys',  label: 'Family 3 · Valleys, Canyons & Grabens', types: ['v_gorge', 'u_glacial_valley', 'slot_canyon', 'rift_graben', 'meander_channel'] },
    { id: 'ridges',   label: 'Family 4 · Ridges, Faults & Fold Belts', types: ['thrust_scarp', 'fold_belt', 'hogback_range', 'knife_arete'] },
    { id: 'aeolian',  label: 'Family 5 · Aeolian, Karst & Impact',    types: ['barchan_dune', 'star_dune', 'transverse_dune_field', 'impact_maar', 'karst_sinkhole', 'cenote_shaft', 'karst_tower'] },
    { id: 'coastal',  label: 'Family 6 · Coastal & Island Forms',     types: ['atoll_ring', 'sea_cliff_headland', 'barrier_spit', 'shelf_dropoff'] }
];

export const LANDFORM_ARCHETYPE_LIST = Object.keys(LANDFORM_ARCHETYPES);

export function GetLandformArchetype(Type)
{
    return LANDFORM_ARCHETYPES[Type] || LANDFORM_ARCHETYPES.alpine_horn;
}

export function GetLandformFamily(Type)
{
    return GetLandformArchetype(Type).family;
}

export function IsLandformArchetype(Type)
{
    return Object.prototype.hasOwnProperty.call(LANDFORM_ARCHETYPES, Type);
}

/** Default parameter bag for a fresh landform layer (archetype defaults + placement defaults). */
export function CreateLandformParams(Type = 'alpine_horn', Overrides = {})
{
    const Arch = GetLandformArchetype(Type);
    const Defaults = {
        archetype: Type,
        placement: 'single',
        worldX: 0.0,
        worldZ: 0.0,
        yawDeg: 0.0,
        baseOffsetM: 0.0,
        footprintPow: 2.0,
        footprintSides: 0,
        topFrac: 0.7,
        cliffSharpness: 0.85,
        edgeFeatherM: 24,
        talusWidth: 0.4,
        talusAngleDeg: 34,
        stepCount: 0,
        stepStrength: 0.8,
        dipDeg: 8,
        strikeDeg: 0,
        throwM: 120,
        rolloverM: 120,
        foldWavelengthM: 600,
        foldAmplitudeM: 90,
        foldAsymmetry: 0.0,
        ridgeCount: 4,
        ridgeSpacingM: 260,
        craterRadiusFrac: 0.22,
        craterDepthM: 80,
        rimHeightM: 24,
        rimWidthFrac: 0.16,
        resurgentDome: 0.2,
        radialFlutes: 0,
        fluteDepth: 0.3,
        armCount: 4,
        armStrength: 0.6,
        azimuthDeg: 45,
        windwardDeg: 12,
        slipfaceDeg: 34,
        hornLength: 0.6,
        pathWidthM: 240,
        pathDepthM: 120,
        pathWallDeg: 76,
        pathFloorFrac: 0.3,
        meanderAmp: 0.2,
        meanderBank: 0.5,
        ringRadiusFrac: 0.74,
        ringWidthFrac: 0.16,
        lagoonDepthM: 40,
        ejectaRadiusFrac: 1.9,
        ejectaHeightM: 20,
        boundaryWobble: 0.16,
        boundaryScaleM: 320,
        roughnessAmpM: 6,
        roughnessScaleM: 180,
        scatterCount: 6,
        scatterRadiusM: 1200,
        scatterJitter: 0.7,
        scatterScaleJitter: 0.4,
        pathPoints: [],
        volumetricUndercut: false
    };
    return { ...Defaults, ...Arch.defaults, ...Overrides, archetype: Type };
}

/*==========================================================================================================================================
                                    PATH-BASED ARCHETYPE DETECTION & PATH RESOLUTION
==========================================================================================================================================*/
const PATH_ARCHETYPES = new Set(['v_gorge', 'u_glacial_valley', 'slot_canyon', 'rift_graben', 'meander_channel',
    'thrust_scarp', 'fold_belt', 'hogback_range', 'knife_arete', 'barrier_spit', 'shelf_dropoff', 'transverse_dune_field']);

export function IsPathLandform(Type)
{
    return PATH_ARCHETYPES.has(Type);
}

/**
 * Resolves the A → B strike / flow path of a landform layer:
 * - uses `pathPoints` ([x, z, widthScale?, depthScale?]) when authored,
 * - otherwise synthesizes a straight A → B trace centred on the footprint along `yawDeg`,
 *   with A → B handles living at ±radiusX (so the 3D A → B gizmo can be dragged).
 */
export function ResolveLandformPath(Layer)
{
    const Pts = Array.isArray(Layer.pathPoints) ? Layer.pathPoints : [];
    if (Pts.length >= 2) return LfResamplePath(Pts, 8);

    const cx = Number(Layer.worldX) || 0.0;
    const cz = Number(Layer.worldZ) || 0.0;
    const Yaw = (Number(Layer.yawDeg) || 0.0) * DEG;
    const HalfLen = Math.max(40.0, Number(Layer.radiusX) || 600.0);
    const Dx = Math.cos(Yaw) * HalfLen, Dz = Math.sin(Yaw) * HalfLen;
    const Meander = LfClamp(Number(Layer.meanderAmp) || 0.0, 0.0, 1.0);
    const Seed = (Layer.seed | 0) || 4029;
    if (Meander <= 0.01)
    {
        return LfResamplePath([[cx - Dx, cz - Dz, 1, 1], [cx + Dx, cz + Dz, 1, 1]], 8);
    }
    // Bake meanders directly into the trace so the 3D spline chain & heightfield agree exactly.
    const Knots = [];
    const Segs = 8;
    for (let I = 0; I <= Segs; ++I)
    {
        const T = I / Segs;
        const Along = -HalfLen + 2.0 * HalfLen * T;
        const Nx = -Math.sin(Yaw), Nz = Math.cos(Yaw);
        const Wave = Math.sin(T * Math.PI * 2.0 * 1.35 + Seed * 0.0007) * HalfLen * 0.22 * Meander;
        Knots.push([cx + Math.cos(Yaw) * Along + Nx * Wave, cz + Math.sin(Yaw) * Along + Nz * Wave, 1, 1]);
    }
    return LfResamplePath(Knots, 6);
}

/*==========================================================================================================================================
                                          GENERATOR / PLACEMENT INSTANCE SOLVER
==========================================================================================================================================*/
/**
 * Resolves every landform instance for a layer's placement mode.
 * Returns `[{ cx, cz, rx, rz, yawDeg, scale, phase }]` — deterministic for a given seed.
 */
export function ResolveLandformInstances(Layer)
{
    const Mode = Layer.placement || 'single';
    const cx = Number(Layer.worldX) || 0.0;
    const cz = Number(Layer.worldZ) || 0.0;
    const rx = Math.max(12.0, Number(Layer.radiusX) || 400.0);
    const rz = Math.max(12.0, Number(Layer.radiusZ) || 400.0);
    const yaw = Number(Layer.yawDeg) || 0.0;
    const Seed = ((Layer.seed | 0) || 4029) ^ 0x9E3779B9;
    const Out = [];

    if (Mode === 'single')
    {
        Out.push({ cx, cz, rx, rz, yawDeg: yaw, scale: 1.0, phase: 0.0 });
        return Out;
    }

    if (Mode === 'chain')
    {
        const Pts = Array.isArray(Layer.pathPoints) && Layer.pathPoints.length >= 2 ? Layer.pathPoints : null;
        if (Pts)
        {
            for (let I = 0; I < Pts.length; ++I)
            {
                const W = Pts[I][2] ?? 1.0, D = Pts[I][3] ?? 1.0;
                Out.push({ cx: Pts[I][0], cz: Pts[I][1], rx: rx * W, rz: rz * W, yawDeg: yaw, scale: W, phase: I * 0.37, depthScale: D });
            }
        }
        else
        {
            const Path = ResolveLandformPath(Layer);
            const Count = Math.max(2, Math.min(24, Math.round(Number(Layer.ridgeCount) || 4)));
            for (let I = 0; I < Count; ++I)
            {
                const K = Path[Math.round((I / Math.max(1, Count - 1)) * (Path.length - 1))];
                const W = K[2] ?? 1.0;
                Out.push({ cx: K[0], cz: K[1], rx: rx * W * 0.72, rz: rz * W * 0.72, yawDeg: yaw, scale: W * 0.72, phase: I * 0.37, depthScale: K[3] ?? 1.0 });
            }
        }
        return Out;
    }

    if (Mode === 'ridge_range')
    {
        const Count = Math.max(1, Math.min(16, Math.round(Number(Layer.ridgeCount) || 4)));
        const Spacing = Math.max(20.0, Number(Layer.ridgeSpacingM) || 260.0);
        const Yaw = yaw * DEG;
        const Nx = -Math.sin(Yaw), Nz = Math.cos(Yaw);
        for (let I = 0; I < Count; ++I)
        {
            const Off = (I - (Count - 1) * 0.5) * Spacing;
            Out.push({ cx: cx + Nx * Off, cz: cz + Nz * Off, rx, rz, yawDeg: yaw, scale: 1.0, phase: I * 0.61 });
        }
        return Out;
    }

    // scatter field
    const Count = Math.max(1, Math.min(64, Math.round(Number(Layer.scatterCount) || 6)));
    const Rad = Math.max(30.0, Number(Layer.scatterRadiusM) || 1200.0);
    const Jitter = LfClamp(Number(Layer.scatterJitter) || 0.0, 0.0, 1.0);
    const ScaleJit = LfClamp(Number(Layer.scatterScaleJitter) || 0.0, 0.0, 0.9);
    const Rnd = LfRng(Seed);
    for (let I = 0; I < Count; ++I)
    {
        // Sunflower/golden-angle packing + seeded jitter = even, natural scatter without clumps.
        const Golden = 2.399963229728653;
        const T = (I + 0.5) / Count;
        const Ang = I * Golden + Rnd() * 0.9 * Jitter;
        const Dist = Math.sqrt(T) * Rad * (1.0 - 0.35 * Jitter * (1.0 - Rnd()));
        const S = 1.0 - ScaleJit * Rnd();
        Out.push({
            cx: cx + Math.cos(Ang) * Dist,
            cz: cz + Math.sin(Ang) * Dist,
            rx: rx * S, rz: rz * S,
            yawDeg: yaw + (Rnd() - 0.5) * 60.0 * Jitter,
            scale: S, phase: Rnd() * 7.3
        });
    }
    return Out;
}

/*==========================================================================================================================================
                                        PREPARED LANDFORM (compiled once per layer evaluation)
==========================================================================================================================================*/
export function PrepareLandform(Layer, Ctx = {})
{
    const Type = Layer.archetype || 'alpine_horn';
    const Arch = GetLandformArchetype(Type);
    const Instances = ResolveLandformInstances(Layer);
    let MaxReach = 0.0;
    for (const Inst of Instances)
    {
        const Reach = Math.max(Inst.rx, Inst.rz) * (1.0 + LfClamp(Number(Layer.talusWidth) || 0, 0, 1.6) * 1.2) + 80.0;
        if (Reach > MaxReach) MaxReach = Reach;
    }
    return {
        type: Type,
        arch: Arch,
        mode: Arch.mode === 'snap' ? 'snap' : 'add',
        layer: Layer,
        instances: Instances,
        path: IsPathLandform(Type) ? ResolveLandformPath(Layer) : null,
        seed: (Layer.seed | 0) || 4029,
        baseY: (Number(Ctx.baseY) || 0.0) + (Number(Layer.baseOffsetM) || 0.0),
        maxReach: MaxReach
    };
}

/*==========================================================================================================================================
                                                   PER-INSTANCE HEIGHT SOLVER
==========================================================================================================================================*/
function LocalFrame(Layer, Inst, Wx, Wz)
{
    const Yaw = (Inst.yawDeg || 0) * DEG;
    const C = Math.cos(-Yaw), S = Math.sin(-Yaw);
    const Dx = Wx - Inst.cx, Dz = Wz - Inst.cz;
    const Lx = Dx * C - Dz * S;
    const Lz = Dx * S + Dz * C;
    const U = Lx / Math.max(12.0, Inst.rx);
    const V = Lz / Math.max(12.0, Inst.rz);
    return { lx: Lx, lz: Lz, u: U, v: V, r: Math.hypot(U, V), theta: Math.atan2(V, U), yawRad: Yaw };
}

/** Footprint radius with superellipse power, optional polygon sides & seeded boundary wobble. */
function FootprintRadius(Layer, Frame, Prepared)
{
    const P = LfClamp(Number(Layer.footprintPow) || 2.0, 1.2, 8.0);
    let R = Math.pow(Math.pow(Math.abs(Frame.u), P) + Math.pow(Math.abs(Frame.v), P), 1.0 / P);

    const Sides = Math.round(Number(Layer.footprintSides) || 0);
    if (Sides >= 3)
    {
        const Seg = TAU / Sides;
        const Half = Seg * 0.5;
        const A = ((Frame.theta % Seg) + Seg) % Seg;
        R *= Math.cos(Half) / Math.max(0.08, Math.cos(A - Half));
    }

    const Wobble = LfClamp(Number(Layer.boundaryWobble) || 0.0, 0.0, 0.9);
    if (Wobble > 0.005)
    {
        const Scale = Math.max(20.0, Number(Layer.boundaryScaleM) || 320.0);
        const Freq = TAU / Scale;
        const N = LfFbm2D(Frame.lx * Freq, Frame.lz * Freq, 3, Prepared.seed + 511);
        R *= 1.0 + Wobble * 0.55 * N;
    }
    return R;
}

/** Footprint Spatial Coverage (0 outside → 1 inside) with feather. */
function FootprintCoverage(Layer, Frame, Prepared)
{
    const R = FootprintRadius(Layer, Frame, Prepared);
    const FeatherM = Math.max(2.0, Number(Layer.edgeFeatherM) || 24.0);
    const MeanR = Math.max(12.0, (Math.abs(Frame.lx) + Math.abs(Frame.lz)) / Math.max(1e-6, Math.abs(Frame.u) + Math.abs(Frame.v)) || Math.max(12, Math.min(Math.abs(Prepared.layer.radiusX) || 12, Math.abs(Prepared.layer.radiusZ) || 12)));
    const FeatherFrac = LfClamp(FeatherM / Math.max(24.0, MeanR), 0.01, 0.95);
    return 1.0 - LfSmoothstep(1.0 - FeatherFrac, 1.0 + FeatherFrac * 0.35, R);
}

/** Talus apron multiplier: broadens the effective footprint radius for lower flanks. */
function ApplyTalus(R, Layer)
{
    const Tw = LfClamp(Number(Layer.talusWidth) || 0.0, 0.0, 1.6);
    return R / Math.max(0.2, 1.0 + Tw);
}

/*==========================================================================================================================================
                                              THE 28 ARCHETYPE HEIGHT SOLVERS
==========================================================================================================================================*/
function SolveArchetype(Prepared, Layer, Frame, PathInfo, Wx, Wz)
{
    const Type = Prepared.type;
    const Seed = Prepared.seed;
    const BaseY = Prepared.baseY;
    const Gamma = LfClamp(Number(Layer.profileGamma) || 1.0, 0.25, 3.6);
    const H = Number(Layer.heightM) || 0.0;
    const TalusAng = LfClamp(Number(Layer.talusAngleDeg) || 34.0, 18.0, 46.0) * DEG;
    const TalusWidthFrac = LfClamp(Number(Layer.talusWidth) || 0.0, 0.0, 1.6);
    const Cliff = LfClamp(Number(Layer.cliffSharpness) || 0.85, 0.02, 1.0);
    const MeanR = Math.max(24.0, ((Math.abs(Number(Layer.radiusX)) || 400.0) + (Math.abs(Number(Layer.radiusZ)) || 400.0)) * 0.5);
    const Wobble = LfClamp(Number(Layer.boundaryWobble) || 0.0, 0.0, 0.9);
    const R = ApplyTalus(FootprintRadius(Layer, Frame, Prepared), Layer);
    const T = LfClamp(1.0 - R, 0.0, 1.0);
    const Mode = Prepared.mode;

    let height = 0.0;
    let coverage = 0.0;

    /**
     * Angle-of-repose talus apron for conical / domed peaks: debris accumulates outside the bedrock
     * flank at ~32° so a steeper repose angle raises & steepens the crater-base skirt.
     */
    const ApplyTalusApron = (BedrockH, BedrockAtRadius = null, Anchor = null) =>
    {
        if (TalusWidthFrac <= 0.01) return BedrockH;
        if (Anchor && R > Anchor.r)
        {
            // Debris fan shed from the crater crest: anchored at the rim, descending at the angle of repose.
            const FanH = Anchor.h - (R - Anchor.r) * MeanR * Math.tan(TalusAng);
            return FanH > BedrockH ? FanH : BedrockH;
        }
        const ApronStart = LfClamp(1.0 - TalusWidthFrac * 0.55, 0.10, 1.35);
        if (R <= ApronStart) return BedrockH;
        // Debris wedge: flank scree piles to a real skirt thickness on the actual flank, then decays at the
        // angle of repose — so a steeper repose angle shortens & steepens the apron (never a cosmetic no-op).
        const FlankAtStart = typeof BedrockAtRadius === 'function'
            ? Math.max(0.0, BedrockAtRadius(ApronStart))
            : Math.max(0.0, H * Math.pow(LfClamp(1.0 - ApronStart, 0.0, 1.0), Gamma));
        const BedrockAtStart = Math.max(Math.abs(H) * 0.10, FlankAtStart);
        const ApronH = BedrockAtStart - (R - ApronStart) * MeanR * Math.tan(TalusAng);
        if (ApronH <= 0.0) return BedrockH;
        return Math.max(BedrockH, ApronH);
    };

    switch (Type)
    {
        /* ------------------------------ FAMILY 1 · PEAKS & VOLCANOES ------------------------------ */
        case 'alpine_horn':
        {
            let Hh = H * Math.pow(T, Gamma);
            const Flutes = Math.max(0, Math.round(Number(Layer.radialFlutes) || 0));
            const Fd = LfClamp(Number(Layer.fluteDepth) || 0.0, 0.0, 1.0);
            if (Flutes > 0 && Fd > 0.001)
            {
                const Facet = Math.cos(Flutes * Frame.theta + Seed * 0.0011);
                // Arêtes stand proud, intervening faces scoop inward as glacial cirques.
                Hh *= 1.0 + Fd * 0.30 * Facet * (0.35 + 0.65 * T);
                Hh -= H * Fd * 0.20 * Math.max(0.0, -Facet) * Math.pow(T, 0.75);
            }
            height = ApplyTalusApron(Math.max(0.0, Hh));
            coverage = LfSmoothstep(0.0, 0.06, T) * (1.0 - LfSmoothstep(1.0 - 0.02, 1.0 + TalusWidthFrac * 0.6, R));
            break;
        }
        case 'shield_volcano':
        {
            let Hh = H * Math.pow(T, Gamma);
            const CraterR = LfClamp(Number(Layer.craterRadiusFrac) || 0.2, 0.02, 0.9);
            const CraterD = Math.max(0.0, Number(Layer.craterDepthM) || 0.0);
            const RimH = Math.max(0.0, Number(Layer.rimHeightM) || 0.0);
            const RimW = LfClamp(Number(Layer.rimWidthFrac) || 0.15, 0.02, 0.6);
            if (R < CraterR * 1.9)
            {
                const Q = R / Math.max(1e-4, CraterR);
                const Bowl = CraterD * (1.0 - LfSmoothstep(0.0, 1.0, Q));
                const Ring = RimH * Math.exp(-Math.pow((Q - 1.0) / Math.max(0.05, RimW), 2.0));
                Hh += Ring - Bowl;
                Hh += H * 0.30 * LfClamp(Number(Layer.resurgentDome) || 0.0, 0.0, 1.0) * (1.0 - LfSmoothstep(0.0, CraterR * 0.85, R));
            }
            height = ApplyTalusApron(Hh);
            coverage = 1.0 - LfSmoothstep(0.97, 1.0 + TalusWidthFrac * 0.5, R);
            break;
        }
        case 'strato_volcano':
        {
            let Hh = H * Math.pow(T, Gamma);
            const Flutes = Math.max(0, Math.round(Number(Layer.radialFlutes) || 0));
            const Fd = LfClamp(Number(Layer.fluteDepth) || 0.0, 0.0, 1.0);
            if (Flutes > 0 && Fd > 0.001)
            {
                // Radial gully networks carved by pyroclastic flows.
                Hh *= 1.0 - Fd * 0.16 * (0.5 + 0.5 * Math.cos(Flutes * Frame.theta + 0.4)) * (1.0 - T * 0.5);
            }
            const CraterR = LfClamp(Number(Layer.craterRadiusFrac) || 0.22, 0.02, 0.9);
            const CraterD = Math.max(0.0, Number(Layer.craterDepthM) || 0.0);
            const RimH = Math.max(0.0, Number(Layer.rimHeightM) || 0.0);
            const RimW = LfClamp(Number(Layer.rimWidthFrac) || 0.16, 0.02, 0.6);
            if (R < CraterR * 2.1)
            {
                const Q = R / Math.max(1e-4, CraterR);
                const RimY = H * Math.pow(LfClamp(1.0 - CraterR, 0.0, 1.0), Gamma);
                Hh = LfMix(RimY, RimY - CraterD, 1.0 - LfSmoothstep(0.0, 1.0, Q));
                Hh += RimH * Math.exp(-Math.pow((Q - 1.0) / Math.max(0.05, RimW), 2.0));
                Hh += RimY * 0.42 * LfClamp(Number(Layer.resurgentDome) || 0.0, 0.0, 1.0) * (1.0 - LfSmoothstep(0.0, CraterR * 0.9, R));
            }
            height = ApplyTalusApron(Hh);
            coverage = 1.0 - LfSmoothstep(0.96, 1.0 + TalusWidthFrac * 0.5, R);
            break;
        }
        case 'batholith_dome':
        {
            // Sheer face on the -U flank: shift the dome crown off-centre and clamp the lee wall.
            const Asym = 0.42;
            const Ru = FootprintRadius({ ...Layer, footprintPow: Math.max(2.0, Number(Layer.footprintPow) || 2.0) }, { ...Frame, u: Frame.u - Asym * 0.35 }, Prepared);
            let Hh = H * Math.pow(LfClamp(1.0 - Ru, 0.0, 1.0), Gamma);
            const Face = LfSmoothstep(-1.0, -0.55, Frame.u);
            Hh *= Face;
            height = ApplyTalusApron(Hh);
            coverage = LfSmoothstep(0.0, 0.05, 1.0 - Ru) * (1.0 - LfSmoothstep(0.98, 1.0 + TalusWidthFrac * 0.5, Ru));
            break;
        }
        case 'cinder_cone':
        {
            const CraterR = LfClamp(Number(Layer.craterRadiusFrac) || 0.24, 0.02, 0.9);
            const CraterD = Math.max(0.0, Number(Layer.craterDepthM) || 0.0);
            const RimH = Math.max(0.0, Number(Layer.rimHeightM) || 0.0);
            const RimW = LfClamp(Number(Layer.rimWidthFrac) || 0.14, 0.02, 0.6);
            // Analytic scoria-cone flank (no apron masking) used both as the ground surface and the apron datum.
            const ConeFlank = (RR) =>
            {
                const B = H * Math.pow(LfClamp(1.0 - RR, 0.0, 1.0), Gamma);
                const Q = RR / Math.max(1e-4, CraterR);
                return B + RimH * Math.exp(-Math.pow((Q - 1.0) / Math.max(0.05, RimW), 2.0));
            };
            // Excavate the summit crater from the raw flank so the bowl can never be hidden by the apron.
            const Bowl = CraterD * (1.0 - LfSmoothstep(0.0, 1.0, R / Math.max(1e-4, CraterR))) * (1.0 - 0.20 * Math.min(1.0, R / Math.max(1e-4, CraterR)) ** 2);
            const ConeH = ConeFlank(R) - (R < CraterR * 2.0 ? Bowl : 0.0);
            height = ApplyTalusApron(ConeH, ConeFlank, { r: CraterR, h: ConeFlank(CraterR) });
            coverage = 1.0 - LfSmoothstep(0.94, 1.0 + TalusWidthFrac * 0.6, R);
            break;
        }

        /* ---------------------------- FAMILY 2 · PLATEAUS, MESAS & BENCHES ---------------------------- */
        case 'mesa_tepui':
        case 'stepped_butte':
        case 'alluvial_bench':
        case 'sea_cliff_headland':
        {
            const MeanR = Math.max(30.0, (Math.abs(Layer.radiusX) || 400) * 0.5 + (Math.abs(Layer.radiusZ) || 400) * 0.5);
            const TopFrac = LfClamp(Number(Layer.topFrac) || 0.72, 0.05, 0.98);
            const CapR = TopFrac;
            const CliffM = Math.max(2.0, (1.0 - Cliff) * 0.24 * MeanR + 3.0);
            const CliffFrac = CliffM / MeanR;
            const TalusFrac = TalusWidthFrac * (1.0 - TopFrac) * 0.95;
            const TopY = BaseY + H;
            const StepN = Math.max(0, Math.round(Number(Layer.stepCount) || 0));
            const StepS = LfClamp(Number(Layer.stepStrength) || 0.0, 0.0, 1.0);
            const DipAng = LfClamp(Number(Layer.dipDeg) || 0.0, 0.0, 62.0) * DEG;
            const Strike = (Number(Layer.strikeDeg) || 0.0) * DEG;
            const DipDirX = -Math.sin(Strike), DipDirZ = Math.cos(Strike);
            // Bedding tilt applied to the caprock surface (cuesta / tilted mesa / bench).
            const Tilt = (Frame.lx * DipDirX + Frame.lz * DipDirZ) * Math.tan(DipAng);

            if (R <= CapR)
            {
                height = TopY + Tilt;
                coverage = 1.0;
            }
            else if (R <= CapR + Math.max(CliffFrac, 1e-4))
            {
                const K = (R - CapR) / Math.max(1e-4, CliffFrac);
                const Kq = StepN > 0 ? LfQuantize(K, StepN, StepS) : K;
                height = TopY + Tilt - H * LfSmoothstep(0.0, 1.0, Kq) * 0.985;
                coverage = 1.0;
            }
            else if (R <= CapR + CliffFrac + Math.max(TalusFrac, 1e-4))
            {
                const K = (R - CapR - CliffFrac) / Math.max(1e-4, TalusFrac);
                const DropM = TalusFrac * MeanR * Math.tan(TalusAng);
                height = BaseY + Math.max(0.0, H * 0.015 - (DropM * K));
                coverage = 1.0;
            }
            else
            {
                height = BaseY;
                coverage = 1.0 - LfSmoothstep(0.0, EdgeFeatherFrac(Layer, MeanR), R - (CapR + CliffFrac + Math.max(TalusFrac, 1e-4)));
            }
            break;
        }
        case 'cuesta_escarpment':
        {
            const MeanR = Math.max(30.0, (Math.abs(Layer.radiusX) || 400) * 0.5 + (Math.abs(Layer.radiusZ) || 400) * 0.5);
            const Strike = (Number(Layer.strikeDeg) || 0.0) * DEG;
            const DipDirX = -Math.sin(Strike), DipDirZ = Math.cos(Strike);
            const AlongDip = Frame.lx * DipDirX + Frame.lz * DipDirZ;
            const TanDip = Math.tan(LfClamp(Number(Layer.dipDeg) || 0.0, 0.0, 62.0) * DEG);
            const ScarpDeg = LfMix(52.0, 78.0, Cliff);
            const TanScarp = Math.tan(ScarpDeg * DEG);
            const CrestDist = MeanR * 0.42;
            // Caprock surface rises along the dip slope, then the scarp face drops away seaward.
            const Rise = Math.max(0.0, AlongDip + MeanR * 0.55) * TanDip;
            let Local = Math.min(H, Rise);
            if (AlongDip > CrestDist)
            {
                const Over = AlongDip - CrestDist;
                const CrestH = Math.min(H, (CrestDist + MeanR * 0.55) * TanDip);
                Local = Math.max(0.0, CrestH - Over * TanScarp);
            }
            // The scarp crest must still reach the declared relief height when dip is shallow,
            // otherwise gain the remaining climb as a crest ridge so heightM always reads.
            if (H > 0.0 && TanDip * MeanR < H * 0.6)
            {
                const CrestBand = Math.exp(-Math.pow((AlongDip - CrestDist) / Math.max(6.0, MeanR * 0.30), 2.0));
                Local = Math.max(Local, (H - Math.min(H, TanDip * MeanR * 0.6)) * CrestBand + Math.min(H, TanDip * MeanR * 0.6));
            }
            let LocalH = LfClamp(Local, 0.0, Math.max(0.0, H));
            // Scree apron below the scarp face (angle-of-repose debris wedge).
            if (TalusWidthFrac > 0.01)
            {
                const Toe = CrestDist + Math.max(6.0, (H / Math.max(0.05, Math.tan(LfMix(52.0, 78.0, Cliff) * DEG))));
                const OverToe = AlongDip - Toe;
                if (OverToe > 0.0)
                {
                    const Apron = Math.max(0.0, H * TalusWidthFrac * 0.22 - OverToe * Math.tan(TalusAng));
                    LocalH = Math.max(LocalH, Apron);
                }
            }
            height = BaseY + LocalH;
            coverage = 1.0 - LfSmoothstep(0.95, 1.0 + EdgeFeatherFrac(Layer, MeanR), R);
            break;
        }

        /* ---------------------------- FAMILY 3 · VALLEYS, CANYONS & GRABENS --------------------------- */
        case 'v_gorge':
        case 'u_glacial_valley':
        case 'slot_canyon':
        case 'rift_graben':
        case 'meander_channel':
        {
            const P = PathInfo;
            if (!P) { height = 0.0; coverage = 0.0; break; }
            const WallDeg = LfClamp(Number(Layer.pathWallDeg) || 76.0, 55.0, 125.0);
            const FloorFrac = LfClamp(Number(Layer.pathFloorFrac) || 0.3, 0.0, 0.95);
            // Footprint radii widen/narrow the whole corridor (Gizmo-driven valley width!).
            const RadiusScale = Math.max(0.08, Math.min(
                (Math.abs(Number(Layer.radiusX)) || 800.0) / 800.0,
                (Math.abs(Number(Layer.radiusZ)) || 800.0) / 800.0
            ));
            const HalfW = Math.max(6.0, (Number(Layer.pathWidthM) || 240.0) * 0.5 * (P.widthScale || 1.0) * RadiusScale);
            const Depth = Math.max(2.0, (Number(Layer.pathDepthM) || 120.0) * (P.depthScale || 1.0));
            // Signed lateral distance in metres from the centreline.
            const Side = P.side;
            let Lat = P.dist;
            // Cut-bank asymmetry: steepen one bank, widen the opposite point bar.
            const BankAsym = LfClamp(Number(Layer.meanderBank) || 0.0, 0.0, 1.0);
            if (BankAsym > 0.001 && Type === 'meander_channel')
            {
                Lat *= (Side > 0) ? (1.0 - 0.35 * BankAsym) : (1.0 + 0.55 * BankAsym);
            }

            // Footprint gating along the corridor length (A → B ends taper).
            const AlongGate = LfSmoothstep(0.0, 0.10, P.along) * (1.0 - LfSmoothstep(0.90, 1.0, P.along));
            let Reach = HalfW * (1.0 + 1.35 * Math.max(0.0, 1.0 - FloorFrac)) + 30.0 +
                (Type === 'rift_graben' ? Math.max(40.0, (Number(Layer.rolloverM) || 0)) * 0.55 : 0.0);
            // Meander channels carry a depositional point-bar shoulder on the wide bank.
            if (Type === 'meander_channel' && BankAsym > 0.001)
            {
                Reach *= (Side > 0) ? 1.0 : (1.0 + 0.85 * BankAsym);
            }
            // Boundary wobble roughens the rim of the corridor so walls read as eroding rock, not a sweep.
            if (Wobble > 0.005)
            {
                const BScale = Math.max(20.0, Number(Layer.boundaryScaleM) || 320.0);
                const Bf = TAU / BScale;
                Reach *= 1.0 + Wobble * 0.30 * LfFbm2D(Wx * Bf, Wz * Bf, 3, Seed + 733);
            }
            if (Lat > Reach || AlongGate <= 0.001) { height = 0.0; coverage = 0.0; break; }

            const K = LfClamp(1.0 - Lat / Math.max(1e-4, Reach), 0.0, 1.0);
            let Profile = 0.0;
            if (Type === 'v_gorge')
            {
                // Sharp V: linear rise from the thalweg to the rim.
                Profile = Math.pow(K, LfMix(1.35, 0.85, LfClamp(WallDeg / 125.0, 0.0, 1.0)));
            }
            else if (Type === 'u_glacial_valley')
            {
                // Flat floor + steep trough walls.
                Profile = Math.pow(LfSmoothstep(0.0, Math.max(0.15, 1.0 - FloorFrac), K), 0.45);
            }
            else if (Type === 'slot_canyon')
            {
                // Near-vertical walls with a narrow sandy floor.
                Profile = K < 0.999 ? LfSmoothstep(1.0 - Math.max(0.02, 1.0 - FloorFrac) * 0.10, 1.0, K) : 1.0;
                Profile = Math.pow(Profile, 0.35);
            }
            else if (Type === 'rift_graben')
            {
                // Two normal faults: flat down-dropped floor, abrupt wall break.
                Profile = LfSmoothstep(1.0 - 0.12, 1.0, K);
            }
            else
            {
                // Meander channel: parabolic point-bar cross-section.
                Profile = Math.pow(K, LfMix(2.0, 0.9, LfClamp(WallDeg / 125.0, 0.0, 1.0)));
            }

            const ThrowExtra = Type === 'rift_graben'
                ? Math.max(0.0, Number(Layer.throwM) || 0.0) * 0.45 * Profile
                : 0.0;
            const Rollover = Type === 'rift_graben'
                ? Math.max(0.0, Number(Layer.rolloverM) || 0.0)
                : 0.0;
            // Graben bounding faults: the footwall shoulders roll over within `rolloverM` of the trace,
            // and the graben floor drops by the authored throw (both genuinely reshape the SDF).
            const ShoulderFault = Type === 'rift_graben'
                ? Math.max(0.0, Number(Layer.throwM) || 0.0) * 0.28 *
                  (LfSmoothstep(HalfW * 0.85, HalfW * 0.85 + Math.max(4.0, Rollover * 0.25), Lat) -
                   LfSmoothstep(HalfW * 0.85 + Math.max(4.0, Rollover * 0.25), HalfW * 0.85 + Math.max(5.0, Rollover), Lat))
                : 0.0;
            const ThrowFloor = Type === 'rift_graben'
                ? Math.max(0.0, Number(Layer.throwM) || 0.0) * 0.30 * (1.0 - LfSmoothstep(0.0, HalfW * 0.75, Lat))
                : 0.0;
            const RollTaper = Rollover > 0.5
                ? 1.0 - LfSmoothstep(HalfW * 0.9, HalfW * 0.9 + Rollover, Lat)
                : 1.0;
            // Undercut (>90°) walls get an extra pinch so the 3D brick tier can hollow the rim.
            const Overhang = LfClamp((WallDeg - 90.0) / 35.0, 0.0, 1.0);
            // Along-channel riffle/pool relief so corridor depth always reshapes every path archetype.
            const Riffle = 0.20 * LfFbm2D(Wx * 0.0021, Wz * 0.0021, 2, Seed + 421);
            height = -(Depth * Profile * (0.35 + 0.65 * AlongGate) + ThrowExtra * RollTaper + ThrowFloor + ShoulderFault +
                       Depth * 0.28 * Riffle * AlongGate * (1.0 - Profile * 0.5));
            if (Overhang > 0.01)
            {
                height -= Depth * 0.16 * Overhang * (1.0 - Profile) * AlongGate;
            }
            coverage = AlongGate * (1.0 - LfSmoothstep(0.86, 1.0, Lat / Math.max(1e-4, Reach)));
            break;
        }

        /* ----------------------------- FAMILY 4 · RIDGES, FAULTS & FOLDS ----------------------------- */
        case 'thrust_scarp':
        {
            const MeanR = Math.max(30.0, Math.abs(Layer.radiusZ) || 300.0);
            // Signed distance across the fault trace (path is the surface break).
            const Signed = PathInfo ? (PathInfo.side * PathInfo.dist) : 0.0;
            const AlongGate = PathInfo ? (LfSmoothstep(0.0, 0.08, PathInfo.along) * (1.0 - LfSmoothstep(0.92, 1.0, PathInfo.along))) : 0.0;
            const Throw = Math.max(0.0, Number(Layer.throwM) || 0.0);
            const Roll = Math.max(2.0, Number(Layer.rolloverM) || 120.0);
            const WallDeg = LfClamp(Number(Layer.pathWallDeg) || 72.0, 55.0, 90.0);
            const Step = LfSmoothstep(-Roll * 0.25, Roll * 0.25, (Signed > 0 ? Math.min(Signed, Roll * (90.0 - WallDeg) / 45.0) : Signed * 0.35));
            // Hanging wall up, footwall dragged down into a rollover syncline.
            let Y = Throw * Step;
            const Drag = Math.max(0.0, Math.abs(Signed) - Roll) / Math.max(1.0, Roll);
            Y -= Throw * 0.18 * LfClamp(Drag, 0.0, 1.0) * (Signed < 0 ? 1.0 : 0.35);
            // Freshened scarp face: shave the immediate hanging-wall lip.
            const Lip = LfClamp(1.0 - Math.abs(Signed) / Math.max(8.0, MeanR * 0.35), 0.0, 1.0);
            Y -= Throw * 0.10 * Lip * LfClamp((90.0 - WallDeg) / 35.0, 0.0, 1.0);
            height = Y;
            coverage = AlongGate * (1.0 - LfSmoothstep(MeanR * 0.95, MeanR * 1.35, Math.abs(Signed)));
            break;
        }
        case 'fold_belt':
        case 'hogback_range':
        case 'transverse_dune_field':
        {
            const MeanR = Math.max(30.0, Math.abs(Layer.radiusZ) || 620.0);
            const Yaw = Frame.yawRad;
            const Nx = -Math.sin(Yaw), Nz = Math.cos(Yaw);
            const Across = Frame.lx * Nx + Frame.lz * Nz;
            const WindAz = (Number(Layer.azimuthDeg) || 0.0) * DEG;

            if (Type === 'fold_belt')
            {
                const Wl = Math.max(60.0, Number(Layer.foldWavelengthM) || 600.0);
                const Amp = Math.max(0.0, Number(Layer.foldAmplitudeM) || 90.0);
                const Asym = LfClamp(Number(Layer.foldAsymmetry) || 0.0, -1.0, 1.0);
                const Phase = (Across / Wl) * TAU;
                // Skewed sinusoid: asymmetry steepens one limb (monoclinal drag).
                const Skew = Math.sin(Phase + Asym * 0.9 * Math.sin(Phase));
                height = Amp * 0.5 * (Skew + 1.0);
                coverage = 1.0 - LfSmoothstep(MeanR * 0.92, MeanR * 1.25, Math.abs(Across));
            }
            else if (Type === 'hogback_range')
            {
                const Count = Math.max(1, Math.round(Number(Layer.ridgeCount) || 4));
                const DipDeg = LfClamp(Number(Layer.dipDeg) || 42.0, 0.0, 62.0);
                // Authored strike spacing sets the crest pitch; the ridge count sets the ride-out belt width,
                // so both controls independently reshape the range (no dead sliders).
                const Spacing = Math.max(24.0, Number(Layer.ridgeSpacingM) || 260.0);
                const StrikeLen = Math.max(20.0, Math.abs(Number(Layer.radiusX)) || 1800.0);
                const AlongT = PathInfo ? PathInfo.along : 0.5;
                const StrikeGate = LfSmoothstep(-StrikeLen * 0.5, -StrikeLen * 0.5 + Math.max(8.0, StrikeLen * 0.12), (AlongT - 0.5) * 2.0 * StrikeLen) *
                                   (1.0 - LfSmoothstep(StrikeLen * 0.5 - Math.max(8.0, StrikeLen * 0.12), StrikeLen * 0.5, (AlongT - 0.5) * 2.0 * StrikeLen));
                const BeltHalf = Math.min(StrikeLen * 1.6, Spacing * Count * 0.5);
                const Period = (Across + BeltHalf) / Math.max(20.0, Spacing);
                const Frac = Period - Math.floor(Period);
                // Asymmetric sawtooth: gentle dip slope then sheer escarpment (dip angle sets the skew).
                const Skewed = DipDeg > 55.0 ? Frac : Math.pow(Frac, LfMix(1.6, 0.6, DipDeg / 62.0));
                const Inside = LfSmoothstep(-0.02, 0.10, Period) * (1.0 - LfSmoothstep(Count - 0.10, Count + 0.02, Period));
                const Crest = LfRidgeProfile((Frac - 0.5) * 2.0, 0.86);
                height = H * (0.35 + 0.65 * Skewed) * (0.55 + 0.45 * Crest) * Inside * StrikeGate;
                coverage = (1.0 - LfSmoothstep(MeanR * 0.94, MeanR * 1.3, Math.abs(Across))) * StrikeGate;
            }
            else
            {
                // Transverse dune field: wind-perpendicular asymmetric dune train.
                const Spacing = Math.max(30.0, Number(Layer.ridgeSpacingM) || 180.0);
                const AlongWind = (Frame.lx * Math.cos(WindAz) + Frame.lz * Math.sin(WindAz));
                const Period = AlongWind / Spacing;
                const Frac = Period - Math.floor(Period);
                const Profile = LfDuneProfile(Frac * 2.0 - 1.0, Number(Layer.windwardDeg) || 12, Number(Layer.slipfaceDeg) || 34, 0.32);
                const Count = Math.max(1, Math.round(Number(Layer.ridgeCount) || 8));
                const StrikeLen = Math.max(20.0, Math.abs(Number(Layer.radiusX)) || 1800.0);
                const AlongT = PathInfo ? PathInfo.along : 0.5;
                const StrikeGate = 1.0 - LfSmoothstep(StrikeLen * 0.42, StrikeLen * 0.54, Math.abs((AlongT - 0.5) * 2.0 * StrikeLen));
                // The authored dune count defines the length of the transverse dune train along the wind axis.
                const TrainHalf = Math.max(Spacing * 0.55, Count * Spacing * 0.5);
                const AlongGate = 1.0 - LfSmoothstep(TrainHalf * 0.86, TrainHalf, Math.abs(AlongWind));
                height = H * Profile * StrikeGate * AlongGate;
                coverage = (1.0 - LfSmoothstep(MeanR * 0.95, MeanR * 1.2, Math.abs(Across))) * StrikeGate;
            }
            break;
        }
        case 'knife_arete':
        {
            const P = PathInfo;
            if (!P) { height = 0.0; coverage = 0.0; break; }
            // Radius Z acts as the lateral crest-width control for a ridge, not just the footprint.
            const LateralGain = Math.max(0.25, (Math.abs(Number(Layer.radiusZ)) || 220.0) / 220.0);
            const HalfW = Math.max(8.0, (Number(Layer.pathWidthM) || 120.0) * 0.5 * (P.widthScale || 1.0) * LateralGain);
            const Crest = Math.pow(LfClamp(1.0 - P.dist / HalfW, 0.0, 1.0), Gamma);
            const AlongGate = LfSmoothstep(0.0, 0.12, P.along) * (1.0 - LfSmoothstep(0.88, 1.0, P.along));
            height = H * Crest * AlongGate;
            coverage = AlongGate * (1.0 - LfSmoothstep(0.85, 1.0, P.dist / Math.max(1e-4, HalfW)));
            break;
        }

        /* --------------------------- FAMILY 5 · AEOLIAN, KARST & IMPACT --------------------------- */
        case 'barchan_dune':
        {
            const Wind = (Number(Layer.azimuthDeg) || 0.0) * DEG;
            const AlongWind = (Frame.lx * Math.cos(Wind) + Frame.lz * Math.sin(Wind)) / Math.max(20.0, Math.abs(Layer.radiusX) || 320.0);
            const Cross = (-Frame.lx * Math.sin(Wind) + Frame.lz * Math.cos(Wind)) / Math.max(20.0, Math.abs(Layer.radiusZ) || 240.0);
            const Horns = LfClamp(Number(Layer.hornLength) || 0.0, 0.0, 1.6);
            // Crescent: cross-wind half-width grows downwind to form trailing horns.
            const HalfWidth = 0.62 + 0.40 * Horns * LfSmoothstep(-0.2, 1.0, AlongWind);
            const Lat = Math.abs(Cross) / Math.max(0.05, HalfWidth);
            const Across = LfClamp(1.0 - Lat, 0.0, 1.0);
            const Prof = LfDuneProfile(AlongWind, Number(Layer.windwardDeg) || 12, Number(Layer.slipfaceDeg) || 34, 0.10);
            height = H * Prof * Math.pow(Across, 0.55);
            coverage = (1.0 - LfSmoothstep(0.9, 1.05, Math.hypot(AlongWind, Lat * HalfWidth))) * (Lat < 1.25 ? 1.0 : 0.0);
            break;
        }
        case 'star_dune':
        {
            const Arms = Math.max(2, Math.round(Number(Layer.armCount) || 4));
            const Strength = LfClamp(Number(Layer.armStrength) || 0.0, 0.0, 1.0);
            const Az = (Number(Layer.azimuthDeg) || 0.0) * DEG;
            const Radial = Math.pow(LfClamp(1.0 - R, 0.0, 1.0), Gamma);
            const ArmWave = Math.pow(Math.abs(Math.cos((Arms * (Frame.theta - Az)) * 0.5)), 0.55);
            height = H * Radial * (1.0 - Strength + Strength * ArmWave);
            coverage = 1.0 - LfSmoothstep(0.93, 1.02 + TalusWidthFrac * 0.3, R);
            break;
        }
        case 'impact_maar':
        {
            const CraterR = LfClamp(Number(Layer.craterRadiusFrac) || 0.6, 0.05, 0.95);
            const CraterD = Math.max(0.0, Number(Layer.craterDepthM) || 0.0);
            const RimH = Math.max(0.0, Number(Layer.rimHeightM) || 0.0);
            const RimW = LfClamp(Number(Layer.rimWidthFrac) || 0.18, 0.02, 0.6);
            const EjectaR = LfClamp(Number(Layer.ejectaRadiusFrac) || 1.9, 1.02, 3.0);
            const EjectaH = Math.max(0.0, Number(Layer.ejectaHeightM) || 0.0);
            // Volcanic edifice uplift beneath the crater (heightM) so maar/impact relief always reads.
            let Y = Math.max(0.0, H) * LfSmoothstep(0.0, EjectaR * 0.95, R) * 0.55;
            if (R < CraterR)
            {
                const Q = R / Math.max(1e-4, CraterR);
                Y = Math.max(0.0, H) * 0.55 - CraterD * (1.0 - LfSmoothstep(0.0, 1.0, Q)) * (1.0 - 0.25 * Q * Q);
            }
            Y += RimH * Math.exp(-Math.pow((R - CraterR) / Math.max(0.02, RimW), 2.0));
            if (R > CraterR && R < EjectaR)
            {
                const K = (R - CraterR) / Math.max(1e-4, EjectaR - CraterR);
                Y += EjectaH * Math.pow(1.0 - K, 2.2);
            }
            height = Y;
            coverage = 1.0 - LfSmoothstep(EjectaR * 0.94, EjectaR * 1.06, R);
            break;
        }
        case 'karst_sinkhole':
        {
            const Flutes = Math.max(0, Math.round(Number(Layer.radialFlutes) || 0));
            const Fd = LfClamp(Number(Layer.fluteDepth) || 0.0, 0.0, 1.0);
            const Depth = Math.max(0.0, Number(Layer.craterDepthM) || 0.0);
            let Y = -Depth * Math.pow(T, Gamma);
            if (Flutes > 0 && Fd > 0.001)
            {
                Y -= Depth * Fd * 0.16 * (0.5 + 0.5 * Math.cos(Flutes * Frame.theta)) * (1.0 - T);
            }
            height = Y;
            coverage = LfSmoothstep(0.0, 0.04, T) * (1.0 - LfSmoothstep(0.99, 1.02, R));
            break;
        }
        case 'cenote_shaft':
        {
            const ShaftR = LfClamp(Number(Layer.craterRadiusFrac) || 0.7, 0.05, 0.95);
            const Depth = Math.max(0.0, Number(Layer.craterDepthM) || 0.0);
            const RimH = Math.max(0.0, Number(Layer.rimHeightM) || 0.0);
            const RimW = LfClamp(Number(Layer.rimWidthFrac) || 0.1, 0.02, 0.6);
            const WallDeg = LfClamp(Number(Layer.pathWallDeg) || 108.0, 55.0, 125.0);
            const Overhang = LfClamp((WallDeg - 90.0) / 35.0, 0.0, 1.0);
            // Shaft radius pinches with depth when the lip is undercut (>90°).
            const ShaftProfile = LfSmoothstep(ShaftR * (1.0 - 0.10 * Overhang), ShaftR * (1.0 + 0.06), R);
            height = -Depth * (1.0 - ShaftProfile) + RimH * Math.exp(-Math.pow((R - ShaftR) / Math.max(0.02, RimW), 2.0));
            coverage = 1.0 - LfSmoothstep(ShaftR * 1.20, ShaftR * 1.32, R);
            break;
        }
        case 'karst_tower':
        {
            // Exponent < 1 ⇒ sheer walls with a rounded crown (Guilin / Phang Nga tower).
            let Y = H * Math.pow(T, Gamma);
            Y += H * 0.10 * LfSmoothstep(0.55, 0.92, R) * (1.0 - LfSmoothstep(0.92, 1.0, R)); // basal undercut bulge
            height = Math.max(0.0, Y * (1.0 - (1.0 - Cliff) * 0.15));
            coverage = LfSmoothstep(0.0, 0.03, T) * (1.0 - LfSmoothstep(0.97, 1.01, R));
            break;
        }

        /* ----------------------------- FAMILY 6 · COASTAL & ISLAND FORMS ----------------------------- */
        case 'atoll_ring':
        {
            const RingR = LfClamp(Number(Layer.ringRadiusFrac) || 0.74, 0.15, 0.95);
            const RingW = LfClamp(Number(Layer.ringWidthFrac) || 0.16, 0.03, 0.5);
            const LagoonD = Math.max(0.0, Number(Layer.lagoonDepthM) || 0.0);
            const Ring = Math.exp(-Math.pow((R - RingR) / Math.max(0.02, RingW), 2.0));
            const Lagoon = LagoonD * (1.0 - LfSmoothstep(0.0, RingR, R));
            height = H * Ring - Lagoon;
            coverage = 1.0 - LfSmoothstep(0.96, 1.10, R);
            break;
        }
        case 'barrier_spit':
        {
            const P = PathInfo;
            if (!P) { height = 0.0; coverage = 0.0; break; }
            const LateralGain = Math.max(0.25, (Math.abs(Number(Layer.radiusZ)) || 260.0) / 260.0);
            const HalfW = Math.max(10.0, (Number(Layer.pathWidthM) || 180.0) * 0.5 * (P.widthScale || 1.0) * LateralGain);
            const Cross = Math.pow(LfClamp(1.0 - P.dist / HalfW, 0.0, 1.0), Gamma);
            // Tombolo taper: lowest at both ends, widest crest mid-span.
            const Along = LfSmoothstep(0.0, 0.22, P.along) * (1.0 - LfSmoothstep(0.78, 1.0, P.along));
            height = H * Cross * (0.35 + 0.65 * Along);
            coverage = Along * (1.0 - LfSmoothstep(0.86, 1.0, P.dist / Math.max(1e-4, HalfW)));
            break;
        }
        case 'shelf_dropoff':
        {
            const P = PathInfo;
            if (!P) { height = 0.0; coverage = 0.0; break; }
            const Signed = P.side * P.dist;
            const WallDeg = LfClamp(Number(Layer.pathWallDeg) || 62.0, 20.0, 88.0);
            const Roll = Math.max(20.0, Number(Layer.rolloverM) || 180.0);
            const Tan = Math.tan(WallDeg * DEG);
            // Radius Z scales the depth of the submarine drop-off (Gizmo-draggable bathyal relief).
            const DepthGain = Math.max(0.25, (Math.abs(Number(Layer.radiusZ)) || 900.0) / 900.0);
            const Drop = Math.max(0.0, H) * DepthGain;
            const Y = Signed > 0
                ? -Math.min(Drop, (Signed * Tan))
                : -Drop;
            const Roller = 1.0 - LfSmoothstep(Roll * 0.6, Roll * 1.4, Math.abs(Signed));
            height = Y + (Signed > 0 ? Drop * 0.10 * Roller : 0.0);
            coverage = LfSmoothstep(0.0, 0.10, P.along) * (1.0 - LfSmoothstep(0.90, 1.0, P.along)) *
                       (1.0 - LfSmoothstep(Roll * 1.0, Roll * 2.4, Math.abs(Signed)));
            break;
        }

        default:
        {
            height = H * Math.pow(T, Gamma);
            coverage = 1.0 - LfSmoothstep(0.95, 1.05, R);
            break;
        }
    }

    if (Mode === 'snap') return { height: BaseY + height * 0.0 + (height - BaseY), coverage, mode: 'snap' };
    return { height, coverage, mode: 'add' };
}

function EdgeFeatherFrac(Layer, MeanR)
{
    return LfClamp((Number(Layer.edgeFeatherM) || 24.0) / Math.max(30.0, MeanR), 0.01, 0.6);
}

/*==========================================================================================================================================
                                                PUBLIC EVALUATION ENTRY POINT
==========================================================================================================================================*/
/**
 * Evaluates the composed landform surface contribution at world point (Wx, Wz).
 * Returns `{ height, coverage, mode }` where:
 *  - mode 'add'  ⇒ caller blends `CurH + height` by `coverage`
 *  - mode 'snap' ⇒ `height` is an absolute target elevation (caprock / plateau / bench)
 */
export function EvaluateLandform(Prepared, Wx, Wz)
{
    const Layer = Prepared.layer;
    const Insts = Prepared.instances;
    if (!Insts || Insts.length === 0) return { height: 0.0, coverage: 0.0, mode: Prepared.mode };

    const PathMode = IsPathLandform(Prepared.type);
    const Path = Prepared.path;
    let AccH = 0.0, AccCov = 0.0, MaxCov = 0.0, SnapH = 0.0, SnapW = 0.0;

    for (let I = 0; I < Insts.length; ++I)
    {
        const Inst = Insts[I];
        // Cheap bounding-sphere reject (radius + talus + feather).
        const Reach = Math.max(Inst.rx, Inst.rz) * (1.0 + LfClamp(Number(Layer.talusWidth) || 0, 0, 1.6) * 1.05) + 60.0;
        const Dx = Wx - Inst.cx, Dz = Wz - Inst.cz;
        if (Dx * Dx + Dz * Dz > Reach * Reach) continue;

        const Frame = LocalFrame(Layer, Inst, Wx, Wz);
        let PathInfo = null;
        if (PathMode && Path && Path.length >= 2)
        {
            const P = LfSignedPathDistance(Wx, Wz, Path);
            PathInfo = { dist: P.dist, along: P.along, side: P.side, widthScale: P.widthScale, depthScale: P.depthScale };
        }
        const Res = SolveArchetype(Prepared, Layer, Frame, PathInfo, Wx, Wz);
        if (!(Res.coverage > 0.0001)) continue;

        if (Res.mode === 'snap')
        {
            const W = Res.coverage;
            SnapH += Res.height * W;
            SnapW += W;
            if (W > MaxCov) MaxCov = W;
        }
        else
        {
            AccH += Res.height * Res.coverage;
            AccCov += Res.coverage;
            if (Res.coverage > MaxCov) MaxCov = Res.coverage;
        }
    }

    let Height = 0.0;
    let Mode = Prepared.mode;
    if (SnapW > 1e-5)
    {
        Height = SnapH / SnapW;
        Mode = 'snap';
        if (AccCov > SnapW) { Height = AccH / Math.max(1e-5, AccCov); Mode = 'add'; }
    }
    else if (AccCov > 1e-5)
    {
        Height = AccH / AccCov;
    }

    // Flank surface roughness: fractal detail gated by coverage so footprints stay crisp.
    const RoughAmp = Number(Layer.roughnessAmpM) || 0.0;
    if (RoughAmp > 0.05 && MaxCov > 0.001)
    {
        const RScale = Math.max(12.0, Number(Layer.roughnessScaleM) || 180.0);
        const F = TAU / RScale;
        const N1 = LfFbm2D(Wx * F, Wz * F, 3, Prepared.seed + 907);
        Height += RoughAmp * N1 * MaxCov;
    }

    return { height: Height, coverage: MaxCov, mode: Mode };
}

/*==========================================================================================================================================
                                   TRUE-3D VOLUMETRIC SDF OVERHANG OP EMITTER (Phase L2)
==========================================================================================================================================*/
/**
 * Emits analytical 3D SDF carve capsules for landforms whose walls overhang (> 90° slant):
 * slot-canyon undercut rims, cenote lips, and wave-cut sea notches. These are consumed by the sparse
 * 3D brick Dual-Surface-Nets tier so the landscape gains genuine overhangs — 0 Mesh -> SDF.
 */
export function BuildLandformVolumetricOps(Prepared, SurfaceSampler)
{
    const Layer = Prepared.layer;
    const Ops = [];
    if (!Layer || Layer.volumetricUndercut !== true) return Ops;

    const Type = Prepared.type;
    const WallDeg = Number(Layer.pathWallDeg) || 76.0;
    const Overhang = LfClamp((WallDeg - 90.0) / 35.0, 0.0, 1.0);
    const Sample = typeof SurfaceSampler === 'function' ? SurfaceSampler : () => Prepared.baseY;

    if (Type === 'slot_canyon' || Type === 'meander_channel' || Type === 'u_glacial_valley' || Type === 'v_gorge')
    {
        if (Overhang <= 0.02) return Ops;
        const Path = Prepared.path;
        if (!Path || Path.length < 2) return Ops;
        const HalfW = Math.max(4.0, (Number(Layer.pathWidthM) || 200.0) * 0.5);
        const Depth = Math.max(4.0, Number(Layer.pathDepthM) || 120.0);
        const Step = Math.max(1, Math.round(Path.length / 12));
        for (let I = 0; I < Path.length - 1; I += Step)
        {
            const A = Path[I], B = Path[Math.min(Path.length - 1, I + Step)];
            const Ay = Sample(A[0], A[1]) - Depth * 0.55;
            const By = Sample(B[0], B[1]) - Depth * 0.55;
            // Undercut lip capsule hugging the rim just below the ground surface.
            Ops.push({
                ax: A[0], ay: Ay, az: A[1], bx: B[0], by: By, bz: B[1],
                radius: HalfW * (0.62 + 0.30 * Overhang),
                blend: Math.max(2.0, HalfW * 0.22),
                op: 'cave',
                source: `landform:${Type}`
            });
        }
    }
    else if (Type === 'cenote_shaft')
    {
        const Inst = Prepared.instances[0];
        if (!Inst) return Ops;
        const ShaftR = Math.max(6.0, Number(Layer.craterRadiusFrac) || 0.7) * Math.min(Inst.rx, Inst.rz);
        const Depth = Math.max(8.0, Number(Layer.craterDepthM) || 140.0);
        const TopY = Sample(Inst.cx, Inst.cz);
        Ops.push({
            ax: Inst.cx, ay: TopY - Depth * 0.25, az: Inst.cz,
            bx: Inst.cx, by: TopY - Depth * 1.05, bz: Inst.cz,
            radius: ShaftR * (0.86 + 0.18 * Overhang),
            blend: Math.max(2.0, ShaftR * 0.18),
            op: 'cave',
            source: 'landform:cenote_shaft'
        });
    }
    else if (Type === 'sea_cliff_headland')
    {
        // Wave-cut notch along the seaward (-U) cliff foot.
        for (const Inst of Prepared.instances)
        {
            const Yaw = (Inst.yawDeg || 0) * DEG;
            const SeawardX = -Math.cos(Yaw), SeawardZ = -Math.sin(Yaw);
            const RimX = Inst.cx + SeawardX * Inst.rx * 0.92;
            const RimZ = Inst.cz + SeawardZ * Inst.rz * 0.92;
            const TopY = Sample(RimX, RimZ);
            Ops.push({
                ax: RimX - SeawardZ * Inst.rz * 0.42, ay: TopY - Math.max(4.0, (Number(Layer.heightM) || 120) * 0.20), az: RimZ + SeawardX * Inst.rx * 0.42,
                bx: RimX + SeawardZ * Inst.rz * 0.42, by: TopY - Math.max(4.0, (Number(Layer.heightM) || 120) * 0.20), bz: RimZ - SeawardX * Inst.rx * 0.42,
                radius: Math.max(4.0, (Number(Layer.heightM) || 120) * 0.10),
                blend: 3.0,
                op: 'cave',
                source: 'landform:sea_cliff_headland'
            });
        }
    }
    else if (Type === 'karst_tower' && Overhang > 0.05)
    {
        for (const Inst of Prepared.instances)
        {
            const BaseY = Sample(Inst.cx, Inst.cz);
            Ops.push({
                ax: Inst.cx, ay: BaseY + 2.0, az: Inst.cz,
                bx: Inst.cx, by: BaseY + Math.max(6.0, (Number(Layer.heightM) || 100) * 0.22), bz: Inst.cz,
                radius: Math.min(Inst.rx, Inst.rz) * 0.72,
                blend: 3.0,
                op: 'cave',
                source: 'landform:karst_tower'
            });
        }
    }
    return Ops;
}

/** Human-readable summary badge for the outliner (e.g. "MESA · 620×480 m · snap"). */
export function DescribeLandformLayer(Layer)
{
    const Arch = GetLandformArchetype(Layer.archetype);
    const Placement = (Layer.placement || 'single');
    const RX = Math.round(Number(Layer.radiusX) || 0);
    const RZ = Math.round(Number(Layer.radiusZ) || 0);
    return `${Arch.short} · ${RX}×${RZ} m · ${Placement}`;
}
