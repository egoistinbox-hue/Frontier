/*============================================================================================================================================
                                                    VEGETATIONPRESETCATALOG.H
============================================================================================================================================*/
// C++ mirror of the Slate species list (37 trees + 14 grasses). Values are the runtime-authoring subset
// extracted from params.ts: name, group, crown envelope, height, recursion depth, trunk ratio,
// per-level branch counts, leaves, leaf scale and root count. The full botanical blocks stay in
// src/tree/params.ts until the Weber-Penn skeleton / welded mesher are ported file-by-file.

#pragma once

#include <array>
#include <cstdint>
#include <string_view>
#include <vector>

namespace Frontier::Vegetation
{

enum class PlantKind : uint8_t
{
    Tree  = 0,
    Grass = 1,
};

enum class CrownShape : uint8_t
{
    Conical = 0,
    Spherical = 1,
    Hemispherical = 2,
    Cylindrical = 3,
    TaperedCylindrical = 4,
    Flame = 5,
    InverseConical = 6,
    TendFlame = 7,
};

struct VegetationPreset
{
    std::string_view Name       {};
    std::string_view Group      {};
    PlantKind        Kind       = PlantKind::Tree;
    CrownShape       Shape      = CrownShape::Hemispherical;
    float            HeightM    = 10.0f;
    float            HeightVarianceM = 2.0f;
    uint32_t         Levels     = 3u;
    float            TrunkRatio = 0.02f;
    std::array<uint32_t, 4> Branches {}; // Children created by levels 0..3.
    uint32_t         LeavesPerTwig = 0u;
    float            LeafScaleM = 0.0f;
    uint32_t         RootCount  = 0u;
    float            WindFlex   = 0.7f; // Trunk + limb compliance multiplier authored for the demo.
};

class VegetationPresetCatalog
{
public:
    [[nodiscard]] static const std::vector<VegetationPreset>& QueryAll() noexcept;
    [[nodiscard]] static const VegetationPreset* QueryPreset(std::string_view Name) noexcept;
    [[nodiscard]] static std::vector<std::string_view> QueryGroupNames() noexcept;
    [[nodiscard]] static std::vector<const VegetationPreset*> QueryGroup(std::string_view Group) noexcept;
    [[nodiscard]] static std::vector<std::string_view> QuerySearchNames() noexcept;
};

} // namespace Frontier::Vegetation
