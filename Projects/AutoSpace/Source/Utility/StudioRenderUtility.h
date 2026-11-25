/*============================================================================================================================================
                                                          STUDIORENDERUTILITY.H
============================================================================================================================================*/
// 🧩 Shared math, lighting placement, PNG export, ParticleSpace compositing & Vulkan/CPU proof render utilities for AutoSpace

#pragma once

//------------------------------------------------------------------------------------------------------------------------
//                                                        INCLUDES
//------------------------------------------------------------------------------------------------------------------------

#include "Engine/GeometricRaster/GlobalIllumination/TieredWorldRenderSequence.h"
#include "Engine/Mathematics/AxisCoordinates.h"
#include "Engine/Mathematics/LinearColors.h"
#include "Engine/ParticleSpace/ParticleCloudTypes.h"
#include "Engine/ParticleSpace/ParticleGpuRenderer.h"
#include "Engine/ParticleSpace/ParticleGpuSimulation.h"
#include "Source/Geometry/StudioProceduralSurface.h"

#include <array>
#include <cstdint>
#include <filesystem>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace AutoSpace
{

//------------------------------------------------------------------------------------------------------------------------
//                                                       STRUCTURES
//------------------------------------------------------------------------------------------------------------------------

struct HtmlAimAngles
{
    float YawDeg   = 0.0f; // [deg] - HTML Y-up azimuth yaw
    float PitchDeg = 0.0f; // [deg] - HTML Y-up elevation pitch
};

struct StudioCameraPresetView
{
    std::string                                       Id     {};
    std::string                                       Label  {};
    Frontier::GeometricRaster::PerspectiveCameraBasis Camera {};
};

//------------------------------------------------------------------------------------------------------------------------
//                                                  UTILITY OPERATIONS
//------------------------------------------------------------------------------------------------------------------------

[[nodiscard]] Frontier::Mathematics::Axis3D    ConvertHtmlPositionToWorldZUp(float Hx, float Hy, float Hz) noexcept;
[[nodiscard]] Frontier::Mathematics::Axis3D    NormalizeVectorSafe(Frontier::Mathematics::Axis3D V, Frontier::Mathematics::Axis3D Fallback = { 0.0f, 0.0f, -1.0f }) noexcept;
[[nodiscard]] Frontier::Mathematics::LinearRGB SrgbHexToLinearRgb(uint32_t HexRgb) noexcept;
[[nodiscard]] HtmlAimAngles                    ComputeHtmlAimAngles(Frontier::Mathematics::Axis3D FromHtml, Frontier::Mathematics::Axis3D TargetHtml) noexcept;
[[nodiscard]] float                            ComputeTripodMountHeight(const TripodParams& Params) noexcept;
[[nodiscard]] uint64_t                         HashStableId64(std::string_view Text) noexcept;

[[nodiscard]] Frontier::GeometricRaster::PolygonalAreaQuadLight MakeAimedAreaQuadLight(
    Frontier::Mathematics::Axis3D          CenterWorld,
    Frontier::Mathematics::Axis3D          AimTargetWorld,
    float                                  WidthMeters,
    float                                  HeightMeters,
    Frontier::Mathematics::LinearRGB       Radiance,
    bool                                   TwoSided        = false,
    Frontier::GeometricRaster::LightMobility Mobility      = Frontier::GeometricRaster::LightMobility::Static,
    uint32_t                               LightRigGroupId = 0u) noexcept;

[[nodiscard]] Frontier::GeometricRaster::PhotometricPointRadiator MakeAimedPhotometricSpotLight(
    Frontier::Mathematics::Axis3D          PosWorld,
    Frontier::Mathematics::Axis3D          TargetWorld,
    Frontier::Mathematics::LinearRGB       PeakRgb,
    float                                  RangeMeters,
    uint32_t                               ProfileOrdinal  = 2u,
    Frontier::GeometricRaster::LightMobility Mobility      = Frontier::GeometricRaster::LightMobility::Static,
    uint32_t                               LightRigGroupId = 0u) noexcept;

[[nodiscard]] bool SaveRgba8ImageToPngFile(
    const std::filesystem::path& FilePath,
    uint32_t                     WidthPx,
    uint32_t                     HeightPx,
    const std::vector<uint8_t>&  RgbaBytes);

void CompositeParticleCloudsIntoRgba8(
    const Frontier::GeometricRaster::WorldSceneSpecification&           Scene,
    const Frontier::GeometricRaster::PerspectiveCameraBasis&            Camera,
    std::span<const Frontier::ParticleSpace::ParticleCloudNode>         ParticleClouds,
    const Frontier::ParticleSpace::ParticleGpuSimulation&               ParticleSimulation,
    const Frontier::ParticleSpace::ParticleGpuRenderer&                 ParticleRenderer,
    const Frontier::ParticleSpace::ParticleSimulationRegion&            ParticleRegion,
    double                                                              SimulationClockSeconds,
    std::vector<uint8_t>&                                               InOutRgba8);

[[nodiscard]] bool RenderWorldVisualProof(
    Frontier::GeometricRaster::WorldSceneSpecification&             Scene,
    std::span<const StudioCameraPresetView>                         CameraPresets,
    uint32_t                                                            ActivePresetIndex,
    bool                                                                EnableParticles,
    std::span<const Frontier::ParticleSpace::ParticleCloudNode>         ParticleClouds,
    const Frontier::ParticleSpace::ParticleGpuSimulation&               ParticleSimulation,
    const Frontier::ParticleSpace::ParticleGpuRenderer&                 ParticleRenderer,
    const Frontier::ParticleSpace::ParticleSimulationRegion&            ParticleRegion,
    double                                                              SimulationClockSeconds,
    std::string_view                                                    LobbySlug,
    const std::filesystem::path&                                        OutputDirectory,
    const std::filesystem::path&                                        RepositoryRoot,
    uint32_t                                                            WidthPx,
    uint32_t                                                            HeightPx,
    std::string&                                                        OutDiagnostic);

} // namespace AutoSpace
