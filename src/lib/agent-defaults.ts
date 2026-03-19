/**
 * Built-in default agent definitions.
 *
 * These are used when haltr/agents/<role>.yaml doesn't exist.
 * Users can override by creating the file.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const AGENT_DEFAULTS: Record<string, string> = {
  "main-orchestrator": `roles: [orchestrate, spec]
disallowed_tools:
  - Edit
  - Write
  - NotebookEdit
allowed_tools:
  - "Bash(hal:*)"
  - "Bash(cat:*)"
hooks:
  Stop:
    - command: "hal check --orchestrator --task '{{task}}'"
`,
  "sub-orchestrator": `roles: [orchestrate]
disallowed_tools:
  - Edit
  - Write
  - NotebookEdit
allowed_tools:
  - "Bash(hal:*)"
  - "Bash(cat:*)"
hooks:
  Stop:
    - command: "hal check --orchestrator --task '{{task}}'"
`,
  worker: `roles: [implement]
permission_mode: acceptEdits
hooks:
  PreToolUse:
    - matcher: "Edit|Write"
      command: "hal hook guard-task-yaml"
  Stop:
    - command: "hal check --worker --task '{{task}}' --step '{{step}}'"
`,
  verifier: `roles: [verify]
disallowed_tools:
  - Edit
  - Write
  - NotebookEdit
allowed_tools:
  - "Bash(hal:*)"
  - "Bash(cat:*)"
hooks:
  Stop:
    - command: "hal check --verifier --task '{{task}}' --step '{{step}}'"
`,
  "task-spec-reviewer": `roles: [review]
disallowed_tools:
  - Edit
  - Write
  - NotebookEdit
allowed_tools:
  - "Bash(hal:*)"
  - "Bash(cat:*)"
check_criteria:
  - goal 明確さ
  - accept 具体性
  - 測定可能性
  - 偽造不可能性
  - スコープ明確さ
  - ステップ実行可能性
  - ステップ間順序整合性
hooks:
  Stop:
    - command: "hal check --task-spec-reviewer --task '{{task}}'"
`,
  "rules-agent": `roles: [maintain-rules]
hooks: {}
`,
};

/**
 * Get agent settings content for a role.
 * Checks haltr/agents/<role>.yaml first (user override),
 * then falls back to built-in defaults.
 */
export function getAgentSettings(haltrDir: string, role: string): string {
  const overridePath = join(haltrDir, "agents", `${role}.yaml`);
  if (existsSync(overridePath)) {
    return readFileSync(overridePath, "utf-8");
  }
  return AGENT_DEFAULTS[role] ?? `roles: [${role}]\nhooks: {}\n`;
}
