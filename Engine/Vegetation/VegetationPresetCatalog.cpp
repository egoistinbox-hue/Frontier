/*============================================================================================================================================
                                                    VEGETATIONPRESETCATALOG.CPP
============================================================================================================================================*/

#include "Engine/Vegetation/VegetationPresetCatalog.h"

#include <algorithm>

namespace Frontier::Vegetation
{

namespace
{
// Generated from Slate src/tree/params.ts (TREE_PRESETS + PRESET_GROUPS) and src/plant/grassParams.ts (GRASS_GROUPS).
constexpr std::array<VegetationPreset, 51> Presets
{{
    {"English Oak", "Oaks", PlantKind::Tree, CrownShape::Hemispherical, 16.0f, 2.0f, 4u, 0.022f, {1u, 14u, 22u, 14u}, 12u, 0.14f, 6u, 0.72f},
    {"Quaking Aspen", "Forest · broadleaf", PlantKind::Tree, CrownShape::TendFlame, 13.0f, 3.0f, 3u, 0.015f, {1u, 45u, 26u, 1u}, 30u, 0.17f, 4u, 1.15f},
    {"Black Tupelo", "Forest · broadleaf", PlantKind::Tree, CrownShape::TaperedCylindrical, 23.0f, 5.0f, 4u, 0.015f, {1u, 55u, 20u, 12u}, 14u, 0.2f, 5u, 0.72f},
    {"California Black Oak", "Oaks", PlantKind::Tree, CrownShape::Hemispherical, 10.0f, 2.0f, 3u, 0.018f, {1u, 24u, 60u, 0u}, 20u, 0.2f, 6u, 0.72f},
    {"Southern Live Oak", "Oaks", PlantKind::Tree, CrownShape::Hemispherical, 11.0f, 2.0f, 4u, 0.036f, {1u, 10u, 22u, 14u}, 14u, 0.08f, 7u, 0.72f},
    {"White Oak", "Oaks", PlantKind::Tree, CrownShape::Hemispherical, 17.0f, 3.0f, 4u, 0.028f, {1u, 13u, 24u, 14u}, 12u, 0.16f, 6u, 0.72f},
    {"Northern Red Oak", "Oaks", PlantKind::Tree, CrownShape::Spherical, 26.0f, 3.0f, 4u, 0.02f, {1u, 13u, 24u, 14u}, 12u, 0.18f, 6u, 0.72f},
    {"Valley Oak", "Oaks", PlantKind::Tree, CrownShape::Hemispherical, 22.0f, 3.0f, 4u, 0.03f, {1u, 12u, 22u, 16u}, 14u, 0.12f, 7u, 0.72f},
    {"Pin Oak", "Oaks", PlantKind::Tree, CrownShape::Conical, 20.0f, 3.0f, 4u, 0.019f, {1u, 40u, 22u, 8u}, 16u, 0.12f, 5u, 0.72f},
    {"Cork Oak", "Oaks", PlantKind::Tree, CrownShape::Hemispherical, 11.0f, 2.0f, 4u, 0.04f, {1u, 9u, 16u, 12u}, 14u, 0.07f, 6u, 0.72f},
    {"Silver Birch", "Forest · broadleaf", PlantKind::Tree, CrownShape::Cylindrical, 18.0f, 4.0f, 3u, 0.013f, {1u, 28u, 40u, 0u}, 40u, 0.15f, 4u, 1.15f},
    {"Weeping Willow", "Forest · broadleaf", PlantKind::Tree, CrownShape::TaperedCylindrical, 15.0f, 3.0f, 4u, 0.03f, {1u, 14u, 18u, 40u}, 15u, 0.13f, 6u, 1.15f},
    {"Scots Pine", "Forest · conifers", PlantKind::Tree, CrownShape::Conical, 22.0f, 4.0f, 3u, 0.014f, {1u, 42u, 24u, 0u}, 60u, 0.1f, 4u, 0.45f},
    {"Coast Redwood", "Forest · conifers", PlantKind::Tree, CrownShape::TaperedCylindrical, 70.0f, 15.0f, 3u, 0.017f, {1u, 90u, 26u, 0u}, 40u, 0.14f, 7u, 0.45f},
    {"Norway Spruce", "Forest · conifers", PlantKind::Tree, CrownShape::Conical, 32.0f, 6.0f, 3u, 0.012f, {1u, 170u, 26u, 0u}, 60u, 0.09f, 5u, 0.45f},
    {"Bamboo", "Jungle", PlantKind::Tree, CrownShape::Cylindrical, 11.0f, 3.0f, 3u, 0.0075f, {1u, 36u, 8u, 0u}, 30u, 0.12f, 0u, 1.15f},
    {"Umbrella Thorn", "Savanna", PlantKind::Tree, CrownShape::InverseConical, 8.0f, 1.5f, 4u, 0.032f, {1u, 20u, 16u, 12u}, 20u, 0.08f, 5u, 0.72f},
    {"Baobab", "Savanna", PlantKind::Tree, CrownShape::Hemispherical, 16.0f, 3.0f, 4u, 0.15f, {1u, 16u, 10u, 6u}, 10u, 0.14f, 6u, 0.72f},
    {"European Beech", "Forest · broadleaf", PlantKind::Tree, CrownShape::Hemispherical, 24.0f, 3.0f, 4u, 0.02f, {1u, 16u, 22u, 16u}, 22u, 0.11f, 6u, 0.72f},
    {"Sugar Maple", "Forest · broadleaf", PlantKind::Tree, CrownShape::Spherical, 24.0f, 3.0f, 4u, 0.019f, {1u, 16u, 22u, 16u}, 20u, 0.15f, 6u, 1.15f},
    {"Douglas Fir", "Forest · conifers", PlantKind::Tree, CrownShape::Conical, 55.0f, 8.0f, 3u, 0.012f, {1u, 130u, 24u, 0u}, 30u, 0.05f, 6u, 0.45f},
    {"Kapok", "Jungle", PlantKind::Tree, CrownShape::InverseConical, 50.0f, 6.0f, 4u, 0.022f, {1u, 8u, 18u, 14u}, 16u, 0.12f, 7u, 0.72f},
    {"Rain-Forest Fig", "Jungle", PlantKind::Tree, CrownShape::Hemispherical, 28.0f, 4.0f, 4u, 0.03f, {1u, 12u, 20u, 14u}, 18u, 0.18f, 8u, 0.72f},
    {"Marula", "Savanna", PlantKind::Tree, CrownShape::Hemispherical, 12.0f, 2.0f, 4u, 0.034f, {1u, 8u, 16u, 12u}, 14u, 0.1f, 5u, 0.72f},
    {"Fever Tree", "Savanna", PlantKind::Tree, CrownShape::InverseConical, 16.0f, 3.0f, 4u, 0.018f, {1u, 10u, 14u, 12u}, 16u, 0.07f, 5u, 0.72f},
    {"Joshua Tree", "Desert", PlantKind::Tree, CrownShape::Spherical, 5.5f, 1.5f, 3u, 0.07f, {1u, 4u, 3u, 0u}, 110u, 0.32f, 4u, 0.18f},
    {"Desert Ironwood", "Desert", PlantKind::Tree, CrownShape::Hemispherical, 7.0f, 1.5f, 4u, 0.035f, {1u, 8u, 14u, 12u}, 14u, 0.05f, 5u, 0.18f},
    {"Saguaro Cactus", "Desert", PlantKind::Tree, CrownShape::TaperedCylindrical, 8.5f, 1.2f, 3u, 0.065f, {1u, 3u, 2u, 0u}, 0u, 0.0f, 5u, 0.18f},
    {"Golden Barrel Cactus", "Desert", PlantKind::Tree, CrownShape::Spherical, 1.45f, 0.12f, 1u, 0.24f, {0u, 0u, 0u, 0u}, 0u, 0.0f, 4u, 0.18f},
    {"Organ Pipe Cactus", "Desert", PlantKind::Tree, CrownShape::Cylindrical, 6.2f, 0.9f, 2u, 0.052f, {1u, 2u, 0u, 0u}, 0u, 0.0f, 6u, 0.18f},
    {"Agave Americana", "Desert", PlantKind::Tree, CrownShape::Hemispherical, 1.25f, 0.12f, 2u, 0.04f, {1u, 9u, 0u, 0u}, 72u, 0.72f, 0u, 0.18f},
    {"Aloe Vera", "Desert", PlantKind::Tree, CrownShape::Hemispherical, 0.62f, 0.08f, 2u, 0.045f, {1u, 8u, 0u, 0u}, 44u, 0.34f, 0u, 0.18f},
    {"Ocotillo", "Desert", PlantKind::Tree, CrownShape::TaperedCylindrical, 4.2f, 0.7f, 3u, 0.014f, {1u, 10u, 9u, 0u}, 50u, 0.11f, 0u, 0.45f},
    {"Dasylirion Sotol", "Desert", PlantKind::Tree, CrownShape::Hemispherical, 1.05f, 0.1f, 2u, 0.05f, {1u, 10u, 0u, 0u}, 72u, 0.54f, 0u, 0.18f},
    {"Bristlecone Pine", "Rocky terrain", PlantKind::Tree, CrownShape::TendFlame, 7.0f, 2.0f, 3u, 0.075f, {1u, 7u, 16u, 0u}, 220u, 0.07f, 6u, 0.45f},
    {"Rowan", "Rocky terrain", PlantKind::Tree, CrownShape::Spherical, 9.0f, 2.0f, 4u, 0.02f, {1u, 10u, 16u, 12u}, 18u, 0.14f, 5u, 0.72f},
    {"Japanese Maple", "Forest · broadleaf", PlantKind::Tree, CrownShape::Hemispherical, 6.0f, 1.0f, 4u, 0.03f, {1u, 8u, 14u, 12u}, 24u, 0.09f, 5u, 1.15f},
    {"Lawn Turf", "Grasses · turf & meadow", PlantKind::Grass, CrownShape::Cylindrical, 1.0f, 0.2f, 1u, 0.01f, {0u, 0u, 0u, 0u}, 0u, 0.06f, 0u, 0.90f},
    {"Meadow Grass", "Grasses · turf & meadow", PlantKind::Grass, CrownShape::Cylindrical, 1.0f, 0.2f, 1u, 0.01f, {0u, 0u, 0u, 0u}, 0u, 0.06f, 0u, 0.90f},
    {"Timothy", "Grasses · turf & meadow", PlantKind::Grass, CrownShape::Cylindrical, 1.0f, 0.2f, 1u, 0.01f, {0u, 0u, 0u, 0u}, 0u, 0.06f, 0u, 0.90f},
    {"Red Oat Grass", "Grasses · turf & meadow", PlantKind::Grass, CrownShape::Cylindrical, 1.0f, 0.2f, 1u, 0.01f, {0u, 0u, 0u, 0u}, 0u, 0.06f, 0u, 0.90f},
    {"Blue Fescue", "Grasses · tussock", PlantKind::Grass, CrownShape::Cylindrical, 1.0f, 0.2f, 1u, 0.01f, {0u, 0u, 0u, 0u}, 0u, 0.06f, 0u, 0.90f},
    {"Fountain Grass", "Grasses · tussock", PlantKind::Grass, CrownShape::Cylindrical, 1.0f, 0.2f, 1u, 0.01f, {0u, 0u, 0u, 0u}, 0u, 0.06f, 0u, 0.90f},
    {"Marram Grass", "Grasses · tussock", PlantKind::Grass, CrownShape::Cylindrical, 1.0f, 0.2f, 1u, 0.01f, {0u, 0u, 0u, 0u}, 0u, 0.06f, 0u, 0.90f},
    {"Chinese Silver Grass", "Grasses · tussock", PlantKind::Grass, CrownShape::Cylindrical, 1.0f, 0.2f, 1u, 0.01f, {0u, 0u, 0u, 0u}, 0u, 0.06f, 0u, 0.90f},
    {"Pampas Grass", "Grasses · tussock", PlantKind::Grass, CrownShape::Cylindrical, 1.0f, 0.2f, 1u, 0.01f, {0u, 0u, 0u, 0u}, 0u, 0.06f, 0u, 0.90f},
    {"Wheat", "Grasses · cereals & reeds", PlantKind::Grass, CrownShape::Cylindrical, 1.0f, 0.2f, 1u, 0.01f, {0u, 0u, 0u, 0u}, 0u, 0.06f, 0u, 0.90f},
    {"Barley", "Grasses · cereals & reeds", PlantKind::Grass, CrownShape::Cylindrical, 1.0f, 0.2f, 1u, 0.01f, {0u, 0u, 0u, 0u}, 0u, 0.06f, 0u, 0.90f},
    {"Oat", "Grasses · cereals & reeds", PlantKind::Grass, CrownShape::Cylindrical, 1.0f, 0.2f, 1u, 0.01f, {0u, 0u, 0u, 0u}, 0u, 0.06f, 0u, 0.90f},
    {"Common Reed", "Grasses · cereals & reeds", PlantKind::Grass, CrownShape::Cylindrical, 1.0f, 0.2f, 1u, 0.01f, {0u, 0u, 0u, 0u}, 0u, 0.06f, 0u, 0.90f},
    {"Elephant Grass", "Grasses · cereals & reeds", PlantKind::Grass, CrownShape::Cylindrical, 1.0f, 0.2f, 1u, 0.01f, {0u, 0u, 0u, 0u}, 0u, 0.06f, 0u, 0.90f},
}};
} // namespace

const std::vector<VegetationPreset>& VegetationPresetCatalog::QueryAll() noexcept
{
    static const std::vector<VegetationPreset> Repository(Presets.begin(), Presets.end());
    return Repository;
}

const VegetationPreset* VegetationPresetCatalog::QueryPreset(std::string_view Name) noexcept
{
    const auto& Repository = QueryAll();
    const auto Found = std::find_if(Repository.begin(), Repository.end(),
        [Name](const VegetationPreset& Entry) { return Entry.Name == Name; });
    return Found == Repository.end() ? nullptr : &*Found;
}

std::vector<std::string_view> VegetationPresetCatalog::QueryGroupNames() noexcept
{
    std::vector<std::string_view> Result {};
    for (const VegetationPreset& Entry : QueryAll())
    {
        if (std::find(Result.begin(), Result.end(), Entry.Group) == Result.end())
        {
            Result.push_back(Entry.Group);
        }
    }
    return Result;
}

std::vector<const VegetationPreset*> VegetationPresetCatalog::QueryGroup(std::string_view Group) noexcept
{
    std::vector<const VegetationPreset*> Result {};
    for (const VegetationPreset& Entry : QueryAll())
    {
        if (Entry.Group == Group)
        {
            Result.push_back(&Entry);
        }
    }
    return Result;
}

std::vector<std::string_view> VegetationPresetCatalog::QuerySearchNames() noexcept
{
    std::vector<std::string_view> Result {};
    for (const VegetationPreset& Entry : QueryAll())
    {
        Result.push_back(Entry.Name);
    }
    return Result;
}

} // namespace Frontier::Vegetation
