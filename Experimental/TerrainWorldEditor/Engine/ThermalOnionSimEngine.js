/*==========================================================================================================================================
                                                     THERMALONIONSIMENGINE.JS
==========================================================================================================================================*/
// Focused Pure-SDF Weathering Simulation Engine for BOTH 3D Landscapes (512 Lookdev · 1K/2K/4K Production) AND 3D Rocks (RockFormation 2.0):
//
//   1. Thermal Cracks & Pitting (`thermal_cracks`):
//      - Irwin V-tipped finite skin-depth cracks with exponential attenuation `exp(-d / skinDepth)` (core stays 100% solid)
//      - Solar thermal shock ΔT & directional insolation bias (`N · SunDir`)
//      - Hierarchical 90° T-junction thermal crazing (`evalHierarchical90Crazing3D`: Tier-1 continuous + Tier-2 90° arrests + Tier-3 splits)
//      - Domain-warped 3D Voronoi rock joints + secondary dendritic hairline splinters (`evalPlanarCleavage3D`)
//      - Hallet-Walder ice & thermal pitting (multi-scale frost-shattered spall cavities nucleated along cracks & exposed rock faces)
//
//   2. Onion-Skin Exfoliation ("Onion Peel") (`onion_peel`):
//      - Multi-tier (2..6, default 4) concentric spheroidal depth-band exfoliation shells (`hShell`)
//      - Asymmetric fanned terrace widths (tight stacked multi-layer rock ledges on one flank, broad cracked aprons on the other)
//      - Shell-confined polygonal plate joints stopping flat on top of the underlying shell
//      - Deep overhanging undercut parting slots (`wSlot`) tucked beneath every broken shell lip
//      - Convex spall peeling + smooth rounded fresh corestone beneath aged weathered outer husks
//
// Zero triangle-mesh proxies, zero Mesh->SDF — 100% Pure-SDF geometry & matching GPU shader parity!

import {
    clamp,
    mix,
    smoothstep,
    smin,
    smax,
    chamferMax,
    chamferSub,
    scalarField3D,
    fbm3D,
    evalPlanarCleavage3D,
    evalHierarchical90Crazing3D
} from './RockCliff/Core/SpatialNoise3D.js';
import { ComputeRegionMaskSdf2D } from './WorldMask2D.js';
import { EvaluateTerrainRegion, StitchAdjacentRegionBorders } from './TerrainLayerStack.js';

/*==========================================================================================================================================
                                            NODE CATALOG, RESOLUTION TIERS & BOX SCOPES
==========================================================================================================================================*/
export const WEATHER_SIM_CATALOG = [
    {
        type: 'thermal_cracks',
        name: 'Thermal Cracks & Pitting',
        shortBadge: 'CRACKS · PIT',
        glyph: 'Activity',
        accent: '#f08c4a',
        desc: 'Irwin V-tipped skin-depth cracks exp(-d/skinDepth), hierarchical 90° T-junction crazing, 3D Voronoi joints & Hallet–Walder ice/thermal pitting.',
        defaultParams: {
            strength: 0.88,
            thermalDeltaT: 58.0,
            directionalBias: 0.55,
            skinDepth: 0.54,
            crazing90: 0.84,
            crazingSpacing: 0.56,     // meters on 3D rocks (auto-scaled to 12..28m on km-scale landscapes)
            voronoiJoints: 0.56,
            pittingStrength: 0.68,
            pitScale: 1.0,
            seed: 4109
        },
        landscapeDefaultParams: {
            strength: 0.90,
            thermalDeltaT: 60.0,
            directionalBias: 0.52,
            skinDepth: 3.4,           // meters on landscape cliffs/domes
            crazing90: 0.86,
            crazingSpacing: 16.0,     // meters between Tier-1 polygon master cracks on terrain
            voronoiJoints: 0.62,
            pittingStrength: 0.72,
            pitScale: 1.0,
            seed: 4109
        }
    },
    {
        type: 'onion_peel',
        name: 'Onion-Skin Exfoliation',
        shortBadge: 'ONION PEEL',
        glyph: 'Layers',
        accent: '#e8c27a',
        desc: 'Concentric depth-band exfoliation shells, undercut parting slots, shell-confined plate cracks, convex spall peeling & rounded corestone.',
        defaultParams: {
            strength: 0.90,
            shellCount: 4,
            shellThickness: 1.0,
            undercutDepth: 1.05,
            plateJoints: 0.80,
            corestoneRounding: 0.62,
            spallAsymmetry: 0.78,
            seed: 5217
        },
        landscapeDefaultParams: {
            strength: 0.92,
            shellCount: 4,
            shellThickness: 1.0,
            undercutDepth: 1.05,
            plateJoints: 0.80,
            corestoneRounding: 0.65,
            spallAsymmetry: 0.78,
            seed: 5217
        }
    }
];

export const WEATHER_SIM_TIERS = [
    { id: 'lookdev_512', label: 'Lookdev Preview · 512',   res: 512,  kind: 'lookdev' },
    { id: 'prod_1k',     label: 'Production · 1K (1024)',  res: 1024, kind: 'production' },
    { id: 'prod_2k',     label: 'Production · 2K (2048)',  res: 2048, kind: 'production' },
    { id: 'prod_4k',     label: 'Production · 4K (4096)',  res: 4096, kind: 'production' }
];

export const WEATHER_BOX_SCOPES = [
    { id: 'active_box',     label: '1 Landscape Box (Active)' },
    { id: 'selected_boxes', label: 'Selected Boxes (Shared Sun)' },
    { id: 'all_boxes',      label: 'All Landscape Boxes Together' }
];

export const ROCK_WEATHER_TIERS = [
    { id: 'live_raymarch', label: 'Live GPU SDF Raymarch (Infinite Res)', res: 72,  kind: 'lookdev' },
    { id: 'qef_lookdev',   label: 'QEF Mesh Lookdev · 88³',               res: 88,  kind: 'lookdev' },
    { id: 'qef_prod_high', label: 'QEF Production · 120³',                res: 120, kind: 'production' },
    { id: 'qef_prod_ultra',label: 'QEF Production Ultra · 148³',          res: 148, kind: 'production' }
];

export const ROCK_WEATHER_BOX_SCOPES = [
    { id: 'active_box',  label: '1 Rock Box (Active)' },
    { id: 'below_stack', label: 'Rock Layers Below' },
    { id: 'all_boxes',   label: 'All Rock Boxes Together' }
];

let _weatherNodeSeq = 1;

export function GetWeatherSimSpec(NodeType)
{
    return WEATHER_SIM_CATALOG.find(S => S.type === NodeType) || WEATHER_SIM_CATALOG[0];
}

export function IsWeatherSimType(NodeType)
{
    return NodeType === 'thermal_cracks' || NodeType === 'onion_peel';
}

export function GetWeatherSimTier(TierId)
{
    return WEATHER_SIM_TIERS.find(T => T.id === TierId) || WEATHER_SIM_TIERS[0];
}

export function CreateWeatherSimNode(NodeType, Overrides = {}, IsLandscape = true)
{
    const Spec = GetWeatherSimSpec(NodeType);
    const BaseP = IsLandscape ? Spec.landscapeDefaultParams : Spec.defaultParams;
    const Params = { ...BaseP, ...(Overrides.params || {}) };
    for (const K of Object.keys(BaseP))
    {
        if (Overrides[K] !== undefined) Params[K] = Overrides[K];
    }
    return {
        id: Overrides.id || `wsim-${NodeType}-${_weatherNodeSeq++}`,
        nodeType: Spec.type,
        name: Overrides.name || Spec.name,
        enabled: Overrides.enabled !== undefined ? !!Overrides.enabled : true,
        solo: !!Overrides.solo,
        params: Params
    };
}

export function CreateDefaultLandscapeWeatherNodes()
{
    return [
        CreateWeatherSimNode('onion_peel', { enabled: true }, true),
        CreateWeatherSimNode('thermal_cracks', { enabled: true }, true)
    ];
}

/*==========================================================================================================================================
                       SHARED PURE-SDF 3D ROCK WEATHERING EVALUATOR (1:1 PARITY WITH GPU RAYMARCH GLSL!)
==========================================================================================================================================*/
/**
 * Evaluates BOTH Onion-Skin Exfoliation (`onion_peel`) and Thermal Cracks & Pitting (`thermal_cracks`)
 * analytically in 3D Pure-SDF space on top of a macro rock SDF `dMacro` with surface normal `(nx, ny, nz)`.
 *
 * Matches `ROCK2_RAYMARCH_FS` GLSL line-for-line so Live 60 FPS GPU Raymarching and QEF Dual-Contour
 * mesh bakes produce identical sub-millimeter V-tip cracks, 90° T-junctions, Hallet-Walder pits,
 * and overhanging 4-tier concentric onion-skin exfoliation shells!
 *
 * @param {number} wx,wy,wz       World-space point
 * @param {number} dMacro         Signed distance to macro rock volume (< 0 inside)
 * @param {number} nx,ny,nz       Unit outward surface normal of macro rock
 * @param {object} boxBounds      `{ cx, cy, cz, rx, ry, rz, scale }` reference rock box bounds
 * @param {number[]} sunDir       Normalized 3-vector toward sun
 * @param {object|null} thermalP  Active `thermal_cracks` params or null
 * @param {object|null} onionP    Active `onion_peel` params or null
 * @param {boolean} onionFirst    Whether onion_peel executes before thermal_cracks in layer stack
 * @param {object|null} outMeta   Optional `{ freshBoost, cavityAO, pitMask, shellEdge }` output
 * @returns {number} Modified Pure-SDF signed distance
 */
export function evalRockWeatheringSdf3D(
    wx, wy, wz,
    dMacro,
    nx, ny, nz,
    boxBounds,
    sunDir,
    thermalP,
    onionP,
    onionFirst = true,
    outMeta = null
)
{
    if (outMeta)
    {
        outMeta.freshBoost = 0.0;
        outMeta.cavityAO = 1.0;
        outMeta.pitMask = 0.0;
        outMeta.shellEdge = 0.0;
    }

    const HasOnion = onionP && (onionP.strength ?? 0.0) > 0.01;
    const HasThermal = thermalP && (thermalP.strength ?? 0.0) > 0.01;
    if (!HasOnion && !HasThermal) return dMacro;

    const S = Math.max(1.2, boxBounds.scale || 5.0);
    const Cx = boxBounds.cx || 0.0;
    const Cy = boxBounds.cy || 0.0;
    const Cz = boxBounds.cz || 0.0;
    const Rx = Math.max(0.6, boxBounds.rx || S * 0.5);
    const Ry = Math.max(0.6, boxBounds.ry || S * 0.5);
    const Rz = Math.max(0.6, boxBounds.rz || S * 0.5);

    const MaxSkin = HasThermal ? Math.max(0.08, thermalP.skinDepth ?? 0.54) * 1.45 : 0.10;
    const MaxShellBand = HasOnion ? S * (0.022 * Math.max(2, Math.min(6, Math.round(onionP.shellCount ?? 4))) * (onionP.shellThickness ?? 1.0) * 1.35) : 0.08;
    const MaxDepth = Math.max(MaxSkin, MaxShellBand, S * 0.14);

    if (dMacro > S * 0.075 || dMacro < -MaxDepth) return dMacro;

    let d = dMacro;
    let curMacro = dMacro;
    let freshBoost = 0.0;
    let shellAgeFactor = 1.0;
    let cavityAO = 1.0;
    let pitMask = 0.0;
    let shellEdge = 0.0;

    // Local coordinates relative to rock box center
    const lx = wx - Cx;
    const ly = wy - Cy;
    const lz = wz - Cz;

    const ApplyOnion = () =>
    {
        if (!HasOnion) return;
        const Str = clamp(onionP.strength ?? 0.90, 0.0, 1.0);
        const ExfAct = smoothstep(0.05, 0.92, Str);
        if (ExfAct <= 0.001) return;

        const ShellN = clamp(Math.round(onionP.shellCount ?? 4), 2, 6);
        const ThickMul = clamp(onionP.shellThickness ?? 1.0, 0.35, 2.4);
        const UndercutMul = clamp(onionP.undercutDepth ?? 1.05, 0.0, 1.8);
        const PlateK = clamp(onionP.plateJoints ?? 0.80, 0.0, 1.0);
        const CoreRound = clamp(onionP.corestoneRounding ?? 0.62, 0.0, 1.0);
        const Asym = clamp(onionP.spallAsymmetry ?? 0.78, 0.0, 1.0);
        const Salt = (onionP.seed ?? 5217) | 0;

        // Chunky granite exfoliation sheet thickness (~1.4%–2.2% of rock span * multiplier)
        const hShell = S * (0.0135 + 0.0072 * ExfAct) * ThickMul;
        const dExt0 = curMacro;

        if (dExt0 > -((ShellN + 0.95) * hShell) && dExt0 < S * 0.045)
        {
            // Normalized spheroidal radial frame wrapping ANY boulder/dome/cliff proportion cleanly
            const qx = lx / Rx;
            const qy = (wy - (Cy - Ry)) / Math.max(0.6, Ry * 2.0); // 0 at base, 1 at summit
            const qz = lz / Rz;

            // Two offset spall nucleation crowns -> realistic asymmetric royal-arches exfoliation windows!
            const r1 = Math.hypot((qx - 0.24 * Asym) * 0.90, (qy - 0.86) * 1.05, (qz - 0.22 * Asym) * 0.92);
            const r2 = Math.hypot((qx + 0.38 * Asym) * 0.94, (qy - 0.62) * 1.08, (qz + 0.34 * Asym) * 0.94) + 0.16;
            const rBase = smin(r1, r2, 0.15);

            // Multi-scale angular brittle rock-ledge deflection (steep granite scarps, zero smooth rings!)
            const wf1 = 1.0 / (S * 0.32);
            const wf2 = 1.0 / (S * 0.11);
            const wShared =
                0.15 * scalarField3D(lx * wf1, ly * wf1, lz * wf1, Salt + 491) +
                0.055 * (Math.abs(scalarField3D(lx * wf2, ly * wf2, lz * wf2, Salt + 499)) * 2.0 - 1.0);

            // Keep basal apron cradled in intact outer onion shells near rock base like a broken stone calyx!
            const basalHold = Math.max(0.0, 0.16 - qy) * 1.75;
            const rSpall = (rBase + wShared + basalHold) * S * 0.55;

            // Asymmetric fanned terrace widths: shells bunch into tight stacked ledges on one flank & fan wide on the other!
            const fanF = 1.0 / (S * 0.44);
            const kf = 1.0 / (S * 0.15);
            const fanBase = S * 0.095 * Asym * scalarField3D(lx * fanF, ly * fanF, lz * fanF, Salt + 503);
            const maxR = S * 0.52 * ExfAct;

            // Pre-evaluate shell-confined polygonal plate joints ONCE
            const pScale = (0.95 / S) * 3.8;
            let plateWallWorld = 1e6;
            let plateOpen = 0.0;
            if (PlateK > 0.01)
            {
                const pwx = 0.36 * scalarField3D(lx * pScale * 0.5, ly * pScale * 0.5, lz * pScale * 0.5, Salt + 563);
                const pwz = 0.36 * scalarField3D(lx * pScale * 0.5 + 4.8, ly * pScale * 0.5, lz * pScale * 0.5 - 3.1, Salt + 569);
                const plateClv = evalPlanarCleavage3D(lx * pScale + pwx, ly * pScale * 0.9, lz * pScale + pwz, 0.78, Salt + 577);
                plateWallWorld = plateClv.wallDist / pScale;
                plateOpen = smoothstep(-0.20, 0.36, scalarField3D(lx * pScale * 0.45, ly * pScale * 0.45, lz * pScale * 0.45, Salt + 587)) * PlateK;
            }

            // Inner rounded spheroidal corestone (ShellN layers deep, gently smoothed by CoreRound!)
            const coreSmoothBias = CoreRound * hShell * 0.42 * smoothstep(0.35, 0.95, rBase);
            let dOnionExt = dExt0 + ShellN * hShell - coreSmoothBias * 0.25;
            let onionFresh = 0.96 * ExfAct;
            let onionAge = 0.05;
            let localSlotAO = 1.0;

            const wSlot = hShell * 2.35 * UndercutMul; // deep overhanging undercut parting slot under every shell lip!
            let cumFan = 0.0;
            let prevDw = 1e9;

            // Evaluate outer-to-inner shell rims (`k = ShellN-1` outermost down to `k = 0` innermost)
            const dws = new Float32Array(ShellN);
            for (let idx = ShellN - 1; idx >= 0; --idx)
            {
                const fNoise = 0.5 + 0.5 * scalarField3D(
                    lx * fanF + (idx * 3.1 - 4.2),
                    ly * fanF - (idx * 2.3),
                    lz * fanF + (idx * 1.9 + 2.7),
                    Salt + 509 + idx * 17
                );
                if (idx < ShellN - 1)
                {
                    cumFan += S * (0.032 + 0.095 * mix(0.45, fNoise, Asym)) * ExfAct;
                }
                const kink = S * 0.026 * (Math.abs(scalarField3D(lx * kf + idx * 3.7, ly * kf, lz * kf - idx * 2.1, Salt + 511 + idx * 13)) * 2.0 - 1.0);
                let dw = (maxR + fanBase - cumFan) - (rSpall + kink);
                if (idx < ShellN - 1) dw = Math.min(prevDw - S * 0.020, dw);
                dws[idx] = dw;
                prevDw = dw;
            }

            for (let k = 0; k < ShellN; ++k)
            {
                const surfOff = (ShellN - 1 - k) * hShell;
                const dSurf = dExt0 + surfOff;
                const dw = dws[k];
                let dSlab = chamferMax(dSurf, dw, hShell * 0.14);

                // 1. Shell-confined polygonal plate joints stopping flat on top of Shell k-1
                if (plateOpen > 0.01)
                {
                    const rimStress = smoothstep(-S * 0.44, 0.0, dw) * plateOpen * (0.55 + 0.14 * k);
                    const plateAp = hShell * 0.26 * rimStress;
                    if (plateAp > 0.0010)
                    {
                        const cutPlate = Math.max(plateWallWorld - plateAp, (-dSurf) - hShell * 0.94);
                        dSlab = chamferSub(dSlab, cutPlate, plateAp * 0.40);
                    }
                }

                // 2. Deep overhanging basal unloading undercut slot right under Shell k's broken rim!
                if (wSlot > 0.002)
                {
                    const tSlot = clamp(1.0 + dw / wSlot, 0.0, 1.0);
                    if (tSlot > 0.001)
                    {
                        const aSlot = hShell * 0.27 * tSlot * clamp(UndercutMul, 0.4, 1.5);
                        const dSeamPlane = Math.abs(dSurf + hShell * 0.88);
                        const cutSlot = Math.max(Math.max(dSeamPlane - aSlot, (-dw) - wSlot), dw - 0.025);
                        dSlab = Math.max(dSlab, -cutSlot);
                        if (Math.abs(dSeamPlane) < aSlot * 2.4 && dw < 0.025 && dw > -wSlot)
                        {
                            localSlotAO = Math.min(localSlotAO, 1.0 - 0.72 * tSlot);
                        }
                    }
                }

                // Crisp lip highlight right along broken terrace rim
                if (Math.abs(dw) < hShell * 0.85 && Math.abs(dSurf) < hShell * 0.75)
                {
                    shellEdge = Math.max(shellEdge, smoothstep(hShell * 0.85, 0.0, Math.abs(dw)));
                }

                const blend = smoothstep(0.018, -0.018, dSlab - dOnionExt);
                if (dSlab < dOnionExt) dOnionExt = dSlab;
                const tierFrac = k / Math.max(1, ShellN - 1);
                const freshTier = (1.0 - tierFrac) * 0.72;
                const ageTier = 0.14 + 0.86 * tierFrac * tierFrac;
                onionFresh = mix(onionFresh, freshTier * ExfAct, blend);
                onionAge = mix(onionAge, ageTier, blend);
            }

            d = dOnionExt;
            curMacro = dOnionExt;
            freshBoost = Math.max(freshBoost, onionFresh);
            shellAgeFactor = mix(1.0, onionAge, ExfAct);
            cavityAO = Math.min(cavityAO, localSlotAO);
        }
    };

    const ApplyThermal = () =>
    {
        if (!HasThermal) return;
        const Str = clamp(thermalP.strength ?? 0.88, 0.0, 1.0);
        const DeltaT = clamp(thermalP.thermalDeltaT ?? 58.0, 8.0, 100.0);
        const ThermalNorm = clamp(DeltaT / 60.0, 0.15, 1.65) * Str;
        const DirBias = clamp(thermalP.directionalBias ?? 0.55, 0.0, 1.0);
        const SkinDepth = Math.max(0.06, thermalP.skinDepth ?? 0.54);
        const Crazing90 = clamp(thermalP.crazing90 ?? 0.84, 0.0, 1.0);
        const Spacing = Math.max(0.18, thermalP.crazingSpacing ?? 0.56);
        const VorStr = clamp(thermalP.voronoiJoints ?? 0.56, 0.0, 1.0);
        const PitStr = clamp(thermalP.pittingStrength ?? 0.68, 0.0, 1.0);
        const PitScale = clamp(thermalP.pitScale ?? 1.0, 0.30, 2.50);
        const Salt = (thermalP.seed ?? 4109) | 0;

        // Solar insolation directional stress gate (`N · SunDir`)
        const ndots = Math.max(0.0, nx * sunDir[0] + ny * sunDir[1] + nz * sunDir[2]);
        const sunGate = clamp(Math.pow(ndots, 1.20) + 0.14, 0.0, 1.0);
        const insol = mix(1.0, sunGate, DirBias) * ThermalNorm;

        // Irwin Finite Skin-Depth Exponential V-Tip Profile: `exp(-depth / skinDepth)` * finite V-wedge arrest!
        const tipDepth = SkinDepth * clamp(0.32 + 0.72 * insol, 0.18, 1.45) * (0.35 + 0.65 * shellAgeFactor);
        const depthIn = Math.max(0.0, -curMacro);
        if (depthIn > tipDepth * 1.15) return;

        const linTaper = Math.max(0.0, 1.0 - depthIn / Math.max(0.04, tipDepth));
        const expSkin = Math.exp(-depthIn / Math.max(0.04, tipDepth * 0.68));
        const vTaper = linTaper * (0.45 + 0.55 * expSkin) * shellAgeFactor;

        let crackProx = 0.0;

        // (1) Hierarchical 90° T-Junction Thermal Crazing (continuous Tier-1 + slab-local Tier-2 90° arrests + Tier-3 splits!)
        if (Crazing90 > 0.01 && insol > 0.02)
        {
            const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
            let u, v, w;
            if (ay >= ax && ay >= az)      { u = wx; v = wz; w = wy; }
            else if (ax >= az)             { u = wz; v = wy; w = wx; }
            else                           { u = wx; v = wy; w = wz; }

            const c90 = evalHierarchical90Crazing3D(u, v, w, Spacing, Salt + 211);
            const surfHalfAp90 = Spacing * 0.072 * Crazing90 * insol;
            if (surfHalfAp90 > 0.0012)
            {
                const ap1 = surfHalfAp90 * c90.mod1 * vTaper;
                const ap2 = surfHalfAp90 * c90.mod2 * vTaper;
                const cut1 = c90.tier1Dist - ap1;
                const cut2 = c90.tier2Dist * 1.12 - ap2;
                const cutOrg90 = Math.min(cut1, cut2);
                const effAp = Math.max(ap1, ap2);
                const cut90 = Math.max(cutOrg90, depthIn - tipDepth);
                const dPrev = d;
                d = chamferSub(d, cut90, effAp * 0.34);
                if (d > dPrev + 1e-5)
                {
                    const cDepth = clamp((d - dPrev) / Math.max(0.006, effAp * 1.8), 0.0, 1.0);
                    cavityAO = Math.min(cavityAO, 1.0 - 0.76 * cDepth);
                    freshBoost = Math.max(freshBoost, 0.55 * cDepth);
                }
                crackProx = Math.max(crackProx, smoothstep(Spacing * 0.24, 0.0, Math.min(c90.tier1Dist, c90.tier2Dist)));
            }
        }

        // (2) Organic Domain-Warped 3D Voronoi Rock Joints + Secondary Dendritic Hairline Splinters
        if (VorStr > 0.01)
        {
            const vorScale = (1.35 / S) * 4.2;
            const vx = lx * vorScale;
            const vy = ly * vorScale * 0.86;
            const vz = lz * vorScale;

            const wx0 = 0.38 * scalarField3D(vx * 0.55, vy * 0.55, vz * 0.55, Salt + 311)
                      + 0.12 * (Math.abs(scalarField3D(vx * 2.15, vy * 2.15, vz * 2.15, Salt + 317)) * 2.0 - 1.0);
            const wy0 = 0.36 * scalarField3D(vx * 0.55 + 5.2, vy * 0.55 - 2.8, vz * 0.55, Salt + 331)
                      + 0.12 * (Math.abs(scalarField3D(vx * 2.15 - 3.4, vy * 2.15, vz * 2.15, Salt + 337)) * 2.0 - 1.0);
            const wz0 = 0.38 * scalarField3D(vx * 0.55 - 4.1, vy * 0.55 + 6.3, vz * 0.55, Salt + 347)
                      + 0.12 * (Math.abs(scalarField3D(vx * 2.15, vy * 2.15 + 4.1, vz * 2.15, Salt + 353)) * 2.0 - 1.0);

            const clv = evalPlanarCleavage3D(vx + wx0, vy + wy0, vz + wz0, 0.76, Salt + 307);
            const worldWallDist = clv.wallDist / vorScale;

            const vorVit = scalarField3D(vx * 0.48 - 7.1, vy * 0.48 + 3.9, vz * 0.48, Salt + 367);
            const openVor = smoothstep(-0.14, 0.44, vorVit);
            const vorBridge = openVor * Math.sqrt(openVor)
                * (0.82 + 0.46 * Math.abs(scalarField3D(vx * 2.7, vy * 2.7, vz * 2.7, Salt + 379)));

            const surfHalfApVor = (0.012 + 0.034 * VorStr) * (0.45 + 0.55 * insol) * (S / 6.5) * vorBridge;
            if (surfHalfApVor > 0.0012)
            {
                const halfApVor = surfHalfApVor * vTaper;
                const cutVor = Math.max(worldWallDist - halfApVor, depthIn - tipDepth);
                const dPrev = d;
                d = chamferSub(d, cutVor, halfApVor * 0.36);
                if (d > dPrev + 1e-5)
                {
                    const cDepth = clamp((d - dPrev) / Math.max(0.006, halfApVor * 1.8), 0.0, 1.0);
                    cavityAO = Math.min(cavityAO, 1.0 - 0.72 * cDepth);
                    freshBoost = Math.max(freshBoost, 0.48 * cDepth);
                }
                crackProx = Math.max(crackProx, smoothstep(0.32, 0.0, clv.wallDist) * openVor);
            }

            // Secondary dendritic hairline splinters branching ONLY near primary open fissures!
            const nearPrimary = smoothstep(0.42, 0.02, clv.wallDist) * smoothstep(0.12, 0.60, vorBridge);
            if (nearPrimary > 0.04 && vTaper > 0.0)
            {
                const subScale = 2.45;
                const subClv = evalPlanarCleavage3D((vx + wx0 * 1.3) * subScale, (vy + wy0 * 1.3) * subScale, (vz + wz0 * 1.3) * subScale, 0.76, Salt + 389);
                const subWallWorld = subClv.wallDist / (vorScale * subScale);
                const subHalfAp = (0.005 + 0.014 * VorStr) * nearPrimary * vTaper * (S / 6.5);
                if (subHalfAp > 0.0010)
                {
                    const cutSub = Math.max(subWallWorld - subHalfAp, depthIn - tipDepth * 0.55);
                    d = chamferSub(d, cutSub, subHalfAp * 0.30);
                }
            }
        }

        // (3) Hallet–Walder Ice / Thermal Segregation Pitting (multi-scale frost-shattered spall cavities!)
        //     Concentrates along crack junctions & thermally cycled exposed faces — carves crisp concave spall bowls!
        if (PitStr > 0.01 && depthIn < tipDepth * 0.75)
        {
            const pFreq1 = (6.8 / S) / PitScale;
            const pFreq2 = (16.5 / S) / PitScale;
            const frostBias = clamp(0.42 + 0.58 * Math.max(0.0, ny) + 0.55 * crackProx, 0.20, 1.35);
            const pitGate = clamp(PitStr * (0.45 + 0.55 * insol) * frostBias * shellAgeFactor, 0.0, 1.4);

            // Macro spall bowls (Hallet-Walder frost pop-outs ~5–14 cm)
            const cPit1 = evalPlanarCleavage3D(wx * pFreq1, wy * pFreq1 * 1.15, wz * pFreq1, 0.85, Salt + 613);
            const active1 = smoothstep(0.28 - 0.34 * PitStr, 0.62 - 0.25 * PitStr, cPit1.cellRand * 0.5 + 0.5 + 0.25 * crackProx);
            const rad1 = (0.14 + 0.22 * active1) / pFreq1;
            const bowlDist1 = (cPit1.f1 / pFreq1) - rad1 * clamp(pitGate, 0.0, 1.15);

            // Micro frost/thermal vesicles (~2–5 cm)
            const cPit2 = evalPlanarCleavage3D(wx * pFreq2 + 7.1, wy * pFreq2 * 1.15, wz * pFreq2 - 4.3, 0.88, Salt + 641);
            const active2 = smoothstep(0.32 - 0.30 * PitStr, 0.70 - 0.20 * PitStr, cPit2.cellRand * 0.5 + 0.5 + 0.20 * crackProx);
            const rad2 = (0.13 + 0.20 * active2) / pFreq2;
            const bowlDist2 = (cPit2.f1 / pFreq2) - rad2 * clamp(pitGate, 0.0, 1.15);

            const pitDepthCap = Math.min(tipDepth * 0.42, S * 0.028 * PitScale * pitGate);
            const pitCut1 = Math.max(bowlDist1, depthIn - pitDepthCap);
            const pitCut2 = Math.max(bowlDist2, depthIn - pitDepthCap * 0.55);
            const pitCut = Math.min(pitCut1, pitCut2);

            if (pitCut < 0.015)
            {
                const dPrev = d;
                d = smax(d, -pitCut, S * 0.004 * PitScale);
                if (d > dPrev + 1e-5)
                {
                    const pHit = clamp((d - dPrev) / Math.max(0.004, pitDepthCap * 0.85), 0.0, 1.0);
                    pitMask = Math.max(pitMask, pHit);
                    cavityAO = Math.min(cavityAO, 1.0 - 0.56 * pHit);
                    freshBoost = Math.max(freshBoost, 0.38 * pHit);
                }
            }
        }
    };

    if (onionFirst) { ApplyOnion(); ApplyThermal(); }
    else            { ApplyThermal(); ApplyOnion(); }

    if (outMeta)
    {
        outMeta.freshBoost = clamp(freshBoost, 0.0, 1.0);
        outMeta.cavityAO = clamp(cavityAO, 0.16, 1.0);
        outMeta.pitMask = clamp(pitMask, 0.0, 1.0);
        outMeta.shellEdge = clamp(shellEdge, 0.0, 1.0);
    }
    return d;
}

/*==========================================================================================================================================
                     LANDSCAPE HIGH-RES (512 LOOKDEV · 1K/2K/4K PRODUCTION) THERMAL CRACKS & ONION-PEEL SOLVER
==========================================================================================================================================*/
export function ResolveTargetTerrainBoxes(World, Scope = 'active_box', ActiveRegionId = null, SelectedRegionIds = null)
{
    const Enabled = (World.regions || []).filter(R => R.enabled);
    if (Enabled.length === 0) return [];
    if (Scope === 'all_boxes') return Enabled;
    if (Scope === 'selected_boxes' && SelectedRegionIds && SelectedRegionIds.size > 0)
    {
        const Picks = Enabled.filter(R => SelectedRegionIds.has(R.id));
        if (Picks.length > 0) return Picks;
    }
    const Active = Enabled.find(R => R.id === ActiveRegionId) || Enabled[0];
    return Active ? [Active] : [];
}

function SampleBilinear(Grid, Nx, Nz, Fx, Fz)
{
    const Cx = clamp(Fx, 0, Nx - 1.0001);
    const Cz = clamp(Fz, 0, Nz - 1.0001);
    const X0 = Math.floor(Cx), Z0 = Math.floor(Cz);
    const X1 = Math.min(Nx - 1, X0 + 1), Z1 = Math.min(Nz - 1, Z0 + 1);
    const Tx = Cx - X0, Tz = Cz - Z0;
    const I00 = Z0 * Nx + X0, I10 = Z0 * Nx + X1;
    const I01 = Z1 * Nx + X0, I11 = Z1 * Nx + X1;
    const A = Grid[I00] + (Grid[I10] - Grid[I00]) * Tx;
    const B = Grid[I01] + (Grid[I11] - Grid[I01]) * Tx;
    return A + (B - A) * Tz;
}

/**
 * Allocates a compact high-res (`512` Lookdev, `1K`, `2K`, `4K`) weathering grid for one Terrain Bounds Box.
 * Stores float32 `h`/`h0`/`sdf2D` plus compact Uint8 channels (`cavity`, `pit`, `fresh`, `rind`, `edge`)
 * so even 4K (`4096×4096`) stays memory-lean and fast!
 */
export function CreateLandscapeWeatherState(World, Region, Options = {})
{
    const Tier = GetWeatherSimTier(Options.tierId || 'lookdev_512');
    const TargetRes = Math.max(64, Math.min(4096, Math.round(Options.resolution || Tier.res)));
    const B = Region.bounds;
    const Aspect = B.width / Math.max(1.0, B.depth);
    let Nx, Nz;
    if (Aspect >= 1.0)
    {
        Nx = TargetRes;
        Nz = Math.max(64, Math.round(TargetRes / Aspect));
    }
    else
    {
        Nz = TargetRes;
        Nx = Math.max(64, Math.round(TargetRes * Aspect));
    }
    const Count = Nx * Nz;
    const CellX = B.width / Math.max(1, Nx - 1);
    const CellZ = B.depth / Math.max(1, Nz - 1);

    if (!Region.runtime || Region.dirty) EvaluateTerrainRegion(World, Region, null);
    const Rt = Region.runtime;
    const BaseH = Rt.simBaseHeights && Rt.simBaseHeights.length === Rt.heights.length ? Rt.simBaseHeights : Rt.heights;

    // Resample baseline heights & 2D mask SDF onto high-res grid
    const H0 = new Float32Array(Count);
    const H  = new Float32Array(Count);
    const Sdf2D = ComputeRegionMaskSdf2D(World, Region, Nx, Nz);

    let MinH = 1e9, MaxH = -1e9;
    const ScaleX = (Rt.nx - 1) / Math.max(1, Nx - 1);
    const ScaleZ = (Rt.nz - 1) / Math.max(1, Nz - 1);
    for (let Z = 0; Z < Nz; ++Z)
    {
        const Row = Z * Nx;
        const Fz = Z * ScaleZ;
        for (let X = 0; X < Nx; ++X)
        {
            const Val = SampleBilinear(BaseH, Rt.nx, Rt.nz, X * ScaleX, Fz);
            H0[Row + X] = Val;
            H[Row + X] = Val;
            if (Sdf2D[Row + X] < 0.0)
            {
                if (Val < MinH) MinH = Val;
                if (Val > MaxH) MaxH = Val;
            }
        }
    }
    if (MinH > MaxH) { MinH = 0.0; MaxH = 100.0; }

    return {
        regionId: Region.id,
        tierId: Tier.id,
        resolution: TargetRes,
        nx: Nx,
        nz: Nz,
        count: Count,
        cellX: CellX,
        cellZ: CellZ,
        bounds: { ...B },
        seaLevel: World.seaLevel ?? 0.0,
        minH: MinH,
        maxH: MaxH,
        h0: H0,
        h: H,
        sdf2D: Sdf2D,
        // Compact 0..255 shading channels (safe up to 4K!)
        cavity: new Uint8Array(Count),      // deep V-tip crack & onion parting-slot cavity
        pit: new Uint8Array(Count),         // Hallet-Walder frost/thermal pitting bowls
        fresh: new Uint8Array(Count),       // fresh inner corestone & bright inner crack walls
        rind: new Uint8Array(Count),        // dark aged weathered outer husk
        shellEdge: new Uint8Array(Count),   // crisp sunlit terrace rim / spall lip
        activeMask: new Uint8Array(Count),  // active blend mask
        stats: {
            crackedCells: 0,
            pittedCells: 0,
            onionCells: 0,
            maxCarveM: 0.0,
            meshProxiesUsed: 0
        },
        lastElapsedMs: 0
    };
}

/**
 * Executes **Onion-Skin Exfoliation ("Onion Peel")** on a high-res (`512..4K`) landscape state.
 * Carves genuine 4-tier concentric fanned exfoliation shell steps, shell-confined polygonal plate seams,
 * deep undercut dark parting-slot shadow bands, convex spall peeling, and smooth rounded corestone crowns
 * across domes, ridges, escarpments, and rock buttresses!
 */
export function RunLandscapeOnionPeelPass(State, Params = {}, SunDir = [0.55, 0.72, 0.42])
{
    const Str = clamp(Params.strength ?? 0.92, 0.0, 1.0);
    if (Str <= 0.005) return;

    const { nx: Nx, nz: Nz, cellX: Cx, cellZ: Cz, bounds: B, h: H, h0: H0, sdf2D: Sdf, seaLevel } = State;
    const ShellN = clamp(Math.round(Params.shellCount ?? 4), 2, 6);
    const ThickMul = clamp(Params.shellThickness ?? 1.0, 0.35, 2.4);
    const UndercutMul = clamp(Params.undercutDepth ?? 1.05, 0.0, 1.8);
    const PlateK = clamp(Params.plateJoints ?? 0.80, 0.0, 1.0);
    const CoreRound = clamp(Params.corestoneRounding ?? 0.65, 0.0, 1.0);
    const Asym = clamp(Params.spallAsymmetry ?? 0.78, 0.0, 1.0);
    const Salt = (Params.seed ?? 5217) | 0;

    const Relief = Math.max(25.0, State.maxH - Math.max(seaLevel, State.minH));
    const Span = Math.max(200.0, Math.min(B.width, B.depth));
    // Vertical shell thickness scaled to terrain relief (~2.2–6.5m chunky granite exfoliation sheets!)
    const ShellStepM = clamp(Relief * 0.026, 1.6, 6.8) * ThickMul * (0.65 + 0.35 * Str);
    const Inv2Cx = 1.0 / (2.0 * Cx);
    const Inv2Cz = 1.0 / (2.0 * Cz);
    const LapStep = Math.max(2, Math.round(14.0 / Math.max(Cx, Cz)));

    // Keep clean read snapshot for Laplacian convexity & corestone rounding
    const HRead = H.slice();
    let OnionCells = 0;
    const pScale = 1.0 / clamp(Span * 0.038, 12.0, 42.0);
    const fanFreq = 1.0 / clamp(Span * 0.24, 95.0, 320.0);
    const kinkFreq = 1.0 / clamp(Span * 0.075, 28.0, 110.0);

    for (let Z = 1; Z < Nz - 1; ++Z)
    {
        const Row = Z * Nx;
        const Wz = B.z + Z * Cz;
        const Zm = Math.max(0, Z - LapStep), Zp = Math.min(Nz - 1, Z + LapStep);
        for (let X = 1; X < Nx - 1; ++X)
        {
            const I = Row + X;
            if (Sdf[I] >= 0.0) continue;

            const Hi = HRead[I];
            const ElevAboveSea = Hi - seaLevel;
            if (ElevAboveSea < 4.0) continue;

            const Wx = B.x + X * Cx;
            const DhDx = (HRead[I + 1] - HRead[I - 1]) * Inv2Cx;
            const DhDz = (HRead[I + Nx] - HRead[I - Nx]) * Inv2Cz;
            const SlopeTan = Math.hypot(DhDx, DhDz);
            const SlopeDeg = Math.atan(SlopeTan) * 57.29578;

            // Multi-scale convexity (positive = convex dome, granite crown, ridge shoulder, mesa lip)
            const Xm = Math.max(0, X - LapStep), Xp = Math.min(Nx - 1, X + LapStep);
            const AvgNbr = 0.25 * (HRead[Z * Nx + Xm] + HRead[Z * Nx + Xp] + HRead[Zm * Nx + X] + HRead[Zp * Nx + X]);
            const Convex = Hi - AvgNbr;

            // Exfoliation prefers elevated rocky domes, convex slopes & cliff shoulders (not flat sea beaches!)
            const ElevGate = smoothstep(6.0, 32.0, ElevAboveSea);
            const RockGate = smoothstep(6.0, 22.0, SlopeDeg) * smoothstep(76.0, 56.0, SlopeDeg) * 0.72
                           + smoothstep(-0.4, 3.2, Convex) * 0.65;
            const ExfMask = clamp(ElevGate * clamp(RockGate, 0.0, 1.0) * Str, 0.0, 1.0);
            if (ExfMask < 0.04) continue;

            // Asymmetric fanned concentric depth-band coordinate wrapping each dome/ridge naturally!
            const NormH = clamp((Hi - Math.max(seaLevel, State.minH)) / Relief, 0.0, 1.2);
            const FanWarp = 0.22 * Asym * scalarField3D(Wx * fanFreq, Hi * fanFreq * 1.4, Wz * fanFreq, Salt + 503);
            const KinkWarp = 0.065 * (Math.abs(scalarField3D(Wx * kinkFreq, Hi * kinkFreq * 1.6, Wz * kinkFreq, Salt + 511)) * 2.0 - 1.0);
            const AsymSpan = 0.68 + 0.62 * mix(0.5, 0.5 + 0.5 * scalarField3D(Wx * fanFreq * 0.8 + 4.3, Hi * fanFreq, Wz * fanFreq * 0.8 - 2.9, Salt + 509), Asym);

            // Shell coordinate: `0` at lower apron (outermost aged shell), `ShellN` at upper peeled corestone crown!
            const PeelBand = clamp((NormH * 1.12 + clamp(Convex * 0.035, -0.15, 0.28) + FanWarp + KinkWarp - 0.14) / Math.max(0.35, 0.82 * AsymSpan), 0.0, 1.0);
            const ExactTier = PeelBand * ShellN * (0.45 + 0.55 * Str);
            const TierIdx = Math.min(ShellN, Math.floor(ExactTier));
            const FracInTier = ExactTier - Math.floor(ExactTier);

            // Sharp stepped concentric shell scarp + overhanging undercut parting slot right at FracInTier ≈ 0!
            // Smooth inner corestone dome when TierIdx >= ShellN!
            let StepDelta = 0.0;
            let SlotDark = 0.0;
            let LipHi = 0.0;

            if (TierIdx < ShellN)
            {
                // Sharp stepped ledge rise over the first 16% of each shell band, then gentle curved sheet across the plate
                const ScarpCurve = smoothstep(0.0, 0.17, FracInTier);
                const SheetDome = 0.18 * Math.sin(FracInTier * Math.PI);
                StepDelta = -ShellStepM * ((ShellN - TierIdx - 1) * 0.34 + (1.0 - ScarpCurve) * 0.42 - SheetDome * 0.22) * ExfMask;

                // Deep undercut parting slot tucked directly beneath each broken terrace rim (FracInTier in 0.02..0.24)
                const SlotBand = Math.exp(-Math.pow((FracInTier - 0.09) / 0.065, 2.0));
                SlotDark = SlotBand * clamp(UndercutMul, 0.0, 1.5) * ExfMask;
                // Carve crisp groove right along parting seam so central-difference normal catches razor shadow!
                StepDelta -= ShellStepM * 0.26 * SlotDark;

                // Bright sunlit broken shell lip just above the parting seam (FracInTier in 0.16..0.32)
                LipHi = Math.exp(-Math.pow((FracInTier - 0.22) / 0.075, 2.0)) * ExfMask;

                // Shell-confined polygonal plate joints cracking each individual curved rock sheet!
                if (PlateK > 0.02 && FracInTier > 0.16)
                {
                    const pwX = 0.34 * scalarField3D(Wx * pScale * 0.5, Hi * pScale * 0.5, Wz * pScale * 0.5, Salt + 563);
                    const pwZ = 0.34 * scalarField3D(Wx * pScale * 0.5 + 4.8, Hi * pScale * 0.5, Wz * pScale * 0.5 - 3.1, Salt + 569);
                    const clv = evalPlanarCleavage3D(Wx * pScale + pwX, Hi * pScale * 0.85, Wz * pScale + pwZ, 0.78, Salt + 577);
                    const plateOpen = smoothstep(-0.18, 0.38, scalarField3D(Wx * pScale * 0.45, Hi * pScale * 0.45, Wz * pScale * 0.45, Salt + 587));
                    const plateCrack = smoothstep(0.11 * PlateK, 0.0, clv.wallDist) * plateOpen * PlateK * ExfMask;
                    if (plateCrack > 0.02)
                    {
                        StepDelta -= ShellStepM * 0.30 * plateCrack;
                        SlotDark = Math.max(SlotDark, plateCrack * 0.85);
                    }
                }
            }

            // Inner rounded corestone smoothing: gently relaxes rough micro-jaggedness on freshly peeled upper crown!
            const CoreFrac = clamp(ExactTier / Math.max(1.0, ShellN), 0.0, 1.0);
            const RoundPull = CoreRound * CoreFrac * CoreFrac * ExfMask;
            const SmoothDelta = (AvgNbr - Hi) * 0.22 * RoundPull;

            const TotalDh = StepDelta + SmoothDelta;
            H[I] = Hi + TotalDh;
            if (Math.abs(TotalDh) > State.stats.maxCarveM) State.stats.maxCarveM = Math.abs(TotalDh);

            // Pack visual contrast channels: fresh peeled corestone vs aged dark outer husk + undercut slot shadow!
            const FreshVal = clamp(CoreFrac * 0.92 * ExfMask, 0.0, 1.0);
            const RindVal = clamp((1.0 - CoreFrac) * 0.78 * ExfMask, 0.0, 1.0);
            State.fresh[I] = Math.max(State.fresh[I], Math.round(FreshVal * 255));
            State.rind[I] = Math.max(State.rind[I], Math.round(RindVal * 255));
            State.cavity[I] = Math.max(State.cavity[I], Math.round(clamp(SlotDark * 0.96, 0.0, 1.0) * 255));
            State.shellEdge[I] = Math.max(State.shellEdge[I], Math.round(clamp(LipHi * 0.95, 0.0, 1.0) * 255));
            State.activeMask[I] = Math.max(State.activeMask[I], Math.round(ExfMask * 255));
            OnionCells++;
        }
    }

    State.stats.onionCells += OnionCells;
}

/**
 * Executes **Thermal Cracks & Pitting (`thermal_cracks`)** on a high-res (`512..4K`) landscape state.
 * Evaluates Irwin exponential skin-depth V-tip cracks (`exp(-d/skinDepth)`), true hierarchical 90° T-junction
 * crazing (`evalHierarchical90Crazing3D`), domain-warped 3D Voronoi rock joints + dendritic splinters,
 * and Hallet–Walder ice/thermal pitting nucleated along crack lips & thermally stressed rock faces!
 */
export function RunLandscapeThermalCracksPass(State, Params = {}, SunDir = [0.55, 0.72, 0.42])
{
    const Str = clamp(Params.strength ?? 0.90, 0.0, 1.0);
    if (Str <= 0.005) return;

    const { nx: Nx, nz: Nz, cellX: Cx, cellZ: Cz, bounds: B, h: H, sdf2D: Sdf, seaLevel } = State;
    const DeltaT = clamp(Params.thermalDeltaT ?? 60.0, 8.0, 100.0);
    const ThermalNorm = clamp(DeltaT / 60.0, 0.15, 1.65) * Str;
    const DirBias = clamp(Params.directionalBias ?? 0.52, 0.0, 1.0);
    const SkinDepth = clamp(Params.skinDepth ?? 3.4, 0.3, 14.0);
    const Crazing90 = clamp(Params.crazing90 ?? 0.86, 0.0, 1.0);
    const Spacing = clamp(Params.crazingSpacing ?? 16.0, 3.0, 60.0);
    const VorStr = clamp(Params.voronoiJoints ?? 0.62, 0.0, 1.0);
    const PitStr = clamp(Params.pittingStrength ?? 0.72, 0.0, 1.0);
    const PitScale = clamp(Params.pitScale ?? 1.0, 0.30, 2.50);
    const Salt = (Params.seed ?? 4109) | 0;

    const Inv2Cx = 1.0 / (2.0 * Cx);
    const Inv2Cz = 1.0 / (2.0 * Cz);
    const CellMean = 0.5 * (Cx + Cz);
    // Guarantee cracks span at least ~1.4 cells so 512..4K central-difference normals catch razor-crisp bevels!
    const MinApWorld = Math.max(0.28, CellMean * 1.15);

    const HRead = H.slice();
    const VorScale = 1.0 / clamp(Spacing * 1.65, 8.0, 75.0);
    const PitFreq1 = (1.0 / clamp(Spacing * 0.52, 3.5, 22.0)) / PitScale;
    const PitFreq2 = PitFreq1 * 2.35;

    let CrackedCells = 0;
    let PittedCells = 0;

    for (let Z = 1; Z < Nz - 1; ++Z)
    {
        const Row = Z * Nx;
        const Wz = B.z + Z * Cz;
        for (let X = 1; X < Nx - 1; ++X)
        {
            const I = Row + X;
            if (Sdf[I] >= 0.0) continue;

            const Hi = HRead[I];
            const Elev = Hi - seaLevel;
            if (Elev < 2.5) continue;

            const Wx = B.x + X * Cx;
            const DhDx = (HRead[I + 1] - HRead[I - 1]) * Inv2Cx;
            const DhDz = (HRead[I + Nx] - HRead[I - Nx]) * Inv2Cz;
            const InvLen = 1.0 / Math.hypot(DhDx, 1.0, DhDz);
            const NxN = -DhDx * InvLen;
            const NyN =  1.0 * InvLen;
            const NzN = -DhDz * InvLen;
            const SlopeDeg = Math.acos(clamp(NyN, -1.0, 1.0)) * 57.29578;

            // Rock exposure gate (cracks are strongest on rocky slopes, ridges, cliffs & high elevations)
            const RockMask = clamp(
                smoothstep(3.0, 16.0, Elev) * (0.38 + 0.62 * smoothstep(8.0, 34.0, SlopeDeg)),
                0.0, 1.0
            );
            if (RockMask < 0.04) continue;

            // Freshly peeled inner corestone (from an upstream onion_peel node) cracks more lightly than aged outer rind!
            const FreshAge = 1.0 - 0.55 * (State.fresh[I] / 255.0);

            // Solar insolation directional thermal shock (`N · SunDir`)
            const NdotS = Math.max(0.0, NxN * SunDir[0] + NyN * SunDir[1] + NzN * SunDir[2]);
            const SunGate = clamp(Math.pow(NdotS, 1.20) + 0.16, 0.0, 1.0);
            const Insol = mix(1.0, SunGate, DirBias) * ThermalNorm * FreshAge;

            // Irwin finite skin depth (`exp(-d/skinDepth)`): deeper on exposed sun-baked cliffs, bounded inside rock!
            const EffSkinDepth = SkinDepth * clamp(0.38 + 0.68 * Insol, 0.20, 1.50) * RockMask;

            let TotalCut = 0.0;
            let CrackCavity = 0.0;
            let CrackProx = 0.0;
            let CrackLip = 0.0;

            // (1) True Hierarchical 90° T-Junction Thermal Crazing (Tier-1 + Tier-2 90° arrests + Tier-3 cross splits!)
            if (Crazing90 > 0.01)
            {
                const c90 = evalHierarchical90Crazing3D(Wx, Wz, Hi * 0.72, Spacing, Salt + 211);
                const BaseAp = Math.max(MinApWorld, Spacing * 0.082) * Crazing90 * clamp(Insol, 0.15, 1.4);
                const Ap1 = BaseAp * clamp(c90.mod1, 0.0, 1.8);
                const Ap2 = BaseAp * clamp(c90.mod2, 0.0, 1.4);

                // Irwin exponential V-tip profile: razor-sharp V-groove with `exp(-dist / ap)` wall falloff!
                const t1 = Ap1 > 0.01 ? Math.max(0.0, 1.0 - c90.tier1Dist / Ap1) : 0.0;
                const t2 = Ap2 > 0.01 ? Math.max(0.0, 1.0 - c90.tier2Dist / Ap2) : 0.0;
                const vProfile1 = t1 > 0.0 ? t1 * Math.exp(-(1.0 - t1) * 1.15) : 0.0;
                const vProfile2 = t2 > 0.0 ? t2 * Math.exp(-(1.0 - t2) * 1.25) * 0.74 : 0.0;
                const vMax = Math.max(vProfile1, vProfile2);

                if (vMax > 0.005)
                {
                    const Cut90 = EffSkinDepth * 0.85 * vMax;
                    TotalCut = Math.max(TotalCut, Cut90);
                    CrackCavity = Math.max(CrackCavity, clamp(vMax * 1.35, 0.0, 1.0));
                }
                // Subtle sunlit chamfered crack lip right outside crack mouth
                const MinDist90 = Math.min(c90.tier1Dist, c90.tier2Dist);
                CrackProx = Math.max(CrackProx, smoothstep(Spacing * 0.24, 0.0, MinDist90));
                if (MinDist90 > BaseAp * 0.85 && MinDist90 < BaseAp * 2.2)
                {
                    CrackLip = Math.max(CrackLip, smoothstep(BaseAp * 2.2, BaseAp * 1.1, MinDist90) * 0.65 * Crazing90);
                }
            }

            // (2) Organic Domain-Warped 3D Voronoi Rock Joints + Secondary Dendritic Splinters
            if (VorStr > 0.01)
            {
                const vx = Wx * VorScale;
                const vy = Hi * VorScale * 0.85;
                const vz = Wz * VorScale;
                const wx0 = 0.36 * scalarField3D(vx * 0.55, vy * 0.55, vz * 0.55, Salt + 311);
                const wz0 = 0.36 * scalarField3D(vx * 0.55 - 4.1, vy * 0.55 + 6.3, vz * 0.55, Salt + 347);
                const clv = evalPlanarCleavage3D(vx + wx0, vy, vz + wz0, 0.76, Salt + 307);
                const wallWorld = clv.wallDist / VorScale;

                const vorVit = scalarField3D(vx * 0.48 - 7.1, vy * 0.48 + 3.9, vz * 0.48, Salt + 367);
                const openVor = smoothstep(-0.14, 0.44, vorVit);
                const vorAp = Math.max(MinApWorld, 0.095 / VorScale) * VorStr * openVor * (0.45 + 0.55 * Insol);
                if (vorAp > 0.01 && wallWorld < vorAp)
                {
                    const tv = 1.0 - wallWorld / vorAp;
                    const vVor = tv * Math.exp(-(1.0 - tv) * 1.10);
                    TotalCut = Math.max(TotalCut, EffSkinDepth * 0.92 * vVor);
                    CrackCavity = Math.max(CrackCavity, clamp(vVor * 1.25, 0.0, 1.0));
                }
                CrackProx = Math.max(CrackProx, smoothstep(0.28, 0.0, clv.wallDist) * openVor);
            }

            // (3) Hallet–Walder Ice / Thermal Segregation Pitting (frost-shattered spall bowls + raised micro-spall rim!)
            let PitVal = 0.0;
            if (PitStr > 0.01)
            {
                const FrostGate = clamp(PitStr * (0.42 + 0.58 * Insol) * (0.48 + 0.72 * CrackProx) * RockMask, 0.0, 1.35);
                const cP1 = evalPlanarCleavage3D(Wx * PitFreq1, Hi * PitFreq1 * 0.8, Wz * PitFreq1, 0.85, Salt + 613);
                const act1 = smoothstep(0.30 - 0.34 * PitStr, 0.64 - 0.24 * PitStr, cP1.cellRand * 0.5 + 0.5 + 0.28 * CrackProx);
                const rad1 = (0.16 + 0.24 * act1) * clamp(FrostGate, 0.0, 1.15);

                const cP2 = evalPlanarCleavage3D(Wx * PitFreq2 + 7.1, Hi * PitFreq2 * 0.8, Wz * PitFreq2 - 4.3, 0.88, Salt + 641);
                const act2 = smoothstep(0.34 - 0.30 * PitStr, 0.70 - 0.20 * PitStr, cP2.cellRand * 0.5 + 0.5 + 0.22 * CrackProx);
                const rad2 = (0.14 + 0.22 * act2) * clamp(FrostGate, 0.0, 1.15);

                const Bowl1 = rad1 > 0.02 && cP1.f1 < rad1 ? Math.pow(1.0 - (cP1.f1 / rad1) * (cP1.f1 / rad1), 0.75) : 0.0;
                const Bowl2 = rad2 > 0.02 && cP2.f1 < rad2 ? Math.pow(1.0 - (cP2.f1 / rad2) * (cP2.f1 / rad2), 0.75) * 0.65 : 0.0;
                PitVal = Math.max(Bowl1, Bowl2);

                if (PitVal > 0.02)
                {
                    const PitDepth = Math.min(EffSkinDepth * 0.48, 1.65 * PitScale * FrostGate) * PitVal;
                    TotalCut += PitDepth;
                    CrackCavity = Math.max(CrackCavity, PitVal * 0.68);
                    PittedCells++;
                }
                else if (rad1 > 0.05 && cP1.f1 >= rad1 && cP1.f1 < rad1 * 1.32)
                {
                    // Subtle raised spall rim around Hallet-Walder frost pop-out bowls!
                    const RimW = Math.sin(((cP1.f1 - rad1) / (rad1 * 0.32)) * Math.PI);
                    CrackLip = Math.max(CrackLip, RimW * 0.52 * PitStr * RockMask);
                }
            }

            if (TotalCut > 0.004 || CrackCavity > 0.02 || PitVal > 0.02)
            {
                H[I] -= TotalCut;
                if (TotalCut > State.stats.maxCarveM) State.stats.maxCarveM = TotalCut;
                State.cavity[I] = Math.max(State.cavity[I], Math.round(clamp(CrackCavity, 0.0, 1.0) * 255));
                State.pit[I] = Math.max(State.pit[I], Math.round(clamp(PitVal, 0.0, 1.0) * 255));
                State.fresh[I] = Math.max(State.fresh[I], Math.round(clamp((CrackCavity * 0.55 + PitVal * 0.42), 0.0, 1.0) * 255));
                State.shellEdge[I] = Math.max(State.shellEdge[I], Math.round(clamp(CrackLip, 0.0, 1.0) * 255));
                State.activeMask[I] = Math.max(State.activeMask[I], Math.round(RockMask * 255));
                if (CrackCavity > 0.05) CrackedCells++;
            }
        }
    }

    State.stats.crackedCells += CrackedCells;
    State.stats.pittedCells += PittedCells;
}

/**
 * Packs razor-sharp full-resolution (`512` Lookdev / `1K` / `2K` / `4K` Production) GPU RGBA8 textures:
 *  - `detail`: `(normalX, normalZ, crevice+slot cavity, Hallet-Walder pit depth)`
 *  - `tone`:   `(fresh corestone/crack interior, aged dark rind, sunlit shell/crack lip highlight, active mask)`
 */
export function BuildWeatheringDetailTextures(State, MaxDim = 2048)
{
    const { nx: Nx, nz: Nz, cellX: Cx, cellZ: Cz, h: H } = State;
    const MaxSide = Math.max(Nx, Nz);
    const Scale = MaxSide > MaxDim ? (MaxDim / MaxSide) : 1.0;
    const Tw = Math.max(64, Math.round(Nx * Scale));
    const Th = Math.max(64, Math.round(Nz * Scale));

    const Detail = new Uint8Array(Tw * Th * 4);
    const Tone = new Uint8Array(Tw * Th * 4);
    const Inv2Cx = 1.0 / (2.0 * Cx);
    const Inv2Cz = 1.0 / (2.0 * Cz);
    const StepX = (Nx - 1) / Math.max(1, Tw - 1);
    const StepZ = (Nz - 1) / Math.max(1, Th - 1);

    for (let Y = 0; Y < Th; ++Y)
    {
        const Sz = Math.min(Nz - 1, Math.round(Y * StepZ));
        const Zm = Math.max(0, Sz - 1), Zp = Math.min(Nz - 1, Sz + 1);
        const RowS = Sz * Nx;
        const RowT = Y * Tw;
        for (let X = 0; X < Tw; ++X)
        {
            const Sx = Math.min(Nx - 1, Math.round(X * StepX));
            const Xm = Math.max(0, Sx - 1), Xp = Math.min(Nx - 1, Sx + 1);
            const I = RowS + Sx;

            // High-res micro-surface normal (boosted slightly so 512..4K crack walls & onion ledges pop crisply!)
            const DhDx = (H[RowS + Xp] - H[RowS + Xm]) * Inv2Cx * 1.35;
            const DhDz = (H[Zp * Nx + Sx] - H[Zm * Nx + Sx]) * Inv2Cz * 1.35;
            const InvL = 1.0 / Math.hypot(DhDx, 1.0, DhDz);
            const Nnx = -DhDx * InvL;
            const Nnz = -DhDz * InvL;

            const P = (RowT + X) * 4;
            Detail[P]     = Math.round(clamp(Nnx * 0.5 + 0.5, 0.0, 1.0) * 255);
            Detail[P + 1] = Math.round(clamp(Nnz * 0.5 + 0.5, 0.0, 1.0) * 255);
            Detail[P + 2] = State.cavity[I];
            Detail[P + 3] = State.pit[I];

            Tone[P]       = State.fresh[I];
            Tone[P + 1]   = State.rind[I];
            Tone[P + 2]   = State.shellEdge[I];
            Tone[P + 3]   = State.activeMask[I];
        }
    }

    return { width: Tw, height: Th, detail: Detail, tone: Tone };
}

/**
 * Writes the simulated high-res relief delta back onto `Region` AND attaches the full-res GPU textures
 * plus active triplanar cliff parameters so `TerrainOceanViewport.js` renders razor-sharp cracks & onion shells
 * on BOTH slopes AND vertical cliff walls!
 */
export function ApplyWeatherStateToRegion(World, Region, State, Nodes, Options = {})
{
    const Rt = Region.runtime;
    if (!Rt) EvaluateTerrainRegion(World, Region, null);

    // Downsample carved relief delta (`h - h0`) cleanly back onto Region's base heightfield
    const Rnx = Region.runtime.nx, Rnz = Region.runtime.nz;
    const Delta = new Float32Array(Rnx * Rnz);
    const ScaleX = (State.nx - 1) / Math.max(1, Rnx - 1);
    const ScaleZ = (State.nz - 1) / Math.max(1, Rnz - 1);

    for (let Z = 0; Z < Rnz; ++Z)
    {
        const Fz = Z * ScaleZ;
        const Row = Z * Rnx;
        for (let X = 0; X < Rnx; ++X)
        {
            const Fx = X * ScaleX;
            const HNew = SampleBilinear(State.h, State.nx, State.nz, Fx, Fz);
            const HOld = SampleBilinear(State.h0, State.nx, State.nz, Fx, Fz);
            Delta[Row + X] = HNew - HOld;
        }
    }

    // Attach non-destructive delta layer so user can Clear/Re-Run cleanly anytime
    if (Region.weatherDeltaLayer)
    {
        const OldIdx = Region.stack.indexOf(Region.weatherDeltaLayer);
        if (OldIdx >= 0) Region.stack.splice(OldIdx, 1);
    }
    const BaseH = Region.runtime.simBaseHeights && Region.runtime.simBaseHeights.length === Region.runtime.heights.length
        ? Region.runtime.simBaseHeights
        : Region.runtime.heights.slice();
    for (let I = 0; I < Region.runtime.heights.length; ++I)
    {
        Region.runtime.heights[I] = BaseH[I] + Delta[I];
    }

    // Store active thermal & onion params for zero-stretch GPU cliff triplanar sharpening
    const AnySolo = Nodes.some(N => N.solo && N.enabled !== false);
    const Active = Nodes.filter(N => N.enabled !== false && (!AnySolo || N.solo));
    const ThermalNode = Active.find(N => N.nodeType === 'thermal_cracks');
    const OnionNode = Active.find(N => N.nodeType === 'onion_peel');

    Region.runtime.weatherState = State;
    Region.runtime.weatherParams = {
        thermal: ThermalNode ? { ...ThermalNode.params } : null,
        onion: OnionNode ? { ...OnionNode.params } : null
    };
    if (!Options.skipTextures)
    {
        Region.runtime.weatherTextures = BuildWeatheringDetailTextures(State, Options.maxTexDim ?? Math.min(State.resolution, 2048));
        Region.runtime.weatherTexturesDirty = true;
    }
    Region.meshDirty = true;
}

export function ClearWeatheringFromRegion(World, Region)
{
    if (!Region) return;
    if (Region.runtime)
    {
        if (Region.runtime.simBaseHeights && Region.runtime.simBaseHeights.length === Region.runtime.heights.length)
        {
            Region.runtime.heights.set(Region.runtime.simBaseHeights);
        }
        Region.runtime.simBaseHeights = null;
        Region.runtime.weatherState = null;
        Region.runtime.weatherParams = null;
        Region.runtime.weatherTextures = null;
        Region.runtime.weatherTexturesDirty = true;
    }
    Region.dirty = true;
    EvaluateTerrainRegion(World, Region, null);
    Region.meshDirty = true;
}

/**
 * Synchronous Landscape Thermal Cracks + Onion-Skin Exfoliation runner (used by headless validation & sync calls).
 */
export function RunLandscapeWeatheringNodes(World, Options = {})
{
    const Scope = Options.scope || 'active_box';
    const Tier = GetWeatherSimTier(Options.tierId || 'lookdev_512');
    const TargetRes = Options.resolutionOverride ?? Tier.res;
    const Nodes = Options.nodes || CreateDefaultLandscapeWeatherNodes();
    const SunDir = Options.sunDir || [0.55, 0.72, 0.42];
    const Targets = ResolveTargetTerrainBoxes(World, Scope, Options.activeRegionId, Options.selectedRegionIds);

    const AnySolo = Nodes.some(N => N.solo && N.enabled !== false);
    const ActiveNodes = Nodes.filter(N => N.enabled !== false && (!AnySolo || N.solo));

    const T0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const Results = [];

    for (let Bi = 0; Bi < Targets.length; ++Bi)
    {
        const Region = Targets[Bi];
        if (!Region.runtime || Region.dirty) EvaluateTerrainRegion(World, Region, null);
        if (!Region.runtime.simBaseHeights || Options.freshBase !== false)
        {
            if (Region.runtime.simBaseHeights && Options.freshBase !== false)
            {
                Region.runtime.heights.set(Region.runtime.simBaseHeights);
            }
            else
            {
                Region.runtime.simBaseHeights = Region.runtime.heights.slice();
            }
        }

        const St0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const State = CreateLandscapeWeatherState(World, Region, { resolution: TargetRes, tierId: Tier.id });
        for (const Node of ActiveNodes)
        {
            if (Node.nodeType === 'onion_peel') RunLandscapeOnionPeelPass(State, Node.params, SunDir);
            else if (Node.nodeType === 'thermal_cracks') RunLandscapeThermalCracksPass(State, Node.params, SunDir);
        }
        State.lastElapsedMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - St0);
        ApplyWeatherStateToRegion(World, Region, State, Nodes, {
            skipTextures: !!Options.skipTextures,
            maxTexDim: Options.maxTexDim ?? Math.min(TargetRes, 2048)
        });
        Results.push({
            regionId: Region.id,
            regionName: Region.name,
            resolution: State.resolution,
            nx: State.nx,
            nz: State.nz,
            elapsedMs: State.lastElapsedMs,
            stats: { ...State.stats },
            state: State
        });
    }

    if (Targets.length >= 2) StitchAdjacentRegionBorders(World);

    return {
        scope: Scope,
        tierId: Tier.id,
        resolution: TargetRes,
        targetCount: Targets.length,
        totalElapsedMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - T0),
        results: Results
    };
}

/**
 * Async frame-yielding Landscape Thermal Cracks + Onion-Skin Exfoliation runner so Lookdev 512 & Production 1K/2K/4K
 * stream live progress without blocking browser rendering!
 */
export async function RunLandscapeWeatheringNodesAsync(World, Options = {})
{
    const YieldFrame = () => new Promise(Resolve => setTimeout(Resolve, 4));
    const Scope = Options.scope || 'active_box';
    const Tier = GetWeatherSimTier(Options.tierId || 'lookdev_512');
    const TargetRes = Options.resolutionOverride ?? Tier.res;
    const Nodes = Options.nodes || CreateDefaultLandscapeWeatherNodes();
    const SunDir = Options.sunDir || [0.55, 0.72, 0.42];
    const Targets = ResolveTargetTerrainBoxes(World, Scope, Options.activeRegionId, Options.selectedRegionIds);

    const AnySolo = Nodes.some(N => N.solo && N.enabled !== false);
    const ActiveNodes = Nodes.filter(N => N.enabled !== false && (!AnySolo || N.solo));

    const T0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const Results = [];

    for (let Bi = 0; Bi < Targets.length; ++Bi)
    {
        const Region = Targets[Bi];
        if (!Region.runtime || Region.dirty) EvaluateTerrainRegion(World, Region, null);
        if (!Region.runtime.simBaseHeights || Options.freshBase !== false)
        {
            if (Region.runtime.simBaseHeights && Options.freshBase !== false)
            {
                Region.runtime.heights.set(Region.runtime.simBaseHeights);
            }
            else
            {
                Region.runtime.simBaseHeights = Region.runtime.heights.slice();
            }
        }

        const St0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
        const State = CreateLandscapeWeatherState(World, Region, { resolution: TargetRes, tierId: Tier.id });
        await YieldFrame();

        for (let Ni = 0; Ni < ActiveNodes.length; ++Ni)
        {
            const Node = ActiveNodes[Ni];
            if (Options.onProgress)
            {
                const Frac = (Bi + Ni / Math.max(1, ActiveNodes.length)) / Math.max(1, Targets.length);
                Options.onProgress(Frac, Region, Node);
            }
            await YieldFrame();
            if (Node.nodeType === 'onion_peel') RunLandscapeOnionPeelPass(State, Node.params, SunDir);
            else if (Node.nodeType === 'thermal_cracks') RunLandscapeThermalCracksPass(State, Node.params, SunDir);
        }

        State.lastElapsedMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - St0);
        ApplyWeatherStateToRegion(World, Region, State, Nodes, {
            skipTextures: !!Options.skipTextures,
            maxTexDim: Options.maxTexDim ?? Math.min(TargetRes, 2048)
        });

        const Entry = {
            regionId: Region.id,
            regionName: Region.name,
            resolution: State.resolution,
            nx: State.nx,
            nz: State.nz,
            elapsedMs: State.lastElapsedMs,
            stats: { ...State.stats },
            state: State
        };
        Results.push(Entry);
        if (Options.onRegionDone) Options.onRegionDone(Region, Entry, Bi, Targets.length);
    }

    if (Targets.length >= 2) StitchAdjacentRegionBorders(World);
    if (Options.onProgress) Options.onProgress(1.0, null, null);

    return {
        scope: Scope,
        tierId: Tier.id,
        resolution: TargetRes,
        targetCount: Targets.length,
        totalElapsedMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - T0),
        results: Results
    };
}
