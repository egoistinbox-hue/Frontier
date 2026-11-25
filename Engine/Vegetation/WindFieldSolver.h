/*============================================================================================================================================
                                                       WINDFIELDSOLVER.H
============================================================================================================================================*/
// One wind field for the whole forest: mesh sway, leaf flutter and SDF proxy motion all resolve the
// same component list. Component superposition matches Slate/ProjectZeroEditor/WindSpecification.js;
// shear, veer, gust, turbulence and steadiness match GeometricRaster::AtmosphericWindParameters.

#pragma once

#include "Engine/Vegetation/VegetationMath.h"

#include <cstdint>
#include <vector>

namespace Frontier::Vegetation
{

enum class WindComponentType : uint8_t
{
    Directional = 0,
    Gust        = 1,
    Tornado     = 2,
    Radial      = 3,
};

struct WindComponent
{
    WindComponentType Type       = WindComponentType::Directional;
    uint32_t          Identifier = 0u; // Stable token from the Outliner wind entry.
    bool              Enabled    = true;
    float             X          = 0.0f;  // [m]
    float             Z          = 0.0f;  // [m]
    float             Radius     = 260.0f;// [m]
    float             Strength   = 7.0f;  // [m/s]
    float             BearingDeg = 250.0f;// [deg]
    float             Frequency  = 0.30f; // [Hz]
};

struct AtmosphericWindSettings
{
    bool  Enabled          = true;
    float SpeedMps         = 7.0f;   // [m/s]
    float BearingDeg       = 250.0f; // [deg]
    float ShearPerKm       = 0.35f;  // [1/km]
    float VeerDegPerKm     = 12.0f;  // [deg/km]
    float GustStrength     = 0.25f;  // [0..1]
    float GustFrequencyHz  = 0.30f;  // [Hz]
    float Turbulence       = 0.30f;  // [0..1]
    float Steadiness       = 1.00f;  // [0..1]
};

struct WindSample
{
    Vec3  Velocity    {};    // [m/s]
    Vec3  Direction   {1.0f, 0.0f, 0.0f};
    float Strength    = 0.0f;// [m/s]
    float Gust        = 0.0f;// [0..~1.5]
    float Turbulence  = 0.0f;// [0..1]
    float Curl        = 0.0f;// [1/s]
};

class WindFieldSolver
{
public:
    void ConfigureAtmosphere(const AtmosphericWindSettings& Settings) noexcept { Atmosphere = Settings; }
    [[nodiscard]] const AtmosphericWindSettings& QueryAtmosphere() const noexcept { return Atmosphere; }

    void ClearComponents() noexcept { Components.clear(); }
    void AddComponent(const WindComponent& Component) noexcept { Components.push_back(Component); }
    [[nodiscard]] const std::vector<WindComponent>& QueryComponents() const noexcept { return Components; }

    // Resolves the shared field at a world point. Height uses local Y-up metres.
    [[nodiscard]] WindSample Resolve(float X, float Y, float Z, float TimeSeconds) const noexcept;

    // Per-tree phase used to decorrelate identical instances without creating per-tree wind components.
    [[nodiscard]] static float InstancePhase(uint32_t InstanceToken) noexcept { return Hash01(InstanceToken); }

private:
    AtmosphericWindSettings     Atmosphere {};
    std::vector<WindComponent>  Components {};
};

} // namespace Frontier::Vegetation
