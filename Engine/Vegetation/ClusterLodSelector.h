/*============================================================================================================================================
                                                      CLUSTERLODSELECTOR.H
============================================================================================================================================*/
// Screen-space cut selection for Nanite-style 128-triangle cluster pyramids.
// The production builder is SpatialAcceleration::ClusterPyramid; this unit owns only the per-instance
// cut decision and the wind-safe bound inflation needed by two-phase cluster culling.

#pragma once

#include "Engine/Vegetation/CanopyDeformer.h"
#include "Engine/Vegetation/VegetationPresetCatalog.h"

#include <cstdint>
#include <vector>

namespace Frontier::Vegetation
{

struct ClusterRecord
{
    Vec3     Center  {};
    float    RadiusM = 0.0f;
    float    ErrorM  = 0.0f; // Monotone group error from ClusterPyramid.
    uint32_t TriangleCount = 0u;
    uint8_t  Level = 0u;
};

struct ClusterCullConfiguration
{
    uint32_t MaximumTrianglesPerCluster = 128u;
    float    MaximumErrorPixels         = 1.25f; // Matches ClusterCullSettings.
    float    MicroClusterPixels         = 4.0f;
    bool     LockUvSeams                = true;
    bool     EnableNormalConeCull       = true;
};

class ClusterLodSelector
{
public:
    // Accepts monotone per-level errors produced by ClusterPyramid::BuildHierarchy.
    void ConfigureLevels(const std::vector<float>& ErrorsM, float CanopyRadiusM) noexcept;

    [[nodiscard]] uint32_t SelectLevel(uint32_t InstanceToken, float DistanceM, float ProjectionScale,
                                       const ClusterCullConfiguration& Configuration) const noexcept;

    [[nodiscard]] const std::vector<ClusterRecord>& QueryClusters() const noexcept { return Clusters; }

    // Conservative bound: a cluster may not be culled at the edge of its wind envelope.
    [[nodiscard]] static float WindSafeRadius(const ClusterRecord& Cluster,
                                              const DeformerSettings& Settings,
                                              const WindSample& Wind) noexcept;

    [[nodiscard]] static float ScreenErrorPixels(float ErrorM, float DistanceM, float ProjectionScale) noexcept;

private:
    std::vector<ClusterRecord> Clusters {};
};

} // namespace Frontier::Vegetation
