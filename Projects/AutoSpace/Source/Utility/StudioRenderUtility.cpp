/*============================================================================================================================================
                                                         STUDIORENDERUTILITY.CPP
============================================================================================================================================*/
// 🧩 Shared math, lighting placement, PNG export, ParticleSpace compositing & Vulkan/CPU proof render utilities for AutoSpace

//------------------------------------------------------------------------------------------------------------------------
//                                                        INCLUDES
//------------------------------------------------------------------------------------------------------------------------

#include "Source/Utility/StudioRenderUtility.h"

#include "Engine/Constants/MathConstants.h"
#include "Engine/GeometricRaster/GlobalIllumination/VulkanWorldRenderSequence.h"
#include "Engine/GeometricRaster/VulkanInterchange.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <fstream>

namespace AutoSpace
{

using namespace Frontier;
using namespace Frontier::GeometricRaster;
using namespace Frontier::Mathematics;
using namespace Frontier::ParticleSpace;

namespace
{

void AppendBigEndianU32(std::vector<uint8_t>& Dest, uint32_t Word)
{
    Dest.push_back(static_cast<uint8_t>((Word >> 24u) & 0xFFu));
    Dest.push_back(static_cast<uint8_t>((Word >> 16u) & 0xFFu));
    Dest.push_back(static_cast<uint8_t>((Word >> 8u) & 0xFFu));
    Dest.push_back(static_cast<uint8_t>(Word & 0xFFu));
}

[[nodiscard]] uint32_t ComputePngCrc32(const uint8_t* Bytes, std::size_t Length) noexcept
{
    uint32_t Crc = 0xFFFFFFFFu;
    for (std::size_t I = 0u; I < Length; ++I)
    {
        Crc ^= Bytes[I];
        for (int Bit = 0; Bit < 8; ++Bit)
        {
            const uint32_t Mask = static_cast<uint32_t>(-static_cast<int32_t>(Crc & 1u));
            Crc = (Crc >> 1u) ^ (0xEDB88320u & Mask);
        }
    }
    return ~Crc;
}

void AppendPngChunk(std::vector<uint8_t>& Dest, const char Tag[4], const std::vector<uint8_t>& Body)
{
    AppendBigEndianU32(Dest, static_cast<uint32_t>(Body.size()));
    const std::size_t Start = Dest.size();
    for (int I = 0; I < 4; ++I)
    {
        Dest.push_back(static_cast<uint8_t>(Tag[I]));
    }
    Dest.insert(Dest.end(), Body.begin(), Body.end());
    AppendBigEndianU32(Dest, ComputePngCrc32(Dest.data() + Start, 4u + Body.size()));
}

[[nodiscard]] std::filesystem::path LocateCompiledShaderFolder(const std::filesystem::path& RepoRoot)
{
    const std::array<std::filesystem::path, 6u> Candidates {{
#ifdef FRONTIER_COMPILED_SHADER_DIR
        std::filesystem::path(FRONTIER_COMPILED_SHADER_DIR),
#else
        std::filesystem::current_path() / "CompiledShaders",
#endif
        RepoRoot / "Build/Editor/CompiledShaders",
        RepoRoot / "Build/Shipping/CompiledShaders",
        RepoRoot / "Build/CompiledShaders",
        std::filesystem::current_path() / "CompiledShaders",
        RepoRoot / "CompiledShaders",
    }};
    for (const auto& Dir : Candidates)
    {
        std::error_code Ec {};
        if (!Dir.empty() && std::filesystem::exists(Dir, Ec))
        {
            return Dir;
        }
    }
    return RepoRoot / "Build/Editor/CompiledShaders";
}

[[nodiscard]] std::array<float, 16> BuildWorldZUpViewProj(const PerspectiveCameraBasis& Cam) noexcept
{
    const Axis3D Fwd   = NormalizeVectorSafe(Cam.TargetPoint - Cam.CameraOrigin, { 0.0f, 1.0f, 0.0f });
    const Axis3D Right = NormalizeVectorSafe(EvaluateCross(Fwd, Cam.WorldUpAxis), { 1.0f, 0.0f, 0.0f });
    const Axis3D Up    = NormalizeVectorSafe(EvaluateCross(Right, Fwd), { 0.0f, 0.0f, 1.0f });

    const float Aspect = static_cast<float>(std::max(1u, Cam.ViewportWidthPx)) /
                         static_cast<float>(std::max(1u, Cam.ViewportHeightPx));
    const float F      = 1.0f / std::max(1.0e-4f, std::tan(Cam.VerticalFovRadians * 0.5f));
    const float ZNear  = std::max(0.05f, Cam.NearClipMeters);
    const float ZFar   = 1000.0f;

    const float Tx = -EvaluateDot(Right, Cam.CameraOrigin);
    const float Ty = -EvaluateDot(Up,    Cam.CameraOrigin);
    const float Tz =  EvaluateDot(Fwd,   Cam.CameraOrigin);

    const float A = (ZFar + ZNear) / (ZNear - ZFar);
    const float B = (2.0f * ZFar * ZNear) / (ZNear - ZFar);

    std::array<float, 16> VP {};
    VP[0]  = (F / Aspect) * Right.X;
    VP[1]  = F * Up.X;
    VP[2]  = -A * Fwd.X;
    VP[3]  = Fwd.X;

    VP[4]  = (F / Aspect) * Right.Y;
    VP[5]  = F * Up.Y;
    VP[6]  = -A * Fwd.Y;
    VP[7]  = Fwd.Y;

    VP[8]  = (F / Aspect) * Right.Z;
    VP[9]  = F * Up.Z;
    VP[10] = -A * Fwd.Z;
    VP[11] = Fwd.Z;

    VP[12] = (F / Aspect) * Tx;
    VP[13] = F * Ty;
    VP[14] = A * Tz + B;
    VP[15] = -Tz;
    return VP;
}

[[nodiscard]] PerspectiveCameraBasis ResolveProofCamera(
    std::span<const StudioCameraPresetView> CameraPresets,
    uint32_t                                PresetIndex,
    uint32_t                                ViewportWidthPx,
    uint32_t                                ViewportHeightPx) noexcept
{
    PerspectiveCameraBasis Cam {};
    if (!CameraPresets.empty())
    {
        const uint32_t Clamped = std::min(PresetIndex, static_cast<uint32_t>(CameraPresets.size() - 1u));
        Cam = CameraPresets[Clamped].Camera;
    }
    else
    {
        Cam.CameraOrigin       = ConvertHtmlPositionToWorldZUp(5.75f, 1.62f, 6.45f);
        Cam.TargetPoint        = ConvertHtmlPositionToWorldZUp(0.05f, 0.78f, -0.15f);
        Cam.WorldUpAxis        = { 0.0f, 0.0f, 1.0f };
        Cam.VerticalFovRadians = 35.0f * Constants::DegToRadFloat;
        Cam.NearClipMeters     = 0.10f;
    }
    Cam.ViewportWidthPx  = std::max(64u, ViewportWidthPx);
    Cam.ViewportHeightPx = std::max(64u, ViewportHeightPx);
    return Cam;
}

} // namespace

Axis3D ConvertHtmlPositionToWorldZUp(float Hx, float Hy, float Hz) noexcept
{
    return { Hx, -Hz, Hy };
}

Axis3D NormalizeVectorSafe(Axis3D V, Axis3D Fallback) noexcept
{
    return Frontier::Mathematics::NormalizeAxis(V, Fallback);
}

LinearRGB SrgbHexToLinearRgb(uint32_t HexRgb) noexcept
{
    const auto Ch = [](uint32_t B) noexcept -> float
    {
        const float S = static_cast<float>(B & 0xFFu) / 255.0f;
        return (S <= 0.04045f) ? (S / 12.92f) : std::pow((S + 0.055f) / 1.055f, 2.4f);
    };
    return { Ch(HexRgb >> 16u), Ch(HexRgb >> 8u), Ch(HexRgb) };
}

HtmlAimAngles ComputeHtmlAimAngles(Axis3D FromHtml, Axis3D TargetHtml) noexcept
{
    const float Dx    = TargetHtml.X - FromHtml.X;
    const float Dy    = TargetHtml.Y - FromHtml.Y;
    const float Dz    = TargetHtml.Z - FromHtml.Z;
    const float Horiz = std::max(1.0e-5f, std::hypot(Dx, Dz));
    const float Yaw   = std::atan2(Dx, Dz) * (180.0f / Constants::PiFloat);
    const float Pitch = std::atan2(-Dy, Horiz) * (180.0f / Constants::PiFloat);
    return { Yaw, Pitch };
}

float ComputeTripodMountHeight(const TripodParams& Params) noexcept
{
    return Params.StandHeight + Params.ColumnLift + (Params.Casters ? 0.08f : 0.0f) + (Params.FloorMat ? 0.032f : 0.0f);
}

uint64_t HashStableId64(std::string_view Text) noexcept
{
    uint64_t H = 14695981039346656037ull;
    for (const char Ch : Text)
    {
        H ^= static_cast<uint64_t>(static_cast<unsigned char>(Ch));
        H *= 1099511628211ull;
    }
    return H;
}

PolygonalAreaQuadLight MakeAimedAreaQuadLight(
    Axis3D    CenterWorld,
    Axis3D    AimTargetWorld,
    float     WidthMeters,
    float     HeightMeters,
    LinearRGB Radiance,
    bool      TwoSided) noexcept
{
    const Axis3D AimDir = NormalizeVectorSafe(AimTargetWorld - CenterWorld, { 0.0f, 0.0f, -1.0f });
    const Axis3D RefUp  = (std::fabs(AimDir.Z) < 0.96f) ? Axis3D{ 0.0f, 0.0f, 1.0f } : Axis3D{ 0.0f, 1.0f, 0.0f };
    Axis3D Right = NormalizeVectorSafe(EvaluateCross(RefUp, AimDir), { 1.0f, 0.0f, 0.0f });
    if (std::fabs(AimDir.Z) >= 0.96f)
    {
        Right = { 1.0f, 0.0f, 0.0f };
    }
    const Axis3D Up = NormalizeVectorSafe(EvaluateCross(AimDir, Right), { 0.0f, -1.0f, 0.0f });

    PolygonalAreaQuadLight Quad {};
    Quad.CenterWorld      = CenterWorld;
    Quad.RightTangent     = Right;
    Quad.UpBitangent      = Up;
    Quad.HalfWidthMeters  = WidthMeters * 0.5f;
    Quad.HalfHeightMeters = HeightMeters * 0.5f;
    Quad.EmittedRadiance  = Radiance;
    Quad.TwoSidedEmission = TwoSided;
    return Quad;
}

PhotometricPointRadiator MakeAimedPhotometricSpotLight(
    Axis3D    PosWorld,
    Axis3D    TargetWorld,
    LinearRGB PeakRgb,
    float     RangeMeters,
    uint32_t  ProfileOrdinal) noexcept
{
    const Axis3D BeamAxis = NormalizeVectorSafe(TargetWorld - PosWorld, { 0.0f, 0.0f, -1.0f });
    const Axis3D RefUp    = (std::fabs(BeamAxis.Z) < 0.96f) ? Axis3D{ 0.0f, 0.0f, 1.0f } : Axis3D{ 1.0f, 0.0f, 0.0f };
    const Axis3D ZeroAz   = NormalizeVectorSafe(EvaluateCross(RefUp, BeamAxis), { 1.0f, 0.0f, 0.0f });

    PhotometricPointRadiator Lamp {};
    Lamp.PositionWorld    = PosWorld;
    Lamp.BeamAxis         = BeamAxis;
    Lamp.ZeroAzimuthAxis  = ZeroAz;
    Lamp.PeakIntensityRgb = PeakRgb;
    Lamp.RangeMeters      = RangeMeters;
    Lamp.RadiusMeters     = 0.12f;
    Lamp.ProfileOrdinal   = ProfileOrdinal;
    return Lamp;
}

bool SaveRgba8ImageToPngFile(
    const std::filesystem::path& FilePath,
    uint32_t                     WidthPx,
    uint32_t                     HeightPx,
    const std::vector<uint8_t>&  RgbaBytes)
{
    if (WidthPx == 0u || HeightPx == 0u || RgbaBytes.size() < static_cast<std::size_t>(WidthPx) * HeightPx * 4u)
    {
        return false;
    }

    std::error_code Ec {};
    std::filesystem::create_directories(FilePath.parent_path(), Ec);

    std::vector<uint8_t> RawScanlines;
    const std::size_t RowBytes = 1u + static_cast<std::size_t>(WidthPx) * 4u;
    RawScanlines.reserve(RowBytes * HeightPx);
    for (uint32_t Y = 0u; Y < HeightPx; ++Y)
    {
        RawScanlines.push_back(0u);
        const uint8_t* RowPtr = RgbaBytes.data() + static_cast<std::size_t>(Y) * WidthPx * 4u;
        RawScanlines.insert(RawScanlines.end(), RowPtr, RowPtr + static_cast<std::size_t>(WidthPx) * 4u);
    }

    std::vector<uint8_t> ZlibData;
    ZlibData.reserve(RawScanlines.size() + 64u);
    ZlibData.push_back(0x78u);
    ZlibData.push_back(0x01u);

    uint32_t AdlerA = 1u;
    uint32_t AdlerB = 0u;
    for (const uint8_t Byte : RawScanlines)
    {
        AdlerA = (AdlerA + Byte) % 65521u;
        AdlerB = (AdlerB + AdlerA) % 65521u;
    }

    std::size_t Offset = 0u;
    while (Offset < RawScanlines.size())
    {
        const std::size_t ChunkLen = std::min<std::size_t>(65535u, RawScanlines.size() - Offset);
        const bool        IsLast   = (Offset + ChunkLen >= RawScanlines.size());
        ZlibData.push_back(IsLast ? 0x01u : 0x00u);
        const uint16_t Len16  = static_cast<uint16_t>(ChunkLen);
        const uint16_t Nlen16 = static_cast<uint16_t>(~Len16);
        ZlibData.push_back(static_cast<uint8_t>(Len16 & 0xFFu));
        ZlibData.push_back(static_cast<uint8_t>((Len16 >> 8u) & 0xFFu));
        ZlibData.push_back(static_cast<uint8_t>(Nlen16 & 0xFFu));
        ZlibData.push_back(static_cast<uint8_t>((Nlen16 >> 8u) & 0xFFu));
        ZlibData.insert(
            ZlibData.end(),
            RawScanlines.begin() + static_cast<std::ptrdiff_t>(Offset),
            RawScanlines.begin() + static_cast<std::ptrdiff_t>(Offset + ChunkLen));
        Offset += ChunkLen;
    }
    AppendBigEndianU32(ZlibData, (AdlerB << 16u) | AdlerA);

    std::vector<uint8_t> Png;
    constexpr uint8_t Sig[8] = { 137u, 80u, 78u, 71u, 13u, 10u, 26u, 10u };
    Png.insert(Png.end(), Sig, Sig + 8u);

    std::vector<uint8_t> Ihdr;
    AppendBigEndianU32(Ihdr, WidthPx);
    AppendBigEndianU32(Ihdr, HeightPx);
    Ihdr.push_back(8u);
    Ihdr.push_back(6u);
    Ihdr.push_back(0u);
    Ihdr.push_back(0u);
    Ihdr.push_back(0u);
    AppendPngChunk(Png, "IHDR", Ihdr);
    AppendPngChunk(Png, "IDAT", ZlibData);
    AppendPngChunk(Png, "IEND", {});

    std::ofstream File(FilePath, std::ios::binary | std::ios::trunc);
    if (!File.is_open())
    {
        return false;
    }
    File.write(reinterpret_cast<const char*>(Png.data()), static_cast<std::streamsize>(Png.size()));
    return File.good();
}

void CompositeParticleCloudsIntoRgba8(
    const WorldSceneSpecification&      Scene,
    const PerspectiveCameraBasis&       Camera,
    std::span<const ParticleCloudNode>  ParticleClouds,
    const ParticleGpuSimulation&        ParticleSimulation,
    const ParticleGpuRenderer&          ParticleRenderer,
    const ParticleSimulationRegion&     ParticleRegion,
    double                              SimulationClockSeconds,
    std::vector<uint8_t>&               InOutRgba8)
{
    if (ParticleClouds.empty())
    {
        return;
    }
    const uint32_t W = Camera.ViewportWidthPx;
    const uint32_t H = Camera.ViewportHeightPx;
    if (InOutRgba8.size() < static_cast<std::size_t>(W) * H * 4u)
    {
        return;
    }

    std::vector<ParticleCloudNode> TempClouds(ParticleClouds.begin(), ParticleClouds.end());

    ParticleCameraView PView {};
    PView.ViewProjection   = BuildWorldZUpViewProj(Camera);
    PView.CameraPosition   = { Camera.CameraOrigin.X, Camera.CameraOrigin.Y, Camera.CameraOrigin.Z };
    const Axis3D Fwd       = NormalizeVectorSafe(Camera.TargetPoint - Camera.CameraOrigin, { 0.0f, 1.0f, 0.0f });
    PView.CameraForward    = { Fwd.X, Fwd.Y, Fwd.Z };
    PView.ViewportWidthPx  = static_cast<float>(W);
    PView.ViewportHeightPx = static_cast<float>(H);
    PView.VerticalFovRad   = Camera.VerticalFovRadians;
    PView.PixelRatio       = 1.0f;

    const auto DrawCalls = ParticleRenderer.BuildSpriteRenderCalls(
        TempClouds,
        ParticleSimulation,
        PView,
        static_cast<float>(SimulationClockSeconds),
        ParticleRegion.HalfExtentMeters[1] * 2.0f);

    for (const auto& Call : DrawCalls)
    {
        const auto* Rec = ParticleSimulation.FindCloudRecord(Call.NodeId);
        if (Rec == nullptr || Rec->ActiveCount == 0u)
        {
            continue;
        }
        const bool IsAdditive = (Call.Blend == ParticleBlendOrdinal::Additive) || Call.IsHaloCall;
        for (uint32_t I = 0u; I < Rec->ActiveCount && I < Rec->ReadStates.size(); ++I)
        {
            const auto& State = Rec->ReadStates[I];
            if (State.PositionAge[3] < 0.0f)
            {
                continue;
            }
            const Axis3D WorldP { State.PositionAge[0], -State.PositionAge[2], State.PositionAge[1] };

            const float ClipX = PView.ViewProjection[0] * WorldP.X + PView.ViewProjection[4] * WorldP.Y + PView.ViewProjection[8]  * WorldP.Z + PView.ViewProjection[12];
            const float ClipY = PView.ViewProjection[1] * WorldP.X + PView.ViewProjection[5] * WorldP.Y + PView.ViewProjection[9]  * WorldP.Z + PView.ViewProjection[13];
            const float ClipW = PView.ViewProjection[3] * WorldP.X + PView.ViewProjection[7] * WorldP.Y + PView.ViewProjection[11] * WorldP.Z + PView.ViewProjection[15];
            if (ClipW <= 0.1f)
            {
                continue;
            }
            const float NdcX = ClipX / ClipW;
            const float NdcY = ClipY / ClipW;
            if (std::fabs(NdcX) > 1.05f || std::fabs(NdcY) > 1.05f)
            {
                continue;
            }
            const float ScreenX = (NdcX * 0.5f + 0.5f) * static_cast<float>(W);
            const float ScreenY = (0.5f - NdcY * 0.5f) * static_cast<float>(H);

            const auto Shade = EvaluateParticleShadeCpu(
                Call.UniformBlock.Shape,
                Call.UniformBlock.Shade,
                Rec->AnchorTexels.Data,
                static_cast<int32_t>(I),
                State.PositionAge,
                State.VelocitySeed);

            float DiamPx = 4.0f;
            float DofAlpha = 1.0f;
            ComputeSpriteDofMetricsCpu(
                Call.UniformBlock,
                Call.UniformBlock.ViewportYSizeParams[1],
                ClipW,
                DiamPx,
                DofAlpha);

            const Axis3D RayDir = NormalizeVectorSafe(WorldP - Camera.CameraOrigin, { 0.0f, 1.0f, 0.0f });
            const float  Dist   = std::sqrt(EvaluateLengthSquared(WorldP - Camera.CameraOrigin));
            SpatialAcceleration::RaySegmentQuery VisRay {};
            VisRay.Origin          = Camera.CameraOrigin;
            VisRay.MinimumDistance = 0.05f;
            VisRay.UnitDirection   = RayDir;
            VisRay.MaximumDistance = std::max(0.06f, Dist - 0.08f);
            if (Scene.SceneTree.QueryRayOccluded(VisRay))
            {
                continue;
            }

            const float RadiusPx     = std::clamp(DiamPx * 0.65f, 2.2f, 22.0f);
            const float SoftAlphaMul = (Call.NodeId.find("smoke") != std::string::npos) ? 0.24f : 0.42f;
            const float BaseAlpha    = std::clamp(Shade.Alpha * DofAlpha * SoftAlphaMul, 0.0f, 0.55f);
            if (BaseAlpha <= 0.004f)
            {
                continue;
            }

            const int X0 = std::max(0, static_cast<int>(std::floor(ScreenX - RadiusPx)));
            const int X1 = std::min(static_cast<int>(W) - 1, static_cast<int>(std::ceil(ScreenX + RadiusPx)));
            const int Y0 = std::max(0, static_cast<int>(std::floor(ScreenY - RadiusPx)));
            const int Y1 = std::min(static_cast<int>(H) - 1, static_cast<int>(std::ceil(ScreenY + RadiusPx)));
            for (int Py = Y0; Py <= Y1; ++Py)
            {
                for (int Px = X0; Px <= X1; ++Px)
                {
                    const float U = ((static_cast<float>(Px) + 0.5f - ScreenX) / RadiusPx) * 0.5f + 0.5f;
                    const float V = ((static_cast<float>(Py) + 0.5f - ScreenY) / RadiusPx) * 0.5f + 0.5f;
                    const auto Cut = EvaluateSpriteCutoutCpu(
                        0u,
                        static_cast<uint32_t>(Call.UniformBlock.HaloSpriteStyleTrail[2]),
                        { Shade.Colour[0], Shade.Colour[1], Shade.Colour[2], BaseAlpha },
                        1.0f, 0.5f, { 0.0f, 0.0f, 0.0f, 0.0f }, { U, V });
                    if (Cut.Discarded || Cut.Alpha <= 0.002f)
                    {
                        continue;
                    }
                    const std::size_t Off = (static_cast<std::size_t>(Py) * W + static_cast<std::size_t>(Px)) * 4u;
                    const float SrcA = std::clamp(Cut.Alpha, 0.0f, 1.0f);
                    for (int C = 0; C < 3; ++C)
                    {
                        const float Dst = static_cast<float>(InOutRgba8[Off + C]) / 255.0f;
                        const float Src = std::clamp(Cut.Rgb[C], 0.0f, 1.0f);
                        const float Blended = IsAdditive ? std::min(1.0f, Dst + Src * SrcA) : (Dst * (1.0f - SrcA) + Src * SrcA);
                        InOutRgba8[Off + C] = static_cast<uint8_t>(std::lround(Blended * 255.0f));
                    }
                }
            }
        }
    }
}

bool RenderWorldVisualProof(
    WorldSceneSpecification&                   Scene,
    std::span<const StudioCameraPresetView>    CameraPresets,
    uint32_t                            ActivePresetIndex,
    bool                                EnableParticles,
    std::span<const ParticleCloudNode>  ParticleClouds,
    const ParticleGpuSimulation&        ParticleSimulation,
    const ParticleGpuRenderer&          ParticleRenderer,
    const ParticleSimulationRegion&     ParticleRegion,
    double                              SimulationClockSeconds,
    std::string_view                    LobbySlug,
    const std::filesystem::path&        OutputDirectory,
    const std::filesystem::path&        RepositoryRoot,
    uint32_t                            WidthPx,
    uint32_t                            HeightPx,
    std::string&                        OutDiagnostic)
{
    const uint32_t W = std::max(320u, WidthPx);
    const uint32_t H = std::max(240u, HeightPx);

    std::error_code Ec {};
    std::filesystem::create_directories(OutputDirectory, Ec);

    TieredWorldRenderSequence CpuSequence {};
    CpuSequence.PrepareWorldScene(Scene);
    CpuSequence.SynchronizeWorldAtmosphere(Scene);

    VulkanInterchange VkDevice {};
    VulkanWorldRenderSequence GpuSequence {};
    bool VulkanReady = false;
    std::string VkDiag {};
    if (VkDevice.InitializeInterchange(RepositoryRoot, &VkDiag))
    {
        const std::filesystem::path ShaderDir = LocateCompiledShaderFolder(RepositoryRoot);
        if (GpuSequence.InitializeSequence(VkDevice, ShaderDir))
        {
            GpuSequence.SynchronizeSceneResources(Scene, true);
            VulkanReady = true;
        }
    }

    const std::string Slug(LobbySlug);
    const PerspectiveCameraBasis HeroCam = ResolveProofCamera(CameraPresets, ActivePresetIndex, W, H);

    if (VulkanReady)
    {
        {
            WorldRenderConfiguration Cfg {};
            Cfg.Engine             = WorldRenderEngine::RealTimeGiGtxLowEnd;
            Cfg.ShadowAlgorithm    = SolarShadowAlgorithm::WideTreeRayQuery;
            Cfg.ReflectionSource   = SpecularReflectionSource::WideTreeRaytrace;
            Cfg.ReflectionsEnabled = true;
            Cfg.RaytracingEnabled  = true;
            Cfg.SdfGiIntensity     = 1.05f;
            Cfg.ExposureGain       = 1.05f;

            std::vector<uint8_t> Rgba {};
            if (!GpuSequence.RenderWorldViewportWithEngine(Cfg, 0u, HeroCam, Scene, Rgba))
            {
                OutDiagnostic = "Vulkan RealTimeGiGtxLowEnd viewport render failed.";
                GpuSequence.TeardownSequence();
                return false;
            }
            if (EnableParticles)
            {
                CompositeParticleCloudsIntoRgba8(
                    Scene, HeroCam, ParticleClouds, ParticleSimulation, ParticleRenderer, ParticleRegion, SimulationClockSeconds, Rgba);
            }
            const auto OutPath = OutputDirectory / (Slug + "-Hero34-VulkanGi.png");
            if (!SaveRgba8ImageToPngFile(OutPath, W, H, Rgba))
            {
                OutDiagnostic = "Failed to save " + OutPath.string();
                GpuSequence.TeardownSequence();
                return false;
            }
        }

        if (CameraPresets.size() >= 6u)
        {
            const PerspectiveCameraBasis CrewCam = ResolveProofCamera(CameraPresets, 5u, W, H);
            WorldRenderConfiguration Cfg {};
            Cfg.Engine             = WorldRenderEngine::RealTimeGiGtxLowEnd;
            Cfg.ShadowAlgorithm    = SolarShadowAlgorithm::WideTreeRayQuery;
            Cfg.ReflectionSource   = SpecularReflectionSource::WideTreeRaytrace;
            Cfg.ReflectionsEnabled = true;
            Cfg.RaytracingEnabled  = true;
            Cfg.SdfGiIntensity     = 1.05f;
            Cfg.ExposureGain       = 1.15f;

            std::vector<uint8_t> Rgba {};
            if (GpuSequence.RenderWorldViewportWithEngine(Cfg, 1u, CrewCam, Scene, Rgba))
            {
                if (EnableParticles)
                {
                    CompositeParticleCloudsIntoRgba8(
                        Scene, CrewCam, ParticleClouds, ParticleSimulation, ParticleRenderer, ParticleRegion, SimulationClockSeconds, Rgba);
                }
                (void)SaveRgba8ImageToPngFile(OutputDirectory / (Slug + "-CrewBTS-VulkanGi.png"), W, H, Rgba);
            }
        }

        GpuSequence.TeardownSequence();
    }
    else
    {
        WorldRenderConfiguration CpuCfg {};
        CpuCfg.Engine             = WorldRenderEngine::OpenPbrDirect;
        CpuCfg.ShadowAlgorithm    = SolarShadowAlgorithm::WideTreeRayQuery;
        CpuCfg.ReflectionSource   = SpecularReflectionSource::WideTreeRaytrace;
        CpuCfg.ReflectionsEnabled = true;
        CpuCfg.RaytracingEnabled  = true;
        CpuCfg.ExposureGain       = 1.25f;

        auto Out = CpuSequence.RenderWorldFrameWithEngine(CpuCfg, HeroCam, HeroCam, Scene);
        if (EnableParticles)
        {
            CompositeParticleCloudsIntoRgba8(
                Scene, HeroCam, ParticleClouds, ParticleSimulation, ParticleRenderer, ParticleRegion, SimulationClockSeconds, Out.DisplayRgba8);
        }
        const auto OutPath = OutputDirectory / (Slug + "-Hero34-CpuDirect.png");
        if (!SaveRgba8ImageToPngFile(OutPath, W, H, Out.DisplayRgba8))
        {
            OutDiagnostic = "Failed to save " + OutPath.string();
            return false;
        }
    }

    return true;
}

} // namespace AutoSpace
