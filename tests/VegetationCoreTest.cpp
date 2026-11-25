/*============================================================================================================================================
                                                     VEGETATIONCORETEST.CPP
============================================================================================================================================*/
// Standalone verification of the vegetation porting scaffold: g++ -std=c++20 -I. tests/VegetationCoreTest.cpp
// plus the Engine/Vegetation/*.cpp units (see scripts/build_vegetation_core.sh).

#include "Engine/Vegetation/CanopyDeformer.h"
#include "Engine/Vegetation/ClusterLodSelector.h"
#include "Engine/Vegetation/DistanceProxySet.h"
#include "Engine/Vegetation/FractureSpecification.h"
#include "Engine/Vegetation/VegetationInstanceRegister.h"
#include "Engine/Vegetation/VegetationPresetCatalog.h"
#include "Engine/Vegetation/WindFieldSolver.h"

#include <cassert>
#include <cmath>
#include <iostream>

using namespace Frontier::Vegetation;

int main()
{
    // Preset catalogue: every Slate tree and grass preset is present and queryable.
    const auto& Presets = VegetationPresetCatalog::QueryAll();
    assert(Presets.size() == 51u);
    assert(VegetationPresetCatalog::QueryPreset("English Oak") != nullptr);
    assert(VegetationPresetCatalog::QueryPreset("Dasylirion Sotol") != nullptr);
    assert(VegetationPresetCatalog::QueryPreset("Pampas Grass") != nullptr);
    assert(VegetationPresetCatalog::QueryPreset("Not A Species") == nullptr);
    assert(VegetationPresetCatalog::QueryPreset("Coast Redwood")->HeightM == 70.0f);
    assert(VegetationPresetCatalog::QueryGroup("Oaks").size() == 8u);

    // One wind field: local gust moves the sample; shear changes it with height; disabling stops all motion.
    WindFieldSolver Field;
    AtmosphericWindSettings Atmosphere {};
    Atmosphere.SpeedMps = 7.0f;
    Atmosphere.BearingDeg = 250.0f;
    Atmosphere.ShearPerKm = 0.35f;
    Field.ConfigureAtmosphere(Atmosphere);
    const WindSample Base = Field.Resolve(0.0f, 0.0f, 0.0f, 0.0f);
    assert(std::abs(Base.Strength - 7.0f) < 0.01f);
    assert(Field.Resolve(0.0f, 500.0f, 0.0f, 0.0f).Strength > Base.Strength);

    WindComponent Gust {};
    Gust.Type = WindComponentType::Gust;
    Gust.Strength = 12.0f;
    Gust.Radius = 100.0f;
    Gust.BearingDeg = 250.0f;
    Gust.Frequency = 0.3f;
    Field.AddComponent(Gust);
    assert(Field.Resolve(0.0f, 0.0f, 0.0f, 0.0f).Strength > Base.Strength);

    // Deformer: roots stay anchored, crowns move, and a stronger field moves them further.
    const VegetationPreset* Oak = VegetationPresetCatalog::QueryPreset("English Oak");
    DeformerSettings Settings {};
    Settings.TreeHeightM = Oak->HeightM;
    Settings.TrunkFlex = Oak->WindFlex;
    Settings.LimbFlex = Oak->WindFlex;
    Settings.DetailFlex = Oak->WindFlex;

    const Vec3 Root {0.0f, 0.0f, 0.0f};
    const Vec3 Crown {0.0f, Oak->HeightM, 0.0f};
    const WindVertexAttributes RootWind {0.0f, 0.0f, 0.0f, 0.0f};
    const WindVertexAttributes CrownWind {1.0f, 0.5f, 0.3f, 0.5f};
    const Vec3 DeformedRoot = CanopyDeformer::Deform(Root, Root, RootWind, Base, Settings, 1.0f);
    const Vec3 DeformedCrown = CanopyDeformer::Deform(Crown, Crown, CrownWind, Base, Settings, 1.0f);
    assert(Length(DeformedRoot) < 1.0e-5f);
    assert(Length(DeformedCrown - Crown) > 0.01f);
    assert(CanopyDeformer::MaximumDisplacement(Settings, Base) > 0.0f);

    // Cluster cut: increasing distance or error budget never selects a finer level.
    ClusterLodSelector Selector;
    Selector.ConfigureLevels({0.01f, 0.12f, 0.9f}, 5.0f);
    const ClusterCullConfiguration Cull {};
    const uint32_t Near = Selector.SelectLevel(12u, 10.0f, 900.0f, Cull);
    const uint32_t Far = Selector.SelectLevel(12u, 400.0f, 900.0f, Cull);
    assert(Far >= Near);
    assert(ClusterLodSelector::ScreenErrorPixels(0.9f, 400.0f, 900.0f) <
           ClusterLodSelector::ScreenErrorPixels(0.9f, 40.0f, 900.0f));
    assert(ClusterLodSelector::WindSafeRadius(Selector.QueryClusters().front(), Settings, Base) > 5.0f);

    // SDF proxies: inside is negative, wind moves the canopy, and pose updates are deterministic.
    DistanceProxySet Proxies;
    Proxies.Build(*Oak, 9u);
    assert(Proxies.QueryProxies().size() > 3u);
    Proxies.UpdatePose(Base, Settings, 0.0f);
    assert(Proxies.Evaluate({0.0f, 1.0f, 0.0f}) < 0.0f);
    const Vec3 CanopyBefore = Proxies.QueryProxies().back().JointEnd;
    Proxies.UpdatePose(Base, Settings, 2.0f);
    assert(Length(Proxies.QueryProxies().back().JointEnd - CanopyBefore) > 1.0e-4f);

    // Fracture: stronger impacts produce more cut planes and more pieces.
    const auto WeakCuts = FractureSpecification::BuildTrunkCuts(*Oak, 5u, 4.0f, 0.1f);
    const auto StrongCuts = FractureSpecification::BuildTrunkCuts(*Oak, 5u, 4.0f, 0.9f);
    assert(StrongCuts.size() > WeakCuts.size());
    assert(FractureSpecification::QueryPieceCount(*Oak, StrongCuts) > StrongCuts.size());

    // Instance register: 10k records and token lookup.
    VegetationInstanceRegister Instances;
    Instances.Reserve(10000u);
    for (uint32_t Index = 1u; Index <= 10000u; ++Index)
    {
        VegetationInstanceRecord Record {};
        Record.SlotToken = Index;
        Record.PresetOrdinal = Index % static_cast<uint32_t>(Presets.size());
        Record.WindPhase = WindFieldSolver::InstancePhase(Index);
        Instances.Insert(Record);
    }
    assert(Instances.QueryAll().size() == 10000u);
    assert(Instances.QueryVisibleCount() == 10000u);
    assert(Instances.Query(5000u) != nullptr);
    Instances.Edit(5000u)->Visible = false;
    assert(Instances.QueryVisibleCount() == 9999u);

    std::cout << "Vegetation core checks passed (" << Presets.size() << " presets, "
              << Instances.QueryAll().size() << " instances).\n";
    return 0;
}
