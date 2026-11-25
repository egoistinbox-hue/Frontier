/*============================================================================================================================================
                                                     FRACTURESPECIFICATION.H
============================================================================================================================================*/
// Tree fracture authoring: deterministic cut planes on trunk / primary limbs, consumed by
// GeometrySpace::Fracture::FastRuntimeFracture near the camera and baked offline for distant instances.
// CutToken values are shared across neighbouring cells so fragment bonds remain exact.

#pragma once

#include "Engine/Vegetation/VegetationMath.h"
#include "Engine/Vegetation/VegetationPresetCatalog.h"

#include <cstdint>
#include <vector>

namespace Frontier::Vegetation
{

struct FractureCutPlane
{
    Vec3    Normal {};
    float   OffsetM = 0.0f;
    int32_t CutToken = 0;
    float   HeightM = 0.0f;
};

class FractureSpecification
{
public:
    [[nodiscard]] static std::vector<FractureCutPlane> BuildTrunkCuts(
        const VegetationPreset& Preset,
        uint32_t InstanceToken,
        float ImpactHeightM,
        float ImpactStrength) noexcept;

    [[nodiscard]] static uint32_t QueryPieceCount(const VegetationPreset& Preset,
                                                  const std::vector<FractureCutPlane>& Cuts) noexcept;
};

inline std::vector<FractureCutPlane> FractureSpecification::BuildTrunkCuts(
    const VegetationPreset& Preset,
    uint32_t InstanceToken,
    float ImpactHeightM,
    float ImpactStrength) noexcept
{
    std::vector<FractureCutPlane> Cuts {};
    const uint32_t Count = ImpactStrength > 0.8f ? 4u : ImpactStrength > 0.3f ? 2u : 1u;
    for (uint32_t Index = 0u; Index < Count; ++Index)
    {
        const float Random = Hash01(InstanceToken * 977u + Index * 41u);
        FractureCutPlane Cut {};
        Cut.Normal = Normalize(Vec3 {Random - 0.5f, 0.18f + Random * 0.22f, Hash01(InstanceToken + Index * 71u) - 0.5f});
        Cut.HeightM = Clamp(ImpactHeightM + (static_cast<float>(Index) - static_cast<float>(Count) * 0.5f) *
                            Preset.HeightM * 0.07f, Preset.HeightM * 0.05f, Preset.HeightM * 0.95f);
        Cut.OffsetM = -Dot(Cut.Normal, Vec3 {0.0f, Cut.HeightM, 0.0f});
        Cut.CutToken = static_cast<int32_t>(Index + 1u);
        Cuts.push_back(Cut);
    }
    return Cuts;
}

inline uint32_t FractureSpecification::QueryPieceCount(const VegetationPreset& Preset,
                                                       const std::vector<FractureCutPlane>& Cuts) noexcept
{
    // One extra cut at each primary limb root keeps collar geometry attached to the correct fragment.
    return static_cast<uint32_t>(Cuts.size()) + 1u + std::min(4u, Preset.Branches[1] / 16u);
}

} // namespace Frontier::Vegetation
