/*============================================================================================================================================
                                                      BOTANICALINSPECTORSECTION.H
============================================================================================================================================*/
// 🧩 Native Frontier Editor Botanical Inspector Section using Frontier's exact `ScalarSlider::ConstructWithReadout`,
//    `CapsuleButton::ConstructSegmented`, `ExclusiveSelector::Construct`, and `ControlAppearance::ConstructLabeledRow` controls!

#pragma once

//------------------------------------------------------------------------------------------------------------------------
//                                                        INCLUDES
//------------------------------------------------------------------------------------------------------------------------

#include "Engine/Components/Controls/ControlAppearance.h"
#include "Engine/GeometrySpace/Procedural/Botanical/BotanicalSpeciesSchema.h"

#include <cstdint>

namespace Frontier
{

//------------------------------------------------------------------------------------------------------------------------
//                                                       STRUCTURES
//------------------------------------------------------------------------------------------------------------------------

struct BotanicalInspectorEditState
{
    int32_t ActiveSliderIndex = -1; // [-] - Currently dragged slider index (-1 when idle)
    bool    Changed           = false;
};

//------------------------------------------------------------------------------------------------------------------------
//                                                  FUNCTION PROTOTYPES
//------------------------------------------------------------------------------------------------------------------------

namespace BotanicalInspectorSection
{

/// Renders the Botanical Species & Live Generator Inspector using Frontier's native Editor controls
/// (split readout capsule + thick neutral pill slider, segmented growth-form bar, and 46x26 toggle switches).
/// Returns the final vertical cursor Y after the last constructed section.
[[nodiscard]] float Construct(
    PixelSpace&                                                 Surface,
    Rectangle2D                                                 PaneBounds,
    GeometrySpace::Botanical::BotanicalSpeciesDefinition&       Species,
    BotanicalInspectorEditState&                                State,
    const ControlPointer&                                       Pointer,
    float                                                       Opacity = 1.0f) noexcept;

} // namespace BotanicalInspectorSection

} // namespace Frontier
