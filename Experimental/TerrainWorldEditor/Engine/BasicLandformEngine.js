/*==========================================================================================================================================
                                                     BASICLANDFORMENGINE.JS
==========================================================================================================================================*/
// Universal Pure-SDF Basic Landform Generators for Frontier 3D Landscape Studio (Phase L1 + Sparse 3D Volumetric Overhangs):
// - 6 Fundamental Geological Families · 20 Parametric Pure-SDF Landform Archetypes:
//     1. Peaks, Cones & Volcanoes : alpine_peak, stratovolcano, shield_volcano, granite_dome
//     2. Plateaus, Mesas & Buttes : mesa_plateau, stepped_butte, tilted_cuesta
//     3. Valleys, Canyons & Rifts : v_gorge, u_glacial_valley, slot_canyon (3D Overhang), rift_graben
//     4. Ridges, Faults & Folds   : fault_scarp, fold_belt, hogback_arete
//     5. Aeolian, Karst & Impact  : barchan_dune, star_dune, impact_crater, karst_cenote (3D Overhang)
//     6. Coastal & Island Forms   : atoll_lagoon, sea_cliff_headland (3D Wave-Notch Overhang)
// - 4 Composable Placement Generators: Single (3D Gizmo), Range (Linear Chain), Cluster (Massif), Field (Poisson Scatter)
// - Smooth SDF CSG Combine Modes: Add, Smooth Union (Alluvial), Subtract, Smooth Subtract (Cirque/Canyon), Max, Min, Lerp
// - Zero Dead Controls: every declared per-archetype parameter actively drives the SDF profile or 3D volumetric overhang!

import { MakeTerrainUid } from './WorldMask2D.js';

const Clamp = (V, Lo, Hi) => (V < Lo ? Lo : V > Hi ? Hi : V);
const Mix = (A, B, T) => A + (B - A) * T;
const Smoothstep = (E0, E1, X) =>
{
    const Span = E1 - E0;
    if (Math.abs(Span) < 1e-6) return X >= E1 ? 1.0 : 0.0;
    const T = Clamp((X - E0) / Span, 0.0, 1.0);
    return T * T * (3.0 - 2.0 * T);
};
const SdfSmoothMin = (A, B, K) =>
{
    if (K <= 1e-4) return Math.min(A, B);
    const H = Clamp(0.5 + (0.5 * (B - A)) / K, 0.0, 1.0);
    return Mix(B, A, H) - K * H * (1.0 - H);
};
const SdfSmoothMax = (A, B, K) => -SdfSmoothMin(-A, -B, K);

/*==========================================================================================================================================
                                         DETERMINISTIC PRNG & ORGANIC MICRO-RELIEF NOISE
==========================================================================================================================================*/
function Hash1(N, Seed = 4029)
{
    let H = Math.imul((N | 0) + 374761393, 668265263) ^ Math.imul(Seed | 0, 1442695041);
    H = Math.imul(H ^ (H >>> 13), 1274126177);
    return ((H ^ (H >>> 16)) >>> 0) / 4294967295.0;
}

function Hash2(Ix, Iz, Seed = 4029)
{
    let H = Math.imul(Ix | 0, 374761393) ^ Math.imul(Iz | 0, 668265263) ^ Math.imul(Seed | 0, 1442695041);
    H = Math.imul(H ^ (H >>> 13), 1274126177);
    return ((H ^ (H >>> 16)) >>> 0) / 4294967295.0;
}

function Noise2D(X, Z, Seed = 4029)
{
    const X0 = Math.floor(X), Z0 = Math.floor(Z);
    const Fx = X - X0, Fz = Z - Z0;
    const Ux = Fx * Fx * Fx * (Fx * (Fx * 6.0 - 15.0) + 10.0);
    const Uz = Fz * Fz * Fz * (Fz * (Fz * 6.0 - 15.0) + 10.0);
    const Dot = (Gx, Gz, Dx, Dz) =>
    {
        const A = Hash2(Gx, Gz, Seed) * 6.28318530718;
        return Math.cos(A) * Dx + Math.sin(A) * Dz;
    };
    const N00 = Dot(X0, Z0, Fx, Fz);
    const N10 = Dot(X0 + 1, Z0, Fx - 1.0, Fz);
    const N01 = Dot(X0, Z0 + 1, Fx, Fz - 1.0);
    const N11 = Dot(X0 + 1, Z0 + 1, Fx - 1.0, Fz - 1.0);
    return Mix(Mix(N00, N10, Ux), Mix(N01, N11, Ux), Uz) * 1.4142; // [-1..1]
}

function DetailFbm2D(X, Z, Seed = 4029)
{
    let Sum = 0.0, Amp = 0.56, Freq = 1.0;
    for (let I = 0; I < 3; ++I)
    {
        Sum += Amp * Noise2D(X * Freq, Z * Freq, Seed + I * 197);
        Freq *= 2.08;
        Amp *= 0.48;
    }
    return Sum; // approx [-1..1]
}

function RidgedDetail2D(X, Z, Seed = 4029)
{
    let Sum = 0.0, Amp = 0.58, Freq = 1.0;
    for (let I = 0; I < 3; ++I)
    {
        const R = 1.0 - Math.abs(Noise2D(X * Freq, Z * Freq, Seed + I * 251));
        Sum += Amp * (R * R - 0.35);
        Freq *= 2.12;
        Amp *= 0.48;
    }
    return Sum;
}

function ApplyTerraceSteps(Val01, Steps, Strength)
{
    if (Steps < 1 || Strength <= 1e-4 || Val01 <= 0.0) return Val01;
    const S = Math.max(1.0, Steps);
    const Ph = Val01 * S;
    const Fl = Math.floor(Ph);
    const Fr = Ph - Fl;
    const Stepped = Smoothstep(0.14, 0.86, Fr);
    return Mix(Val01, (Fl + Stepped) / S, Clamp(Strength, 0.0, 0.98));
}

function WrapAnglePi(A)
{
    let X = (A + Math.PI) % (Math.PI * 2.0);
    if (X < 0.0) X += Math.PI * 2.0;
    return X - Math.PI;
}

/*==========================================================================================================================================
                                      6 GEOLOGICAL LANDFORM FAMILIES & 20 ARCHETYPE CATALOG
==========================================================================================================================================*/
export const LANDFORM_FAMILIES = [
    { id: 'peaks',         label: 'Peaks & Volcanoes', shortLabel: 'Peaks',    glyph: 'Volcano', accent: '#f0935b', desc: 'Alpine horns, stratovolcanoes, calderas, shields & granite domes' },
    { id: 'plateaus',      label: 'Mesas & Escarpments', shortLabel: 'Plateaus', glyph: 'Mesa',    accent: '#e8c27a', desc: 'Flat-topped mesas, stepped buttes & tilted cuestas' },
    { id: 'valleys',       label: 'Valleys & Canyons', shortLabel: 'Valleys',  glyph: 'Canyon',  accent: '#5ac8fa', desc: 'V-gorges, U-glacial fjords, 3D slot canyons & rift grabens' },
    { id: 'ridges',        label: 'Ridges, Faults & Folds', shortLabel: 'Ridges', glyph: 'Fault',  accent: '#d6a2e8', desc: 'Tectonic fault scarps, folded anticlines & knife-edge arêtes' },
    { id: 'aeolian_karst', label: 'Dunes, Craters & Karst', shortLabel: 'Dunes/Karst', glyph: 'Dune', accent: '#f3d078', desc: 'Barchan & star dunes, impact craters & 3D karst cenotes' },
    { id: 'coastal',       label: 'Coastal & Islands', shortLabel: 'Coastal',  glyph: 'Atoll',   accent: '#3ec46d', desc: 'Volcanic atoll lagoons & 3D wave-notch sea-cliff headlands' }
];

export const LANDFORM_PLACEMENT_MODES = [
    ['Single Hero (3D Gizmo)', 'single'],
    ['Mountain Chain / Range Array', 'range'],
    ['Massif / Satellite Cluster', 'cluster'],
    ['Procedural Scatter Field', 'field']
];

export const LANDFORM_COMBINE_MODES = [
    ['Smooth Union (Alluvial Blend)', 'smooth_union'],
    ['Add (Uplift / Bipolar)', 'add'],
    ['Smooth Subtract (Carve Rim)', 'smooth_sub'],
    ['Subtract (Sharp Carve)', 'sub'],
    ['Max (Bedrock Pierce)', 'max'],
    ['Min (Clip Ceiling)', 'min'],
    ['Blend (Replace Elevation)', 'lerp']
];

/**
 * Complete registry of all 20 Universal Pure-SDF Basic Landform Archetypes.
 * Each entry explicitly declares its contextual `controls` schema so the UI has ZERO dead controls!
 */
export const LANDFORM_CATALOG = [
    // =========================================================================
    // FAMILY 1: PEAKS, CONES & VOLCANOES
    // =========================================================================
    {
        id: 'alpine_peak',
        family: 'peaks',
        name: 'Alpine Pyramidal Horn',
        badge: 'HORN',
        glyph: 'Mountain',
        desc: 'Glacially carved Matterhorn peak with radial arêtes & cirque scoops',
        defaultCombine: 'smooth_union',
        defaultRadius: 340,
        defaultLength: 340,
        defaultHeight: 225,
        defaultAspect: 1.0,
        hasLength: false,
        hasVolumetric3D: false,
        defaultParams: {
            slopeCurve: 1.38,
            ridgeCount: 4,
            ridgeSharpness: 0.68,
            ridgeTwist: 0.28,
            cirqueDepth: 0.34,
            summitFlatness: 0.04
        },
        controls: [
            { key: 'slopeCurve',     label: 'Slope Concavity (γ)',     min: 0.45, max: 2.40, step: 0.02, dec: 2, unit: 'γ' },
            { key: 'ridgeCount',     label: 'Radial Arête Ridges',     min: 3,    max: 9,    step: 1,    dec: 0, unit: 'N' },
            { key: 'ridgeSharpness', label: 'Arête Crest Sharpness',   min: 0.0,  max: 1.0,  step: 0.02, dec: 2, unit: 'w' },
            { key: 'ridgeTwist',     label: 'Spur Torsion Twist',      min: -1.5, max: 1.5,  step: 0.04, dec: 2, unit: 'rad' },
            { key: 'cirqueDepth',    label: 'Glacial Cirque Scoop',    min: 0.0,  max: 0.72, step: 0.02, dec: 2, unit: 'w' },
            { key: 'summitFlatness', label: 'Summit Truncation',       min: 0.0,  max: 0.55, step: 0.02, dec: 2, unit: 'w' }
        ]
    },
    {
        id: 'stratovolcano',
        family: 'peaks',
        name: 'Stratovolcano + Caldera',
        badge: 'VOLCANO',
        glyph: 'Volcano',
        desc: 'Concave volcanic cone with summit caldera rim, resurgent dome & breach',
        defaultCombine: 'smooth_union',
        defaultRadius: 420,
        defaultLength: 420,
        defaultHeight: 245,
        defaultAspect: 1.0,
        hasLength: false,
        hasVolumetric3D: false,
        defaultParams: {
            slopeCurve: 1.55,
            craterRadius: 0.25,
            craterDepth: 0.44,
            rimLipBoost: 0.14,
            resurgentDome: 0.16,
            ridgeCount: 10,
            ridgeSharpness: 0.28,
            breachDepth: 0.0
        },
        controls: [
            { key: 'slopeCurve',     label: 'Cone Flank Concavity',    min: 0.75, max: 2.60, step: 0.02, dec: 2, unit: 'γ' },
            { key: 'craterRadius',   label: 'Caldera Rim Radius',      min: 0.08, max: 0.56, step: 0.01, dec: 2, unit: 'r' },
            { key: 'craterDepth',    label: 'Caldera Bowl Depth',      min: 0.04, max: 0.92, step: 0.02, dec: 2, unit: 'w' },
            { key: 'rimLipBoost',    label: 'Rim Lip Crest Boost',     min: 0.0,  max: 0.36, step: 0.01, dec: 2, unit: 'w' },
            { key: 'resurgentDome',  label: 'Central Resurgent Dome',  min: 0.0,  max: 0.65, step: 0.02, dec: 2, unit: 'w' },
            { key: 'ridgeCount',     label: 'Radial Lahar Ravines',    min: 4,    max: 18,   step: 1,    dec: 0, unit: 'N' },
            { key: 'ridgeSharpness', label: 'Ravine Flute Depth',      min: 0.0,  max: 0.80, step: 0.02, dec: 2, unit: 'w' },
            { key: 'breachDepth',    label: 'Rim Breach Spillway',     min: 0.0,  max: 0.90, step: 0.02, dec: 2, unit: 'w' }
        ]
    },
    {
        id: 'shield_volcano',
        family: 'peaks',
        name: 'Shield Volcano & Lava Apron',
        badge: 'SHIELD',
        glyph: 'Volcano',
        desc: 'Broad convex basaltic shield with summit pit caldera & stepped lava lobes',
        defaultCombine: 'smooth_union',
        defaultRadius: 520,
        defaultLength: 520,
        defaultHeight: 145,
        defaultAspect: 1.08,
        hasLength: false,
        hasVolumetric3D: false,
        defaultParams: {
            slopeCurve: 0.62,
            craterRadius: 0.15,
            craterDepth: 0.26,
            ridgeCount: 6,
            terraceSteps: 4,
            terraceStrength: 0.36
        },
        controls: [
            { key: 'slopeCurve',      label: 'Shield Convexity',       min: 0.35, max: 1.45, step: 0.02, dec: 2, unit: 'γ' },
            { key: 'craterRadius',    label: 'Summit Pit Radius',      min: 0.04, max: 0.38, step: 0.01, dec: 2, unit: 'r' },
            { key: 'craterDepth',     label: 'Pit Collapse Depth',     min: 0.0,  max: 0.70, step: 0.02, dec: 2, unit: 'w' },
            { key: 'ridgeCount',      label: 'Basalt Lava Lobes',      min: 3,    max: 12,   step: 1,    dec: 0, unit: 'N' },
            { key: 'terraceSteps',    label: 'Lava Flow Benches',      min: 0,    max: 10,   step: 1,    dec: 0, unit: 'st' },
            { key: 'terraceStrength', label: 'Bench Step Crispness',   min: 0.0,  max: 0.90, step: 0.02, dec: 2, unit: 'w' }
        ]
    },
    {
        id: 'granite_dome',
        family: 'peaks',
        name: 'Granite Batholith / Half-Dome',
        badge: 'DOME',
        glyph: 'Mountain',
        desc: 'Exfoliation monolith dome with optional sheer glacial cliff face (Half Dome)',
        defaultCombine: 'smooth_union',
        defaultRadius: 320,
        defaultLength: 320,
        defaultHeight: 195,
        defaultAspect: 1.22,
        hasLength: false,
        hasVolumetric3D: false,
        defaultParams: {
            slopeCurve: 0.56,
            shearStrength: 0.52,
            shearSteepness: 0.84,
            terraceSteps: 3,
            terraceStrength: 0.28
        },
        controls: [
            { key: 'slopeCurve',      label: 'Batholith Dome Curve',   min: 0.32, max: 1.30, step: 0.02, dec: 2, unit: 'γ' },
            { key: 'shearStrength',   label: 'Half-Dome Cliff Shear',  min: 0.0,  max: 0.92, step: 0.02, dec: 2, unit: 'w' },
            { key: 'shearSteepness',  label: 'Shear Wall Verticality', min: 0.20, max: 0.98, step: 0.02, dec: 2, unit: 'w' },
            { key: 'terraceSteps',    label: 'Exfoliation Apron Tiers',min: 0,    max: 8,    step: 1,    dec: 0, unit: 'st' },
            { key: 'terraceStrength', label: 'Exfoliation Step Depth', min: 0.0,  max: 0.85, step: 0.02, dec: 2, unit: 'w' }
        ]
    },

    // =========================================================================
    // FAMILY 2: PLATEAUS, MESAS, BUTTES & ESCARPMENTS
    // =========================================================================
    {
        id: 'mesa_plateau',
        family: 'plateaus',
        name: 'Flat-Topped Mesa / Tepui',
        badge: 'MESA',
        glyph: 'Mesa',
        desc: 'Superellipse caprock plateau with vertical rim cliff, 34° talus & strata',
        defaultCombine: 'smooth_union',
        defaultRadius: 360,
        defaultLength: 360,
        defaultHeight: 155,
        defaultAspect: 1.28,
        hasLength: false,
        hasVolumetric3D: false,
        defaultParams: {
            footprintRoundness: 3.0,
            lobing: 0.24,
            cliffSteepness: 0.86,
            talusRatio: 0.34,
            terraceSteps: 5,
            terraceStrength: 0.56,
            dipDeg: 1.5
        },
        controls: [
            { key: 'footprintRoundness', label: 'Footprint Squaring',   min: 1.6,  max: 6.0,  step: 0.1,  dec: 1, unit: 'q' },
            { key: 'lobing',             label: 'Rim Headland Lobing',  min: 0.0,  max: 0.62, step: 0.02, dec: 2, unit: 'w' },
            { key: 'cliffSteepness',     label: 'Caprock Cliff Angle',  min: 0.30, max: 0.98, step: 0.02, dec: 2, unit: 'w' },
            { key: 'talusRatio',         label: 'Talus Scree Apron',    min: 0.06, max: 0.64, step: 0.02, dec: 2, unit: 'r' },
            { key: 'terraceSteps',       label: 'Strata Ledge Count',   min: 0,    max: 12,   step: 1,    dec: 0, unit: 'st' },
            { key: 'terraceStrength',    label: 'Strata Step Crispness',min: 0.0,  max: 0.95, step: 0.02, dec: 2, unit: 'w' },
            { key: 'dipDeg',             label: 'Caprock Dip Tilt',     min: -14,  max: 14,   step: 0.5,  dec: 1, unit: '°' }
        ]
    },
    {
        id: 'stepped_butte',
        family: 'plateaus',
        name: 'Stepped Monument Butte',
        badge: 'BUTTE',
        glyph: 'Mesa',
        desc: 'Narrow fluted Grand-Canyon tower over wide stepped sandstone talus skirt',
        defaultCombine: 'smooth_union',
        defaultRadius: 270,
        defaultLength: 270,
        defaultHeight: 185,
        defaultAspect: 1.12,
        hasLength: false,
        hasVolumetric3D: false,
        defaultParams: {
            crownRatio: 0.28,
            terraceSteps: 6,
            terraceStrength: 0.78,
            cliffSteepness: 0.88,
            ridgeCount: 7,
            ridgeSharpness: 0.42
        },
        controls: [
            { key: 'crownRatio',      label: 'Summit Crown Ratio',     min: 0.12, max: 0.58, step: 0.02, dec: 2, unit: 'r' },
            { key: 'terraceSteps',    label: 'Sandstone Bench Tiers',  min: 2,    max: 12,   step: 1,    dec: 0, unit: 'st' },
            { key: 'terraceStrength', label: 'Bench Ledge Sharpness',  min: 0.15, max: 0.98, step: 0.02, dec: 2, unit: 'w' },
            { key: 'cliffSteepness',  label: 'Tower Cliff Verticality',min: 0.35, max: 0.98, step: 0.02, dec: 2, unit: 'w' },
            { key: 'ridgeCount',      label: 'Vertical Cliff Ribs',    min: 3,    max: 12,   step: 1,    dec: 0, unit: 'N' },
            { key: 'ridgeSharpness',  label: 'Buttress Rib Depth',     min: 0.0,  max: 0.85, step: 0.02, dec: 2, unit: 'w' }
        ]
    },
    {
        id: 'tilted_cuesta',
        family: 'plateaus',
        name: 'Tilted Cuesta / Escarpment',
        badge: 'CUESTA',
        glyph: 'Mesa',
        desc: 'Asymmetric gentle structural dip-slope meeting a sheared escarpment cliff',
        defaultCombine: 'smooth_union',
        defaultRadius: 260,
        defaultLength: 740,
        defaultHeight: 145,
        defaultAspect: 1.0,
        hasLength: true,
        hasVolumetric3D: false,
        defaultParams: {
            dipSlopeRatio: 0.72,
            cliffSteepness: 0.88,
            lobing: 0.22,
            terraceSteps: 4,
            terraceStrength: 0.48,
            strikeBow: 0.12
        },
        controls: [
            { key: 'dipSlopeRatio',   label: 'Dip-Slope Asymmetry',    min: 0.25, max: 0.86, step: 0.02, dec: 2, unit: 'r' },
            { key: 'cliffSteepness',  label: 'Scarp Face Steepness',   min: 0.30, max: 0.98, step: 0.02, dec: 2, unit: 'w' },
            { key: 'lobing',          label: 'Escarpment Rim Sinous',  min: 0.0,  max: 0.55, step: 0.02, dec: 2, unit: 'w' },
            { key: 'terraceSteps',    label: 'Exposed Strata Beds',    min: 0,    max: 10,   step: 1,    dec: 0, unit: 'st' },
            { key: 'terraceStrength', label: 'Strata Bench Strength',  min: 0.0,  max: 0.92, step: 0.02, dec: 2, unit: 'w' },
            { key: 'strikeBow',       label: 'Strike Arc Curvature',   min: -0.5, max: 0.5,  step: 0.02, dec: 2, unit: 'b' }
        ]
    },

    // =========================================================================
    // FAMILY 3: VALLEYS, CANYONS, FJORDS & GRABENS
    // =========================================================================
    {
        id: 'v_gorge',
        family: 'valleys',
        name: 'V-Shaped Fluvial Gorge',
        badge: 'GORGE',
        glyph: 'Canyon',
        desc: 'Meandering river-incised V-valley with cut-bank asymmetry & thalweg bed',
        defaultCombine: 'smooth_sub',
        defaultRadius: 155,
        defaultLength: 780,
        defaultHeight: 92,
        defaultAspect: 1.0,
        hasLength: true,
        hasVolumetric3D: false,
        defaultParams: {
            meanderAmp: 0.32,
            meanderFreq: 1.4,
            wallSlope: 1.05,
            floorRatio: 0.12,
            asymmetry: 0.18,
            longitudinalTilt: 0.16
        },
        controls: [
            { key: 'meanderAmp',       label: 'Meander Amplitude',      min: 0.0,  max: 0.95, step: 0.02, dec: 2, unit: 'w' },
            { key: 'meanderFreq',      label: 'Meander Bends',          min: 0.5,  max: 4.0,  step: 0.1,  dec: 1, unit: '×' },
            { key: 'wallSlope',        label: 'V-Wall Profile Curve',   min: 0.40, max: 2.40, step: 0.04, dec: 2, unit: 'γ' },
            { key: 'floorRatio',       label: 'Stream Thalweg Width',   min: 0.02, max: 0.45, step: 0.02, dec: 2, unit: 'r' },
            { key: 'asymmetry',        label: 'Cut-Bank Asymmetry',     min: -0.7, max: 0.7,  step: 0.02, dec: 2, unit: 'a' },
            { key: 'longitudinalTilt', label: 'Downstream Depth Tilt',  min: -0.6, max: 0.6,  step: 0.02, dec: 2, unit: 's' }
        ]
    },
    {
        id: 'u_glacial_valley',
        family: 'valleys',
        name: 'U-Shaped Glacial Fjord',
        badge: 'FJORD',
        glyph: 'Canyon',
        desc: 'Wide parabolic glacial trough with steep trimline walls & cirque headwall',
        defaultCombine: 'smooth_sub',
        defaultRadius: 195,
        defaultLength: 840,
        defaultHeight: 115,
        defaultAspect: 1.0,
        hasLength: true,
        hasVolumetric3D: false,
        defaultParams: {
            meanderAmp: 0.16,
            meanderFreq: 1.0,
            floorRatio: 0.42,
            wallExponent: 3.2,
            shoulderHeight: 0.14,
            headwallSteepness: 0.72
        },
        controls: [
            { key: 'meanderAmp',        label: 'Trough Curvature',       min: 0.0,  max: 0.65, step: 0.02, dec: 2, unit: 'w' },
            { key: 'meanderFreq',       label: 'Valley Sinuosity',       min: 0.4,  max: 3.0,  step: 0.1,  dec: 1, unit: '×' },
            { key: 'floorRatio',        label: 'Glacial Floor Width',    min: 0.16, max: 0.68, step: 0.02, dec: 2, unit: 'r' },
            { key: 'wallExponent',      label: 'U-Wall Steepness',       min: 1.5,  max: 5.5,  step: 0.1,  dec: 1, unit: 'p' },
            { key: 'shoulderHeight',    label: 'Trimline Bench Shelf',   min: 0.0,  max: 0.38, step: 0.02, dec: 2, unit: 'w' },
            { key: 'headwallSteepness', label: 'Cirque Headwall Steep',  min: 0.15, max: 0.96, step: 0.02, dec: 2, unit: 'w' }
        ]
    },
    {
        id: 'slot_canyon',
        family: 'valleys',
        name: 'Slot Canyon (3D Overhang)',
        badge: '3D SLOT',
        glyph: 'Canyon',
        desc: 'Sinuous sandstone slot gorge with TRUE 3D SDF undercut overhang alcoves',
        defaultCombine: 'sub',
        defaultRadius: 95,
        defaultLength: 620,
        defaultHeight: 96,
        defaultAspect: 1.0,
        hasLength: true,
        hasVolumetric3D: true,
        defaultParams: {
            meanderAmp: 0.56,
            meanderFreq: 2.6,
            floorRatio: 0.18,
            cliffSteepness: 0.92,
            overhangAmount: 0.68,
            waveFlutes: 3
        },
        controls: [
            { key: 'meanderAmp',     label: 'Slot Sinuosity Amp',     min: 0.08, max: 1.20, step: 0.02, dec: 2, unit: 'w' },
            { key: 'meanderFreq',    label: 'Slot Bend Frequency',    min: 0.8,  max: 5.5,  step: 0.1,  dec: 1, unit: '×' },
            { key: 'floorRatio',     label: 'Canyon Floor Width',     min: 0.06, max: 0.36, step: 0.02, dec: 2, unit: 'r' },
            { key: 'cliffSteepness', label: 'Rim Sheer Steepness',    min: 0.45, max: 0.99, step: 0.01, dec: 2, unit: 'w' },
            { key: 'overhangAmount', label: '3D Overhang Undercut',   min: 0.0,  max: 1.0,  step: 0.02, dec: 2, unit: '3D' },
            { key: 'waveFlutes',     label: '3D Wall Wave Flutes',    min: 1,    max: 6,    step: 1,    dec: 0, unit: 'N' }
        ]
    },
    {
        id: 'rift_graben',
        family: 'valleys',
        name: 'Tectonic Rift Graben',
        badge: 'RIFT',
        glyph: 'Fault',
        desc: 'Sunken flat rift floor flanked by stepped fault scarps & uplifted horst rims',
        defaultCombine: 'add', // Bipolar: lowers rift center AND uplifts flanking horsts!
        defaultRadius: 260,
        defaultLength: 880,
        defaultHeight: 95,
        defaultAspect: 1.0,
        hasLength: true,
        hasVolumetric3D: false,
        defaultParams: {
            floorRatio: 0.42,
            cliffSteepness: 0.85,
            terraceSteps: 3,
            rimLipBoost: 0.34,
            strikeBow: 0.08
        },
        controls: [
            { key: 'floorRatio',     label: 'Rift Floor Width',       min: 0.18, max: 0.66, step: 0.02, dec: 2, unit: 'r' },
            { key: 'cliffSteepness', label: 'Fault Scarp Steepness',  min: 0.35, max: 0.98, step: 0.02, dec: 2, unit: 'w' },
            { key: 'terraceSteps',   label: 'Normal-Fault Steps',     min: 1,    max: 6,    step: 1,    dec: 0, unit: 'st' },
            { key: 'rimLipBoost',    label: 'Flanking Horst Uplift',  min: 0.0,  max: 0.65, step: 0.02, dec: 2, unit: 'w' },
            { key: 'strikeBow',      label: 'Rift Trace Curvature',   min: -0.5, max: 0.5,  step: 0.02, dec: 2, unit: 'b' }
        ]
    },
    {
        id: 'cliff_pathway',
        family: 'valleys',
        name: 'Cliffside Switchback Pathway (3D)',
        badge: '3D TRAIL',
        glyph: 'Spline',
        desc: 'Real-scale mountain/cliff switchback ledge with retaining embankment & 3D rock gallery overhang',
        defaultCombine: 'smooth_union',
        defaultRadius: 16,
        defaultLength: 420,
        defaultHeight: 58,
        defaultAspect: 1.0,
        hasLength: true,
        hasVolumetric3D: true,
        defaultParams: {
            influenceScale: 1.35,
            switchbacks: 2,
            bendAmplitude: 0.42,
            cliffGallery: 0.74,
            retainingSteepness: 0.78,
            gradeRise: 0.65
        },
        controls: [
            { key: 'influenceScale',     label: 'Influence Scale (Shoulder)', min: 0.30, max: 3.50, step: 0.05, dec: 2, unit: '×' },
            { key: 'switchbacks',        label: 'Switchback Hairpins',        min: 0,    max: 4,    step: 1,    dec: 0, unit: 'N' },
            { key: 'bendAmplitude',      label: 'Switchback Sweep',           min: 0.0,  max: 0.95, step: 0.02, dec: 2, unit: 'w' },
            { key: 'cliffGallery',       label: '3D Cliff Overhang Gallery',  min: 0.0,  max: 1.0,  step: 0.02, dec: 2, unit: '3D' },
            { key: 'retainingSteepness', label: 'Outer Retaining Steepness',  min: 0.25, max: 0.98, step: 0.02, dec: 2, unit: 'w' },
            { key: 'gradeRise',          label: 'Longitudinal Climb Grade',   min: -1.0, max: 1.0,  step: 0.02, dec: 2, unit: 'g' }
        ]
    },

    // =========================================================================
    // FAMILY 4: LINEAR RIDGES, FAULT SCARPS & FOLD BELTS
    // =========================================================================
    {
        id: 'fault_scarp',
        family: 'ridges',
        name: 'Tectonic Fault Scarp',
        badge: 'FAULT',
        glyph: 'Fault',
        desc: 'Thrust / normal fault cliff with rollover crest & triangular faceted spurs',
        defaultCombine: 'add',
        defaultRadius: 270,
        defaultLength: 860,
        defaultHeight: 140,
        defaultAspect: 1.0,
        hasLength: true,
        hasVolumetric3D: false,
        defaultParams: {
            cliffSteepness: 0.88,
            rolloverAmp: 0.22,
            ridgeCount: 8,
            ridgeSharpness: 0.42,
            strikeBow: 0.08
        },
        controls: [
            { key: 'cliffSteepness', label: 'Fault Plane Steepness',  min: 0.35, max: 0.98, step: 0.02, dec: 2, unit: 'w' },
            { key: 'rolloverAmp',    label: 'Hanging-Wall Rollover',  min: 0.0,  max: 0.48, step: 0.02, dec: 2, unit: 'w' },
            { key: 'ridgeCount',     label: 'Triangular Spur Facets', min: 3,    max: 16,   step: 1,    dec: 0, unit: 'N' },
            { key: 'ridgeSharpness', label: 'Facet Ravine Depth',     min: 0.0,  max: 0.85, step: 0.02, dec: 2, unit: 'w' },
            { key: 'strikeBow',      label: 'Fault Line Bow',         min: -0.5, max: 0.5,  step: 0.02, dec: 2, unit: 'b' }
        ]
    },
    {
        id: 'fold_belt',
        family: 'ridges',
        name: 'Anticline / Syncline Fold Belt',
        badge: 'FOLDS',
        glyph: 'Activity',
        desc: 'Parallel folded strata wave train (Appalachian / Zagros) with breached crests',
        defaultCombine: 'smooth_union',
        defaultRadius: 340,
        defaultLength: 920,
        defaultHeight: 135,
        defaultAspect: 1.0,
        hasLength: true,
        hasVolumetric3D: false,
        defaultParams: {
            foldCount: 3.5,
            foldAsymmetry: 0.36,
            breachDepth: 0.22,
            strikeBow: 0.18,
            crestSharpness: 0.58
        },
        controls: [
            { key: 'foldCount',      label: 'Fold Wave Cycles',       min: 1.5,  max: 8.0,  step: 0.25, dec: 2, unit: 'N' },
            { key: 'foldAsymmetry',  label: 'Fold Overturn Skew',     min: -0.85,max: 0.85, step: 0.02, dec: 2, unit: 'a' },
            { key: 'breachDepth',    label: 'Breached Crest Valley',  min: 0.0,  max: 0.78, step: 0.02, dec: 2, unit: 'w' },
            { key: 'strikeBow',      label: 'Belt Strike Arc',        min: -0.6, max: 0.6,  step: 0.02, dec: 2, unit: 'b' },
            { key: 'crestSharpness', label: 'Anticline Crest Crisp',  min: 0.10, max: 1.0,  step: 0.02, dec: 2, unit: 'w' }
        ]
    },
    {
        id: 'hogback_arete',
        family: 'ridges',
        name: 'Knife-Edge Arête / Hogback',
        badge: 'ARÊTE',
        glyph: 'LinearDike',
        desc: 'Razor-crested linear mountain spine with sculpted col saddles & lateral ribs',
        defaultCombine: 'smooth_union',
        defaultRadius: 210,
        defaultLength: 820,
        defaultHeight: 185,
        defaultAspect: 1.0,
        hasLength: true,
        hasVolumetric3D: false,
        defaultParams: {
            crestSharpness: 0.82,
            asymmetry: 0.32,
            strikeBow: 0.16,
            ridgeCount: 5,
            colDepth: 0.28,
            spurStrength: 0.44
        },
        controls: [
            { key: 'crestSharpness', label: 'Knife-Edge Sharpness',   min: 0.18, max: 1.0,  step: 0.02, dec: 2, unit: 'w' },
            { key: 'asymmetry',      label: 'Hogback Dip Asymmetry',  min: -0.75,max: 0.75, step: 0.02, dec: 2, unit: 'a' },
            { key: 'strikeBow',      label: 'Spine Curvature',        min: -0.6, max: 0.6,  step: 0.02, dec: 2, unit: 'b' },
            { key: 'ridgeCount',     label: 'Summit Peaks Along Ridge',min: 2,   max: 12,   step: 1,    dec: 0, unit: 'N' },
            { key: 'colDepth',       label: 'Col Saddle Dip',         min: 0.0,  max: 0.68, step: 0.02, dec: 2, unit: 'w' },
            { key: 'spurStrength',   label: 'Lateral Buttress Ribs',  min: 0.0,  max: 0.82, step: 0.02, dec: 2, unit: 'w' }
        ]
    },

    // =========================================================================
    // FAMILY 5: AEOLIAN, KARST & IMPACT FORMS
    // =========================================================================
    {
        id: 'barchan_dune',
        family: 'aeolian_karst',
        name: 'Crescent Barchan Dune',
        badge: 'DUNE',
        glyph: 'Dune',
        desc: 'Wind-sculpted 12° stoss slope, sharp crest, 34° slipface & swept crescent horns',
        defaultCombine: 'smooth_union',
        defaultRadius: 240,
        defaultLength: 240,
        defaultHeight: 58,
        defaultAspect: 1.15,
        hasLength: false,
        hasVolumetric3D: false,
        defaultParams: {
            slipfaceSteepness: 0.86,
            crestSharpness: 0.82,
            hornLength: 0.72,
            hornCurvature: 0.66,
            duneWaves: 1
        },
        controls: [
            { key: 'slipfaceSteepness', label: 'Leeward 34° Slipface',  min: 0.32, max: 0.98, step: 0.02, dec: 2, unit: 'w' },
            { key: 'crestSharpness',    label: 'Sand Crest Razor',      min: 0.20, max: 1.0,  step: 0.02, dec: 2, unit: 'w' },
            { key: 'hornLength',        label: 'Crescent Horn Reach',   min: 0.08, max: 1.20, step: 0.02, dec: 2, unit: 'r' },
            { key: 'hornCurvature',     label: 'Horn Sweep Curvature',  min: 0.10, max: 1.0,  step: 0.02, dec: 2, unit: 'w' },
            { key: 'duneWaves',         label: 'Transverse Dune Waves', min: 1,    max: 5,    step: 1,    dec: 0, unit: 'N' }
        ]
    },
    {
        id: 'star_dune',
        family: 'aeolian_karst',
        name: 'Multi-Arm Star Dune',
        badge: 'STAR DUNE',
        glyph: 'Dune',
        desc: 'Towering Namib/Sahara pyramidal erg dune with sinuous radiating razor arms',
        defaultCombine: 'smooth_union',
        defaultRadius: 290,
        defaultLength: 290,
        defaultHeight: 88,
        defaultAspect: 1.0,
        hasLength: false,
        hasVolumetric3D: false,
        defaultParams: {
            armCount: 5,
            armTwist: 0.48,
            slipfaceSteepness: 0.84,
            crestSharpness: 0.86,
            armSpan: 0.82
        },
        controls: [
            { key: 'armCount',          label: 'Radiating Sand Arms',   min: 3,    max: 7,    step: 1,    dec: 0, unit: 'N' },
            { key: 'armTwist',          label: 'Arm Sinuous Twist',     min: -1.4, max: 1.4,  step: 0.04, dec: 2, unit: 'rad' },
            { key: 'slipfaceSteepness', label: 'Arm Slipface Angle',    min: 0.30, max: 0.98, step: 0.02, dec: 2, unit: 'w' },
            { key: 'crestSharpness',    label: 'Arm Ridge Sharpness',   min: 0.25, max: 1.0,  step: 0.02, dec: 2, unit: 'w' },
            { key: 'armSpan',           label: 'Arm Radial Reach',      min: 0.38, max: 1.0,  step: 0.02, dec: 2, unit: 'r' }
        ]
    },
    {
        id: 'impact_crater',
        family: 'aeolian_karst',
        name: 'Impact / Maar Crater',
        badge: 'CRATER',
        glyph: 'Atoll',
        desc: 'Excavated parabolic bowl, upturned ejecta rim, central peak & ejecta rays',
        defaultCombine: 'add', // Bipolar: carves bowl AND uplifts rim + ejecta!
        defaultRadius: 340,
        defaultLength: 340,
        defaultHeight: 115,
        defaultAspect: 1.0,
        hasLength: false,
        hasVolumetric3D: false,
        defaultParams: {
            craterRadius: 0.52,
            craterDepth: 0.72,
            rimHeight: 0.42,
            centralPeak: 0.28,
            terraceSteps: 2,
            ejectaRays: 0.36
        },
        controls: [
            { key: 'craterRadius', label: 'Rim-to-Ejecta Ratio',    min: 0.24, max: 0.74, step: 0.02, dec: 2, unit: 'r' },
            { key: 'craterDepth',  label: 'Excavation Bowl Depth',  min: 0.15, max: 1.0,  step: 0.02, dec: 2, unit: 'w' },
            { key: 'rimHeight',    label: 'Upturned Rim Height',    min: 0.08, max: 0.85, step: 0.02, dec: 2, unit: 'w' },
            { key: 'centralPeak',  label: 'Central Rebound Peak',   min: 0.0,  max: 0.78, step: 0.02, dec: 2, unit: 'w' },
            { key: 'terraceSteps', label: 'Inner Slump Rings',      min: 0,    max: 6,    step: 1,    dec: 0, unit: 'st' },
            { key: 'ejectaRays',   label: 'Radial Ejecta Blanket',  min: 0.0,  max: 1.0,  step: 0.02, dec: 2, unit: 'w' }
        ]
    },
    {
        id: 'karst_cenote',
        family: 'aeolian_karst',
        name: 'Karst Cenote (3D Overhang)',
        badge: '3D CENOTE',
        glyph: 'Atoll',
        desc: 'Collapsed limestone sinkhole shaft with TRUE 3D SDF overhanging roof lip',
        defaultCombine: 'sub',
        defaultRadius: 195,
        defaultLength: 195,
        defaultHeight: 92,
        defaultAspect: 1.06,
        hasLength: false,
        hasVolumetric3D: true,
        defaultParams: {
            shaftRadius: 0.48,
            funnelSlope: 0.34,
            cliffSteepness: 0.92,
            overhangAmount: 0.70,
            lobing: 0.18
        },
        controls: [
            { key: 'shaftRadius',    label: 'Shaft Opening Ratio',    min: 0.20, max: 0.74, step: 0.02, dec: 2, unit: 'r' },
            { key: 'funnelSlope',    label: 'Outer Doline Funnel',    min: 0.05, max: 0.88, step: 0.02, dec: 2, unit: 'w' },
            { key: 'cliffSteepness', label: 'Limestone Rim Drop',     min: 0.45, max: 0.99, step: 0.01, dec: 2, unit: 'w' },
            { key: 'overhangAmount', label: '3D Overhanging Roof',    min: 0.0,  max: 1.0,  step: 0.02, dec: 2, unit: '3D' },
            { key: 'lobing',         label: 'Karst Rim Lobing',       min: 0.0,  max: 0.45, step: 0.02, dec: 2, unit: 'w' }
        ]
    },
    {
        id: 'cave_cavern',
        family: 'aeolian_karst',
        name: 'Natural 3D Cave & Cavern',
        badge: '3D CAVE',
        glyph: 'Arch',
        desc: 'True-3D subterranean cave portal, winding limestone passage, vaulted chamber & walkable floor',
        defaultCombine: 'sub',
        defaultRadius: 24,
        defaultLength: 160,
        defaultHeight: 24,
        defaultAspect: 1.0,
        hasLength: true,
        hasVolumetric3D: true,
        defaultParams: {
            portalWidth: 0.78,
            chamberSwell: 0.62,
            caveRoughness: 0.48,
            floorFlatness: 0.78,
            passageCurve: 0.32,
            mouthApron: 0.45
        },
        controls: [
            { key: 'portalWidth',   label: 'Cave Mouth Width Ratio',  min: 0.35, max: 1.35, step: 0.02, dec: 2, unit: 'r' },
            { key: 'chamberSwell',  label: 'Interior Vault Swell',    min: 0.0,  max: 1.40, step: 0.02, dec: 2, unit: 'w' },
            { key: 'caveRoughness', label: '3D Wall & Roof Crags',    min: 0.0,  max: 1.0,  step: 0.02, dec: 2, unit: '3D' },
            { key: 'floorFlatness', label: 'Walkable Floor Flatness', min: 0.15, max: 1.0,  step: 0.02, dec: 2, unit: 'w' },
            { key: 'passageCurve',  label: 'Passage Winding S-Bend',  min: -0.85,max: 0.85, step: 0.02, dec: 2, unit: 'b' },
            { key: 'mouthApron',    label: 'Exterior Mouth Approach', min: 0.0,  max: 1.0,  step: 0.02, dec: 2, unit: 'w' }
        ]
    },

    // =========================================================================
    // FAMILY 6: COASTAL & ISLAND FORMS
    // =========================================================================
    {
        id: 'atoll_lagoon',
        family: 'coastal',
        name: 'Atoll Ring & Lagoon',
        badge: 'ATOLL',
        glyph: 'Atoll',
        desc: 'Annular reef/volcanic island ring with sheltered lagoon & navigable pass',
        defaultCombine: 'add', // Bipolar: uplifts reef ring AND carves lagoon basin!
        defaultRadius: 440,
        defaultLength: 440,
        defaultHeight: 72,
        defaultAspect: 1.06,
        hasLength: false,
        hasVolumetric3D: false,
        defaultParams: {
            ringRadius: 0.66,
            ringWidth: 0.24,
            lagoonDepth: 0.38,
            breachDepth: 0.72,
            breachWidth: 0.24,
            ridgeCount: 6
        },
        controls: [
            { key: 'ringRadius',  label: 'Reef Ring Radius',       min: 0.35, max: 0.82, step: 0.02, dec: 2, unit: 'r' },
            { key: 'ringWidth',   label: 'Island Rim Thickness',   min: 0.10, max: 0.46, step: 0.02, dec: 2, unit: 'r' },
            { key: 'lagoonDepth', label: 'Lagoon Floor Depth',     min: 0.0,  max: 0.85, step: 0.02, dec: 2, unit: 'w' },
            { key: 'breachDepth', label: 'Reef Pass Channel Cut',  min: 0.0,  max: 1.0,  step: 0.02, dec: 2, unit: 'w' },
            { key: 'breachWidth', label: 'Channel Pass Width',     min: 0.08, max: 0.62, step: 0.02, dec: 2, unit: 'rad' },
            { key: 'ridgeCount',  label: 'Motu Islet Segments',    min: 3,    max: 12,   step: 1,    dec: 0, unit: 'N' }
        ]
    },
    {
        id: 'sea_cliff_headland',
        family: 'coastal',
        name: 'Sea-Cliff Headland (3D Notch)',
        badge: '3D CLIFF',
        glyph: 'Mesa',
        desc: 'Rocky promontory with wave-cut platform & TRUE 3D SDF basal wave notch',
        defaultCombine: 'smooth_union',
        defaultRadius: 235,
        defaultLength: 560,
        defaultHeight: 138,
        defaultAspect: 1.0,
        hasLength: true,
        hasVolumetric3D: true,
        defaultParams: {
            cliffSteepness: 0.92,
            platformWidth: 0.28,
            platformHeight: 0.11,
            overhangAmount: 0.66,
            lobing: 0.22,
            terraceSteps: 4
        },
        controls: [
            { key: 'cliffSteepness', label: 'Headland Cliff Sheer',   min: 0.45, max: 0.99, step: 0.01, dec: 2, unit: 'w' },
            { key: 'platformWidth',  label: 'Wave-Cut Bench Width',   min: 0.08, max: 0.54, step: 0.02, dec: 2, unit: 'r' },
            { key: 'platformHeight', label: 'Abrasion Bench Elev',    min: 0.02, max: 0.28, step: 0.01, dec: 2, unit: 'w' },
            { key: 'overhangAmount', label: '3D Basal Wave Notch',    min: 0.0,  max: 1.0,  step: 0.02, dec: 2, unit: '3D' },
            { key: 'lobing',         label: 'Headland Promontory',    min: 0.0,  max: 0.50, step: 0.02, dec: 2, unit: 'w' },
            { key: 'terraceSteps',   label: 'Cliff Strata Benches',   min: 0,    max: 8,    step: 1,    dec: 0, unit: 'st' }
        ]
    }
];

const LANDFORM_BY_ID = new Map(LANDFORM_CATALOG.map(Item => [Item.id, Item]));

export function GetLandformSpec(ArchetypeId)
{
    return LANDFORM_BY_ID.get(ArchetypeId) || LANDFORM_CATALOG[0];
}

export function GetLandformFamily(FamilyId)
{
    return LANDFORM_FAMILIES.find(F => F.id === FamilyId) || LANDFORM_FAMILIES[0];
}

/**
 * Factory for a composable `'landform'` layer inside `Region.stack`.
 */
export function CreateLandformLayer(ArchetypeId = 'stratovolcano', Overrides = {})
{
    const Spec = GetLandformSpec(ArchetypeId);
    const Params = { ...Spec.defaultParams, ...(Overrides.params || {}) };
    return {
        id: Overrides.id || MakeTerrainUid('lf'),
        type: 'landform',
        archetype: Spec.id,
        name: Overrides.name || Spec.name,
        enabled: Overrides.enabled !== false,
        opacity: Overrides.opacity ?? 1.0,
        combine: Overrides.combine || Spec.defaultCombine || 'smooth_union',
        smoothK: Overrides.smoothK ?? 26.0,
        seed: Overrides.seed ?? 4029,
        // Placement generator mode: 'single' | 'range' | 'cluster' | 'field'
        placementMode: Overrides.placementMode || 'single',
        instanceCount: Overrides.instanceCount ?? 5,
        spread: Overrides.spread ?? 680.0,
        rangeCurvature: Overrides.rangeCurvature ?? 0.22,
        scaleTaper: Overrides.scaleTaper ?? 0.42,
        jitter: Overrides.jitter ?? 0.32,
        // Core 3D Gizmo transform & footprint
        centerX: Overrides.centerX ?? 0.0,
        centerZ: Overrides.centerZ ?? 0.0,
        radius: Overrides.radius ?? Spec.defaultRadius,
        length: Overrides.length ?? Spec.defaultLength,
        height: Overrides.height ?? Spec.defaultHeight,
        azimuth: Overrides.azimuth ?? 28.0,
        aspectRatio: Overrides.aspectRatio ?? Spec.defaultAspect,
        rockDetail: Overrides.rockDetail ?? 0.24,
        params: Params,
        falloff: {
            mode: Overrides.falloff?.mode ?? 'none',
            distance: Overrides.falloff?.distance ?? 220.0,
            edgeFloor: Overrides.falloff?.edgeFloor ?? 0.0,
            points: (Overrides.falloff?.points || [[0, 0], [0.35, 0.28], [0.72, 0.84], [1, 1]]).map(P => P.slice())
        },
        heightMask: {
            enabled: !!Overrides.heightMask?.enabled,
            minElev: Overrides.heightMask?.minElev ?? 0.0,
            maxElev: Overrides.heightMask?.maxElev ?? 300.0,
            minSlope: Overrides.heightMask?.minSlope ?? 0.0,
            maxSlope: Overrides.heightMask?.maxSlope ?? 90.0
        }
    };
}

/*==========================================================================================================================================
                                     PLACEMENT GENERATOR: SINGLE / RANGE / CLUSTER / FIELD
==========================================================================================================================================*/
/**
 * Deterministically expands a `landform` layer into concrete placed instances + tight world AABBs.
 */
export function ResolveLandformInstances(Layer)
{
    const Spec = GetLandformSpec(Layer.archetype);
    const Mode = Layer.placementMode || 'single';
    const Cx = Number(Layer.centerX) || 0.0;
    const Cz = Number(Layer.centerZ) || 0.0;
    const BaseR = Math.max(4.0, Number(Layer.radius) || Spec.defaultRadius);
    const BaseL = Spec.hasLength ? Math.max(24.0, Number(Layer.length) || Spec.defaultLength) : BaseR;
    const BaseH = Math.max(4.0, Number(Layer.height) || Spec.defaultHeight);
    const BaseAzRad = ((Number(Layer.azimuth) || 0.0) * Math.PI) / 180.0;
    const Aspect = Clamp(Number(Layer.aspectRatio) || 1.0, 0.35, 3.0);
    const Seed = (Layer.seed | 0) || 4029;
    const Count = Mode === 'single' ? 1 : Clamp(Math.round(Number(Layer.instanceCount) || 5), 2, 18);
    const Spread = Math.max(80.0, Number(Layer.spread) || 680.0);
    const Curv = Clamp(Number(Layer.rangeCurvature) ?? 0.22, -1.0, 1.0);
    const Taper = Clamp(Number(Layer.scaleTaper) ?? 0.42, 0.0, 0.88);
    const Jitter = Clamp(Number(Layer.jitter) ?? 0.32, 0.0, 1.0);

    const Instances = [];
    const PushInst = (X, Z, R, L, H, AzRad, InstSeed) =>
    {
        const CosA = Math.cos(AzRad), SinA = Math.sin(AzRad);
        const HalfU = Spec.hasLength ? L * 0.56 + R * 0.45 : R * Math.max(1.0, Aspect) * 1.18;
        let HalfV = R * Math.max(1.0, Aspect) * 1.18;
        if (Spec.id === 'slot_canyon' || Spec.id === 'v_gorge')
        {
            HalfV = R * Math.max(1.0, Aspect) * (1.35 + (Number(Layer.params?.meanderAmp) || 0.35));
        }
        else if (Spec.id === 'cliff_pathway')
        {
            const InfS = Clamp(Number(Layer.params?.influenceScale) ?? 1.35, 0.25, 4.0);
            const BendA = Clamp(Number(Layer.params?.bendAmplitude) ?? 0.42, 0.0, 1.0);
            HalfV = R * (1.25 + 1.45 * InfS) + L * 0.20 * BendA + 18.0;
        }
        else if (Spec.id === 'cave_cavern')
        {
            const Swell = Clamp(Number(Layer.params?.chamberSwell) ?? 0.62, 0.0, 1.5);
            const Curve = Math.abs(Number(Layer.params?.passageCurve) ?? 0.32);
            HalfV = R * (1.45 + Swell + Curve * 1.15) + 18.0;
        }
        const Reach = Math.hypot(HalfU, HalfV) * 1.06;
        Instances.push({
            cx: X, cz: Z,
            radius: R, length: L, height: H,
            azimuthRad: AzRad, cosA: CosA, sinA: SinA,
            aspect: Aspect,
            seed: InstSeed,
            minX: X - Reach, maxX: X + Reach,
            minZ: Z - Reach, maxZ: Z + Reach
        });
    };

    if (Mode === 'single')
    {
        PushInst(Cx, Cz, BaseR, BaseL, BaseH, BaseAzRad, Seed);
    }
    else if (Mode === 'range')
    {
        // Linear / bowed mountain chain, island arc, or dune ridge along azimuth!
        const CosA = Math.cos(BaseAzRad), SinA = Math.sin(BaseAzRad);
        for (let I = 0; I < Count; ++I)
        {
            const U = Count > 1 ? (I / (Count - 1)) * 2.0 - 1.0 : 0.0; // [-1..+1]
            const Jx = (Hash1(I * 17 + 3, Seed) - 0.5) * Jitter * (Spread / Count) * 0.65;
            const Jz = (Hash1(I * 29 + 7, Seed) - 0.5) * Jitter * BaseR * 0.55;
            const Along = U * Spread * 0.5 + Jx;
            const Bow = Curv * Spread * 0.24 * (1.0 - U * U) + Jz;
            const X = Cx + Along * CosA - Bow * SinA;
            const Z = Cz + Along * SinA + Bow * CosA;

            const Env = 1.0 - Taper * (U * U * 0.85);
            const HScale = Env * (1.0 + (Hash1(I * 43 + 11, Seed) - 0.5) * Jitter * 0.45);
            const RScale = (0.72 + 0.28 * Env) * (1.0 + (Hash1(I * 59 + 13, Seed) - 0.5) * Jitter * 0.35);
            const AzOff = (Hash1(I * 71 + 19, Seed) - 0.5) * Jitter * 0.85;
            PushInst(X, Z, BaseR * RScale, BaseL * RScale, BaseH * HScale, BaseAzRad + AzOff, Seed + I * 313);
        }
    }
    else if (Mode === 'cluster')
    {
        // Central hero massif surrounded by golden-angle satellite peaks / cinder cones / buttes
        PushInst(Cx, Cz, BaseR, BaseL, BaseH, BaseAzRad, Seed);
        const Golden = 2.399963229728653;
        for (let I = 1; I < Count; ++I)
        {
            const T = I / Math.max(1, Count - 1);
            const Ang = BaseAzRad + I * Golden + (Hash1(I * 19 + 5, Seed) - 0.5) * Jitter * 0.75;
            const Dist = Spread * (0.24 + 0.42 * Math.sqrt(T)) * (0.82 + 0.36 * Hash1(I * 31 + 9, Seed));
            const X = Cx + Math.cos(Ang) * Dist;
            const Z = Cz + Math.sin(Ang) * Dist;
            const Scale = Mix(0.84, 1.0 - Taper * 0.65, T) * (0.85 + 0.30 * Hash1(I * 47 + 17, Seed));
            const HScale = Scale * (0.82 + 0.36 * Hash1(I * 61 + 23, Seed));
            const AzOff = (Hash1(I * 83 + 29, Seed) - 0.5) * Math.PI * Jitter;
            PushInst(X, Z, BaseR * Scale, BaseL * Scale, BaseH * HScale, BaseAzRad + AzOff, Seed + I * 419);
        }
    }
    else
    {
        // 'field' — jittered quasi-Poisson scatter field across Spread × Spread area (craters, dunes, karst, buttes!)
        const Side = Math.ceil(Math.sqrt(Count));
        const Cell = Spread / Math.max(1, Side);
        let Emitted = 0;
        for (let Gz = 0; Gz < Side && Emitted < Count; ++Gz)
        {
            for (let Gx = 0; Gx < Side && Emitted < Count; ++Gx)
            {
                const Idx = Gz * Side + Gx;
                const Rx = (Gx + 0.5 + (Hash1(Idx * 13 + 3, Seed) - 0.5) * (0.55 + 0.38 * Jitter)) / Side - 0.5;
                const Rz = (Gz + 0.5 + (Hash1(Idx * 23 + 7, Seed) - 0.5) * (0.55 + 0.38 * Jitter)) / Side - 0.5;
                const CosA = Math.cos(BaseAzRad), SinA = Math.sin(BaseAzRad);
                const Lx = Rx * Spread, Lz = Rz * Spread;
                const X = Cx + Lx * CosA - Lz * SinA;
                const Z = Cz + Lx * SinA + Lz * CosA;

                const SizeVar = Mix(1.0 - Taper * 0.65, 1.08, Hash1(Idx * 37 + 11, Seed));
                const HVar = SizeVar * Mix(1.0 - Jitter * 0.45, 1.15, Hash1(Idx * 53 + 17, Seed));
                // Keep directional wind dunes aligned to azimuth with slight jitter; rotate radial landforms more freely
                const IsDirectional = Spec.id === 'barchan_dune' || Spec.hasLength;
                const AzSpan = IsDirectional ? 0.35 : Math.PI * 1.4;
                const AzOff = (Hash1(Idx * 67 + 29, Seed) - 0.5) * AzSpan * Jitter;
                const FieldR = Math.min(BaseR, Math.max(BaseR * 0.48, Cell * 0.72)) * SizeVar;
                const FieldL = Spec.hasLength ? BaseL * SizeVar : FieldR;
                PushInst(X, Z, FieldR, FieldL, BaseH * HVar, BaseAzRad + AzOff, Seed + Emitted * 509);
                Emitted++;
            }
        }
    }

    let MinX = Infinity, MaxX = -Infinity, MinZ = Infinity, MaxZ = -Infinity;
    for (const Inst of Instances)
    {
        if (Inst.minX < MinX) MinX = Inst.minX;
        if (Inst.maxX > MaxX) MaxX = Inst.maxX;
        if (Inst.minZ < MinZ) MinZ = Inst.minZ;
        if (Inst.maxZ > MaxZ) MaxZ = Inst.maxZ;
    }

    return {
        spec: Spec,
        instances: Instances,
        bounds: { minX: MinX, maxX: MaxX, minZ: MinZ, maxZ: MaxZ }
    };
}

/*==========================================================================================================================================
                                     SINGLE-INSTANCE PURE-SDF LANDFORM PROFILE EVALUATOR
==========================================================================================================================================*/
/**
 * Deterministic 3D limestone/bedrock wall displacement noise for Pure-SDF 3D Caves & Cliff Galleries.
 * Smooth trigonometric 3D wave interference (fast, allocation-free, C∞ differentiable, exact everywhere).
 */
export function CaveNoise3D(X, Y, Z, Seed)
{
    const S1 = (Seed % 997) * 0.017;
    const S2 = ((Seed * 7) % 991) * 0.013;
    const N1 = Math.sin(X * 0.19 + S1) * Math.cos(Y * 0.23 + S2) * Math.sin(Z * 0.17 - S1 * 0.7);
    const N2 = Math.sin(X * 0.43 - Z * 0.37 + S2) * Math.cos(Y * 0.41 + X * 0.21);
    const N3 = Math.cos(X * 0.89 + Y * 0.77 - Z * 0.83 + S1 * 1.9);
    return N1 * 0.54 + N2 * 0.30 + N3 * 0.16;
}

// Reusable return object to guarantee ZERO heap allocation inside the inner 2D grid loop!
const _EvalOut = { value: 0.0, active: false, waterMask: 0.0 };

function EvaluateSingleLandformInstance(SpecId, Inst, Params, RockDetail, Wx, Wz)
{
    _EvalOut.value = 0.0;
    _EvalOut.active = false;
    _EvalOut.waterMask = 0.0;

    const Dx = Wx - Inst.cx;
    const Dz = Wz - Inst.cz;
    // Rotate into local landform frame (u = strike/wind/length axis, v = cross axis)
    const U = Dx * Inst.cosA + Dz * Inst.sinA;
    const V = -Dx * Inst.sinA + Dz * Inst.cosA;
    const R = Inst.radius;
    const L = Inst.length;
    const H = Inst.height;
    const Asp = Inst.aspect;
    const Seed = Inst.seed;
    const Det = Clamp(RockDetail, 0.0, 1.0);

    // Optional light domain warp for natural organic rock silhouettes when RockDetail > 0
    let Wu = U, Wv = V;
    if (Det > 0.005)
    {
        const WScale = 2.4 / Math.max(40.0, R);
        const WAmp = R * 0.085 * Det;
        Wu += DetailFbm2D(U * WScale + 3.1, V * WScale + 7.4, Seed + 11) * WAmp;
        Wv += DetailFbm2D(U * WScale + 19.3, V * WScale + 11.7, Seed + 29) * WAmp;
    }

    const Un = Wu / R;
    const Vn = Wv / (R * Asp);
    const Rad = Math.hypot(Un, Vn);
    const Phi = Math.atan2(Vn, Un);

    let Prof = 0.0;
    let Water = 0.0;

    switch (SpecId)
    {
        /*----------------------------------------------------------------------------------------------------------------------------------
                                                 FAMILY 1: PEAKS, CONES & VOLCANOES
        ----------------------------------------------------------------------------------------------------------------------------------*/
        case 'alpine_peak':
        {
            if (Rad >= 1.22) return _EvalOut;
            const Gamma = Clamp(Number(Params.slopeCurve) || 1.38, 0.4, 2.6);
            const N = Clamp(Math.round(Number(Params.ridgeCount) || 4), 3, 9);
            const RSharp = Clamp(Number(Params.ridgeSharpness) ?? 0.68, 0.0, 1.0);
            const Twist = Number(Params.ridgeTwist) ?? 0.28;
            const Cirque = Clamp(Number(Params.cirqueDepth) ?? 0.34, 0.0, 0.78);
            const FlatTop = Clamp(Number(Params.summitFlatness) ?? 0.04, 0.0, 0.60);

            const PhiT = Phi + Twist * Math.pow(Math.min(Rad, 1.2), 1.15);
            const Wave = 0.5 + 0.5 * Math.cos(N * PhiT);
            const Arete = Math.pow(Wave, 1.0 + 1.85 * RSharp);
            // Expand radius slightly along arêtes and tuck inward inside glacial cirques
            const RadEff = Rad / Math.max(0.55, 1.0 + 0.24 * RSharp * (2.0 * Arete - 1.0));
            if (RadEff >= 1.0) return _EvalOut;

            const ToeFade = Smoothstep(1.0, 0.80, RadEff);
            let Horn = Math.pow(Clamp(1.0 - RadEff, 0.0, 1.0), Gamma) * ToeFade;
            Horn += 0.14 * RSharp * Arete * Math.sin(Math.PI * Clamp(RadEff, 0.0, 1.0)) * (1.0 - RadEff * 0.5);

            // Carve glacial cirque bowls in the valleys between arêtes
            const CirqBand = Math.sin(Math.PI * Clamp((RadEff - 0.08) / 0.78, 0.0, 1.0));
            const CirqCut = Cirque * (1.0 - Arete) * Math.pow(Math.max(0.0, CirqBand), 1.35) * 0.52;
            Horn = Math.max(0.0, Horn - CirqCut);

            if (FlatTop > 0.005)
            {
                const Cap = 1.0 - FlatTop;
                Horn = SdfSmoothMin(Horn, Cap, 0.07) / Math.max(0.45, Cap + 0.03);
            }
            Prof = Horn;
            break;
        }

        case 'stratovolcano':
        {
            if (Rad >= 1.06) return _EvalOut;
            const Gamma = Clamp(Number(Params.slopeCurve) || 1.55, 0.7, 2.8);
            const Rc = Clamp(Number(Params.craterRadius) || 0.25, 0.07, 0.58);
            const CDepth = Clamp(Number(Params.craterDepth) ?? 0.44, 0.02, 0.95);
            const RimBoost = Clamp(Number(Params.rimLipBoost) ?? 0.14, 0.0, 0.40);
            const Resurg = Clamp(Number(Params.resurgentDome) ?? 0.16, 0.0, 0.70);
            const Flutes = Clamp(Math.round(Number(Params.ridgeCount) || 10), 4, 18);
            const FSharp = Clamp(Number(Params.ridgeSharpness) ?? 0.28, 0.0, 0.85);
            const Breach = Clamp(Number(Params.breachDepth) ?? 0.0, 0.0, 0.92);

            const RimPeak = 1.0 + RimBoost;
            let Cone = 0.0;
            if (Rad >= Rc)
            {
                const T = Clamp((Rad - Rc) / Math.max(0.12, 1.0 - Rc), 0.0, 1.0);
                const Skirt = Smoothstep(1.0, 0.82, T);
                Cone = Math.pow(1.0 - T, Gamma) * Skirt;
                // Subtle upturned caldera rim lip right at crater edge
                const RimGauss = Math.exp(-Math.pow((Rad - Rc) / (0.14 * Rc + 0.035), 2.0));
                Cone += RimBoost * RimGauss;
                // Radial lahar & eruption ravines radiating down cone flanks
                const FluteEnv = Math.sin(Math.PI * T) * Skirt;
                const FluteWave = Math.cos(Flutes * Phi + Math.sin(T * 5.0 + Seed) * 0.35);
                Cone += FSharp * 0.095 * FluteWave * FluteEnv;
            }
            else
            {
                const Uc = Rad / Rc; // [0..1]
                const Wall = Math.pow(Smoothstep(0.12, 1.0, Uc), 1.45);
                const FloorElev = Math.max(0.06, 1.0 - CDepth);
                Cone = Mix(FloorElev, RimPeak, Wall);
                // Central resurgent lava dome inside caldera floor
                if (Resurg > 0.005 && Uc < 0.52)
                {
                    const Dq = Uc / 0.52;
                    Cone += Resurg * CDepth * Math.pow(Math.max(0.0, 1.0 - Dq * Dq), 1.45);
                }
            }

            // Optional rim breach spillway along +u (azimuth direction)
            if (Breach > 0.005 && Rad > Rc * 0.25 && Rad < 0.95)
            {
                const AngD = Math.abs(WrapAnglePi(Phi));
                const AngW = 1.0 - Smoothstep(0.08, 0.44, AngD);
                const RadW = Smoothstep(Rc * 0.25, Rc * 0.92, Rad) * Smoothstep(0.95, Rc * 1.45, Rad);
                Cone -= Breach * (CDepth * 0.85 + RimBoost) * AngW * RadW;
            }
            Prof = Math.max(0.0, Cone);
            break;
        }

        case 'shield_volcano':
        {
            const Lobes = Clamp(Math.round(Number(Params.ridgeCount) || 6), 3, 12);
            const RadLobe = Rad / (1.0 + 0.11 * Math.cos(Lobes * Phi + 0.35 * Math.sin(Rad * 4.0 + Seed)));
            if (RadLobe >= 1.0) return _EvalOut;

            const Gamma = Clamp(Number(Params.slopeCurve) || 0.62, 0.30, 1.50);
            const Rc = Clamp(Number(Params.craterRadius) || 0.15, 0.03, 0.40);
            const CDepth = Clamp(Number(Params.craterDepth) ?? 0.26, 0.0, 0.72);
            const Steps = Math.round(Number(Params.terraceSteps) || 0);
            const TStr = Clamp(Number(Params.terraceStrength) ?? 0.36, 0.0, 0.92);

            let Shield = Math.pow(Math.max(0.0, 1.0 - RadLobe * RadLobe), Gamma) * Smoothstep(1.0, 0.86, RadLobe);
            Shield = ApplyTerraceSteps(Shield, Steps, TStr * 0.75);

            if (CDepth > 0.005 && Rad < Rc * 1.08)
            {
                const PitMask = 1.0 - Smoothstep(Rc * 0.68, Rc * 1.06, Rad);
                Shield = Math.max(0.05, Shield - CDepth * PitMask);
            }
            Prof = Shield;
            break;
        }

        case 'granite_dome':
        {
            if (Rad >= 1.02) return _EvalOut;
            const Gamma = Clamp(Number(Params.slopeCurve) || 0.56, 0.30, 1.35);
            const Shear = Clamp(Number(Params.shearStrength) ?? 0.52, 0.0, 0.95);
            const SSteep = Clamp(Number(Params.shearSteepness) ?? 0.84, 0.18, 0.99);
            const Steps = Math.round(Number(Params.terraceSteps) || 0);
            const TStr = Clamp(Number(Params.terraceStrength) ?? 0.28, 0.0, 0.90);

            let Dome = Math.pow(Math.max(0.0, 1.0 - Rad * Rad), Gamma) * Smoothstep(1.0, 0.88, Rad);
            if (Shear > 0.01)
            {
                // Glacial shear face slicing the +u flank into a sheer Half-Dome cliff!
                const CutU = 0.76 - 0.88 * Shear;
                const Band = Mix(0.32, 0.042, SSteep);
                const ShearKeep = 1.0 - Smoothstep(CutU, CutU + Band, Un);
                Dome *= ShearKeep;
            }
            Dome = ApplyTerraceSteps(Dome, Steps, TStr * 0.65);
            Prof = Dome;
            break;
        }

        /*----------------------------------------------------------------------------------------------------------------------------------
                                               FAMILY 2: PLATEAUS, MESAS, BUTTES & CUESTAS
        ----------------------------------------------------------------------------------------------------------------------------------*/
        case 'mesa_plateau':
        {
            const Q = Clamp(Number(Params.footprintRoundness) || 3.0, 1.5, 6.2);
            const Lobing = Clamp(Number(Params.lobing) ?? 0.24, 0.0, 0.65);
            const Steep = Clamp(Number(Params.cliffSteepness) ?? 0.86, 0.25, 0.99);
            const Talus = Clamp(Number(Params.talusRatio) ?? 0.34, 0.04, 0.68);
            const Steps = Math.round(Number(Params.terraceSteps) || 0);
            const TStr = Clamp(Number(Params.terraceStrength) ?? 0.56, 0.0, 0.96);
            const DipRad = ((Number(Params.dipDeg) || 0.0) * Math.PI) / 180.0;

            const SuperR = Math.pow(Math.pow(Math.abs(Un), Q) + Math.pow(Math.abs(Vn), Q), 1.0 / Q);
            const LobeMod = 1.0 + Lobing * (0.55 * Math.cos(5.0 * Phi + Seed * 0.13) + 0.45 * Math.sin(3.0 * Phi - Seed * 0.21));
            const Re = SuperR / Math.max(0.45, LobeMod);
            if (Re >= 1.0) return _EvalOut;

            const CliffW = Mix(0.24, 0.038, Steep);
            const CapR = Math.max(0.14, 1.0 - Talus - CliffW);
            const TalusShoulder = Mix(0.46, 0.28, Steep);

            let P = 0.0;
            if (Re <= CapR)
            {
                P = 1.0;
            }
            else if (Re <= CapR + CliffW)
            {
                const T = (Re - CapR) / Math.max(1e-4, CliffW);
                P = Mix(1.0, TalusShoulder, Smoothstep(0.0, 1.0, T));
            }
            else
            {
                const T = (Re - (CapR + CliffW)) / Math.max(1e-4, 1.0 - (CapR + CliffW));
                P = TalusShoulder * Math.pow(Clamp(1.0 - T, 0.0, 1.0), 1.38);
            }

            // Apply stepped strata benches cleanly along cliff & talus (keep flat mesa cap crisp!)
            if (Steps > 0 && TStr > 0.01 && P < 0.992)
            {
                P = ApplyTerraceSteps(P, Steps, TStr);
            }

            // Slight structural caprock dip tilt across the plateau top
            if (Math.abs(DipRad) > 1e-4 && P > 0.02)
            {
                const TiltAdd = (Math.tan(DipRad) * Wu) / Math.max(20.0, H);
                P = Math.max(0.0, P + TiltAdd * Smoothstep(0.0, 0.45, P));
            }
            Prof = P;
            break;
        }

        case 'stepped_butte':
        {
            const Ribs = Clamp(Math.round(Number(Params.ridgeCount) || 7), 3, 12);
            const RSharp = Clamp(Number(Params.ridgeSharpness) ?? 0.42, 0.0, 0.88);
            const FlutedR = Rad / Math.max(0.55, 1.0 + 0.16 * RSharp * Math.cos(Ribs * Phi + Seed * 0.17));
            if (FlutedR >= 1.0) return _EvalOut;

            const Crown = Clamp(Number(Params.crownRatio) || 0.28, 0.10, 0.60);
            const Steep = Clamp(Number(Params.cliffSteepness) ?? 0.88, 0.30, 0.99);
            const Steps = Clamp(Math.round(Number(Params.terraceSteps) || 6), 1, 14);
            const TStr = Clamp(Number(Params.terraceStrength) ?? 0.78, 0.0, 0.98);

            const CliffW = Mix(0.18, 0.045, Steep);
            let P = 0.0;
            if (FlutedR <= Crown)
            {
                P = 1.0;
            }
            else if (FlutedR <= Crown + CliffW)
            {
                const T = (FlutedR - Crown) / Math.max(1e-4, CliffW);
                P = Mix(1.0, 0.56, Smoothstep(0.0, 1.0, T));
            }
            else
            {
                const T = (FlutedR - (Crown + CliffW)) / Math.max(1e-4, 1.0 - (Crown + CliffW));
                P = 0.56 * Math.pow(Clamp(1.0 - T, 0.0, 1.0), 1.55);
            }
            P = ApplyTerraceSteps(P, Steps, TStr);
            Prof = P;
            break;
        }

        case 'tilted_cuesta':
        {
            const HalfL = Math.max(40.0, L * 0.5);
            const Ul = Wu / HalfL;
            if (Math.abs(Ul) >= 1.05) return _EvalOut;

            const Bow = Number(Params.strikeBow) ?? 0.12;
            const Lobing = Clamp(Number(Params.lobing) ?? 0.22, 0.0, 0.58);
            const DipR = Clamp(Number(Params.dipSlopeRatio) ?? 0.72, 0.22, 0.88);
            const Steep = Clamp(Number(Params.cliffSteepness) ?? 0.88, 0.28, 0.99);
            const Steps = Math.round(Number(Params.terraceSteps) || 0);
            const TStr = Clamp(Number(Params.terraceStrength) ?? 0.48, 0.0, 0.95);

            const BowOff = Bow * R * (1.0 - Ul * Ul);
            const LobeOff = Lobing * R * 0.35 * Math.sin(Ul * Math.PI * 3.0 + Seed * 0.19);
            const VRel = (Wv - BowOff - LobeOff) / R; // [-1..+1]
            if (Math.abs(VRel) >= 1.0) return _EvalOut;

            const EndEnv = Smoothstep(1.0, 0.68, Math.abs(Ul));
            const CrestV = 2.0 * DipR - 1.0; // in [-0.56..+0.76]
            let Cross = 0.0;
            if (VRel <= CrestV)
            {
                // Gentle structural dip-slope rising from -1 to CrestV
                const T = Clamp((VRel + 1.0) / Math.max(0.15, CrestV + 1.0), 0.0, 1.0);
                Cross = Math.pow(T, 0.88) * Smoothstep(0.0, 0.12, T);
            }
            else
            {
                // Steep sheared escarpment falling rapidly from CrestV to +1
                const T = Clamp((VRel - CrestV) / Math.max(0.12, 1.0 - CrestV), 0.0, 1.0);
                const DropPow = Mix(1.4, 4.4, Steep);
                Cross = Math.pow(1.0 - T, DropPow);
            }
            let P = Cross * EndEnv;
            if (Steps > 0 && TStr > 0.01) P = ApplyTerraceSteps(P, Steps, TStr);
            Prof = P;
            break;
        }

        /*----------------------------------------------------------------------------------------------------------------------------------
                                              FAMILY 3: VALLEYS, CANYONS, FJORDS & GRABENS
        ----------------------------------------------------------------------------------------------------------------------------------*/
        case 'v_gorge':
        {
            const HalfL = Math.max(40.0, L * 0.5);
            const Ul = Wu / HalfL;
            if (Math.abs(Ul) >= 1.04) return _EvalOut;

            const MAmp = Clamp(Number(Params.meanderAmp) ?? 0.32, 0.0, 1.0);
            const MFreq = Clamp(Number(Params.meanderFreq) ?? 1.4, 0.4, 4.5);
            const WSlope = Clamp(Number(Params.wallSlope) ?? 1.05, 0.38, 2.6);
            const Flr = Clamp(Number(Params.floorRatio) ?? 0.12, 0.02, 0.48);
            const Asym = Clamp(Number(Params.asymmetry) ?? 0.18, -0.75, 0.75);
            const Tilt = Clamp(Number(Params.longitudinalTilt) ?? 0.16, -0.65, 0.65);

            const CenterV = MAmp * R * Math.sin(Ul * Math.PI * MFreq + (Seed % 628) * 0.01);
            const SignedD = Wv - CenterV;
            const SideW = R * (1.0 + (SignedD >= 0.0 ? Asym : -Asym) * 0.52);
            const Q = Math.abs(SignedD) / Math.max(12.0, SideW);
            if (Q >= 1.0) return _EvalOut;

            const EndEnv = Smoothstep(1.0, 0.78, Math.abs(Ul));
            const TiltMul = Clamp(1.0 + Tilt * Ul, 0.35, 1.45);
            let Cross = 1.0;
            if (Q > Flr)
            {
                const T = (Q - Flr) / Math.max(1e-4, 1.0 - Flr);
                Cross = Math.pow(Clamp(1.0 - T, 0.0, 1.0), WSlope) * Smoothstep(1.0, 0.82, T);
            }
            Prof = Cross * EndEnv * TiltMul;
            if (Q < Flr * 1.55) Water = (1.0 - Q / (Flr * 1.55)) * EndEnv;
            break;
        }

        case 'u_glacial_valley':
        {
            const HalfL = Math.max(40.0, L * 0.5);
            const Ul = Wu / HalfL;
            if (Math.abs(Ul) >= 1.05) return _EvalOut;

            const MAmp = Clamp(Number(Params.meanderAmp) ?? 0.16, 0.0, 0.70);
            const MFreq = Clamp(Number(Params.meanderFreq) ?? 1.0, 0.3, 3.5);
            const Flr = Clamp(Number(Params.floorRatio) ?? 0.42, 0.14, 0.72);
            const WallExp = Clamp(Number(Params.wallExponent) ?? 3.2, 1.4, 5.8);
            const Shoulder = Clamp(Number(Params.shoulderHeight) ?? 0.14, 0.0, 0.42);
            const HeadSteep = Clamp(Number(Params.headwallSteepness) ?? 0.72, 0.12, 0.98);

            const CenterV = MAmp * R * Math.sin(Ul * Math.PI * MFreq + (Seed % 314) * 0.01);
            const Q = Math.abs(Wv - CenterV) / R;
            if (Q >= 1.0) return _EvalOut;

            // Asymmetric longitudinal envelope: steep cirque amphitheater headwall at Ul=-1, wide open fjord mouth at Ul=+1
            const HeadEnv = Smoothstep(-1.0, -1.0 + Mix(0.55, 0.12, HeadSteep), Ul);
            const MouthEnv = Smoothstep(1.0, 0.78, Ul);
            const EndEnv = HeadEnv * MouthEnv;

            let Cross = 1.0;
            if (Q > Flr)
            {
                const T = (Q - Flr) / Math.max(1e-4, 1.0 - Flr);
                Cross = 1.0 - Math.pow(T, WallExp);
                // Optional glacial trimline shoulder shelf halfway up the U-wall
                if (Shoulder > 0.01)
                {
                    const ShelfBump = Math.exp(-Math.pow((T - 0.68) / 0.15, 2.0));
                    Cross = Math.max(0.0, Cross - Shoulder * 0.35 * ShelfBump);
                }
                Cross *= Smoothstep(1.0, 0.88, T);
            }
            Prof = Cross * EndEnv;
            if (Q < Flr * 0.85) Water = 0.65 * EndEnv;
            break;
        }

        case 'slot_canyon':
        {
            const HalfL = Math.max(40.0, L * 0.5);
            const Ul = Wu / HalfL;
            if (Math.abs(Ul) >= 1.04) return _EvalOut;

            const MAmp = Clamp(Number(Params.meanderAmp) ?? 0.56, 0.05, 1.25);
            const MFreq = Clamp(Number(Params.meanderFreq) ?? 2.6, 0.6, 6.0);
            const Flr = Clamp(Number(Params.floorRatio) ?? 0.18, 0.04, 0.40);
            const Steep = Clamp(Number(Params.cliffSteepness) ?? 0.92, 0.40, 0.99);

            const CenterV = MAmp * R * (Math.sin(Ul * Math.PI * MFreq + (Seed % 314) * 0.01) +
                                        0.28 * Math.sin(Ul * Math.PI * MFreq * 2.1 + 1.4));
            const Q = Math.abs(Wv - CenterV) / R;
            if (Q >= 1.0) return _EvalOut;

            const EndEnv = Smoothstep(1.0, 0.84, Math.abs(Ul));
            const WallW = Mix(0.45, 0.10, Steep);
            const Cross = 1.0 - Smoothstep(Flr, Math.min(0.98, Flr + WallW), Q);
            Prof = Cross * EndEnv;
            if (Q < Flr * 1.1) Water = 0.45 * EndEnv;
            break;
        }

        case 'rift_graben':
        {
            // Bipolar tectonic landform: lowers central rift graben (-1.0) AND uplifts twin horst rims (+rimLipBoost)!
            const HalfL = Math.max(40.0, L * 0.5);
            const Ul = Wu / HalfL;
            if (Math.abs(Ul) >= 1.04) return _EvalOut;

            const Flr = Clamp(Number(Params.floorRatio) ?? 0.42, 0.16, 0.68);
            const Steep = Clamp(Number(Params.cliffSteepness) ?? 0.85, 0.30, 0.99);
            const Steps = Clamp(Math.round(Number(Params.terraceSteps) || 3), 1, 7);
            const Horst = Clamp(Number(Params.rimLipBoost) ?? 0.34, 0.0, 0.70);
            const Bow = Number(Params.strikeBow) ?? 0.08;

            const BowOff = Bow * R * (1.0 - Ul * Ul);
            const Q = Math.abs(Wv - BowOff) / R;
            if (Q >= 1.0) return _EvalOut;

            const EndEnv = Smoothstep(1.0, 0.72, Math.abs(Ul));
            const WallEnd = Clamp(Flr + Mix(0.32, 0.14, Steep), Flr + 0.08, 0.78);
            let Cross = 0.0;
            if (Q <= Flr)
            {
                Cross = -1.0;
            }
            else if (Q <= WallEnd)
            {
                const T = (Q - Flr) / Math.max(1e-4, WallEnd - Flr);
                const SteppedT = ApplyTerraceSteps(T, Steps, 0.68);
                Cross = Mix(-1.0, Horst, SteppedT);
            }
            else
            {
                const T = (Q - WallEnd) / Math.max(1e-4, 1.0 - WallEnd);
                Cross = Horst * Math.pow(Clamp(1.0 - T, 0.0, 1.0), 1.65);
            }
            Prof = Cross * EndEnv;
            break;
        }

        /*----------------------------------------------------------------------------------------------------------------------------------
                                          FAMILY 4: LINEAR RIDGES, FAULT SCARPS & FOLD BELTS
        ----------------------------------------------------------------------------------------------------------------------------------*/
        case 'fault_scarp':
        {
            const HalfL = Math.max(40.0, L * 0.5);
            const Ul = Wu / HalfL;
            if (Math.abs(Ul) >= 1.05) return _EvalOut;

            const Steep = Clamp(Number(Params.cliffSteepness) ?? 0.88, 0.30, 0.99);
            const Rollover = Clamp(Number(Params.rolloverAmp) ?? 0.22, 0.0, 0.52);
            const Facets = Clamp(Math.round(Number(Params.ridgeCount) || 8), 3, 16);
            const FSharp = Clamp(Number(Params.ridgeSharpness) ?? 0.42, 0.0, 0.90);
            const Bow = Number(Params.strikeBow) ?? 0.08;

            const BowOff = Bow * R * (1.0 - Ul * Ul);
            const VRel = (Wv - BowOff) / R; // [-1..+1]
            if (VRel <= -0.35 || VRel >= 1.0) return _EvalOut;

            const EndEnv = Smoothstep(1.0, 0.72, Math.abs(Ul));
            const ScarpW = Mix(0.32, 0.055, Steep);
            const Rise = Smoothstep(-ScarpW, ScarpW, VRel);
            const BackDecay = Smoothstep(1.0, 0.12, VRel);
            const Arch = Rollover * Math.exp(-Math.pow((VRel - ScarpW * 1.4) / 0.24, 2.0));

            // Triangular faceted spur gullies incised across the fault scarp face
            const ScarpZone = Math.exp(-Math.pow((VRel - ScarpW * 0.3) / (ScarpW * 1.6 + 0.08), 2.0));
            const FacetWave = 0.5 - 0.5 * Math.cos(Ul * Math.PI * Facets + Seed * 0.11);
            const FacetCut = FSharp * 0.24 * FacetWave * ScarpZone;

            Prof = Math.max(0.0, (Rise * BackDecay + Arch - FacetCut) * EndEnv);
            break;
        }

        case 'fold_belt':
        {
            const HalfL = Math.max(40.0, L * 0.5);
            const Ul = Wu / HalfL;
            if (Math.abs(Ul) >= 1.04) return _EvalOut;

            const Cycles = Clamp(Number(Params.foldCount) || 3.5, 1.2, 8.5);
            const Asym = Clamp(Number(Params.foldAsymmetry) ?? 0.36, -0.88, 0.88);
            const Breach = Clamp(Number(Params.breachDepth) ?? 0.22, 0.0, 0.82);
            const Bow = Number(Params.strikeBow) ?? 0.18;
            const Sharp = Clamp(Number(Params.crestSharpness) ?? 0.58, 0.08, 1.0);

            const BowOff = Bow * R * (1.0 - Ul * Ul);
            const VRel = (Wv - BowOff) / R; // [-1..+1]
            if (Math.abs(VRel) >= 1.0) return _EvalOut;

            const EnvU = Smoothstep(1.0, 0.65, Math.abs(Ul));
            const EnvV = Smoothstep(1.0, 0.72, Math.abs(VRel));
            const PhBase = Math.PI * Cycles * VRel + 0.25 * Math.sin(Ul * Math.PI * 1.5 + Seed);
            const PhSkew = PhBase + Asym * 0.68 * Math.sin(PhBase);
            let Wave = Math.pow(0.5 + 0.5 * Math.cos(PhSkew), Mix(0.75, 2.1, Sharp));

            // Optional breached anticlinal crest valley -> classic twin facing hogbacks!
            if (Breach > 0.01 && Wave > 0.58)
            {
                const CrestT = Smoothstep(0.58, 1.0, Wave);
                Wave -= Breach * 0.45 * CrestT * CrestT;
            }
            Prof = Math.max(0.0, Wave * EnvU * EnvV);
            break;
        }

        case 'hogback_arete':
        {
            const HalfL = Math.max(40.0, L * 0.5);
            const Ul = Wu / HalfL;
            if (Math.abs(Ul) >= 1.04) return _EvalOut;

            const Sharp = Clamp(Number(Params.crestSharpness) ?? 0.82, 0.15, 1.0);
            const Asym = Clamp(Number(Params.asymmetry) ?? 0.32, -0.78, 0.78);
            const Bow = Number(Params.strikeBow) ?? 0.16;
            const Peaks = Clamp(Math.round(Number(Params.ridgeCount) || 5), 2, 12);
            const Cols = Clamp(Number(Params.colDepth) ?? 0.28, 0.0, 0.72);
            const Spurs = Clamp(Number(Params.spurStrength) ?? 0.44, 0.0, 0.88);

            const BowOff = Bow * R * (1.0 - Ul * Ul);
            const SignedV = Wv - BowOff;
            const SideW = R * (1.0 + (SignedV >= 0.0 ? Asym : -Asym) * 0.55);
            const Q = Math.abs(SignedV) / Math.max(14.0, SideW);
            if (Q >= 1.0) return _EvalOut;

            const EndEnv = Smoothstep(1.0, 0.72, Math.abs(Ul));
            const CrestMod = 1.0 - Cols * (0.5 - 0.5 * Math.cos(Ul * Math.PI * Peaks + Seed * 0.17));
            const Spine = Math.pow(Clamp(1.0 - Q, 0.0, 1.0), 1.0 + 2.15 * Sharp) * Smoothstep(1.0, 0.84, Q);
            // Lateral buttress ribs descending orthogonally down both flanks
            const SpurWave = 0.5 + 0.5 * Math.cos(Ul * Math.PI * Peaks * 1.5 + (SignedV >= 0 ? 0.4 : -0.4));
            const SpurAdd = Spurs * 0.22 * SpurWave * Math.sin(Math.PI * Q) * (1.0 - Q * 0.55);
            Prof = Math.max(0.0, (Spine * CrestMod + SpurAdd) * EndEnv);
            break;
        }

        /*----------------------------------------------------------------------------------------------------------------------------------
                                              FAMILY 5: AEOLIAN, KARST & IMPACT FORMS
        ----------------------------------------------------------------------------------------------------------------------------------*/
        case 'barchan_dune':
        {
            if (Rad >= 1.18) return _EvalOut;
            const SlipSteep = Clamp(Number(Params.slipfaceSteepness) ?? 0.86, 0.28, 0.99);
            const Sharp = Clamp(Number(Params.crestSharpness) ?? 0.82, 0.18, 1.0);
            const HornL = Clamp(Number(Params.hornLength) ?? 0.72, 0.05, 1.25);
            const HornCurv = Clamp(Number(Params.hornCurvature) ?? 0.66, 0.08, 1.0);
            const Waves = Clamp(Math.round(Number(Params.duneWaves) || 1), 1, 5);

            // Wind blows along +u. Crescent horns sweep downwind (+u) as |Vn| increases!
            const CrossEnv = Math.pow(Clamp(1.0 - Vn * Vn, 0.0, 1.0), Mix(0.85, 0.52, HornCurv));
            if (CrossEnv <= 1e-4) return _EvalOut;

            const CrestU = -0.22 + HornL * Math.pow(Math.abs(Vn), Mix(1.5, 2.3, HornCurv)) * (0.65 + 0.35 * HornCurv);
            let Du = Un - CrestU;

            if (Waves > 1)
            {
                // Repeat transverse dune crests cleanly inside radial envelope
                const Period = 1.65 / Waves;
                Du = (((Du + Period * 0.5) % Period) + Period) % Period - Period * 0.5;
                Du *= Waves * 0.72;
            }

            const StossW = 0.72; // Gentle ~12 deg windward ramp
            const SlipW = Mix(0.38, 0.085, SlipSteep); // Crisp ~34 deg leeward avalanche slipface!

            let SlopeProf = 0.0;
            if (Du < 0.0)
            {
                const T = Clamp(-Du / StossW, 0.0, 1.0);
                // Smooth convex windward stoss slope meeting sharp crest
                SlopeProf = Math.pow(1.0 - T, Mix(1.05, 1.45, Sharp)) * Smoothstep(1.0, 0.78, T);
            }
            else
            {
                const T = Clamp(Du / SlipW, 0.0, 1.0);
                // Crisp near-linear 34-degree leeward slipface
                SlopeProf = Math.pow(1.0 - T, Mix(0.85, 1.15, Sharp)) * Smoothstep(1.0, 0.86, T);
            }

            const RadialCap = Waves > 1 ? Smoothstep(1.0, 0.72, Rad) : 1.0;
            Prof = SlopeProf * CrossEnv * RadialCap;
            break;
        }

        case 'star_dune':
        {
            if (Rad >= 1.02) return _EvalOut;
            const Arms = Clamp(Math.round(Number(Params.armCount) || 5), 3, 7);
            const Twist = Number(Params.armTwist) ?? 0.48;
            const Slip = Clamp(Number(Params.slipfaceSteepness) ?? 0.84, 0.25, 0.99);
            const Sharp = Clamp(Number(Params.crestSharpness) ?? 0.86, 0.20, 1.0);
            const Span = Clamp(Number(Params.armSpan) ?? 0.82, 0.32, 1.0);

            const PhiT = Phi + Twist * Math.sin(Rad * 2.55) + 0.14 * Math.cos(Rad * 4.2 + Seed);
            // Distance to nearest radiating arm spine -> sharp sand-knife crest!
            const ArmSaw = Math.abs(Math.sin(Arms * PhiT * 0.5)); // 0 on arm crests, 1 in interdune hollows
            const ArmRidge = Math.pow(Clamp(1.0 - ArmSaw, 0.0, 1.0), 1.0 + 2.3 * Sharp);
            const ArmReach = Clamp(1.0 - Rad / Math.max(0.35, Span), 0.0, 1.0);
            const ArmProf = Math.pow(ArmReach, Mix(1.4, 0.92, Slip)) * ArmRidge;

            // Central pyramidal star spire linking all arms cleanly
            const Core = Math.pow(Clamp(1.0 - Rad / 0.52, 0.0, 1.0), 1.35) * 0.72;
            Prof = Math.max(ArmProf, Core) * Smoothstep(1.0, 0.82, Rad);
            break;
        }

        case 'impact_crater':
        {
            // Bipolar signed landform: excavated parabolic bowl (-craterDepth) + upturned rim (+rimHeight) + central peak + ejecta rays!
            if (Rad >= 1.04) return _EvalOut;
            const Rc = Clamp(Number(Params.craterRadius) || 0.52, 0.22, 0.76);
            const Depth = Clamp(Number(Params.craterDepth) ?? 0.72, 0.10, 1.0);
            const RimH = Clamp(Number(Params.rimHeight) ?? 0.42, 0.05, 0.90);
            const Peak = Clamp(Number(Params.centralPeak) ?? 0.28, 0.0, 0.82);
            const Steps = Math.round(Number(Params.terraceSteps) || 0);
            const Rays = Clamp(Number(Params.ejectaRays) ?? 0.36, 0.0, 1.0);

            if (Rad < Rc)
            {
                const Uc = Rad / Rc; // [0..1]
                let WallT = Math.pow(Uc, 2.15);
                if (Steps > 0 && Uc > 0.48)
                {
                    WallT = ApplyTerraceSteps(WallT, Steps + 1, 0.42);
                }
                Prof = Mix(-Depth, RimH, WallT);
                // Complex crater central rebound peak
                if (Peak > 0.005 && Uc < 0.34)
                {
                    const Pq = Uc / 0.34;
                    Prof += Peak * (Depth + RimH * 0.4) * Math.pow(Math.max(0.0, 1.0 - Pq * Pq), 1.65);
                }
            }
            else
            {
                const T = Clamp((Rad - Rc) / Math.max(0.14, 1.0 - Rc), 0.0, 1.0);
                const Blanket = RimH * Math.pow(1.0 - T, 2.35) * Smoothstep(1.0, 0.78, T);
                const RayMod = 1.0 + Rays * 0.48 * (0.5 + 0.5 * Math.cos(11.0 * Phi + Seed * 0.13)) * Math.sin(Math.PI * T);
                Prof = Blanket * RayMod;
            }
            break;
        }

        case 'karst_cenote':
        {
            const Lobing = Clamp(Number(Params.lobing) ?? 0.18, 0.0, 0.48);
            const Re = Rad / Math.max(0.55, 1.0 + Lobing * (0.6 * Math.cos(4.0 * Phi + Seed * 0.17) + 0.4 * Math.sin(3.0 * Phi)));
            if (Re >= 1.0) return _EvalOut;

            const ShaftR = Clamp(Number(Params.shaftRadius) || 0.48, 0.18, 0.76);
            const Funnel = Clamp(Number(Params.funnelSlope) ?? 0.34, 0.04, 0.90);
            const Steep = Clamp(Number(Params.cliffSteepness) ?? 0.92, 0.40, 0.99);

            const DropW = Mix(0.24, 0.045, Steep);
            let Carve = 0.0;
            if (Re <= ShaftR)
            {
                Carve = 1.0;
            }
            else if (Re <= ShaftR + DropW)
            {
                const T = (Re - ShaftR) / Math.max(1e-4, DropW);
                Carve = Mix(1.0, Funnel * 0.38, Smoothstep(0.0, 1.0, T));
            }
            else
            {
                const T = (Re - (ShaftR + DropW)) / Math.max(1e-4, 1.0 - (ShaftR + DropW));
                Carve = Funnel * 0.38 * Math.pow(Clamp(1.0 - T, 0.0, 1.0), 1.5);
            }
            Prof = Carve;
            if (Re < ShaftR * 0.92) Water = 0.85;
            break;
        }

        /*----------------------------------------------------------------------------------------------------------------------------------
                                                 FAMILY 6: COASTAL & ISLAND FORMS
        ----------------------------------------------------------------------------------------------------------------------------------*/
        case 'atoll_lagoon':
        {
            // Bipolar signed landform: uplifted reef island ring (+1.0) + depressed central lagoon (-lagoonDepth) + navigable pass!
            if (Rad >= 1.04) return _EvalOut;
            const RingR = Clamp(Number(Params.ringRadius) || 0.66, 0.32, 0.84);
            const RingW = Clamp(Number(Params.ringWidth) || 0.24, 0.08, 0.48);
            const LagD = Clamp(Number(Params.lagoonDepth) ?? 0.38, 0.0, 0.88);
            const BreachD = Clamp(Number(Params.breachDepth) ?? 0.72, 0.0, 1.0);
            const BreachW = Clamp(Number(Params.breachWidth) ?? 0.24, 0.06, 0.68);
            const Motus = Clamp(Math.round(Number(Params.ridgeCount) || 6), 3, 12);

            const RingDist = Math.abs(Rad - RingR) / Math.max(0.06, RingW * 0.5);
            let Ring = Math.pow(Clamp(1.0 - RingDist, 0.0, 1.0), 1.35) * Smoothstep(1.0, 0.78, Rad);
            // Segmented motu islet humps around the ring
            Ring *= 0.76 + 0.24 * (0.5 + 0.5 * Math.cos(Motus * Phi + Seed * 0.23));

            // Navigable reef channel pass along +u (azimuth direction)
            if (BreachD > 0.01)
            {
                const AngD = Math.abs(WrapAnglePi(Phi));
                const PassCut = 1.0 - Smoothstep(BreachW * 0.25, BreachW, AngD);
                Ring *= (1.0 - BreachD * PassCut);
            }

            // Sheltered central lagoon depression
            const InnerR = Math.max(0.12, RingR - RingW * 0.42);
            const LagMask = 1.0 - Smoothstep(InnerR * 0.55, InnerR * 1.05, Rad);
            const Lagoon = -LagD * LagMask;

            Prof = Ring + Lagoon;
            if (LagMask > 0.35) Water = LagMask * 0.9;
            break;
        }

        case 'sea_cliff_headland':
        {
            const HalfL = Math.max(40.0, L * 0.5);
            const Ul = Wu / HalfL; // -1 = landward root, +1 = seaward headland promontory tip!
            if (Ul <= -1.04 || Ul >= 1.06) return _EvalOut;

            const Steep = Clamp(Number(Params.cliffSteepness) ?? 0.92, 0.40, 0.99);
            const PlatW = Clamp(Number(Params.platformWidth) ?? 0.28, 0.06, 0.56);
            const PlatH = Clamp(Number(Params.platformHeight) ?? 0.11, 0.02, 0.30);
            const Lobing = Clamp(Number(Params.lobing) ?? 0.22, 0.0, 0.52);
            const Steps = Math.round(Number(Params.terraceSteps) || 0);

            // Narrow slightly toward the projecting promontory tip
            const TipTaper = Mix(1.05, 0.72, Smoothstep(-0.6, 0.95, Ul));
            const LobeMod = 1.0 + Lobing * 0.32 * Math.sin(Ul * Math.PI * 3.0 + Seed * 0.17);
            const Vq = Math.abs(Wv) / Math.max(18.0, R * TipTaper * LobeMod);
            const TipQ = Ul > 0.0 ? Ul : 0.0;
            // Combined seaward boundary metric (0 = interior headland, 1 = outer edge of wave-cut platform)
            const EdgeQ = Math.pow(Math.pow(Vq, 3.0) + Math.pow(TipQ, 3.0), 1.0 / 3.0);
            if (EdgeQ >= 1.0) return _EvalOut;

            const LandRootFade = Smoothstep(-1.0, -0.58, Ul);
            const CliffW = Mix(0.18, 0.036, Steep);
            const CliffEdge = Math.max(0.25, 1.0 - PlatW - CliffW);

            let P = 0.0;
            if (EdgeQ <= CliffEdge)
            {
                // Slight seaward slope on headland crown
                P = Mix(1.0, 0.88, Smoothstep(-0.5, 0.8, Ul));
            }
            else if (EdgeQ <= CliffEdge + CliffW)
            {
                const T = (EdgeQ - CliffEdge) / Math.max(1e-4, CliffW);
                P = Mix(0.92, PlatH, Smoothstep(0.0, 1.0, T));
            }
            else
            {
                // Flat intertidal wave-cut rock bench plunging cleanly at outer rim
                const T = (EdgeQ - (CliffEdge + CliffW)) / Math.max(1e-4, 1.0 - (CliffEdge + CliffW));
                P = PlatH * (1.0 - Smoothstep(0.76, 1.0, T));
            }
            if (Steps > 0 && P > PlatH + 0.04 && P < 0.94)
            {
                P = ApplyTerraceSteps(P, Steps, 0.45);
            }
            Prof = P * LandRootFade;
            break;
        }

        // -----------------------------------------------------------------------------------------------------------------
        // 21. CLIFFSIDE SWITCHBACK PATHWAY (3D) — Real-scale mountain trail shelf + uphill cliff wall + 3D gallery overhang
        // -----------------------------------------------------------------------------------------------------------------
        case 'cliff_pathway':
        {
            const HalfL = Math.max(24.0, L * 0.5);
            const Ul = Wu / HalfL;
            if (Math.abs(Ul) >= 1.04) return _EvalOut;

            const InfScale = Clamp(Number(Params.influenceScale) ?? 1.35, 0.25, 4.0);
            const Gallery = Clamp(Number(Params.cliffGallery) ?? 0.58, 0.0, 1.0);
            const SwBacks = Clamp(Number(Params.switchbacks) ?? 1.5, 0.0, 4.0);
            const BendAmp = Clamp(Number(Params.bendAmplitude) ?? 0.42, 0.0, 1.0);
            const RetSteep = Clamp(Number(Params.retainingSteepness) ?? 0.86, 0.35, 0.98);
            const GradeRise = Clamp(Number(Params.gradeRise) ?? 0.65, 0.0, 1.0);

            const CenterV = BendAmp * HalfL * 0.32 * Math.sin(Ul * Math.PI * Math.max(0.5, SwBacks) + (Seed % 173) * 0.01);
            const DV = Wv - CenterV;
            const HalfPath = Math.max(2.0, R * 0.5);
            const SkirtW = Math.max(4.0, R * (0.85 + 1.35 * InfScale));
            const EndEnv = Smoothstep(1.04, 0.84, Math.abs(Ul));
            if (EndEnv <= 1e-4) return _EvalOut;

            // Ascending walkable trail deck elevation along the switchback
            const TrailProf = 0.24 + 0.44 * GradeRise * (0.5 + 0.5 * Ul);
            let P = 0.0;
            if (Math.abs(DV) <= HalfPath)
            {
                // Crisp flat walkable path deck
                P = TrailProf;
            }
            else if (DV < -HalfPath)
            {
                // Downhill side: steep retaining embankment & rock talus buttress controlled by retainingSteepness + influenceScale
                const OutT = Clamp((-DV - HalfPath) / SkirtW, 0.0, 1.0);
                if (OutT >= 1.0) return _EvalOut;
                const DropExp = Mix(1.15, 3.6, RetSteep);
                P = TrailProf * Math.pow(1.0 - Smoothstep(0.0, 1.0, OutT), DropExp);
            }
            else
            {
                // Uphill side: towering cliff wall rising cleanly above the trail so 3D rock gallery cuts an overhanging ceiling
                const UpDist = DV - HalfPath;
                const CliffW = Math.max(4.0, R * (0.28 + 0.22 * (1.0 - RetSteep)));
                const CliffCrownW = Math.max(10.0, R * (1.15 + 1.15 * InfScale));
                const UpT = UpDist / (CliffW + CliffCrownW);
                if (UpT >= 1.0) return _EvalOut;
                const CliffTop = Math.min(1.0, TrailProf + 0.34 + 0.30 * Gallery);
                const RiseFrac = Smoothstep(0.0, CliffW, UpDist);
                const BackFade = 1.0 - Smoothstep(CliffW + CliffCrownW * 0.32, CliffW + CliffCrownW, UpDist);
                P = Mix(TrailProf, CliffTop, RiseFrac) * BackFade;
            }
            Prof = P * EndEnv;
            break;
        }

        // -----------------------------------------------------------------------------------------------------------------
        // 22. SUBTERRANEAN KARST CAVE & CAVERN (3D) — Exterior entrance mouth cut (interior void is True-3D volumetric SDF!)
        // -----------------------------------------------------------------------------------------------------------------
        case 'cave_cavern':
        {
            const HalfL = Math.max(24.0, L * 0.5);
            const Ul = Wu / HalfL;
            if (Ul < -1.08 || Ul > 0.35) return _EvalOut;

            const PortalW = Clamp(Number(Params.portalWidth) ?? 0.56, 0.25, 1.0);
            const Curve = Clamp(Number(Params.passageCurve) ?? 0.32, -1.0, 1.0);
            const Apron = Clamp(Number(Params.mouthApron) ?? 0.45, 0.05, 1.0);
            const CenterV = Curve * R * Math.sin(Ul * Math.PI * 1.15);
            const AbsV = Math.abs(Wv - CenterV);

            // Recessed exterior approach grotto at the front portal (-1.05 .. -0.25) while keeping overhead rock intact deeper in!
            const MouthLen = Mix(0.28, 0.66, Apron);
            const MouthStart = -1.04;
            const MouthEnd = MouthStart + MouthLen;
            if (Ul > MouthEnd + 0.18) return _EvalOut;

            const LongEnv = Smoothstep(MouthStart - 0.04, MouthStart + MouthLen * 0.36, Ul)
                          * Smoothstep(MouthEnd + 0.16, MouthEnd - MouthLen * 0.22, Ul);
            const MouthHalfW = Math.max(3.0, R * (PortalW * 0.78 + 0.42 * Apron));
            const CrossT = AbsV / MouthHalfW;
            if (CrossT >= 1.25 || LongEnv <= 1e-4) return _EvalOut;

            const CrossEnv = 1.0 - Smoothstep(0.42, 1.22, CrossT);
            // Carves down smoothly to cave floor elevation right in front of the cave mouth
            Prof = (0.78 + 0.22 * Apron) * LongEnv * CrossEnv;
            break;
        }

        default:
            return _EvalOut;
    }

    // Add natural geological micro-detail scaled cleanly by RockDetail & active profile
    if (Det > 0.005 && Math.abs(Prof) > 0.015)
    {
        const Freq = 3.8 / Math.max(45.0, R);
        const Micro = RidgedDetail2D(Wu * Freq, Wv * Freq, Seed + 911);
        const Env = Clamp(Math.abs(Prof), 0.0, 1.0);
        // Preserve crisp flat mesa top and dune slipface clarity while adding craggy flank relief
        const MicroGain = (SpecId === 'barchan_dune' || SpecId === 'star_dune') ? 0.06 : 0.16;
        Prof += Micro * Det * MicroGain * Env * (1.0 - 0.35 * Env);
    }

    _EvalOut.value = Prof * H;
    _EvalOut.active = true;
    _EvalOut.waterMask = Water;
    return _EvalOut;
}

/**
 * Evaluates a full `landform` layer (across all resolved instances) at world coordinate `(Wx, Wz)`.
 * Uses smooth-max / smooth-min aggregation across overlapping multi-instance ranges/clusters/fields!
 */
export function EvaluateLandformLayerAt(Layer, Resolved, Wx, Wz)
{
    const B = Resolved.bounds;
    if (Wx < B.minX || Wx > B.maxX || Wz < B.minZ || Wz > B.maxZ)
    {
        return { active: false, value: 0.0, waterMask: 0.0 };
    }

    const SpecId = Layer.archetype;
    const Params = Layer.params || {};
    const Det = Clamp(Number(Layer.rockDetail) ?? 0.24, 0.0, 1.0);
    const Insts = Resolved.instances;
    const BlendK = Math.max(6.0, Number(Layer.smoothK) || 22.0);
    const IsBipolar = SpecId === 'impact_crater' || SpecId === 'rift_graben' || SpecId === 'atoll_lagoon';

    let AnyActive = false;
    let AccVal = 0.0;
    let AccWater = 0.0;

    for (let I = 0; I < Insts.length; ++I)
    {
        const Inst = Insts[I];
        if (Wx < Inst.minX || Wx > Inst.maxX || Wz < Inst.minZ || Wz > Inst.maxZ) continue;
        const Res = EvaluateSingleLandformInstance(SpecId, Inst, Params, Det, Wx, Wz);
        if (!Res.active) continue;

        if (!AnyActive)
        {
            AccVal = Res.value;
            AccWater = Res.waterMask;
            AnyActive = true;
        }
        else
        {
            if (IsBipolar)
            {
                // Sum signed bipolar landforms cleanly so overlapping craters/rifts compose naturally!
                AccVal += Res.value;
            }
            else
            {
                // Smooth alluvial union across neighboring peaks/mesas/dunes in a range or cluster!
                AccVal = SdfSmoothMax(AccVal, Res.value, BlendK * 0.55);
            }
            if (Res.waterMask > AccWater) AccWater = Res.waterMask;
        }
    }

    return { active: AnyActive, value: AccVal, waterMask: AccWater };
}

/**
 * Applies a Landform Layer's Smooth SDF CSG Combine Mode onto the terrain elevation `CurH`.
 */
export function ApplyLandformCombine(CurH, BaseTop, SlabBottom, RawValue, Layer, MaskW, ShoreProtect)
{
    const Combine = Layer.combine || 'smooth_union';
    const K = Math.max(1.0, Number(Layer.smoothK) || 24.0);
    const W = Clamp(MaskW * ShoreProtect, 0.0, 1.0);
    if (W <= 1e-4) return CurH;

    let TargetH = CurH;
    switch (Combine)
    {
        case 'add':
            TargetH = CurH + RawValue;
            break;
        case 'sub':
            TargetH = CurH - Math.abs(RawValue);
            break;
        case 'smooth_union':
        {
            // True Heightfield SDF Smooth Union: y - smax(CurH, BaseTop + RawValue, K)
            const CandH = BaseTop + RawValue;
            TargetH = SdfSmoothMax(CurH, CandH, K);
            break;
        }
        case 'smooth_sub':
        {
            // True Heightfield SDF Smooth Subtract: smoothly carves canyon/valley with rounded lip!
            const CarvedH = CurH - Math.abs(RawValue);
            TargetH = SdfSmoothMin(CurH, CarvedH, K * 0.65);
            break;
        }
        case 'max':
            TargetH = Math.max(CurH, BaseTop + RawValue);
            break;
        case 'min':
            TargetH = Math.min(CurH, BaseTop + RawValue);
            break;
        case 'lerp':
            TargetH = BaseTop + RawValue;
            break;
        default:
            TargetH = CurH + RawValue;
            break;
    }

    return Math.max(SlabBottom + 0.5, Mix(CurH, TargetH, W));
}

/*==========================================================================================================================================
               TRUE-3D VOLUMETRIC SDF LANDFORM PRIMITIVES (SLOT CANYON · KARST CENOTE · SEA-CLIFF WAVE NOTCH)
==========================================================================================================================================*/
/**
 * Collects active True-3D Volumetric SDF landform primitives on `Region` so `BuildVolumetric3DBricks`
 * allocates sparse Dual-Surface-Nets 3D bricks ONLY inside their bounding boxes!
 */
export function CollectVolumetricLandformPrimitives(Region, Rt, SeaLevel = 0.0)
{
    if (!Region || !Region.stack || !Rt) return [];
    const B = Region.bounds;
    const Out = [];

    const SampleSurfH = (Wx, Wz) =>
    {
        const Ix = Clamp(Math.round((Wx - B.x) / Rt.stepX), 0, Rt.nx - 1);
        const Iz = Clamp(Math.round((Wz - B.z) / Rt.stepZ), 0, Rt.nz - 1);
        return Rt.heights[Iz * Rt.nx + Ix];
    };

    for (const Layer of Region.stack)
    {
        if (!Layer || Layer.enabled === false || Layer.type !== 'landform') continue;
        const Spec = GetLandformSpec(Layer.archetype);
        if (!Spec.hasVolumetric3D) continue;
        const IsCaveCavern = Spec.id === 'cave_cavern';
        const IsCliffPath = Spec.id === 'cliff_pathway';
        const Overhang = IsCaveCavern
            ? 1.0
            : IsCliffPath
                ? Clamp(Number(Layer.params?.cliffGallery) ?? 0.58, 0.0, 1.0)
                : Clamp(Number(Layer.params?.overhangAmount) ?? 0.0, 0.0, 1.0);
        if (Overhang <= 0.04) continue;

        const Resolved = ResolveLandformInstances(Layer);
        const Params = Layer.params || {};
        const BlendM = Math.max(3.0, Math.min(18.0, Number(Layer.smoothK) * 0.35 || 8.0));

        for (const Inst of Resolved.instances)
        {
            // Skip instances completely outside the terrain region bounds
            if (Inst.maxX < B.x || Inst.minX > B.x + B.width || Inst.maxZ < B.z || Inst.minZ > B.z + B.depth) continue;

            // Estimate ambient rim height perpendicular to strike/azimuth (plus radial cardinals) so RimH hits intact plateau!
            const PerpX = -Inst.sinA * Inst.radius * 0.96;
            const PerpZ = Inst.cosA * Inst.radius * 0.96;
            const RimH = Math.max(
                SampleSurfH(Inst.cx + PerpX, Inst.cz + PerpZ),
                SampleSurfH(Inst.cx - PerpX, Inst.cz - PerpZ),
                SampleSurfH(Inst.cx + Inst.radius * 0.92, Inst.cz),
                SampleSurfH(Inst.cx - Inst.radius * 0.92, Inst.cz),
                SampleSurfH(Inst.cx, Inst.cz + Inst.radius * 0.92),
                SampleSurfH(Inst.cx, Inst.cz - Inst.radius * 0.92),
                SeaLevel + 25.0
            );
            const FloorY = Math.max(Rt.slabBottom + 4.0, RimH - Inst.height * 0.96);

            if (Spec.id === 'slot_canyon')
            {
                const MAmp = Clamp(Number(Params.meanderAmp) ?? 0.56, 0.05, 1.25);
                const MFreq = Clamp(Number(Params.meanderFreq) ?? 2.6, 0.6, 6.0);
                const Flr = Clamp(Number(Params.floorRatio) ?? 0.18, 0.04, 0.40);
                const Waves = Clamp(Math.round(Number(Params.waveFlutes) || 3), 1, 6);
                const HalfL = Math.max(40.0, Inst.length * 0.5);
                const R = Inst.radius;

                // Tightly bound the brick to the active sinuous slot corridor!
                const CorridorHalfW = R * (MAmp + 0.55);
                const ReachX = Math.abs(HalfL * Inst.cosA) + Math.abs(CorridorHalfW * Inst.sinA) + 18.0;
                const ReachZ = Math.abs(HalfL * Inst.sinA) + Math.abs(CorridorHalfW * Inst.cosA) + 18.0;

                Out.push({
                    kind: 'slot_canyon',
                    minX: Inst.cx - ReachX, maxX: Inst.cx + ReachX,
                    minY: FloorY - 12.0,    maxY: RimH + 18.0,
                    minZ: Inst.cz - ReachZ, maxZ: Inst.cz + ReachZ,
                    evalSdf(Px, Py, Pz, CurD)
                    {
                        const Dx = Px - Inst.cx, Dz = Pz - Inst.cz;
                        const U = Dx * Inst.cosA + Dz * Inst.sinA;
                        const V = -Dx * Inst.sinA + Dz * Inst.cosA;
                        const Ul = U / HalfL;
                        if (Math.abs(Ul) >= 1.0) return CurD;

                        const CenterV = MAmp * R * (Math.sin(Ul * Math.PI * MFreq + (Inst.seed % 314) * 0.01) +
                                                    0.28 * Math.sin(Ul * Math.PI * MFreq * 2.1 + 1.4));
                        const EndEnv = Smoothstep(1.0, 0.80, Math.abs(Ul));
                        const ElevT = Clamp((Py - FloorY) / Math.max(12.0, RimH - FloorY), 0.0, 1.0);

                        // True 3D Overhang Alcove: wider subterranean belly + undulating Navajo sandstone wall waves!
                        const Belly = Math.sin(Math.PI * ElevT); // Peaks mid-wall, pinches inward at rim -> overhanging ceiling!
                        const WaveShift = Math.sin(ElevT * Math.PI * Waves * 2.0 + Ul * 5.2) * R * 0.14 * Overhang * Belly;
                        const UndercutR = R * (Flr + 0.42 * Overhang * Belly) * EndEnv;
                        const DistFromSlot = Math.abs((V - CenterV) - WaveShift);

                        // Vertical capsule-like void spanning [FloorY .. RimH - TopLip]
                        const TopLip = RimH - Math.max(6.0, (RimH - FloorY) * 0.14);
                        const VertD = Math.max(FloorY - Py, Py - TopLip);
                        const VoidD = Math.max(DistFromSlot - UndercutR, VertD);
                        return SdfSmoothMax(CurD, -VoidD, BlendM);
                    }
                });
            }
            else if (Spec.id === 'karst_cenote')
            {
                const ShaftR = Clamp(Number(Params.shaftRadius) || 0.48, 0.18, 0.76);
                const Lobing = Clamp(Number(Params.lobing) ?? 0.18, 0.0, 0.48);
                const OuterR = Inst.radius * (ShaftR + 0.55 * Overhang + 0.22);

                Out.push({
                    kind: 'karst_cenote',
                    minX: Inst.cx - OuterR, maxX: Inst.cx + OuterR,
                    minY: FloorY - 12.0,    maxY: RimH + 16.0,
                    minZ: Inst.cz - OuterR, maxZ: Inst.cz + OuterR,
                    evalSdf(Px, Py, Pz, CurD)
                    {
                        const Dx = Px - Inst.cx, Dz = Pz - Inst.cz;
                        const U = Dx * Inst.cosA + Dz * Inst.sinA;
                        const V = (-Dx * Inst.sinA + Dz * Inst.cosA) / Inst.aspect;
                        const HorD = Math.hypot(U, V);
                        const Phi = Math.atan2(V, U);
                        const LobeMod = 1.0 + Lobing * (0.6 * Math.cos(4.0 * Phi + Inst.seed * 0.17) + 0.4 * Math.sin(3.0 * Phi));

                        const ElevT = Clamp((Py - FloorY) / Math.max(12.0, RimH - FloorY), 0.0, 1.0);
                        // Bell-shaped cavern expands underneath the limestone ceiling lip -> genuine 3D overhanging roof!
                        const ChamberBelly = Math.sin(Math.PI * Math.pow(ElevT, 0.78));
                        const ChamberR = Inst.radius * LobeMod * (ShaftR * 0.92 + 0.48 * Overhang * ChamberBelly);
                        const RoofY = RimH - Math.max(7.0, (RimH - FloorY) * (0.16 + 0.10 * Overhang));
                        const VertD = Math.max(FloorY - Py, Py - RoofY);
                        const CavernD = Math.max(HorD - ChamberR, VertD);
                        return SdfSmoothMax(CurD, -CavernD, BlendM * 0.85);
                    }
                });
            }
            else if (Spec.id === 'sea_cliff_headland')
            {
                const PlatW = Clamp(Number(Params.platformWidth) ?? 0.28, 0.06, 0.56);
                const PlatH = Clamp(Number(Params.platformHeight) ?? 0.11, 0.02, 0.30);
                const Steep = Clamp(Number(Params.cliffSteepness) ?? 0.92, 0.40, 0.99);
                const Lobing = Clamp(Number(Params.lobing) ?? 0.22, 0.0, 0.52);
                const HalfL = Math.max(40.0, Inst.length * 0.5);
                const R = Inst.radius;
                const CliffEdge = Math.max(0.25, 1.0 - PlatW - Mix(0.18, 0.036, Steep));

                const BaseTopY = SeaLevel + (Number(Region.baseElevation) ?? 3.0);
                const NotchCenterY = BaseTopY + Inst.height * (PlatH + 0.11);
                const NotchHalfH = Math.max(6.0, Inst.height * (0.09 + 0.08 * Overhang));

                const ReachX = Math.abs(HalfL * Inst.cosA) + Math.abs(R * Inst.sinA) + 22.0;
                const ReachZ = Math.abs(HalfL * Inst.sinA) + Math.abs(R * Inst.cosA) + 22.0;

                Out.push({
                    kind: 'sea_cliff_headland',
                    minX: Inst.cx - ReachX, maxX: Inst.cx + ReachX,
                    minY: NotchCenterY - NotchHalfH * 2.2, maxY: BaseTopY + Inst.height + 16.0,
                    minZ: Inst.cz - ReachZ, maxZ: Inst.cz + ReachZ,
                    evalSdf(Px, Py, Pz, CurD)
                    {
                        const Dx = Px - Inst.cx, Dz = Pz - Inst.cz;
                        const U = Dx * Inst.cosA + Dz * Inst.sinA;
                        const V = -Dx * Inst.sinA + Dz * Inst.cosA;
                        const Ul = U / HalfL;
                        if (Ul < -0.55 || Ul > 1.05) return CurD;

                        const TipTaper = Mix(1.05, 0.72, Smoothstep(-0.6, 0.95, Ul));
                        const LobeMod = 1.0 + Lobing * 0.32 * Math.sin(Ul * Math.PI * 3.0 + Inst.seed * 0.17);
                        const Vq = Math.abs(V) / Math.max(18.0, R * TipTaper * LobeMod);
                        const TipQ = Ul > 0.0 ? Ul : 0.0;
                        const EdgeQ = Math.pow(Math.pow(Vq, 3.0) + Math.pow(TipQ, 3.0), 1.0 / 3.0);

                        // Horizontal wave-cut sea notch biting inward into the cliff toe around CliffEdge!
                        const NotchDepthQ = 0.24 * Overhang;
                        const InwardQ = EdgeQ - (CliffEdge - NotchDepthQ);
                        const OutwardQ = (CliffEdge + 0.14) - EdgeQ;
                        const RingDistM = -Math.min(InwardQ, OutwardQ) * R;
                        const VertDistM = Math.abs(Py - NotchCenterY) - NotchHalfH;
                        const NotchVoidD = Math.max(RingDistM, VertDistM);
                        const LandFade = Smoothstep(-0.55, -0.15, Ul);
                        if (LandFade <= 0.01) return CurD;
                        return Mix(CurD, SdfSmoothMax(CurD, -NotchVoidD, BlendM * 0.75), LandFade);
                    }
                });
            }
            else if (Spec.id === 'cliff_pathway')
            {
                const InfScale = Clamp(Number(Params.influenceScale) ?? 1.35, 0.25, 4.0);
                const Gallery = Clamp(Number(Params.cliffGallery) ?? 0.58, 0.0, 1.0);
                const SwBacks = Clamp(Number(Params.switchbacks) ?? 1.5, 0.0, 4.0);
                const BendAmp = Clamp(Number(Params.bendAmplitude) ?? 0.42, 0.0, 1.0);
                const GradeRise = Clamp(Number(Params.gradeRise) ?? 0.65, 0.0, 1.0);
                const HalfL = Math.max(24.0, Inst.length * 0.5);
                const R = Inst.radius;
                const HalfPath = Math.max(2.0, R * 0.5);
                const BaseTopY = SeaLevel + (Number(Region.baseElevation) ?? 3.0);
                const GalleryH = Math.max(5.5, Inst.height * (0.16 + 0.14 * Gallery));
                const GalleryDepth = Math.max(4.5, HalfPath * (1.25 + 1.25 * Gallery) + InfScale * 1.4);

                const MaxSweep = BendAmp * HalfL * 0.34 + HalfPath + GalleryDepth + 14.0;
                const ReachX = Math.abs(HalfL * Inst.cosA) + Math.abs(MaxSweep * Inst.sinA) + 14.0;
                const ReachZ = Math.abs(HalfL * Inst.sinA) + Math.abs(MaxSweep * Inst.cosA) + 14.0;
                const MinY = BaseTopY + Inst.height * 0.16 - 8.0;
                const MaxY = BaseTopY + Inst.height * (0.28 + 0.44 * GradeRise) + GalleryH + 14.0;

                Out.push({
                    kind: 'cliff_pathway',
                    minX: Inst.cx - ReachX, maxX: Inst.cx + ReachX,
                    minY: MinY,             maxY: MaxY,
                    minZ: Inst.cz - ReachZ, maxZ: Inst.cz + ReachZ,
                    evalSdf(Px, Py, Pz, CurD)
                    {
                        const Dx = Px - Inst.cx, Dz = Pz - Inst.cz;
                        const U = Dx * Inst.cosA + Dz * Inst.sinA;
                        const V = -Dx * Inst.sinA + Dz * Inst.cosA;
                        const Ul = U / HalfL;
                        if (Math.abs(Ul) >= 0.98) return CurD;

                        const EndEnv = Smoothstep(0.98, 0.78, Math.abs(Ul));
                        const CenterV = BendAmp * HalfL * 0.32 * Math.sin(Ul * Math.PI * Math.max(0.5, SwBacks) + (Inst.seed % 173) * 0.01);
                        const DV = V - CenterV;
                        const TrailY = BaseTopY + Inst.height * (0.24 + 0.44 * GradeRise * (0.5 + 0.5 * Ul));

                        // Arched half-tunnel cliff gallery biting horizontally into uphill cliff (DV > 0) above the trail deck!
                        const ArchCenterV = HalfPath * 0.35;
                        const ArchRx = Math.max(3.0, GalleryDepth * EndEnv);
                        const ArchRy = Math.max(3.5, GalleryH * EndEnv);
                        const RelV = (DV - ArchCenterV) / ArchRx;
                        const RelY = (Py - TrailY) / ArchRy;

                        // Flat walkable trail floor at Py == TrailY, vaulted rock ceiling above (RelV^2 + RelY^2 <= 1)
                        const VaultDist = (Math.hypot(Math.max(0.0, RelV), Math.max(0.0, RelY)) - 1.0) * Math.min(ArchRx, ArchRy);
                        const FloorDist = TrailY - Py;
                        const OpenSideDist = -(DV + HalfPath * 0.85); // Open to valley air on downhill side
                        const Rough = CaveNoise3D(Px * 0.32, Py * 0.36, Pz * 0.32, Inst.seed + 53) * Math.min(2.2, ArchRy * 0.16) * Smoothstep(0.0, 0.35, RelY);
                        const VoidD = Math.max(VaultDist + Rough, FloorDist, OpenSideDist);
                        return SdfSmoothMax(CurD, -VoidD, Math.min(4.5, BlendM * 0.45));
                    }
                });
            }
            else if (Spec.id === 'cave_cavern')
            {
                const Swell = Clamp(Number(Params.chamberSwell) ?? 0.62, 0.0, 1.5);
                const Rough = Clamp(Number(Params.caveRoughness) ?? 0.48, 0.0, 1.0);
                const FlatFloor = Clamp(Number(Params.floorFlatness) ?? 0.72, 0.0, 1.0);
                const PortalW = Clamp(Number(Params.portalWidth) ?? 0.56, 0.25, 1.0);
                const Curve = Clamp(Number(Params.passageCurve) ?? 0.32, -1.0, 1.0);
                const HalfL = Math.max(24.0, Inst.length * 0.5);
                const R = Inst.radius;

                const RoofGroundH = Math.max(
                    SampleSurfH(Inst.cx, Inst.cz),
                    SampleSurfH(Inst.cx + Inst.cosA * HalfL * 0.42, Inst.cz + Inst.sinA * HalfL * 0.42),
                    RimH
                );
                const MouthGroundH = SampleSurfH(Inst.cx - Inst.cosA * HalfL * 0.86, Inst.cz - Inst.sinA * HalfL * 0.86);
                const VaultH = Math.max(4.5, Math.min(Inst.height, Math.max(8.0, (RoofGroundH - Rt.slabBottom) * 0.58)));
                const RoofRock = Math.max(6.0, VaultH * 0.32);
                const CaveFloorY = Math.max(Rt.slabBottom + 4.5, Math.min(MouthGroundH + 1.5, RoofGroundH - VaultH - RoofRock));

                const MaxHalfW = R * (1.0 + Swell + Math.abs(Curve)) + 16.0;
                const ReachX = Math.abs(HalfL * Inst.cosA) + Math.abs(MaxHalfW * Inst.sinA) + 16.0;
                const ReachZ = Math.abs(HalfL * Inst.sinA) + Math.abs(MaxHalfW * Inst.cosA) + 16.0;

                Out.push({
                    kind: 'cave_cavern',
                    minX: Inst.cx - ReachX, maxX: Inst.cx + ReachX,
                    minY: CaveFloorY - 8.0, maxY: CaveFloorY + VaultH * (1.25 + 0.35 * Swell) + 14.0,
                    minZ: Inst.cz - ReachZ, maxZ: Inst.cz + ReachZ,
                    evalSdf(Px, Py, Pz, CurD)
                    {
                        const Dx = Px - Inst.cx, Dz = Pz - Inst.cz;
                        const U = Dx * Inst.cosA + Dz * Inst.sinA;
                        const V = -Dx * Inst.sinA + Dz * Inst.cosA;
                        const Ul = U / HalfL;
                        if (Ul < -1.05 || Ul > 1.02) return CurD;

                        const CenterV = Curve * R * Math.sin(Ul * Math.PI * 1.15);
                        const DV = V - CenterV;

                        // Swelling central karst chamber + tapered blind back grotto + flared entrance mouth
                        const BackEnv = Smoothstep(1.02, 0.68, Ul);
                        const PortalBlend = Smoothstep(-0.95, 0.10, Ul);
                        const ChamberDome = Math.sin(Clamp((Ul + 0.85) / 1.85, 0.0, 1.0) * Math.PI);
                        const LocalW = Math.max(2.5, R * Mix(PortalW, 1.0 + Swell * ChamberDome, PortalBlend) * BackEnv);
                        const LocalH = Math.max(3.5, VaultH * (0.72 + 0.42 * ChamberDome * (0.4 + 0.6 * Swell)) * BackEnv);

                        // Slight upward ramp right at the exterior portal so the mouth exits into open air cleanly
                        const MouthLift = Smoothstep(-0.55, -1.02, Ul) * Math.max(0.0, MouthGroundH - CaveFloorY) * 0.55;
                        const LocalFloorY = CaveFloorY + MouthLift;

                        // Arch cross-section: flat walkable floor when floorFlatness -> 1, rounded karst tube when -> 0
                        const ArchCenterY = LocalFloorY + LocalH * Mix(0.48, 0.14, FlatFloor);
                        const EffRy = Math.max(2.5, LocalH * Mix(0.52, 0.86, FlatFloor));
                        const Qx = DV / LocalW;
                        const Qy = (Py - ArchCenterY) / EffRy;
                        const TubeD = (Math.hypot(Qx, Qy) - 1.0) * Math.min(LocalW, EffRy);
                        const FlatFloorD = LocalFloorY - Py;
                        const BaseCrossD = FlatFloor > 0.05 ? SdfSmoothMax(TubeD, FlatFloorD, Math.max(0.6, (1.0 - FlatFloor) * 4.5)) : TubeD;

                        // End caps along Ul (open front entrance past -1.02, rounded grotto back at +0.96)
                        const BackCapD = (Ul - 0.96) * HalfL;
                        const FrontCapD = (-1.04 - Ul) * HalfL;

                        // Organic 3D limestone stalactite & scalloped wall displacement (gentle near flat walkable floor)
                        const FloorQuiet = Mix(1.0, Smoothstep(0.0, LocalH * 0.35, Py - LocalFloorY), FlatFloor * 0.82);
                        const WallDisp = CaveNoise3D(Px * (2.6 / Math.max(8.0, R)), Py * (2.8 / Math.max(8.0, VaultH)), Pz * (2.6 / Math.max(8.0, R)), Inst.seed)
                                       * Rough * Math.min(LocalW, LocalH) * 0.34 * FloorQuiet;

                        const CaveVoidD = Math.max(BaseCrossD + WallDisp, BackCapD, FrontCapD);
                        return SdfSmoothMax(CurD, -CaveVoidD, Math.min(5.0, BlendM * 0.45));
                    }
                });
            }
        }
    }

    return Out;
}

/*==========================================================================================================================================
                                     8 CURATED BASIC LANDFORM SHOWCASE WORLDS (1-CLICK TEMPLATES)
==========================================================================================================================================*/
export const LANDFORM_SHOWCASE_WORLDS = [
    {
        id: 'universal-archipelago',
        name: 'Universal Landform Archipelago',
        badge: 'ALL 6 FAMILIES',
        desc: '3 Islands showcasing Stratovolcano + Caldera Lake, Alpine Horn Range + Fjord, and Mesas + 3D Overhanging Slot Canyon'
    },
    {
        id: 'volcanic-caldera',
        name: 'Volcanic Island & Caldera Lake',
        badge: 'VOLCANO',
        desc: 'Stratovolcano with auto-filled crater lake, parasitic shield cone & outer coral atoll reef'
    },
    {
        id: 'alpine-fjord',
        name: 'Alpine Horn Massif & Glacial Fjord',
        badge: 'ALPINE',
        desc: 'Pyramidal alpine horn chain, Yosemite Half-Dome granite cliff, knife-edge arête & U-shaped fjord'
    },
    {
        id: 'mesa-slot-canyon',
        name: 'Monument Mesas & 3D Slot Canyon',
        badge: '3D CANYON',
        desc: 'Flat-topped sandstone mesas, stepped Grand-Canyon butte cluster & true 3D overhanging slot canyon'
    },
    {
        id: 'erg-dune-sea',
        name: 'Sahara & Namib Erg Dune Sea',
        badge: 'DUNES',
        desc: 'Wind-swept crescent barchan dune field, towering multi-arm star dunes & tilted desert cuesta'
    },
    {
        id: 'tectonic-crater',
        name: 'Tectonic Fault, Fold Belt & Crater',
        badge: 'TECTONIC',
        desc: 'Appalachian anticline folds, thrust fault scarp, sunken rift graben & complex impact crater'
    },
    {
        id: 'karst-sea-cliffs',
        name: '3D Karst Cenote & Wave-Notch Cliffs',
        badge: '3D COAST',
        desc: 'True 3D overhanging limestone cenote sinkhole, wave-cut sea-cliff headland & coastal atoll'
    },
    {
        id: 'caves-cliff-pathways',
        name: 'Cliff Pathways, Mounds & 3D Caves',
        badge: 'NEW 3D',
        desc: 'Real-scale steep cliffside gallery pathway, organic spline-drawn earthen mound, natural footpath & 3D limestone cave network'
    }
];

/**
 * Populates `World` with one of the 8 curated Universal Basic Landform Showcase Worlds.
 * Returns `{ masks, regions, focusLandformLayerId }` so the studio can immediately activate its 3D Landform Gizmo!
 */
export function SeedLandformShowcaseWorld(World, ShowcaseId = 'universal-archipelago', EvaluateRegionFn = null)
{
    World.maskLayers = [];
    World.regions = [];
    World.seaLevel = 0.0;
    World.oceanVisible = true;

    const Masks = [];
    const Regions = [];
    let FocusLayerId = null;

    if (ShowcaseId === 'universal-archipelago')
    {
        // ISLAND 1 (South-Center): Volcanic Stratovolcano + Caldera Lake + Outer Atoll Ring
        const M1 = World.addMaskLayer({ id: 'mask-lf-volcano', name: 'Mask 01 · Volcanic Atoll', color: '#f0935b' });
        World.paintCapsuleMeters(M1, [-120, 560], [160, 580], 560, 'paint', 1.0, 0.24, 4101);
        const B1 = World.computeLayerPaintedBounds(M1, 90.0);
        const LfVolcano = CreateLandformLayer('stratovolcano', {
            name: 'Mount Caldera (Stratovolcano)',
            centerX: 20, centerZ: 565, radius: 425, height: 248, azimuth: 38, rockDetail: 0.26,
            combine: 'smooth_union', smoothK: 26,
            params: { slopeCurve: 1.52, craterRadius: 0.27, craterDepth: 0.48, rimLipBoost: 0.15, resurgentDome: 0.14, ridgeCount: 12, ridgeSharpness: 0.30, breachDepth: 0.0 },
            falloff: { mode: 'soft', distance: 120, edgeFloor: 0.15 }
        });
        const LfAtoll = CreateLandformLayer('atoll_lagoon', {
            name: 'Outer Volcanic Reef Ring',
            centerX: 20, centerZ: 565, radius: 560, height: 42, azimuth: -35, rockDetail: 0.22,
            combine: 'smooth_union', smoothK: 20,
            params: { ringRadius: 0.80, ringWidth: 0.22, lagoonDepth: 0.12, breachDepth: 0.78, breachWidth: 0.30, ridgeCount: 7 },
            falloff: { mode: 'none', distance: 120, edgeFloor: 1.0 }
        });
        const R1 = World.addTerrainRegion({
            id: 'terrain-lf-volcano', name: 'Landform 01 · Stratovolcano & Atoll',
            maskLayerId: M1.id, color: '#f0935b', bounds: B1, resolution: 144,
            baseElevation: 3.5, slabThickness: 6.5, shorelineBevel: 18.0, maxRelief: 280.0,
            stack: [LfAtoll, LfVolcano]
        });
        Masks.push(M1); Regions.push(R1);
        FocusLayerId = LfVolcano.id;

        // ISLAND 2 (NW): Alpine Pyramidal Horn Chain + Half-Dome + U-Glacial Fjord
        const M2 = World.addMaskLayer({ id: 'mask-lf-alpine', name: 'Mask 02 · Alpine Massif', color: '#5ac8fa' });
        World.paintPolygonMeters(M2, [
            [-1480, -960], [-620, -1080], [-140, -680], [-220, -40], [-740, 120], [-1420, -120], [-1620, -540]
        ], false, 0.26, 5201);
        const B2 = World.computeLayerPaintedBounds(M2, 90.0);
        const LfAlps = CreateLandformLayer('alpine_peak', {
            name: 'Alpine Horn Range (Chain)',
            placementMode: 'range', instanceCount: 5, spread: 860, rangeCurvature: 0.24, scaleTaper: 0.36, jitter: 0.28,
            centerX: -880, centerZ: -560, radius: 340, height: 245, azimuth: 24, rockDetail: 0.32,
            combine: 'smooth_union', smoothK: 34, seed: 5211,
            params: { slopeCurve: 1.38, ridgeCount: 4, ridgeSharpness: 0.72, ridgeTwist: 0.26, cirqueDepth: 0.38, summitFlatness: 0.03 },
            falloff: { mode: 'soft', distance: 220, edgeFloor: 0.05 }
        });
        const LfDome = CreateLandformLayer('granite_dome', {
            name: 'Sheared Granite Half-Dome',
            centerX: -540, centerZ: -250, radius: 245, height: 175, azimuth: -48, aspectRatio: 1.24, rockDetail: 0.20,
            combine: 'smooth_union', smoothK: 22, seed: 5309,
            params: { slopeCurve: 0.52, shearStrength: 0.58, shearSteepness: 0.88, terraceSteps: 3, terraceStrength: 0.24 },
            falloff: { mode: 'soft', distance: 120, edgeFloor: 0.1 }
        });
        const LfFjord = CreateLandformLayer('u_glacial_valley', {
            name: 'U-Shaped Glacial Fjord',
            centerX: -920, centerZ: -310, radius: 155, length: 780, height: 105, azimuth: -18, rockDetail: 0.18,
            combine: 'smooth_sub', smoothK: 24, seed: 5401,
            params: { meanderAmp: 0.18, meanderFreq: 1.0, floorRatio: 0.42, wallExponent: 3.4, shoulderHeight: 0.14, headwallSteepness: 0.76 },
            falloff: { mode: 'none', distance: 100, edgeFloor: 1.0 }
        });
        const R2 = World.addTerrainRegion({
            id: 'terrain-lf-alpine', name: 'Landform 02 · Alpine Horns & Fjord',
            maskLayerId: M2.id, color: '#5ac8fa', bounds: B2, resolution: 144,
            baseElevation: 4.0, slabThickness: 6.5, shorelineBevel: 18.0, maxRelief: 280.0,
            stack: [LfAlps, LfDome, LfFjord]
        });
        Masks.push(M2); Regions.push(R2);

        // ISLAND 3 (East): Stratified Mesas, Monument Butte & True-3D Overhanging Slot Canyon!
        const M3 = World.addMaskLayer({ id: 'mask-lf-mesa', name: 'Mask 03 · Canyon Plateau', color: '#e8c27a' });
        World.paintPolygonMeters(M3, [
            [320, -960], [1160, -980], [1380, -480], [1240, 120], [580, 180], [260, -240], [340, -640]
        ], false, 0.20, 6301);
        const B3 = World.computeLayerPaintedBounds(M3, 90.0);
        const LfMesa = CreateLandformLayer('mesa_plateau', {
            name: 'Flat-Topped Sandstone Mesa',
            centerX: 820, centerZ: -440, radius: 440, height: 148, azimuth: 16, aspectRatio: 1.18, rockDetail: 0.20,
            combine: 'smooth_union', smoothK: 18, seed: 6311,
            params: { footprintRoundness: 3.2, lobing: 0.22, cliffSteepness: 0.88, talusRatio: 0.30, terraceSteps: 6, terraceStrength: 0.62, dipDeg: 1.5 },
            falloff: { mode: 'none', distance: 100, edgeFloor: 1.0 }
        });
        const LfButte = CreateLandformLayer('stepped_butte', {
            name: 'Monument Spire Butte',
            centerX: 540, centerZ: -710, radius: 195, height: 188, azimuth: 40, aspectRatio: 1.1, rockDetail: 0.22,
            combine: 'smooth_union', smoothK: 20, seed: 6411,
            params: { crownRatio: 0.28, terraceSteps: 7, terraceStrength: 0.82, cliffSteepness: 0.90, ridgeCount: 7, ridgeSharpness: 0.44 },
            falloff: { mode: 'none', distance: 100, edgeFloor: 1.0 }
        });
        const LfSlot = CreateLandformLayer('slot_canyon', {
            name: '3D Overhanging Slot Canyon',
            centerX: 830, centerZ: -430, radius: 88, length: 620, height: 98, azimuth: 32, rockDetail: 0.16,
            combine: 'sub', smoothK: 14, seed: 6521,
            params: { meanderAmp: 0.54, meanderFreq: 2.5, floorRatio: 0.18, cliffSteepness: 0.92, overhangAmount: 0.68, waveFlutes: 3 },
            falloff: { mode: 'none', distance: 100, edgeFloor: 1.0 }
        });
        const R3 = World.addTerrainRegion({
            id: 'terrain-lf-mesa', name: 'Landform 03 · Mesas & 3D Slot Canyon',
            maskLayerId: M3.id, color: '#e8c27a', bounds: B3, resolution: 144,
            baseElevation: 6.0, slabThickness: 6.5, shorelineBevel: 4.0, maxRelief: 240.0,
            stack: [LfMesa, LfButte, LfSlot]
        });
        Masks.push(M3); Regions.push(R3);
    }
    else
    {
        // Single-focus rich 1.8 × 1.5 km showcase landmass tailored to the selected landform theme!
        const Mask = World.addMaskLayer({ id: `mask-${ShowcaseId}`, name: `Mask · ${ShowcaseId}`, color: '#58b982' });
        if (ShowcaseId === 'volcanic-caldera' || ShowcaseId === 'karst-sea-cliffs')
        {
            World.paintCapsuleMeters(Mask, [-240, -60], [260, 80], 680, 'paint', 1.0, 0.24, 7101);
        }
        else
        {
            World.paintPolygonMeters(Mask, [
                [-860, -680], [0, -760], [880, -620], [940, 0], [820, 680], [0, 740], [-840, 640], [-940, 20]
            ], false, 0.20, 7201);
        }
        const Bounds = World.computeLayerPaintedBounds(Mask, 85.0);
        let Stack = [];
        let RegName = 'Landform Showcase';
        let ShoreBevel = 16.0;
        let BaseElev = 4.0;

        if (ShowcaseId === 'volcanic-caldera')
        {
            RegName = 'Volcanic Island & Caldera Lake';
            const Primary = CreateLandformLayer('stratovolcano', {
                name: 'Stratovolcano + Caldera Lake',
                centerX: -40, centerZ: -20, radius: 540, height: 275, azimuth: 32, rockDetail: 0.28,
                combine: 'smooth_union', smoothK: 28,
                params: { slopeCurve: 1.56, craterRadius: 0.28, craterDepth: 0.52, rimLipBoost: 0.16, resurgentDome: 0.16, ridgeCount: 12, ridgeSharpness: 0.34, breachDepth: 0.0 }
            });
            const Shield = CreateLandformLayer('shield_volcano', {
                name: 'Parasitic Shield Cone',
                centerX: 390, centerZ: 180, radius: 340, height: 125, azimuth: -20, rockDetail: 0.22,
                combine: 'smooth_union', smoothK: 28,
                params: { slopeCurve: 0.60, craterRadius: 0.16, craterDepth: 0.28, ridgeCount: 6, terraceSteps: 4, terraceStrength: 0.38 }
            });
            const Reef = CreateLandformLayer('atoll_lagoon', {
                name: 'Outer Barrier Atoll Reef',
                centerX: 0, centerZ: 10, radius: 740, height: 38, azimuth: -35, rockDetail: 0.20,
                combine: 'smooth_union', smoothK: 18,
                params: { ringRadius: 0.86, ringWidth: 0.16, lagoonDepth: 0.08, breachDepth: 0.85, breachWidth: 0.34, ridgeCount: 8 }
            });
            Stack = [Reef, Shield, Primary];
            FocusLayerId = Primary.id;
        }
        else if (ShowcaseId === 'alpine-fjord')
        {
            RegName = 'Alpine Horn Massif & Glacial Fjord';
            const Range = CreateLandformLayer('alpine_peak', {
                name: 'Alpine Pyramidal Horn Range',
                placementMode: 'range', instanceCount: 6, spread: 1180, rangeCurvature: 0.26, scaleTaper: 0.34, jitter: 0.26,
                centerX: -60, centerZ: -180, radius: 390, height: 265, azimuth: 16, rockDetail: 0.34,
                combine: 'smooth_union', smoothK: 36, seed: 8101,
                params: { slopeCurve: 1.42, ridgeCount: 4, ridgeSharpness: 0.74, ridgeTwist: 0.28, cirqueDepth: 0.40, summitFlatness: 0.02 },
                falloff: { mode: 'soft', distance: 220, edgeFloor: 0.04 }
            });
            const Arete = CreateLandformLayer('hogback_arete', {
                name: 'Knife-Edge Arête Spine',
                centerX: 80, centerZ: 220, radius: 220, length: 920, height: 185, azimuth: -14, rockDetail: 0.28,
                combine: 'smooth_union', smoothK: 26, seed: 8201,
                params: { crestSharpness: 0.86, asymmetry: 0.28, strikeBow: 0.18, ridgeCount: 6, colDepth: 0.30, spurStrength: 0.46 },
                falloff: { mode: 'soft', distance: 160, edgeFloor: 0.08 }
            });
            const Dome = CreateLandformLayer('granite_dome', {
                name: 'Half-Dome Glacial Monolith',
                centerX: -380, centerZ: 260, radius: 265, height: 195, azimuth: -52, aspectRatio: 1.24, rockDetail: 0.20,
                combine: 'smooth_union', smoothK: 24, seed: 8301,
                params: { slopeCurve: 0.54, shearStrength: 0.58, shearSteepness: 0.88, terraceSteps: 3, terraceStrength: 0.25 }
            });
            const Fjord = CreateLandformLayer('u_glacial_valley', {
                name: 'U-Shaped Glacial Fjord Trough',
                centerX: 60, centerZ: 40, radius: 190, length: 1220, height: 125, azimuth: 12, rockDetail: 0.18,
                combine: 'smooth_sub', smoothK: 26, seed: 8401,
                params: { meanderAmp: 0.16, meanderFreq: 1.1, floorRatio: 0.44, wallExponent: 3.4, shoulderHeight: 0.15, headwallSteepness: 0.78 }
            });
            Stack = [Range, Arete, Dome, Fjord];
            FocusLayerId = Range.id;
        }
        else if (ShowcaseId === 'mesa-slot-canyon')
        {
            RegName = 'Monument Mesas & 3D Slot Canyon';
            ShoreBevel = 6.0;
            BaseElev = 8.0;
            const Mesa = CreateLandformLayer('mesa_plateau', {
                name: 'Grand Sandstone Mesa Plateau',
                centerX: 60, centerZ: 40, radius: 560, height: 155, azimuth: 14, aspectRatio: 1.18, rockDetail: 0.22,
                combine: 'smooth_union', smoothK: 20, seed: 9101,
                params: { footprintRoundness: 3.1, lobing: 0.24, cliffSteepness: 0.88, talusRatio: 0.30, terraceSteps: 7, terraceStrength: 0.66, dipDeg: 1.5 }
            });
            const Buttes = CreateLandformLayer('stepped_butte', {
                name: 'Monument Valley Butte Cluster',
                placementMode: 'cluster', instanceCount: 4, spread: 580, scaleTaper: 0.38, jitter: 0.28,
                centerX: -480, centerZ: -290, radius: 225, height: 192, azimuth: 32, rockDetail: 0.24,
                combine: 'smooth_union', smoothK: 22, seed: 9201,
                params: { crownRatio: 0.26, terraceSteps: 7, terraceStrength: 0.82, cliffSteepness: 0.90, ridgeCount: 7, ridgeSharpness: 0.44 }
            });
            const Slot = CreateLandformLayer('slot_canyon', {
                name: 'True-3D Overhanging Slot Canyon',
                centerX: 80, centerZ: 30, radius: 96, length: 820, height: 108, azimuth: 28, rockDetail: 0.16,
                combine: 'sub', smoothK: 14, seed: 9301,
                params: { meanderAmp: 0.56, meanderFreq: 2.8, floorRatio: 0.18, cliffSteepness: 0.92, overhangAmount: 0.72, waveFlutes: 3 }
            });
            Stack = [Mesa, Buttes, Slot];
            FocusLayerId = Slot.id;
        }
        else if (ShowcaseId === 'erg-dune-sea')
        {
            RegName = 'Sahara & Namib Erg Dune Sea';
            BaseElev = 10.0;
            const Cuesta = CreateLandformLayer('tilted_cuesta', {
                name: 'Desert Homoclinal Escarpment',
                centerX: -420, centerZ: -320, radius: 280, length: 920, height: 145, azimuth: 34, rockDetail: 0.26,
                combine: 'smooth_union', smoothK: 28, seed: 10101,
                params: { dipSlopeRatio: 0.72, cliffSteepness: 0.88, lobing: 0.22, terraceSteps: 5, terraceStrength: 0.52, strikeBow: 0.12 }
            });
            const Barchans = CreateLandformLayer('barchan_dune', {
                name: 'Crescent Barchan Dune Field',
                placementMode: 'field', instanceCount: 9, spread: 1220, scaleTaper: 0.35, jitter: 0.34,
                centerX: 80, centerZ: 120, radius: 245, height: 64, azimuth: 36, aspectRatio: 1.14, rockDetail: 0.10,
                combine: 'smooth_union', smoothK: 18, seed: 10201,
                params: { slipfaceSteepness: 0.88, crestSharpness: 0.86, hornLength: 0.76, hornCurvature: 0.68, duneWaves: 1 }
            });
            const Stars = CreateLandformLayer('star_dune', {
                name: 'Namib Star Dune Cluster',
                placementMode: 'cluster', instanceCount: 4, spread: 560, scaleTaper: 0.38, jitter: 0.30,
                centerX: 340, centerZ: -180, radius: 295, height: 96, azimuth: 22, rockDetail: 0.10,
                combine: 'smooth_union', smoothK: 22, seed: 10301,
                params: { armCount: 5, armTwist: 0.52, slipfaceSteepness: 0.86, crestSharpness: 0.88, armSpan: 0.84 }
            });
            Stack = [Cuesta, Barchans, Stars];
            FocusLayerId = Stars.id;
        }
        else if (ShowcaseId === 'tectonic-crater')
        {
            RegName = 'Tectonic Fault, Fold Belt & Impact Crater';
            BaseElev = 58.0;
            const Folds = CreateLandformLayer('fold_belt', {
                name: 'Appalachian Anticline Fold Belt',
                centerX: -260, centerZ: -160, radius: 390, length: 1120, height: 135, azimuth: 24, rockDetail: 0.26,
                combine: 'smooth_union', smoothK: 24, seed: 11101,
                params: { foldCount: 4.0, foldAsymmetry: 0.38, breachDepth: 0.24, strikeBow: 0.20, crestSharpness: 0.62 },
                falloff: { mode: 'soft', distance: 180, edgeFloor: 0.15 }
            });
            const Fault = CreateLandformLayer('fault_scarp', {
                name: 'Tectonic Thrust Fault Scarp',
                centerX: 280, centerZ: -280, radius: 290, length: 920, height: 148, azimuth: -22, rockDetail: 0.24,
                combine: 'add', smoothK: 20, seed: 11201,
                params: { cliffSteepness: 0.88, rolloverAmp: 0.24, ridgeCount: 9, ridgeSharpness: 0.44, strikeBow: 0.08 }
            });
            const Graben = CreateLandformLayer('rift_graben', {
                name: 'Tectonic Rift Graben Valley',
                centerX: -120, centerZ: 310, radius: 250, length: 1020, height: 68, azimuth: 12, rockDetail: 0.18,
                combine: 'add', smoothK: 18, seed: 11301,
                params: { floorRatio: 0.42, cliffSteepness: 0.86, terraceSteps: 3, rimLipBoost: 0.36, strikeBow: 0.08 }
            });
            const Crater = CreateLandformLayer('impact_crater', {
                name: 'Complex Impact Crater',
                centerX: 310, centerZ: 190, radius: 340, height: 96, azimuth: 0, rockDetail: 0.18,
                combine: 'add', smoothK: 16, seed: 11401,
                params: { craterRadius: 0.52, craterDepth: 0.74, rimHeight: 0.44, centralPeak: 0.32, terraceSteps: 2, ejectaRays: 0.40 }
            });
            Stack = [Folds, Fault, Graben, Crater];
            FocusLayerId = Crater.id;
        }
        else if (ShowcaseId === 'caves-cliff-pathways')
        {
            RegName = 'Cliff Pathways, Mounds & 3D Caves';
            ShoreBevel = 10.0;
            BaseElev = 14.0;
            const CliffMesa = CreateLandformLayer('mesa_plateau', {
                name: 'Sandstone Cliff Escarpment',
                centerX: -140, centerZ: -110, radius: 420, height: 128, azimuth: 18, aspectRatio: 1.15, rockDetail: 0.22,
                combine: 'smooth_union', smoothK: 20, seed: 13101,
                params: { footprintRoundness: 2.8, lobing: 0.22, cliffSteepness: 0.90, talusRatio: 0.28, terraceSteps: 6, terraceStrength: 0.58, dipDeg: 1.2 }
            });
            const MoundSpline = {
                id: 'layer-showcase-mound-1',
                type: 'spline',
                name: 'Organic Earthen Mound (Spline)',
                enabled: true,
                opacity: 1.0,
                combine: 'add',
                smoothK: 16.0,
                seed: 13111,
                splineMode: 'mound',
                width: 44.0,
                amount: 26.0,
                bankSmooth: 0.68,
                meander: 0.10,
                influenceScale: 1.85,
                moundRoundness: 0.56,
                endTaper: 0.74,
                lumpiness: 0.34,
                points: [
                    [130, 290, 18.0],
                    [235, 165, 34.0],
                    [315, 25, 42.0],
                    [275, -135, 28.0]
                ],
                falloff: { mode: 'none', distance: 200.0, edgeFloor: 0.0, points: [[0, 0], [0.35, 0.28], [0.72, 0.84], [1, 1]] },
                heightMask: { enabled: false, minElev: 0.0, maxElev: 300.0, minSlope: 0.0, maxSlope: 90.0 }
            };
            const NaturalPath = {
                id: 'layer-showcase-pathway-1',
                type: 'spline',
                name: 'Foothill Natural Footpath (5.5m)',
                enabled: true,
                opacity: 1.0,
                combine: 'lerp',
                smoothK: 10.0,
                seed: 13121,
                splineMode: 'pathway',
                width: 5.5,
                amount: 1.2,
                bankSmooth: 0.58,
                meander: 0.08,
                influenceScale: 1.45,
                points: [
                    [360, 280, 15.0],
                    [270, 235, 18.0],
                    [205, 190, 21.0],
                    [155, 145, 24.0]
                ],
                falloff: { mode: 'none', distance: 200.0, edgeFloor: 0.0, points: [[0, 0], [0.35, 0.28], [0.72, 0.84], [1, 1]] },
                heightMask: { enabled: false, minElev: 0.0, maxElev: 300.0, minSlope: 0.0, maxSlope: 90.0 }
            };
            const CliffPath = {
                id: 'layer-showcase-cliffpath-1',
                type: 'spline',
                name: 'Steep Cliffside Gallery Pathway (9m · 3D)',
                enabled: true,
                opacity: 1.0,
                combine: 'lerp',
                smoothK: 10.0,
                seed: 13131,
                splineMode: 'cliff_path',
                width: 9.0,
                amount: 9.5,
                bankSmooth: 0.52,
                meander: 0.04,
                influenceScale: 1.50,
                cliffGallery: 0.78,
                retainingDepth: 0.85,
                points: [
                    [155, 145, 24.0],
                    [40, 205, 52.0],
                    [-120, 220, 82.0],
                    [-275, 165, 112.0],
                    [-320, 35, 140.0]
                ],
                falloff: { mode: 'none', distance: 200.0, edgeFloor: 0.0, points: [[0, 0], [0.35, 0.28], [0.72, 0.84], [1, 1]] },
                heightMask: { enabled: false, minElev: 0.0, maxElev: 300.0, minSlope: 0.0, maxSlope: 90.0 }
            };
            const CaveSpline = {
                id: 'layer-showcase-cave-1',
                type: 'spline',
                name: 'True-3D Limestone Cave Passage (15m)',
                enabled: true,
                opacity: 1.0,
                combine: 'sub',
                smoothK: 10.0,
                seed: 13141,
                splineMode: 'cave',
                width: 15.0,
                amount: 12.0,
                bankSmooth: 0.35,
                meander: 0.0,
                influenceScale: 1.0,
                caveRoughness: 0.54,
                chamberSwell: 0.72,
                floorFlatness: 0.78,
                points: [
                    [265, -80, 44.0],
                    [150, -95, 46.0],
                    [10, -115, 50.0],
                    [-135, -135, 54.0],
                    [-285, -210, 48.0]
                ],
                falloff: { mode: 'none', distance: 200.0, edgeFloor: 0.0, points: [[0, 0], [0.35, 0.28], [0.72, 0.84], [1, 1]] },
                heightMask: { enabled: false, minElev: 0.0, maxElev: 300.0, minSlope: 0.0, maxSlope: 90.0 }
            };
            const KarstCavern = CreateLandformLayer('cave_cavern', {
                name: 'Subterranean Karst Grotto (3D)',
                centerX: -120, centerZ: -280, radius: 22, length: 155, height: 22, azimuth: 82, aspectRatio: 1.0, rockDetail: 0.18,
                combine: 'sub', smoothK: 10, seed: 13201,
                params: { chamberSwell: 0.68, caveRoughness: 0.50, floorFlatness: 0.76, portalWidth: 0.60, passageCurve: 0.28, mouthApron: 0.55 }
            });
            Stack = [CliffMesa, MoundSpline, NaturalPath, CliffPath, CaveSpline, KarstCavern];
            FocusLayerId = CliffPath.id;
        }
        else // 'karst-sea-cliffs'
        {
            RegName = '3D Karst Cenote & Wave-Notch Cliffs';
            ShoreBevel = 6.0;
            BaseElev = 12.0;
            const Headland = CreateLandformLayer('sea_cliff_headland', {
                name: 'Wave-Notch Sea-Cliff Headland',
                centerX: -80, centerZ: -40, radius: 360, length: 980, height: 138, azimuth: 18, rockDetail: 0.22,
                combine: 'smooth_union', smoothK: 18, seed: 12101,
                params: { cliffSteepness: 0.92, platformWidth: 0.28, platformHeight: 0.12, overhangAmount: 0.68, lobing: 0.22, terraceSteps: 5 }
            });
            const Cenote = CreateLandformLayer('karst_cenote', {
                name: 'True-3D Overhanging Karst Cenote',
                centerX: -190, centerZ: -60, radius: 205, height: 105, azimuth: 0, aspectRatio: 1.08, rockDetail: 0.18,
                combine: 'sub', smoothK: 14, seed: 12201,
                params: { shaftRadius: 0.48, funnelSlope: 0.32, cliffSteepness: 0.94, overhangAmount: 0.74, lobing: 0.18 }
            });
            const Gorge = CreateLandformLayer('v_gorge', {
                name: 'Coastal Fluvial Gorge',
                centerX: 160, centerZ: 180, radius: 135, length: 620, height: 78, azimuth: 42, rockDetail: 0.20,
                combine: 'smooth_sub', smoothK: 20, seed: 12301,
                params: { meanderAmp: 0.30, meanderFreq: 1.4, wallSlope: 1.1, floorRatio: 0.14, asymmetry: 0.22, longitudinalTilt: 0.18 }
            });
            Stack = [Headland, Cenote, Gorge];
            FocusLayerId = Cenote.id;
        }

        const Reg = World.addTerrainRegion({
            id: `terrain-${ShowcaseId}`,
            name: RegName,
            maskLayerId: Mask.id,
            color: '#e8c27a',
            bounds: Bounds,
            resolution: 148,
            baseElevation: BaseElev,
            slabThickness: 6.5,
            shorelineBevel: ShoreBevel,
            maxRelief: 280.0,
            stack: Stack
        });
        Masks.push(Mask);
        Regions.push(Reg);
    }

    if (typeof EvaluateRegionFn === 'function')
    {
        for (const R of Regions) EvaluateRegionFn(World, R, FocusLayerId);
    }

    return { masks: Masks, regions: Regions, focusLandformLayerId: FocusLayerId };
}
