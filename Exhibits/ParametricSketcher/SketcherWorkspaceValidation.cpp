/*============================================================================================================================================
                                                    SKETCHERWORKSPACEVALIDATION.CPP
============================================================================================================================================*/
// 🧩 End-to-end validation of SketcherWorkspaceHost (docked Outliner/Viewport/DrawingSheet/Construct/Inspector + Vulkan B-rep + SVG icons + ProjectBrowser capability)

#include "Engine/Components/Appearance/ThemeRepository.h"
#include "Engine/Components/Appearance/TypographyRepository.h"
#include "Engine/Components/Controls/ControlAppearance.h"
#include "Engine/Components/Docking/WorkspaceDockContainer.h"
#include "Engine/Components/Panes/WorkspaceAppearance.h"
#include "Engine/GeometricRaster/VulkanInterchange.h"
#include "Engine/Input/ImGuiInputAdapter.h"
#include "Engine/Input/InputExchange.h"
#include "Engine/Input/InputExtension.h"
#include "Engine/GeometrySpace/Parametric/Blend/EdgeBlend.h"
#include "Engine/GeometrySpace/Parametric/Construction/BodyArrangement.h"
#include "Engine/GeometrySpace/Parametric/Geometry/SurfaceGeometry.h"
#include "Engine/Workspaces/ParametricSketcher/Document/SketcherDocument.h"
#include "Engine/Workspaces/ParametricSketcher/Document/SketcherImagePlane.h"
#include "Engine/Workspaces/ParametricSketcher/Interface/SketcherIcons.h"
#include "Engine/Workspaces/ParametricSketcher/Interface/SketcherOutliner.h"
#include "Engine/Workspaces/ParametricSketcher/Interface/SketcherProjectBrowser.h"
#include "Engine/Workspaces/ParametricSketcher/Interface/SketcherStyleSheet.h"
#include "Engine/Workspaces/ParametricSketcher/Interface/SketcherWorkspaceHost.h"
#include "Engine/Workspaces/WorkspaceCapabilityRegister.h"

#include <imgui.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <filesystem>

#ifndef FRONTIER_REPO_ROOT_DIR
#define FRONTIER_REPO_ROOT_DIR "."
#endif

#ifndef FRONTIER_COMPILED_SHADER_DIR
#define FRONTIER_COMPILED_SHADER_DIR "CompiledShaders"
#endif

namespace
{

using namespace Frontier;
using namespace Frontier::Workspaces;
using namespace Frontier::Workspaces::Sketcher;

bool VerifyCheck(bool Condition, const char* Message) noexcept
{
    if (!Condition)
    {
        std::fprintf(stderr, "[SketcherWorkspaceValidation] FAILED: %s\n", Message);
        return false;
    }
    return true;
}

std::filesystem::path ResolveShaderDir(const std::filesystem::path& RepoRoot)
{
    if (const char* Env = std::getenv("FRONTIER_COMPILED_SHADER_DIR"))
    {
        if (*Env != '\0' && std::filesystem::exists(std::filesystem::path(Env) / "SketcherSurface.frag.spv"))
        {
            return std::filesystem::path(Env);
        }
    }
    if (std::filesystem::exists(std::filesystem::path(FRONTIER_COMPILED_SHADER_DIR) / "SketcherSurface.frag.spv"))
    {
        return std::filesystem::path(FRONTIER_COMPILED_SHADER_DIR);
    }
    return RepoRoot / "Build/CompiledShaders";
}

} // namespace

int main()
{
    uint32_t Passed = 0u;
    const std::filesystem::path RepoRoot = std::filesystem::path(FRONTIER_REPO_ROOT_DIR);

    // 1. Verify WorkspaceCapabilityRegister routes .solidarc and .step files to SketcherWorkspace first
    {
        WorkspaceCapabilityRegister Register {};
        const auto SolidArcCaps = Register.QueryPermittedForPath("Bracket.solidarc");
        const auto StepCaps     = Register.QueryPermittedForPath("Housing.step");
        if (!VerifyCheck(!SolidArcCaps.empty() && SolidArcCaps.front().Target == HostWorkspaceTarget::SketcherWorkspace,
                         ".solidarc routes to SketcherWorkspace") ||
            !VerifyCheck(!StepCaps.empty() && StepCaps.front().Target == HostWorkspaceTarget::SketcherWorkspace,
                         ".step routes to SketcherWorkspace"))
        {
            return 1;
        }
        ++Passed;
    }

    // 2. Verify all 66 SVG icons exist on disk
    {
        size_t SvgCount = 0u;
        const std::filesystem::path IconDir = RepoRoot / "EngineContent/Icons/Sketcher";
        if (std::filesystem::exists(IconDir))
        {
            for (const auto& Entry : std::filesystem::directory_iterator(IconDir))
            {
                if (Entry.is_regular_file() && Entry.path().extension() == ".svg")
                {
                    ++SvgCount;
                }
            }
        }
        if (!VerifyCheck(SvgCount == static_cast<size_t>(IconSymbol::Count), "All 66 Sketcher SVG icons present"))
        {
            return 1;
        }
        ++Passed;
    }

    // 3. Initialize VulkanInterchange + ImGui + HeadlessWorkspaceDockContainer + SketcherWorkspaceHost
    GeometricRaster::VulkanInterchange Device {};
    std::string VkDiag {};
    bool HasVulkan = Device.InitializeInterchange(RepoRoot, &VkDiag);
    if (!HasVulkan)
    {
#if defined(_WIN32)
        std::printf("[SKIP] No Vulkan ICD available on headless Windows runner (%s); running host/ImGui/CAD checks without GPU raster.\n", VkDiag.c_str());
#else
        std::fprintf(stderr, "[SketcherWorkspaceValidation] FAILED: VulkanInterchange initialization: %s\n", VkDiag.c_str());
        return 1;
#endif
    }

    ImGuiContext* Gui = ImGui::CreateContext();
    ImGui::SetCurrentContext(Gui);
    ImGuiIO& Io = ImGui::GetIO();
    Io.ConfigFlags |= ImGuiConfigFlags_DockingEnable | ImGuiConfigFlags_NavEnableKeyboard;
    Io.DisplaySize = ImVec2(1440.0f, 900.0f);
    Io.DeltaTime   = 1.0f / 60.0f;
    Io.IniFilename = nullptr;

    TypographyRepository Typefaces {};
    (void)Typefaces.LoadRepository(RepoRoot / "EngineContent/FontsArchives");
    TypographyRepository::AssignCurrent(&Typefaces);
    if (ImFont* DefaultFace = Typefaces.QueryFont(0u, FontWeightClass::Regular))
    {
        Io.FontDefault = DefaultFace;
    }
    unsigned char* FontPixels = nullptr;
    int FontW = 0, FontH = 0;
    Io.Fonts->GetTexDataAsRGBA32(&FontPixels, &FontW, &FontH);

    ThemeRepository Theme {};
    Theme.ConfigureTheme(ThemePreset::Dark);
    Theme.ConfigureAccent(AccentPreset::Blue);
    ControlAppearance::ConfigureTheme(Theme);

    Components::HeadlessWorkspaceDockContainer Dock {};
    if (!VerifyCheck(Dock.Initialize(Windowing::WindowConfigurationDescriptor::ConstructApplicationWindow("Sketcher Validation", 1440u, 900u)),
                     "HeadlessWorkspaceDockContainer initialization"))
    {
        ImGui::DestroyContext(Gui);
        return 1;
    }
    Components::ConfigureImGuiWorkspaceStyle(Dock.ActiveTabMetrics());
    Components::ConfigureImGuiWorkspaceTheme(Dock.ActiveTabMetrics(), Theme);

    SketcherWorkspaceHost Host {};
    std::string HostDiag {};
    const std::filesystem::path ShaderDir = ResolveShaderDir(RepoRoot);
    if (!VerifyCheck(Host.Initialize(HasVulkan ? &Device : nullptr, ShaderDir, RepoRoot / "EngineContent/Icons", {}, &HostDiag),
                     "SketcherWorkspaceHost initialization"))
    {
        std::fprintf(stderr, "Host diag: %s\n", HostDiag.c_str());
        Dock.Finalize();
        ImGui::DestroyContext(Gui);
        return 1;
    }
    Host.AccessState().WelcomeOpen = false;
    Host.RegisterDockPanes(Dock);
    if (!VerifyCheck(Host.QueryRegisteredTabCount() == 5u, "5 dockable Sketcher panes registered"))
    {
        Host.Finalize();
        Dock.Finalize();
        ImGui::DestroyContext(Gui);
        return 1;
    }
    ++Passed;

    // 4. Build a Block - Cylinder cut solid inside the host document and step 2 docked ImGui frames
    {
        auto& Doc = Host.AccessState().Document;
        SketcherConstructRequest BoxReq {};
        BoxReq.Kind     = SketcherConstructCategory::Block;
        BoxReq.Position = { -1.2, -0.9, -0.6 };
        BoxReq.Width    = 2.4;
        BoxReq.Depth    = 1.8;
        BoxReq.Height   = 1.2;
        if (!VerifyCheck(ConstructSketcherPrimitive(Doc, BoxReq).AcceptedCondition, "Construct Block in host"))
        {
            Host.Finalize();
            Dock.Finalize();
            ImGui::DestroyContext(Gui);
            return 1;
        }

        SketcherDrawingRequest CircleReq {};
        CircleReq.Kind            = SketcherDrawingCategory::Circle;
        CircleReq.GridPlane       = 0;
        CircleReq.CentreCondition = true;
        CircleReq.FillCondition   = true;
        CircleReq.Points          = { { 0.0, 0.0 }, { 0.45, 0.0 } };
        if (!VerifyCheck(DrawSketcherSketch(Doc, CircleReq).AcceptedCondition, "Draw Circle sketch in host"))
        {
            Host.Finalize();
            Dock.Finalize();
            ImGui::DestroyContext(Gui);
            return 1;
        }
        const std::string SketchLabel = Doc.Tree.Steps.back().Label;
        if (!VerifyCheck(ExtrudeSketcherSketch(Doc, SketchLabel, 3.0, GeometrySpace::Parametric::FeatureCombination::Difference).AcceptedCondition,
                         "Extrude Difference cut in host"))
        {
            Host.Finalize();
            Dock.Finalize();
            ImGui::DestroyContext(Gui);
            return 1;
        }

        RefreshSketcherScene(Host.AccessState(), false);
        ConfigureSketcherStartupViews(Host.AccessState());
    }

    for (int FrameIdx = 0; FrameIdx < 2; ++FrameIdx)
    {
        ImGui::NewFrame();
        Host.BeginFrame(1.0 / 60.0);
        Dock.PresentWindowImGuiPanes(Components::HostWindowToken{ 0u });
        Host.EndFrame(1.0 / 60.0, true, true);
        ImGui::Render();
    }

    const auto& Scene = DisplayedSketcherScene(Host.InspectState());
    const ImDrawData* DrawData = ImGui::GetDrawData();
    if (!VerifyCheck(!Scene.Faces.empty() && !Scene.Edges.empty(), "Host scene populated with B-rep faces and edges") ||
        !VerifyCheck(DrawData != nullptr && DrawData->CmdListsCount > 0, "Docked ImGui draw lists generated"))
    {
        Host.Finalize();
        Dock.Finalize();
        ImGui::DestroyContext(Gui);
        return 1;
    }
    ++Passed;

    // 5. InputExchange -> InputExtension -> ImGuiInputAdapter validation (numpad keys, punctuation, no stuck modifiers, overlay shield)
    {
        Input::InputExtension InputExt {};
        InputExt.Initialize();
        uint64_t Ts = 1'000'000ull;

        auto EmitKey = [&](Input::InputLogicalKey Key, Input::ButtonTransitionCategory Transition, uint16_t Mods)
        {
            Input::InputSignalPacket Pkt {};
            Pkt.TimestampNanoseconds = (Ts += 100'000ull);
            Pkt.Category             = Input::InputSignalCategory::KeyboardKey;
            Pkt.LogicalKey           = Key;
            Pkt.Transition           = Transition;
            Pkt.ModifierBitmask      = Mods;
            (void)InputExt.IntakeHardwareSignal(Pkt);
        };

        InputExt.BeginTick();
        EmitKey(Input::InputLogicalKey::LeftControl, Input::ButtonTransitionCategory::Pressed, Input::InputModifierBits::Control);
        EmitKey(Input::InputLogicalKey::Keypad1, Input::ButtonTransitionCategory::Pressed, 0u);
        EmitKey(Input::InputLogicalKey::LeftBracket, Input::ButtonTransitionCategory::Pressed, 0u);
        EmitKey(Input::InputLogicalKey::KeypadAdd, Input::ButtonTransitionCategory::Pressed, 0u);
        EmitKey(Input::InputLogicalKey::Minus, Input::ButtonTransitionCategory::Pressed, 0u);
        (void)InputExt.TickExchange();
        Input::InputExtension::AssignActiveExtension(&InputExt);

        if (!VerifyCheck(InputExt.InspectEditorSnapshot().ControlHeld &&
                             InputExt.InspectEditorSnapshot().QueryKeyPressed(Input::InputLogicalKey::Keypad1, false) &&
                             InputExt.InspectEditorSnapshot().QueryKeyPressed(Input::InputLogicalKey::LeftBracket, false) &&
                             InputExt.InspectEditorSnapshot().QueryKeyPressed(Input::InputLogicalKey::KeypadAdd, false) &&
                             InputExt.InspectEditorSnapshot().QueryKeyPressed(Input::InputLogicalKey::Minus, false),
                         "InputExtension records Keypad1, LeftBracket, KeypadAdd, Minus, ControlHeld"))
        {
            Host.Finalize();
            Dock.Finalize();
            ImGui::DestroyContext(Gui);
            return 1;
        }
        const std::size_t Forwarded = Input::ImGuiInputAdapter::ForwardEditorExchangeToImGui(InputExt, Io);
        ImGui::NewFrame();
        if (!VerifyCheck(Forwarded == 5u, "ImGuiInputAdapter drained 5 editor packets") ||
            !VerifyCheck(Io.KeyCtrl, "ImGuiInputAdapter sets Io.KeyCtrl") ||
            !VerifyCheck(ImGui::IsKeyPressed(ImGuiKey_Keypad1, false), "ImGuiInputAdapter propagates Keypad1") ||
            !VerifyCheck(ImGui::IsKeyPressed(ImGuiKey_LeftBracket, false), "ImGuiInputAdapter propagates LeftBracket") ||
            !VerifyCheck(ImGui::IsKeyPressed(ImGuiKey_KeypadAdd, false), "ImGuiInputAdapter propagates KeypadAdd") ||
            !VerifyCheck(ImGui::IsKeyPressed(ImGuiKey_Minus, false), "ImGuiInputAdapter propagates Minus"))
        {
            ImGui::EndFrame();
            Host.Finalize();
            Dock.Finalize();
            ImGui::DestroyContext(Gui);
            return 1;
        }
        ImGui::EndFrame();

        // Release LeftControl even when OS reports stale Control bit in ModifierBitmask: ControlHeld must clear cleanly
        InputExt.BeginTick();
        EmitKey(Input::InputLogicalKey::LeftControl, Input::ButtonTransitionCategory::Released, Input::InputModifierBits::Control);
        (void)InputExt.TickExchange();
        (void)Input::ImGuiInputAdapter::ForwardEditorExchangeToImGui(InputExt, Io);
        ImGui::NewFrame();
        if (!VerifyCheck(!InputExt.InspectEditorSnapshot().ControlHeld && !Io.KeyCtrl,
                         "Modifier release clears ControlHeld/KeyCtrl without sticking"))
        {
            ImGui::EndFrame();
            Host.Finalize();
            Dock.Finalize();
            ImGui::DestroyContext(Gui);
            return 1;
        }
        ImGui::EndFrame();

        WorkspaceAppearance::AssignOverlayPointerShield(Rectangle2D { 10.0f, 10.0f, 120.0f, 80.0f });
        const bool BlockedInside  = WorkspaceAppearance::QueryOverlayPointerBlockedAt(Point2D { 40.0f, 40.0f });
        const bool ClearOutside   = !WorkspaceAppearance::QueryOverlayPointerBlockedAt(Point2D { 300.0f, 300.0f });
        WorkspaceAppearance::ClearOverlayPointerShield();
        Input::InputExtension::AssignActiveExtension(nullptr);
        if (!VerifyCheck(BlockedInside && ClearOutside, "WorkspaceAppearance overlay pointer shield blocks/passes properly"))
        {
            Host.Finalize();
            Dock.Finalize();
            ImGui::DestroyContext(Gui);
            return 1;
        }
        ++Passed;
    }

    // 6. CAD controls & UX: Ctrl+E menu, E last extrude mode, Ctrl+B bevel, C chamfer, G/R/S + .ImageSpace drop + Snap filter
    {
        auto StepHostedFrame = [&](auto&& InjectBeforeNewFrame)
        {
            InjectBeforeNewFrame();
            ImGui::NewFrame();
            Host.BeginFrame(1.0 / 60.0);
            Dock.PresentWindowImGuiPanes(Components::HostWindowToken{ 0u });
            Host.EndFrame(1.0 / 60.0, true, true);
            ImGui::Render();
        };

        auto& State = Host.AccessState();
        const size_t ResidentMatcapPreviews = std::count_if(State.Matcaps.Thumbnails.begin(), State.Matcaps.Thumbnails.end(), [](const auto& Texture) { return Texture && Texture->Pixels; });
        if (!VerifyCheck(!State.Scene.Faces.empty() && !State.Scene.Edges.empty(), "Scene has faces and edges for CAD controls") ||
            !VerifyCheck(ResidentMatcapPreviews == State.Matcaps.Library.Names.size() && ResidentMatcapPreviews >= 30,
                         "Material section has a baked preview texture for every MatCap"))
        {
            Host.Finalize();
            Dock.Finalize();
            ImGui::DestroyContext(Gui);
            return 1;
        }

        // Ctrl+E opens ExtrudeTypeContextMenu (without triggering Export)
        State.Document.Selection = {};
        State.Document.Selection.Faces = { State.Scene.Faces.front().Name };
        if (!VerifyCheck(!ImGui::IsPopupOpen("", ImGuiPopupFlags_AnyPopupId | ImGuiPopupFlags_AnyPopupLevel),
                         "No popup open before Ctrl+E"))
        {
            Host.Finalize();
            Dock.Finalize();
            ImGui::DestroyContext(Gui);
            return 1;
        }
        StepHostedFrame([&]()
        {
            Io.AddMousePosEvent(500.0f, 360.0f);
            Io.AddKeyEvent(ImGuiMod_Ctrl, true);
            Io.AddKeyEvent(ImGuiKey_E, true);
        });
        if (!VerifyCheck(ImGui::IsPopupOpen("", ImGuiPopupFlags_AnyPopupId | ImGuiPopupFlags_AnyPopupLevel) &&
                             !State.ExtrudeMenuRequest &&
                             State.PopupRequest.empty(),
                         "Ctrl+E opens ExtrudeTypeContextMenu instead of Export"))
        {
            Host.Finalize();
            Dock.Finalize();
            ImGui::DestroyContext(Gui);
            return 1;
        }
        StepHostedFrame([&]()
        {
            Io.AddKeyEvent(ImGuiKey_E, false);
            Io.AddKeyEvent(ImGuiMod_Ctrl, false);
            Io.AddKeyEvent(ImGuiKey_Escape, true);
        });
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_Escape, false); });
        if (!VerifyCheck(!ImGui::IsPopupOpen("", ImGuiPopupFlags_AnyPopupId | ImGuiPopupFlags_AnyPopupLevel),
                         "Escape closes ExtrudeTypeContextMenu"))
        {
            Host.Finalize();
            Dock.Finalize();
            ImGui::DestroyContext(Gui);
            return 1;
        }

        // Set LastExtrudeMode = Symmetric and press E -> opens Extrude session with Symmetric mode
        State.Document.Selection.Faces = { State.Scene.Faces.front().Name };
        State.LastExtrudeMode = SketcherExtrudeMode::Symmetric;
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_E, true); });
        const bool ExtrudeOpened = State.Bevel.ActiveCondition &&
                                   State.Bevel.Verb == SketcherSessionVerb::Extrude &&
                                   State.Bevel.ExtrudeMode == SketcherExtrudeMode::Symmetric;
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_E, false); });
        if (!VerifyCheck(ExtrudeOpened, "E starts Extrude with LastExtrudeMode (Symmetric)"))
        {
            Host.Finalize();
            Dock.Finalize();
            ImGui::DestroyContext(Gui);
            return 1;
        }
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_Escape, true); });
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_Escape, false); });

        // Ctrl+B opens Bevel Fillet; C with edge selected opens Chamfer
        State.Document.Selection = {};
        State.Document.Selection.Edges = { State.Scene.Edges.front().Name };
        StepHostedFrame([&]()
        {
            Io.AddKeyEvent(ImGuiMod_Ctrl, true);
            Io.AddKeyEvent(ImGuiKey_B, true);
        });
        const bool CtrlBFillet = State.Bevel.ActiveCondition &&
                                 State.Bevel.Verb == SketcherSessionVerb::Blend &&
                                 State.Bevel.Shape == GeometrySpace::Parametric::BlendProfile::Fillet;
        StepHostedFrame([&]()
        {
            Io.AddKeyEvent(ImGuiKey_B, false);
            Io.AddKeyEvent(ImGuiMod_Ctrl, false);
            Io.AddKeyEvent(ImGuiKey_Escape, true);
        });
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_Escape, false); });

        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_C, true); });
        const bool CChamfer = State.Bevel.ActiveCondition &&
                              State.Bevel.Verb == SketcherSessionVerb::Blend &&
                              State.Bevel.Shape == GeometrySpace::Parametric::BlendProfile::Chamfer;
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_C, false); });
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_Escape, true); });
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_Escape, false); });

        State.Document.Selection = {};
        State.Document.Selection.Vertices = { State.Scene.Vertices.front().Name };
        State.PickMode = SketcherPickMode::ControlPoint;
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_B, true); });
        const bool VertexBevel = State.Bevel.ActiveCondition && State.Bevel.VertexCondition
                              && State.Bevel.VertexNames.size() == 1 && State.Document.Selection.Edges.empty()
                              && State.Bevel.Handles.size() == 1 && State.Bevel.Handles.front().Edges == 3;
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_B, false); Io.AddKeyEvent(ImGuiKey_Escape, true); });
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_Escape, false); });
        const bool VertexSelectionRestored = !State.Bevel.ActiveCondition && State.Document.Selection.Edges.empty()
                                          && State.Document.Selection.Vertices.size() == 1;
        if (!VerifyCheck(CtrlBFillet && CChamfer, "Ctrl+B starts Fillet and C on edge starts Chamfer") ||
            !VerifyCheck(VertexBevel && VertexSelectionRestored, "B starts Blender-style Vertex Bevel without expanding edges and cancel restores selection"))
        {
            Host.Finalize();
            Dock.Finalize();
            ImGui::DestroyContext(Gui);
            return 1;
        }

        // .ImageSpace drop intake + G (Move) transform on focused ImagePlane
        SketcherPicture DropPic {};
        DropPic.Width  = 2u;
        DropPic.Height = 2u;
        DropPic.Pixels.assign(2u * 2u * 4u, 220u);
        const std::filesystem::path DropPath =
            std::filesystem::temp_directory_path() / "SketcherWsDropRef.ImageSpace";
        std::string DropDiag {};
        if (!VerifyCheck(ExportSketcherPictureAsImageSpace(DropPic, DropPath, DropDiag, "WsDropPlane"),
                         "Create .ImageSpace drop fixture"))
        {
            Host.Finalize();
            Dock.Finalize();
            ImGui::DestroyContext(Gui);
            return 1;
        }
        const bool DroppedOk = Host.IntakeExternalFileDrop(DropPath.string(), &DropDiag);
        std::filesystem::remove(DropPath);
        if (!VerifyCheck(DroppedOk && State.Document.ImagePlanes.size() == 1u,
                         "IntakeExternalFileDrop adds .ImageSpace ImagePlane"))
        {
            Host.Finalize();
            Dock.Finalize();
            ImGui::DestroyContext(Gui);
            return 1;
        }
        const double OrigCornerX = State.Document.ImagePlanes[0].Corner.X;
        State.Document.Selection = {};
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_G, true); });
        const bool GrabStarted = State.Transform.ActiveCondition &&
                                 State.Transform.Verb == SketcherTransformVerb::Move &&
                                 State.Transform.TargetKind == SketcherTransformTarget::ImagePlanes;
        StepHostedFrame([&]()
        {
            Io.AddKeyEvent(ImGuiKey_G, false);
            Io.AddKeyEvent(ImGuiKey_X, true);
        });
        StepHostedFrame([&]()
        {
            Io.AddKeyEvent(ImGuiKey_X, false);
            Io.AddKeyEvent(ImGuiKey_0, true);
        });
        StepHostedFrame([&]()
        {
            Io.AddKeyEvent(ImGuiKey_0, false);
            Io.AddKeyEvent(ImGuiKey_Period, true);
        });
        StepHostedFrame([&]()
        {
            Io.AddKeyEvent(ImGuiKey_Period, false);
            Io.AddKeyEvent(ImGuiKey_5, true);
        });
        StepHostedFrame([&]()
        {
            Io.AddKeyEvent(ImGuiKey_5, false);
            Io.AddKeyEvent(ImGuiKey_Enter, true);
        });
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_Enter, false); });
        const double MovedCornerX = State.Document.ImagePlanes[0].Corner.X;
        if (!VerifyCheck(GrabStarted, "G starts Move transform on .ImageSpace ImagePlane") ||
            !VerifyCheck(std::abs((MovedCornerX - OrigCornerX) - 0.5) < 1.0e-5,
                         "G + X + 0.5 + Enter moves .ImageSpace plane by +0.5 m"))
        {
            Host.Finalize();
            Dock.Finalize();
            ImGui::DestroyContext(Gui);
            return 1;
        }

        // Verify R and S start Rotate & Scale sessions on body
        State.Document.Selection.Bodies = { State.Document.Summary.Bodies.front().Key };
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_R, true); });
        const bool RotateOk = State.Transform.ActiveCondition && State.Transform.Verb == SketcherTransformVerb::Rotate;
        StepHostedFrame([&]()
        {
            Io.AddKeyEvent(ImGuiKey_R, false);
            Io.AddKeyEvent(ImGuiKey_Escape, true);
        });
        StepHostedFrame([&]()
        {
            Io.AddKeyEvent(ImGuiKey_Escape, false);
            Io.AddKeyEvent(ImGuiKey_S, true);
        });
        const bool ScaleOk = State.Transform.ActiveCondition && State.Transform.Verb == SketcherTransformVerb::Scale;
        StepHostedFrame([&]()
        {
            Io.AddKeyEvent(ImGuiKey_S, false);
            Io.AddKeyEvent(ImGuiKey_Escape, true);
        });
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_Escape, false); });
        if (!VerifyCheck(RotateOk && ScaleOk, "R starts Rotate and S starts Scale on selected body"))
        {
            Host.Finalize();
            Dock.Finalize();
            ImGui::DestroyContext(Gui);
            return 1;
        }

        // Blender modal contract: pointer movement adjusts, LMB confirms, RMB cancels.
        State.Document.Selection = {};
        State.Document.Selection.Bodies = { State.Document.Summary.Bodies.front().Key };
        const uint64_t BeforeLmb = State.Document.Revision;
        StepHostedFrame([&]()
        {
            Io.AddMousePosEvent(620.0f, 360.0f);
            Io.AddKeyEvent(ImGuiKey_G, true);
        });
        StepHostedFrame([&]()
        {
            Io.AddKeyEvent(ImGuiKey_G, false);
            Io.AddMousePosEvent(680.0f, 360.0f);
        });
        StepHostedFrame([&]() { Io.AddMouseButtonEvent(ImGuiMouseButton_Left, true); });
        StepHostedFrame([&]() { Io.AddMouseButtonEvent(ImGuiMouseButton_Left, false); });
        const bool LmbConfirmed = !State.Transform.ActiveCondition && State.Document.Revision > BeforeLmb;

        const uint64_t BeforeRmb = State.Document.Revision;
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_G, true); });
        StepHostedFrame([&]()
        {
            Io.AddKeyEvent(ImGuiKey_G, false);
            Io.AddMouseButtonEvent(ImGuiMouseButton_Right, true);
        });
        StepHostedFrame([&]() { Io.AddMouseButtonEvent(ImGuiMouseButton_Right, false); });
        const bool RmbCancelled = !State.Transform.ActiveCondition && State.Document.Revision == BeforeRmb;

        // B follows free pointer motion immediately; no bevel-gizmo grab is required.
        State.Document.Selection = {};
        State.Document.Selection.Edges = { State.Scene.Edges.front().Name };
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_B, true); });
        const bool BevelPointerArmed = State.Bevel.ActiveCondition && !State.Bevel.PinnedCondition;
        StepHostedFrame([&]()
        {
            Io.AddKeyEvent(ImGuiKey_B, false);
            Io.AddMousePosEvent(600.0f, 360.0f);
        });
        StepHostedFrame([&]() { Io.AddMouseButtonEvent(ImGuiMouseButton_Right, true); });
        StepHostedFrame([&]() { Io.AddMouseButtonEvent(ImGuiMouseButton_Right, false); });
        const bool BevelRmbCancelled = !State.Bevel.ActiveCondition;

        if (!VerifyCheck(LmbConfirmed && RmbCancelled && BevelPointerArmed && BevelRmbCancelled,
                         "Blender gestures: B arms free-pointer bevel, LMB confirms, RMB cancels"))
        {
            std::fprintf(stderr, "LmbConfirmed=%d RmbCancelled=%d BevelPointerArmed=%d BevelCancelled=%d BeforeLmb=%llu BeforeRmb=%llu Revision=%llu\n",
                         LmbConfirmed ? 1 : 0, RmbCancelled ? 1 : 0,
                         BevelPointerArmed ? 1 : 0, BevelRmbCancelled ? 1 : 0,
                         static_cast<unsigned long long>(BeforeLmb), static_cast<unsigned long long>(BeforeRmb),
                         static_cast<unsigned long long>(State.Document.Revision));
            Host.Finalize();
            Dock.Finalize();
            ImGui::DestroyContext(Gui);
            return 1;
        }

        // A completed bevel keeps the result selected and places the standard gizmo at the edited feature. Plain V is
        // deliberately unassigned (Point and variable bevel are chosen from UI controls instead).
        State.Document.Selection = {};
        State.Document.Selection.Edges = { State.Scene.Edges.front().Name };
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_B, true); });
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_B, false); });
        State.Bevel.Size = 0.02;
        State.Bevel.PinnedCondition = true;
        std::snprintf(State.Bevel.SizeText.data(), State.Bevel.SizeText.size(), "0.02");
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_Enter, true); });
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_Enter, false); });
        const bool BevelGizmoPlaced = !State.Bevel.ActiveCondition && State.Gizmo.OperationOriginCondition
                                   && State.Document.Selection.Bodies.size() == 1;
        const bool PersistentBevelActive = State.BevelControls.ActiveCondition
                                        && !State.BevelControls.StepLabel.empty()
                                        && State.BevelControls.Handles.size() >= 3u;
        bool PersistentBevelDragged = false;
        if (const ImVec4* Handle0Box = State.Widgets.Find("BevelHandle0"))
        {
            const float HX = 0.5f * (Handle0Box->x + Handle0Box->z);
            const float HY = 0.5f * (Handle0Box->y + Handle0Box->w);
            const double BeforeDragSize = State.BevelControls.Size;
            StepHostedFrame([&]() { Io.AddMousePosEvent(HX, HY); });
            const bool Hovered0 = State.BevelControls.HoverHandle == 0;
            StepHostedFrame([&]() { Io.AddMouseButtonEvent(ImGuiMouseButton_Left, true); });
            const bool Grabbed0 = State.BevelControls.DragHandle == 0 && !State.Gizmo.DragCondition;
            StepHostedFrame([&]() { Io.AddMousePosEvent(HX - 24.0f, HY + 18.0f); });
            const bool StillDragging0 = State.BevelControls.DragHandle == 0 && !State.Gizmo.DragCondition;
            StepHostedFrame([&]() { Io.AddMouseButtonEvent(ImGuiMouseButton_Left, false); });
            PersistentBevelDragged = Hovered0 && Grabbed0 && StillDragging0 && std::abs(State.BevelControls.Size - BeforeDragSize) > 1.0e-4;
        }
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_V, true); });
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_V, false); });
        const bool VUnassigned = !State.Trim.ActiveCondition && !State.Bevel.ActiveCondition;

        // Verify F3 live per-operation & frame profiler toggle + recorded operation stats.
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_F3, true); });
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_F3, false); });
        const bool ProfilerToggledOn = State.ProfilerShown && !State.Profile.OperationStats.empty();
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_F3, true); });
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_F3, false); });
        const bool ProfilerToggledOff = !State.ProfilerShown;

        // Verify Snap Filter & ContextAwareSnap defaults and Shift+A Line drawing mode
        if (!VerifyCheck(BevelGizmoPlaced, "Completed bevel places the gizmo at the edited feature") ||
            !VerifyCheck(PersistentBevelActive, "Completed bevel keeps persistent blue + white variable-bevel controls active") ||
            !VerifyCheck(PersistentBevelDragged, "Persistent bevel handle 0 drags cleanly over overlapping transform gizmo") ||
            !VerifyCheck(ProfilerToggledOn && ProfilerToggledOff, "F3 toggles live per-operation profiler HUD with recorded timings") ||
            !VerifyCheck(VUnassigned, "Plain V has no assigned tool hotkey") ||
            !VerifyCheck(State.Picker.Enabled && State.Picker.ContextAwareSnap && State.Picker.Filter.CurveEnabled && State.Picker.Filter.EndpointEnabled,
                         "Snap Filter & ContextAwareSnap enabled by default"))
        {
            Host.Finalize();
            Dock.Finalize();
            ImGui::DestroyContext(Gui);
            return 1;
        }
        StepHostedFrame([&]()
        {
            Io.AddKeyEvent(ImGuiMod_Shift, true);
            Io.AddKeyEvent(ImGuiKey_A, true);
        });
        const bool LineDrawingStarted = State.Drawing.ActiveCondition && State.Drawing.Kind == SketcherDrawingCategory::Line;
        const bool BevelControlsDismissedOnToolChange = !State.BevelControls.ActiveCondition;
        if (!VerifyCheck(BevelControlsDismissedOnToolChange, "Changing active tool dismisses persistent variable-bevel controls"))
        {
            Host.Finalize();
            Dock.Finalize();
            ImGui::DestroyContext(Gui);
            return 1;
        }
        const uint64_t BeforeLine = State.Document.Revision;
        StepHostedFrame([&]()
        {
            Io.AddKeyEvent(ImGuiKey_A, false);
            Io.AddKeyEvent(ImGuiMod_Shift, false);
            Io.AddMousePosEvent(540.0f, 420.0f);
            Io.AddMouseButtonEvent(ImGuiMouseButton_Left, true);
        });
        StepHostedFrame([&]() { Io.AddMouseButtonEvent(ImGuiMouseButton_Left, false); });
        StepHostedFrame([&]()
        {
            Io.AddMousePosEvent(660.0f, 420.0f);
            Io.AddMouseButtonEvent(ImGuiMouseButton_Left, true);
        });
        StepHostedFrame([&]() { Io.AddMouseButtonEvent(ImGuiMouseButton_Left, false); });
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_Enter, true); });
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_Enter, false); });
        const bool LineToolRearmed = State.Document.Revision > BeforeLine && State.Drawing.ActiveCondition
                                  && State.Drawing.Kind == SketcherDrawingCategory::Line && State.Drawing.Points.empty();
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_Escape, true); });
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_Escape, false); });

        // Empty viewport RMB opens Construct at the pointer (a drag remains viewport pan).
        State.Document.Selection = {};
        State.SketchPoints.Points.clear();
        StepHostedFrame([&]()
        {
            Io.AddMousePosEvent(620.0f, 360.0f);
            Io.AddMouseButtonEvent(ImGuiMouseButton_Right, true);
        });
        StepHostedFrame([&]() { Io.AddMouseButtonEvent(ImGuiMouseButton_Right, false); });
        const bool EmptyRmbConstruct = State.ConstructMenuRequest && State.ConstructMenuAtPointer
                                    && std::abs(State.ConstructMenuPointer[0] - 620.0f) < 0.5f
                                    && std::abs(State.ConstructMenuPointer[1] - 360.0f) < 0.5f;
        StepHostedFrame([&]() {});                                                           // Consume the request and open the popup
        State.ConstructSection = 3;
        State.ContextToolPage = 3;
        State.ContextToolSlide = 1.0f;
        StepHostedFrame([&]() {});
        const bool ContextToolOptions = State.ContextToolPage == 3 && State.ContextToolSlide < 1.0f;
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_Escape, true); });
        StepHostedFrame([&]() { Io.AddKeyEvent(ImGuiKey_Escape, false); });
        if (!VerifyCheck(LineDrawingStarted, "Shift+A starts Line drawing session") ||
            !VerifyCheck(LineToolRearmed, "Completed Construct sketch keeps its drawing tool active") ||
            !VerifyCheck(EmptyRmbConstruct, "Empty viewport RMB requests Construct menu at pointer") ||
            !VerifyCheck(ContextToolOptions, "Context tool selection slides to options without closing the menu"))
        {
            Host.Finalize();
            Dock.Finalize();
            ImGui::DestroyContext(Gui);
            return 1;
        }
        ++Passed;
    }

    // 9. Typography weights (Regular vs Light, never Thin), Fullscreen viewport toggle, and Inspector zero-overflow bounds
    {
        auto& State = Host.AccessState();
        const auto& Faces = QuerySketcherTypefaces();
        bool TypographyWeightsValid = true;
        if (Typefaces.QueryGroupCount() > 0u)
        {
            const std::string RegName = Faces.Regular ? static_cast<ImFont*>(Faces.Regular)->GetDebugName() : "";
            const std::string LgtName = Faces.Light   ? static_cast<ImFont*>(Faces.Light)->GetDebugName()   : "";
            std::string RegLow = RegName;
            for (char& Ch : RegLow) Ch = static_cast<char>(std::tolower(static_cast<unsigned char>(Ch)));
            TypographyWeightsValid = (Faces.Regular != nullptr) && (Faces.Light != nullptr)
                                  && (RegLow.find("thin") == std::string::npos)
                                  && (RegLow.find("regular") != std::string::npos);
        }

        // Fullscreen viewport toggle expands ViewportRect to full display width and exits cleanly
        const float DockedWidth = State.ViewportRect[2];
        State.ViewportMaximizedEnabled = true;
        for (int F = 0; F < 2; ++F)
        {
            ImGui::NewFrame();
            Host.BeginFrame(1.0 / 60.0);
            Host.RenderFullscreenViewport(1440.0f, 900.0f);
            Host.EndFrame(1.0 / 60.0, true, true);
            ImGui::Render();
        }
        const bool FullscreenExpanded = Host.QueryViewportMaximized() && State.ViewportRect[2] >= 1400.0f && State.ViewportRect[2] > DockedWidth + 200.0f;
        State.ViewportMaximizedEnabled = false;
        for (int F = 0; F < 2; ++F)
        {
            ImGui::NewFrame();
            Host.BeginFrame(1.0 / 60.0);
            Dock.PresentWindowImGuiPanes(Components::HostWindowToken{ 0u });
            Host.EndFrame(1.0 / 60.0, true, true);
            ImGui::Render();
        }
        const bool FullscreenRestored = !Host.QueryViewportMaximized() && State.ViewportRect[2] < 1200.0f;

        // Inspector zero-overflow bounds check at 330 px width with focused reference surface + Opacity slider
        SketcherReferenceSurface MockRef {};
        MockRef.Name        = "Egoist";
        MockRef.SummaryNote = "Blender 5.02 · 44 parts · 240068 tris · 82 modifiers · 550 ms";
        MockRef.Opacity     = 0.85f;
        MockRef.VisibleCondition = true;
        State.Document.ReferenceSurfaces.push_back(MockRef);
        State.FocusedReference    = "Egoist";
        State.SurfaceTraceEnabled = false;
        State.InspectorTab        = SketcherInspectorTab::Geometry;
        const ImVec2 SavedDisplay = Io.DisplaySize;
        Io.DisplaySize = ImVec2(330.0f, 3600.0f);
        for (int F = 0; F < 2; ++F)
        {
            ImGui::NewFrame();
            Host.BeginFrame(1.0 / 60.0);
            ImGui::SetNextWindowPos(ImVec2(0.0f, 0.0f));
            ImGui::SetNextWindowSize(ImVec2(330.0f, 3600.0f));
            ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(0.0f, 0.0f));
            if (ImGui::Begin("##ValidationInspector", nullptr, ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoResize))
                DrawSketcherInspectorPanel(State);
            ImGui::End();
            ImGui::PopStyleVar();
            Host.EndFrame(1.0 / 60.0, false, true);
            ImGui::Render();
        }
        Io.DisplaySize = SavedDisplay;
        const ImVec4* VisRect = State.Widgets.Find("RefVisible0");
        const ImVec4* NameRect = State.Widgets.Find("RefName0");
        const ImVec4* RemRect = State.Widgets.Find("RefRemove0");
        const ImVec4* SliderRect = State.Widgets.Find("RefOpacity");
        const bool InspectorBoundsClean = (VisRect != nullptr && NameRect != nullptr && RemRect != nullptr && SliderRect != nullptr)
                                       && (VisRect->z < NameRect->x)
                                       && (NameRect->z <= RemRect->x)
                                       && (RemRect->z <= 330.0f)
                                       && (SliderRect->z <= 330.0f)
                                       && (NameRect->z - NameRect->x >= 60.0f);
        State.Document.ReferenceSurfaces.pop_back();
        State.FocusedReference.clear();

        if (!VerifyCheck(TypographyWeightsValid, "Typography resolves Regular (400) + Light (300) without Thin fallback") ||
            !VerifyCheck(FullscreenExpanded && FullscreenRestored, "Fullscreen viewport button expands to full display and restores docked layout") ||
            !VerifyCheck(InspectorBoundsClean, "Inspector Reference toggle/name/remove row and Opacity slider stay strictly within 330 px"))
        {
            Host.Finalize();
            Dock.Finalize();
            ImGui::DestroyContext(Gui);
            return 1;
        }
        ++Passed;
    }

    // 10. In-app SolidArc Project Browser: PC folder navigation (no OS popup), .solidarc-only filter, project folder CAD previews,
    //     MatCap+B&W / B&W CAD / MatCap render modes, and opening .solidarc into SolidArc
    {
        auto& State = Host.AccessState();
        const std::filesystem::path SolidArcRoot = RepoRoot / "Content/SolidArc";
        const std::filesystem::path VehiclesDir  = SolidArcRoot / "Vehicles";
        if (std::filesystem::is_directory(VehiclesDir))
        {
            OpenSketcherProjectBrowser(State, SolidArcRoot);
            for (int F = 0; F < 2; ++F)
            {
                ImGui::NewFrame();
                Host.BeginFrame(1.0 / 60.0);
                Dock.PresentWindowImGuiPanes(Components::HostWindowToken{ 0u });
                Host.EndFrame(1.0 / 60.0, true, true);
                ImGui::Render();
            }
            const SketcherBrowserDiagnostic FolderDiag = InspectSketcherProjectBrowser(State);
            const bool FolderPreviewOk = FolderDiag.OpenCondition && FolderDiag.ProjectFolders >= 1u && FolderDiag.RenderedPreviews >= 1u;

            // Navigate into Content/Geometry/Vehicles/Blends — must show ZERO .blend files (strictly .solidarc + folders only!)
            bool StrictFilterOk = true;
            const std::filesystem::path BlendsDir = RepoRoot / "Content/Geometry/Vehicles/Blends";
            if (std::filesystem::is_directory(BlendsDir))
            {
                (void)NavigateSketcherProjectBrowser(State, BlendsDir);
                const SketcherBrowserDiagnostic BlendsDiag = InspectSketcherProjectBrowser(State);
                StrictFilterOk = (BlendsDiag.VisibleSolidArcs == 0u);
            }

            // Navigate into Vehicles, verify all 3 .solidarc files appear and render in MatCap+B&W and B&W CAD
            (void)NavigateSketcherProjectBrowser(State, VehiclesDir);
            ConfigureSketcherBrowserPreviewStyle(State, SketcherCadPreviewStyle::MatcapOverlay);
            for (int F = 0; F < 2; ++F)
            {
                ImGui::NewFrame();
                Host.BeginFrame(1.0 / 60.0);
                Dock.PresentWindowImGuiPanes(Components::HostWindowToken{ 0u });
                Host.EndFrame(1.0 / 60.0, true, true);
                ImGui::Render();
            }
            const SketcherBrowserDiagnostic VehDiag = InspectSketcherProjectBrowser(State);

            std::vector<uint8_t> MatcapBwRgba {}, PureBwRgba {}, PureMatcapRgba {};
            const std::filesystem::path EgoistPath = VehiclesDir / "Egoist.solidarc";
            const bool RenderOk = RenderSolidArcCadPreviewRgba(EgoistPath, SketcherCadPreviewStyle::MatcapOverlay, 160u, 100u, true, false, -0.68f, 0.42f, 1.0f, MatcapBwRgba)
                               && RenderSolidArcCadPreviewRgba(EgoistPath, SketcherCadPreviewStyle::DraftingBw,    160u, 100u, true, false, -0.68f, 0.42f, 1.0f, PureBwRgba)
                               && RenderSolidArcCadPreviewRgba(EgoistPath, SketcherCadPreviewStyle::MatcapStudio,  160u, 100u, true, false, -0.68f, 0.42f, 1.0f, PureMatcapRgba)
                               && (MatcapBwRgba != PureBwRgba)
                               && (MatcapBwRgba != PureMatcapRgba);

            const bool SelectOpenOk = SelectSketcherBrowserEntry(State, EgoistPath)
                                   && ActivateSketcherBrowserSelection(State)
                                   && !State.ProjectBrowserOpen
                                   && !State.Document.ReferenceSurfaces.empty();

            if (!VerifyCheck(FolderPreviewOk, "Project folder containing .solidarc renders live CAD preview") ||
                !VerifyCheck(StrictFilterOk, "Browser hides non-.solidarc files (.blend/etc.) while allowing folder navigation") ||
                !VerifyCheck(VehDiag.VisibleSolidArcs >= 3u && VehDiag.RenderedPreviews >= 3u, "Vehicles directory lists & previews all .solidarc files") ||
                !VerifyCheck(RenderOk, "CAD preview renderer produces distinct MatCap+B&W, B&W CAD, and MatCap outputs") ||
                !VerifyCheck(SelectOpenOk, "Activating a .solidarc file opens it into SolidArc and closes the browser"))
            {
                Host.Finalize();
                Dock.Finalize();
                ImGui::DestroyContext(Gui);
                return 1;
            }
        }
        ++Passed;
    }

    // 11. Blender-style GG vertex slide, rail switching, C unclamp, Mode 2 GG edge slide, and Mode 1 B-Rep vertex priority over consumed sketch
    {
        auto& State = Host.AccessState();
        auto StepFrame = [&](auto&& Inject)
        {
            Inject();
            ImGui::NewFrame();
            Host.BeginFrame(1.0 / 60.0);
            Dock.PresentWindowImGuiPanes(Components::HostWindowToken{ 0u });
            Host.EndFrame(1.0 / 60.0, true, true);
            ImGui::Render();
        };

        // Build a fresh document with a consumed sketch extruded into a box so sketch points & B-Rep vertices share Z = 0 corners.
        State.Document = CreateSketcherDocument("VertexSlideWs");
        SketcherDrawingRequest BaseRect {};
        BaseRect.Kind            = SketcherDrawingCategory::Rectangle;
        BaseRect.GridPlane       = 0;
        BaseRect.ClosedCondition = true;
        BaseRect.FillCondition   = true;
        BaseRect.Points          = { { -1.0, -0.8 }, { 1.0, 0.8 } };
        (void)DrawSketcherSketch(State.Document, BaseRect);
        const std::string RectLabel = State.Document.Tree.Steps.back().Label;
        (void)ExtrudeSketcherSketch(State.Document, RectLabel, 1.2, GeometrySpace::Parametric::FeatureCombination::New);
        RefreshSketcherScene(State, false);
        FitOrbitCamera(State.Camera, State.Scene.BoundsLow, State.Scene.BoundsHigh);
        State.PickMode           = SketcherPickMode::ControlPoint;
        State.FocusedStep        = {};
        State.Document.Selection = {};
        State.SketchPoints       = {};
        StepFrame([&]() {});
        StepFrame([&]() {});

        // Pick a visible B-Rep vertex at Z = 0 (coincident with the consumed rectangle sketch!) via recorded BodyVertex widget
        int    ChosenVertIdx = -1;
        ImVec4 VertBox {};
        for (size_t VIdx = 0; VIdx < State.Scene.Vertices.size(); ++VIdx)
        {
            if (std::abs(State.Scene.Vertices[VIdx].Position[2]) > 1.0e-4) continue;
            if (const ImVec4* Box = State.Widgets.Find("BodyVertex" + std::to_string(VIdx)))
            {
                VertBox       = *Box;
                ChosenVertIdx = int(VIdx);
                break;
            }
        }
        const float ClickX = 0.5f * (VertBox.x + VertBox.z);
        const float ClickY = 0.5f * (VertBox.y + VertBox.w);
        StepFrame([&]() { Io.AddMousePosEvent(ClickX, ClickY); });
        StepFrame([&]() { Io.AddMouseButtonEvent(ImGuiMouseButton_Left, true); });
        StepFrame([&]() { Io.AddMouseButtonEvent(ImGuiMouseButton_Left, false); });
        StepFrame([&]() {});

        const bool PickedBodyVertOverConsumedSketch =
            ChosenVertIdx >= 0 &&
            State.Document.Selection.Vertices.size() == 1u &&
            State.SketchPoints.Points.empty() &&
            State.Gizmo.Target == SketcherGizmoTarget::Shape &&
            State.Gizmo.VertexCondition;

        // Press G -> free Move with 3 incident slide rails; press G again (GG) -> enters SlideCondition!
        StepFrame([&]() { Io.AddKeyEvent(ImGuiKey_G, true); });
        StepFrame([&]() { Io.AddKeyEvent(ImGuiKey_G, false); });
        const bool FirstGHasRails = State.Transform.ActiveCondition && !State.Transform.SlideCondition &&
                                    State.Transform.SlideRails.size() == 3u;

        StepFrame([&]() { Io.AddKeyEvent(ImGuiKey_G, true); });
        StepFrame([&]() { Io.AddKeyEvent(ImGuiKey_G, false); });
        const bool SecondGEntersSlide = State.Transform.ActiveCondition && State.Transform.SlideCondition;

        // Move cursor along the first rail's actual screen direction: 40% along -> (0, 1), then 250% along -> clamped < 1.0, then C -> > 1.0!
        // Probe a tiny step to see each rail's screen vector, or compute from two screen steps:
        // Try 4 cardinal diagonals to find one that advances strongly (> 0.25) along an incident rail:
        float BestDx = 60.0f, BestDy = 0.0f;
        double BestProbe = -1.0;
        for (const auto& Dir : std::array<std::pair<float, float>, 4>{{ { 80.0f, -30.0f }, { -80.0f, -30.0f }, { 80.0f, 30.0f }, { -80.0f, 30.0f } }})
        {
            StepFrame([&]() { Io.AddMousePosEvent(ClickX + Dir.first, ClickY + Dir.second); });
            if (State.Transform.SlideFactor > BestProbe)
            {
                BestProbe = State.Transform.SlideFactor;
                BestDx    = Dir.first;
                BestDy    = Dir.second;
            }
        }
        StepFrame([&]() { Io.AddMousePosEvent(ClickX + BestDx, ClickY + BestDy); });
        const int    FirstRail   = State.Transform.ActiveSlideRail;
        const double FirstFactor = State.Transform.SlideFactor;
        bool CollinearOnRail = false;
        if (FirstRail >= 0 && FirstRail < int(State.Transform.SlideRails.size()))
        {
            const SketcherSlideRail& R = State.Transform.SlideRails[size_t(FirstRail)];
            const GeometrySpace::Parametric::Vector3 Expected = R.Origin + (R.Target - R.Origin) * FirstFactor;
            CollinearOnRail = GeometrySpace::Parametric::Distance(State.Transform.DisplayPivot, Expected) < 1.0e-5;
        }

        // Move 12x along that exact rail screen direction to confirm default clamping (< 1.0), then press C to unclamp (> 1.0), then C again
        StepFrame([&]() { Io.AddMousePosEvent(ClickX + BestDx * 12.0f, ClickY + BestDy * 12.0f); });
        const double ClampedFar = State.Transform.SlideFactor;
        StepFrame([&]() { Io.AddKeyEvent(ImGuiKey_C, true); });
        StepFrame([&]() { Io.AddKeyEvent(ImGuiKey_C, false); });
        const double UnclampedFar = State.Transform.SlideFactor;
        StepFrame([&]() { Io.AddKeyEvent(ImGuiKey_C, true); });
        StepFrame([&]() { Io.AddKeyEvent(ImGuiKey_C, false); });

        // Move cursor back to the moderate offset along that rail and commit with Enter
        const uint64_t RevBeforeSlide = State.Document.Revision;
        StepFrame([&]() { Io.AddMousePosEvent(ClickX + BestDx * 0.5f, ClickY + BestDy * 0.5f); });
        StepFrame([&]() { Io.AddKeyEvent(ImGuiKey_Enter, true); });
        StepFrame([&]() { Io.AddKeyEvent(ImGuiKey_Enter, false); });
        RefreshSketcherScene(State, false);
        const bool VertexSlideCommitted = !State.Transform.ActiveCondition &&
                                          State.Document.Revision > RevBeforeSlide &&
                                          State.Document.Summary.SoundCondition &&
                                          !State.Scene.Edges.empty();

        // Mode 2 GG Edge Slide: select an edge, press G then G, slide, and commit
        State.PickMode = SketcherPickMode::Edge;
        State.Document.Selection = {};
        State.Document.Selection.Edges = { State.Scene.Edges.front().Name };
        StepFrame([&]() { Io.AddMousePosEvent(620.0f, 360.0f); });
        StepFrame([&]() { Io.AddKeyEvent(ImGuiKey_G, true); });
        StepFrame([&]() { Io.AddKeyEvent(ImGuiKey_G, false); });
        StepFrame([&]() { Io.AddKeyEvent(ImGuiKey_G, true); });
        StepFrame([&]() { Io.AddKeyEvent(ImGuiKey_G, false); });
        const bool EdgeSlideActive = State.Transform.ActiveCondition && State.Transform.SlideCondition &&
                                     !State.Transform.SlideRails.empty() && State.Transform.SlideRails.front().EdgePair;
        const uint64_t RevBeforeEdgeSlide = State.Document.Revision;
        for (const auto& Dir : std::array<std::pair<float, float>, 4>{{ { 55.0f, -25.0f }, { -55.0f, -25.0f }, { 55.0f, 25.0f }, { -55.0f, 25.0f } }})
        {
            StepFrame([&]() { Io.AddMousePosEvent(620.0f + Dir.first, 360.0f + Dir.second); });
            if (State.Transform.SlideFactor > 0.05) break;
        }
        StepFrame([&]() { Io.AddKeyEvent(ImGuiKey_Enter, true); });
        StepFrame([&]() { Io.AddKeyEvent(ImGuiKey_Enter, false); });
        RefreshSketcherScene(State, false);
        const bool EdgeSlideCommitted = !State.Transform.ActiveCondition &&
                                        State.Document.Revision > RevBeforeEdgeSlide &&
                                        State.Document.Summary.SoundCondition;

        if (!VerifyCheck(PickedBodyVertOverConsumedSketch, "Mode 1 click picks 3D B-Rep vertex over coincident consumed sketch point") ||
            !VerifyCheck(FirstGHasRails && SecondGEntersSlide, "Pressing G then G (GG) enters incident-edge Vertex Slide mode") ||
            !VerifyCheck(CollinearOnRail && ClampedFar > 0.0 && ClampedFar < 1.0 && UnclampedFar > 1.0,
                         "GG slides collinearly along incident edge, clamps within (0, 1), and C unclamps past 1.0") ||
            !VerifyCheck(VertexSlideCommitted, "GG Vertex Slide commits a sound B-Rep reshape") ||
            !VerifyCheck(EdgeSlideActive && EdgeSlideCommitted, "Mode 2 GG Edge Slide slides edge along side rails and commits"))
        {
            Host.Finalize();
            Dock.Finalize();
            ImGui::DestroyContext(Gui);
            return 1;
        }
        ++Passed;
    }

    // ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    // Outliner 3D Shape Icons (Block, Cylinder, Sphere, Cone, Torus, Wedge, Prism, Tube + renamed Tube)
    // ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    {
        SketcherDocument IconDoc = CreateDefaultSketcherDocument();
        const struct { SketcherConstructCategory Kind; IconSymbol Expected; const char* Label; } Cases[] = {
            { SketcherConstructCategory::Block,    IconSymbol::SketcherBody,     "Block" },
            { SketcherConstructCategory::Cylinder, IconSymbol::SketcherCylinder, "Cylinder" },
            { SketcherConstructCategory::Sphere,   IconSymbol::SketcherSphere,   "Sphere" },
            { SketcherConstructCategory::Cone,     IconSymbol::SketcherCone,     "Cone" },
            { SketcherConstructCategory::Torus,    IconSymbol::SketcherRing,     "Torus" },
            { SketcherConstructCategory::Wedge,    IconSymbol::SketcherWedge,    "Wedge" },
            { SketcherConstructCategory::Prism,    IconSymbol::SketcherPrism,    "Prism" },
            { SketcherConstructCategory::Tube,     IconSymbol::SketcherTube,     "Tube" },
        };
        for (size_t Idx = 0; Idx < std::size(Cases); ++Idx)
        {
            SketcherConstructRequest Req;
            Req.Kind        = Cases[Idx].Kind;
            Req.Combination = GeometrySpace::Parametric::FeatureCombination::Separate;
            Req.Spot        = { static_cast<double>(Idx) * 3.0, 0.0, 0.0 };
            Req.Sides       = 5;
            const SketcherCommandOutcome Built = ConstructSketcherPrimitive(IconDoc, Req);
            if (!VerifyCheck(Built.AcceptedCondition, Cases[Idx].Label))
            {
                Host.Finalize();
                Dock.Finalize();
                ImGui::DestroyContext(Gui);
                return 1;
            }
            const SketcherBodyFigures& Fig = IconDoc.Summary.Bodies.back();
            const IconSymbol Actual = SketcherBodyIcon(IconDoc, Fig);
            if (!VerifyCheck(Actual == Cases[Idx].Expected, "Outliner body shape icon matches primitive geometry"))
            {
                Host.Finalize();
                Dock.Finalize();
                ImGui::DestroyContext(Gui);
                return 1;
            }
        }
        // Rename the Tube body and confirm surface-based shape detection keeps SketcherTube
        SketcherBodyFigures RenamedTube = IconDoc.Summary.Bodies.back();
        RenamedTube.Caption = "CustomRenamedPart";
        if (!VerifyCheck(SketcherBodyIcon(IconDoc, RenamedTube) == IconSymbol::SketcherTube,
                         "Renamed Tube body retains SketcherTube icon via B-rep surface inspection"))
        {
            Host.Finalize();
            Dock.Finalize();
            ImGui::DestroyContext(Gui);
            return 1;
        }
        ++Passed;
    }

    // ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    // Blender-Style Vertex Bevel (Affect: Vertices): 3-gon, 4-gon, 5-gon corner faces + 1/2-edge denial
    // ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
    {
        using namespace GeometrySpace::Parametric;

        const auto MakePlane = [](Vector3 Origin, Vector3 Normal) -> PlaneSurface
        {
            const Vector3 N = Normalize(Normal);
            const Vector3 Seed = std::abs(N.X) < 0.9 ? Vector3{ 1.0, 0.0, 0.0 } : Vector3{ 0.0, 1.0, 0.0 };
            const Vector3 X = Normalize(Seed - N * Dot(Seed, N));
            const Vector3 Y = Cross(N, X);
            return PlaneSurface{ { Origin, X, Y, N } };
        };
        const auto AddPlaneFace = [&](BodyBlueprint& Bp, const std::vector<int>& Ring, const std::vector<int>& Edges, const std::vector<Orientation>& Senses)
        {
            Vector3 Newell{}, Sum{};
            for (int V : Ring) Sum = Sum + Bp.Vertices[V].Position;
            const Vector3 Centre = Sum * (1.0 / static_cast<double>(Ring.size()));
            for (size_t I = 0; I < Ring.size(); ++I)
                Newell = Newell + Cross(Bp.Vertices[Ring[I]].Position, Bp.Vertices[Ring[(I + 1) % Ring.size()]].Position);
            const PlaneSurface Surf = MakePlane(Centre, Newell);
            BlueprintFace Face{ Surf, Orientation::Forward, {} };
            std::vector<BlueprintUse> Loop;
            for (size_t I = 0; I < Edges.size(); ++I)
            {
                const BlueprintEdge& E = Bp.Edges[Edges[I]];
                const Vector3 Mid = EvaluateCurve(E.Curve, 0.5 * (E.Low + E.High)).Position;
                const Vector2 Anchor = ProjectOntoSurface(Face.Surface, Mid, {});
                Loop.push_back({ Edges[I], Senses[I], FitSurfaceCurve(Face.Surface, E.Curve, E.Low, E.High, { Anchor - Vector2{ 1.0, 1.0 }, Anchor + Vector2{ 1.0, 1.0 } }, Anchor) });
            }
            Face.Loops.push_back(std::move(Loop));
            Bp.Faces.push_back(std::move(Face));
        };
        const auto BuildPyramid = [&](int Sides, ModelPartition& Part, BodyToken& OutBody, VertexToken& OutApex) -> bool
        {
            BodyBlueprint Bp;
            Bp.Category = BodyCategory::Solid;
            for (int I = 0; I < Sides; ++I)
            {
                const double A = 2.0 * 3.14159265358979323846 * I / Sides;
                Bp.Vertices.push_back({ { std::cos(A), std::sin(A), 0.0 } });
            }
            Bp.Vertices.push_back({ { 0.0, 0.0, 1.5 } });
            for (int I = 0; I < Sides; ++I)
            {
                const int J = (I + 1) % Sides;
                const Vector3 D = Bp.Vertices[J].Position - Bp.Vertices[I].Position;
                const double L = Length(D);
                Bp.Edges.push_back({ StraightLine{ Bp.Vertices[I].Position, D * (1.0 / L) }, 0.0, L, I, J });
            }
            for (int I = 0; I < Sides; ++I)
            {
                const Vector3 D = Bp.Vertices[Sides].Position - Bp.Vertices[I].Position;
                const double L = Length(D);
                Bp.Edges.push_back({ StraightLine{ Bp.Vertices[I].Position, D * (1.0 / L) }, 0.0, L, I, Sides });
            }
            // Base face (CW from +Z so outward normal is -Z)
            {
                std::vector<int> Ring, Edges;
                std::vector<Orientation> Senses;
                for (int I = Sides - 1; I >= 0; --I)
                {
                    const int Prev = (I + Sides - 1) % Sides;
                    Ring.push_back(I);
                    Edges.push_back(Prev);
                    Senses.push_back(Orientation::Reversed);
                }
                AddPlaneFace(Bp, Ring, Edges, Senses);
            }
            // Side triangles
            for (int I = 0; I < Sides; ++I)
            {
                const int J = (I + 1) % Sides;
                AddPlaneFace(Bp, { I, J, Sides }, { I, Sides + J, Sides + I },
                             { Orientation::Forward, Orientation::Forward, Orientation::Reversed });
            }
            const ArrangementOutcome Asm = AssembleBody(Part, Bp, "Pyramid");
            if (!Asm.Refusal.empty()) return false;
            OutBody = Asm.Body;
            OutApex = Part.CollectInventory(OutBody).Vertices.back();
            return true;
        };
        const auto CountFaceEdges = [](const ModelPartition& Part, FaceToken Face) -> int
        {
            int Count = 0;
            for (LoopToken Loop : Part.Faces.Resolve(Face).Loops)
                Part.EnumerateLoopFins(Loop, [&](FinToken) { ++Count; });
            return Count;
        };

        // 1) 3-edge cube corner -> triangle (3-gon) corner face via SketcherDocument
        SketcherDocument CubeDoc = CreateDefaultSketcherDocument();
        {
            SketcherConstructRequest Req;
            Req.Kind = SketcherConstructCategory::Block;
            ConstructSketcherPrimitive(CubeDoc, Req);
            const auto& Body = CubeDoc.Regeneration.Bodies.front();
            const std::string FirstVert = Body.Naming.Vertices.begin()->second;
            CubeDoc.Selection.Vertices = { FirstVert };
            SketcherBlendRequest BReq;
            BReq.VertexCondition = true;
            BReq.Size = 0.2;
            const SketcherCommandOutcome Out = BlendSketcherSelection(CubeDoc, BReq);
            const auto& NewFig = CubeDoc.Summary.Bodies.front();
            bool HasTriangle = false;
            for (FaceToken F : CubeDoc.Partition->CollectInventory(CubeDoc.Regeneration.Bodies.front().Body).Faces)
                if (CountFaceEdges(*CubeDoc.Partition, F) == 3) HasTriangle = true;
            if (!VerifyCheck(Out.AcceptedCondition && NewFig.SoundCondition && NewFig.Faces == 7 && NewFig.Edges == 15 && NewFig.Vertices == 10 && HasTriangle,
                             "Cube vertex bevel (3 edges) generates a 3-gon triangle corner face"))
            {
                Host.Finalize();
                Dock.Finalize();
                ImGui::DestroyContext(Gui);
                return 1;
            }
        }

        // 2) 4-edge apex -> quad (4-gon) corner face
        {
            ModelPartition Part;
            BodyToken Pyr4{};
            VertexToken Apex4{};
            const bool Built4 = BuildPyramid(4, Part, Pyr4, Apex4);
            const BlendOutcome Out4 = Built4 ? BevelVertices(Part, Pyr4, { Apex4 }, { 0.25, true }) : BlendOutcome{};
            int CornerEdges4 = 0;
            for (const BlendFaceHistory& H : Out4.FaceHistories)
                if (H.Origin == BlendFaceOrigin::Vertex) CornerEdges4 = CountFaceEdges(Part, H.Result);
            if (!VerifyCheck(Built4 && Out4.Refusal.empty() && Out4.Audit.SoundCondition() && CornerEdges4 == 4,
                             "4-edge vertex bevel generates a 4-gon quad corner face"))
            {
                Host.Finalize();
                Dock.Finalize();
                ImGui::DestroyContext(Gui);
                return 1;
            }
        }

        // 3) 5-edge apex -> pentagon (5-gon) corner face
        {
            ModelPartition Part;
            BodyToken Pyr5{};
            VertexToken Apex5{};
            const bool Built5 = BuildPyramid(5, Part, Pyr5, Apex5);
            const BlendOutcome Out5 = Built5 ? BevelVertices(Part, Pyr5, { Apex5 }, { 0.25, true }) : BlendOutcome{};
            int CornerEdges5 = 0;
            for (const BlendFaceHistory& H : Out5.FaceHistories)
                if (H.Origin == BlendFaceOrigin::Vertex) CornerEdges5 = CountFaceEdges(Part, H.Result);
            if (!VerifyCheck(Built5 && Out5.Refusal.empty() && Out5.Audit.SoundCondition() && CornerEdges5 == 5,
                             "5-edge vertex bevel generates a 5-gon pentagon corner face"))
            {
                Host.Finalize();
                Dock.Finalize();
                ImGui::DestroyContext(Gui);
                return 1;
            }
        }

        // 4) Degree-2 vertex (midpoint splitting a cube edge into two collinear edges) -> DENIED
        {
            ModelPartition Part;
            BodyBlueprint Bp;
            Bp.Category = BodyCategory::Solid;
            // Unit cube [0,1]^3 with vertex 8 at (0.5, 0, 0) splitting bottom-front edge 0->1
            Bp.Vertices = {
                { { 0, 0, 0 } }, { { 1, 0, 0 } }, { { 1, 1, 0 } }, { { 0, 1, 0 } },
                { { 0, 0, 1 } }, { { 1, 0, 1 } }, { { 1, 1, 1 } }, { { 0, 1, 1 } },
                { { 0.5, 0, 0 } }
            };
            const auto AddSeg = [&](int A, int B)
            {
                const Vector3 D = Bp.Vertices[B].Position - Bp.Vertices[A].Position;
                const double L = Length(D);
                Bp.Edges.push_back({ StraightLine{ Bp.Vertices[A].Position, D * (1.0 / L) }, 0.0, L, A, B });
            };
            AddSeg(0, 8); AddSeg(8, 1); AddSeg(1, 2); AddSeg(2, 3); AddSeg(3, 0); // 0..4 (bottom)
            AddSeg(4, 5); AddSeg(5, 6); AddSeg(6, 7); AddSeg(7, 4);               // 5..8 (top)
            AddSeg(0, 4); AddSeg(1, 5); AddSeg(2, 6); AddSeg(3, 7);               // 9..12 (verticals)
            AddPlaneFace(Bp, { 0, 3, 2, 1, 8 }, { 4, 3, 2, 1, 0 }, { Orientation::Reversed, Orientation::Reversed, Orientation::Reversed, Orientation::Reversed, Orientation::Reversed });
            AddPlaneFace(Bp, { 4, 5, 6, 7 }, { 5, 6, 7, 8 }, { Orientation::Forward, Orientation::Forward, Orientation::Forward, Orientation::Forward });
            AddPlaneFace(Bp, { 0, 8, 1, 5, 4 }, { 0, 1, 10, 5, 9 }, { Orientation::Forward, Orientation::Forward, Orientation::Forward, Orientation::Reversed, Orientation::Reversed });
            AddPlaneFace(Bp, { 1, 2, 6, 5 }, { 2, 11, 6, 10 }, { Orientation::Forward, Orientation::Forward, Orientation::Reversed, Orientation::Reversed });
            AddPlaneFace(Bp, { 2, 3, 7, 6 }, { 3, 12, 7, 11 }, { Orientation::Forward, Orientation::Forward, Orientation::Reversed, Orientation::Reversed });
            AddPlaneFace(Bp, { 3, 0, 4, 7 }, { 4, 9, 8, 12 }, { Orientation::Forward, Orientation::Forward, Orientation::Reversed, Orientation::Reversed });
            const ArrangementOutcome Asm = AssembleBody(Part, Bp, "SplitCube");
            const VertexToken Deg2Vert = Asm.Refusal.empty() ? Part.CollectInventory(Asm.Body).Vertices[8] : VertexToken{};
            const BlendOutcome Denied2 = Asm.Refusal.empty() ? BevelVertices(Part, Asm.Body, { Deg2Vert }, { 0.1, true }) : BlendOutcome{};
            if (!VerifyCheck(Asm.Refusal.empty() && !Denied2.Refusal.empty(),
                             "Degree-2 vertex bevel is denied (requires >= 3 edges)"))
            {
                Host.Finalize();
                Dock.Finalize();
                ImGui::DestroyContext(Gui);
                return 1;
            }
        }
        ++Passed;
    }

    Host.Finalize();
    Dock.Finalize();
    TypographyRepository::AssignCurrent(nullptr);
    ImGui::DestroyContext(Gui);
    if (HasVulkan)
    {
        Device.TeardownInterchange();
    }

    std::printf("[SketcherWorkspaceValidation] Passed=%u Failed=0 (Tabs=%u Faces=%zu Edges=%zu)\n",
                Passed, 5u, Scene.Faces.size(), Scene.Edges.size());
    return 0;
}
