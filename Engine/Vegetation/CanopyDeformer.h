/*============================================================================================================================================
                                                       CANOPYDEFORMER.H
============================================================================================================================================*/
// CPU reference for the exact three-tier wind vertex program in Slate src/viewer/shaders.ts.
// The GPU path is Engine/Shaders/Vegetation/TreeSway.slang; keep both implementations bit-comparable.

#pragma once

#include "Engine/Vegetation/VegetationMath.h"
#include "Engine/Vegetation/WindFieldSolver.h"

namespace Frontier::Vegetation
{

struct WindVertexAttributes
{
    float Height = 0.0f; // [0..1] normalised height, trunk cantilever weight.
    float Limb   = 0.0f; // [0..1] distance along a limb from its pivot.
    float Phase  = 0.0f; // [0..1] per-limb random phase.
    float Detail = 0.0f; // [0..1] twig/leaf flutter weight.
};

struct DeformerSettings
{
    float TrunkFlex = 1.0f;
    float LimbFlex  = 1.0f;
    float DetailFlex = 1.0f;
    float TreeHeightM = 10.0f;
};

class CanopyDeformer
{
public:
    // Deforms one rest-space vertex. Pivot is the limb root from the welded Slate mesh.
    [[nodiscard]] static Vec3 Deform(
        const Vec3& Position,
        const Vec3& Pivot,
        const WindVertexAttributes& Attributes,
        const WindSample& Wind,
        const DeformerSettings& Settings,
        float TimeSeconds) noexcept;

    // Conservative radius inflation so cluster frustum/Hi-Z culling cannot clip a swaying tree.
    [[nodiscard]] static float MaximumDisplacement(
        const DeformerSettings& Settings,
        const WindSample& Wind) noexcept;

    // Triangle-ish wave, ported verbatim from windWave() in shaders.ts.
    [[nodiscard]] static float WindWave(float Phase) noexcept;
};

} // namespace Frontier::Vegetation
