/*============================================================================================================================================
                                                          BOTANICALGENERATOR.H
============================================================================================================================================*/
// 🧩 Unified C++20 Procedural Botanical Generator (Ferns -> Palms -> Trees/Oak) in Frontier Right-Hand +Z Up.
//    Ported faithfully from egoistm1inbox/Frontier (fernMesher, palmMesher, treeMesher) + coupled to
//    BotanicalThinLeafSdf (watertight noisy ball-jointed wood capsules + 2.5D thin-sheet leaf instances).

#pragma once

//------------------------------------------------------------------------------------------------------------------------
//                                                        INCLUDES
//------------------------------------------------------------------------------------------------------------------------

#include "Engine/GeometrySpace/Network/PolygonNetwork.h"
#include "Engine/GeometrySpace/Procedural/Botanical/BotanicalSpeciesSchema.h"
#include "Engine/GeometrySpace/Procedural/Botanical/BotanicalThinLeafSdf.h"

#include <array>
#include <cstdint>
#include <vector>

namespace Frontier::GeometrySpace::Botanical
{

//------------------------------------------------------------------------------------------------------------------------
//                                        GENERATED BOTANICAL MESH & OUTPUT PACKAGE
//------------------------------------------------------------------------------------------------------------------------

enum class BotanicalPartTag : uint8_t
{
    Wood   = 0u, // Bark, trunk, roots, stipe, rachis (UDIM 1001)
    Leaf   = 1u, // Pinnae, palm leaflets, tree leaves (UDIM 1002)
    Fruit  = 2u, // Crosiers, dates, coconuts, acorns (UDIM 1002)
};

struct BotanicalTriangle
{
    std::array<float, 3> V0       {};
    std::array<float, 3> V1       {};
    std::array<float, 3> V2       {};
    std::array<float, 3> RestV0   {};
    std::array<float, 3> RestV1   {};
    std::array<float, 3> RestV2   {};
    std::array<float, 3> Normal   { 0.0f, 0.0f, 1.0f };
    std::array<float, 3> ColorLin { 0.1f, 0.3f, 0.08f };
    float                WindFlex = 0.0f;
    float                Phase    = 0.0f;
    BotanicalPartTag     Part     = BotanicalPartTag::Wood;
};

struct BotanicalPlantBuildResult
{
    std::string                  SpeciesId      {};
    BotanicalGrowthForm          GrowthForm     = BotanicalGrowthForm::Fern;
    uint32_t                     Seed           = 42u;
    std::vector<BotanicalTriangle> Triangles    {};
    PolygonNetwork               Network        {};
    BotanicalSdfVolume           SdfVolume      {};
    std::array<float, 3>         BoundsMin      { 0.0f, 0.0f, 0.0f };
    std::array<float, 3>         BoundsMax      { 0.0f, 0.0f, 0.0f };
    uint32_t                     WoodTriCount   = 0u;
    uint32_t                     LeafTriCount   = 0u;
    uint32_t                     FruitTriCount  = 0u;
};

/// Generates a deterministic 3D botanical plant (Fern, Palm, or Tree) in Frontier Right-Hand +Z Up,
/// populating render triangles, PolygonNetwork, watertight noisy wood capsules, and 16^3 thin-leaf SDF bricks.
[[nodiscard]] BotanicalPlantBuildResult BuildBotanicalPlant(
    const BotanicalSpeciesDefinition& species,
    const LeafArchetypeSdfAtlas&      leafAtlas,
    uint32_t                          seed = 42u,
    uint32_t                          detailTier = 2u,
    bool                              buildPolygonNetwork = true);

/// Deforms a built plant's render triangles AND SDF volume synchronously using identical cantilever + rustle sway.
void ApplyWindPoseToPlant(
    BotanicalPlantBuildResult& plant,
    float                      bendAngleXRad,
    float                      bendAngleYRad,
    float                      gustTimeSec,
    float                      rustleAmp) noexcept;

} // namespace Frontier::GeometrySpace::Botanical
