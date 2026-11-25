/*============================================================================================================================================
                                                     BOTANICALINSPECTORSECTION.CPP
============================================================================================================================================*/
// 🧩 Native Frontier Editor Botanical Inspector Section — 100% Frontier Editor Control Palette & Slider Geometry.

//------------------------------------------------------------------------------------------------------------------------
//                                                        INCLUDES
//------------------------------------------------------------------------------------------------------------------------

#include "Engine/Components/Panes/BotanicalInspectorSection.h"
#include "Engine/Components/Controls/CapsuleButton.h"
#include "Engine/Components/Controls/ExclusiveSelector.h"
#include "Engine/Components/Controls/ScalarSlider.h"

#include <algorithm>
#include <cstdio>

namespace Frontier
{

namespace BotanicalInspectorSection
{

float Construct(
    PixelSpace&                                           Surface,
    const Rectangle2D                                     PaneBounds,
    GeometrySpace::Botanical::BotanicalSpeciesDefinition& Species,
    BotanicalInspectorEditState&                          State,
    const ControlPointer&                                 Pointer,
    const float                                           Opacity) noexcept
{
    using namespace GeometrySpace::Botanical;

    State.Changed = false;
    const auto& Colors = ControlAppearance::Colors();

    if (!Pointer.Down)
    {
        State.ActiveSliderIndex = -1;
    }

    const float padX = ControlMetrics::SectionPadding;
    const float x    = PaneBounds.X + padX;
    const float w    = std::max(120.0f, PaneBounds.Width - 2.0f * padX);
    float       y    = PaneBounds.Y + 12.0f;

    // 1. Section Header: Botanical Species & Growth Form
    y = ControlAppearance::ConstructSectionHeading(
        Surface, x, y, w,
        "Botanical Generator",
        "Welded genus-0 quad manifold + 2.5D Thin-Leaf SDF",
        Colors.Text, Colors.TextDim, Opacity);
    y += 10.0f;

    // Growth Form Segmented Bar (Exact Frontier Exclusive Segmented Control)
    {
        const Rectangle2D row = ControlAppearance::ConstructLabeledRow(Surface, x, y, w, "Growth Form", Colors.TextDim, Opacity);
        static constexpr const char* kForms[3] = { "Fern", "Palm", "Tree" };
        const uint32_t currentIdx = static_cast<uint32_t>(Species.GrowthForm);
        uint32_t selectedIdx = currentIdx;
        const auto c = CapsuleButton::ConstructSegmented(Surface, row, kForms, 3u, currentIdx, Pointer, selectedIdx, Opacity);
        if (c.Pressed && selectedIdx != currentIdx && selectedIdx < 3u)
        {
            Species.GrowthForm = static_cast<BotanicalGrowthForm>(selectedIdx);
            State.Changed = true;
        }
        y = row.Bottom() + 14.0f;
    }

    auto emitSlider = [&](const int32_t id, const char* label, const char* fmt, const char* unit,
                          float& value, const float minV, const float maxV) noexcept
    {
        const Rectangle2D row = ControlAppearance::ConstructLabeledRow(Surface, x, y, w, label, Colors.TextDim, Opacity);
        char numBuf[32] {};
        std::snprintf(numBuf, sizeof(numBuf), fmt, static_cast<double>(value));

        const bool dragging = (State.ActiveSliderIndex == id);
        float updated = value;
        const auto c = ScalarSlider::ConstructWithReadout(
            Surface, row, numBuf, unit, minV, maxV, value, dragging, Pointer, updated, Opacity);
        if (c.Pressed)
        {
            State.ActiveSliderIndex = id;
        }
        if ((c.Pressed || dragging) && updated != value)
        {
            value = updated;
            State.Changed = true;
        }
        y = row.Bottom() + 14.0f;
    };

    // 2. Growth-Form-Specific Exact Frontier Sliders
    if (Species.GrowthForm == BotanicalGrowthForm::Tree)
    {
        emitSlider(0, "Trunk Height",    "%.2f", "m",   Species.Trunk.HeightMeters,      3.0f,  16.0f);
        emitSlider(1, "Base Radius",     "%.2f", "m",   Species.Trunk.BaseRadiusMeters,  0.15f,  1.20f);
        emitSlider(2, "Root Spread",     "%.2f", "m",   Species.Roots.SpreadMeters,      1.0f,   5.5f);
        emitSlider(3, "Branch Angle",    "%.0f", "deg", Species.Tree.BranchAngleDeg,    22.0f,  75.0f);
        emitSlider(4, "Leaf Density",    "%.2f", "x",   Species.Tree.LeafDensity,        0.35f,  2.00f);
    }
    else if (Species.GrowthForm == BotanicalGrowthForm::Palm)
    {
        emitSlider(10, "Trunk Height",   "%.2f", "m",   Species.Trunk.HeightMeters,      3.0f,  16.0f);
        emitSlider(11, "Trunk Lean",     "%.0f", "deg", Species.Palm.TrunkLeanDeg,       0.0f,  28.0f);
        emitSlider(12, "Frond Length",   "%.2f", "m",   Species.Palm.FrondLengthMeters,  1.5f,   5.5f);
        emitSlider(13, "Frond Arch",     "%.0f", "deg", Species.Palm.FrondArchDeg,      25.0f, 110.0f);
        emitSlider(14, "Trunk Relief",   "%.2f", "x",   Species.Palm.TrunkRelief,        0.0f,   1.0f);
    }
    else
    {
        emitSlider(20, "Frond Length",   "%.2f", "m",   Species.Fern.FrondLengthMeters,  0.30f,  1.80f);
        emitSlider(21, "Arch Droop",     "%.0f", "deg", Species.Fern.ArchDroopDeg,      15.0f, 120.0f);
        emitSlider(22, "Rosette Angle",  "%.0f", "deg", Species.Fern.RosetteAngleDeg,   15.0f,  72.0f);
        emitSlider(23, "Lamina Camber",  "%.2f", "x",   Species.Fern.LaminaCamber,       0.0f,   0.45f);
    }

    // 3. Wind & SDF Physics Sliders + Native Toggle Switches
    ControlAppearance::ConstructHairline(Surface, x, y + 2.0f, w, Colors.Stroke.Faded(Opacity));
    y += 14.0f;

    emitSlider(30, "Wind Sensitivity", "%.2f", "x",   Species.WindAndMotion.WindSensitivity,   0.05f, 1.80f);
    emitSlider(31, "Rustle Frequency", "%.2f", "Hz",  Species.WindAndMotion.RustleFrequencyHz, 0.20f, 4.50f);
    emitSlider(32, "Detach Wind",      "%.1f", "m/s", Species.Leaves.DetachWindMps,            6.0f, 30.0f);

    // Toggle Switch: Noisy Bark Capsules
    {
        const float toggleX = x + w - ControlMetrics::SwitchWidth;
        const Rectangle2D labelRect { x, y, w - ControlMetrics::SwitchWidth - 10.0f, ControlMetrics::SwitchHeight };
        ControlAppearance::TextLeading(Surface, labelRect, 0.0f, Colors.TextDim.Faded(Opacity), "Noisy Bark Capsules", 12.5f);
        const auto c = ExclusiveSelector::Construct(Surface, toggleX, y, Species.Sdf.UseNoisyCapsules, Pointer, Opacity);
        if (c.Pressed)
        {
            Species.Sdf.UseNoisyCapsules = !Species.Sdf.UseNoisyCapsules;
            State.Changed = true;
        }
        y += ControlMetrics::SwitchHeight + 12.0f;
    }

    // Toggle Switch: Detached Leaf Jolt Collision
    {
        const float toggleX = x + w - ControlMetrics::SwitchWidth;
        const Rectangle2D labelRect { x, y, w - ControlMetrics::SwitchWidth - 10.0f, ControlMetrics::SwitchHeight };
        ControlAppearance::TextLeading(Surface, labelRect, 0.0f, Colors.TextDim.Faded(Opacity), "Detached Leaf Physics", 12.5f);
        const auto c = ExclusiveSelector::Construct(Surface, toggleX, y, Species.Leaves.CanDetach, Pointer, Opacity);
        if (c.Pressed)
        {
            Species.Leaves.CanDetach = !Species.Leaves.CanDetach;
            State.Changed = true;
        }
        y += ControlMetrics::SwitchHeight + 12.0f;
    }

    return y;
}

} // namespace BotanicalInspectorSection

} // namespace Frontier
