/*============================================================================================================================================
                                                          STUDIOLOBBYHOST.CPP
============================================================================================================================================*/
// 🧩 Single-level implementation of Lobby 1 (Cyclorama), Lobby 2 (Forest Stage) & Lobby 3 (Racing Garage) controlled by StudioLobbyPolicy

//------------------------------------------------------------------------------------------------------------------------
//                                                        INCLUDES
//------------------------------------------------------------------------------------------------------------------------

#include "Source/StudioLobbyHost.h"

#include "Engine/Constants/MathConstants.h"
#include "Engine/GeometricRaster/GlobalIllumination/VulkanWorldRenderSequence.h"
#include "Engine/GeometricRaster/VulkanInterchange.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <utility>

namespace AutoSpace
{

namespace
{

using namespace Frontier;
using namespace Frontier::Codecs;
using namespace Frontier::GeometricRaster;
using namespace Frontier::Mathematics;
using namespace Frontier::ParticleSpace;
using namespace Frontier::World;

[[nodiscard]] Axis3D ConvertHtmlPos(float Hx, float Hy, float Hz) noexcept
{
    return { Hx, -Hz, Hy };
}

[[nodiscard]] Axis3D SafeNorm(Axis3D V, Axis3D Fallback = { 0.0f, 0.0f, -1.0f }) noexcept
{
    return Frontier::Mathematics::NormalizeAxis(V, Fallback);
}

[[nodiscard]] LinearRGB SrgbHex(uint32_t HexRgb) noexcept
{
    const auto Ch = [](uint32_t B) noexcept -> float
    {
        const float S = static_cast<float>(B & 0xFFu) / 255.0f;
        return (S <= 0.04045f) ? (S / 12.92f) : std::pow((S + 0.055f) / 1.055f, 2.4f);
    };
    return { Ch(HexRgb >> 16u), Ch(HexRgb >> 8u), Ch(HexRgb) };
}

// Compute HTML Y-up YawDeg and PitchDeg so local +Z aims toward TargetHtml
struct HtmlAimAngles
{
    float YawDeg   = 0.0f;
    float PitchDeg = 0.0f;
};

[[nodiscard]] HtmlAimAngles ComputeHtmlAim(Axis3D FromHtml, Axis3D TargetHtml) noexcept
{
    const float Dx    = TargetHtml.X - FromHtml.X;
    const float Dy    = TargetHtml.Y - FromHtml.Y;
    const float Dz    = TargetHtml.Z - FromHtml.Z;
    const float Horiz = std::max(1.0e-5f, std::hypot(Dx, Dz));
    const float Yaw   = std::atan2(Dx, Dz) * (180.0f / Constants::PiFloat);
    const float Pitch = std::atan2(-Dy, Horiz) * (180.0f / Constants::PiFloat);
    return { Yaw, Pitch };
}

[[nodiscard]] float ComputeTripodMountHeight(const TripodParams& P) noexcept
{
    return P.StandHeight + P.ColumnLift + (P.Casters ? 0.08f : 0.0f) + (P.FloorMat ? 0.032f : 0.0f);
}

// Construct PolygonalAreaQuadLight whose emitter normal (cross(RightTangent, UpBitangent)) points along AimDir!
[[nodiscard]] PolygonalAreaQuadLight MakeAimedAreaQuad(
    Axis3D    CenterWorld,
    Axis3D    AimTargetWorld,
    float     WidthMeters,
    float     HeightMeters,
    LinearRGB Radiance,
    bool      TwoSided = false) noexcept
{
    const Axis3D AimDir = SafeNorm(AimTargetWorld - CenterWorld, { 0.0f, 0.0f, -1.0f });
    const Axis3D RefUp  = (std::fabs(AimDir.Z) < 0.96f) ? Axis3D{ 0.0f, 0.0f, 1.0f } : Axis3D{ 0.0f, 1.0f, 0.0f };
    Axis3D Right = SafeNorm(EvaluateCross(RefUp, AimDir), { 1.0f, 0.0f, 0.0f });
    if (std::fabs(AimDir.Z) >= 0.96f)
    {
        // Horizontal overhead bank aligned with studio X/Y axes pointing straight down
        Right = { 1.0f, 0.0f, 0.0f };
    }
    const Axis3D Up = SafeNorm(EvaluateCross(AimDir, Right), { 0.0f, -1.0f, 0.0f });

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

[[nodiscard]] PhotometricPointRadiator MakeAimedPhotometricSpot(
    Axis3D    PosWorld,
    Axis3D    TargetWorld,
    LinearRGB PeakRgb,
    float     RangeMeters,
    uint32_t  ProfileOrdinal = 2u) noexcept
{
    const Axis3D BeamAxis = SafeNorm(TargetWorld - PosWorld, { 0.0f, 0.0f, -1.0f });
    const Axis3D RefUp    = (std::fabs(BeamAxis.Z) < 0.96f) ? Axis3D{ 0.0f, 0.0f, 1.0f } : Axis3D{ 1.0f, 0.0f, 0.0f };
    const Axis3D ZeroAz   = SafeNorm(EvaluateCross(RefUp, BeamAxis), { 1.0f, 0.0f, 0.0f });

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

[[nodiscard]] uint64_t HashString64(std::string_view Text) noexcept
{
    uint64_t H = 14695981039346656037ull;
    for (const char Ch : Text)
    {
        H ^= static_cast<uint64_t>(static_cast<unsigned char>(Ch));
        H *= 1099511628211ull;
    }
    return H;
}

//------------------------------------------------------------------------------------------------------------------------
//                                      SELF-CONTAINED UNCOMPRESSED PNG WRITER
//------------------------------------------------------------------------------------------------------------------------

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

[[nodiscard]] bool SaveRgba8ImageToPng(
    const std::filesystem::path& FilePath,
    uint32_t                     Width,
    uint32_t                     Height,
    const std::vector<uint8_t>&  Rgba)
{
    if (Width == 0u || Height == 0u || Rgba.size() < static_cast<std::size_t>(Width) * Height * 4u)
    {
        return false;
    }

    std::error_code Ec {};
    std::filesystem::create_directories(FilePath.parent_path(), Ec);

    std::vector<uint8_t> RawScanlines;
    const std::size_t RowBytes = 1u + static_cast<std::size_t>(Width) * 4u;
    RawScanlines.reserve(RowBytes * Height);
    for (uint32_t Y = 0u; Y < Height; ++Y)
    {
        RawScanlines.push_back(0u); // Filter type 0 (None)
        const uint8_t* RowPtr = Rgba.data() + static_cast<std::size_t>(Y) * Width * 4u;
        RawScanlines.insert(RawScanlines.end(), RowPtr, RowPtr + static_cast<std::size_t>(Width) * 4u);
    }

    // Zlib stored (uncompressed DEFLATE) framing
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
        ZlibData.insert(ZlibData.end(), RawScanlines.begin() + static_cast<std::ptrdiff_t>(Offset), RawScanlines.begin() + static_cast<std::ptrdiff_t>(Offset + ChunkLen));
        Offset += ChunkLen;
    }
    AppendBigEndianU32(ZlibData, (AdlerB << 16u) | AdlerA);

    std::vector<uint8_t> Png;
    constexpr uint8_t Sig[8] = { 137u, 80u, 78u, 71u, 13u, 10u, 26u, 10u };
    Png.insert(Png.end(), Sig, Sig + 8u);

    std::vector<uint8_t> Ihdr;
    AppendBigEndianU32(Ihdr, Width);
    AppendBigEndianU32(Ihdr, Height);
    Ihdr.push_back(8u); // Bit depth
    Ihdr.push_back(6u); // RGBA
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
    const Axis3D Fwd   = SafeNorm(Cam.TargetPoint - Cam.CameraOrigin, { 0.0f, 1.0f, 0.0f });
    const Axis3D Right = SafeNorm(EvaluateCross(Fwd, Cam.WorldUpAxis), { 1.0f, 0.0f, 0.0f });
    const Axis3D Up    = SafeNorm(EvaluateCross(Right, Fwd), { 0.0f, 0.0f, 1.0f });

    const float Aspect = static_cast<float>(std::max(1u, Cam.ViewportWidthPx)) /
                         static_cast<float>(std::max(1u, Cam.ViewportHeightPx));
    const float F      = 1.0f / std::max(1.0e-4f, std::tan(Cam.VerticalFovRadians * 0.5f));
    const float ZNear  = std::max(0.05f, Cam.NearClipMeters);
    const float ZFar   = 1000.0f;

    // Right-handed OpenGL clip matrix (column-major): M[col*4 + row]
    const float Tx = -EvaluateDot(Right, Cam.CameraOrigin);
    const float Ty = -EvaluateDot(Up,    Cam.CameraOrigin);
    const float Tz =  EvaluateDot(Fwd,   Cam.CameraOrigin);

    const float A = (ZFar + ZNear) / (ZNear - ZFar);
    const float B = (2.0f * ZFar * ZNear) / (ZNear - ZFar);

    std::array<float, 16> VP {};
    // Column 0 (X)
    VP[0]  = (F / Aspect) * Right.X;
    VP[1]  = F * Up.X;
    VP[2]  = -A * Fwd.X;
    VP[3]  = Fwd.X;
    // Column 1 (Y)
    VP[4]  = (F / Aspect) * Right.Y;
    VP[5]  = F * Up.Y;
    VP[6]  = -A * Fwd.Y;
    VP[7]  = Fwd.Y;
    // Column 2 (Z)
    VP[8]  = (F / Aspect) * Right.Z;
    VP[9]  = F * Up.Z;
    VP[10] = -A * Fwd.Z;
    VP[11] = Fwd.Z;
    // Column 3 (Translation)
    VP[12] = (F / Aspect) * Tx;
    VP[13] = F * Ty;
    VP[14] = A * Tz + B;
    VP[15] = -Tz;
    return VP;
}

} // namespace

//------------------------------------------------------------------------------------------------------------------------
//                                           LIFECYCLE & INITIALIZATION
//------------------------------------------------------------------------------------------------------------------------

StudioLobbyHost::~StudioLobbyHost() noexcept
{
    Shutdown();
}

void StudioLobbyHost::Shutdown() noexcept
{
    ClearLobbyObjects();
#if FRONTIER_PROFILE_EDITOR
    if (EditorBridge != nullptr)
    {
        EditorBridge->Unbind();
        EditorBridge.reset();
    }
    BoundOutliner = nullptr;
#endif
}

void StudioLobbyHost::ClearLobbyObjects() noexcept
{
    // Destroy RAII category handles BEFORE clearing WorldRegister or unbinding Outliner!
    ManagedCategoryHandles.clear();
    FolderTokens.clear();
    SceneSyncBridge.ClearBindings();
    WorldRegister.ClearAll();
    WorldScene = {};
    GeometryAssets.clear();
    CameraPresets.clear();
    ParticleClouds.clear();
    ParticleSimulation = {};
    SimulationClockSeconds = 0.0;
    VehicleCount = 0u;
    TotalMeshTriangles = 0u;
}

#if FRONTIER_PROFILE_EDITOR
void StudioLobbyHost::AttachOutliner(Frontier::OutlinerPanel* Outliner) noexcept
{
    if (BoundOutliner == Outliner && EditorBridge != nullptr)
    {
        return;
    }
    ManagedCategoryHandles.clear();
    FolderTokens.clear();
    if (EditorBridge != nullptr)
    {
        EditorBridge->Unbind();
        EditorBridge.reset();
    }
    BoundOutliner = Outliner;
    if (BoundOutliner != nullptr)
    {
        EditorBridge = std::make_unique<Frontier::Editor::WorldInstanceEditorBridge>();
        EditorBridge->BindOutliner(WorldRegister, *BoundOutliner);
    }
}
#endif

bool StudioLobbyHost::EnsureSharedAssetsLoaded(
    const std::filesystem::path& RepoRoot,
    std::string&                 OutDiagnostic)
{
    if (SharedAssetsReady)
    {
        return true;
    }

    if (!ControlVehicleSurfaceDecoder::DecodeAssembledVehicle(
            RepoRoot,
            VehicleCoordinateConvention::FrontierWorldZUp,
            ControlVehicleTemplate,
            OutDiagnostic))
    {
        OutDiagnostic = "StudioLobbyHost failed to decode ControlVehicle.GeometrySpace: " + OutDiagnostic;
        return false;
    }

    if (!PhotometricProfileCodec::LoadCanonicalPhotometrySuite(RepoRoot, PhotometrySuite, OutDiagnostic))
    {
        OutDiagnostic = "StudioLobbyHost failed to load canonical photometry profiles: " + OutDiagnostic;
        return false;
    }

    // Load Engine ParticleSpace template specifications & 71 templates (non-fatal if directory absent in minimal test packs)
    const std::filesystem::path SpecsPath     = RepoRoot / "EngineContent/Simulation/LayerSpecifications.VolumetricSpace";
    const std::filesystem::path TemplatesDir  = RepoRoot / "EngineContent/Simulation/ParticleTemplates";
    std::string ParticleErr {};
    if (std::filesystem::exists(SpecsPath) && std::filesystem::exists(TemplatesDir))
    {
        if (const auto LoadedSpecs = Frontier::SimulationSpace::EffectLayers::LoadLayerSpecificationsFromFile(SpecsPath.string(), &ParticleErr))
        {
            ParticleSpecs = *LoadedSpecs;
            ParticleCatalogReady = ParticleTemplates.LoadFromDirectory(ParticleSpecs, TemplatesDir.string(), &ParticleErr);
        }
    }

    SharedAssetsReady = true;
    return true;
}

bool StudioLobbyHost::BuildLobbyInSingleWorld(
    const std::filesystem::path& RepoRoot,
    const StudioLobbyPolicy&     Policy,
    std::string&                 OutDiagnostic)
{
    ActivePolicy = Policy;
    ClampStudioLobbyPolicyBounds(ActivePolicy);

    if (!EnsureSharedAssetsLoaded(RepoRoot, OutDiagnostic))
    {
        return false;
    }

    ClearLobbyObjects();

#if FRONTIER_PROFILE_EDITOR
    if (BoundOutliner != nullptr)
    {
        if (EditorBridge == nullptr)
        {
            EditorBridge = std::make_unique<Frontier::Editor::WorldInstanceEditorBridge>();
        }
        EditorBridge->BindOutliner(WorldRegister, *BoundOutliner);
    }
#endif

    WorldRegister.ReserveInstanceCapacity(128u);
    RegisterStudioBaseMaterials(WorldScene.MaterialRegister, MaterialPalette);
    WorldScene.PhotometricProfiles = PhotometrySuite;

    switch (ActivePolicy.SelectedLobby)
    {
        case StudioLobbyId::StudioLobby2ForestStage:
            BuildLobby2ForestStage(ActivePolicy);
            break;
        case StudioLobbyId::StudioLobby3RacingGarage:
            BuildLobby3RacingGarage(ActivePolicy);
            break;
        case StudioLobbyId::StudioLobby1Cyclorama:
        default:
            BuildLobby1Cyclorama(ActivePolicy);
            break;
    }

    (void)SceneSyncBridge.FlushRebuiltTransformsToScene(WorldRegister, WorldScene);
    FinalizeWorldSceneAcceleration();

    // Advance initial 20 particle frames so atmospheric emitters are populated from tick 0
    if (ActivePolicy.EnableEngineParticles && !ParticleClouds.empty())
    {
        for (int Step = 0; Step < 20; ++Step)
        {
            TickSimulation(1.0 / 60.0);
        }
    }

    return true;
}

//------------------------------------------------------------------------------------------------------------------------
//                                        WORLDREGISTER & OUTLINER HELPER ROUTINES
//------------------------------------------------------------------------------------------------------------------------

InstanceToken StudioLobbyHost::CreateFolderEntry(
    std::string_view Title,
    std::string_view Subtitle,
    InstanceToken    EnclosingToken)
{
    const InstanceToken FolderTok = WorldRegister.IssueInstanceSlot(InstanceCategory::ContainmentFolder, 0u);
    if (!FolderTok.QueryValid())
    {
        return {};
    }
    if (EnclosingToken.QueryValid())
    {
        (void)WorldRegister.AttachNestedSlot(EnclosingToken, FolderTok);
    }
    FolderTokens.push_back(FolderTok);

#if FRONTIER_PROFILE_EDITOR
    EditorInstanceRegistrationDescriptor Desc {};
    Desc.Token              = FolderTok;
    Desc.EnclosingToken     = EnclosingToken;
    Desc.DisplayTitle       = Title;
    Desc.CategoryLabel      = "Folder";
    Desc.Subtitle           = Subtitle;
    Desc.CategoryTag        = "env:folder";
    Desc.VisibilityEnabled  = true;
    Desc.RemovalProtected   = false;
    Desc.DuplicateProtected = false;
    WorldRegister.NotifyEditorInstanceRegistered(Desc);
#else
    (void)Title;
    (void)Subtitle;
#endif
    return FolderTok;
}

void StudioLobbyHost::SyncOutlinerEntryMetadata(
    InstanceToken    Token,
    std::string_view Subtitle,
    std::string_view DomainTag,
    Axis3D           WorldPos,
    Axis3D           RotationDeg,
    float            Scale,
    bool             RemovalProtected)
{
#if FRONTIER_PROFILE_EDITOR
    if (BoundOutliner == nullptr || EditorBridge == nullptr || !Token.QueryValid())
    {
        return;
    }
    const OutlinerSlotToken Slot = EditorBridge->QueryOutlinerSlot(Token);
    if (OutlinerRecordEntry* Entry = BoundOutliner->AccessEntry(Slot))
    {
        Entry->Subtitle         = std::string(Subtitle);
        Entry->DomainTag        = std::string(DomainTag);
        Entry->PositionX        = WorldPos.X;
        Entry->PositionY        = WorldPos.Y;
        Entry->PositionZ        = WorldPos.Z;
        Entry->RotationX        = RotationDeg.X;
        Entry->RotationY        = RotationDeg.Y;
        Entry->RotationZ        = RotationDeg.Z;
        Entry->ScaleX           = Scale;
        Entry->ScaleY           = Scale;
        Entry->ScaleZ           = Scale;
        Entry->RemovalProtected = RemovalProtected;
        Entry->Expanded         = true;
    }
#else
    (void)Token;
    (void)Subtitle;
    (void)DomainTag;
    (void)WorldPos;
    (void)RotationDeg;
    (void)Scale;
    (void)RemovalProtected;
#endif
}

uint32_t StudioLobbyHost::AppendSurfaceEntity(
    std::string_view StableId,
    std::string_view OutlinerTitle,
    std::string_view Subtitle,
    StudioBuiltMesh  BuiltMesh,
    Axis3D           WorldTranslation,
    uint16_t         FallbackMaterialSlot,
    InstanceToken    EnclosingToken,
    bool             CastShadows)
{
    auto Asset = std::make_unique<StudioGeometryAsset>();
    Asset->StableId = std::string(StableId);
    Asset->Network  = std::move(BuiltMesh.Network);
    TotalMeshTriangles += static_cast<uint32_t>(Asset->Network.Faces.size());

    Frontier::SpatialAcceleration::ClusterLodBakeConfiguration BakeCfg {};
    BakeCfg.MaximumLevels             = 4u;
    BakeCfg.LockMaterialBoundaries    = true;
    BakeCfg.AuthoredFaceCornerNormals = std::move(BuiltMesh.AuthoredCornerNormals);
    (void)Asset->Pyramid.BuildFromPolygonNetwork(Asset->Network, BakeCfg);

    RigidClusterInstance Inst {};
    Inst.PyramidAsset        = &Asset->Pyramid;
    Inst.WorldTranslation    = WorldTranslation;
    Inst.PreviousTranslation = WorldTranslation;
    Inst.UniformScale        = 1.0f;
    Inst.NonUniformScale     = { 1.0f, 1.0f, 1.0f };
    Inst.RotationZDegrees    = 0.0f;
    Inst.MaterialSlot        = FallbackMaterialSlot;

    const uint32_t ClusterIdx = static_cast<uint32_t>(WorldScene.ClusterInstances.size());
    WorldScene.ClusterInstances.push_back(Inst);
    GeometryAssets.push_back(std::move(Asset));

    SurfaceInstanceParameters Params {};
    Params.GeometryDocumentHash64 = HashString64(StableId);
    Params.MaterialDocumentHash64 = static_cast<uint64_t>(FallbackMaterialSlot);
    Params.CastShadows            = CastShadows;
    Params.VisibilityEnabled      = true;

#if FRONTIER_PROFILE_EDITOR
    SurfaceInstance Handle(WorldRegister, OutlinerTitle, Params, EnclosingToken);
#else
    (void)OutlinerTitle;
    SurfaceInstance Handle(WorldRegister, Params);
#endif
    const InstanceToken Tok = Handle.QueryToken();
    if (EnclosingToken.QueryValid())
    {
        (void)WorldRegister.AttachNestedSlot(EnclosingToken, Tok);
    }
    (void)WorldRegister.AssignWorldTransform(Tok, WorldTranslation.X, WorldTranslation.Y, WorldTranslation.Z);
    SceneSyncBridge.BindSurfaceToClusterInstance(Tok, ClusterIdx);
    SyncOutlinerEntryMetadata(Tok, Subtitle, "geom:studio", WorldTranslation);
    ManagedCategoryHandles.push_back(std::move(Handle));
    return ClusterIdx;
}

InstanceToken StudioLobbyHost::AppendLuminaireEntity(
    std::string_view                   Title,
    std::string_view                   Subtitle,
    std::string_view                   DomainTag,
    Axis3D                             WorldPos,
    const LuminaireInstanceParameters& Params,
    InstanceToken                      EnclosingToken)
{
#if FRONTIER_PROFILE_EDITOR
    LuminaireInstance Handle(WorldRegister, Title, Params, EnclosingToken);
#else
    (void)Title;
    LuminaireInstance Handle(WorldRegister, Params);
#endif
    const InstanceToken Tok = Handle.QueryToken();
    if (EnclosingToken.QueryValid())
    {
        (void)WorldRegister.AttachNestedSlot(EnclosingToken, Tok);
    }
    (void)WorldRegister.AssignWorldTransform(Tok, WorldPos.X, WorldPos.Y, WorldPos.Z);
    SyncOutlinerEntryMetadata(Tok, Subtitle, DomainTag, WorldPos);
    ManagedCategoryHandles.push_back(std::move(Handle));
    return Tok;
}

InstanceToken StudioLobbyHost::AppendCameraEntity(
    std::string_view                Title,
    std::string_view                Subtitle,
    Axis3D                          WorldPos,
    const CameraInstanceParameters& Params,
    InstanceToken                   EnclosingToken,
    bool                            RemovalProtected)
{
#if FRONTIER_PROFILE_EDITOR
    CameraInstance Handle(WorldRegister, Title, Params, EnclosingToken);
#else
    (void)Title;
    CameraInstance Handle(WorldRegister, Params);
#endif
    const InstanceToken Tok = Handle.QueryToken();
    if (EnclosingToken.QueryValid())
    {
        (void)WorldRegister.AttachNestedSlot(EnclosingToken, Tok);
    }
    (void)WorldRegister.AssignWorldTransform(Tok, WorldPos.X, WorldPos.Y, WorldPos.Z);
    SyncOutlinerEntryMetadata(Tok, Subtitle, "camera:perspective", WorldPos, {}, 1.0f, RemovalProtected);
    ManagedCategoryHandles.push_back(std::move(Handle));
    return Tok;
}

void StudioLobbyHost::AppendParticleEmitter(
    std::string_view NodeId,
    std::string_view OutlinerTitle,
    std::string_view Subtitle,
    std::string_view TemplateId,
    Axis3D           WorldOriginZUp,
    uint32_t         ParticleCount,
    float            ReleaseRate,
    InstanceToken    EnclosingToken)
{
    ParticleInstanceParameters Params {};
    Params.ParticleDocumentHash64 = HashString64(TemplateId);
    Params.MaximumParticleCount   = ParticleCount;
    Params.ReleaseRatePerSecond   = ReleaseRate;
    Params.SimulationActive       = true;

#if FRONTIER_PROFILE_EDITOR
    ParticleInstance Handle(WorldRegister, OutlinerTitle, Params, EnclosingToken);
#else
    (void)OutlinerTitle;
    ParticleInstance Handle(WorldRegister, Params);
#endif
    const InstanceToken Tok = Handle.QueryToken();
    if (EnclosingToken.QueryValid())
    {
        (void)WorldRegister.AttachNestedSlot(EnclosingToken, Tok);
    }
    (void)WorldRegister.AssignWorldTransform(Tok, WorldOriginZUp.X, WorldOriginZUp.Y, WorldOriginZUp.Z);
    SyncOutlinerEntryMetadata(Tok, Subtitle, "env:particle", WorldOriginZUp);
    ManagedCategoryHandles.push_back(std::move(Handle));

    if (ActivePolicy.EnableEngineParticles && ParticleCatalogReady)
    {
        if (auto CloudOpt = ParticleTemplates.ConstructParticleCloud(ParticleSpecs, TemplateId, NodeId))
        {
            CloudOpt->Evaluated.Count = std::max(16u, std::min(ParticleCount, 1024u));
            // Position origin in ParticleSpace Y-up convention so converted { X, -Z, Y } lands at WorldOriginZUp
            CloudOpt->Evaluated.Position = { WorldOriginZUp.X, WorldOriginZUp.Z, -WorldOriginZUp.Y };
            ParticleClouds.push_back(std::move(*CloudOpt));
        }
    }
}

void StudioLobbyHost::FinalizeWorldSceneAcceleration()
{
    std::vector<SpatialAcceleration::RayTrianglePrimitive> WorldPrims;
    std::vector<SpatialAcceleration::TriangleSmoothNormals> WorldNormals;

    for (const auto& Inst : WorldScene.ClusterInstances)
    {
        const auto* Pyr = Inst.PyramidAsset;
        if (Pyr == nullptr)
        {
            continue;
        }
        for (const auto& Cluster : Pyr->Clusters)
        {
            if (Cluster.HierarchyLevel != 0u)
            {
                continue;
            }
            for (uint32_t T = 0u; T < Cluster.TriangleCount; ++T)
            {
                const auto& Tri = Pyr->Triangles[Cluster.TriangleStartOffset + T];
                const Axis3D P0 = Inst.WorldTranslation + Pyr->Positions[Tri.VertexIndex0] * Inst.UniformScale;
                const Axis3D P1 = Inst.WorldTranslation + Pyr->Positions[Tri.VertexIndex1] * Inst.UniformScale;
                const Axis3D P2 = Inst.WorldTranslation + Pyr->Positions[Tri.VertexIndex2] * Inst.UniformScale;
                const Axis3D CrossN = EvaluateCross(P1 - P0, P2 - P0);
                if (EvaluateLengthSquared(CrossN) <= 1.0e-12f)
                {
                    continue;
                }
                const Axis3D FlatN = SafeNorm(CrossN, { 0.0f, 0.0f, 1.0f });
                SpatialAcceleration::RayTrianglePrimitive Prim {};
                Prim.Corner0          = P0;
                Prim.Edge01           = P1 - P0;
                Prim.Edge02           = P2 - P0;
                Prim.PrimitiveOrdinal = static_cast<uint32_t>(WorldPrims.size());
                Prim.MaterialOrdinal  = (Tri.MaterialOrdinal != 0u) ? Tri.MaterialOrdinal : Inst.MaterialSlot;
                Prim.OpaqueMask       = 1u;
                WorldPrims.push_back(Prim);

                SpatialAcceleration::TriangleSmoothNormals SN {};
                SN.Normal0 = (Tri.PackedNormal0 != 0u) ? SafeNorm(SpatialAcceleration::UnpackClusterOctahedralUnitVector(Tri.PackedNormal0), FlatN) : FlatN;
                SN.Normal1 = (Tri.PackedNormal1 != 0u) ? SafeNorm(SpatialAcceleration::UnpackClusterOctahedralUnitVector(Tri.PackedNormal1), FlatN) : FlatN;
                SN.Normal2 = (Tri.PackedNormal2 != 0u) ? SafeNorm(SpatialAcceleration::UnpackClusterOctahedralUnitVector(Tri.PackedNormal2), FlatN) : FlatN;
                WorldNormals.push_back(SN);
            }
        }
    }

    (void)WorldScene.SceneTree.BuildFromTrianglePrimitivesWithNormals(WorldPrims, WorldNormals);
    WorldScene.CompressedSceneTree.Reset();
    (void)WorldScene.CompressedSceneTree.BuildFromPrimitives(WorldPrims, WorldNormals);
}

//------------------------------------------------------------------------------------------------------------------------
//                                      LOBBY 1 · STUDIO LOBBY · CYCLORAMA
//------------------------------------------------------------------------------------------------------------------------

void StudioLobbyHost::BuildLobby1Cyclorama(const StudioLobbyPolicy& Policy)
{
    const Axis3D HeroAimHtml { 0.0f, 0.88f, -0.15f };
    const Axis3D HeroAimZUp  = ConvertHtmlPos(HeroAimHtml.X, HeroAimHtml.Y, HeroAimHtml.Z);

    // 1. Vehicles Folder (3 vehicles matching StudioLobbyRows)
    const InstanceToken VehiclesFolder = CreateFolderEntry("Vehicles", "Studio vehicle lineup · 3 vehicles", {});
    {
        const uint16_t HeroPaint = RegisterVehicleBodyPaintMaterial(WorldScene.MaterialRegister, "ObsidianGloss", SrgbHex(0x111319), 0.84f, 0.13f, 1.00f);
        const uint16_t HeroBrake = RegisterVehicleBodyPaintMaterial(WorldScene.MaterialRegister, "HeroCrimsonCaliper", SrgbHex(0xb81d24), 0.35f, 0.20f, 0.85f);
        auto MeshHero = BuildAssembledControlVehicleSurface(
            ControlVehicleTemplate, MaterialPalette, HeroPaint, HeroBrake, { 0.76f, -16.0f, 0.0f, 0.0f }, "HeroCoupeCyclorama");
        (void)AppendSurfaceEntity(
            "vehicle-hero", "Hero Coupe · Cyclorama",
            "ControlledIntegrator · Center hero vehicle under overhead softbox",
            std::move(MeshHero), ConvertHtmlPos(0.0f, 0.026f, -0.15f), HeroPaint, VehiclesFolder, true);

        const uint16_t Gt3Paint = RegisterVehicleBodyPaintMaterial(WorldScene.MaterialRegister, "AlpineGT3White", SrgbHex(0xeceff3), 0.18f, 0.16f, 0.98f);
        auto MeshGt3 = BuildAssembledControlVehicleSurface(
            ControlVehicleTemplate, MaterialPalette, Gt3Paint, HeroBrake, { 0.74f, -24.0f, 0.0f, 0.0f }, "AlpineGTOuterLeft");
        (void)AppendSurfaceEntity(
            "vehicle-gt3", "Alpine GT · Outer Left Bay",
            "ControlledIntegrator · Parked outside cyclorama on outer tiled floor",
            std::move(MeshGt3), ConvertHtmlPos(-12.2f, 0.0f, 4.8f), Gt3Paint, VehiclesFolder, true);

        const uint16_t TourerPaint = RegisterVehicleBodyPaintMaterial(WorldScene.MaterialRegister, "LiquidTitanium", SrgbHex(0x9ca5b4), 0.92f, 0.18f, 0.96f);
        const uint16_t GoldBrake   = RegisterVehicleBodyPaintMaterial(WorldScene.MaterialRegister, "GoldCaliper", SrgbHex(0xd49b24), 0.55f, 0.22f, 0.88f);
        auto MeshTourer = BuildAssembledControlVehicleSurface(
            ControlVehicleTemplate, MaterialPalette, TourerPaint, GoldBrake, { 0.74f, -156.0f, 0.0f, 0.0f }, "LiquidTourerOuterRight");
        (void)AppendSurfaceEntity(
            "vehicle-tourer", "Liquid Tourer · Outer Right Bay",
            "ControlledIntegrator · Parked outside cyclorama on outer tiled floor",
            std::move(MeshTourer), ConvertHtmlPos(12.2f, 0.0f, 4.8f), TourerPaint, VehiclesFolder, true);
        VehicleCount = 3u;
    }

    // 2. Studio Architecture Folder
    const InstanceToken ArchFolder = CreateFolderEntry("Studio Architecture", "Cyclorama cove, glossy tiled floor, ceiling truss", {});
    {
        CycloramaParams CycP { 18.0f, 13.5f, 7.0f, 2.2f, true };
        (void)AppendSurfaceEntity(
            "studio-cyclorama", "Cyclorama Infinity Cove",
            "Procedural studio.cyclorama · seamless matte cove",
            BuildCycloramaSurface(CycP, MaterialPalette), ConvertHtmlPos(0.0f, 0.0f, -0.8f),
            MaterialPalette.Resolve(StudioMaterialCode::Cyclorama), ArchFolder, true);

        TiledFloorParams FloorP { 48.0f, 40.0f, 1.5f, true };
        (void)AppendSurfaceEntity(
            "studio-floor", "Glossy Tiled Studio Floor",
            "Procedural studio.tiled_floor · dark reflective slate tiles",
            BuildTiledFloorSurface(FloorP, MaterialPalette), ConvertHtmlPos(0.0f, 0.0f, 0.0f),
            MaterialPalette.Resolve(StudioMaterialCode::TiledFloor), ArchFolder, false);

        CeilingTrussParams CeilP { 34.0f, 28.0f, 7.25f, 16u, true };
        (void)AppendSurfaceEntity(
            "studio-ceiling", "Ribbed Ceiling & Truss",
            "Procedural studio.ceiling_truss · overhead grid & steel ribs",
            BuildCeilingTrussSurface(CeilP, MaterialPalette), ConvertHtmlPos(0.0f, 0.0f, -0.5f),
            MaterialPalette.Resolve(StudioMaterialCode::CeilingRib), ArchFolder, false);
    }

    // 3. Lighting Rigs Folder (5 physical stands/modifiers + 3 Area + 2 IES luminaires)
    const InstanceToken LightingFolder = CreateFolderEntry("Lighting Rigs", "Hierarchical procedural stands, modifiers & native lights", {});
    if (Policy.EnableStudioLightingRigs)
    {
        // 3a. Overhead Softbox Bank -> Rect Area Light
        {
            LightFixtureParams SbP { "Overhead Softbox", 7.2f, 4.0f, 0.30f, 0.0f, 28.0f, 16u, 2.88f };
            const Axis3D SbPos = ConvertHtmlPos(0.0f, 4.22f, -0.25f);
            (void)AppendSurfaceEntity(
                "rig-softbox-fixture", "Overhead Softbox Bank",
                "Procedural studio.light_fixture · suspended silk overhead softbox",
                BuildLightFixtureSurface(SbP, MaterialPalette), SbPos,
                MaterialPalette.Resolve(StudioMaterialCode::DarkMetal), LightingFolder, false);
            const InstanceToken SbParentTok = ManagedCategoryHandles.back().QueryToken();

            // Place area quad emitter slightly below diffuser plane (Z = 3.98) pointing down at Hero
            const Axis3D LightPos = ConvertHtmlPos(0.0f, 3.98f, -0.25f);
            WorldScene.AreaLights.push_back(MakeAimedAreaQuad(
                LightPos, ConvertHtmlPos(0.0f, 0.4f, -0.25f), 7.2f, 4.0f, { 0.95f, 1.00f, 1.08f }, false));

            LuminaireInstanceParameters Lp { 2u, 0.95f, 1.00f, 1.08f, 22.0f, 125.0f, true };
            (void)AppendLuminaireEntity("Overhead Softbox Area Light", "Rect Area Light · 7.2 x 4.0 m suspended silk diffuser", "light:area", LightPos, Lp, SbParentTok);
        }

        // 3b. Key Fresnel Tripod -> Barn-Door Fresnel -> Key Fresnel IES Light
        {
            const Axis3D KeyTripodHtml { -3.65f, 0.0f, 1.55f };
            TripodParams Tp { 1.58f, 0.34f, 27.0f, 0.017f, 3u, 0.0f, true, true, false, true };
            const float MountH = ComputeTripodMountHeight(Tp);
            const HtmlAimAngles Aim = ComputeHtmlAim({ KeyTripodHtml.X, MountH, KeyTripodHtml.Z }, HeroAimHtml);
            Tp.HeadTiltDeg = Aim.PitchDeg;

            const Axis3D TripodPos = ConvertHtmlPos(KeyTripodHtml.X, KeyTripodHtml.Y, KeyTripodHtml.Z);
            (void)AppendSurfaceEntity(
                "rig-key-tripod", "Key Fresnel Tripod",
                "Shared procedural studio.tripod · wheeled studio light stand",
                BuildTripodSurface(Tp, MaterialPalette, { 1.0f, Aim.YawDeg, 0.0f, 0.0f }),
                TripodPos, MaterialPalette.Resolve(StudioMaterialCode::DarkMetal), LightingFolder, true);
            const InstanceToken TripodTok = ManagedCategoryHandles.back().QueryToken();

            LightFixtureParams FixP { "Barn-Door Fresnel", 0.48f, 0.48f, 0.42f, Aim.PitchDeg, 34.0f, 12u, 0.0f };
            const Axis3D FixPos = ConvertHtmlPos(KeyTripodHtml.X, MountH, KeyTripodHtml.Z);
            (void)AppendSurfaceEntity(
                "rig-key-fixture", "Barn-Door Fresnel Fixture",
                "Procedural studio.light_fixture · articulated 4-leaf barn doors",
                BuildLightFixtureSurface(FixP, MaterialPalette, { 1.0f, Aim.YawDeg, 0.0f, 0.0f }),
                FixPos, MaterialPalette.Resolve(StudioMaterialCode::DarkMetal), TripodTok, false);
            const InstanceToken FixTok = ManagedCategoryHandles.back().QueryToken();

            // Place IES emitter slightly forward along Aim vector (clear of Fresnel lens)
            const Axis3D AimDir   = SafeNorm(HeroAimZUp - FixPos);
            const Axis3D LampPos  = FixPos + Axis3D{ 0.0f, 0.0f, 0.28f } + AimDir * 0.34f;
            WorldScene.PhotometricRadiators.push_back(MakeAimedPhotometricSpot(
                LampPos, HeroAimZUp, { 16.5f, 15.2f, 13.4f }, 22.0f, 2u));

            LuminaireInstanceParameters Lp { 3u, 16.5f, 15.2f, 13.4f, 22.0f, 46.0f, true };
            (void)AppendLuminaireEntity("Key Fresnel IES Light", "IES Photometric · 5400 K Fresnel lobe aimed at Hero Coupe", "light:ies", LampPos, Lp, FixTok);
        }

        // 3c. Umbrella Fill Tripod -> Parabolic Umbrella -> Umbrella Bounce Area Light
        {
            const Axis3D UmbTripodHtml { 3.45f, 0.0f, 1.85f };
            TripodParams Tp { 1.56f, 0.32f, 28.0f, 0.016f, 3u, 0.0f, true, false, false, true };
            const float MountH = ComputeTripodMountHeight(Tp);
            const HtmlAimAngles Aim = ComputeHtmlAim({ UmbTripodHtml.X, MountH, UmbTripodHtml.Z }, HeroAimHtml);
            Tp.HeadTiltDeg = Aim.PitchDeg;

            const Axis3D TripodPos = ConvertHtmlPos(UmbTripodHtml.X, UmbTripodHtml.Y, UmbTripodHtml.Z);
            (void)AppendSurfaceEntity(
                "rig-umbrella-tripod", "Umbrella Fill Tripod",
                "Shared procedural studio.tripod · silver umbrella stand",
                BuildTripodSurface(Tp, MaterialPalette, { 1.0f, Aim.YawDeg, 0.0f, 0.0f }),
                TripodPos, MaterialPalette.Resolve(StudioMaterialCode::DarkMetal), LightingFolder, true);
            const InstanceToken TripodTok = ManagedCategoryHandles.back().QueryToken();

            LightFixtureParams FixP { "Parabolic Umbrella", 1.48f, 1.48f, 0.48f, Aim.PitchDeg, 25.0f, 16u, 0.0f };
            const Axis3D FixPos = ConvertHtmlPos(UmbTripodHtml.X, MountH, UmbTripodHtml.Z);
            (void)AppendSurfaceEntity(
                "rig-umbrella-fixture", "Parabolic Umbrella Modifier",
                "Procedural studio.light_fixture · 16-rib silver bounce umbrella",
                BuildLightFixtureSurface(FixP, MaterialPalette, { 1.0f, Aim.YawDeg, 0.0f, 0.0f }),
                FixPos, MaterialPalette.Resolve(StudioMaterialCode::UmbrellaSilver), TripodTok, false);
            const InstanceToken FixTok = ManagedCategoryHandles.back().QueryToken();

            const Axis3D AimDir  = SafeNorm(HeroAimZUp - FixPos);
            const Axis3D LampPos = FixPos + Axis3D{ 0.0f, 0.0f, 0.24f } + AimDir * 0.28f;
            WorldScene.AreaLights.push_back(MakeAimedAreaQuad(
                LampPos, HeroAimZUp, 1.55f, 1.55f, { 1.45f, 1.55f, 1.72f }, false));

            LuminaireInstanceParameters Lp { 2u, 1.45f, 1.55f, 1.72f, 18.0f, 135.0f, true };
            (void)AppendLuminaireEntity("Umbrella Bounce Area Light", "Rect Area Light · soft 5800 K silver parabolic bounce fill", "light:area", LampPos, Lp, FixTok);
        }

        // 3d. Back-Left Rim Tripod -> Studio LED Panel -> Rim LED Area Light
        {
            const Axis3D RimTripodHtml { -4.35f, 0.0f, -2.65f };
            TripodParams Tp { 1.72f, 0.38f, 26.0f, 0.017f, 3u, 0.0f, true, true, false, true };
            const float MountH = ComputeTripodMountHeight(Tp);
            const HtmlAimAngles Aim = ComputeHtmlAim({ RimTripodHtml.X, MountH, RimTripodHtml.Z }, HeroAimHtml);
            Tp.HeadTiltDeg = Aim.PitchDeg;

            const Axis3D TripodPos = ConvertHtmlPos(RimTripodHtml.X, RimTripodHtml.Y, RimTripodHtml.Z);
            (void)AppendSurfaceEntity(
                "rig-rim-tripod", "Back-Left Rim Tripod",
                "Shared procedural studio.tripod · wheeled rim stand",
                BuildTripodSurface(Tp, MaterialPalette, { 1.0f, Aim.YawDeg, 0.0f, 0.0f }),
                TripodPos, MaterialPalette.Resolve(StudioMaterialCode::DarkMetal), LightingFolder, true);
            const InstanceToken TripodTok = ManagedCategoryHandles.back().QueryToken();

            LightFixtureParams FixP { "Studio LED Panel", 1.15f, 0.68f, 0.14f, Aim.PitchDeg, 24.0f, 12u, 0.0f };
            const Axis3D FixPos = ConvertHtmlPos(RimTripodHtml.X, MountH, RimTripodHtml.Z);
            (void)AppendSurfaceEntity(
                "rig-rim-fixture", "Rim LED Panel Fixture",
                "Procedural studio.light_fixture · cool edge-separation LED",
                BuildLightFixtureSurface(FixP, MaterialPalette, { 1.0f, Aim.YawDeg, 0.0f, 0.0f }),
                FixPos, MaterialPalette.Resolve(StudioMaterialCode::DarkMetal), TripodTok, false);
            const InstanceToken FixTok = ManagedCategoryHandles.back().QueryToken();

            const Axis3D AimDir  = SafeNorm(HeroAimZUp - FixPos);
            const Axis3D LampPos = FixPos + Axis3D{ 0.0f, 0.0f, 0.34f } + AimDir * 0.22f;
            WorldScene.AreaLights.push_back(MakeAimedAreaQuad(
                LampPos, HeroAimZUp, 1.15f, 0.68f, { 2.50f, 2.85f, 3.45f }, false));

            LuminaireInstanceParameters Lp { 2u, 2.50f, 2.85f, 3.45f, 18.0f, 110.0f, true };
            (void)AppendLuminaireEntity("Rim LED Area Light", "Rect Area Light · cool 6300 K contour rim separation", "light:area", LampPos, Lp, FixTok);
        }

        // 3e. Back-Right Accent Tripod -> Octa Softbox Strobe -> Accent Strobe IES Light
        {
            const Axis3D AccTripodHtml { 4.55f, 0.0f, -2.40f };
            TripodParams Tp { 1.66f, 0.36f, 26.0f, 0.016f, 3u, 0.0f, true, true, false, true };
            const float MountH = ComputeTripodMountHeight(Tp);
            const HtmlAimAngles Aim = ComputeHtmlAim({ AccTripodHtml.X, MountH, AccTripodHtml.Z }, HeroAimHtml);
            Tp.HeadTiltDeg = Aim.PitchDeg;

            const Axis3D TripodPos = ConvertHtmlPos(AccTripodHtml.X, AccTripodHtml.Y, AccTripodHtml.Z);
            (void)AppendSurfaceEntity(
                "rig-accent-tripod", "Back-Right Accent Tripod",
                "Shared procedural studio.tripod · wheeled accent strobe stand",
                BuildTripodSurface(Tp, MaterialPalette, { 1.0f, Aim.YawDeg, 0.0f, 0.0f }),
                TripodPos, MaterialPalette.Resolve(StudioMaterialCode::DarkMetal), LightingFolder, true);
            const InstanceToken TripodTok = ManagedCategoryHandles.back().QueryToken();

            LightFixtureParams FixP { "Octa Softbox", 0.96f, 0.96f, 0.42f, Aim.PitchDeg, 25.0f, 8u, 0.0f };
            const Axis3D FixPos = ConvertHtmlPos(AccTripodHtml.X, MountH, AccTripodHtml.Z);
            (void)AppendSurfaceEntity(
                "rig-accent-fixture", "Octa Softbox Strobe",
                "Procedural studio.light_fixture · 8-sided studio octa modifier",
                BuildLightFixtureSurface(FixP, MaterialPalette, { 1.0f, Aim.YawDeg, 0.0f, 0.0f }),
                FixPos, MaterialPalette.Resolve(StudioMaterialCode::DarkMetal), TripodTok, false);
            const InstanceToken FixTok = ManagedCategoryHandles.back().QueryToken();

            const Axis3D AimDir  = SafeNorm(HeroAimZUp - FixPos);
            const Axis3D LampPos = FixPos + Axis3D{ 0.0f, 0.0f, 0.22f } + AimDir * 0.32f;
            WorldScene.PhotometricRadiators.push_back(MakeAimedPhotometricSpot(
                LampPos, HeroAimZUp, { 12.5f, 13.0f, 14.5f }, 22.0f, 2u));

            LuminaireInstanceParameters Lp { 3u, 12.5f, 13.0f, 14.5f, 22.0f, 42.0f, true };
            (void)AppendLuminaireEntity("Accent Strobe IES Light", "IES Photometric · focused 5600 K cyclorama rim strobe", "light:ies", LampPos, Lp, FixTok);
        }
    }

    // 4. Camera Rigs Folder (Editor Camera + 2 procedural cinema tripod camera rigs + 6 presets)
    const InstanceToken CameraFolder = CreateFolderEntry("Camera Rigs", "Editor camera & mounted studio cinema camera rigs", {});
    {
        CameraInstanceParameters EdCamP { 35.0f, 36.0f, 0.10f, 2500.0f, true };
        (void)AppendCameraEntity("Editor Camera", "Permanent editor navigation camera · Orbit/Pan/Zoom", ConvertHtmlPos(5.75f, 1.62f, 6.45f), EdCamP, CameraFolder, true);

        if (Policy.EnableCameraRigs)
        {
            // Cinema Tripod A
            const Axis3D CamATripodHtml { -3.25f, 0.0f, 5.75f };
            TripodParams TpA { 1.38f, 0.20f, 24.0f, 0.020f, 3u, 0.0f, true, false, true, true };
            const float MountHA = ComputeTripodMountHeight(TpA);
            const HtmlAimAngles AimA = ComputeHtmlAim({ CamATripodHtml.X, MountHA, CamATripodHtml.Z }, HeroAimHtml);
            TpA.HeadTiltDeg = AimA.PitchDeg;

            (void)AppendSurfaceEntity(
                "rig-cam-a-tripod", "Cinema Tripod A",
                "Shared procedural studio.tripod · heavy matte tripod + floor mat",
                BuildTripodSurface(TpA, MaterialPalette, { 1.0f, AimA.YawDeg, 0.0f, 0.0f }),
                ConvertHtmlPos(CamATripodHtml.X, CamATripodHtml.Y, CamATripodHtml.Z),
                MaterialPalette.Resolve(StudioMaterialCode::DarkMetal), CameraFolder, true);
            const InstanceToken TripodATok = ManagedCategoryHandles.back().QueryToken();

            CinemaCameraParams CamAP { "Cinema Matte Box", 0.34f, 0.13f, true, true, AimA.PitchDeg };
            const Axis3D CamABodyPos = ConvertHtmlPos(CamATripodHtml.X, MountHA, CamATripodHtml.Z);
            (void)AppendSurfaceEntity(
                "rig-cam-a-body", "Cinema Camera A",
                "Procedural studio.cinema_camera · twin-magazine cine camera",
                BuildCinemaCameraSurface(CamAP, MaterialPalette, { 1.0f, AimA.YawDeg, 0.0f, 0.0f }),
                CamABodyPos, MaterialPalette.Resolve(StudioMaterialCode::DarkMetal), TripodATok, true);
            const InstanceToken BodyATok = ManagedCategoryHandles.back().QueryToken();

            CameraInstanceParameters ConfCamP { 36.0f, 36.0f, 0.10f, 2000.0f, false };
            (void)AppendCameraEntity("Car Configurator Camera", "Configurator camera · 6 automotive studio presets", CamABodyPos, ConfCamP, BodyATok);

            // Cinema Tripod B
            const Axis3D CamBTripodHtml { 2.55f, 0.0f, 5.65f };
            TripodParams TpB { 1.24f, 0.18f, 25.0f, 0.018f, 3u, 0.0f, true, false, true, true };
            const float MountHB = ComputeTripodMountHeight(TpB);
            const HtmlAimAngles AimB = ComputeHtmlAim({ CamBTripodHtml.X, MountHB, CamBTripodHtml.Z }, HeroAimHtml);
            TpB.HeadTiltDeg = AimB.PitchDeg;

            (void)AppendSurfaceEntity(
                "rig-cam-b-tripod", "Cinema Tripod B",
                "Shared procedural studio.tripod · foreground tether camera tripod",
                BuildTripodSurface(TpB, MaterialPalette, { 1.0f, AimB.YawDeg, 0.0f, 0.0f }),
                ConvertHtmlPos(CamBTripodHtml.X, CamBTripodHtml.Y, CamBTripodHtml.Z),
                MaterialPalette.Resolve(StudioMaterialCode::DarkMetal), CameraFolder, true);
            const InstanceToken TripodBTok = ManagedCategoryHandles.back().QueryToken();

            CinemaCameraParams CamBP { "Medium Format Tether", 0.24f, 0.08f, true, true, AimB.PitchDeg };
            const Axis3D CamBBodyPos = ConvertHtmlPos(CamBTripodHtml.X, MountHB, CamBTripodHtml.Z);
            (void)AppendSurfaceEntity(
                "rig-cam-b-body", "Medium Format Camera B",
                "Procedural studio.cinema_camera · medium format studio camera",
                BuildCinemaCameraSurface(CamBP, MaterialPalette, { 1.0f, AimB.YawDeg, 0.0f, 0.0f }),
                CamBBodyPos, MaterialPalette.Resolve(StudioMaterialCode::DarkMetal), TripodBTok, true);
            const InstanceToken BodyBTok = ManagedCategoryHandles.back().QueryToken();

            CameraInstanceParameters ProfCamP { 65.0f, 36.0f, 0.10f, 2000.0f, false };
            (void)AppendCameraEntity("Profile 65mm Camera", "Side elevation 65 mm optical study camera", CamBBodyPos, ProfCamP, BodyBTok);
        }
    }

    // 5. Studio Props & Crew Folder
    const InstanceToken PropsFolder = CreateFolderEntry("Studio Props & Crew", "Tether workstation, Pelican flight cases, cable runs & mats", {});
    if (Policy.EnableCrewProps)
    {
        WorkstationParams WsP { 1.48f, 0.72f, 0.78f, true, true, true };
        (void)AppendSurfaceEntity(
            "prop-workstation", "Tether Workstation & Desk",
            "Procedural studio.workstation · hairpin desk, laptop & flight cases",
            BuildWorkstationSurface(WsP, MaterialPalette, { 1.0f, -28.0f, 0.0f, 0.0f }),
            ConvertHtmlPos(5.9f, 0.0f, 6.45f), MaterialPalette.Resolve(StudioMaterialCode::DarkMetal), PropsFolder, true);

        WorkstationParams GripP { 1.0f, 0.55f, 0.65f, false, true, true };
        (void)AppendSurfaceEntity(
            "prop-grip-cases", "Grip Cases & Floor Mats",
            "Procedural studio.workstation · stage-left Pelican cases & cables",
            BuildWorkstationSurface(GripP, MaterialPalette, { 1.0f, 24.0f, 0.0f, 0.0f }),
            ConvertHtmlPos(-6.4f, 0.0f, 6.25f), MaterialPalette.Resolve(StudioMaterialCode::PelicanCase), PropsFolder, true);
    }

    // 6. World Atmosphere / Interior Darkroom Ambient
    const InstanceToken WorldFolder = CreateFolderEntry("World", "Interior studio ambient & tone balance", {});
    {
        AtmosphereInstanceParameters AtmoP { 8000.0f, 1200.0f, 1.0f, 120.0f, false };
#if FRONTIER_PROFILE_EDITOR
        AtmosphereInstance Atmo(WorldRegister, "Studio Ambient", AtmoP, WorldFolder);
#else
        AtmosphereInstance Atmo(WorldRegister, AtmoP);
#endif
        const InstanceToken Tok = Atmo.QueryToken();
        if (WorldFolder.QueryValid())
        {
            (void)WorldRegister.AttachNestedSlot(WorldFolder, Tok);
        }
        SyncOutlinerEntryMetadata(Tok, "Interior darkroom exposure, bounce fill & floor reflection strength", "env:atmosphere", {});
        ManagedCategoryHandles.push_back(std::move(Atmo));

        WorldScene.Atmosphere.Medium.AtmosphereEnabled = false;
        WorldScene.Atmosphere.Solar.SolarEnabled       = false;
        WorldScene.Atmosphere.Clouds.CloudsEnabled     = false;
        WorldScene.Sun.DirectionToSun                   = SafeNorm({ 0.25f, -0.45f, 0.85f });
        WorldScene.Sun.SolarIrradiance                  = { 0.0f, 0.0f, 0.0f };
        WorldScene.SkyRadiance                          = { 0.014f, 0.018f, 0.026f };
    }

    // Populate the 6 Configurator Camera Presets from StudioLobbyScene.js
    const auto AddPreset = [&](std::string Id, std::string Label, Axis3D HtmlEye, Axis3D HtmlTarget, float FovDeg)
    {
        PerspectiveCameraBasis Cam {};
        Cam.CameraOrigin       = ConvertHtmlPos(HtmlEye.X, HtmlEye.Y, HtmlEye.Z);
        Cam.TargetPoint        = ConvertHtmlPos(HtmlTarget.X, HtmlTarget.Y, HtmlTarget.Z);
        Cam.WorldUpAxis        = { 0.0f, 0.0f, 1.0f };
        Cam.VerticalFovRadians = FovDeg * Constants::DegToRadFloat;
        Cam.ViewportWidthPx    = 1280u;
        Cam.ViewportHeightPx   = 720u;
        Cam.NearClipMeters     = 0.10f;
        CameraPresets.push_back({ std::move(Id), std::move(Label), Cam });
    };
    AddPreset("hero-34",        "Hero 3/4",        {  5.75f, 1.62f, 6.45f }, {  0.05f, 0.78f, -0.15f }, 35.0f);
    AddPreset("low-front",      "Low Front",       {  3.85f, 0.85f, 5.15f }, { -0.10f, 0.72f,  0.00f }, 32.0f);
    AddPreset("rear-quarter",   "Rear Quarter",    { -5.45f, 1.54f, 5.45f }, {  0.15f, 0.76f, -0.25f }, 36.0f);
    AddPreset("profile-65",     "Profile 65mm",    {  0.15f, 1.22f, 8.25f }, {  0.00f, 0.78f, -0.15f }, 25.0f);
    AddPreset("overhead-crane", "Overhead Crane",  {  5.40f, 4.45f, 8.10f }, {  0.00f, 0.70f, -0.40f }, 40.0f);
    AddPreset("crew-bts",       "Crew BTS",        { -7.40f, 1.92f, 8.85f }, {  0.25f, 1.12f, -0.40f }, 42.0f);
}

//------------------------------------------------------------------------------------------------------------------------
//                                      LOBBY 2 · FOREST SOUNDSTAGE (ROCKS/PLANTS BLANK)
//------------------------------------------------------------------------------------------------------------------------

void StudioLobbyHost::BuildLobby2ForestStage(const StudioLobbyPolicy& Policy)
{
    const Axis3D HeroAimHtml { 0.0f, 1.10f, -0.35f };
    const Axis3D HeroAimZUp  = ConvertHtmlPos(HeroAimHtml.X, HeroAimHtml.Y, HeroAimHtml.Z);

    // 1. Vehicles Folder (4 cars; hero centered cleanly on stage since rocks/moss/wood/plants remain intentionally blank)
    const InstanceToken VehiclesFolder = CreateFolderEntry("Vehicles", "Forest Soundstage lineup · 4 cars (rocks & botanical props left blank)", {});
    {
        const uint16_t SagePaint    = RegisterVehicleBodyPaintMaterial(WorldScene.MaterialRegister, "ForestSage", SrgbHex(0x7ea689), 0.42f, 0.16f, 0.98f);
        const uint16_t SageBrake    = RegisterVehicleBodyPaintMaterial(WorldScene.MaterialRegister, "SageCaliper", SrgbHex(0x8c9c7a), 0.35f, 0.22f, 0.85f);
        const uint16_t ObsidianPaint= RegisterVehicleBodyPaintMaterial(WorldScene.MaterialRegister, "ObsidianGloss", SrgbHex(0x111319), 0.84f, 0.14f, 1.00f);
        const uint16_t WhitePaint   = RegisterVehicleBodyPaintMaterial(WorldScene.MaterialRegister, "AlpineWhite", SrgbHex(0xeceff3), 0.18f, 0.16f, 0.98f);
        const uint16_t SilverPaint  = RegisterVehicleBodyPaintMaterial(WorldScene.MaterialRegister, "LiquidTitanium", SrgbHex(0x9ca5b4), 0.92f, 0.18f, 0.95f);
        const uint16_t RedBrake     = RegisterVehicleBodyPaintMaterial(WorldScene.MaterialRegister, "CrimsonCaliper", SrgbHex(0xb81d24), 0.35f, 0.20f, 0.85f);

        // With rocks/plants/leaves left blank per policy, hero sits directly at ground datum Z=0.0 at [-0.35]
        auto MeshHero = BuildAssembledControlVehicleSurface(
            ControlVehicleTemplate, MaterialPalette, SagePaint, SageBrake, { 0.78f, -22.0f, 0.0f, 0.0f }, "HeroForestStage");
        (void)AppendSurfaceEntity("vehicle-hero", "Hero Vehicle · Forest Stage", "ControlledIntegrator · Forest Sage center stage",
            std::move(MeshHero), ConvertHtmlPos(0.0f, 0.0f, -0.35f), SagePaint, VehiclesFolder, true);

        auto MeshGt3 = BuildAssembledControlVehicleSurface(
            ControlVehicleTemplate, MaterialPalette, ObsidianPaint, RedBrake, { 0.74f, -24.0f, 0.0f, 0.0f }, "ObsidianOuterLeft");
        (void)AppendSurfaceEntity("vehicle-gt3", "Obsidian Coupe · Left Stage", "ControlledIntegrator · Companion coupe",
            std::move(MeshGt3), ConvertHtmlPos(-11.8f, 0.0f, 4.2f), ObsidianPaint, VehiclesFolder, true);

        auto MeshTourer = BuildAssembledControlVehicleSurface(
            ControlVehicleTemplate, MaterialPalette, WhitePaint, RedBrake, { 0.74f, -156.0f, 0.0f, 0.0f }, "AlpineOuterRight");
        (void)AppendSurfaceEntity("vehicle-tourer", "Alpine GT · Right Stage", "ControlledIntegrator · Companion coupe",
            std::move(MeshTourer), ConvertHtmlPos(11.8f, 0.0f, 4.2f), WhitePaint, VehiclesFolder, true);

        auto MeshRes = BuildAssembledControlVehicleSurface(
            ControlVehicleTemplate, MaterialPalette, SilverPaint, RedBrake, { 0.74f, -138.0f, 0.0f, 0.0f }, "LiquidReserve");
        (void)AppendSurfaceEntity("vehicle-reserve", "Liquid Tourer · Reserve Bay", "ControlledIntegrator · Reserve vehicle",
            std::move(MeshRes), ConvertHtmlPos(10.8f, 0.0f, 9.4f), SilverPaint, VehiclesFolder, true);
        VehicleCount = 4u;
    }

    // 2. Forest Soundstage Set Folder (LED Backdrop, Concrete Floor, Ceiling Truss; rocks/fallen wood/ferns/grass deliberately omitted!)
    const InstanceToken SetFolder = CreateFolderEntry("Forest Soundstage Set", "Backlit forest LED backdrop, studio floor & truss (rocks/plants left blank)", {});
    {
        ForestBackdropParams BdP { 12.4f, 6.2f, 20.5f, 7.25f, true };
        (void)AppendSurfaceEntity(
            "l2-forest-backdrop", "Forest LED Backdrop & Flags",
            "Procedural studio.forest_backdrop · backlit LED volume & V-flats",
            BuildForestBackdropSurface(BdP, MaterialPalette), ConvertHtmlPos(0.0f, 0.0f, -5.65f),
            MaterialPalette.Resolve(StudioMaterialCode::ForestBackdrop), SetFolder, true);

        TiledFloorParams FloorP { 46.0f, 40.0f, 1.8f, true };
        (void)AppendSurfaceEntity(
            "studio-floor", "Studio Concrete Floor",
            "Procedural studio.tiled_floor · matte studio concrete floor",
            BuildTiledFloorSurface(FloorP, MaterialPalette), ConvertHtmlPos(0.0f, 0.0f, 1.5f),
            MaterialPalette.Resolve(StudioMaterialCode::TiledFloor), SetFolder, false);

        CeilingTrussParams CeilP { 26.0f, 22.0f, 7.25f, 14u, true };
        (void)AppendSurfaceEntity(
            "studio-ceiling", "Ribbed Ceiling & Truss",
            "Procedural studio.ceiling_truss · overhead studio truss",
            BuildCeilingTrussSurface(CeilP, MaterialPalette), ConvertHtmlPos(0.0f, 0.0f, -0.8f),
            MaterialPalette.Resolve(StudioMaterialCode::CeilingRib), SetFolder, false);
    }

    // 3. Wind Fan & Engine ParticleSpace Dust FX
    const InstanceToken AtmosFolder = CreateFolderEntry("Wind Fan & Dust FX", "Procedural studio wind blower & Frontier::ParticleSpace dust motes", {});
    {
        const Axis3D FanHtml { -5.25f, 0.0f, 1.65f };
        const HtmlAimAngles AimFan = ComputeHtmlAim({ FanHtml.X, 1.28f, FanHtml.Z }, HeroAimHtml);
        StudioFanParams FanP { 1.28f, 0.52f, -4.0f };
        (void)AppendSurfaceEntity(
            "l2-studio-fan", "Studio Wind Fan (Blower)",
            "Procedural studio.studio_fan · wheeled wind blower aimed across stage",
            BuildStudioFanSurface(FanP, MaterialPalette, { 1.0f, AimFan.YawDeg, 0.0f, 0.0f }),
            ConvertHtmlPos(FanHtml.X, FanHtml.Y, FanHtml.Z),
            MaterialPalette.Resolve(StudioMaterialCode::FanHousing), AtmosFolder, true);

        AppendParticleEmitter(
            "l2-dust-particles", "Sunbeam Dust Particles",
            "Frontier::ParticleSpace (ground-dust) · 280 atmospheric stage dust motes",
            "ground-dust", ConvertHtmlPos(0.0f, 1.65f, -0.2f), 280u, 96.0f, AtmosFolder);
    }

    // 4. Lighting Rigs
    const InstanceToken LightFolder = CreateFolderEntry("Lighting Rigs", "Softbox, warm sun Fresnel & studio bounce rigs", {});
    if (Policy.EnableStudioLightingRigs)
    {
        LightFixtureParams SbP { "Overhead Softbox", 6.4f, 3.8f, 0.30f, 0.0f, 40.0f, 16u, 2.68f };
        (void)AppendSurfaceEntity(
            "rig-softbox-fixture", "Overhead Softbox Bank",
            "Procedural studio.light_fixture · overhead silk softbox",
            BuildLightFixtureSurface(SbP, MaterialPalette), ConvertHtmlPos(0.0f, 4.42f, -0.45f),
            MaterialPalette.Resolve(StudioMaterialCode::DarkMetal), LightFolder, false);
        const InstanceToken SbParent = ManagedCategoryHandles.back().QueryToken();
        const Axis3D SbLightPos = ConvertHtmlPos(0.0f, 4.18f, -0.45f);
        WorldScene.AreaLights.push_back(MakeAimedAreaQuad(SbLightPos, HeroAimZUp, 6.4f, 3.8f, { 5.0f, 5.2f, 5.5f }));
        (void)AppendLuminaireEntity("Overhead Softbox Area Light", "Rect Area Light · 6.4 x 3.8 m diffuser", "light:area", SbLightPos, { 2u, 5.0f, 5.2f, 5.5f, 22.0f, 125.0f, true }, SbParent);

        const Axis3D KeyPos = ConvertHtmlPos(-4.75f, 2.70f, 1.45f);
        WorldScene.PhotometricRadiators.push_back(MakeAimedPhotometricSpot(KeyPos, HeroAimZUp, { 42.0f, 31.0f, 18.5f }, 24.0f, 2u));
        (void)AppendLuminaireEntity("Key Sun Fresnel IES Light", "IES Photometric · 3450 K warm woodland sunbeam", "light:ies", KeyPos, { 3u, 42.0f, 31.0f, 18.5f, 24.0f, 54.0f, true }, LightFolder);

        const Axis3D UmbPos = ConvertHtmlPos(4.85f, 2.35f, 2.15f);
        WorldScene.AreaLights.push_back(MakeAimedAreaQuad(UmbPos, HeroAimZUp, 1.55f, 1.55f, { 3.8f, 4.2f, 4.5f }));
        (void)AppendLuminaireEntity("Umbrella Bounce Area Light", "Rect Area Light · ambient stage fill", "light:area", UmbPos, { 2u, 3.8f, 4.2f, 4.5f, 18.0f, 135.0f, true }, LightFolder);

        const Axis3D RimPos = ConvertHtmlPos(-4.95f, 2.75f, -2.55f);
        WorldScene.AreaLights.push_back(MakeAimedAreaQuad(RimPos, HeroAimZUp, 1.05f, 0.62f, { 4.2f, 4.8f, 5.8f }));
        (void)AppendLuminaireEntity("Rim LED Area Light", "Rect Area Light · canopy edge rim", "light:area", RimPos, { 2u, 4.2f, 4.8f, 5.8f, 18.0f, 110.0f, true }, LightFolder);

        const Axis3D AccPos = ConvertHtmlPos(5.05f, 2.65f, -2.25f);
        WorldScene.PhotometricRadiators.push_back(MakeAimedPhotometricSpot(AccPos, HeroAimZUp, { 36.0f, 25.0f, 15.0f }, 22.0f, 2u));
        (void)AppendLuminaireEntity("Accent Strobe IES Light", "IES Photometric · 3250 K warm sun-rim backlight", "light:ies", AccPos, { 3u, 36.0f, 25.0f, 15.0f, 22.0f, 52.0f, true }, LightFolder);
    }

    // 5. Camera Rigs & Crew Props
    const InstanceToken CamFolder = CreateFolderEntry("Camera Rigs", "Editor camera & foreground tripod rigs", {});
    (void)AppendCameraEntity("Editor Camera", "Unrestricted 3D editor navigation camera", ConvertHtmlPos(5.45f, 2.05f, 7.15f), { 35.0f, 36.0f, 0.1f, 2500.0f, true }, CamFolder, true);
    if (Policy.EnableCrewProps)
    {
        const InstanceToken PropsFolder = CreateFolderEntry("Studio Props & Crew", "Tether desk & grip cases outside soundstage", {});
        (void)AppendSurfaceEntity(
            "prop-workstation", "Tether Workstation & Desk", "Hairpin desk & calibration laptop",
            BuildWorkstationSurface({ 1.48f, 0.72f, 0.78f, true, true, true }, MaterialPalette, { 1.0f, -28.0f, 0.0f, 0.0f }),
            ConvertHtmlPos(6.4f, 0.0f, 6.85f), MaterialPalette.Resolve(StudioMaterialCode::DarkMetal), PropsFolder, true);
        (void)AppendSurfaceEntity(
            "prop-grip-cases", "Grip Cases & Cables", "Pelican flight cases & coiled power cable",
            BuildWorkstationSurface({ 1.0f, 0.55f, 0.65f, false, true, true }, MaterialPalette, { 1.0f, 22.0f, 0.0f, 0.0f }),
            ConvertHtmlPos(-6.8f, 0.0f, 6.55f), MaterialPalette.Resolve(StudioMaterialCode::PelicanCase), PropsFolder, true);
    }

    WorldScene.Atmosphere.Medium.AtmosphereEnabled = false;
    WorldScene.Atmosphere.Solar.SolarEnabled       = false;
    WorldScene.Atmosphere.Clouds.CloudsEnabled     = false;
    WorldScene.Sun.SolarIrradiance                  = { 0.0f, 0.0f, 0.0f };
    WorldScene.SkyRadiance                          = { 0.018f, 0.024f, 0.022f };

    PerspectiveCameraBasis Cam {};
    Cam.CameraOrigin       = ConvertHtmlPos(5.45f, 2.05f, 7.15f);
    Cam.TargetPoint        = HeroAimZUp;
    Cam.WorldUpAxis        = { 0.0f, 0.0f, 1.0f };
    Cam.VerticalFovRadians = 36.0f * Constants::DegToRadFloat;
    Cam.ViewportWidthPx    = 1280u;
    Cam.ViewportHeightPx   = 720u;
    Cam.NearClipMeters     = 0.10f;
    CameraPresets.push_back({ "hero-34", "Hero 3/4 · Forest Stage", Cam });
}

//------------------------------------------------------------------------------------------------------------------------
//                                      LOBBY 3 · RACING PIT GARAGE
//------------------------------------------------------------------------------------------------------------------------

void StudioLobbyHost::BuildLobby3RacingGarage(const StudioLobbyPolicy& Policy)
{
    const Axis3D HeroAimHtml { 0.35f, 0.88f, 0.35f };
    const Axis3D HeroAimZUp  = ConvertHtmlPos(HeroAimHtml.X, HeroAimHtml.Y, HeroAimHtml.Z);

    // 1. Vehicles Folder (4 cars; lift car elevated atop 4-post lift at Z = 2.12m)
    const InstanceToken VehiclesFolder = CreateFolderEntry("Vehicles", "Racing Stadium Garage lineup · 4 cars (including 1 on hydraulic lift)", {});
    const InstanceToken ArchFolder     = CreateFolderEntry("Racing Stadium & Pit Garage", "3D multi-lane track, grandstands, pit garage & hydraulic lift", {});

    const uint16_t OrangePaint  = RegisterVehicleBodyPaintMaterial(WorldScene.MaterialRegister, "SignalOrange", SrgbHex(0xe86512), 0.62f, 0.14f, 1.00f);
    const uint16_t ObsidianPaint= RegisterVehicleBodyPaintMaterial(WorldScene.MaterialRegister, "ObsidianGloss", SrgbHex(0x111319), 0.86f, 0.14f, 1.00f);
    const uint16_t WhitePaint   = RegisterVehicleBodyPaintMaterial(WorldScene.MaterialRegister, "AlpineWhite", SrgbHex(0xeceff3), 0.18f, 0.15f, 0.98f);
    const uint16_t CobaltPaint  = RegisterVehicleBodyPaintMaterial(WorldScene.MaterialRegister, "MidnightCobalt", SrgbHex(0x13294b), 0.85f, 0.16f, 1.00f);
    const uint16_t RedBrake     = RegisterVehicleBodyPaintMaterial(WorldScene.MaterialRegister, "CrimsonCaliper", SrgbHex(0xb81d24), 0.35f, 0.20f, 0.85f);

    (void)AppendSurfaceEntity(
        "vehicle-hero", "Hero GT · Pit Bay Center",
        "ControlledIntegrator · Signal Orange GT in afternoon pit-lane sunbeam",
        BuildAssembledControlVehicleSurface(ControlVehicleTemplate, MaterialPalette, OrangePaint, OrangePaint, { 0.78f, -146.0f, 0.0f, 0.0f }, "HeroSignalOrange"),
        ConvertHtmlPos(0.35f, 0.0f, 0.25f), OrangePaint, VehiclesFolder, true);

    (void)AppendSurfaceEntity(
        "vehicle-gt3", "Alpine GT · Right Pit Bay",
        "ControlledIntegrator · Paddock GT car in right bay",
        BuildAssembledControlVehicleSurface(ControlVehicleTemplate, MaterialPalette, WhitePaint, RedBrake, { 0.75f, -142.0f, 0.0f, 0.0f }, "AlpinePitRight"),
        ConvertHtmlPos(5.45f, 0.0f, 8.65f), WhitePaint, VehiclesFolder, true);

    (void)AppendSurfaceEntity(
        "vehicle-tourer", "Midnight Cobalt · Outer Paddock",
        "ControlledIntegrator · Reserve track car on left paddock apron",
        BuildAssembledControlVehicleSurface(ControlVehicleTemplate, MaterialPalette, CobaltPaint, OrangePaint, { 0.75f, -36.0f, 0.0f, 0.0f }, "CobaltPitLeft"),
        ConvertHtmlPos(-5.35f, 0.0f, 8.75f), CobaltPaint, VehiclesFolder, true);

    // 2. Racing Stadium & Pit Garage Architecture + Hydraulic Lift + Elevated Car
    (void)AppendSurfaceEntity(
        "l3-race-track", "3D Racing Track & Stadium",
        "Procedural studio.race_track · 3-lane FIA circuit, pit wall, gantry & 14-tier grandstands",
        BuildRaceTrackSurface({ 150.0f, 3u, true, true }, MaterialPalette), ConvertHtmlPos(0.0f, 0.0f, 0.0f),
        MaterialPalette.Resolve(StudioMaterialCode::TrackAsphalt), ArchFolder, true);

    (void)AppendSurfaceEntity(
        "l3-garage-shell", "Pit Garage, Cages & Mezzanine",
        "Procedural studio.garage_shell · pit archway, security bars, mezzanine & linear LEDs",
        BuildGarageShellSurface({ 22.0f, 18.0f, 7.15f, true, true }, MaterialPalette), ConvertHtmlPos(0.0f, 0.0f, 0.0f),
        MaterialPalette.Resolve(StudioMaterialCode::ConcreteGarage), ArchFolder, true);

    (void)AppendSurfaceEntity(
        "l3-car-lift", "Hydraulic 4-Post Car Lift",
        "Procedural studio.car_lift · 4-post lift supporting elevated track coupe at Z = 2.12m",
        BuildCarLiftSurface({ 2.12f, 3.85f }, MaterialPalette, { 1.0f, 90.0f, 0.0f, 0.0f }),
        ConvertHtmlPos(-5.55f, 0.0f, -1.55f), MaterialPalette.Resolve(StudioMaterialCode::SafetyYellow), ArchFolder, true);
    const InstanceToken LiftTok = ManagedCategoryHandles.back().QueryToken();

    (void)AppendSurfaceEntity(
        "vehicle-lift", "Track Coupe · On Hydraulic Lift",
        "ControlledIntegrator · Elevated race car mounted on hydraulic lift deck",
        BuildAssembledControlVehicleSurface(ControlVehicleTemplate, MaterialPalette, ObsidianPaint, RedBrake, { 0.74f, 90.0f, 0.0f, 0.0f }, "ElevatedLiftCoupe"),
        ConvertHtmlPos(-5.55f, 2.12f, -1.55f), ObsidianPaint, LiftTok, true);
    VehicleCount = 4u;

    (void)AppendSurfaceEntity(
        "studio-floor", "Polished Concrete Pit Floor",
        "Procedural studio.tiled_floor · motorsport garage concrete floor",
        BuildTiledFloorSurface({ 44.0f, 24.8f, 2.2f, true }, MaterialPalette), ConvertHtmlPos(0.0f, 0.0f, 6.2f),
        MaterialPalette.Resolve(StudioMaterialCode::ConcreteGarage), ArchFolder, false);

    // 3. Mechanics Equipment & Engine ParticleSpace Smoke/Dust
    const InstanceToken PropsFolder = CreateFolderEntry("Mechanics Equipment & Smoke", "Toolboxes, workbench, air compressor, tire rack, cables & smoke FX", {});
    if (Policy.EnableCrewProps)
    {
        (void)AppendSurfaceEntity("l3-tool-chest", "Double-Bank Cherry-Red Tool Chest", "10-drawer rolling tool chest + impact gun",
            BuildGaragePropsSurface({ "tool-chest" }, MaterialPalette, { 1.0f, -85.0f, 0.0f, 0.0f }),
            ConvertHtmlPos(7.10f, 0.0f, -2.40f), MaterialPalette.Resolve(StudioMaterialCode::CherryRedTool), PropsFolder, true);
        (void)AppendSurfaceEntity("l3-tool-cart", "Rolling Cherry-Red Tool Cart", "Service trolley with toolboxes & slicks",
            BuildGaragePropsSurface({ "tool-cart" }, MaterialPalette, { 1.0f, -32.0f, 0.0f, 0.0f }),
            ConvertHtmlPos(5.35f, 0.0f, 2.20f), MaterialPalette.Resolve(StudioMaterialCode::CherryRedTool), PropsFolder, true);
        (void)AppendSurfaceEntity("l3-workbench", "Mechanic's Workbench & Pegboard", "Butcher-block bench, vise, wrenches & drums",
            BuildGaragePropsSurface({ "workbench" }, MaterialPalette, { 1.0f, -90.0f, 0.0f, 0.0f }),
            ConvertHtmlPos(9.75f, 0.0f, -0.35f), MaterialPalette.Resolve(StudioMaterialCode::TimberBench), PropsFolder, true);
        (void)AppendSurfaceEntity("l3-air-compressor", "Air Compressor & Welding Cart", "80-gallon vertical compressor & gas bottles",
            BuildGaragePropsSurface({ "air-compressor" }, MaterialPalette, { 1.0f, 90.0f, 0.0f, 0.0f }),
            ConvertHtmlPos(-9.65f, 0.0f, 3.85f), MaterialPalette.Resolve(StudioMaterialCode::CherryRedTool), PropsFolder, true);
        (void)AppendSurfaceEntity("l3-tire-rack", "Racing Slick Tire Rack & Jack", "2-tier slick rack, trolley jack & stands",
            BuildGaragePropsSurface({ "tire-rack" }, MaterialPalette, { 1.0f, 0.0f, 0.0f, 0.0f }),
            ConvertHtmlPos(4.05f, 0.0f, -4.55f), MaterialPalette.Resolve(StudioMaterialCode::SafetyYellow), PropsFolder, true);
        (void)AppendSurfaceEntity("l3-diag-cabinet", "Diagnostic Telemetry Cabinet", "Rolling pit telemetry chest",
            BuildGaragePropsSurface({ "diag-cabinet" }, MaterialPalette, { 1.0f, 18.0f, 0.0f, 0.0f }),
            ConvertHtmlPos(-1.55f, 0.0f, -4.65f), MaterialPalette.Resolve(StudioMaterialCode::CherryRedTool), PropsFolder, true);
        (void)AppendSurfaceEntity("l3-garage-cables", "Floor Air Hoses & Cable Ramp", "Pneumatic hoses & yellow cable ramp",
            BuildGarageCablesSurface({ 11.5f }, MaterialPalette), ConvertHtmlPos(0.0f, 0.0f, 0.0f),
            MaterialPalette.Resolve(StudioMaterialCode::RubberMat), PropsFolder, false);
    }

    AppendParticleEmitter(
        "l3-garage-smoke", "Volumetric Garage & Tire Smoke",
        "Frontier::ParticleSpace (mist-spray) · exhaust & pit-bay atmosphere plume",
        "mist-spray", ConvertHtmlPos(0.85f, 0.55f, 0.95f), 145u, 64.0f, PropsFolder);
    AppendParticleEmitter(
        "l3-dust-particles", "Sunbeam Garage Dust Motes",
        "Frontier::ParticleSpace (ground-dust) · sunlit pit-archway dust motes",
        "ground-dust", ConvertHtmlPos(-0.8f, 2.0f, -0.4f), 165u, 72.0f, PropsFolder);

    // 4. Garage & Stadium Lighting
    const InstanceToken LightFolder = CreateFolderEntry("Garage & Stadium Lighting", "Overhead garage linear LEDs & stadium afternoon sunlight", {});
    if (Policy.EnableStudioLightingRigs)
    {
        const Axis3D OverheadPos = ConvertHtmlPos(0.0f, 6.05f, 0.35f);
        WorldScene.AreaLights.push_back(MakeAimedAreaQuad(OverheadPos, ConvertHtmlPos(0.0f, 0.0f, 0.35f), 12.0f, 8.0f, { 5.2f, 5.4f, 5.7f }));
        (void)AppendLuminaireEntity("Garage Ceiling Linear LEDs", "Rect Area Light · 5850 K industrial ceiling bank", "light:area", OverheadPos, { 2u, 5.2f, 5.4f, 5.7f, 26.0f, 125.0f, true }, LightFolder);

        const Axis3D SunPos = ConvertHtmlPos(-9.4f, 8.2f, -13.5f);
        WorldScene.PhotometricRadiators.push_back(MakeAimedPhotometricSpot(SunPos, HeroAimZUp, { 52.0f, 42.0f, 28.0f }, 36.0f, 2u));
        (void)AppendLuminaireEntity("Afternoon Stadium Sunlight", "IES Photometric · golden sunlight through open pit archway", "light:ies", SunPos, { 3u, 52.0f, 42.0f, 28.0f, 36.0f, 72.0f, true }, LightFolder);

        const Axis3D PortalPos = ConvertHtmlPos(-4.2f, 3.1f, -6.3f);
        WorldScene.AreaLights.push_back(MakeAimedAreaQuad(PortalPos, HeroAimZUp, 7.5f, 3.6f, { 4.2f, 4.4f, 4.9f }));
        (void)AppendLuminaireEntity("Open Pit Archway Sky Fill", "Rect Area Light · outdoor track daylight spill", "light:area", PortalPos, { 2u, 4.2f, 4.4f, 4.9f, 24.0f, 110.0f, true }, LightFolder);

        const Axis3D BayPos = ConvertHtmlPos(5.2f, 5.4f, 1.4f);
        WorldScene.PhotometricRadiators.push_back(MakeAimedPhotometricSpot(BayPos, HeroAimZUp, { 28.0f, 20.5f, 12.8f }, 22.0f, 2u));
        (void)AppendLuminaireEntity("Mechanic Bay Overhead Lamp", "IES Photometric · warm 3400 K worklamp", "light:ies", BayPos, { 3u, 28.0f, 20.5f, 12.8f, 22.0f, 64.0f, true }, LightFolder);
    }

    const InstanceToken CamFolder = CreateFolderEntry("Camera Rigs", "Editor camera & pit garage camera rigs", {});
    (void)AppendCameraEntity("Editor Camera", "Unrestricted 3D editor navigation camera", ConvertHtmlPos(4.95f, 1.52f, 5.85f), { 35.0f, 36.0f, 0.1f, 2500.0f, true }, CamFolder, true);

    WorldScene.Atmosphere.Medium.AtmosphereEnabled = false;
    WorldScene.Atmosphere.Solar.SolarEnabled       = true;
    WorldScene.Sun.DirectionToSun                   = SafeNorm({ -0.45f, 0.65f, 0.60f });
    WorldScene.Sun.SolarIrradiance                  = { 3.2f, 2.8f, 2.3f };
    WorldScene.SkyRadiance                          = { 0.18f, 0.24f, 0.34f };

    PerspectiveCameraBasis Cam {};
    Cam.CameraOrigin       = ConvertHtmlPos(4.95f, 1.52f, 5.85f);
    Cam.TargetPoint        = HeroAimZUp;
    Cam.WorldUpAxis        = { 0.0f, 0.0f, 1.0f };
    Cam.VerticalFovRadians = 36.0f * Constants::DegToRadFloat;
    Cam.ViewportWidthPx    = 1280u;
    Cam.ViewportHeightPx   = 720u;
    Cam.NearClipMeters     = 0.10f;
    CameraPresets.push_back({ "hero-34", "Hero 3/4 · Racing Garage", Cam });
}

//------------------------------------------------------------------------------------------------------------------------
//                                      SIMULATION STEP & PARTICLE COMPOSITING
//------------------------------------------------------------------------------------------------------------------------

void StudioLobbyHost::TickSimulation(double FixedDeltaSeconds) noexcept
{
    SimulationClockSeconds += FixedDeltaSeconds;
    const float Dt = static_cast<float>(std::clamp(FixedDeltaSeconds, 0.001, 0.05));

    (void)World::ExecuteWorldSimulationSequence(WorldRegister, Dt, true);
    (void)SceneSyncBridge.FlushRebuiltTransformsToScene(WorldRegister, WorldScene);

    if (ActivePolicy.EnableEngineParticles && !ParticleClouds.empty())
    {
        ParticleSimulation.StepCloudsCpu(
            ParticleClouds,
            CarrierSolids,
            ParticleRegion,
            static_cast<float>(SimulationClockSeconds),
            Dt);
    }
}

PerspectiveCameraBasis StudioLobbyHost::QueryCameraPreset(
    uint32_t PresetIndex,
    uint32_t ViewportWidthPx,
    uint32_t ViewportHeightPx) const noexcept
{
    PerspectiveCameraBasis Cam {};
    if (!CameraPresets.empty())
    {
        const uint32_t Clamped = std::min(PresetIndex, static_cast<uint32_t>(CameraPresets.size() - 1u));
        Cam = CameraPresets[Clamped].Camera;
    }
    else
    {
        Cam.CameraOrigin       = ConvertHtmlPos(5.75f, 1.62f, 6.45f);
        Cam.TargetPoint        = ConvertHtmlPos(0.05f, 0.78f, -0.15f);
        Cam.WorldUpAxis        = { 0.0f, 0.0f, 1.0f };
        Cam.VerticalFovRadians = 35.0f * Constants::DegToRadFloat;
        Cam.NearClipMeters     = 0.10f;
    }
    Cam.ViewportWidthPx  = std::max(64u, ViewportWidthPx);
    Cam.ViewportHeightPx = std::max(64u, ViewportHeightPx);
    return Cam;
}

void StudioLobbyHost::CompositeParticlesIntoRgba8(
    const PerspectiveCameraBasis& Camera,
    std::vector<uint8_t>&         InOutRgba8) const
{
    if (!ActivePolicy.EnableEngineParticles || ParticleClouds.empty())
    {
        return;
    }
    const uint32_t W = Camera.ViewportWidthPx;
    const uint32_t H = Camera.ViewportHeightPx;
    if (InOutRgba8.size() < static_cast<std::size_t>(W) * H * 4u)
    {
        return;
    }

    ParticleCameraView PView {};
    PView.ViewProjection  = BuildWorldZUpViewProj(Camera);
    PView.CameraPosition  = { Camera.CameraOrigin.X, Camera.CameraOrigin.Y, Camera.CameraOrigin.Z };
    const Axis3D Fwd      = SafeNorm(Camera.TargetPoint - Camera.CameraOrigin, { 0.0f, 1.0f, 0.0f });
    PView.CameraForward   = { Fwd.X, Fwd.Y, Fwd.Z };
    PView.ViewportWidthPx = static_cast<float>(W);
    PView.ViewportHeightPx = static_cast<float>(H);
    PView.VerticalFovRad  = Camera.VerticalFovRadians;
    PView.PixelRatio      = 1.0f;

    const auto DrawCalls = ParticleRenderer.BuildSpriteRenderCalls(
        ParticleClouds,
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
            // Convert ParticleSpace Y-up state position into FrontierWorldZUp (X, -Z, Y)
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
            const Axis3D RayDir = SafeNorm(WorldP - Camera.CameraOrigin, { 0.0f, 1.0f, 0.0f });
            const float  Dist   = std::sqrt(EvaluateLengthSquared(WorldP - Camera.CameraOrigin));
            SpatialAcceleration::RaySegmentQuery VisRay {};
            VisRay.Origin          = Camera.CameraOrigin;
            VisRay.MinimumDistance = 0.05f;
            VisRay.UnitDirection   = RayDir;
            VisRay.MaximumDistance = std::max(0.06f, Dist - 0.08f);
            if (WorldScene.SceneTree.QueryRayOccluded(VisRay))
            {
                continue;
            }

            const float RadiusPx = std::clamp(DiamPx * 0.65f, 2.2f, 22.0f);
            const float SoftAlphaMul = (Call.NodeId.find("smoke") != std::string::npos) ? 0.24f : 0.42f;
            const float BaseAlpha = std::clamp(Shade.Alpha * DofAlpha * SoftAlphaMul, 0.0f, 0.55f);
            if (BaseAlpha <= 0.004f)
            {
                continue;
            }

            const int X0 = std::max(0, static_cast<int>(std::floor(ScreenX - RadiusPx)));
            const int X1 = std::min(static_cast<int>(W) - 1, static_cast<int>(std::ceil(ScreenX + RadiusPx)));
            const int Y0 = std::max(0, static_cast<int>(std::floor(ScreenY - RadiusPx)));
            const int Y1 = std::min(static_cast<int>(H) - 1, static_cast<int>(std::ceil(ScreenY + RadiusPx)));
            const float SoftFlag = 1.0f;
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
                        SoftFlag, 0.5f, { 0.0f, 0.0f, 0.0f, 0.0f }, { U, V });
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

//------------------------------------------------------------------------------------------------------------------------
//                                        OFFSCREEN VISUAL PROOF RENDERER
//------------------------------------------------------------------------------------------------------------------------

bool StudioLobbyHost::RenderVisualProof(
    const std::filesystem::path& OutputDirectory,
    const std::filesystem::path& RepoRoot,
    uint32_t                     WidthPx,
    uint32_t                     HeightPx,
    std::string&                 OutDiagnostic)
{
    const uint32_t W = std::max(320u, WidthPx);
    const uint32_t H = std::max(240u, HeightPx);

    std::error_code Ec {};
    std::filesystem::create_directories(OutputDirectory, Ec);

    TieredWorldRenderSequence CpuSequence {};
    CpuSequence.PrepareWorldScene(WorldScene);
    CpuSequence.SynchronizeWorldAtmosphere(WorldScene);

    VulkanInterchange VkDevice {};
    VulkanWorldRenderSequence GpuSequence {};
    bool VulkanReady = false;
    std::string VkDiag {};
    if (VkDevice.InitializeInterchange(RepoRoot, &VkDiag))
    {
        const std::filesystem::path ShaderDir = LocateCompiledShaderFolder(RepoRoot);
        if (GpuSequence.InitializeSequence(VkDevice, ShaderDir))
        {
            GpuSequence.SynchronizeSceneResources(WorldScene, true);
            VulkanReady = true;
        }
    }

    const std::string Slug(QueryStudioLobbySlug(ActivePolicy.SelectedLobby));

    // View 0: Primary Hero 3/4 view (Vulkan RealTimeGiGtxLowEnd for rich studio bounce + OpenPbrDirect comparison)
    const PerspectiveCameraBasis HeroCam = QueryCameraPreset(ActivePolicy.ActiveCameraPresetIndex, W, H);
    if (VulkanReady)
    {
        // 1) Vulkan Order 2 GI (Direct LTC + IES + Indirect bounce + BVH4 Reflections)
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
            if (!GpuSequence.RenderWorldViewportWithEngine(Cfg, 0u, HeroCam, WorldScene, Rgba))
            {
                OutDiagnostic = "Vulkan RealTimeGiGtxLowEnd viewport render failed.";
                GpuSequence.TeardownSequence();
                return false;
            }
            CompositeParticlesIntoRgba8(HeroCam, Rgba);
            const auto OutPath = OutputDirectory / (Slug + "-Hero34-VulkanGi.png");
            if (!SaveRgba8ImageToPng(OutPath, W, H, Rgba))
            {
                OutDiagnostic = "Failed to save " + OutPath.string();
                GpuSequence.TeardownSequence();
                return false;
            }
        }

        // 2) Wide Stage Overview / Crew BTS preset (shows cyclorama, all 3 cars, light rigs, tripods & crew props!)
        if (CameraPresets.size() >= 6u)
        {
            const PerspectiveCameraBasis CrewCam = QueryCameraPreset(5u, W, H);
            WorldRenderConfiguration Cfg {};
            Cfg.Engine             = WorldRenderEngine::RealTimeGiGtxLowEnd;
            Cfg.ShadowAlgorithm    = SolarShadowAlgorithm::WideTreeRayQuery;
            Cfg.ReflectionSource   = SpecularReflectionSource::WideTreeRaytrace;
            Cfg.ReflectionsEnabled = true;
            Cfg.RaytracingEnabled  = true;
            Cfg.SdfGiIntensity     = 1.05f;
            Cfg.ExposureGain       = 1.15f;

            std::vector<uint8_t> Rgba {};
            if (GpuSequence.RenderWorldViewportWithEngine(Cfg, 1u, CrewCam, WorldScene, Rgba))
            {
                CompositeParticlesIntoRgba8(CrewCam, Rgba);
                (void)SaveRgba8ImageToPng(OutputDirectory / (Slug + "-CrewBTS-VulkanGi.png"), W, H, Rgba);
            }
        }

        GpuSequence.TeardownSequence();
    }
    else
    {
        // Headless CPU fallback when Vulkan ICD is not installed
        WorldRenderConfiguration CpuCfg {};
        CpuCfg.Engine             = WorldRenderEngine::OpenPbrDirect;
        CpuCfg.ShadowAlgorithm    = SolarShadowAlgorithm::WideTreeRayQuery;
        CpuCfg.ReflectionSource   = SpecularReflectionSource::WideTreeRaytrace;
        CpuCfg.ReflectionsEnabled = true;
        CpuCfg.RaytracingEnabled  = true;
        CpuCfg.ExposureGain       = 1.25f;

        auto Out = CpuSequence.RenderWorldFrameWithEngine(CpuCfg, HeroCam, HeroCam, WorldScene);
        CompositeParticlesIntoRgba8(HeroCam, Out.DisplayRgba8);
        const auto OutPath = OutputDirectory / (Slug + "-Hero34-CpuDirect.png");
        if (!SaveRgba8ImageToPng(OutPath, W, H, Out.DisplayRgba8))
        {
            OutDiagnostic = "Failed to save " + OutPath.string();
            return false;
        }
    }

    return true;
}

StudioLobbyTelemetry StudioLobbyHost::InspectTelemetry() const noexcept
{
    StudioLobbyTelemetry T {};
    T.ActiveLobby             = ActivePolicy.SelectedLobby;
    T.VehicleCount            = VehicleCount;
    T.SurfaceInstanceCount    = WorldRegister.InspectSurfaceRegister().QueryActiveCount();
    T.AreaLightCount          = static_cast<uint32_t>(WorldScene.AreaLights.size());
    T.PhotometricLightCount   = static_cast<uint32_t>(WorldScene.PhotometricRadiators.size());
    T.CameraRigCount          = WorldRegister.InspectCameraRegister().QueryActiveCount();
    T.ParticleCloudCount      = static_cast<uint32_t>(ParticleClouds.size());
    T.SimulatedParticleCount  = ParticleSimulation.QueryStatistics().ActiveParticleCount;
    T.TotalMeshTriangles      = TotalMeshTriangles;
    T.VehicleDecoderLoaded    = !ControlVehicleTemplate.Triangles.empty();
    T.PhotometryLoaded        = !PhotometrySuite.empty();
    T.ParticleTemplatesLoaded = ParticleCatalogReady;
#if FRONTIER_PROFILE_EDITOR
    T.OutlinerRowCount        = (BoundOutliner != nullptr) ? BoundOutliner->QueryTotalCount() : 0u;
#endif
    return T;
}

} // namespace AutoSpace
