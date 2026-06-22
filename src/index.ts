export {
  BANNED_IMPORT_PATTERNS,
  PGAS_SERVER_IMPORTS,
  PGAS_SERVER_PACKAGE,
  PGAS_SERVER_VERSION,
  isAllowedPgasServerImport,
  isBannedImport,
  type PgasServerImport,
} from "./pgas-new/version.js";

export {
  GOVERNED_STATE_KEYS,
  FIXED_WIRING_MANIFEST_PATH,
  PGAS_NEW_ACTIONS,
  PGAS_NEW_MODES,
  createInitialState,
  type GovernedStateKey,
  type PgasNewAction,
  type PgasNewMode,
  type PgasNewState,
} from "./pgas-new/model.js";

export {
  assertActionAllowed,
  canTransition,
  legalActionsForMode,
  type GateResult,
} from "./pgas-new/gates.js";

export {
  WIRING_MANIFEST_PATH,
  loadWiringManifest,
  parseWiringManifest,
  type WiringManifest,
  type WiringManifestResult,
} from "./pgas-new/wiring-manifest.js";

export {
  createExistingRepoArtifactPlan,
  createStandaloneArtifactPlan,
  type ArtifactKind,
  type ArtifactPlan,
  type PlannedArtifact,
  type ProgramIdentity,
} from "./pgas-new/artifact-plan.js";

export {
  renderMissingWiringRequest,
  renderRegistrationRequest,
  type MissingWiringRequestOptions,
} from "./pgas-new/curator-request.js";

export {
  prepareExistingRepoAttachment,
  type ExistingRepoAttachmentOptions,
  type ExistingRepoAttachmentResult,
} from "./pgas-new/existing-repo.js";

export {
  renderExistingRepoAttachment,
  renderStandaloneScaffold,
  renderTemplate,
  type ProgramTemplate,
  type RenderExistingRepoOptions,
  type RenderResult,
  type RenderStandaloneOptions,
} from "./pgas-new/template-renderer.js";

export { createPgasNewFoundryProgramEntry } from "./foundry-program/registration.js";

export { startFoundryServer } from "./foundry-server.js";

export type { FoundryServerOptions, StartedFoundryServer } from "./foundry-server.js";

export { runRepl, runStreamingRepl } from "./repl/runner.js";

export type {
  ActionResult,
  ReplExitInfo,
  ReplLogger,
  ReplOptions,
  ReplState,
  ReplStreamEvent,
} from "./repl/types.js";

export {
  runLiveProviderVerification,
  runPostRebaseVerification,
  runStaticVerification,
  createMockCommandRunner,
  type VerificationEvidence,
  type VerificationStatus,
} from "./pgas-new/verify.js";

export {
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
  type SemanticCommandId,
} from "./pgas-new/command-runner.js";
