/*============================================================================================================================================
                                                           AUTOSPACEPOLICIES.H
============================================================================================================================================*/
// 🧩 Declarative policy bundle for project AutoSpace (Execution, GameplayRule, DeterministicDriving, NetworkingSpace, and StudioLobby policies)

#pragma once

//------------------------------------------------------------------------------------------------------------------------
//                                                        INCLUDES
//------------------------------------------------------------------------------------------------------------------------

#include "Engine/Lifecycle/ProjectExecutionPolicy.h"
#include "Engine/NetworkingSpace/Policies/ReplicationPolicy.h"
#include "Engine/NetworkingSpace/Policies/TransportSelectionPolicy.h"
#include "Engine/SimulationSpace/Policies/DeterministicDrivingPolicy.h"
#include "Engine/SimulationSpace/Policies/GameplayRulePolicy.h"

#include <cstdint>
#include <string_view>

namespace AutoSpace
{

//------------------------------------------------------------------------------------------------------------------------
//                                                      ENUMERATIONS
//------------------------------------------------------------------------------------------------------------------------

enum class StudioLobbyId : uint8_t
{
    StudioLobby1Cyclorama   = 1u, // [-] - Lobby 1 · Cyclorama (photographic infinity cove, 3 vehicles, 5 lighting rigs)
    StudioLobby2ForestStage = 2u, // [-] - Lobby 2 · Forest Stage (LED backdrop, 4 vehicles, wind fan + engine dust, rocks/plants left blank)
    StudioLobby3RacingGarage = 3u,// [-] - Lobby 3 · Racing Garage (3D track & grandstands, pit garage, car lift, tools, smoke & dust)
};

//------------------------------------------------------------------------------------------------------------------------
//                                                       STRUCTURES
//------------------------------------------------------------------------------------------------------------------------

struct StudioLobbyPolicy
{
    StudioLobbyId SelectedLobby            = StudioLobbyId::StudioLobby1Cyclorama; // [-] - Active lobby loaded into MainWorld
    bool          EnableEngineParticles    = true;  // [-] - Load and simulate Frontier::ParticleSpace emitters
    bool          LeaveBotanicalAndRockBlank = true;// [-] - Leave rocks, moss, wood, ferns, grass, and leaves blank
    bool          EnableStudioLightingRigs = true;  // [-] - Mount physical light stands/modifiers & Area/IES luminaires
    bool          EnableCameraRigs         = true;  // [-] - Mount procedural cinema tripods, bodies & scene cameras
    bool          EnableCrewProps          = true;  // [-] - Mount tether workstation, Pelican cases, garage props & cables
    bool          EnableConfiguratorOrbit  = true;  // [-] - Advance configurator camera orbit when ticking
    uint32_t      ActiveCameraPresetIndex  = 0u;    // [idx] - Active configurator camera preset [0..5]
};

struct AutoSpacePolicyBundle
{
    Frontier::Lifecycle::ProjectExecutionPolicy                   ExecutionPolicy   {}; // [-] - Cadence, opt-in domains & worker lanes
    Frontier::SimulationSpace::Policies::GameplayRulePolicy       GameplayPolicy    {}; // [-] - Fixed Hz, alignment hash & bounds rules
    Frontier::SimulationSpace::Policies::DeterministicDrivingPolicy DrivingPolicy   {}; // [-] - 16->20->3 deterministic driver policy
    Frontier::NetworkingSpace::ReplicationScheduleSpec            VehicleContract   {}; // [-] - Kinematic replication schedule
    Frontier::NetworkingSpace::TransportSelectionInput            TransportInput    {}; // [-] - Transport routing & failover rule
    StudioLobbyPolicy                                             LobbyPolicy       {}; // [-] - Single-level Studio Lobby selection policy
};

//------------------------------------------------------------------------------------------------------------------------
//                                                  FUNCTION PROTOTYPES
//------------------------------------------------------------------------------------------------------------------------

[[nodiscard]] Frontier::Lifecycle::ProjectExecutionPolicy                   BuildAutoSpaceExecutionPolicy() noexcept;
[[nodiscard]] Frontier::SimulationSpace::Policies::GameplayRulePolicy       BuildAutoSpaceGameplayPolicy() noexcept;
[[nodiscard]] Frontier::SimulationSpace::Policies::DeterministicDrivingPolicy BuildAutoSpaceDrivingPolicy(uint64_t Seed = 0x4155544Full) noexcept;
[[nodiscard]] StudioLobbyPolicy                                             BuildAutoSpaceLobbyPolicy(StudioLobbyId Lobby = StudioLobbyId::StudioLobby1Cyclorama) noexcept;
void                                                                        ClampStudioLobbyPolicyBounds(StudioLobbyPolicy& InOutPolicy) noexcept;
[[nodiscard]] std::string_view                                              QueryStudioLobbySlug(StudioLobbyId Lobby) noexcept;
[[nodiscard]] std::string_view                                              QueryStudioLobbyLabel(StudioLobbyId Lobby) noexcept;
[[nodiscard]] bool                                                          ParseStudioLobbyId(std::string_view Text, StudioLobbyId& OutLobby) noexcept;
[[nodiscard]] AutoSpacePolicyBundle                                         BuildAutoSpacePolicyBundle(
    uint64_t      DrivingSeed   = 0x4155544Full,
    StudioLobbyId InitialLobby  = StudioLobbyId::StudioLobby1Cyclorama) noexcept;

} // namespace AutoSpace
