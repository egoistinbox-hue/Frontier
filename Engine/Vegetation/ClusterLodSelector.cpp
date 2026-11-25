/*============================================================================================================================================
                                                      CLUSTERLODSELECTOR.CPP
============================================================================================================================================*/

#include "Engine/Vegetation/ClusterLodSelector.h"

#include <algorithm>
#include <cmath>

namespace Frontier::Vegetation
{

void ClusterLodSelector::ConfigureLevels(const std::vector<float>& ErrorsM, float CanopyRadiusM) noexcept
{
    Clusters.clear();
    Clusters.reserve(ErrorsM.size());
    for (std::size_t Index = 0u; Index < ErrorsM.size(); ++Index)
    {
        ClusterRecord Record {};
        Record.Center = {0.0f, CanopyRadiusM, 0.0f};
        Record.RadiusM = CanopyRadiusM;
        Record.ErrorM = ErrorsM[Index];
        Record.TriangleCount = 128u;
        Record.Level = static_cast<uint8_t>(Index);
        Clusters.push_back(Record);
    }
}

uint32_t ClusterLodSelector::SelectLevel(uint32_t InstanceToken, float DistanceM, float ProjectionScale,
                                         const ClusterCullConfiguration& Configuration) const noexcept
{
    if (Clusters.empty() || DistanceM <= 1.0f)
    {
        return 0u;
    }

    // Small per-instance dither breaks the LOD transition line across a forest without temporal noise.
    const float Dither = 0.85f + 0.30f * Hash01(InstanceToken ^ 0x9E3779B9u);
    const float Budget = Configuration.MaximumErrorPixels * Dither;
    for (const ClusterRecord& Record : Clusters)
    {
        if (ScreenErrorPixels(Record.ErrorM, DistanceM, ProjectionScale) <= Budget)
        {
            return Record.Level;
        }
    }
    return static_cast<uint32_t>(Clusters.back().Level);
}

float ClusterLodSelector::ScreenErrorPixels(float ErrorM, float DistanceM, float ProjectionScale) noexcept
{
    if (DistanceM <= 1.0f)
    {
        return ErrorM * ProjectionScale;
    }
    return ErrorM * ProjectionScale / DistanceM;
}

float ClusterLodSelector::WindSafeRadius(const ClusterRecord& Cluster,
                                         const DeformerSettings& Settings,
                                         const WindSample& Wind) noexcept
{
    return Cluster.RadiusM + CanopyDeformer::MaximumDisplacement(Settings, Wind);
}

} // namespace Frontier::Vegetation
