/*============================================================================================================================================
                                                    VEGETATIONINSTANCEREGISTER.H
============================================================================================================================================*/
// Structure-of-arrays instance records keyed by OutlinerSlotToken. Designed for 10k+ trees:
// no per-instance virtual calls, no per-tree wind component, 64 B padded stride for GPU upload.

#pragma once

#include "Engine/Vegetation/VegetationMath.h"
#include "Engine/Vegetation/VegetationPresetCatalog.h"

#include <algorithm>
#include <cstdint>
#include <vector>

namespace Frontier::Vegetation
{

struct alignas(64) VegetationInstanceRecord
{
    uint32_t SlotToken = 0u;      // OutlinerSlotToken of the generator entry.
    uint32_t PresetOrdinal = 0u;  // Index into VegetationPresetCatalog::QueryAll().
    uint32_t Seed = 1u;
    float    PositionX = 0.0f;    // [m]
    float    PositionY = 0.0f;    // [m]
    float    PositionZ = 0.0f;    // [m]
    float    Scale = 1.0f;
    float    YawDegrees = 0.0f;
    float    WindPhase = 0.0f;    // [0..1]
    uint8_t  LodLevel = 0u;
    bool     Visible = true;
    bool     Fractured = false;
};
static_assert(sizeof(VegetationInstanceRecord) == 64u, "Instance record must stay GPU-aligned.");

class VegetationInstanceRegister
{
public:
    void Reserve(std::size_t Capacity) noexcept { Records.reserve(Capacity); }

    uint32_t Insert(const VegetationInstanceRecord& Record) noexcept
    {
        Records.push_back(Record);
        return Record.SlotToken;
    }

    [[nodiscard]] const VegetationInstanceRecord* Query(uint32_t SlotToken) const noexcept
    {
        const auto Found = std::find_if(Records.begin(), Records.end(),
            [SlotToken](const VegetationInstanceRecord& Record) { return Record.SlotToken == SlotToken; });
        return Found == Records.end() ? nullptr : &*Found;
    }

    [[nodiscard]] VegetationInstanceRecord* Edit(uint32_t SlotToken) noexcept
    {
        const auto Found = std::find_if(Records.begin(), Records.end(),
            [SlotToken](VegetationInstanceRecord& Record) { return Record.SlotToken == SlotToken; });
        return Found == Records.end() ? nullptr : &*Found;
    }

    [[nodiscard]] const std::vector<VegetationInstanceRecord>& QueryAll() const noexcept { return Records; }
    [[nodiscard]] std::size_t QueryVisibleCount() const noexcept
    {
        return static_cast<std::size_t>(std::count_if(Records.begin(), Records.end(),
            [](const VegetationInstanceRecord& Record) { return Record.Visible; }));
    }

private:
    std::vector<VegetationInstanceRecord> Records {};
};

} // namespace Frontier::Vegetation
