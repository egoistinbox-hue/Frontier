/*============================================================================================================================================
                                                          AUTOSPACEPOLICIES.CPP
============================================================================================================================================*/
// 🧩 Declarative policy defaults for project AutoSpace

//------------------------------------------------------------------------------------------------------------------------
//                                                        INCLUDES
//------------------------------------------------------------------------------------------------------------------------

#include "Source/AutoSpacePolicies.h"

#include <algorithm>

namespace AutoSpace
{

//------------------------------------------------------------------------------------------------------------------------
//                                                 POLICY BUILDER DEFINITIONS
//------------------------------------------------------------------------------------------------------------------------

Frontier::Lifecycle::ProjectExecutionPolicy BuildAutoSpaceExecutionPolicy() noexcept
{
    using namespace Frontier::Lifecycle;

    ProjectExecutionPolicy Policy{};
    Policy.ProjectTitle           = "AutoSpace";
    Policy.FixedStepSeconds       = 1.0 / 60.0;
    Policy.MaximumStepSeconds     = 0.100;
    Policy.MaximumSubstepsPerTick = 4u;
    Policy.TargetStepBudgetMs     = 16.6667;
    Policy.WorkerChannelCount     = 2u;
    Policy.WindowWidthPixels      = 1280u;
    Policy.WindowHeightPixels     = 720u;
    Policy.PreferHeadlessWindow   = true;
    Policy.SuspendWhenMinimized   = true;
    Policy.EnableVerticalSync     = true;
    Policy.EnabledDomains         = RuntimeDomainMask::WorkerChannels |
                                    RuntimeDomainMask::AssetStreaming |
                                    RuntimeDomainMask::Networking;
    ProjectExecutionPolicyCodec::ClampToSafeBounds(Policy);
    return Policy;
}

Frontier::SimulationSpace::Policies::GameplayRulePolicy BuildAutoSpaceGameplayPolicy() noexcept
{
    Frontier::SimulationSpace::Policies::GameplayRulePolicy Policy{};
    Policy.SchemaVersion               = 1u;
    Policy.FixedSimulationHz           = 60u;
    Policy.AlignmentHashIntervalTicks  = 10u;
    Policy.SpeedLimitKmh               = 120.0f;
    Policy.RedSignalPenaltyScore       = 50.0f;
    Policy.CollisionImpulseThresholdNs = 12000.0f;
    Policy.PursuitEscalationStages     = 5u;
    Policy.MaximumSteerMagnitude       = 1.0f;
    Policy.MaximumDirectiveRateHz      = 240u;
    Policy.JoinInProgressAllowed       = true;
    Policy.HostMigrationEnabled        = true;
    Frontier::SimulationSpace::Policies::GameplayRulePolicyEngine::ClampToSafeBounds(Policy);
    return Policy;
}

Frontier::SimulationSpace::Policies::DeterministicDrivingPolicy BuildAutoSpaceDrivingPolicy(uint64_t Seed) noexcept
{
    Frontier::SimulationSpace::Policies::DeterministicDrivingPolicy Policy{};
    Policy.SeedInitialize(Seed);
    return Policy;
}

StudioLobbyPolicy BuildAutoSpaceLobbyPolicy(StudioLobbyId Lobby) noexcept
{
    StudioLobbyPolicy Policy{};
    Policy.SelectedLobby              = Lobby;
    Policy.EnableEngineParticles      = true;
    Policy.LeaveBotanicalAndRockBlank = true;
    Policy.EnableStudioLightingRigs   = true;
    Policy.EnableCameraRigs           = true;
    Policy.EnableCrewProps            = true;
    Policy.EnableConfiguratorOrbit    = true;
    Policy.ActiveCameraPresetIndex    = 0u;
    ClampStudioLobbyPolicyBounds(Policy);
    return Policy;
}

void ClampStudioLobbyPolicyBounds(StudioLobbyPolicy& InOutPolicy) noexcept
{
    const uint8_t Raw = static_cast<uint8_t>(InOutPolicy.SelectedLobby);
    if (Raw < 1u || Raw > 3u)
    {
        InOutPolicy.SelectedLobby = StudioLobbyId::StudioLobby1Cyclorama;
    }
    InOutPolicy.ActiveCameraPresetIndex = std::min(InOutPolicy.ActiveCameraPresetIndex, 5u);
    // Standing constraint: rocks, plants, and leaves stay blank across single-level lobbies
    InOutPolicy.LeaveBotanicalAndRockBlank = true;
}

std::string_view QueryStudioLobbySlug(StudioLobbyId Lobby) noexcept
{
    switch (Lobby)
    {
        case StudioLobbyId::StudioLobby2ForestStage:  return "studio-lobby-2";
        case StudioLobbyId::StudioLobby3RacingGarage: return "studio-lobby-3";
        case StudioLobbyId::StudioLobby1Cyclorama:
        default:                                      return "studio-lobby";
    }
}

std::string_view QueryStudioLobbyLabel(StudioLobbyId Lobby) noexcept
{
    switch (Lobby)
    {
        case StudioLobbyId::StudioLobby2ForestStage:  return "Lobby 2 · Forest Stage";
        case StudioLobbyId::StudioLobby3RacingGarage: return "Lobby 3 · Racing Garage";
        case StudioLobbyId::StudioLobby1Cyclorama:
        default:                                      return "Lobby 1 · Cyclorama";
    }
}

bool ParseStudioLobbyId(std::string_view Text, StudioLobbyId& OutLobby) noexcept
{
    if (Text == "1" || Text == "lobby1" || Text == "lobby-1" || Text == "studio-lobby" || Text == "cyclorama")
    {
        OutLobby = StudioLobbyId::StudioLobby1Cyclorama;
        return true;
    }
    if (Text == "2" || Text == "lobby2" || Text == "lobby-2" || Text == "studio-lobby-2" || Text == "forest")
    {
        OutLobby = StudioLobbyId::StudioLobby2ForestStage;
        return true;
    }
    if (Text == "3" || Text == "lobby3" || Text == "lobby-3" || Text == "studio-lobby-3" || Text == "garage")
    {
        OutLobby = StudioLobbyId::StudioLobby3RacingGarage;
        return true;
    }
    return false;
}

AutoSpacePolicyBundle BuildAutoSpacePolicyBundle(
    uint64_t      DrivingSeed,
    StudioLobbyId InitialLobby) noexcept
{
    AutoSpacePolicyBundle Bundle{};
    Bundle.ExecutionPolicy = BuildAutoSpaceExecutionPolicy();
    Bundle.GameplayPolicy  = BuildAutoSpaceGameplayPolicy();
    Bundle.DrivingPolicy   = BuildAutoSpaceDrivingPolicy(DrivingSeed);
    Bundle.VehicleContract = Frontier::NetworkingSpace::BuildRealtimeKinematicContract(2001u, 30.0f);
    Bundle.LobbyPolicy     = BuildAutoSpaceLobbyPolicy(InitialLobby);

    Bundle.TransportInput.AccessTier = Frontier::NetworkingSpace::EntitlementAccessTier::StandardAccess;
    Bundle.TransportInput.AvailabilityMask =
        static_cast<uint8_t>(Frontier::NetworkingSpace::TransportLinkAvailabilityMask::EnableLoopback) |
        static_cast<uint8_t>(Frontier::NetworkingSpace::TransportLinkAvailabilityMask::EnableSovereignSocket);
    return Bundle;
}

} // namespace AutoSpace
