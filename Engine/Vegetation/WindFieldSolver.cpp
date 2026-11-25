/*============================================================================================================================================
                                                       WINDFIELDSOLVER.CPP
============================================================================================================================================*/

#include "Engine/Vegetation/WindFieldSolver.h"

#include <algorithm>
#include <cmath>

namespace Frontier::Vegetation
{

WindSample WindFieldSolver::Resolve(float X, float Y, float Z, float TimeSeconds) const noexcept
{
    if (!Atmosphere.Enabled)
    {
        return {};
    }

    float VelocityX = 0.0f;
    float VelocityZ = 0.0f;

    if (Components.empty())
    {
        // Legacy single-wind configuration: one prevailing vector, no local falloff.
        const float Angle = Radians(Atmosphere.BearingDeg);
        VelocityX = std::sin(Angle) * Atmosphere.SpeedMps;
        VelocityZ = -std::cos(Angle) * Atmosphere.SpeedMps;
    }

    for (const WindComponent& Part : Components)
    {
        if (!Part.Enabled || Part.Strength <= 0.0f)
        {
            continue;
        }

        const float DeltaX = X - Part.X;
        const float DeltaZ = Z - Part.Z;
        const float Distance = std::hypot(DeltaX, DeltaZ);
        const float Radius = Distance / std::max(Part.Radius, 1.0f);
        const float Falloff = std::pow(std::max(0.0f, 1.0f - Radius * Radius), 2.0f);
        const float Angle = Radians(Part.BearingDeg);

        if (Part.Type == WindComponentType::Directional || Part.Type == WindComponentType::Gust)
        {
            const float Pulse = 0.65f + 0.35f * std::sin(6.2831853f * Part.Frequency * TimeSeconds);
            const float Amount = Part.Strength * (Part.Type == WindComponentType::Gust ? Falloff * Pulse : 1.0f);
            VelocityX += std::sin(Angle) * Amount;
            VelocityZ -= std::cos(Angle) * Amount;
        }
        else if (Distance > 1.0e-6f)
        {
            const float Amount = Part.Strength * Falloff * std::min(1.0f, Radius * 3.0f);
            if (Part.Type == WindComponentType::Tornado)
            {
                VelocityX += ((-DeltaZ - 0.18f * DeltaX) / Distance) * Amount;
                VelocityZ += ((DeltaX - 0.18f * DeltaZ) / Distance) * Amount;
            }
            else
            {
                VelocityX += (DeltaX / Distance) * Amount;
                VelocityZ += (DeltaZ / Distance) * Amount;
            }
        }
    }

    // Altitude shear and Ekman veer: the same quantities the atmosphere solver exposes to clouds and fog.
    const float AltitudeKm = std::max(0.0f, Y) / 1000.0f;
    const float Shear = 1.0f + Atmosphere.ShearPerKm * AltitudeKm;
    VelocityX *= Shear;
    VelocityZ *= Shear;

    const float VeerAngle = Radians(Atmosphere.VeerDegPerKm * AltitudeKm);
    const float VeerCosine = std::cos(VeerAngle);
    const float VeerSine = std::sin(VeerAngle);
    const float VeeredX = VelocityX * VeerCosine - VelocityZ * VeerSine;
    const float VeeredZ = VelocityX * VeerSine + VelocityZ * VeerCosine;
    VelocityX = VeeredX;
    VelocityZ = VeeredZ;

    // Gust envelope shared by the tree; phase lag by height is applied in the vertex deformer.
    const float GustWave = 0.5f + 0.5f * std::sin(6.2831853f * Atmosphere.GustFrequencyHz * TimeSeconds);
    const float Gust = Atmosphere.GustStrength * GustWave * (0.35f + 0.65f * Atmosphere.Steadiness);
    const float Turbulence = Atmosphere.Turbulence * (1.05f - 0.45f * Atmosphere.Steadiness);

    WindSample Sample {};
    Sample.Velocity = {VelocityX, 0.0f, VelocityZ};
    Sample.Strength = Length(Sample.Velocity);
    Sample.Direction = Sample.Strength > 1.0e-6f ? Sample.Velocity * (1.0f / Sample.Strength) : Vec3 {1.0f, 0.0f, 0.0f};
    Sample.Gust = Gust;
    Sample.Turbulence = Turbulence;
    Sample.Curl = Turbulence * Sample.Strength * 0.11f;
    return Sample;
}

} // namespace Frontier::Vegetation
