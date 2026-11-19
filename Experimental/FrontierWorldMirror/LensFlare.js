//==========================================================================================================================================
// FILE: LensFlare.js
// PURPOSE: Authoritative lens-flare specification shared by the WebGL2 composite pass, the Inspector "Lens Flare" card, the CPU GTX
//          fallback overlay, and the Outliner summary line. Mirrors Engine/Components/Camera/VisualEffects/LensFlareEffect.h so the HTML
//          prototype and the C++ mirror resolve the same optical values from the same authored record.
//
//          The flare is a physically-motivated screen-space composite:
//            · diffraction ghosts mirrored through the optical axis (aperture polygon shaped, spectral dispersion)
//            · aperture halo (Airy ring approximation) at a fixed angular radius
//            · anamorphic horizontal streak pair with chromatic fringe (cylindrical element artefact)
//            · starburst diffraction spikes from the aperture blade count
//          Sun visibility is resolved from the scene depth byte, so flare disappears the instant an occluder covers the solar disc.
//==========================================================================================================================================

export const FLARE_TYPES = ["Cinematic", "Anamorphic", "Starburst", "Halo", "Custom layers"];
export const GHOST_SHAPES = ["Round", "Hexagon", "Octagon"];

// Authored defaults — identical to NativePanels.json "flare" defaults so the first frame already renders a calibrated flare.
export const CanonicalFlare = {
  Enabled: true,
  Type: 0,
  Intensity: 1.0,
  Ghosts: 6,
  "Halo Radius": 0.28,
  Chromatic: 0.6,
  "Aperture Blades": 6,
  "Streak gain": 1.0,
  Anamorphic: true,
  Streaks: true,
  Starburst: true,
  Spread: 1.0,
  Rotation: 0.0,
  "Ray pairs": 6,
  "Ghost brightness": 1.0,
  "Ghost spacing": 1.0,
  "Halo brightness": 1.0,
  "Halo width": 0.035,
  "Ghost shape": 0,
  "Preview X": 0.28,
  "Preview Y": 0.43,
  Notes:
    "Lens Flare optical effect · diffraction ghosts, aperture halo, anamorphic streak and starburst driven by the solar disc.",
};

const Num = (Value, Fallback) => {
  const Parsed = Number(Value);
  return Number.isFinite(Parsed) ? Parsed : Fallback;
};

const Clamp = (Value, Low, High) => Math.max(Low, Math.min(High, Value));

const Toggle = (Value, Fallback) => (Value === undefined || Value === null ? Fallback : Value !== false && Value !== 0);

/**
 * Resolves the authored flare record into the normalised settings consumed by every renderer.
 * Missing properties fall back to CanonicalFlare, so a partially authored or legacy row still renders.
 */
export function ResolveFlareSettings(Record = {}, Visible = true) {
  const Source = Record && typeof Record === "object" ? Record : {};
  const TypeIndex = Clamp(Math.round(Num(Source.Type, CanonicalFlare.Type)), 0, FLARE_TYPES.length - 1);
  return {
    enabled: Boolean(Visible) && Toggle(Source.Enabled, CanonicalFlare.Enabled),
    type: TypeIndex,
    typeName: FLARE_TYPES[TypeIndex],
    intensity: Clamp(Num(Source.Intensity, CanonicalFlare.Intensity), 0, 3),
    ghosts: Clamp(Math.round(Num(Source.Ghosts, CanonicalFlare.Ghosts)), 0, 24),
    haloRadius: Clamp(Num(Source["Halo Radius"], CanonicalFlare["Halo Radius"]), 0.1, 1.2),
    haloBrightness: Clamp(Num(Source["Halo brightness"], CanonicalFlare["Halo brightness"]), 0, 3),
    haloWidth: Clamp(Num(Source["Halo width"], CanonicalFlare["Halo width"]), 0.005, 0.2),
    chromatic: Clamp(Num(Source.Chromatic, CanonicalFlare.Chromatic), 0, 1),
    apertureBlades: Clamp(Math.round(Num(Source["Aperture Blades"], CanonicalFlare["Aperture Blades"])), 3, 12),
    streakGain: Clamp(Num(Source["Streak gain"], CanonicalFlare["Streak gain"]), 0, 3),
    anamorphic: Toggle(Source.Anamorphic, CanonicalFlare.Anamorphic),
    streaks: Toggle(Source.Streaks, CanonicalFlare.Streaks),
    starburst: Toggle(Source.Starburst, CanonicalFlare.Starburst),
    spread: Clamp(Num(Source.Spread, CanonicalFlare.Spread), 0.25, 2),
    rotationDeg: Clamp(Num(Source.Rotation, CanonicalFlare.Rotation), 0, 180),
    rayPairs: Clamp(Math.round(Num(Source["Ray pairs"], CanonicalFlare["Ray pairs"])), 2, 12),
    ghostBrightness: Clamp(Num(Source["Ghost brightness"], CanonicalFlare["Ghost brightness"]), 0, 2),
    ghostSpacing: Clamp(Num(Source["Ghost spacing"], CanonicalFlare["Ghost spacing"]), 0, 2),
    ghostShape: Clamp(Math.round(Num(Source["Ghost shape"], CanonicalFlare["Ghost shape"])), 0, GHOST_SHAPES.length - 1),
    previewX: Clamp(Num(Source["Preview X"], CanonicalFlare["Preview X"]), 0.06, 0.94),
    previewY: Clamp(Num(Source["Preview Y"], CanonicalFlare["Preview Y"]), 0.08, 0.92),
  };
}

/** Cache key so the composite uniforms only refresh when the authored optics actually change. */
export function FlareCacheKey(Flare = {}) {
  return [
    Flare.enabled ? 1 : 0,
    Flare.type,
    Flare.intensity?.toFixed(3),
    Flare.ghosts,
    Flare.haloRadius?.toFixed(3),
    Flare.haloBrightness?.toFixed(3),
    Flare.haloWidth?.toFixed(4),
    Flare.chromatic?.toFixed(3),
    Flare.apertureBlades,
    Flare.streakGain?.toFixed(3),
    Flare.anamorphic ? 1 : 0,
    Flare.streaks ? 1 : 0,
    Flare.starburst ? 1 : 0,
    Flare.spread?.toFixed(3),
    Flare.rotationDeg?.toFixed(2),
    Flare.rayPairs,
    Flare.ghostBrightness?.toFixed(3),
    Flare.ghostSpacing?.toFixed(3),
    Flare.ghostShape,
    Flare.previewX?.toFixed(3),
    Flare.previewY?.toFixed(3),
  ].join("|");
}

/**
 * Packs the resolved flare into the four vec4 uniform blocks consumed by the composite shader:
 *   uFlareCfg0 = (enabled, intensity, ghostCount, spread)
 *   uFlareCfg1 = (haloRadius, haloBrightness, haloWidth, chromatic)
 *   uFlareCfg2 = (apertureBlades, streakGain, rotationRad, ghostSpacing)
 *   uFlareCfg3 = (anamorphic, streaks, starburst, ghostBrightness)
 *   uFlareCfg4 = (type, rayPairs, ghostShape, 0)
 */
export function EncodeFlareUniforms(Flare = {}) {
  const F = ResolveFlareSettings(Flare, Flare.enabled);
  return {
    cfg0: [F.enabled ? 1 : 0, F.intensity, F.ghosts, F.spread],
    cfg1: [F.haloRadius, F.haloBrightness, F.haloWidth, F.chromatic],
    cfg2: [F.apertureBlades, F.streakGain, (F.rotationDeg * Math.PI) / 180, F.ghostSpacing],
    cfg3: [F.anamorphic ? 1 : 0, F.streaks ? 1 : 0, F.starburst ? 1 : 0, F.ghostBrightness],
    cfg4: [F.type, F.rayPairs, F.ghostShape, F.intensity > 0 && F.enabled ? 1 : 0],
  };
}

/**
 * Projected solar-disc position in UV space (0..1, +Y up) plus the forward depth used to reject the flare when the sun is behind
 * the camera. Pure function so the CPU fallback overlay, the Inspector readout and the unit checks share one projection.
 */
export function ProjectSunToScreen(SunDir, CameraBasis, TanHalfFov, Aspect) {
  const Dot = (A, B) => A[0] * B[0] + A[1] * B[1] + A[2] * B[2];
  const Z = Dot(SunDir, CameraBasis.Forward);
  const X = Dot(SunDir, CameraBasis.Right);
  const Y = Dot(SunDir, CameraBasis.Up);
  if (!(Z > 1e-4)) return { visible: false, x: 0.5, y: 0.5, z: Z, offScreen: true };
  const TanY = Math.max(1e-4, TanHalfFov);
  const TanX = TanY * Math.max(1e-4, Aspect);
  return {
    visible: true,
    x: 0.5 + 0.5 * (X / Z) / TanX,
    y: 0.5 + 0.5 * (Y / Z) / TanY,
    z: Z,
    offScreen: Math.abs((X / Z) / TanX) > 1 || Math.abs((Y / Z) / TanY) > 1,
  };
}

/**
 * The ghost chain rendered by the composite pass — mirrored through the optical axis, ordered outward from the disc with the
 * spectral weight of each element. Reused verbatim by the Inspector preview so the card cannot drift from the viewport.
 */
export function BuildFlareGhostChain(Flare = {}, SunUv = { x: 0.28, y: 0.43 }) {
  const F = ResolveFlareSettings(Flare, Flare.enabled);
  const Ghosts = [];
  if (!F.enabled) return Ghosts;
  const Count = F.ghosts;
  if (Count <= 0) return Ghosts;
  const AxisX = 0.5 - (SunUv?.x ?? F.previewX);
  const AxisY = 0.5 - (SunUv?.y ?? F.previewY);
  for (let Index = 0; Index < Count; ++Index) {
    const T = (Index + 1) / (Count + 1);
    const Along = 2 * T * F.spread;
    const Jitter = 0.82 + 0.36 * Hash(Index * 7.13);
    Ghosts.push({
      index: Index,
      x: (SunUv?.x ?? F.previewX) + AxisX * Along * Jitter,
      y: (SunUv?.y ?? F.previewY) + AxisY * Along * Jitter,
      radius: 0.018 + 0.085 * Hash(Index * 3.71 + 0.5),
      weight: F.ghostBrightness * (0.35 + 0.65 * Hash(Index * 1.97 + 0.2)) * (1 - 0.55 * T),
      spectral: T,
      shape: F.ghostShape,
    });
  }
  return Ghosts;
}

function Hash(Seed) {
  const V = Math.sin(Seed * 127.1 + 311.7) * 43758.5453;
  return V - Math.floor(V);
}

/** Approximate spectral weight for a normalised position along the optical axis (R→G→B dispersion). */
export function SpectralWeight(T) {
  const Phase = Math.max(0, Math.min(1, T));
  return [
    0.55 + 0.45 * Math.cos((Phase - 0.05) * Math.PI * 2),
    0.55 + 0.45 * Math.cos((Phase - 0.38) * Math.PI * 2),
    0.55 + 0.45 * Math.cos((Phase - 0.71) * Math.PI * 2),
  ];
}

/**
 * Normalised visibility of the solar disc from the composite depth byte stream.
 * `AlphaAt(x, y)` returns the scene alpha byte (0 = sky, >0 = surface hit).
 */
export function SunDiscVisibility(SunUv, AlphaAt, SampleRadius = 3) {
  if (!SunUv?.visible) return 0;
  let Hits = 0;
  let Taps = 0;
  for (let Y = -SampleRadius; Y <= SampleRadius; ++Y) {
    for (let X = -SampleRadius; X <= SampleRadius; ++X) {
      if (X * X + Y * Y > SampleRadius * SampleRadius) continue;
      ++Taps;
      const Alpha = AlphaAt(SunUv.x + X * 0.0026, SunUv.y + Y * 0.0026);
      if (Alpha > 0) ++Hits;
    }
  }
  if (!Taps) return 0;
  const Coverage = Hits / Taps;
  // A grazed disc keeps a residual flare; a fully covered disc extinguishes it.
  return Math.max(0, 1 - Math.pow(Coverage, 0.55));
}

export default {
  FLARE_TYPES,
  GHOST_SHAPES,
  CanonicalFlare,
  ResolveFlareSettings,
  FlareCacheKey,
  EncodeFlareUniforms,
  ProjectSunToScreen,
  BuildFlareGhostChain,
  SpectralWeight,
  SunDiscVisibility,
};
