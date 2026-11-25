/*============================================================================================================================================
                                                         AUTOSPACELIFECYCLE.CPP
============================================================================================================================================*/
// 🧩 Single-level runtime lifecycle implementation for project AutoSpace (policy-driven 3-lobby architecture in MainWorld.WorldSpace)

//------------------------------------------------------------------------------------------------------------------------
//                                                        INCLUDES
//------------------------------------------------------------------------------------------------------------------------

#include "Source/AutoSpaceLifecycle.h"

#include "Engine/Codecs/PhotometrySpaceCodec.h"
#include "Engine/Codecs/VolumetricSpaceCodec.h"
#include "Engine/Codecs/WorldSpaceCodec.h"
#include "Engine/Serialization/Container/DocumentContainerCodec.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <string>

namespace AutoSpace
{

namespace
{

[[nodiscard]] std::filesystem::path LocateFrontierRepositoryRoot(const std::filesystem::path& StartDir)
{
    std::error_code Ec {};
    std::filesystem::path Cursor = StartDir.empty() ? std::filesystem::current_path(Ec) : StartDir;
    for (int Depth = 0; Depth < 8; ++Depth)
    {
        if (std::filesystem::exists(Cursor / "Content" / "Environment" / "Skies" / "ClearSkyDaylight.VolumetricSpace", Ec))
        {
            return Cursor;
        }
        if (!Cursor.has_parent_path() || Cursor.parent_path() == Cursor)
        {
            break;
        }
        Cursor = Cursor.parent_path();
    }
    return std::filesystem::current_path(Ec);
}

} // namespace

//------------------------------------------------------------------------------------------------------------------------
//                                                LIFECYCLE IMPLEMENTATION
//------------------------------------------------------------------------------------------------------------------------

AutoSpaceLifecycle::~AutoSpaceLifecycle() noexcept
{
    Finalize();
}

bool AutoSpaceLifecycle::Initialize(
    const std::filesystem::path& ProjectRootPath,
    bool                         ForceHeadlessWindow,
    std::string&                 OutDiagnostic,
    StudioLobbyId                InitialLobby)
{
    Finalize();

    Policies = BuildAutoSpacePolicyBundle();
    Policies.LobbyPolicy.SelectedLobby = InitialLobby;
    ClampStudioLobbyPolicyBounds(Policies.LobbyPolicy);
    Metrics = {};

    std::filesystem::path EffectiveProjectRoot = ProjectRootPath;
    if (EffectiveProjectRoot.empty())
    {
        EffectiveProjectRoot = std::filesystem::path("Projects") / "AutoSpace";
    }
    RepositoryRoot = LocateFrontierRepositoryRoot(EffectiveProjectRoot);

    if (!RuntimeLoop.BootFromProjectRoot(EffectiveProjectRoot, OutDiagnostic, ForceHeadlessWindow))
    {
        return false;
    }

    Policies.ExecutionPolicy = RuntimeLoop.InspectExecutionPolicy();
    Policies.GameplayPolicy.FixedSimulationHz =
        static_cast<uint32_t>(std::lround(1.0 / std::max(0.001, Policies.ExecutionPolicy.FixedStepSeconds)));
    Frontier::SimulationSpace::Policies::GameplayRulePolicyEngine::ClampToSafeBounds(Policies.GameplayPolicy);

    // Load single-level MainWorld.WorldSpace (zero baked placements; lobbies build dynamically into this one level)
    (void)WorldHost.Initialize();
    const std::filesystem::path StartupWorldPath = EffectiveProjectRoot / "Content" / "Worlds" / "MainWorld.WorldSpace";
    std::string WorldDiag {};
    if (!WorldHost.LoadWorldSpaceFile(StartupWorldPath, WorldDiag))
    {
        OutDiagnostic = "AutoSpaceLifecycle failed to load startup MainWorld.WorldSpace (" +
                        StartupWorldPath.generic_string() + "): " + WorldDiag;
        RuntimeLoop.Finalize();
        return false;
    }

    Frontier::Codecs::WorldSpaceDocumentModel WorldDoc {};
    if (Frontier::Codecs::WorldSpaceDecoder::DecodeFromFile(StartupWorldPath, WorldDoc, WorldDiag))
    {
        if (!WorldDoc.EnvironmentVolumetricPath.empty())
        {
            Frontier::Codecs::VolumetricSpaceDocumentModel VolDoc {};
            std::string                                    VolDiag {};
            if (Frontier::Codecs::VolumetricSpaceDecoder::DecodeFromFile(
                    RepositoryRoot / WorldDoc.EnvironmentVolumetricPath, VolDoc, VolDiag))
            {
                WorldHost.AccessActiveScene().Atmosphere  = VolDoc.Atmosphere;
                WorldHost.AccessActiveScene().SkyRadiance = VolDoc.FallbackSkyRadiance;
                Metrics.SkyAtmosphereEnabled              = VolDoc.Atmosphere.Medium.AtmosphereEnabled;
            }
        }
        if (!WorldDoc.SolarPhotometryPath.empty())
        {
            Frontier::Codecs::PhotometrySpaceDocumentModel SunDoc {};
            std::string                                    SunDiag {};
            if (Frontier::Codecs::PhotometrySpaceDecoder::DecodeFromFile(
                    RepositoryRoot / WorldDoc.SolarPhotometryPath, SunDoc, SunDiag))
            {
                WorldHost.AccessActiveScene().Atmosphere.Solar = SunDoc.SolarEphemeris;
                WorldHost.AccessActiveScene().Sun              = SunDoc.SolarSource;
                Metrics.SunEnabled                             = SunDoc.SolarEphemeris.SolarEnabled;
            }
        }
        Metrics.LoadedGeometryInstances = static_cast<uint32_t>(WorldDoc.GeometryPlacements.size());
        Metrics.MainWorldLoaded         = true;
    }

#if FRONTIER_PROFILE_EDITOR
    EditorOutliner.ClearAll();
    LobbyHost.AttachOutliner(&EditorOutliner);
#endif

    if (!LobbyHost.BuildLobbyInSingleWorld(RepositoryRoot, Policies.LobbyPolicy, OutDiagnostic))
    {
        Finalize();
        return false;
    }

    const auto Reading            = RuntimeLoop.InspectReading();
    Metrics.BootLoadedFromDisk    = Reading.BootLoadedFromDisk;
    Metrics.WorkerChannelsRunning = Reading.CadenceMetrics.WorkerChannelsActive;
    Metrics.AssetStreamRunning    = Reading.CadenceMetrics.AssetStreamActive;
    Metrics.LobbyTelemetry        = LobbyHost.InspectTelemetry();
    Initialized                   = true;
    OutDiagnostic.clear();
    return true;
}

bool AutoSpaceLifecycle::SelectStudioLobby(StudioLobbyId Lobby, std::string& OutDiagnostic)
{
    if (!Initialized)
    {
        OutDiagnostic = "AutoSpaceLifecycle is not initialized.";
        return false;
    }
    Policies.LobbyPolicy.SelectedLobby = Lobby;
    ClampStudioLobbyPolicyBounds(Policies.LobbyPolicy);
    if (!LobbyHost.BuildLobbyInSingleWorld(RepositoryRoot, Policies.LobbyPolicy, OutDiagnostic))
    {
        return false;
    }
    Metrics.LobbyTelemetry = LobbyHost.InspectTelemetry();
    return true;
}

bool AutoSpaceLifecycle::RenderLobbyVisualProof(
    const std::filesystem::path& OutputDirectory,
    uint32_t                     WidthPx,
    uint32_t                     HeightPx,
    std::string&                 OutDiagnostic)
{
    if (!Initialized)
    {
        OutDiagnostic = "AutoSpaceLifecycle is not initialized.";
        return false;
    }
    return LobbyHost.RenderVisualProof(OutputDirectory, RepositoryRoot, WidthPx, HeightPx, OutDiagnostic);
}

uint32_t AutoSpaceLifecycle::RunBoundedTicks(uint32_t MaximumOuterTicks, double WallStepSeconds) noexcept
{
    if (!Initialized)
    {
        return 0u;
    }
    return RuntimeLoop.ExecuteBoundedFixedLoop(
        MaximumOuterTicks,
        WallStepSeconds,
        &AutoSpaceLifecycle::DispatchFixedStep,
        &AutoSpaceLifecycle::DispatchPresentationStep,
        this);
}

bool AutoSpaceLifecycle::VerifyProjectContracts(std::string& OutDiagnostic) const
{
    using namespace Frontier::SimulationSpace::Policies;

    if (!Metrics.MainWorldLoaded)
    {
        OutDiagnostic = "AutoSpace MainWorld.WorldSpace was not loaded.";
        return false;
    }
    if (!Metrics.SunEnabled || !Metrics.SkyAtmosphereEnabled)
    {
        OutDiagnostic = "AutoSpace MainWorld.WorldSpace must have both Sun and Sky enabled.";
        return false;
    }
    if (Metrics.LoadedGeometryInstances != 0u)
    {
        OutDiagnostic = "AutoSpace base MainWorld.WorldSpace must remain single-level with zero baked disk placements.";
        return false;
    }

    const auto Telemetry = LobbyHost.InspectTelemetry();
    if (!Telemetry.VehicleDecoderLoaded || !Telemetry.PhotometryLoaded)
    {
        OutDiagnostic = "AutoSpace StudioLobbyHost failed to load ControlVehicle or PhotometrySuite.";
        return false;
    }
    if (Telemetry.VehicleCount < 3u || Telemetry.SurfaceInstanceCount < 6u)
    {
        OutDiagnostic = "AutoSpace StudioLobbyHost produced fewer vehicles or surfaces than expected.";
        return false;
    }
#if FRONTIER_PROFILE_EDITOR
    if (Telemetry.OutlinerRowCount < 10u)
    {
        OutDiagnostic = "AutoSpace Editor Outliner hierarchy was not populated via WorldInstanceEditorBridge.";
        return false;
    }
#endif

    std::array<std::byte, GameplayRulePolicy::WirePayloadBytes> RuleWire{};
    if (!GameplayRulePolicyEngine::EncodePolicyWireBytes(Policies.GameplayPolicy, RuleWire))
    {
        OutDiagnostic = "AutoSpace GameplayRulePolicy wire encode failed.";
        return false;
    }
    GameplayRulePolicy DecodedRule{};
    if (!GameplayRulePolicyEngine::DecodePolicyWireBytes(RuleWire, DecodedRule, OutDiagnostic))
    {
        return false;
    }
    if (DecodedRule.FixedSimulationHz != Policies.GameplayPolicy.FixedSimulationHz)
    {
        OutDiagnostic = "AutoSpace GameplayRulePolicy wire FixedSimulationHz mismatch.";
        return false;
    }

    OutDiagnostic.clear();
    return true;
}

bool AutoSpaceLifecycle::Suspend() noexcept
{
    return Initialized && RuntimeLoop.Suspend();
}

bool AutoSpaceLifecycle::Resume() noexcept
{
    return Initialized && RuntimeLoop.Resume();
}

void AutoSpaceLifecycle::Finalize() noexcept
{
    LobbyHost.Shutdown();
    RuntimeLoop.Finalize();
    WorldHost.ClearWorld();
    Initialized = false;
}

AutoSpaceLoopMetrics AutoSpaceLifecycle::InspectMetrics() const noexcept
{
    AutoSpaceLoopMetrics Snapshot = Metrics;
    Snapshot.LobbyTelemetry = LobbyHost.InspectTelemetry();
    return Snapshot;
}

void AutoSpaceLifecycle::DispatchFixedStep(double FixedDeltaSeconds, uint64_t FixedStepOrdinal, void* Payload) noexcept
{
    if (auto* Self = static_cast<AutoSpaceLifecycle*>(Payload))
    {
        Self->OnFixedSimulationStep(FixedDeltaSeconds, FixedStepOrdinal);
    }
}

void AutoSpaceLifecycle::DispatchPresentationStep(double InterpolationAlpha, double WallDeltaSeconds, void* Payload) noexcept
{
    if (auto* Self = static_cast<AutoSpaceLifecycle*>(Payload))
    {
        Self->OnPresentationStep(InterpolationAlpha, WallDeltaSeconds);
    }
}

void AutoSpaceLifecycle::OnFixedSimulationStep(double FixedDeltaSeconds, uint64_t /*FixedStepOrdinal*/) noexcept
{
    (void)WorldHost.StepRuntimeWorld(FixedDeltaSeconds);
    LobbyHost.TickSimulation(FixedDeltaSeconds);
    ++Metrics.TotalFixedStepsExecuted;
    Metrics.SimulatedElapsedSeconds += FixedDeltaSeconds;
}

void AutoSpaceLifecycle::OnPresentationStep(double InterpolationAlpha, double /*WallDeltaSeconds*/) noexcept
{
    ++Metrics.PresentationTicksCount;
    Metrics.LastInterpolationAlpha = InterpolationAlpha;
}

} // namespace AutoSpace
