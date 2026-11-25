/*============================================================================================================================================
                                                            STUDIOLOBBYHOST.H
============================================================================================================================================*/
// 🧩 Single-level Studio Lobby host building Lobby 1 (Cyclorama), Lobby 2 (Forest Stage) & Lobby 3 (Racing Garage) by policy inside MainWorld

#pragma once

//------------------------------------------------------------------------------------------------------------------------
//                                                        INCLUDES
//------------------------------------------------------------------------------------------------------------------------

#include "Engine/Codecs/ControlVehicleSurfaceDecoder.h"
#include "Engine/Codecs/PhotometricProfile.h"
#include "Engine/Configuration/BuildConfiguration.h"
#include "Engine/GeometricRaster/GlobalIllumination/TieredWorldRenderSequence.h"
#include "Engine/GeometrySpace/Network/PolygonNetwork.h"
#include "Engine/ParticleSpace/CarrierSolidRegistry.h"
#include "Engine/ParticleSpace/ParticleCloudTypes.h"
#include "Engine/ParticleSpace/ParticleGpuRenderer.h"
#include "Engine/ParticleSpace/ParticleGpuSimulation.h"
#include "Engine/ParticleSpace/ParticleTemplateRegistry.h"
#include "Engine/SimulationSpace/EffectLayers/EffectLayerSpecification.h"
#include "Engine/SpatialAcceleration/ClusterPyramid.h"
#include "Engine/World/CategoryInstances.h"
#include "Engine/World/WorldInstanceRegister.h"
#include "Engine/World/WorldSceneSyncBridge.h"
#include "Source/AutoSpacePolicies.h"
#include "Source/StudioProceduralSurface.h"

#if FRONTIER_PROFILE_EDITOR
#include "Engine/Components/Panes/OutlinerPanel.h"
#include "Engine/Editor/WorldInstanceEditorBridge.h"
#endif

#include <cstdint>
#include <filesystem>
#include <memory>
#include <string>
#include <vector>

namespace AutoSpace
{

//------------------------------------------------------------------------------------------------------------------------
//                                                       STRUCTURES
//------------------------------------------------------------------------------------------------------------------------

struct StudioGeometryAsset
{
    std::string                                    StableId {};
    Frontier::GeometrySpace::PolygonNetwork        Network  {};
    Frontier::SpatialAcceleration::ClusterPyramid  Pyramid  {};
};

struct StudioCameraPresetView
{
    std::string                                        Id     {};
    std::string                                        Label  {};
    Frontier::GeometricRaster::PerspectiveCameraBasis  Camera {};
};

struct StudioLobbyTelemetry
{
    StudioLobbyId ActiveLobby               = StudioLobbyId::StudioLobby1Cyclorama;
    uint32_t      VehicleCount              = 0u;
    uint32_t      SurfaceInstanceCount      = 0u;
    uint32_t      AreaLightCount            = 0u;
    uint32_t      PhotometricLightCount     = 0u;
    uint32_t      CameraRigCount            = 0u;
    uint32_t      ParticleCloudCount        = 0u;
    uint32_t      SimulatedParticleCount    = 0u;
    uint32_t      TotalMeshTriangles        = 0u;
    uint32_t      OutlinerRowCount          = 0u;
    bool          VehicleDecoderLoaded      = false;
    bool          PhotometryLoaded          = false;
    bool          ParticleTemplatesLoaded   = false;
};

//------------------------------------------------------------------------------------------------------------------------
//                                                     STUDIOLOBBYHOST
//------------------------------------------------------------------------------------------------------------------------

class StudioLobbyHost
{
public:
    StudioLobbyHost() noexcept = default;
    ~StudioLobbyHost() noexcept;

    StudioLobbyHost(const StudioLobbyHost&)            = delete;
    StudioLobbyHost& operator=(const StudioLobbyHost&) = delete;

    void Shutdown() noexcept;

    [[nodiscard]] bool BuildLobbyInSingleWorld(
        const std::filesystem::path& RepoRoot,
        const StudioLobbyPolicy&     Policy,
        std::string&                 OutDiagnostic);

#if FRONTIER_PROFILE_EDITOR
    // Binds an Editor OutlinerPanel so lobby hierarchy rows mirror WorldInstanceRegister automatically
    void AttachOutliner(Frontier::OutlinerPanel* Outliner) noexcept;
#endif

    void TickSimulation(double FixedDeltaSeconds) noexcept;

    // Selects camera preset index [0..Presets.size()-1] and returns configured PerspectiveCameraBasis
    [[nodiscard]] Frontier::GeometricRaster::PerspectiveCameraBasis QueryCameraPreset(
        uint32_t PresetIndex,
        uint32_t ViewportWidthPx  = 1280u,
        uint32_t ViewportHeightPx = 720u) const noexcept;

    // Renders offscreen visual-proof PNGs using Frontier's existing Vulkan & CPU Direct PBR/GI pipelines
    [[nodiscard]] bool RenderVisualProof(
        const std::filesystem::path& OutputDirectory,
        const std::filesystem::path& RepoRoot,
        uint32_t                     WidthPx,
        uint32_t                     HeightPx,
        std::string&                 OutDiagnostic);

    [[nodiscard]] StudioLobbyTelemetry                                  InspectTelemetry() const noexcept;
    [[nodiscard]] const Frontier::GeometricRaster::WorldSceneSpecification& InspectWorldScene() const noexcept { return WorldScene; }
    [[nodiscard]] const Frontier::World::WorldInstanceRegister&         InspectWorldRegister() const noexcept { return WorldRegister; }
    [[nodiscard]] const std::vector<StudioCameraPresetView>&            InspectCameraPresets() const noexcept { return CameraPresets; }

private:
    [[nodiscard]] bool EnsureSharedAssetsLoaded(
        const std::filesystem::path& RepoRoot,
        std::string&                 OutDiagnostic);

    void ClearLobbyObjects() noexcept;

    Frontier::World::InstanceToken CreateFolderEntry(
        std::string_view               Title,
        std::string_view               Subtitle,
        Frontier::World::InstanceToken EnclosingToken);

    uint32_t AppendSurfaceEntity(
        std::string_view                      StableId,
        std::string_view                      OutlinerTitle,
        std::string_view                      Subtitle,
        StudioBuiltMesh                       BuiltMesh,
        Frontier::Mathematics::Axis3D         WorldTranslation,
        uint16_t                              FallbackMaterialSlot,
        Frontier::World::InstanceToken        EnclosingToken,
        bool                                  CastShadows = true);

    Frontier::World::InstanceToken AppendLuminaireEntity(
        std::string_view                                       Title,
        std::string_view                                       Subtitle,
        std::string_view                                       DomainTag,
        Frontier::Mathematics::Axis3D                          WorldPos,
        const Frontier::World::LuminaireInstanceParameters&    Params,
        Frontier::World::InstanceToken                         EnclosingToken);

    Frontier::World::InstanceToken AppendCameraEntity(
        std::string_view                                    Title,
        std::string_view                                    Subtitle,
        Frontier::Mathematics::Axis3D                       WorldPos,
        const Frontier::World::CameraInstanceParameters&    Params,
        Frontier::World::InstanceToken                      EnclosingToken,
        bool                                                RemovalProtected = false);

    void AppendParticleEmitter(
        std::string_view                      NodeId,
        std::string_view                      OutlinerTitle,
        std::string_view                      Subtitle,
        std::string_view                      TemplateId,
        Frontier::Mathematics::Axis3D         WorldOriginZUp,
        uint32_t                              ParticleCount,
        float                                 ReleaseRate,
        Frontier::World::InstanceToken        EnclosingToken);

    void SyncOutlinerEntryMetadata(
        Frontier::World::InstanceToken Token,
        std::string_view               Subtitle,
        std::string_view               DomainTag,
        Frontier::Mathematics::Axis3D  WorldPos,
        Frontier::Mathematics::Axis3D  RotationDeg = {},
        float                          Scale       = 1.0f,
        bool                           RemovalProtected = false);

    void BuildLobby1Cyclorama(const StudioLobbyPolicy& Policy);
    void BuildLobby2ForestStage(const StudioLobbyPolicy& Policy);
    void BuildLobby3RacingGarage(const StudioLobbyPolicy& Policy);
    void FinalizeWorldSceneAcceleration();
    void CompositeParticlesIntoRgba8(
        const Frontier::GeometricRaster::PerspectiveCameraBasis& Camera,
        std::vector<uint8_t>&                                    InOutRgba8) const;

    // Shared decoded content (loaded once across policy switches inside the same single level)
    bool                                                                 SharedAssetsReady       = false;
    bool                                                                 ParticleCatalogReady    = false;
    Frontier::Codecs::AssembledControlVehicle                            ControlVehicleTemplate  {};
    std::vector<Frontier::Codecs::ResampledPhotometricProfile>           PhotometrySuite         {};
    Frontier::SimulationSpace::EffectLayers::EffectLayerSpecificationSet ParticleSpecs           {};
    Frontier::ParticleSpace::ParticleTemplateRegistry                    ParticleTemplates       {};
    Frontier::ParticleSpace::CarrierSolidRegistry                        CarrierSolids           {};

    // Live single-level lobby runtime state
    StudioLobbyPolicy                                                    ActivePolicy            {};
    StudioMaterialPalette                                                MaterialPalette         {};
    Frontier::World::WorldInstanceRegister                               WorldRegister           {};
    Frontier::World::WorldSceneSyncBridge                                SceneSyncBridge         {};
    Frontier::GeometricRaster::WorldSceneSpecification                   WorldScene              {};
    std::vector<std::unique_ptr<StudioGeometryAsset>>                    GeometryAssets          {};
    std::vector<Frontier::World::CategoryInstanceHandle>                 ManagedCategoryHandles  {};
    std::vector<Frontier::World::InstanceToken>                          FolderTokens            {};
    std::vector<StudioCameraPresetView>                                  CameraPresets           {};

    // Engine ParticleSpace runtime state
    std::vector<Frontier::ParticleSpace::ParticleCloudNode>              ParticleClouds          {};
    Frontier::ParticleSpace::ParticleGpuSimulation                       ParticleSimulation      {};
    Frontier::ParticleSpace::ParticleGpuRenderer                         ParticleRenderer        {};
    Frontier::ParticleSpace::ParticleSimulationRegion                    ParticleRegion          {};
    double                                                               SimulationClockSeconds  = 0.0;
    uint32_t                                                             VehicleCount            = 0u;
    uint32_t                                                             TotalMeshTriangles      = 0u;

#if FRONTIER_PROFILE_EDITOR
    Frontier::OutlinerPanel*                                             BoundOutliner           = nullptr;
    std::unique_ptr<Frontier::Editor::WorldInstanceEditorBridge>         EditorBridge            {};
#endif
};

} // namespace AutoSpace
