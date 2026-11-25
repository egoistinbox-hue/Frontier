/*============================================================================================================================================
                                                        DISTANCEPROXYSET.H
============================================================================================================================================*/
// Animated analytical SDF proxies for one tree instance: tapered capsules for trunk and primary limbs,
// spheres for canopy tufts. The same WindSample that deforms the visible mesh poses these proxies, so
// shadows / occlusion follow the swaying silhouette without rebaking a global distance field.

#pragma once

#include "Engine/Vegetation/CanopyDeformer.h"
#include "Engine/Vegetation/VegetationPresetCatalog.h"

#include <cstdint>
#include <vector>

namespace Frontier::Vegetation
{

struct DistanceProxy
{
    Vec3     JointStart {};
    Vec3     JointEnd   {};
    float    RadiusStartM = 0.0f;
    float    RadiusEndM   = 0.0f;
    uint32_t Token = 0u;
    float    Phase = 0.0f;
};

class DistanceProxySet
{
public:
    void Build(const VegetationPreset& Preset, uint32_t InstanceToken) noexcept;
    void UpdatePose(const WindSample& Wind, const DeformerSettings& Settings, float TimeSeconds) noexcept;

    [[nodiscard]] float Evaluate(const Vec3& WorldPosition) const noexcept;
    [[nodiscard]] const std::vector<DistanceProxy>& QueryProxies() const noexcept { return Proxies; }
    [[nodiscard]] static float EvaluateCapsule(const DistanceProxy& Proxy, const Vec3& Position) noexcept;

private:
    std::vector<DistanceProxy> Proxies {};
    std::vector<Vec3>          RestJoints {}; // Two joints per proxy.
    float                      SmoothingM = 0.24f;
};

} // namespace Frontier::Vegetation
