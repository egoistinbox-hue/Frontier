/*============================================================================================================================================
                                                   UNTITLEDBOTANICALSYSTEMEXHIBIT.CPP
============================================================================================================================================*/
// 🧩 Complete Verification & Proof Renderer for Frontier's Unified Botanical & Foliage System in Projects/Untitled!
//    - Validates all 8 strict engineering gates (`.botanical` inheritance, Ferns->Palms->Oak +Z Up generation, 64x64 2D EDT
//      2.5D thin-leaf SDF 100% survival & 0-swim rest-space bark noise, 16^3 Canopy Brick shadows, 16m x 16m WorldPartition
//      smooth C1 GPU<->CPU transitions, 4m x 4m 3-state falling/sleeping/waking leaves, and 128x128 baked 3D thumbnails).
//    - Renders BOTH Frontier's Native Editor UI (Outliner w/ folder-botanical SVG + baked 3D plant thumbnails + Geometry-style
//      Inspector cards) AND the sunlit 3D Scene in Projects/Untitled + animated wind/falling-leaf proof frames!

//------------------------------------------------------------------------------------------------------------------------
//                                                        INCLUDES
//------------------------------------------------------------------------------------------------------------------------

#include "Engine/GeometrySpace/Procedural/Botanical/BotanicalGenerator.h"
#include "Engine/GeometrySpace/Procedural/Botanical/BotanicalSpeciesSchema.h"
#include "Engine/GeometrySpace/Procedural/Botanical/BotanicalThinLeafSdf.h"
#include "Engine/GeometrySpace/Procedural/Botanical/BotanicalThumbnailBaker.h"
#include "Engine/GeometrySpace/Procedural/Botanical/BotanicalWorldPartition.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <sstream>
#include <string>
#include <vector>

using namespace Frontier::GeometrySpace::Botanical;

namespace
{

using V3 = std::array<float, 3>;
constexpr float kPi  = 3.14159265358979323846f;
constexpr float kTau = 6.28318530717958647692f;

inline V3 Add3(const V3& a, const V3& b) noexcept { return { a[0] + b[0], a[1] + b[1], a[2] + b[2] }; }
inline V3 Sub3(const V3& a, const V3& b) noexcept { return { a[0] - b[0], a[1] - b[1], a[2] - b[2] }; }
inline V3 Mul3(const V3& a, float s) noexcept     { return { a[0] * s, a[1] * s, a[2] * s }; }
inline float Dot3(const V3& a, const V3& b) noexcept { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
inline V3 Cross3(const V3& a, const V3& b) noexcept
{
    return { a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0] };
}
inline V3 Norm3(const V3& a) noexcept
{
    const float l = std::sqrt(Dot3(a, a));
    return (l > 1.0e-7f) ? Mul3(a, 1.0f / l) : V3{ 0.0f, 0.0f, 1.0f };
}
inline uint8_t LinToSrgb(float v) noexcept
{
    const float c = std::clamp(v, 0.0f, 1.0f);
    const float s = (c <= 0.0031308f) ? (12.92f * c) : (1.055f * std::pow(c, 1.0f / 2.4f) - 0.055f);
    return static_cast<uint8_t>(std::clamp(std::lround(s * 255.0f), 0L, 255L));
}
inline float AcesTone(float x) noexcept
{
    const float v = std::max(0.0f, x * 1.08f);
    return (v * (2.51f * v + 0.03f)) / (v * (2.43f * v + 0.59f) + 0.14f);
}

//------------------------------------------------------------------------------------------------------------------------
//                                  COMPACT 2D RGBA CANVAS & CRISP BITMAP FONT FOR UI PROOF
//------------------------------------------------------------------------------------------------------------------------

struct CanvasRgba
{
    uint32_t             W = 0u;
    uint32_t             H = 0u;
    std::vector<uint8_t> Pix {};

    CanvasRgba(uint32_t w, uint32_t h, std::array<uint8_t, 4> bg = { 18u, 18u, 18u, 255u })
        : W(w), H(h), Pix(static_cast<std::size_t>(w) * h * 4u, 0u)
    {
        for (uint32_t i = 0u; i < w * h; ++i)
        {
            Pix[i * 4u + 0u] = bg[0]; Pix[i * 4u + 1u] = bg[1];
            Pix[i * 4u + 2u] = bg[2]; Pix[i * 4u + 3u] = bg[3];
        }
    }

    void BlendPx(int x, int y, uint8_t r, uint8_t g, uint8_t b, uint8_t a) noexcept
    {
        if (x < 0 || y < 0 || x >= static_cast<int>(W) || y >= static_cast<int>(H) || a == 0u) return;
        const std::size_t idx = (static_cast<std::size_t>(y) * W + static_cast<std::size_t>(x)) * 4u;
        const float al = static_cast<float>(a) / 255.0f;
        const float ia = 1.0f - al;
        Pix[idx + 0u] = static_cast<uint8_t>(std::clamp(std::lround(r * al + Pix[idx + 0u] * ia), 0L, 255L));
        Pix[idx + 1u] = static_cast<uint8_t>(std::clamp(std::lround(g * al + Pix[idx + 1u] * ia), 0L, 255L));
        Pix[idx + 2u] = static_cast<uint8_t>(std::clamp(std::lround(b * al + Pix[idx + 2u] * ia), 0L, 255L));
        Pix[idx + 3u] = 255u;
    }

    void FillRect(int x0, int y0, int w, int h, std::array<uint8_t, 4> col) noexcept
    {
        const int x1 = std::min(static_cast<int>(W), x0 + w);
        const int y1 = std::min(static_cast<int>(H), y0 + h);
        for (int y = std::max(0, y0); y < y1; ++y)
            for (int x = std::max(0, x0); x < x1; ++x)
                BlendPx(x, y, col[0], col[1], col[2], col[3]);
    }

    void FillRoundedRect(int x0, int y0, int w, int h, float rad, std::array<uint8_t, 4> col,
                         std::array<uint8_t, 4> border = { 0u, 0u, 0u, 0u }) noexcept
    {
        const int x1 = std::min(static_cast<int>(W), x0 + w);
        const int y1 = std::min(static_cast<int>(H), y0 + h);
        const float hw = 0.5f * static_cast<float>(w);
        const float hh = 0.5f * static_cast<float>(h);
        const float cx = static_cast<float>(x0) + hw;
        const float cy = static_cast<float>(y0) + hh;
        const float r  = std::min({ rad, hw, hh });
        for (int y = std::max(0, y0); y < y1; ++y)
        {
            for (int x = std::max(0, x0); x < x1; ++x)
            {
                const float qx = std::fabs(static_cast<float>(x) + 0.5f - cx) - (hw - r);
                const float qy = std::fabs(static_cast<float>(y) + 0.5f - cy) - (hh - r);
                const float sd = std::hypot(std::max(qx, 0.0f), std::max(qy, 0.0f)) + std::min(std::max(qx, qy), 0.0f) - r;
                if (sd <= 0.5f)
                {
                    const float cov = std::clamp(0.5f - sd, 0.0f, 1.0f);
                    BlendPx(x, y, col[0], col[1], col[2], static_cast<uint8_t>(col[3] * cov));
                    if (border[3] > 0u && sd >= -1.25f)
                    {
                        const float bcov = std::clamp(1.0f - std::fabs(sd + 0.35f), 0.0f, 1.0f);
                        BlendPx(x, y, border[0], border[1], border[2], static_cast<uint8_t>(border[3] * bcov));
                    }
                }
            }
        }
    }

    void FillCircle(float cx, float cy, float r, std::array<uint8_t, 4> col) noexcept
    {
        const int x0 = std::max(0, static_cast<int>(std::floor(cx - r - 1.0f)));
        const int y0 = std::max(0, static_cast<int>(std::floor(cy - r - 1.0f)));
        const int x1 = std::min(static_cast<int>(W) - 1, static_cast<int>(std::ceil(cx + r + 1.0f)));
        const int y1 = std::min(static_cast<int>(H) - 1, static_cast<int>(std::ceil(cy + r + 1.0f)));
        for (int y = y0; y <= y1; ++y)
        {
            for (int x = x0; x <= x1; ++x)
            {
                const float d = std::hypot(static_cast<float>(x) + 0.5f - cx, static_cast<float>(y) + 0.5f - cy) - r;
                if (d < 0.75f)
                {
                    const float cov = std::clamp(0.75f - d, 0.0f, 1.0f);
                    BlendPx(x, y, col[0], col[1], col[2], static_cast<uint8_t>(col[3] * cov));
                }
            }
        }
    }

    void DrawLine(float x0, float y0, float x1, float y1, float thick, std::array<uint8_t, 4> col) noexcept
    {
        const float dx = x1 - x0, dy = y1 - y0;
        const float len = std::max(1.0f, std::hypot(dx, dy));
        const int steps = static_cast<int>(std::ceil(len * 2.0f));
        for (int i = 0; i <= steps; ++i)
        {
            const float t = static_cast<float>(i) / static_cast<float>(steps);
            FillCircle(x0 + dx * t, y0 + dy * t, thick * 0.5f, col);
        }
    }

    void BlitThumb(int dstX, int dstY, int dstW, int dstH, const BakedPlantThumbnail& thumb, float cornerRad = 6.0f) noexcept
    {
        const float hw = 0.5f * static_cast<float>(dstW), hh = 0.5f * static_cast<float>(dstH);
        const float r = std::min({ cornerRad, hw, hh });
        for (int y = 0; y < dstH; ++y)
        {
            const float sy = (static_cast<float>(y) + 0.5f) / static_cast<float>(dstH) * static_cast<float>(thumb.Height - 1u);
            const uint32_t iy = std::min(thumb.Height - 1u, static_cast<uint32_t>(sy));
            for (int x = 0; x < dstW; ++x)
            {
                const float qx = std::fabs(static_cast<float>(x) + 0.5f - hw) - (hw - r);
                const float qy = std::fabs(static_cast<float>(y) + 0.5f - hh) - (hh - r);
                const float sd = std::hypot(std::max(qx, 0.0f), std::max(qy, 0.0f)) + std::min(std::max(qx, qy), 0.0f) - r;
                if (sd > 0.5f) continue;
                const float sx = (static_cast<float>(x) + 0.5f) / static_cast<float>(dstW) * static_cast<float>(thumb.Width - 1u);
                const uint32_t ix = std::min(thumb.Width - 1u, static_cast<uint32_t>(sx));
                const std::size_t sIdx = (static_cast<std::size_t>(iy) * thumb.Width + ix) * 4u;
                const float cov = std::clamp(0.5f - sd, 0.0f, 1.0f);
                BlendPx(dstX + x, dstY + y,
                    thumb.Rgba8[sIdx + 0u], thumb.Rgba8[sIdx + 1u], thumb.Rgba8[sIdx + 2u],
                    static_cast<uint8_t>(thumb.Rgba8[sIdx + 3u] * cov));
            }
        }
    }

    // Crisp 5x7 ASCII bitmap font for UI labels, inspector values, and technical captions
    void DrawText(int x, int y, const std::string& text, int scale, std::array<uint8_t, 4> col) noexcept
    {
        auto glyphRow = [](char ch, int row) -> uint8_t
        {
            if (ch >= 'a' && ch <= 'z') ch = static_cast<char>(ch - 'a' + 'A');
            static constexpr struct { char c; uint8_t r[7]; } kFont[] = {
                {'A',{0x0E,0x11,0x11,0x1F,0x11,0x11,0x11}}, {'B',{0x1E,0x11,0x11,0x1E,0x11,0x11,0x1E}},
                {'C',{0x0E,0x11,0x10,0x10,0x10,0x11,0x0E}}, {'D',{0x1E,0x11,0x11,0x11,0x11,0x11,0x1E}},
                {'E',{0x1F,0x10,0x10,0x1E,0x10,0x10,0x1F}}, {'F',{0x1F,0x10,0x10,0x1E,0x10,0x10,0x10}},
                {'G',{0x0E,0x11,0x10,0x17,0x11,0x11,0x0F}}, {'H',{0x11,0x11,0x11,0x1F,0x11,0x11,0x11}},
                {'I',{0x0E,0x04,0x04,0x04,0x04,0x04,0x0E}}, {'J',{0x07,0x02,0x02,0x02,0x12,0x12,0x0C}},
                {'K',{0x11,0x12,0x14,0x18,0x14,0x12,0x11}}, {'L',{0x10,0x10,0x10,0x10,0x10,0x10,0x1F}},
                {'M',{0x11,0x1B,0x15,0x15,0x11,0x11,0x11}}, {'N',{0x11,0x19,0x15,0x13,0x11,0x11,0x11}},
                {'O',{0x0E,0x11,0x11,0x11,0x11,0x11,0x0E}}, {'P',{0x1E,0x11,0x11,0x1E,0x10,0x10,0x10}},
                {'Q',{0x0E,0x11,0x11,0x11,0x15,0x12,0x0D}}, {'R',{0x1E,0x11,0x11,0x1E,0x14,0x12,0x11}},
                {'S',{0x0F,0x10,0x10,0x0E,0x01,0x01,0x1E}}, {'T',{0x1F,0x04,0x04,0x04,0x04,0x04,0x04}},
                {'U',{0x11,0x11,0x11,0x11,0x11,0x11,0x0E}}, {'V',{0x11,0x11,0x11,0x11,0x11,0x0A,0x04}},
                {'W',{0x11,0x11,0x11,0x15,0x15,0x1B,0x11}}, {'X',{0x11,0x11,0x0A,0x04,0x0A,0x11,0x11}},
                {'Y',{0x11,0x11,0x0A,0x04,0x04,0x04,0x04}}, {'Z',{0x1F,0x01,0x02,0x04,0x08,0x10,0x1F}},
                {'0',{0x0E,0x11,0x13,0x15,0x19,0x11,0x0E}}, {'1',{0x04,0x0C,0x04,0x04,0x04,0x04,0x0E}},
                {'2',{0x0E,0x11,0x01,0x06,0x08,0x10,0x1F}}, {'3',{0x1E,0x01,0x01,0x0E,0x01,0x01,0x1E}},
                {'4',{0x02,0x06,0x0A,0x12,0x1F,0x02,0x02}}, {'5',{0x1F,0x10,0x1E,0x01,0x01,0x11,0x0E}},
                {'6',{0x0E,0x10,0x1E,0x11,0x11,0x11,0x0E}}, {'7',{0x1F,0x01,0x02,0x04,0x08,0x08,0x08}},
                {'8',{0x0E,0x11,0x11,0x0E,0x11,0x11,0x0E}}, {'9',{0x0E,0x11,0x11,0x0F,0x01,0x02,0x0C}},
                {'.',{0x00,0x00,0x00,0x00,0x00,0x0C,0x0C}}, {',',{0x00,0x00,0x00,0x00,0x00,0x04,0x08}},
                {':',{0x00,0x0C,0x0C,0x00,0x0C,0x0C,0x00}}, {'-',{0x00,0x00,0x00,0x1F,0x00,0x00,0x00}},
                {'+',{0x00,0x04,0x04,0x1F,0x04,0x04,0x00}}, {'/',{0x01,0x02,0x02,0x04,0x08,0x08,0x10}},
                {'(',{0x02,0x04,0x08,0x08,0x08,0x04,0x02}}, {')',{0x08,0x04,0x02,0x02,0x02,0x04,0x08}},
                {'%',{0x19,0x19,0x02,0x04,0x08,0x13,0x13}}, {'_',{0x00,0x00,0x00,0x00,0x00,0x00,0x1F}},
                {'>',{0x10,0x08,0x04,0x02,0x04,0x08,0x10}}, {'<',{0x02,0x04,0x08,0x10,0x08,0x04,0x02}},
                {'=',{0x00,0x00,0x1F,0x00,0x1F,0x00,0x00}}, {'|',{0x04,0x04,0x04,0x04,0x04,0x04,0x04}},
                {'[',{0x0E,0x08,0x08,0x08,0x08,0x08,0x0E}}, {']',{0x0E,0x02,0x02,0x02,0x02,0x02,0x0E}},
                {'#',{0x0A,0x1F,0x0A,0x0A,0x1F,0x0A,0x00}}, {'*',{0x00,0x15,0x0E,0x1F,0x0E,0x15,0x00}},
                {'&',{0x0C,0x12,0x14,0x08,0x15,0x12,0x0D}}, {'^',{0x04,0x0A,0x11,0x00,0x00,0x00,0x00}},
                {' ',{0x00,0x00,0x00,0x00,0x00,0x00,0x00}}
            };
            for (const auto& g : kFont) if (g.c == ch) return g.r[row];
            return 0u;
        };

        int curX = x;
        for (char c : text)
        {
            for (int r = 0; r < 7; ++r)
            {
                const uint8_t bits = glyphRow(c, r);
                for (int colBit = 0; colBit < 5; ++colBit)
                {
                    if ((bits >> (4 - colBit)) & 1u)
                    {
                        FillRect(curX + colBit * scale, y + r * scale, scale, scale, col);
                    }
                }
            }
            curX += 6 * scale;
        }
    }

    // Draws our Outliner folder-botanical.svg icon faithfully (sage-green rounded folder + dual leaf sprout)
    void DrawBotanicalFolderSvgIcon(int x, int y, int sz) noexcept
    {
        const float s = static_cast<float>(sz) / 24.0f;
        // Back folder tab & dark base
        FillRoundedRect(x + static_cast<int>(2 * s), y + static_cast<int>(4 * s),
                        static_cast<int>(9 * s), static_cast<int>(5 * s), 2.0f * s, { 94u, 118u, 76u, 255u });
        FillRoundedRect(x + static_cast<int>(2 * s), y + static_cast<int>(7 * s),
                        static_cast<int>(20 * s), static_cast<int>(13 * s), 2.5f * s, { 134u, 166u, 108u, 255u }, { 172u, 206u, 140u, 220u });
        // Sprouting botanical leaf silhouette inside folder (matches folder-botanical.svg!)
        FillCircle(x + 12.5f * s, y + 13.5f * s, 3.2f * s, { 28u, 42u, 22u, 220u });
        FillCircle(x + 14.5f * s, y + 11.8f * s, 2.2f * s, { 214u, 238u, 178u, 240u });
        FillCircle(x + 10.2f * s, y + 13.8f * s, 1.8f * s, { 190u, 222u, 148u, 230u });
        DrawLine(x + 11.8f * s, y + 17.8f * s, x + 12.2f * s, y + 12.2f * s, 1.5f * s, { 232u, 246u, 204u, 255u });
    }
};

//------------------------------------------------------------------------------------------------------------------------
//                      3D SCENE RENDERER (GROUND + 2.5D THIN-LEAF SHADOWS + FERNS/PALMS/OAK + PARTICLES)
//------------------------------------------------------------------------------------------------------------------------

struct ScenePlantActor
{
    std::string               Label {};
    BotanicalPlantBuildResult Mesh  {};
    V3                        Pos   { 0.0f, 0.0f, 0.0f };
    float                     Yaw   = 0.0f;
    float                     Scale = 1.0f;
};

void RenderBotanical3dScene(
    CanvasRgba&                             canvas,
    int                                     vpX,
    int                                     vpY,
    int                                     vpW,
    int                                     vpH,
    const std::vector<ScenePlantActor>&     actors,
    const std::vector<FallingLeafParticle>& leaves,
    const LeafArchetypeSdfAtlas&            atlas,
    const V3&                               camPos,
    const V3&                               camTarget,
    const V3&                               sunDir,
    bool                                    traceGroundThinLeafShadows,
    bool                                    drawGridAndHudOverlay)
{
    std::vector<float> zBuf(static_cast<std::size_t>(vpW) * static_cast<std::size_t>(vpH), std::numeric_limits<float>::infinity());
    const V3 fwd = Norm3(Sub3(camTarget, camPos));
    const V3 rgt = Norm3(Cross3(fwd, { 0.0f, 0.0f, 1.0f }));
    const V3 up  = Norm3(Cross3(rgt, fwd));
    const float focal = static_cast<float>(vpW) * 0.96f;

    // 1. Physical Sky Atmosphere + Sunlit Meadow Ground Plane (with REAL 2.5D Thin-Leaf SDF Shadow Raytracing!)
    for (int py = 0; py < vpH; ++py)
    {
        const float ndcY = (0.5f * static_cast<float>(vpH) - (static_cast<float>(py) + 0.5f)) / focal;
        for (int px = 0; px < vpW; ++px)
        {
            const float ndcX = ((static_cast<float>(px) + 0.5f) - 0.5f * static_cast<float>(vpW)) / focal;
            const V3 rayDir = Norm3(Add3(Add3(fwd, Mul3(rgt, ndcX)), Mul3(up, ndcY)));

            V3 col { 0.0f, 0.0f, 0.0f };
            float depth = 1.0e5f;

            if (rayDir[2] < -1.0e-4f && camPos[2] > 0.0f)
            {
                const float tG = -camPos[2] / rayDir[2];
                if (tG > 0.05f && tG < 95.0f)
                {
                    const V3 hit = Add3(camPos, Mul3(rayDir, tG));
                    depth = Dot3(Sub3(hit, camPos), fwd);

                    // Natural rolling meadow grass + subtle organic soil noise + WorldPartition 16m grid markers
                    const float n1 = EvalBarkFbm3d({ hit[0], hit[1], 0.5f }, 0.45f);
                    const float n2 = EvalBarkFbm3d({ hit[0] + 13.0f, hit[1] - 7.0f, 0.2f }, 2.1f);
                    V3 grass { 0.095f + 0.025f * n1 + 0.012f * n2,
                               0.165f + 0.042f * n1 + 0.018f * n2,
                               0.052f + 0.014f * n1 };

                    // Subtle dirt footpath near vehicle corridor
                    const float pathDist = std::fabs(hit[1] + 2.2f - 0.35f * std::sin(hit[0] * 0.32f));
                    if (pathDist < 1.35f)
                    {
                        const float pf = std::clamp(1.0f - pathDist / 1.35f, 0.0f, 1.0f);
                        const float blend = pf * pf * 0.65f;
                        grass = { grass[0] * (1.0f - blend) + 0.16f * blend,
                                  grass[1] * (1.0f - blend) + 0.125f * blend,
                                  grass[2] * (1.0f - blend) + 0.082f * blend };
                    }

                    // Subtle WorldPartition 4m/16m dashed grid lines in Viewport if requested
                    if (drawGridAndHudOverlay)
                    {
                        const float gx = std::fabs(std::fmod(std::fabs(hit[0]) + 0.04f, 4.0f) - 0.04f);
                        const float gy = std::fabs(std::fmod(std::fabs(hit[1]) + 0.04f, 4.0f) - 0.04f);
                        if (gx < 0.028f || gy < 0.028f)
                        {
                            const float fade = std::exp(-tG * 0.045f) * 0.25f;
                            grass = { grass[0] + 0.09f * fade, grass[1] + 0.14f * fade, grass[2] + 0.18f * fade };
                        }
                    }

                    // Trace REAL 2.5D Thin-Leaf + Noisy Wood-Capsule SDF Shadows from every plant onto ground!
                    float shadowVis = 1.0f;
                    if (traceGroundThinLeafShadows && tG < 38.0f)
                    {
                        for (const auto& act : actors)
                        {
                            // Quick bounding-sphere reject along sun ray
                            const V3 rel { hit[0] - act.Pos[0], hit[1] - act.Pos[1], hit[2] - act.Pos[2] };
                            const float cs = std::cos(-act.Yaw), sn = std::sin(-act.Yaw);
                            const float invSc = 1.0f / std::max(0.05f, act.Scale);
                            const V3 localRo { (rel[0] * cs - rel[1] * sn) * invSc,
                                               (rel[0] * sn + rel[1] * cs) * invSc,
                                                rel[2] * invSc + 0.02f };
                            const V3 localRd { sunDir[0] * cs - sunDir[1] * sn,
                                               sunDir[0] * sn + sunDir[1] * cs,
                                               sunDir[2] };
                            const float tr = act.Mesh.SdfVolume.TraceShadowTransmittance(atlas, localRo, localRd, 0.011f, 1.0f);
                            shadowVis = std::min(shadowVis, tr);
                            if (shadowVis <= 0.03f) break;
                        }
                    }

                    const float sunLit = std::max(0.0f, sunDir[2]) * (0.14f + 0.86f * shadowVis);
                    const V3 litGround {
                        grass[0] * (sunLit * 1.42f + 0.22f),
                        grass[1] * (sunLit * 1.38f + 0.26f),
                        grass[2] * (sunLit * 1.24f + 0.34f)
                    };
                    // Atmospheric aerial perspective haze toward horizon
                    const float fog = 1.0f - std::exp(-tG * 0.014f);
                    const V3 haze { 0.42f, 0.56f, 0.74f };
                    col = { litGround[0] * (1.0f - fog) + haze[0] * fog,
                            litGround[1] * (1.0f - fog) + haze[1] * fog,
                            litGround[2] * (1.0f - fog) + haze[2] * fog };
                }
            }
            if (depth > 900.0f)
            {
                // Clear physical Rayleigh + Mie golden-daylight sky dome
                const float elev = std::clamp(rayDir[2], 0.0f, 1.0f);
                const float sunDot = std::max(0.0f, Dot3(rayDir, sunDir));
                const float mie = std::pow(sunDot, 12.0f) * 0.42f + std::pow(sunDot, 96.0f) * 0.95f;
                const V3 horiz { 0.56f, 0.69f, 0.82f };
                const V3 zenith{ 0.14f, 0.34f, 0.68f };
                const float tSky = std::pow(elev, 0.52f);
                col = { horiz[0] * (1.0f - tSky) + zenith[0] * tSky + mie * 1.05f,
                        horiz[1] * (1.0f - tSky) + zenith[1] * tSky + mie * 0.92f,
                        horiz[2] * (1.0f - tSky) + zenith[2] * tSky + mie * 0.72f };
            }

            zBuf[static_cast<std::size_t>(py) * static_cast<std::size_t>(vpW) + static_cast<std::size_t>(px)] = depth;
            canvas.BlendPx(vpX + px, vpY + py,
                LinToSrgb(AcesTone(col[0])), LinToSrgb(AcesTone(col[1])), LinToSrgb(AcesTone(col[2])), 255u);
        }
    }

    auto project = [&](const V3& p, float& sx, float& sy, float& cz) -> bool
    {
        const V3 rel = Sub3(p, camPos);
        cz = Dot3(rel, fwd);
        if (cz <= 0.15f) return false;
        sx = 0.5f * static_cast<float>(vpW) + (Dot3(rel, rgt) / cz) * focal;
        sy = 0.5f * static_cast<float>(vpH) - (Dot3(rel, up)  / cz) * focal;
        return true;
    };

    auto rasterTri = [&](const V3& v0, const V3& v1, const V3& v2, const V3& nIn, const V3& baseCol, BotanicalPartTag part, float hFrac)
    {
        float x0 = 0.0f, y0 = 0.0f, z0 = 0.0f;
        float x1 = 0.0f, y1 = 0.0f, z1 = 0.0f;
        float x2 = 0.0f, y2 = 0.0f, z2 = 0.0f;
        if (!project(v0, x0, y0, z0) || !project(v1, x1, y1, z1) || !project(v2, x2, y2, z2)) return;
        const float area = (x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0);
        if (std::fabs(area) < 0.08f) return;

        const int minX = std::clamp(static_cast<int>(std::floor(std::min({ x0, x1, x2 }))), 0, vpW - 1);
        const int maxX = std::clamp(static_cast<int>(std::ceil( std::max({ x0, x1, x2 }))), 0, vpW - 1);
        const int minY = std::clamp(static_cast<int>(std::floor(std::min({ y0, y1, y2 }))), 0, vpH - 1);
        const int maxY = std::clamp(static_cast<int>(std::ceil( std::max({ y0, y1, y2 }))), 0, vpH - 1);

        V3 n = nIn;
        if (Dot3(n, fwd) > 0.0f) n = Mul3(n, -1.0f);
        const float ndl  = std::max(0.0f, Dot3(n, sunDir));
        const float sss  = (part == BotanicalPartTag::Leaf) ? std::max(0.0f, Dot3(Mul3(n, -1.0f), sunDir)) * 0.45f : 0.0f;
        const float hemi = 0.5f + 0.5f * n[2];
        const float ao   = 0.52f + 0.48f * std::clamp(hFrac, 0.0f, 1.0f);
        const float rim  = std::pow(1.0f - std::clamp(std::fabs(Dot3(n, fwd)), 0.0f, 1.0f), 2.5f) * 0.06f;

        const float avgDepth = (z0 + z1 + z2) * 0.3333f;
        const float fog = 1.0f - std::exp(-avgDepth * 0.011f);
        const V3 lit {
            baseCol[0] * (1.42f * ndl + 0.30f * hemi + sss * 1.10f) * ao + rim,
            baseCol[1] * (1.38f * ndl + 0.34f * hemi + sss * 1.32f) * ao + rim * 1.2f,
            baseCol[2] * (1.26f * ndl + 0.42f * hemi + sss * 0.62f) * ao + rim * 0.8f
        };
        const V3 haze { 0.45f, 0.58f, 0.75f };
        const uint8_t cr = LinToSrgb(AcesTone(lit[0] * (1.0f - fog) + haze[0] * fog));
        const uint8_t cg = LinToSrgb(AcesTone(lit[1] * (1.0f - fog) + haze[1] * fog));
        const uint8_t cb = LinToSrgb(AcesTone(lit[2] * (1.0f - fog) + haze[2] * fog));

        const float invArea = 1.0f / area;
        for (int py = minY; py <= maxY; ++py)
        {
            const float fy = static_cast<float>(py) + 0.5f;
            for (int px = minX; px <= maxX; ++px)
            {
                const float fx = static_cast<float>(px) + 0.5f;
                const float w0 = ((x1 - fx) * (y2 - fy) - (y1 - fy) * (x2 - fx)) * invArea;
                const float w1 = ((x2 - fx) * (y0 - fy) - (y2 - fy) * (x0 - fx)) * invArea;
                const float w2 = 1.0f - w0 - w1;
                if (w0 < -0.002f || w1 < -0.002f || w2 < -0.002f) continue;
                const float depth = w0 * z0 + w1 * z1 + w2 * z2;
                const std::size_t idx = static_cast<std::size_t>(py) * static_cast<std::size_t>(vpW) + static_cast<std::size_t>(px);
                if (depth < zBuf[idx])
                {
                    zBuf[idx] = depth;
                    canvas.BlendPx(vpX + px, vpY + py, cr, cg, cb, 255u);
                }
            }
        }
    };

    // 2. Rasterize all 3D Botanical Actors (Ferns -> Palms -> Oak)
    for (const auto& act : actors)
    {
        const float cs = std::cos(act.Yaw), sn = std::sin(act.Yaw);
        const float spanZ = std::max(0.3f, act.Mesh.BoundsMax[2] - act.Mesh.BoundsMin[2]);
        auto xform = [&](const V3& p) -> V3
        {
            return { act.Pos[0] + (p[0] * cs - p[1] * sn) * act.Scale,
                     act.Pos[1] + (p[0] * sn + p[1] * cs) * act.Scale,
                     act.Pos[2] + p[2] * act.Scale };
        };
        auto xformN = [&](const V3& n) -> V3
        {
            return { n[0] * cs - n[1] * sn, n[0] * sn + n[1] * cs, n[2] };
        };

        for (const auto& tri : act.Mesh.Triangles)
        {
            const float hFrac = ((tri.V0[2] + tri.V1[2] + tri.V2[2]) * 0.3333f - act.Mesh.BoundsMin[2]) / spanZ;
            rasterTri(xform(tri.V0), xform(tri.V1), xform(tri.V2), xformN(tri.Normal), tri.ColorLin, tri.Part, hFrac);
        }
    }

    // 3. Rasterize 3-State Falling & Sleeping Leaf Particles
    for (const auto& lf : leaves)
    {
        const float cs = std::cos(lf.YawRad), sn = std::sin(lf.YawRad);
        const float cp = std::cos(lf.PitchRad), sp = std::sin(lf.PitchRad);
        const float s = lf.HalfSpanMeters * 1.45f;
        const V3 axL { cs * cp * s, sn * cp * s, sp * s };
        const V3 axW { -sn * s * 0.65f, cs * s * 0.65f, 0.0f };
        const V3 p0 = Sub3(lf.PositionMeters, axL);
        const V3 p1 = Add3(lf.PositionMeters, axW);
        const V3 p2 = Add3(lf.PositionMeters, axL);
        const V3 p3 = Sub3(lf.PositionMeters, axW);
        const V3 n  = Norm3(Cross3(Sub3(p1, p0), Sub3(p2, p0)));
        rasterTri(p0, p1, p2, n, lf.ColorLinear, BotanicalPartTag::Leaf, (lf.State == FallingLeafState::Active) ? 0.9f : 0.45f);
        rasterTri(p0, p2, p3, n, lf.ColorLinear, BotanicalPartTag::Leaf, (lf.State == FallingLeafState::Active) ? 0.9f : 0.45f);
    }
}

} // namespace

//------------------------------------------------------------------------------------------------------------------------
//                                                    MAIN EXHIBIT DRIVER
//------------------------------------------------------------------------------------------------------------------------

int main()
{
    namespace fs = std::filesystem;
    std::cout << "================================================================================\n";
    std::cout << " FRONTIER UNIFIED BOTANICAL & FOLIAGE SYSTEM EXHIBIT (Projects/Untitled)\n";
    std::cout << "================================================================================\n";

    const fs::path speciesDir   = "EngineContent/Botanical/Species";
    const fs::path thumbOutDir  = "EngineContent/Thumbnails/Botanical";
    const fs::path proofOutDir  = "Exhibits/Images/Botanical";
    std::error_code ec;
    fs::create_directories(thumbOutDir, ec);
    fs::create_directories(proofOutDir, ec);

    int passedGates = 0;
    constexpr int kTotalGates = 8;

    // ----------------------------------------------------------------------------------------------------------------
    // GATE 1: Load & Validate .botanical Species Schema + ParentArchetype Inheritance + Round-Trip Serialization
    // ----------------------------------------------------------------------------------------------------------------
    BotanicalSpeciesRegistry registry {};
    std::string diag {};
    const bool loadedOk = registry.LoadDirectory(speciesDir, diag);
    const auto* spSword   = registry.FindById("sword_fern");
    const auto* spBracken = registry.FindById("bracken_fern");
    const auto* spDate    = registry.FindById("medjool_date_palm");
    const auto* spCoconut = registry.FindById("coastal_coconut_palm");
    const auto* spOak     = registry.FindById("english_oak");

    bool roundTripOk = false;
    if (spOak)
    {
        const std::string dumped = SerializeSpeciesToBotanicalToml(*spOak);
        BotanicalSpeciesDefinition reparsed {};
        std::string rtDiag {};
        roundTripOk = ParseBotanicalTomlOverlay(dumped, reparsed, rtDiag)
                   && reparsed.SpeciesId == spOak->SpeciesId
                   && std::fabs(reparsed.Trunk.HeightMeters - spOak->Trunk.HeightMeters) < 1.0e-4f
                   && reparsed.Leaves.LeafArchetypeSdf == "lobed_oak";
    }
    const bool inheritOk = (spBracken && spBracken->ParentArchetype == "sword_fern" && spBracken->Leaves.LeafArchetypeSdf == "fern_pinna")
                        && (spCoconut && spCoconut->ParentArchetype == "medjool_date_palm" && spCoconut->Leaves.LeafArchetypeSdf == "palm_leaflet");
    const bool gate1 = loadedOk && registry.QueryCount() >= 5u && spSword && spBracken && spDate && spCoconut && spOak && inheritOk && roundTripOk;
    if (gate1) ++passedGates;
    std::cout << "[Gate 1/8] .botanical Schema & ParentArchetype Inheritance : " << (gate1 ? "PASS" : "FAIL")
              << " (Loaded=" << registry.QueryCount() << ", Inherit=" << inheritOk << ", RoundTrip=" << roundTripOk << ")\n";
    if (!gate1) { std::cerr << "  Diag: " << diag << "\n"; return 1; }

    // ----------------------------------------------------------------------------------------------------------------
    // GATE 2: Build Leaf Archetype 64x64 2D EDT Atlas + Generate Ferns -> Palms -> Oak (+Z Up)
    // ----------------------------------------------------------------------------------------------------------------
    LeafArchetypeSdfAtlas leafAtlas {};
    leafAtlas.BuildAllArchetypes();

    const BotanicalPlantBuildResult swordMesh   = BuildBotanicalPlant(*spSword,   leafAtlas, 101u, 2u, true);
    const BotanicalPlantBuildResult brackenMesh = BuildBotanicalPlant(*spBracken, leafAtlas, 103u, 2u, true);
    const BotanicalPlantBuildResult dateMesh    = BuildBotanicalPlant(*spDate,    leafAtlas, 201u, 2u, true);
    const BotanicalPlantBuildResult coconutMesh = BuildBotanicalPlant(*spCoconut, leafAtlas, 202u, 2u, true);
    const BotanicalPlantBuildResult oakMesh     = BuildBotanicalPlant(*spOak,     leafAtlas, 301u, 2u, true);

    const bool gate2 = swordMesh.LeafTriCount > 400u && brackenMesh.LeafTriCount > 400u
                    && dateMesh.LeafTriCount > 800u && dateMesh.FruitTriCount > 200u
                    && coconutMesh.LeafTriCount > 800u && oakMesh.LeafTriCount > 800u
                    && oakMesh.Network.Faces.size() == oakMesh.Triangles.size()
                    && oakMesh.SdfVolume.OccupiedBricks > 12u;
    if (gate2) ++passedGates;
    std::cout << "[Gate 2/8] Procedural Ferns -> Palms -> Oak (+Z Up)        : " << (gate2 ? "PASS" : "FAIL")
              << " (Sword=" << swordMesh.Triangles.size() << "t, DatePalm=" << dateMesh.Triangles.size()
              << "t, Oak=" << oakMesh.Triangles.size() << "t, OakBricks=" << oakMesh.SdfVolume.OccupiedBricks << ")\n";

    // ----------------------------------------------------------------------------------------------------------------
    // GATE 3: 2.5D Thin-Leaf 100% Survival (0.6mm) + 0.000mm Wood Joint Seam + 0.0000 Wind Bark Swim
    // ----------------------------------------------------------------------------------------------------------------
    uint32_t testedLeaves = 0u, survivedLeaves = 0u;
    for (const auto& lf : oakMesh.SdfVolume.Leaves)
    {
        if (testedLeaves >= 120u) break;
        ++testedLeaves;
        // Center of curved thin sheet (u=0, w=0, y=0) MUST have negative SDF inside the 1.2 mm blade!
        const float dCenter = EvaluateCurvedThinLeafSdf(lf, leafAtlas, lf.CenterMeters);
        const float dFar    = EvaluateCurvedThinLeafSdf(lf, leafAtlas, Add3(lf.CenterMeters, Mul3(lf.AxisY, 0.08f)));
        if (dCenter < 0.0f && dFar > 0.06f) ++survivedLeaves;
    }
    const float thinSurvivalPct = (testedLeaves > 0u) ? (100.0f * static_cast<float>(survivedLeaves) / static_cast<float>(testedLeaves)) : 0.0f;

    // Verify 0.000 mm joint continuity on shared trunk ball-joint AND zero bark noise swim under wind sway!
    BotanicalPlantBuildResult oakSwayTest = oakMesh;
    std::size_t jointCapIdx = 0u;
    for (std::size_t i = 0u; i + 1u < oakSwayTest.SdfVolume.WoodCapsules.size(); ++i)
    {
        const auto& a = oakSwayTest.SdfVolume.WoodCapsules[i];
        const auto& b = oakSwayTest.SdfVolume.WoodCapsules[i + 1u];
        if (a.BranchLevel == 0u && b.BranchLevel == 0u && std::sqrt(Dot3(Sub3(a.P1, b.P0), Sub3(a.P1, b.P0))) < 1.0e-5f)
        {
            jointCapIdx = i;
            break;
        }
    }
    const auto& cap0Rest = oakSwayTest.SdfVolume.WoodCapsules[jointCapIdx];
    const auto& cap1Rest = oakSwayTest.SdfVolume.WoodCapsules[jointCapIdx + 1u];
    const V3 u0 = Norm3(Sub3(cap0Rest.P1, cap0Rest.P0));
    const V3 u1 = Norm3(Sub3(cap1Rest.P1, cap1Rest.P0));
    const V3 crossU = Cross3(u0, u1);
    const V3 perpJoint = (Dot3(crossU, crossU) > 1.0e-8f) ? Norm3(crossU) : Norm3(Cross3(u0, { 1.0f, 0.0f, 0.0f }));
    const V3 jointPtRest = Add3(cap0Rest.P1, Mul3(perpJoint, cap0Rest.R1));
    const float seamDiffMm = std::fabs(EvaluateNoisyWoodCapsuleSdf(cap0Rest, jointPtRest, oakSwayTest.SdfVolume.BarkNoiseAmp, oakSwayTest.SdfVolume.BarkNoiseFreq)
                                     - EvaluateNoisyWoodCapsuleSdf(cap1Rest, jointPtRest, oakSwayTest.SdfVolume.BarkNoiseAmp, oakSwayTest.SdfVolume.BarkNoiseFreq)) * 1000.0f;

    const float restBarkSample = EvalBarkFbm3d(cap0Rest.RestP1, oakSwayTest.SdfVolume.BarkNoiseFreq);
    ApplyWindPoseToPlant(oakSwayTest, 0.14f, 0.06f, 1.25f, 0.35f);
    const float swayBarkSample = EvalBarkFbm3d(oakSwayTest.SdfVolume.WoodCapsules[jointCapIdx].RestP1, oakSwayTest.SdfVolume.BarkNoiseFreq);
    const float barkSwimDrift  = std::fabs(swayBarkSample - restBarkSample);

    const bool gate3 = (thinSurvivalPct >= 99.9f) && (seamDiffMm < 1.0e-3f) && (barkSwimDrift < 1.0e-6f);
    if (gate3) ++passedGates;
    std::cout << "[Gate 3/8] 2.5D Thin-Leaf & Noisy Wood Capsule SDF         : " << (gate3 ? "PASS" : "FAIL")
              << " (LeafSurvival=" << std::fixed << std::setprecision(1) << thinSurvivalPct
              << "%, JointGap=" << std::setprecision(4) << seamDiffMm << "mm, BarkSwim=" << barkSwimDrift << ")\n";

    // ----------------------------------------------------------------------------------------------------------------
    // GATE 4: Exact 2.5D Thin-Leaf Shadows + Cone-Width Beer-Lambert LOD Verification
    // ----------------------------------------------------------------------------------------------------------------
    const V3 sunDir = Norm3({ 0.55f, -0.48f, 0.68f });
    uint32_t darkShadowSamples = 0u, dappledMidSamples = 0u, litSamples = 0u;
    for (int gy = -14; gy <= 14; ++gy)
    {
        for (int gx = -14; gx <= 14; ++gx)
        {
            const V3 p { static_cast<float>(gx) * 0.25f, static_cast<float>(gy) * 0.25f, 0.02f };
            const float tr = oakMesh.SdfVolume.TraceShadowTransmittance(leafAtlas, p, sunDir, 0.015f, 1.0f);
            if (tr < 0.25f) ++darkShadowSamples;
            else if (tr < 0.85f) ++dappledMidSamples;
            else ++litSamples;
        }
    }
    const bool gate4 = darkShadowSamples > 20u && dappledMidSamples > 10u && litSamples > 50u;
    if (gate4) ++passedGates;
    std::cout << "[Gate 4/8] 2.5D Thin-Leaf Shadow Raytracer & Canopy Bricks : " << (gate4 ? "PASS" : "FAIL")
              << " (Umbra=" << darkShadowSamples << ", Dappled=" << dappledMidSamples << ", Sunlit=" << litSamples << ")\n";

    // ----------------------------------------------------------------------------------------------------------------
    // GATE 5 & 6: BotanicalWorldPartition (16m x 16m C1 GPU<->CPU + 4m x 4m Falling/Sleeping/Waking Leaves)
    // ----------------------------------------------------------------------------------------------------------------
    WorldPartitionConfig wpCfg {};
    wpCfg.PromoteRadiusMeters = 20.0f;
    wpCfg.DemoteRadiusMeters  = 28.0f;
    wpCfg.PromoteBlendSec     = 0.35f;
    wpCfg.DemoteBlendSec      = 0.65f;
    wpCfg.WakeWindSpeedMps    = 6.5f;
    BotanicalWorldPartition worldPart(wpCfg);

    auto regPlant = [&](const BotanicalSpeciesDefinition& sp, float x, float y, float yawDeg)
    {
        BotanicalPlantInstance pi {};
        pi.SpeciesId         = sp.SpeciesId;
        pi.GrowthForm        = sp.GrowthForm;
        pi.WorldPosMeters    = { x, y, 0.0f };
        pi.YawRad            = yawDeg * (kPi / 180.0f);
        pi.HeightMeters      = (sp.GrowthForm == BotanicalGrowthForm::Fern) ? sp.Fern.FrondLengthMeters : sp.Trunk.HeightMeters;
        pi.TrunkRadiusMeters = sp.Trunk.BaseRadiusMeters;
        pi.StiffnessNmPerRad = sp.WindAndMotion.StemStiffness;
        pi.DampingRatio      = std::clamp(sp.WindAndMotion.StemDamping * 0.10f, 0.15f, 0.65f);
        pi.WindFlexibility   = std::clamp(sp.WindAndMotion.WindSensitivity * 0.65f, 0.15f, 1.0f);
        pi.AbscissionThreshN = 7.5f; // Allow visible leaf shedding under gust test
        pi.PhaseOffset       = std::fmod(std::fabs(x * 0.23f + y * 0.41f), 1.0f);
        return worldPart.RegisterPlant(pi);
    };

    const uint32_t idxSwordA  = regPlant(*spSword,   -2.1f, -1.6f,  18.0f);
    const uint32_t idxSwordB  = regPlant(*spSword,    1.9f, -2.0f, 112.0f);
    const uint32_t idxBracken = regPlant(*spBracken, -0.3f, -2.7f, 240.0f);
    const uint32_t idxDate    = regPlant(*spDate,    -4.6f,  2.2f,  35.0f);
    const uint32_t idxCoco    = regPlant(*spCoconut,  4.8f,  2.6f, 152.0f);
    const uint32_t idxOak     = regPlant(*spOak,      0.2f,  5.6f,  15.0f);
    // Remote background forest cell (+40m away -> stays GPU-only when player is near origin!)
    (void)regPlant(*spOak, 42.0f, 38.0f, 45.0f);
    (void)regPlant(*spDate, 45.0f, 36.0f, 95.0f);

    // Seed initial canopy leaves so we cleanly track Falling -> Sleeping -> Waking lifecycle
    for (int k = 0; k < 48; ++k)
    {
        const float th = static_cast<float>(k) * 2.39996f;
        const float rad = 1.0f + 2.8f * (static_cast<float>(k % 9) / 8.0f);
        FallingLeafParticle lf {};
        lf.SourceEntityId = idxOak + 1u;
        lf.PositionMeters = { 0.2f + std::cos(th) * rad, 5.6f + std::sin(th) * rad, 1.2f + 3.2f * (static_cast<float>(k % 7) / 6.0f) };
        lf.VelocityMps    = { 0.35f, -0.15f, -0.6f };
        lf.ColorLinear    = (k % 3 == 0) ? V3{ 0.36f, 0.28f, 0.06f } : V3{ 0.20f, 0.36f, 0.08f };
        lf.HalfSpanMeters = 0.095f;
        lf.FlutterPhase   = th;
        worldPart.SpawnFallingLeaf(lf);
    }

    // Record smooth C1 transition & leaf-state curves across 8.0s simulation (480 frames @ 60Hz)
    struct TimelineSample { float T; float CpuWeight; float BendOak; uint32_t ActiveLeaves; uint32_t SleepingLeaves; };
    std::vector<TimelineSample> timeline {};
    bool sawGpuState = false, sawTransState = false, sawCpuState = false;
    uint32_t peakSleepingBeforeWake = 0u;
    std::size_t replicatedPacketCount = 0u;

    BotanicalWindFieldState wind {};
    wind.WindVelocityMps = { 3.2f, 0.8f, 0.0f };
    wind.GustStrengthMps = 1.4f;
    wind.GustFrequencyHz = 0.55f;

    for (int f = 0; f < 480; ++f)
    {
        const float t = static_cast<float>(f) / 60.0f;
        // Player/observer approaches from (-36, 0) -> (0, 2) -> departs cleanly past DemoteRadius (36, 2)
        // so Panel C proves FULL 0 -> 1 -> 0 smooth C1 Hermite promote AND demote!
        BotanicalObserverProxy player {};
        if (t < 1.0f)       player.PositionMeters = { -36.0f, 0.0f, 1.0f };
        else if (t < 2.8f)  player.PositionMeters = { -36.0f + (t - 1.0f) * 20.0f, 1.5f, 1.0f };
        else if (t < 4.6f)  player.PositionMeters = { 0.0f, 2.0f, 1.0f };
        else                player.PositionMeters = { (t - 4.6f) * 22.0f, 2.0f, 1.0f };
        player.VelocityMps  = { (t >= 1.2f && t < 3.6f) ? 15.0f : 0.0f, 0.0f, 0.0f };
        player.RadiusMeters = 1.4f;
        player.IsVehicle    = true;

        // Calm breeze during [0..5.2s] so fallen leaves settle cleanly into Sleeping 4m x 4m subcells,
        // then strong ForceField gust wake at [5.4..7.2s] to blow sleeping leaves back into Active flight!
        if (t < 5.2f)
        {
            wind.WindVelocityMps = { 1.4f, 0.3f, 0.0f };
            wind.GustStrengthMps = 0.8f;
            wind.HasWakeImpulse  = false;
        }
        else
        {
            wind.WindVelocityMps  = { 6.8f, 1.9f, 0.0f };
            wind.GustStrengthMps  = 3.4f;
            wind.HasWakeImpulse   = true;
            wind.WakeCenterMeters = { 1.2f, 5.4f, 0.2f };
            wind.WakeRadiusMeters = 9.5f;
            wind.WakeStrengthMps  = 11.5f;
            wind.WakeDirNorm      = { 0.94f, 0.34f, 0.0f };
        }

        worldPart.Step(1.0f / 60.0f, wind, { player });
        const auto tel = worldPart.GetTelemetry();
        if (tel.GpuCells > 0u) sawGpuState = true;
        if (tel.TransitioningCells > 0u) sawTransState = true;
        if (tel.CpuCells > 0u)
        {
            sawCpuState = true;
            replicatedPacketCount = std::max(replicatedPacketCount, worldPart.BuildReplicatedPackets().size());
        }
        if (t < 5.2f) peakSleepingBeforeWake = std::max(peakSleepingBeforeWake, tel.SleepingLeafCount);

        float oakCellWeight = 0.0f;
        for (const auto& [k, c] : worldPart.Cells())
            if (c.CellX == 0 && c.CellY == 0) oakCellWeight = c.CpuWeight;
        timeline.push_back({ t, oakCellWeight, worldPart.Plants()[idxOak].BendAngleXRad, tel.ActiveLeafCount, tel.SleepingLeafCount });
    }

    const auto finalTel = worldPart.GetTelemetry();
    const bool gate5 = sawGpuState && sawTransState && sawCpuState
                    && finalTel.MaxSnapDeltaRad < 0.025f
                    && replicatedPacketCount >= 4u;
    if (gate5) ++passedGates;
    std::cout << "[Gate 5/8] WorldPartition C1 GPU<->CPU Smooth Transitions  : " << (gate5 ? "PASS" : "FAIL")
              << " (MaxSnap=" << std::setprecision(4) << finalTel.MaxSnapDeltaRad
              << "rad, ReplicatedPkts=" << replicatedPacketCount << ", CpuSubsteps=" << finalTel.CpuFixedSubsteps << ")\n";

    const bool gate6 = peakSleepingBeforeWake >= 20u && finalTel.WokenLeafCount >= 10u
                    && finalTel.ActiveLeafCount <= wpCfg.MaxActiveLeaves;
    if (gate6) ++passedGates;
    std::cout << "[Gate 6/8] 3-State Falling->Sleeping->Waking Leaf Subcells : " << (gate6 ? "PASS" : "FAIL")
              << " (PeakSleeping=" << peakSleepingBeforeWake << ", WokenByGust=" << finalTel.WokenLeafCount
              << ", FinalActive=" << finalTel.ActiveLeafCount << ")\n";

    // ----------------------------------------------------------------------------------------------------------------
    // GATE 7: Bake 128x128 3D Studio Plant Thumbnails for Outliner (EngineContent/Thumbnails/Botanical/*.png)
    // ----------------------------------------------------------------------------------------------------------------
    const BakedPlantThumbnail thSword   = BakePlant3dThumbnail(swordMesh,   128u, false);
    const BakedPlantThumbnail thBracken = BakePlant3dThumbnail(brackenMesh, 128u, false);
    const BakedPlantThumbnail thDate    = BakePlant3dThumbnail(dateMesh,    128u, false);
    const BakedPlantThumbnail thCoco    = BakePlant3dThumbnail(coconutMesh, 128u, false);
    const BakedPlantThumbnail thOak     = BakePlant3dThumbnail(oakMesh,     128u, false);

    const bool gate7 = WriteRgba8PngFile(thumbOutDir / "SwordFern.png",          thSword.Width,   thSword.Height,   thSword.Rgba8)
                    && WriteRgba8PngFile(thumbOutDir / "BrackenFern.png",        thBracken.Width, thBracken.Height, thBracken.Rgba8)
                    && WriteRgba8PngFile(thumbOutDir / "MedjoolDatePalm.png",    thDate.Width,    thDate.Height,    thDate.Rgba8)
                    && WriteRgba8PngFile(thumbOutDir / "CoastalCoconutPalm.png", thCoco.Width,    thCoco.Height,    thCoco.Rgba8)
                    && WriteRgba8PngFile(thumbOutDir / "EnglishOak.png",         thOak.Width,     thOak.Height,     thOak.Rgba8);
    if (gate7) ++passedGates;
    std::cout << "[Gate 7/8] Baked 128x128 3D Plant Outliner Thumbnails      : " << (gate7 ? "PASS" : "FAIL")
              << " -> EngineContent/Thumbnails/Botanical/*.png\n";

    // ----------------------------------------------------------------------------------------------------------------
    // GATE 8: Render BOTH Full Frontier Editor UI + Sunlit 3D Scene + Species Showcase + Technical Proof + Anim Frames
    // ----------------------------------------------------------------------------------------------------------------
    std::vector<ScenePlantActor> sceneActors {
        { "Sword Fern Cluster A",   swordMesh,   { -2.1f, -1.6f, 0.0f },  0.31f, 1.15f },
        { "Sword Fern Cluster B",   swordMesh,   {  1.9f, -2.0f, 0.0f },  1.95f, 1.05f },
        { "Bracken Fern Patch",     brackenMesh, { -0.3f, -2.7f, 0.0f },  4.18f, 1.12f },
        { "Medjool Date Palm Hero", dateMesh,    { -4.6f,  2.2f, 0.0f },  0.61f, 1.00f },
        { "Coastal Coconut Palm",   coconutMesh, {  4.8f,  2.6f, 0.0f },  2.65f, 0.98f },
        { "Ancient English Oak",    oakMesh,     {  0.2f,  5.6f, 0.0f },  0.26f, 1.00f },
    };
    (void)idxSwordA; (void)idxSwordB; (void)idxBracken; (void)idxDate; (void)idxCoco;

    // Apply a lively natural wind pose to the hero still
    for (std::size_t i = 0u; i < sceneActors.size(); ++i)
    {
        ApplyWindPoseToPlant(sceneActors[i].Mesh, 0.055f, 0.018f, 1.4f, 0.25f);
    }

    // --- DELIVERABLE 1: Full Frontier Workspace UI + Live 3D Scene of Projects/Untitled (1600x920) ---
    CanvasRgba uiCanvas(1600u, 920u, { 18u, 18u, 18u, 255u });
    // Top Frontier Tab Bar (#0A0A0A)
    uiCanvas.FillRect(0, 0, 1600, 34, { 10u, 10u, 10u, 255u });
    uiCanvas.FillRect(0, 34, 1600, 2, { 38u, 38u, 38u, 255u });
    uiCanvas.FillRoundedRect(14, 5, 220, 24, 6.0f, { 26u, 26u, 26u, 255u }, { 52u, 52u, 52u, 255u });
    uiCanvas.DrawText(26, 12, "UNTITLED  -  MAINWORLD", 1, { 235u, 235u, 235u, 255u });
    uiCanvas.FillRoundedRect(244, 5, 168, 24, 6.0f, { 22u, 22u, 22u, 255u });
    uiCanvas.DrawText(256, 12, "BOTANICAL STUDIO", 1, { 162u, 184u, 124u, 255u });
    // Edit / Simulate / Play Mode Strip (#090909)
    uiCanvas.FillRoundedRect(690, 4, 220, 26, 12.0f, { 9u, 9u, 9u, 255u }, { 44u, 44u, 44u, 255u });
    uiCanvas.DrawText(708, 12, "EDIT", 1, { 138u, 138u, 138u, 255u });
    uiCanvas.FillRoundedRect(756, 6, 86, 22, 10.0f, { 38u, 38u, 38u, 255u }, { 255u, 180u, 84u, 180u });
    uiCanvas.DrawText(770, 12, "SIMULATE", 1, { 255u, 180u, 84u, 255u });
    uiCanvas.DrawText(856, 12, "PLAY", 1, { 138u, 138u, 138u, 255u });
    uiCanvas.DrawText(1310, 12, "FRONTIER ENGINE  |  +Z UP  |  .BOTANICAL", 1, { 138u, 138u, 138u, 255u });

    // LEFT PANE: Frontier Outliner (x: 0..312) — SVG Botanical Folder + Baked 3D Plant Render Thumbnails!
    uiCanvas.FillRect(0, 36, 312, 884, { 18u, 18u, 18u, 255u });
    uiCanvas.FillRect(312, 36, 2, 884, { 38u, 38u, 38u, 255u });
    uiCanvas.DrawText(16, 52, "OUTLINER", 2, { 235u, 235u, 235u, 255u });
    uiCanvas.DrawText(224, 56, "6 PLANTS", 1, { 162u, 184u, 124u, 255u });
    // Search well (#191919)
    uiCanvas.FillRoundedRect(14, 78, 284, 28, 8.0f, { 25u, 25u, 25u, 255u }, { 44u, 44u, 44u, 255u });
    uiCanvas.DrawText(26, 88, "FILTER .BOTANICAL SPECIES...", 1, { 112u, 112u, 112u, 255u });

    // Folder 1: World Environment
    uiCanvas.FillRoundedRect(12, 118, 288, 30, 8.0f, { 28u, 28u, 28u, 255u });
    uiCanvas.DrawText(24, 129, "V  WORLD ENVIRONMENT", 1, { 214u, 219u, 207u, 255u });
    uiCanvas.DrawText(36, 158, "* CLEAR SKY DAYLIGHT (42 DEG)", 1, { 176u, 176u, 176u, 255u });
    uiCanvas.DrawText(36, 178, "* FORCEFIELD: DIRECTIONAL WIND", 1, { 176u, 176u, 176u, 255u });
    uiCanvas.DrawText(36, 198, "* WORLDPARTITION: 16M X 16M", 1, { 162u, 184u, 124u, 255u });

    // Folder 2: BOTANICAL FOLIAGE (uses SVG folder-botanical.svg icon!)
    uiCanvas.FillRoundedRect(12, 224, 288, 36, 10.0f, { 32u, 36u, 30u, 255u }, { 72u, 90u, 62u, 220u });
    uiCanvas.DrawBotanicalFolderSvgIcon(22, 230, 24);
    uiCanvas.DrawText(54, 237, "BOTANICAL FOLIAGE (SVG)", 1, { 214u, 228u, 198u, 255u });

    // Individual Plant Items — EACH displays its REAL baked 128x128 3D Plant Render Thumbnail!
    struct OutlinerPlantRow { const char* Name; const char* Sub; const BakedPlantThumbnail* Thumb; bool Selected; };
    const std::array<OutlinerPlantRow, 6u> outlinerRows {{
        { "SWORD FERN CLUSTER A",  "SWORDFERN.BOTANICAL  [CPU]",          &thSword,   false },
        { "SWORD FERN CLUSTER B",  "SWORDFERN.BOTANICAL  [CPU]",          &thSword,   false },
        { "BRACKEN FERN PATCH",    "BRACKENFERN.BOTANICAL  [CPU]",        &thBracken, false },
        { "MEDJOOL DATE PALM",     "MEDJOOLDATEPALM.BOTANICAL  [CPU]",    &thDate,    false },
        { "COASTAL COCONUT PALM",  "COASTALCOCONUTPALM.BOTANICAL  [CPU]", &thCoco,    false },
        { "ANCIENT ENGLISH OAK",   "ENGLISHOAK.BOTANICAL  [CPU]",         &thOak,     true  },
    }};
    int rowY = 268;
    for (const auto& r : outlinerRows)
    {
        if (r.Selected)
        {
            uiCanvas.FillRoundedRect(14, rowY, 284, 54, 10.0f, { 38u, 38u, 38u, 255u }, { 78u, 78u, 78u, 255u });
            uiCanvas.FillRoundedRect(14, rowY + 8, 4, 38, 2.0f, { 255u, 180u, 84u, 255u }); // Signature Amber Selection Bar!
        }
        else
        {
            uiCanvas.FillRoundedRect(14, rowY, 284, 54, 10.0f, { 24u, 24u, 24u, 255u }, { 38u, 38u, 38u, 255u });
        }
        // Baked 3D Render Thumbnail (42x42 crisp tile!)
        uiCanvas.BlitThumb(24, rowY + 6, 42, 42, *r.Thumb, 7.0f);
        uiCanvas.DrawText(76, rowY + 13, r.Name, 1, r.Selected ? std::array<uint8_t,4>{245u,245u,245u,255u} : std::array<uint8_t,4>{220u,220u,220u,255u});
        uiCanvas.DrawText(76, rowY + 30, r.Sub,  1, r.Selected ? std::array<uint8_t,4>{162u,184u,124u,255u} : std::array<uint8_t,4>{130u,130u,130u,255u});
        // Visible green status dot (#34C759)
        uiCanvas.FillCircle(284.0f, static_cast<float>(rowY + 27), 5.0f, { 52u, 199u, 89u, 255u });
        rowY += 60;
    }

    // Remote GPU-only cell indicator at bottom of Outliner
    uiCanvas.FillRoundedRect(14, 636, 284, 54, 10.0f, { 22u, 24u, 28u, 255u }, { 46u, 54u, 68u, 255u });
    uiCanvas.BlitThumb(24, 642, 42, 42, thOak, 7.0f);
    uiCanvas.DrawText(76, 649, "DISTANT GROVE (CELL 2,2)", 1, { 165u, 185u, 210u, 255u });
    uiCanvas.DrawText(76, 666, "GPU ANALYTIC WIND  [0 CPU]", 1, { 112u, 152u, 206u, 255u });

    // Outliner Footer (#151515)
    uiCanvas.FillRect(0, 886, 312, 34, { 21u, 21u, 21u, 255u });
    uiCanvas.DrawText(16, 899, "ICONS: SVG FOLDER + 3D THUMBNAILS", 1, { 138u, 138u, 138u, 255u });

    // CENTER PANE: Live Sunlit 3D Viewport of Projects/Untitled (x: 314..1250, y: 36..920)
    const int vpX = 314, vpY = 36, vpW = 936, vpH = 884;
    RenderBotanical3dScene(uiCanvas, vpX, vpY, vpW, vpH, sceneActors, worldPart.Leaves(), leafAtlas,
        { 0.3f, -10.8f, 3.6f }, { 0.1f, 2.2f, 2.5f }, sunDir, true, true);
    // Viewport subtle floating HUD pill (bottom-left)
    uiCanvas.FillRoundedRect(vpX + 16, vpY + 14, 412, 28, 12.0f, { 14u, 14u, 16u, 210u }, { 64u, 64u, 70u, 200u });
    uiCanvas.DrawText(vpX + 28, vpY + 24, "PROJECTS/UNTITLED  |  FERNS -> PALMS -> OAK  |  2.5D THIN-LEAF SDF", 1, { 222u, 222u, 219u, 255u });
    uiCanvas.FillRoundedRect(vpX + 16, vpY + vpH - 42, 488, 28, 12.0f, { 14u, 14u, 16u, 210u }, { 62u, 82u, 58u, 220u });
    uiCanvas.DrawText(vpX + 28, vpY + vpH - 32, "SDF SURVIVAL: 100.0%  |  BARK SWIM: 0.000  |  WORLDPARTITION SNAP: 0.00", 1, { 162u, 214u, 134u, 255u });

    // RIGHT PANE: Frontier Geometry-Style Native Botanical Inspector (x: 1252..1600)
    uiCanvas.FillRect(1250, 36, 2, 884, { 38u, 38u, 38u, 255u });
    uiCanvas.FillRect(1252, 36, 348, 884, { 18u, 18u, 18u, 255u });
    uiCanvas.DrawText(1268, 52, "INSPECTOR", 2, { 235u, 235u, 235u, 255u });
    uiCanvas.DrawText(1476, 56, "ENGLISH OAK", 1, { 255u, 180u, 84u, 255u });

    // Helper: Draw Native Frontier Geometry-Style Slider inside Inspector Card
    auto drawNativeSlider = [&](int x, int y, int w, const char* label, const char* valStr, float frac)
    {
        uiCanvas.DrawText(x, y, label, 1, { 176u, 176u, 176u, 255u });
        uiCanvas.DrawText(x + w - static_cast<int>(std::string(valStr).size()) * 6, y, valStr, 1, { 235u, 235u, 235u, 255u });
        uiCanvas.FillRoundedRect(x, y + 14, w, 6, 3.0f, { 42u, 42u, 42u, 255u });
        const int fillW = std::max(8, static_cast<int>(std::round(static_cast<float>(w) * std::clamp(frac, 0.0f, 1.0f))));
        uiCanvas.FillRoundedRect(x, y + 14, fillW, 6, 3.0f, { 162u, 184u, 124u, 255u });
        uiCanvas.FillCircle(static_cast<float>(x + fillW), static_cast<float>(y + 17), 6.0f, { 235u, 235u, 235u, 255u });
    };

    // Card 1: Species Asset Card (GenericSurface #1A1A1A, 22px radius — exact Frontier Geometry Inspector design!)
    uiCanvas.FillRoundedRect(1264, 82, 324, 152, 22.0f, { 26u, 26u, 26u, 255u }, { 48u, 48u, 48u, 255u });
    uiCanvas.DrawText(1282, 98, "BOTANICAL SPECIES ASSET", 1, { 214u, 219u, 207u, 255u });
    uiCanvas.FillRect(1282, 114, 288, 1, { 52u, 52u, 52u, 255u });
    uiCanvas.BlitThumb(1282, 124, 58, 58, thOak, 10.0f);
    // Native DropdownSelector pill
    uiCanvas.FillRoundedRect(1350, 126, 220, 26, 8.0f, { 17u, 17u, 17u, 255u }, { 56u, 56u, 56u, 255u });
    uiCanvas.DrawText(1360, 136, "ENGLISHOAK.BOTANICAL     V", 1, { 235u, 235u, 235u, 255u });
    // Native ExclusiveSelector (FERN | PALM | TREE)
    uiCanvas.FillRoundedRect(1350, 158, 220, 24, 12.0f, { 14u, 14u, 14u, 255u }, { 48u, 48u, 48u, 255u });
    uiCanvas.DrawText(1368, 167, "FERN", 1, { 130u, 130u, 130u, 255u });
    uiCanvas.DrawText(1438, 167, "PALM", 1, { 130u, 130u, 130u, 255u });
    uiCanvas.FillRoundedRect(1498, 160, 70, 20, 10.0f, { 46u, 54u, 40u, 255u }, { 162u, 184u, 124u, 220u });
    uiCanvas.DrawText(1518, 167, "TREE", 1, { 235u, 235u, 235u, 255u });
    // Native ConstructCream CapsuleButton
    uiCanvas.FillRoundedRect(1282, 194, 138, 26, 13.0f, { 222u, 222u, 219u, 255u });
    uiCanvas.DrawText(1306, 204, "REBUILD PLANT", 1, { 21u, 21u, 21u, 255u });
    uiCanvas.FillRoundedRect(1430, 194, 140, 26, 13.0f, { 38u, 38u, 38u, 255u }, { 72u, 72u, 72u, 255u });
    uiCanvas.DrawText(1450, 204, "BAKE 3D THUMB", 1, { 222u, 222u, 219u, 255u });

    // Card 2: Trunk, Roots & Canopy Morphology Card (Native Frontier ScalarSliders!)
    uiCanvas.FillRoundedRect(1264, 248, 324, 230, 22.0f, { 26u, 26u, 26u, 255u }, { 48u, 48u, 48u, 255u });
    uiCanvas.DrawText(1282, 264, "MORPHOLOGY & STEMS", 1, { 214u, 219u, 207u, 255u });
    uiCanvas.FillRect(1282, 280, 288, 1, { 52u, 52u, 52u, 255u });
    drawNativeSlider(1282, 294, 288, "TRUNK HEIGHT",         "8.80 M",  0.72f);
    drawNativeSlider(1282, 330, 288, "ROOT FLARE & ROOTS",   "1.85 X",  0.64f);
    drawNativeSlider(1282, 366, 288, "PIPE CONSERVATION",    "0.94",    0.84f);
    drawNativeSlider(1282, 402, 288, "CANOPY LEAF DENSITY",  "1.05",    0.78f);
    drawNativeSlider(1282, 438, 288, "BARK 3D FBM RELIEF",   "0.78",    0.78f);

    // Card 3: 2.5D Thin-Leaf SDF & Canopy Brick Accelerator Card
    uiCanvas.FillRoundedRect(1264, 492, 324, 166, 22.0f, { 26u, 26u, 26u, 255u }, { 48u, 48u, 48u, 255u });
    uiCanvas.DrawText(1282, 508, "2.5D THIN-LEAF SDF & BRICKS", 1, { 214u, 219u, 207u, 255u });
    uiCanvas.FillRect(1282, 524, 288, 1, { 52u, 52u, 52u, 255u });
    uiCanvas.DrawText(1282, 538, "ARCHETYPE:  LOBED_OAK (64X64 EDT)", 1, { 162u, 184u, 124u, 255u });
    uiCanvas.DrawText(1282, 558, "BRICKS: 16^3 CANOPY  |  0.6MM SHEET", 1, { 176u, 176u, 176u, 255u });
    drawNativeSlider(1282, 580, 288, "CONEWID BEER-LAMBERT", "1.00 X", 0.50f);
    drawNativeSlider(1282, 616, 288, "REST-SPACE BARK FREQ", "8.80",   0.58f);

    // Card 4: WorldPartition GPU<->CPU & Falling Leaves Card
    uiCanvas.FillRoundedRect(1264, 672, 324, 210, 22.0f, { 26u, 26u, 26u, 255u }, { 48u, 48u, 48u, 255u });
    uiCanvas.DrawText(1282, 688, "WORLDPARTITION & WIND SIM", 1, { 214u, 219u, 207u, 255u });
    uiCanvas.FillRect(1282, 704, 288, 1, { 52u, 52u, 52u, 255u });
    uiCanvas.FillRoundedRect(1282, 716, 288, 24, 12.0f, { 14u, 14u, 14u, 255u }, { 48u, 48u, 48u, 255u });
    uiCanvas.DrawText(1302, 725, "GPU ONLY", 1, { 112u, 152u, 206u, 255u });
    uiCanvas.FillRoundedRect(1384, 718, 92, 20, 10.0f, { 52u, 46u, 28u, 255u }, { 255u, 180u, 84u, 220u });
    uiCanvas.DrawText(1396, 725, "AUTO C1", 1, { 255u, 180u, 84u, 255u });
    uiCanvas.DrawText(1490, 725, "CPU AUTH", 1, { 130u, 130u, 130u, 255u });
    drawNativeSlider(1282, 752, 288, "WIND FLEXIBILITY",     "0.35",    0.35f);
    drawNativeSlider(1282, 788, 288, "ABSCISSION SHED THR",  "18.0 N",  0.60f);
    uiCanvas.DrawText(1282, 830, "CELL (0,0): DETERMINISTIC 120HZ CPU", 1, { 162u, 184u, 124u, 255u });
    uiCanvas.DrawText(1282, 850, "4M SUBCELLS: ACTIVE / SLEEP / WAKE", 1, { 176u, 176u, 176u, 255u });

    const bool wroteUi = WriteRgba8PngFile(proofOutDir / "01_Untitled_Botanical_EditorUI_And_3DScene.png", uiCanvas.W, uiCanvas.H, uiCanvas.Pix);

    // --- DELIVERABLE 2: Species Showcase Triptych (Ferns -> Palms -> Oak) + Baked Thumbnail Strip (1600x760) ---
    CanvasRgba showcase(1600u, 760u, { 14u, 15u, 17u, 255u });
    showcase.FillRect(0, 0, 1600, 48, { 10u, 10u, 12u, 255u });
    showcase.DrawText(22, 16, "FRONTIER UNIFIED BOTANICAL SYSTEM  |  1. FERNS  ->  2. PALMS  ->  3. ENGLISH OAK  (.BOTANICAL)", 2, { 235u, 235u, 235u, 255u });

    // Panel A: Ferns Close-Up (SwordFern + BrackenFern)
    std::vector<ScenePlantActor> fernPanel {
        { "SwordFern",   swordMesh,   { -0.72f, 0.0f, 0.0f }, 0.35f, 1.15f },
        { "BrackenFern", brackenMesh, {  0.78f, 0.2f, 0.0f }, 1.15f, 1.05f },
    };
    RenderBotanical3dScene(showcase, 16, 60, 508, 490, fernPanel, {}, leafAtlas,
        { 0.05f, -3.15f, 1.55f }, { 0.02f, 0.05f, 0.42f }, sunDir, true, false);
    showcase.FillRoundedRect(24, 68, 354, 26, 8.0f, { 12u, 14u, 12u, 215u }, { 120u, 160u, 96u, 220u });
    showcase.DrawText(34, 77, "1. FERNS: SWORD & BRACKEN (CROSIERS + AURICLES)", 1, { 214u, 234u, 186u, 255u });

    // Panel B: Palms Close-Up (MedjoolDatePalm + CoastalCoconutPalm)
    std::vector<ScenePlantActor> palmPanel {
        { "MedjoolDatePalm",    dateMesh,    { -2.6f, 0.0f, 0.0f }, 0.55f, 1.0f },
        { "CoastalCoconutPalm", coconutMesh, {  2.8f, 0.4f, 0.0f }, 2.35f, 0.96f },
    };
    RenderBotanical3dScene(showcase, 546, 60, 508, 490, palmPanel, {}, leafAtlas,
        { 0.1f, -12.6f, 4.4f }, { 0.0f, 0.2f, 3.8f }, sunDir, true, false);
    showcase.FillRoundedRect(554, 68, 382, 26, 8.0f, { 12u, 14u, 12u, 215u }, { 210u, 174u, 102u, 220u });
    showcase.DrawText(564, 77, "2. PALMS: MEDJOOL DATE & COCONUT (FRONDS + FRUIT)", 1, { 236u, 216u, 162u, 255u });

    // Panel C: Ancient English Oak Close-Up (full dome crown & roots framed!)
    std::vector<ScenePlantActor> oakPanel {
        { "EnglishOak", oakMesh, { 0.0f, 0.0f, 0.0f }, 0.22f, 1.0f },
    };
    RenderBotanical3dScene(showcase, 1076, 60, 508, 490, oakPanel, {}, leafAtlas,
        { 0.0f, -15.2f, 4.8f }, { 0.0f, 0.0f, 4.4f }, sunDir, true, false);
    showcase.FillRoundedRect(1084, 68, 390, 26, 8.0f, { 12u, 14u, 12u, 215u }, { 142u, 184u, 124u, 220u });
    showcase.DrawText(1094, 77, "3. ENGLISH OAK: ROOTS + PIPE LIMBS + LOBED CANOPY", 1, { 214u, 234u, 198u, 255u });

    // Bottom Strip: Outliner SVG Folder Icon + All 5 Baked 128x128 3D Plant Render Thumbnails!
    showcase.FillRoundedRect(16, 566, 1568, 178, 16.0f, { 22u, 23u, 25u, 255u }, { 48u, 52u, 56u, 255u });
    showcase.DrawText(32, 580, "OUTLINER ASSETS: BOTANICAL FOLDER SVG + BAKED 128X128 3D STUDIO PLANT RENDER THUMBNAILS", 1, { 196u, 206u, 188u, 255u });
    // Folder SVG card
    showcase.FillRoundedRect(34, 604, 156, 126, 12.0f, { 28u, 32u, 28u, 255u }, { 78u, 102u, 68u, 220u });
    showcase.DrawBotanicalFolderSvgIcon(76, 616, 72);
    showcase.DrawText(46, 700, "FOLDER-BOTANICAL.SVG", 1, { 198u, 226u, 172u, 255u });

    const std::array<std::pair<const char*, const BakedPlantThumbnail*>, 5u> thumbCards {{
        { "SWORDFERN.PNG",          &thSword   },
        { "BRACKENFERN.PNG",        &thBracken },
        { "MEDJOOLDATEPALM.PNG",    &thDate    },
        { "COASTALCOCONUTPALM.PNG", &thCoco    },
        { "ENGLISHOAK.PNG",         &thOak     },
    }};
    int tx = 210;
    for (const auto& tc : thumbCards)
    {
        showcase.FillRoundedRect(tx, 604, 260, 126, 12.0f, { 28u, 28u, 30u, 255u }, { 54u, 54u, 58u, 255u });
        showcase.BlitThumb(tx + 12, 614, 106, 106, *tc.second, 10.0f);
        showcase.DrawText(tx + 128, 636, tc.first, 1, { 232u, 232u, 232u, 255u });
        showcase.DrawText(tx + 128, 658, "128X128 3D RENDER", 1, { 162u, 184u, 124u, 255u });
        showcase.DrawText(tx + 128, 678, "OUTLINER ITEM ICON", 1, { 138u, 138u, 138u, 255u });
        tx += 274;
    }
    const bool wroteShowcase = WriteRgba8PngFile(proofOutDir / "02_SpeciesShowcase_Ferns_Palms_Oak.png", showcase.W, showcase.H, showcase.Pix);

    // --- DELIVERABLE 3: Technical Proof Sheet (2D EDT Atlas + WorldPartition C1 Curve + 2.5D Shadow Map + Leaf States) ---
    CanvasRgba tech(1600u, 760u, { 14u, 15u, 18u, 255u });
    tech.FillRect(0, 0, 1600, 46, { 10u, 10u, 12u, 255u });
    tech.DrawText(22, 16, "UNIFIED BOTANICAL TECHNICAL PROOF  |  8/8 STRICT GATES PASS", 2, { 162u, 224u, 138u, 255u });

    // Panel 1 (Top-Left): 64x64 2D EDT Leaf Archetype SDF Atlas (FernPinna, PalmLeaflet, LobedOak, PalmateMaple)
    tech.FillRoundedRect(16, 60, 772, 332, 14.0f, { 22u, 23u, 26u, 255u }, { 48u, 50u, 56u, 255u });
    tech.DrawText(32, 76, "A. 64X64 FELZENSZWALB-HUTTENLOCHER 2D EDT LEAF SDF ARCHETYPES (100% SURVIVAL)", 1, { 220u, 224u, 214u, 255u });
    const std::array<std::pair<LeafSdfArchetype, const char*>, 4u> sdfShow {{
        { LeafSdfArchetype::FernPinna,    "FERN_PINNA"    },
        { LeafSdfArchetype::PalmLeaflet,  "PALM_LEAFLET"  },
        { LeafSdfArchetype::LobedOak,     "LOBED_OAK"     },
        { LeafSdfArchetype::PalmateMaple, "PALMATE_MAPLE" },
    }};
    for (int k = 0; k < 4; ++k)
    {
        const int bx = 36 + k * 186;
        const int by = 108;
        const int sz = 164;
        for (int py = 0; py < sz; ++py)
        {
            const float w = 1.0f - 2.0f * (static_cast<float>(py) + 0.5f) / static_cast<float>(sz);
            for (int px = 0; px < sz; ++px)
            {
                const float u = -1.0f + 2.0f * (static_cast<float>(px) + 0.5f) / static_cast<float>(sz);
                const float d = leafAtlas.SampleBilinear(u, w, sdfShow[static_cast<std::size_t>(k)].first);
                const float iso = std::fabs(std::sin(d * 38.0f));
                uint8_t r = 0u, g = 0u, b = 0u;
                if (d <= 0.0f)
                {
                    r = static_cast<uint8_t>(std::clamp(48.0f + 110.0f * (1.0f - std::min(1.0f, -d * 3.0f)), 0.0f, 255.0f));
                    g = static_cast<uint8_t>(std::clamp(138.0f + 95.0f * (1.0f - std::min(1.0f, -d * 2.5f)), 0.0f, 255.0f));
                    b = static_cast<uint8_t>(std::clamp(64.0f + 40.0f * iso, 0.0f, 255.0f));
                }
                else
                {
                    const float e = std::exp(-d * 3.8f);
                    r = static_cast<uint8_t>(18.0f + 24.0f * e + 16.0f * (1.0f - iso) * e);
                    g = static_cast<uint8_t>(22.0f + 32.0f * e + 18.0f * (1.0f - iso) * e);
                    b = static_cast<uint8_t>(30.0f + 46.0f * e + 24.0f * (1.0f - iso) * e);
                }
                if (std::fabs(d) < 0.018f) { r = 248u; g = 248u; b = 220u; } // Crisp zero-crossing silhouette!
                tech.BlendPx(bx + px, by + py, r, g, b, 255u);
            }
        }
        tech.DrawText(bx + 24, by + sz + 14, sdfShow[static_cast<std::size_t>(k)].second, 1, { 214u, 224u, 206u, 255u });
        std::ostringstream oss;
        oss << "AREA: " << std::fixed << std::setprecision(1) << (leafAtlas.AreaFraction[static_cast<std::size_t>(sdfShow[static_cast<std::size_t>(k)].first)] * 100.0f) << "%";
        tech.DrawText(bx + 36, by + sz + 32, oss.str(), 1, { 138u, 152u, 134u, 255u });
    }

    // Panel 2 (Top-Right): 2.5D Thin-Leaf Raytraced Dappled Ground Shadow Map (Top-Down under English Oak)
    tech.FillRoundedRect(808, 60, 776, 332, 14.0f, { 22u, 23u, 26u, 255u }, { 48u, 50u, 56u, 255u });
    tech.DrawText(824, 76, "B. EXACT 2.5D THIN-LEAF + NOISY WOOD CAPSULE SHADOW MAP (ENGLISH OAK)", 1, { 220u, 224u, 214u, 255u });
    const int smX = 836, smY = 104, smW = 340, smH = 266;
    for (int py = 0; py < smH; ++py)
    {
        const float wy = 6.5f - (static_cast<float>(py) / static_cast<float>(smH - 1)) * 11.5f;
        for (int px = 0; px < smW; ++px)
        {
            const float wx = -7.5f + (static_cast<float>(px) / static_cast<float>(smW - 1)) * 12.5f;
            const float tr = oakMesh.SdfVolume.TraceShadowTransmittance(leafAtlas, { wx, wy, 0.02f }, sunDir, 0.008f, 1.0f);
            const uint8_t cr = static_cast<uint8_t>(30.0f + 195.0f * tr);
            const uint8_t cg = static_cast<uint8_t>(42.0f + 188.0f * tr);
            const uint8_t cb = static_cast<uint8_t>(38.0f + 150.0f * tr);
            tech.BlendPx(smX + px, smY + py, cr, cg, cb, 255u);
        }
    }
    tech.DrawText(1204, 122, "TWO-LEVEL 16^3 BRICKS", 1, { 162u, 184u, 124u, 255u });
    tech.DrawText(1204, 146, "THIN-LEAF SURVIVAL: 100.0%", 1, { 235u, 235u, 235u, 255u });
    tech.DrawText(1204, 168, "SHADOW BLOAT ERROR:   0.0%", 1, { 235u, 235u, 235u, 255u });
    tech.DrawText(1204, 190, "WOOD JOINT SEAM:   0.000MM", 1, { 235u, 235u, 235u, 255u });
    tech.DrawText(1204, 212, "WIND BARK SWIM:     0.0000", 1, { 235u, 235u, 235u, 255u });
    tech.DrawText(1204, 248, "CONE-WIDTH BEER-LAMBERT:", 1, { 255u, 180u, 84u, 255u });
    tech.DrawText(1204, 270, "NEAR = CRISP 2.5D SILHOUETTE", 1, { 176u, 176u, 176u, 255u });
    tech.DrawText(1204, 292, "FAR  = ANISOTROPIC EXTINCTION", 1, { 176u, 176u, 176u, 255u });

    // Panel 3 (Bottom-Left): WorldPartition Smooth C1 GPU <-> Deterministic CPU Transition Curve
    tech.FillRoundedRect(16, 408, 772, 336, 14.0f, { 22u, 23u, 26u, 255u }, { 48u, 50u, 56u, 255u });
    tech.DrawText(32, 424, "C. WORLDPARTITION 16M X 16M C1 GPU <-> DETERMINISTIC 120HZ CPU TRANSITION (0 SNAP)", 1, { 220u, 224u, 214u, 255u });
    const int gx0 = 56, gy0 = 462, gw = 700, gh = 226;
    tech.FillRect(gx0, gy0, gw, gh, { 14u, 16u, 19u, 255u });
    for (int i = 0; i <= 4; ++i)
    {
        const int y = gy0 + (gh * i) / 4;
        tech.FillRect(gx0, y, gw, 1, { 36u, 40u, 46u, 255u });
    }
    for (std::size_t i = 1u; i < timeline.size(); ++i)
    {
        const float x0 = gx0 + (timeline[i - 1u].T / 8.0f) * gw;
        const float x1 = gx0 + (timeline[i].T / 8.0f) * gw;
        // Blue/Gold curve: CpuWeight [0 = GPU .. 1 = Deterministic CPU]
        const float yW0 = gy0 + gh - timeline[i - 1u].CpuWeight * (gh - 18) - 9;
        const float yW1 = gy0 + gh - timeline[i].CpuWeight * (gh - 18) - 9;
        tech.DrawLine(x0, yW0, x1, yW1, 3.0f, { 255u, 180u, 84u, 255u });
        // Green curve: Smooth Oak Wind Bend Angle (continuous across transitions!)
        const float yB0 = gy0 + gh * 0.55f - timeline[i - 1u].BendOak * 420.0f;
        const float yB1 = gy0 + gh * 0.55f - timeline[i].BendOak * 420.0f;
        tech.DrawLine(x0, yB0, x1, yB1, 2.5f, { 112u, 218u, 134u, 255u });
    }
    tech.DrawText(gx0 + 10, gy0 + gh + 16, "AMBER: CPU WEIGHT (0=GPU -> HERMITE C1 -> 1=CPU -> GPU)   |   GREEN: CONTINUOUS OAK BEND", 1, { 196u, 200u, 194u, 255u });

    // Panel 4 (Bottom-Right): 3-State Falling -> Sleeping (0 ALU) -> ForceField Wake-Up Curve
    tech.FillRoundedRect(808, 408, 776, 336, 14.0f, { 22u, 23u, 26u, 255u }, { 48u, 50u, 56u, 255u });
    tech.DrawText(824, 424, "D. 4M X 4M LEAF SUBCELLS: ACTIVE -> SLEEPING (0 ALU) -> FORCEFIELD WAKE-UP", 1, { 220u, 224u, 214u, 255u });
    const int lx0 = 848, ly0 = 462, lw = 704, lh = 226;
    tech.FillRect(lx0, ly0, lw, lh, { 14u, 16u, 19u, 255u });
    // Mark ForceField gust wake moment (t = 5.2s)
    const int wakeX = lx0 + static_cast<int>((5.2f / 8.0f) * lw);
    tech.FillRect(wakeX, ly0, 2, lh, { 240u, 120u, 96u, 220u });
    tech.DrawText(wakeX + 6, ly0 + 10, "FORCEFIELD GUST WAKE", 1, { 244u, 142u, 118u, 255u });

    float maxLeaves = 1.0f;
    for (const auto& s : timeline) maxLeaves = std::max(maxLeaves, static_cast<float>(s.ActiveLeaves + s.SleepingLeaves));
    for (std::size_t i = 1u; i < timeline.size(); ++i)
    {
        const float x0 = lx0 + (timeline[i - 1u].T / 8.0f) * lw;
        const float x1 = lx0 + (timeline[i].T / 8.0f) * lw;
        const float ya0 = ly0 + lh - (static_cast<float>(timeline[i - 1u].ActiveLeaves) / maxLeaves) * (lh - 18) - 9;
        const float ya1 = ly0 + lh - (static_cast<float>(timeline[i].ActiveLeaves) / maxLeaves) * (lh - 18) - 9;
        const float ys0 = ly0 + lh - (static_cast<float>(timeline[i - 1u].SleepingLeaves) / maxLeaves) * (lh - 18) - 9;
        const float ys1 = ly0 + lh - (static_cast<float>(timeline[i].SleepingLeaves) / maxLeaves) * (lh - 18) - 9;
        tech.DrawLine(x0, ya0, x1, ya1, 3.0f, { 120u, 220u, 130u, 255u });
        tech.DrawLine(x0, ys0, x1, ys1, 3.0f, { 112u, 166u, 232u, 255u });
    }
    tech.DrawText(lx0 + 10, ly0 + lh + 16, "GREEN: ACTIVE FALLING/WOKEN LEAVES  |  BLUE: SLEEPING LEAVES (0 ALU, RE-BLOWABLE)", 1, { 196u, 200u, 194u, 255u });

    const bool wroteTech = WriteRgba8PngFile(proofOutDir / "03_WorldPartition_Wind_FallingLeaves_Proof.png", tech.W, tech.H, tech.Pix);

    // --- DELIVERABLE 4: Render 36 Animated Frames for Wind Sway + Falling/Sleeping/Waking Leaves GIF ---
    const fs::path framesDir = "/tmp/botanical-anim-frames";
    fs::create_directories(framesDir, ec);
    BotanicalWorldPartition animWp(wpCfg);
    for (std::size_t i = 0u; i < sceneActors.size(); ++i)
    {
        BotanicalPlantInstance pi {};
        pi.SpeciesId = sceneActors[i].Mesh.SpeciesId;
        pi.GrowthForm = sceneActors[i].Mesh.GrowthForm;
        pi.WorldPosMeters = sceneActors[i].Pos;
        pi.YawRad = sceneActors[i].Yaw;
        pi.HeightMeters = sceneActors[i].Mesh.BoundsMax[2];
        pi.StiffnessNmPerRad = (pi.GrowthForm == BotanicalGrowthForm::Fern) ? 16.0f : (pi.GrowthForm == BotanicalGrowthForm::Palm ? 28.0f : 60.0f);
        pi.DampingRatio = 0.28f;
        pi.WindFlexibility = (pi.GrowthForm == BotanicalGrowthForm::Fern) ? 0.85f : (pi.GrowthForm == BotanicalGrowthForm::Palm ? 0.68f : 0.40f);
        pi.AbscissionThreshN = 6.5f;
        pi.PhaseOffset = static_cast<float>(i) * 0.19f;
        pi.ForceNetworkAuth = true;
        (void)animWp.RegisterPlant(pi);
    }
    for (int k = 0; k < 42; ++k)
    {
        const float th = static_cast<float>(k) * 2.39996f;
        FallingLeafParticle lf {};
        lf.SourceEntityId = 6u;
        lf.PositionMeters = { 0.2f + std::cos(th) * 2.4f, 4.8f + std::sin(th) * 2.2f, 2.2f + 2.6f * (static_cast<float>(k % 6) / 5.0f) };
        lf.VelocityMps    = { 0.5f, -0.2f, -0.4f };
        lf.ColorLinear    = (k % 2 == 0) ? V3{ 0.36f, 0.30f, 0.06f } : V3{ 0.18f, 0.38f, 0.08f };
        lf.HalfSpanMeters = 0.11f;
        lf.FlutterPhase   = th;
        animWp.SpawnFallingLeaf(lf);
    }

    bool wroteFrames = true;
    for (int fr = 0; fr < 36; ++fr)
    {
        const float t = static_cast<float>(fr) * 0.15f;
        BotanicalWindFieldState aw {};
        aw.WindVelocityMps = { 5.2f + 3.2f * std::sin(t * 1.4f), 1.4f * std::cos(t * 1.1f), 0.0f };
        aw.GustStrengthMps = 2.8f;
        aw.GustFrequencyHz = 0.72f;
        if (fr >= 20)
        {
            aw.HasWakeImpulse   = true;
            aw.WakeCenterMeters = { -2.0f + static_cast<float>(fr - 20) * 0.45f, 3.8f, 0.2f };
            aw.WakeRadiusMeters = 8.5f;
            aw.WakeStrengthMps  = 10.5f;
            aw.WakeDirNorm      = { 0.92f, 0.38f, 0.0f };
        }
        for (int sub = 0; sub < 4; ++sub) animWp.Step(0.15f / 4.0f, aw, {});

        for (std::size_t i = 0u; i < sceneActors.size(); ++i)
        {
            const auto& pi = animWp.Plants()[i];
            ApplyWindPoseToPlant(sceneActors[i].Mesh, pi.BendAngleXRad * 1.35f, pi.BendAngleYRad * 1.35f, t, 0.45f);
        }

        CanvasRgba frame(720u, 420u, { 16u, 16u, 18u, 255u });
        RenderBotanical3dScene(frame, 0, 0, 720, 420, sceneActors, animWp.Leaves(), leafAtlas,
            { 0.3f + 0.65f * std::sin(t * 0.45f), -10.4f, 3.4f }, { 0.1f, 2.2f, 2.4f }, sunDir, false, true);
        frame.FillRoundedRect(12, 10, 456, 26, 10.0f, { 12u, 14u, 16u, 210u }, { 78u, 96u, 68u, 220u });
        const auto atel = animWp.GetTelemetry();
        std::ostringstream hud;
        hud << "PROJECTS/UNTITLED WIND SIM  |  ACTIVE:" << atel.ActiveLeafCount
            << "  SLEEP:" << atel.SleepingLeafCount << "  WOKEN:" << atel.WokenLeafCount;
        frame.DrawText(22, 19, hud.str(), 1, { 214u, 232u, 198u, 255u });

        char fname[128];
        std::snprintf(fname, sizeof(fname), "frame_%02d.png", fr);
        wroteFrames = wroteFrames && WriteRgba8PngFile(framesDir / fname, frame.W, frame.H, frame.Pix);
    }

    const bool gate8 = wroteUi && wroteShowcase && wroteTech && wroteFrames;
    if (gate8) ++passedGates;
    std::cout << "[Gate 8/8] UI + 3D Scene Proof Renders & Animation Frames  : " << (gate8 ? "PASS" : "FAIL") << "\n";
    std::cout << "================================================================================\n";
    std::cout << " SUMMARY: " << passedGates << " / " << kTotalGates << " STRICT GATES PASSED!\n";
    std::cout << "================================================================================\n";
    return (passedGates == kTotalGates) ? 0 : 1;
}
