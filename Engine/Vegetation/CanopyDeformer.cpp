/*============================================================================================================================================
                                                       CANOPYDEFORMER.CPP
============================================================================================================================================*/

#include "Engine/Vegetation/CanopyDeformer.h"

#include <cmath>

namespace Frontier::Vegetation
{

float CanopyDeformer::WindWave(float Phase) noexcept
{
    return std::sin(Phase) * 0.7f + std::sin(Phase * 2.31f + 1.3f) * 0.2f + std::sin(Phase * 4.7f + 0.7f) * 0.1f;
}

Vec3 CanopyDeformer::Deform(
    const Vec3& Position,
    const Vec3& Pivot,
    const WindVertexAttributes& Attributes,
    const WindSample& Wind,
    const DeformerSettings& Settings,
    float TimeSeconds) noexcept
{
    const Vec3 Direction = Wind.Direction;
    const Vec3 Side = Normalize(Cross(Vec3 {0.0f, 1.0f, 0.0f}, Direction));

    float Gust = 0.5f + 0.5f * WindWave(TimeSeconds * 0.6f - Attributes.Height * 0.8f);
    Gust = 0.6f + 0.4f * Gust;
    Gust *= 1.0f + Wind.Gust * (0.5f + 0.5f * std::sin(TimeSeconds * 0.23f));
    const float Strength = Clamp(Wind.Strength + Wind.Turbulence, 0.0f, 40.0f) * Gust;

    Vec3 Result = Position;

    // Limb bending about the authored limb root.
    if (Attributes.Limb > 0.0f)
    {
        Vec3 Relative = Result - Pivot;
        const float Phase = Attributes.Phase * 6.2831f;
        const float Weight = Attributes.Limb * Attributes.Limb;
        const float Angle = Settings.LimbFlex * Strength * 0.12f * Weight *
            (WindWave(TimeSeconds * 1.3f + Phase) * 0.8f + 0.5f);
        Relative = RotateAroundAxis(Relative, Normalize(Side + Vec3 {1.0e-4f, 0.0f, 0.0f}), Angle);
        Relative = RotateAroundAxis(Relative, Direction, Angle * 0.35f * std::sin(TimeSeconds * 0.9f + Phase * 1.7f));
        Result = Pivot + Relative;
    }

    // High-frequency twig and leaf flutter.
    if (Attributes.Detail > 0.0f)
    {
        const float Flutter = Attributes.Detail * Settings.DetailFlex * Strength;
        const float Phase = Attributes.Phase * 12.566f + Result.X * 3.1f + Result.Z * 2.7f;
        Result = Result + Side * (std::sin(TimeSeconds * 7.3f + Phase) * 0.02f * Flutter);
        Result.Y += std::sin(TimeSeconds * 5.1f + Phase * 1.3f) * 0.015f * Flutter;
        Result = Result + Direction * (std::sin(TimeSeconds * 6.2f + Phase * 0.7f) * 0.02f * Flutter);
    }

    // Cantilever trunk sway. Height squared keeps the root anchored.
    const float Sway = Settings.TrunkFlex * Strength * 0.035f * Attributes.Height * Attributes.Height * Settings.TreeHeightM;
    const float Wave = WindWave(TimeSeconds * 0.85f) * 0.7f + 0.3f;
    Result = Result + Direction * (Sway * Wave);
    Result = Result + Side * (Sway * 0.2f * WindWave(TimeSeconds * 0.55f + 2.0f));
    return Result;
}

float CanopyDeformer::MaximumDisplacement(
    const DeformerSettings& Settings,
    const WindSample& Wind) noexcept
{
    const float Strength = Clamp(Wind.Strength + Wind.Gust * Wind.Strength + Wind.Turbulence, 0.0f, 40.0f);
    return Settings.TrunkFlex * Strength * 0.035f * Settings.TreeHeightM * 1.25f +
           Settings.LimbFlex * Strength * 0.12f * Settings.TreeHeightM * 0.55f;
}

} // namespace Frontier::Vegetation
