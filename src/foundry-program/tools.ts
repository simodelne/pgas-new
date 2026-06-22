import type { ToolImpl, ToolRegistry } from '@simodelne/pgas-server/plugin.js';

const semanticTools = [
  'repo_read_file',
  'repo_list_files',
  'record_user_note',
  'pin_notebook_note',
  'confirm_research_scope',
  'record_user_requested_research',
  'web_research',
  'select_repo_target',
  'authorize_standalone_target',
  'load_wiring_manifest',
  'authorize_existing_repo_target',
  'create_curator_request',
  'design_architecture',
  'plan_artifacts',
  'approve_artifact_plan',
  'write_scaffold_artifacts',
  'npm_install',
  'npm_typecheck',
  'npm_test',
  'run_static_verification',
  'confirm_live_provider_intent',
  'run_api_blackbox_verification',
  'run_live_provider_verification',
  'git_status',
  'git_rebase_latest',
  'run_rebase_static_verification',
  'open_pull_request',
  'session_new',
  'session_abort_current',
  'session_status',
  'session_history',
  'session_resume',
  'session_help',
] as const;

const noopTool: ToolImpl = {
  kind: 'local',
  fn: async (args) => ({ ok: true, args }),
};

export function registerPgasNewTools(registry: ToolRegistry): void {
  for (const name of semanticTools) {
    registry.register(name, noopTool);
  }
}
