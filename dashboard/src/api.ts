// DX-691 barrel — domain modules live under `./api/`. Public import
// surface unchanged: every name previously exported from this file is
// re-exported here so `import { ... } from "../api"` keeps working.
// New endpoint → drop into the matching `./api/<domain>.ts` and add to
// the corresponding `export` line below.

export type { RepoInfo, ToggleError } from "./api/_request";
export { fetchWithAuth, fetchRepos } from "./api/_request";

export {
  fetchDispatches,
  fetchDispatchDetail,
  cancelDispatch,
  followDispatch,
} from "./api/dispatches";

export {
  fetchIssues,
  fetchIssueDetail,
  patchIssue,
  patchIssueCascade,
  CascadeUnblockRequiredError,
  deleteIssue,
  createIssue,
  getIssueSubtree,
  importIssues,
  triggerTriage,
  fleshOutIssue,
} from "./api/issues";
export type {
  PatchIssueResult,
  CascadeAction,
  CascadeIssueListBody,
  CascadeIssueListResult,
  DeleteIssueResult,
  IssueCreateStatus,
  IssueCreateInput,
} from "./api/issues";

export {
  fetchAgents,
  fetchAgent,
  fetchAgentRuntimeState,
  fetchAgentRoster,
  createAgent,
  updateAgent,
  deleteAgent,
  clearAgentBroken,
  postAgentUnblock,
  postAgentReRunEvaluator,
  uploadAgentAvatar,
  fetchAgentAvatarUrl,
  clearCriticalFailure,
  patchToggle,
  patchEffortSettings,
} from "./api/agents";
export type {
  AgentCreateInput,
  AgentUpdateInput,
  ClearCriticalFailureResult,
  EffortSettingsPatch,
} from "./api/agents";

export {
  patchTrelloCredentials,
  getGithubCredentials,
  patchGithubCredentials,
  putIssuePrefix,
} from "./api/credentials";
export type {
  TrelloCredentialPatch,
  TrelloCredentialResult,
  GithubCredentialsSnapshot,
  IssuePrefixResult,
} from "./api/credentials";

export {
  fetchLists,
  createList,
  patchList,
  swapListOrder,
  deleteList,
} from "./api/lists";
export type { DeleteListResult } from "./api/lists";

export {
  fetchTrelloListMapping,
  fetchTrelloBoardLists,
  patchTrelloListMapping,
  bootstrapBacklogTrelloList,
} from "./api/trello";
export type {
  TrelloListMappingResponse,
  TrelloBoardListsResponse,
  BootstrapBacklogResponse,
} from "./api/trello";

export {
  fetchSystemErrors,
  fetchRepairErrors,
  fetchRepairErrorDetail,
  resetRepairErrorById,
  markRepairErrorUnfixable,
} from "./api/repair";

export {
  listChatSessions,
  listBoardChatSessions,
  fetchChatTimeline,
  startBoardChat,
  postChatMessage,
  cancelChatSession,
  followChatSession,
  sendChatMessage,
} from "./api/chat";
export type { ChatSessionSummary, ChatTimelinePayload } from "./api/chat";

export { fetchSyncRootStates, retrySyncRoot, resetAllData } from "./api/sync";
export type { ResetAllDataResult } from "./api/sync";
