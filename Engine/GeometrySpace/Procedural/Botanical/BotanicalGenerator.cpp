/*============================================================================================================================================
                                                         BOTANICALGENERATOR.CPP
============================================================================================================================================*/
// 🧩 Implementation of Deterministic +Z Up Procedural Ferns, Palms, and Oak Trees with Watertight Noisy Wood Capsules
//    and 2.5D Thin-Sheet Leaf Instances.

//------------------------------------------------------------------------------------------------------------------------
//                                                        INCLUDES
//------------------------------------------------------------------------------------------------------------------------

#include "Engine/GeometrySpace/Procedural/Botanical/BotanicalGenerator.h"

#include <algorithm>
#include <cmath>

namespace Frontier::GeometrySpace::Botanical
{

namespace
{

using V3 = std::array<float, 3>;
constexpr float kPi      = 3.14159265358979323846f;
constexpr float kTau     = 6.28318530717958647692f;
constexpr float kDeg2Rad = kPi / 180.0f;
constexpr float kGolden  = 2.39996322972865332f; // 137.508 deg phyllotaxis golden angle

[[nodiscard]] inline V3 Add3(const V3& a, const V3& b) noexcept { return { a[0] + b[0], a[1] + b[1], a[2] + b[2] }; }
[[nodiscard]] inline V3 Sub3(const V3& a, const V3& b) noexcept { return { a[0] - b[0], a[1] - b[1], a[2] - b[2] }; }
[[nodiscard]] inline V3 Mul3(const V3& a, float s) noexcept     { return { a[0] * s, a[1] * s, a[2] * s }; }
[[nodiscard]] inline float Dot3(const V3& a, const V3& b) noexcept { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
[[nodiscard]] inline V3 Cross3(const V3& a, const V3& b) noexcept
{
    return { a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0] };
}
[[nodiscard]] inline float Len3(const V3& a) noexcept { return std::sqrt(Dot3(a, a)); }
[[nodiscard]] inline V3 Norm3(const V3& a, const V3& fb = { 0.0f, 0.0f, 1.0f }) noexcept
{
    const float l = Len3(a);
    return (l > 1.0e-7f) ? Mul3(a, 1.0f / l) : fb;
}
[[nodiscard]] inline V3 Mix3(const V3& a, const V3& b, float t) noexcept
{
    return { a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t };
}
[[nodiscard]] inline float SmoothStep(float e0, float e1, float x) noexcept
{
    const float t = std::clamp((x - e0) / std::max(e1 - e0, 1.0e-5f), 0.0f, 1.0f);
    return t * t * (3.0f - 2.0f * t);
}
[[nodiscard]] inline V3 RotateAxis(const V3& v, const V3& axis, float rad) noexcept
{
    const V3 k = Norm3(axis);
    const float c = std::cos(rad), s = std::sin(rad);
    return Add3(Add3(Mul3(v, c), Mul3(Cross3(k, v), s)), Mul3(k, Dot3(k, v) * (1.0f - c)));
}

/// Deterministic xorshift32 PRNG (bit-identical across Windows/Linux/macOS!)
class DetRng
{
public:
    explicit DetRng(uint32_t seed) noexcept : State_(seed == 0u ? 0x9E3779B9u : seed) {}
    [[nodiscard]] float Next01() noexcept
    {
        uint32_t x = State_;
        x ^= x << 13u; x ^= x >> 17u; x ^= x << 5u;
        State_ = x;
        return static_cast<float>(x & 0x00FFFFFFu) * (1.0f / 16777216.0f);
    }
    [[nodiscard]] float Range(float lo, float hi) noexcept { return lo + (hi - lo) * Next01(); }
    [[nodiscard]] float Vary(float base, float spread) noexcept { return base + (Next01() * 2.0f - 1.0f) * spread; }
private:
    uint32_t State_ = 1u;
};

struct Frame3
{
    V3 Pos   { 0.0f, 0.0f, 0.0f };
    V3 Dir   { 0.0f, 0.0f, 1.0f };
    V3 Right { 1.0f, 0.0f, 0.0f };
    V3 Up    { 0.0f, 1.0f, 0.0f };
    float T  = 0.0f;
};

void EmitTri(
    BotanicalPlantBuildResult& out,
    const V3& v0, const V3& v1, const V3& v2,
    const V3& col, float windFlex, float phase, BotanicalPartTag part)
{
    const V3 n = Cross3(Sub3(v1, v0), Sub3(v2, v0));
    if (Dot3(n, n) < 1.0e-12f) return;
    BotanicalTriangle t {};
    t.V0 = v0; t.V1 = v1; t.V2 = v2;
    t.RestV0 = v0; t.RestV1 = v1; t.RestV2 = v2;
    t.Normal = Norm3(n);
    t.ColorLin = col;
    t.WindFlex = windFlex;
    t.Phase = phase;
    t.Part = part;
    out.Triangles.push_back(t);
    if (part == BotanicalPartTag::Wood)       ++out.WoodTriCount;
    else if (part == BotanicalPartTag::Leaf)  ++out.LeafTriCount;
    else                                      ++out.FruitTriCount;
}

void EmitQuad(
    BotanicalPlantBuildResult& out,
    const V3& a, const V3& b, const V3& c, const V3& d,
    const V3& col, float windFlex, float phase, BotanicalPartTag part)
{
    EmitTri(out, a, b, c, col, windFlex, phase, part);
    EmitTri(out, a, c, d, col, windFlex, phase, part);
}

/// Emits a tapered tube along `frames` AND simultaneously appends watertight ball-jointed BotanicalWoodCapsules
/// with coherent rest-space 3D bark displacement (exact mesh-to-SDF match!).
void EmitWoodTubeAndCapsules(
    BotanicalPlantBuildResult& out,
    const std::vector<Frame3>& frames,
    const std::vector<float>&  radii,
    const std::vector<float>&  flexes,
    uint32_t                   radialSides,
    const V3&                  colBase,
    const V3&                  colTip,
    float                      barkNoiseAmp,
    float                      barkNoiseFreq,
    uint32_t                   branchLevel,
    bool                       emitCapsules,
    float                      phase,
    float                      annularRings = 0.0f)
{
    if (frames.size() < 2u) return;
    std::vector<std::vector<V3>> rings(frames.size(), std::vector<V3>(radialSides));

    for (std::size_t i = 0u; i < frames.size(); ++i)
    {
        const auto& fr = frames[i];
        const float rSmooth = radii[i];
        for (uint32_t j = 0u; j < radialSides; ++j)
        {
            const float th = (static_cast<float>(j) / static_cast<float>(radialSides)) * kTau;
            const V3 radial = Norm3(Add3(Mul3(fr.Right, std::cos(th)), Mul3(fr.Up, std::sin(th))));
            const V3 pSkin  = Add3(fr.Pos, Mul3(radial, rSmooth));
            float rMod = rSmooth;
            if (barkNoiseAmp > 1.0e-3f)
            {
                const float fbm = EvalBarkFbm3d(pSkin, barkNoiseFreq);
                rMod *= (1.0f + kBarkDispMaxFrac * barkNoiseAmp * fbm);
            }
            if (annularRings > 1.0e-3f)
            {
                // Palm diamond leaf-boot / annular ring sculptural ridge along trunk
                const float ringWave = std::sin(fr.T * 46.0f * kPi + std::sin(th * 5.0f) * 1.4f);
                rMod *= (1.0f + 0.09f * annularRings * ringWave);
            }
            rings[i][j] = Add3(fr.Pos, Mul3(radial, std::max(0.001f, rMod)));
        }
    }

    for (std::size_t i = 0u; i + 1u < frames.size(); ++i)
    {
        const float tMid = 0.5f * (frames[i].T + frames[i + 1u].T);
        const V3 col = Mix3(colBase, colTip, tMid);
        const float fl = 0.5f * (flexes[i] + flexes[i + 1u]);
        for (uint32_t j = 0u; j < radialSides; ++j)
        {
            const uint32_t j1 = (j + 1u) % radialSides;
            EmitQuad(out, rings[i][j], rings[i][j1], rings[i + 1u][j1], rings[i + 1u][j], col, fl, phase, BotanicalPartTag::Wood);
        }

        if (emitCapsules)
        {
            BotanicalWoodCapsule cap {};
            cap.P0 = frames[i].Pos;      cap.R0 = radii[i];
            cap.P1 = frames[i + 1u].Pos; cap.R1 = radii[i + 1u];
            cap.RestP0 = cap.P0;         cap.RestP1 = cap.P1;
            cap.WindFlex0 = flexes[i];   cap.WindFlex1 = flexes[i + 1u];
            cap.BranchLevel = branchLevel;
            out.SdfVolume.WoodCapsules.push_back(cap);
        }
    }
}

void EmitOvoid(
    BotanicalPlantBuildResult& out,
    const V3& center, float rx, float ry, float rz,
    const V3& col, float windFlex, float phase, BotanicalPartTag part)
{
    constexpr int rings = 4, segs = 6;
    for (int i = 0; i < rings; ++i)
    {
        const float p0 = -0.5f * kPi + kPi * (static_cast<float>(i) / rings);
        const float p1 = -0.5f * kPi + kPi * (static_cast<float>(i + 1) / rings);
        for (int j = 0; j < segs; ++j)
        {
            const float t0 = kTau * (static_cast<float>(j) / segs);
            const float t1 = kTau * (static_cast<float>(j + 1) / segs);
            auto pt = [&](float phi, float th) -> V3 {
                return { center[0] + rx * std::cos(phi) * std::cos(th),
                         center[1] + ry * std::cos(phi) * std::sin(th),
                         center[2] + rz * std::sin(phi) };
            };
            EmitQuad(out, pt(p0, t0), pt(p0, t1), pt(p1, t1), pt(p1, t0), col, windFlex, phase, part);
        }
    }
}

/// Emits a sculpted V-cambered botanical blade (pinna, palm leaflet, or lobed oak leaf) AND registers
/// its matching 2.5D Thin-Sheet SDF instance!
void EmitCurvedBladeAndLeafSdf(
    BotanicalPlantBuildResult& out,
    const V3& origin,
    const V3& axisLen,   // +Z in blade coordinates (along blade length)
    const V3& axisWid,   // +X in blade coordinates (across blade width)
    const V3& axisNorm,  // +Y in blade coordinates (adaxial upper normal)
    float     lengthM,
    float     halfWidthM,
    float     camberX,
    float     camberZ,
    float     auricle,
    const V3& colBase,
    const V3& colTip,
    float     windFlex,
    float     phase,
    LeafSdfArchetype arch,
    int       lengthSegs = 4)
{
    // Build sculpted V-keeled curved blade strip (2 halves across width x lengthSegs along length)
    std::vector<std::array<V3, 3u>> rows(static_cast<std::size_t>(lengthSegs + 1));
    for (int i = 0; i <= lengthSegs; ++i)
    {
        const float u = static_cast<float>(i) / static_cast<float>(lengthSegs);
        float env = std::sin(kPi * std::pow(std::clamp(u, 0.01f, 0.99f), 0.72f));
        if (arch == LeafSdfArchetype::LobedOak)
        {
            env *= (0.58f + 0.42f * std::cos((u - 0.14f) * kPi * 7.0f));
        }
        else if (arch == LeafSdfArchetype::FernPinna)
        {
            env = std::pow(1.0f - std::pow(u, 1.35f), 0.72f) * (0.35f + 0.65f * std::min(1.0f, u * 5.0f));
        }
        const float wL = halfWidthM * std::max(0.05f, env);
        const float wR = halfWidthM * std::max(0.05f, env + auricle * 0.45f * std::exp(-std::pow((u - 0.16f) / 0.12f, 2.0f)));
        const float droopZ = -camberZ * lengthM * (u * u) * 0.55f;
        const float keelLift = camberX * halfWidthM * 0.65f;
        const V3 mid = Add3(Add3(origin, Mul3(axisLen, u * lengthM)), Mul3(axisNorm, droopZ));
        rows[static_cast<std::size_t>(i)][0u] = Add3(Add3(mid, Mul3(axisWid, -wL)), Mul3(axisNorm, keelLift));
        rows[static_cast<std::size_t>(i)][1u] = mid;
        rows[static_cast<std::size_t>(i)][2u] = Add3(Add3(mid, Mul3(axisWid, +wR)), Mul3(axisNorm, keelLift));
    }
    for (int i = 0; i < lengthSegs; ++i)
    {
        const float u = (static_cast<float>(i) + 0.5f) / static_cast<float>(lengthSegs);
        const V3 c = Mix3(colBase, colTip, u * 0.65f);
        EmitQuad(out, rows[static_cast<std::size_t>(i)][0u], rows[static_cast<std::size_t>(i)][1u],
                      rows[static_cast<std::size_t>(i + 1)][1u], rows[static_cast<std::size_t>(i + 1)][0u],
                      c, windFlex, phase, BotanicalPartTag::Leaf);
        EmitQuad(out, rows[static_cast<std::size_t>(i)][1u], rows[static_cast<std::size_t>(i)][2u],
                      rows[static_cast<std::size_t>(i + 1)][2u], rows[static_cast<std::size_t>(i + 1)][1u],
                      c, windFlex, phase, BotanicalPartTag::Leaf);
    }

    // Register matching 2.5D Thin-Sheet SDF instance centered at blade midpoint!
    BotanicalLeafSdfInstance lf {};
    lf.CenterMeters   = Add3(origin, Mul3(axisLen, 0.5f * lengthM));
    lf.RestCenterM    = lf.CenterMeters;
    lf.HalfSpanMeters = std::max(0.02f, 0.52f * lengthM);
    lf.AxisX          = Norm3(axisWid);
    lf.AxisY          = Norm3(axisNorm);
    lf.AxisZ          = Norm3(axisLen);
    lf.CamberX        = camberX;
    lf.CamberZ        = camberZ;
    lf.HalfThicknessM = kLeafHalfThickM;
    lf.WindFlex       = windFlex;
    lf.Phase          = phase;
    lf.Archetype      = arch;
    out.SdfVolume.Leaves.push_back(lf);
}

//========================================================================================================================
//                                    1. PROCEDURAL FERN (+Z UP, PORTED FROM FERNMESHER.TS)
//========================================================================================================================

void BuildFernGeometry(const BotanicalSpeciesDefinition& sp, uint32_t seed, uint32_t tier, BotanicalPlantBuildResult& out)
{
    DetRng rng(seed ^ 0xF312A5u);
    const auto& fp = sp.Fern;
    const auto& mat = sp.Materials;
    const V3 colWood = mat.WoodColorLinear;
    const V3 colBase = mat.LeafBaseColorLinear;
    const V3 colYoung = mat.LeafYoungColorLinear;
    const LeafSdfArchetype arch = ParseLeafArchetypeToken(sp.Leaves.LeafArchetypeSdf);

    // 1. Central fibrous rhizome/caudex mound
    EmitOvoid(out, { 0.0f, 0.0f, fp.CaudexHeightMeters * 0.5f },
        fp.CrownRadiusMeters * 1.15f, fp.CrownRadiusMeters * 1.15f, fp.CaudexHeightMeters * 1.1f,
        colWood, 0.0f, 0.0f, BotanicalPartTag::Wood);

    // 2. Coiled fiddlehead crosiers emerging at crown center!
    for (uint32_t c = 0u; c < fp.CrosierCount; ++c)
    {
        const float az = static_cast<float>(c) * kGolden + rng.Range(0.0f, 0.4f);
        const V3 outH { std::cos(az), std::sin(az), 0.0f };
        const V3 rgt  { -std::sin(az), std::cos(az), 0.0f };
        const int steps = 14;
        std::vector<Frame3> frs(static_cast<std::size_t>(steps + 1));
        std::vector<float>  rads(static_cast<std::size_t>(steps + 1));
        std::vector<float>  flx(static_cast<std::size_t>(steps + 1));
        V3 cur { outH[0] * fp.CrownRadiusMeters * 0.35f, outH[1] * fp.CrownRadiusMeters * 0.35f, fp.CaudexHeightMeters * 0.6f };
        V3 dir = Norm3(Add3({ 0.0f, 0.0f, 0.92f }, Mul3(outH, 0.38f)));
        const float segL = fp.CrosierHeightMeters / static_cast<float>(steps);
        for (int s = 0; s <= steps; ++s)
        {
            const float t = static_cast<float>(s) / static_cast<float>(steps);
            frs[static_cast<std::size_t>(s)] = { cur, dir, rgt, Norm3(Cross3(dir, rgt)), t };
            rads[static_cast<std::size_t>(s)] = fp.StipeRadiusMeters * (1.2f - 0.72f * t);
            flx[static_cast<std::size_t>(s)]  = t * 0.45f;
            const float curlRate = (t > 0.45f) ? (fp.CrosierTurns * kTau / static_cast<float>(steps)) * 1.2f : 0.08f;
            dir = RotateAxis(dir, rgt, -curlRate);
            cur = Add3(cur, Mul3(dir, segL * (1.0f - 0.45f * t)));
        }
        EmitWoodTubeAndCapsules(out, frs, rads, flx, 5u, colWood, colYoung, 0.15f, 16.0f, 2u, false, static_cast<float>(c) * 0.25f);
    }

    // 3. Golden-angle spiral rosette of arching fronds + paired auricled pinnae
    const uint32_t frondCount = std::max(4u, fp.FrondCount);
    const uint32_t rachisSteps = (tier >= 2u) ? 16u : 10u;
    const uint32_t nPairs = std::max(6u, (tier >= 2u) ? fp.PinnaPairs : (fp.PinnaPairs * 2u) / 3u);

    for (uint32_t fi = 0u; fi < frondCount; ++fi)
    {
        const float age01 = static_cast<float>(fi) / static_cast<float>(std::max(1u, frondCount - 1u));
        const float az    = static_cast<float>(fi) * kGolden + rng.Vary(0.0f, 0.12f);
        const V3 outH { std::cos(az), std::sin(az), 0.0f };
        const V3 rgt0 = Norm3(Cross3({ 0.0f, 0.0f, 1.0f }, outH));

        const float tiltRad  = std::clamp(fp.RosetteAngleDeg * (0.52f + 0.76f * age01) + rng.Vary(0.0f, 4.5f), 8.0f, 82.0f) * kDeg2Rad;
        const float L        = fp.FrondLengthMeters * (0.76f + 0.30f * std::sin(age01 * kPi * 0.72f + 0.25f)) * (1.0f + rng.Vary(0.0f, fp.FrondLengthVar));
        const float droopRad = (fp.ArchDroopDeg * (0.58f + 0.66f * age01) + rng.Vary(0.0f, 6.0f)) * kDeg2Rad;
        const float twistRad = rng.Vary(0.0f, fp.RachisTwistDeg) * kDeg2Rad;
        const float waveRad  = fp.RachisWaveDeg * kDeg2Rad;
        const float phase    = rng.Next01();

        V3 cur { outH[0] * fp.CrownRadiusMeters * (0.4f + 0.6f * age01),
                 outH[1] * fp.CrownRadiusMeters * (0.4f + 0.6f * age01),
                 fp.CaudexHeightMeters * (0.9f - 0.3f * age01) };
        V3 dir = Norm3(Add3({ 0.0f, 0.0f, std::cos(tiltRad) }, Mul3(outH, std::sin(tiltRad))));
        V3 rgt = rgt0;

        std::vector<Frame3> frs(rachisSteps + 1u);
        std::vector<float>  rads(rachisSteps + 1u);
        std::vector<float>  flx(rachisSteps + 1u);
        const float stepL = L / static_cast<float>(rachisSteps);
        const float stipeR = fp.StipeRadiusMeters * (0.82f + 0.28f * age01);

        for (uint32_t s = 0u; s <= rachisSteps; ++s)
        {
            const float t = static_cast<float>(s) / static_cast<float>(rachisSteps);
            const V3 up = Norm3(Cross3(dir, rgt));
            frs[s] = { cur, dir, rgt, up, t };
            rads[s] = stipeR * (1.0f - 0.82f * t);
            flx[s]  = std::pow(t, 1.35f);
            if (s < rachisSteps)
            {
                const float t1 = static_cast<float>(s + 1u) / static_cast<float>(rachisSteps);
                float dPitch = droopRad * (std::pow(t1, fp.ArchPower) - std::pow(t, fp.ArchPower));
                if (cur[2] < 0.06f && t > 0.45f) dPitch *= 0.30f; // Ground clearance lift
                const float dYaw  = (std::sin(t1 * kPi * 2.2f + phase * kTau) - std::sin(t * kPi * 2.2f + phase * kTau)) * waveRad;
                const float dRoll = (t1 - t) * twistRad;
                dir = Norm3(RotateAxis(dir, rgt, dPitch));
                dir = Norm3(RotateAxis(dir, up, dYaw));
                rgt = Norm3(RotateAxis(rgt, dir, dRoll));
                cur = Add3(cur, Mul3(dir, stepL));
            }
        }

        const V3 frondCol = Mix3(colYoung, colBase, std::clamp(age01 * 0.85f, 0.0f, 1.0f));
        // Emit grooved rachis tube + 3 downsampled wood capsules per frond for fast SDF shadow tracing
        EmitWoodTubeAndCapsules(out, frs, rads, flx, 5u, colWood, frondCol,
            sp.Trunk.BarkNoiseAmp, sp.Trunk.BarkNoiseFreq, 1u, false, phase);
        for (uint32_t k = 0u; k < rachisSteps; k += 4u)
        {
            const uint32_t k1 = std::min(k + 4u, rachisSteps);
            BotanicalWoodCapsule cap {};
            cap.P0 = frs[k].Pos;  cap.R0 = rads[k] * 1.3f;
            cap.P1 = frs[k1].Pos; cap.R1 = rads[k1] * 1.3f;
            cap.RestP0 = cap.P0;  cap.RestP1 = cap.P1;
            cap.WindFlex0 = flx[k]; cap.WindFlex1 = flx[k1];
            cap.BranchLevel = 1u;
            out.SdfVolume.WoodCapsules.push_back(cap);
        }

        // Emit paired pinnae along [StipeFraction .. 1.0]
        const float s0 = std::clamp(fp.StipeFraction, 0.05f, 0.50f);
        for (uint32_t pi = 0u; pi < nPairs; ++pi)
        {
            for (int side : { -1, 1 })
            {
                const float uLeaf = std::clamp((static_cast<float>(pi) + 0.45f) / static_cast<float>(nPairs)
                                             + (side > 0 ? 0.18f : -0.18f) / static_cast<float>(nPairs), 0.01f, 0.985f);
                const float tR = s0 + (1.0f - s0) * uLeaf;
                const float fIdx = tR * static_cast<float>(rachisSteps);
                const uint32_t i0 = std::min(static_cast<uint32_t>(fIdx), rachisSteps - 1u);
                const float a = fIdx - static_cast<float>(i0);
                const V3 pos = Mix3(frs[i0].Pos, frs[i0 + 1u].Pos, a);
                const V3 fDir = Norm3(Mix3(frs[i0].Dir, frs[i0 + 1u].Dir, a));
                const V3 fRgt = Norm3(Mix3(frs[i0].Right, frs[i0 + 1u].Right, a));
                const V3 fUp  = Norm3(Cross3(fDir, fRgt));

                const float env = (0.42f + 0.58f * SmoothStep(0.0f, 0.22f, uLeaf))
                                * std::pow(1.0f - std::pow(uLeaf, 1.65f), 0.68f);
                const float pLen = std::max(0.012f, fp.FrondWidthMeters * 0.52f * env * (1.0f + rng.Vary(0.0f, 0.06f)));
                const float pWid = pLen * std::clamp(sp.Leaves.BladeAspect, 0.18f, 0.55f);

                const float insRad = (fp.PinnaAngleDeg * (1.06f - 0.50f * uLeaf) + rng.Vary(0.0f, 3.0f)) * kDeg2Rad;
                const float dihRad = (12.0f - 14.0f * age01 + 6.0f * (1.0f - uLeaf)) * kDeg2Rad;
                V3 pDir = Norm3(Add3(Mul3(fDir, std::cos(insRad)), Mul3(fRgt, static_cast<float>(side) * std::sin(insRad))));
                pDir = Norm3(RotateAxis(pDir, fDir, static_cast<float>(side) * dihRad));
                const V3 pWidAx = Norm3(Cross3(fUp, pDir));
                const V3 pNorm  = Norm3(Cross3(pDir, pWidAx));

                EmitCurvedBladeAndLeafSdf(out, pos, pDir, pWidAx, pNorm, pLen, pWid * 0.5f,
                    fp.LaminaCamber, sp.Leaves.CamberZ, fp.Auricle,
                    frondCol, colYoung, std::pow(tR, 1.25f), phase + uLeaf * 0.37f, arch, 3);
            }
        }
    }
}

//========================================================================================================================
//                                    2. PROCEDURAL PALM (+Z UP, PORTED FROM PALMMESHER.TS)
//========================================================================================================================

void BuildPalmGeometry(const BotanicalSpeciesDefinition& sp, uint32_t seed, uint32_t tier, BotanicalPlantBuildResult& out)
{
    DetRng rng(seed ^ 0x9A1C77u);
    const auto& pp  = sp.Palm;
    const auto& mat = sp.Materials;
    const V3 colWood  = mat.WoodColorLinear;
    const V3 colBase  = mat.LeafBaseColorLinear;
    const V3 colYoung = mat.LeafYoungColorLinear;
    const V3 colFruit = mat.FruitColorLinear;
    const LeafSdfArchetype arch = ParseLeafArchetypeToken(sp.Leaves.LeafArchetypeSdf);

    // 1. Curved phototropic trunk with basal bole & annular/diamond leaf-boot relief
    const uint32_t tSteps = 14u;
    const float H = std::max(2.5f, sp.Trunk.HeightMeters);
    const float R0 = std::max(0.10f, sp.Trunk.BaseRadiusMeters);
    const float leanAz = rng.Range(0.0f, kTau);
    const V3 leanDir { std::cos(leanAz), std::sin(leanAz), 0.0f };
    const V3 leanRgt { -std::sin(leanAz), std::cos(leanAz), 0.0f };

    std::vector<Frame3> tFrames(tSteps + 1u);
    std::vector<float>  tRads(tSteps + 1u);
    std::vector<float>  tFlex(tSteps + 1u);
    V3 cur { 0.0f, 0.0f, 0.0f };
    const float leanRad = pp.TrunkLeanDeg * kDeg2Rad;
    const float curveRad = pp.TrunkCurveDeg * kDeg2Rad;
    const float segL = H / static_cast<float>(tSteps);

    for (uint32_t s = 0u; s <= tSteps; ++s)
    {
        const float t = static_cast<float>(s) / static_cast<float>(tSteps);
        const float ang = leanRad * (1.0f - t) + (leanRad - curveRad) * t * t;
        const V3 dir = Norm3({ leanDir[0] * std::sin(ang), leanDir[1] * std::sin(ang), std::cos(ang) });
        const V3 up  = Norm3(Cross3(dir, leanRgt));
        tFrames[s] = { cur, dir, leanRgt, up, t };
        const float bole = 1.0f + pp.BasalBole * std::exp(-t * 9.0f);
        tRads[s] = R0 * bole * (1.0f - 0.28f * t);
        tFlex[s] = std::pow(t, 1.6f) * 0.45f;
        cur = Add3(cur, Mul3(dir, segL));
    }

    EmitWoodTubeAndCapsules(out, tFrames, tRads, tFlex, (tier >= 2u) ? 10u : 8u,
        colWood, Mix3(colWood, colBase, 0.14f),
        sp.Trunk.BarkNoiseAmp, sp.Trunk.BarkNoiseFreq, 0u, true, 0.0f, pp.TrunkRelief);

    // 2. Anchoring root buttresses at base
    for (uint32_t r = 0u; r < pp.RootButtresses; ++r)
    {
        const float az = (static_cast<float>(r) / static_cast<float>(std::max(1u, pp.RootButtresses))) * kTau + rng.Vary(0.0f, 0.18f);
        const V3 rd { std::cos(az), std::sin(az), 0.0f };
        const V3 rr { -std::sin(az), std::cos(az), 0.0f };
        std::vector<Frame3> rf(4);
        std::vector<float>  rrad { R0 * 0.42f, R0 * 0.30f, R0 * 0.18f, R0 * 0.06f };
        std::vector<float>  rflx { 0.0f, 0.0f, 0.0f, 0.0f };
        for (int k = 0; k < 4; ++k)
        {
            const float u = static_cast<float>(k) / 3.0f;
            const V3 p { rd[0] * (R0 * 0.65f + sp.Roots.SpreadMeters * u),
                         rd[1] * (R0 * 0.65f + sp.Roots.SpreadMeters * u),
                         sp.Roots.ButtressHeight * std::pow(1.0f - u, 1.6f) };
            rf[static_cast<std::size_t>(k)] = { p, Norm3(Add3(rd, { 0.0f, 0.0f, -0.45f })), rr, Norm3(Cross3(rd, rr)), u };
        }
        EmitWoodTubeAndCapsules(out, rf, rrad, rflx, 5u, colWood, colWood, 0.35f, 10.0f, 0u, false, 0.0f);
    }

    // 3. Crown of arching pinnate palm fronds + V-ranked leaflets
    const V3 crownCenter = tFrames.back().Pos;
    const float crownR   = tRads.back();
    const uint32_t nFronds = std::max(8u, pp.FrondCount);
    const uint32_t nPairs  = std::max(12u, (tier >= 2u) ? pp.LeafletPairs : (pp.LeafletPairs * 2u) / 3u);
    const uint32_t fSteps  = 10u;

    for (uint32_t fi = 0u; fi < nFronds; ++fi)
    {
        const float age01 = static_cast<float>(fi) / static_cast<float>(std::max(1u, nFronds - 1u));
        const float az    = static_cast<float>(fi) * kGolden + rng.Vary(0.0f, 0.12f);
        const V3 radDir { std::cos(az), std::sin(az), 0.0f };
        const V3 rgt0   = Norm3(Cross3({ 0.0f, 0.0f, 1.0f }, radDir));
        const float elevRad = (68.0f - 78.0f * age01 + rng.Vary(0.0f, 6.0f)) * kDeg2Rad;
        const float archRad = (pp.FrondArchDeg * (0.65f + 0.55f * age01)) * kDeg2Rad;
        const float fLen    = pp.FrondLengthMeters * (0.82f + 0.25f * std::sin(age01 * kPi * 0.8f + 0.2f));
        const float phase   = rng.Next01();

        V3 fCur = Add3(crownCenter, Add3(Mul3(radDir, crownR * 0.65f), { 0.0f, 0.0f, 0.25f * (1.0f - age01) - 0.15f }));
        V3 dir  = Norm3({ radDir[0] * std::cos(elevRad), radDir[1] * std::cos(elevRad), std::sin(elevRad) });
        V3 rgt  = rgt0;

        std::vector<Frame3> frs(fSteps + 1u);
        std::vector<float>  rads(fSteps + 1u);
        std::vector<float>  flx(fSteps + 1u);
        const float stepL = fLen / static_cast<float>(fSteps);
        const float baseR = std::max(0.018f, crownR * 0.20f);

        for (uint32_t s = 0u; s <= fSteps; ++s)
        {
            const float t = static_cast<float>(s) / static_cast<float>(fSteps);
            frs[s] = { fCur, dir, rgt, Norm3(Cross3(dir, rgt)), t };
            rads[s] = baseR * std::pow(1.0f - 0.90f * t, 0.85f);
            flx[s]  = 0.45f + 0.55f * std::pow(t, 1.4f);
            if (s < fSteps)
            {
                const float dt = 1.0f / static_cast<float>(fSteps);
                const float dp = dt * archRad * (0.45f + 1.15f * t);
                dir  = Norm3(RotateAxis(dir, rgt, dp));
                fCur = Add3(fCur, Mul3(dir, stepL));
            }
        }

        const V3 frondCol = Mix3(colYoung, colBase, std::clamp(0.25f + 0.75f * age01, 0.0f, 1.0f));
        EmitWoodTubeAndCapsules(out, frs, rads, flx, 5u, colWood, frondCol, 0.25f, 12.0f, 1u, false, phase);
        // 2 wood capsules per palm rachis
        for (uint32_t k = 0u; k < fSteps; k += 5u)
        {
            const uint32_t k1 = std::min(k + 5u, fSteps);
            BotanicalWoodCapsule cap {};
            cap.P0 = frs[k].Pos; cap.R0 = rads[k] * 1.15f;
            cap.P1 = frs[k1].Pos; cap.R1 = rads[k1] * 1.15f;
            cap.RestP0 = cap.P0; cap.RestP1 = cap.P1;
            cap.WindFlex0 = flx[k]; cap.WindFlex1 = flx[k1];
            cap.BranchLevel = 1u;
            out.SdfVolume.WoodCapsules.push_back(cap);
        }

        // Emit V-ranked / plumose pinnate leaflets
        for (uint32_t pi = 0u; pi < nPairs; ++pi)
        {
            const float u = 0.14f + 0.84f * (static_cast<float>(pi) / static_cast<float>(std::max(1u, nPairs - 1u)));
            const float fIdx = u * static_cast<float>(fSteps);
            const uint32_t i0 = std::min(static_cast<uint32_t>(fIdx), fSteps - 1u);
            const float a = fIdx - static_cast<float>(i0);
            const V3 pos  = Mix3(frs[i0].Pos, frs[i0 + 1u].Pos, a);
            const V3 fDir = Norm3(Mix3(frs[i0].Dir, frs[i0 + 1u].Dir, a));
            const V3 fRgt = Norm3(Mix3(frs[i0].Right, frs[i0 + 1u].Right, a));
            const V3 fUp  = Norm3(Cross3(fDir, fRgt));

            const float env = std::sin(kPi * std::pow(u, 0.72f));
            const float lLen = pp.FrondWidthMeters * 0.56f * std::max(0.18f, env);
            const float lWid = lLen * 0.13f;

            for (int side : { -1, 1 })
            {
                const float sweepRad = (56.0f - 28.0f * u) * kDeg2Rad;
                const float vTiltRad = (24.0f + pp.PlumoseSplay * rng.Vary(0.0f, 38.0f)) * kDeg2Rad;
                V3 lDir = Norm3(Add3(Mul3(fDir, std::cos(sweepRad)), Mul3(fRgt, static_cast<float>(side) * std::sin(sweepRad))));
                lDir = Norm3(RotateAxis(lDir, fDir, static_cast<float>(side) * vTiltRad));
                const V3 lWidAx = Norm3(Cross3(fUp, lDir));
                const V3 lNorm  = Norm3(Cross3(lDir, lWidAx));
                EmitCurvedBladeAndLeafSdf(out, pos, lDir, lWidAx, lNorm, lLen, lWid * 0.5f,
                    0.22f, 0.24f, 0.0f, frondCol, colYoung, 0.55f + 0.45f * u, phase + u * 0.41f, arch, 3);
            }
        }
    }

    // 4. 3D Fruiting spadices & Medjool date / coconut clusters below crown
    if (pp.ShowFruits && pp.FruitBunches > 0u)
    {
        const bool isCoconut = (sp.Architecture == "coconut_palm");
        for (uint32_t b = 0u; b < pp.FruitBunches; ++b)
        {
            const float az = (static_cast<float>(b) / static_cast<float>(pp.FruitBunches)) * kTau + 0.35f;
            const V3 base = Add3(crownCenter, { std::cos(az) * crownR * 1.1f, std::sin(az) * crownR * 1.1f, -0.32f });
            const int nFruits = isCoconut ? 5 : 14;
            for (int k = 0; k < nFruits; ++k)
            {
                const float th = static_cast<float>(k) * kGolden;
                const float rOff = isCoconut ? 0.14f : (0.10f + 0.12f * rng.Next01());
                const float zOff = -0.10f - (isCoconut ? 0.16f : 0.48f) * rng.Next01();
                const V3 fp = Add3(base, { std::cos(th) * rOff, std::sin(th) * rOff, zOff });
                const float fr = isCoconut ? 0.10f : 0.038f;
                EmitOvoid(out, fp, fr, fr, fr * 1.32f, colFruit, 0.48f, static_cast<float>(b) * 0.2f, BotanicalPartTag::Fruit);
            }
        }
    }
}

//========================================================================================================================
//                                    3. PROCEDURAL ENGLISH OAK (+Z UP, PORTED FROM TREEMESHER.TS)
//========================================================================================================================

void BuildTreeGeometry(const BotanicalSpeciesDefinition& sp, uint32_t seed, uint32_t tier, BotanicalPlantBuildResult& out)
{
    DetRng rng(seed ^ 0x0A47B2u);
    const auto& tp  = sp.Tree;
    const auto& mat = sp.Materials;
    const V3 colWood  = mat.WoodColorLinear;
    const V3 colBase  = mat.LeafBaseColorLinear;
    const V3 colYoung = mat.LeafYoungColorLinear;
    const LeafSdfArchetype arch = ParseLeafArchetypeToken(sp.Leaves.LeafArchetypeSdf);

    const float H  = std::max(4.0f, sp.Trunk.HeightMeters);
    const float R0 = std::max(0.14f, sp.Trunk.BaseRadiusMeters);

    // 1. Anchoring buttress surface roots
    for (uint32_t r = 0u; r < sp.Roots.Count; ++r)
    {
        const float az = (static_cast<float>(r) / static_cast<float>(std::max(1u, sp.Roots.Count))) * kTau + rng.Vary(0.0f, 0.22f);
        const V3 rd { std::cos(az), std::sin(az), 0.0f };
        const V3 rr { -std::sin(az), std::cos(az), 0.0f };
        std::vector<Frame3> rf(5);
        std::vector<float>  rrad { R0 * 0.56f, R0 * 0.42f, R0 * 0.28f, R0 * 0.16f, R0 * 0.06f };
        std::vector<float>  rflx { 0.0f, 0.0f, 0.0f, 0.0f, 0.0f };
        for (int k = 0; k < 5; ++k)
        {
            const float u = static_cast<float>(k) / 4.0f;
            const float lateral = std::sin(u * kPi) * 0.22f * (r % 2 == 0 ? 1.0f : -1.0f);
            const V3 p { rd[0] * (R0 * 0.5f + sp.Roots.SpreadMeters * u) + rr[0] * lateral,
                         rd[1] * (R0 * 0.5f + sp.Roots.SpreadMeters * u) + rr[1] * lateral,
                         sp.Roots.ButtressHeight * std::pow(1.0f - u, 1.9f) };
            rf[static_cast<std::size_t>(k)] = { p, Norm3(Add3(rd, { 0.0f, 0.0f, -0.35f })), rr, Norm3(Cross3(rd, rr)), u };
        }
        EmitWoodTubeAndCapsules(out, rf, rrad, rflx, 6u, colWood, colWood, sp.Trunk.BarkNoiseAmp, sp.Trunk.BarkNoiseFreq, 0u, true, 0.0f);
    }

    // Recursive multi-level gnarled shoot builder (da Vinci pipe-model cross-section taper!)
    struct TwigLeafSpot { V3 Pos; V3 Dir; float Flex; float Phase; };
    std::vector<TwigLeafSpot> leafSpots {};

    auto growBranch = [&](auto&& self, const V3& startPos, const V3& startDir, float lengthM, float baseR,
                          uint32_t level, float flexBase) -> void
    {
        const uint32_t segs = (level == 0u) ? 8u : ((level == 1u) ? 5u : 3u);
        std::vector<Frame3> frs(segs + 1u);
        std::vector<float>  rads(segs + 1u);
        std::vector<float>  flx(segs + 1u);
        V3 cur = startPos;
        V3 dir = Norm3(startDir);
        V3 rgt = Norm3(Cross3(dir, (std::fabs(dir[2]) < 0.9f) ? V3{ 0.0f, 0.0f, 1.0f } : V3{ 1.0f, 0.0f, 0.0f }));
        const float stepL = lengthM / static_cast<float>(segs);

        for (uint32_t s = 0u; s <= segs; ++s)
        {
            const float t = static_cast<float>(s) / static_cast<float>(segs);
            const V3 up = Norm3(Cross3(dir, rgt));
            frs[s] = { cur, dir, rgt, up, t };
            const float flare = (level == 0u) ? (1.0f + (sp.Trunk.FlareRatio - 1.0f) * std::exp(-t * 8.0f)) : 1.0f;
            rads[s] = std::max(0.014f, baseR * flare * std::pow(1.0f - 0.56f * t, sp.Trunk.TaperExponent));
            flx[s]  = std::clamp(flexBase + (1.0f - flexBase) * t * (level == 0u ? 0.35f : 0.65f), 0.0f, 1.0f);
            if (s < segs)
            {
                const float gnarl = sp.Trunk.GnarlAmplitude * (level == 0u ? 0.16f : 0.38f);
                const V3 jitter { rng.Vary(0.0f, gnarl), rng.Vary(0.0f, gnarl),
                                  (level >= 1u ? (0.10f - 0.18f * tp.CanopyFlatten) : 0.06f) };
                dir = Norm3(Add3(dir, jitter));
                // Parallel-transport rgt without 180-deg sign flip!
                rgt = Norm3(Sub3(rgt, Mul3(dir, Dot3(rgt, dir))));
                cur = Add3(cur, Mul3(dir, stepL));
            }
        }

        const uint32_t radialSides = (level == 0u) ? ((tier >= 2u) ? 10u : 8u) : ((level == 1u) ? 6u : 4u);
        EmitWoodTubeAndCapsules(out, frs, rads, flx, radialSides,
            colWood, Mix3(colWood, { 0.18f, 0.14f, 0.10f }, 0.22f * static_cast<float>(level)),
            sp.Trunk.BarkNoiseAmp, sp.Trunk.BarkNoiseFreq, level, (level <= 1u), static_cast<float>(level) * 0.3f);

        if (level < tp.BranchLevels)
        {
            const uint32_t childCount = (level == 0u) ? tp.LimbCount : ((level == 1u) ? 4u : 3u);
            for (uint32_t ci = 0u; ci < childCount; ++ci)
            {
                const float u = (level == 0u)
                    ? (0.34f + 0.64f * (static_cast<float>(ci) / static_cast<float>(std::max(1u, childCount - 1u))))
                    : (0.28f + 0.70f * (static_cast<float>(ci) / static_cast<float>(std::max(1u, childCount - 1u))));
                const float fIdx = u * static_cast<float>(segs);
                const uint32_t i0 = std::min(static_cast<uint32_t>(fIdx), segs - 1u);
                const float a = fIdx - static_cast<float>(i0);
                const V3 cPos = Mix3(frs[i0].Pos, frs[i0 + 1u].Pos, a);
                const V3 pDir = Norm3(Mix3(frs[i0].Dir, frs[i0 + 1u].Dir, a));
                const float pRad = rads[i0] + (rads[i0 + 1u] - rads[i0]) * a;
                const float cFlx = flx[i0] + (flx[i0 + 1u] - flx[i0]) * a;

                const float az = static_cast<float>(ci) * kGolden + rng.Vary(0.0f, 0.35f);
                const float downRad = (tp.BranchAngleDeg + rng.Vary(0.0f, 12.0f)) * kDeg2Rad;
                const V3 perp = Norm3(Add3(Mul3(frs[i0].Right, std::cos(az)), Mul3(frs[i0].Up, std::sin(az))));
                const V3 cDir = Norm3(Add3(Mul3(pDir, std::cos(downRad)), Mul3(perp, std::sin(downRad))));

                // Da Vinci pipe-model child radius & length taper
                const float cLen = lengthM * (level == 0u ? (0.58f - 0.22f * u) : 0.64f) * rng.Range(0.85f, 1.15f);
                const float cRad = pRad * std::pow(tp.PipeConservation / static_cast<float>(std::max(1u, childCount / 2u)), 0.38f);
                self(self, cPos, cDir, cLen, std::min(pRad * 0.78f, cRad), level + 1u, cFlx);
            }
        }

        if (level >= std::max(1u, tp.BranchLevels - 1u))
        {
            for (uint32_t s = 1u; s <= segs; ++s)
            {
                leafSpots.push_back({ frs[s].Pos, frs[s].Dir, flx[s], rng.Next01() });
            }
        }
    };

    growBranch(growBranch, { 0.0f, 0.0f, 0.0f }, { 0.0f, 0.0f, 1.0f }, H * 0.72f, R0, 0u, 0.0f);

    // 2. Lush, layered lobed oak foliage canopy sprays around terminal limbs & twigs
    const uint32_t leavesPerSpot = std::max(5u, static_cast<uint32_t>(std::round(9.5f * tp.LeafDensity)));
    for (const auto& spSpot : leafSpots)
    {
        for (uint32_t k = 0u; k < leavesPerSpot; ++k)
        {
            const float az = static_cast<float>(k) * kGolden + spSpot.Phase * kTau;
            const float el = rng.Range(-0.32f, 0.75f);
            const V3 lDir = Norm3({ std::cos(az) * std::cos(el), std::sin(az) * std::cos(el), std::sin(el) });
            const V3 lWid = Norm3(Cross3({ 0.0f, 0.0f, 1.0f }, lDir));
            const V3 lNrm = Norm3(Cross3(lDir, lWid));
            const V3 jitter { rng.Vary(0.0f, 0.48f), rng.Vary(0.0f, 0.48f), rng.Vary(0.0f, 0.36f) };
            const V3 pos = Add3(spSpot.Pos, jitter);
            const float len = tp.LeafSizeMeters * rng.Range(1.85f, 2.85f); // Rich lobed oak foliage sprays
            const float wid = len * std::clamp(sp.Leaves.BladeAspect * 1.15f, 0.52f, 0.88f);
            const float sunBias = std::clamp((pos[2] / H), 0.0f, 1.0f);
            const V3 col = Mix3(colBase, colYoung, sunBias * 0.52f + rng.Next01() * 0.22f);
            EmitCurvedBladeAndLeafSdf(out, pos, lDir, lWid, lNrm, len, wid * 0.5f,
                sp.Leaves.CamberX, sp.Leaves.CamberZ, 0.0f, col, colYoung,
                spSpot.Flex, spSpot.Phase + static_cast<float>(k) * 0.17f, arch, 3);
        }
    }
}

void PopulatePolygonNetwork(BotanicalPlantBuildResult& out)
{
    out.Network = {};
    out.Network.Vertices.reserve(out.Triangles.size() * 3u);
    out.Network.Faces.reserve(out.Triangles.size());
    out.Network.Edges.reserve(out.Triangles.size() * 3u);

    for (const auto& t : out.Triangles)
    {
        const uint32_t vBase = static_cast<uint32_t>(out.Network.Vertices.size());
        const uint32_t eBase = static_cast<uint32_t>(out.Network.Edges.size());
        const uint32_t fIdx  = static_cast<uint32_t>(out.Network.Faces.size());

        const std::array<V3, 3u> pts { t.V0, t.V1, t.V2 };
        for (uint32_t k = 0u; k < 3u; ++k)
        {
            Vertex v {};
            v.Axes = { pts[k][0], pts[k][1], pts[k][2] };
            v.Normal = { t.Normal[0], t.Normal[1], t.Normal[2] };
            v.OutgoingEdgeIndex = eBase + k;
            out.Network.Vertices.push_back(v);
        }
        for (uint32_t k = 0u; k < 3u; ++k)
        {
            DirectedEdge de {};
            de.OriginVertexIndex  = vBase + k;
            de.NextEdgeIndex      = eBase + ((k + 1u) % 3u);
            de.PreviousEdgeIndex  = eBase + ((k + 2u) % 3u);
            de.EnclosingFaceIndex = fIdx;
            out.Network.Edges.push_back(de);
        }
        Face f {};
        f.BoundaryLoopEdgeIndex = eBase;
        f.GeometricNormal       = { t.Normal[0], t.Normal[1], t.Normal[2] };
        f.CornerCount           = 3u;
        f.PartGroupOrdinal      = static_cast<uint16_t>(t.Part);
        f.Shading.AlbedoLinearRGB = { t.ColorLin[0], t.ColorLin[1], t.ColorLin[2] };
        f.Shading.Roughness       = (t.Part == BotanicalPartTag::Wood) ? 0.82f : 0.48f;
        f.Shading.Metallic        = 0.0f;
        out.Network.Faces.push_back(f);
    }
}

} // namespace

BotanicalPlantBuildResult BuildBotanicalPlant(
    const BotanicalSpeciesDefinition& species,
    const LeafArchetypeSdfAtlas&      leafAtlas,
    const uint32_t                    seed,
    const uint32_t                    detailTier,
    const bool                        buildPolygonNetwork)
{
    BotanicalPlantBuildResult out {};
    out.SpeciesId  = species.SpeciesId;
    out.GrowthForm = species.GrowthForm;
    out.Seed       = seed;
    out.SdfVolume.BrickRes      = species.Sdf.CanopyBrickRes;
    out.SdfVolume.BarkNoiseAmp  = species.Sdf.UseNoisyCapsules ? species.Trunk.BarkNoiseAmp : 0.0f;
    out.SdfVolume.BarkNoiseFreq = species.Trunk.BarkNoiseFreq;

    if (species.GrowthForm == BotanicalGrowthForm::Fern)
    {
        BuildFernGeometry(species, seed, detailTier, out);
    }
    else if (species.GrowthForm == BotanicalGrowthForm::Palm)
    {
        BuildPalmGeometry(species, seed, detailTier, out);
    }
    else
    {
        BuildTreeGeometry(species, seed, detailTier, out);
    }

    // Compute exact bounding box
    out.BoundsMin = {  1.0e6f,  1.0e6f,  1.0e6f };
    out.BoundsMax = { -1.0e6f, -1.0e6f, -1.0e6f };
    for (const auto& t : out.Triangles)
    {
        for (const auto* p : { &t.V0, &t.V1, &t.V2 })
        {
            for (int k = 0; k < 3; ++k)
            {
                out.BoundsMin[static_cast<std::size_t>(k)] = std::min(out.BoundsMin[static_cast<std::size_t>(k)], (*p)[static_cast<std::size_t>(k)]);
                out.BoundsMax[static_cast<std::size_t>(k)] = std::max(out.BoundsMax[static_cast<std::size_t>(k)], (*p)[static_cast<std::size_t>(k)]);
            }
        }
    }

    // Build 16^3 Canopy Brick SDF accelerator (with wind sway padding)
    const float spanH = std::max(0.5f, out.BoundsMax[2] - out.BoundsMin[2]);
    out.SdfVolume.BuildCanopyBricks(leafAtlas, std::min(0.65f, spanH * 0.12f));

    if (buildPolygonNetwork)
    {
        PopulatePolygonNetwork(out);
    }

    return out;
}

void ApplyWindPoseToPlant(
    BotanicalPlantBuildResult& plant,
    const float                bendAngleXRad,
    const float                bendAngleYRad,
    const float                gustTimeSec,
    const float                rustleAmp) noexcept
{
    auto bendPt = [&](const V3& rest, float flex, float phase) -> V3
    {
        const float h = std::max(0.0f, rest[2]);
        const float rustle = rustleAmp * flex * std::sin(gustTimeSec * 6.5f + phase * kTau) * 0.04f;
        const float dx = (bendAngleXRad * h + rustle) * flex;
        const float dy = (bendAngleYRad * h + rustle * 0.7f) * flex;
        const float dz = -0.35f * (dx * dx + dy * dy) / std::max(h, 0.35f);
        return { rest[0] + dx, rest[1] + dy, std::max(0.0f, rest[2] + dz) };
    };

    for (auto& t : plant.Triangles)
    {
        t.V0 = bendPt(t.RestV0, t.WindFlex, t.Phase);
        t.V1 = bendPt(t.RestV1, t.WindFlex, t.Phase);
        t.V2 = bendPt(t.RestV2, t.WindFlex, t.Phase);
        t.Normal = Norm3(Cross3(Sub3(t.V1, t.V0), Sub3(t.V2, t.V0)), t.Normal);
    }

    // Sync SDF wood capsules & 2.5D leaves 1:1 with render mesh (preserving RestP0/RestP1 for zero bark noise swimming!)
    plant.SdfVolume.ApplyWindBend(bendAngleXRad, bendAngleYRad, gustTimeSec, rustleAmp);
}

} // namespace Frontier::GeometrySpace::Botanical
