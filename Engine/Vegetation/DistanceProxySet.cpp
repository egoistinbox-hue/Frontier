/*============================================================================================================================================
                                                        DISTANCEPROXYSET.CPP
============================================================================================================================================*/

#include "Engine/Vegetation/DistanceProxySet.h"

#include <algorithm>
#include <cmath>

namespace Frontier::Vegetation
{

void DistanceProxySet::Build(const VegetationPreset& Preset, uint32_t InstanceToken) noexcept
{
    Proxies.clear();
    RestJoints.clear();

    const float Height = Preset.HeightM;
    const float TrunkRadius = Height * Preset.TrunkRatio;

    DistanceProxy Trunk {};
    Trunk.JointStart = {0.0f, 0.0f, 0.0f};
    Trunk.JointEnd = {0.0f, Height * 0.72f, 0.0f};
    Trunk.RadiusStartM = TrunkRadius * 1.4f;
    Trunk.RadiusEndM = TrunkRadius * 0.55f;
    Trunk.Token = InstanceToken;
    Trunk.Phase = 0.0f;
    Proxies.push_back(Trunk);
    RestJoints.push_back(Trunk.JointStart);
    RestJoints.push_back(Trunk.JointEnd);

    const uint32_t LimbCount = std::min(8u, std::max(1u, Preset.Branches[1]));
    for (uint32_t Index = 0u; Index < LimbCount; ++Index)
    {
        const float Fraction = static_cast<float>(Index + 1u) / static_cast<float>(LimbCount + 1u);
        const float Phase = Hash01(InstanceToken * 131u + Index * 17u);
        const float Azimuth = Phase * 6.2831853f;
        const float JointY = Height * (0.42f + 0.36f * Fraction);
        const float Length = Height * (0.18f + 0.12f * Phase);

        DistanceProxy Limb {};
        Limb.JointStart = {0.0f, JointY, 0.0f};
        Limb.JointEnd = {std::cos(Azimuth) * Length, JointY + Length * 0.32f, std::sin(Azimuth) * Length};
        Limb.RadiusStartM = TrunkRadius * 0.45f;
        Limb.RadiusEndM = TrunkRadius * 0.16f;
        Limb.Token = InstanceToken + Index + 1u;
        Limb.Phase = Phase;
        Proxies.push_back(Limb);
        RestJoints.push_back(Limb.JointStart);
        RestJoints.push_back(Limb.JointEnd);
    }

    if (Preset.LeavesPerTwig > 0u)
    {
        DistanceProxy Canopy {};
        Canopy.JointStart = {0.0f, Height * 0.82f, 0.0f};
        Canopy.JointEnd = Canopy.JointStart; // Sphere, represented as a zero-length capsule.
        Canopy.RadiusStartM = Height * 0.24f;
        Canopy.RadiusEndM = Canopy.RadiusStartM;
        Canopy.Token = InstanceToken + 0xFFFFu;
        Canopy.Phase = 0.31f;
        Proxies.push_back(Canopy);
        RestJoints.push_back(Canopy.JointStart);
        RestJoints.push_back(Canopy.JointEnd);
    }
}

void DistanceProxySet::UpdatePose(const WindSample& Wind, const DeformerSettings& Settings, float TimeSeconds) noexcept
{
    const Vec3 Side = Normalize(Cross(Vec3 {0.0f, 1.0f, 0.0f}, Wind.Direction));
    for (std::size_t Index = 0u; Index < Proxies.size(); ++Index)
    {
        DistanceProxy& Proxy = Proxies[Index];
        const Vec3 RestStart = RestJoints[Index * 2u];
        const Vec3 RestEnd = RestJoints[Index * 2u + 1u];
        const float HeightWeight = Proxy.Phase == 0.0f ? 1.0f : 0.35f + 0.65f * RestStart.Y / std::max(1.0f, Settings.TreeHeightM);
        const float Angle = Settings.TrunkFlex * Wind.Strength * 0.035f * HeightWeight *
            (CanopyDeformer::WindWave(TimeSeconds * 0.85f) * 0.7f + 0.3f);

        // Rotate the whole rigid proxy about the tree root; canopy spheres translate as one body.
        Proxy.JointStart = RotateAroundAxis(RestStart, Side, Angle);
        Proxy.JointEnd = RotateAroundAxis(RestEnd, Side, Angle * 1.25f);
        if (Proxy.Phase > 0.0f)
        {
            const float LimbWave = std::sin(TimeSeconds * 1.3f + Proxy.Phase * 6.2831f) * 0.04f * Wind.Strength * Settings.LimbFlex;
            Proxy.JointEnd = RotateAroundAxis(Proxy.JointEnd, Side, LimbWave);
        }
    }
}

float DistanceProxySet::EvaluateCapsule(const DistanceProxy& Proxy, const Vec3& Position) noexcept
{
    const Vec3 Segment = Proxy.JointEnd - Proxy.JointStart;
    const Vec3 Relative = Position - Proxy.JointStart;
    const float LengthSquared = Dot(Segment, Segment);
    const float Fraction = LengthSquared > 1.0e-8f ? Clamp(Dot(Relative, Segment) / LengthSquared, 0.0f, 1.0f) : 0.0f;
    const float Radius = Proxy.RadiusStartM + (Proxy.RadiusEndM - Proxy.RadiusStartM) * Fraction;
    return Length(Relative - Segment * Fraction) - Radius;
}

float DistanceProxySet::Evaluate(const Vec3& WorldPosition) const noexcept
{
    float Result = 1.0e5f;
    for (const DistanceProxy& Proxy : Proxies)
    {
        Result = SmoothMinimum(Result, EvaluateCapsule(Proxy, WorldPosition), SmoothingM);
    }
    return Result;
}

} // namespace Frontier::Vegetation
