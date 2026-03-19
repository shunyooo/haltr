/**
 * `hal spawn` -- Spawn a new agent pane.
 *
 * hal spawn <role> --task <path> [--step <step>] [--cli <cli>]
 *
 * Roles: worker, verifier, sub-orchestrator, task-spec-reviewer
 *
 * Steps:
 *   1. Resolve which CLI to use (priority chain)
 *   2. Render hooks template into .hooks/{NNN}_{step}_{role}/
 *   3. Assemble prompt.md
 *   4. Check pane limit
 *   5. Spawn tmux pane via TmuxRuntime
 *   6. Register in .panes.yaml
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import * as yaml from "js-yaml";
import { loadAndValidateTask } from "../lib/validator.js";
import { findStep, loadConfig, validateCli, validateTaskPath, parseCli } from "../lib/task-utils.js";
import { getAgentSettings } from "../lib/agent-defaults.js";
import { tmuxStylePane, tmuxEnableBorderStatus } from "../lib/tmux.js";
import { PanesManager } from "../lib/panes-manager.js";
import type { TaskYaml, ConfigYaml, AcceptObject, } from "../types.js";
import type { Runtime, SpawnOptions } from "../lib/runtime.js";

export const VALID_ROLES = new Set([
  "worker",
  "verifier",
  "sub-orchestrator",
  "task-spec-reviewer",
]);

/** Border colors per role for tmux pane styling. */
const ROLE_COLORS: Record<string, string> = {
  "main-orchestrator": "yellow",
  "sub-orchestrator": "yellow",
  worker: "blue",
  verifier: "green",
  "task-spec-reviewer": "magenta",
};

export interface SpawnCommandOptions {
  role: string;
  task: string;
  step?: string;
  cli?: string;
  /** Accept ID for verifier CLI resolution context */
  acceptId?: string;
  /** Parent pane ID (defaults to "%0") */
  parentPaneId?: string;
}

// ============================================================================
// CLI Resolution
// ============================================================================

/**
 * Resolve which CLI tool to use, following the priority chain:
 *
 * 1. --cli flag (explicit override)
 * 2. For verifier: accept[].verifier (check-level override, if acceptId available)
 * 3. Step-level: step.agents.worker or step.agents.verifier
 * 4. Task-level: task.agents.worker or task.agents.verifier
 * 5. For orchestrator roles: config.yaml orchestrator_cli
 */
export function resolveCli(
  role: string,
  taskYaml: TaskYaml,
  configYaml: ConfigYaml,
  stepPath?: string,
  cliOverride?: string,
  acceptId?: string,
): string {
  // 1. Explicit --cli override
  if (cliOverride) {
    return cliOverride;
  }

  // Determine if it's a worker-like or verifier-like role
  const isVerifier = role === "verifier";
  const isWorker = role === "worker";
  const isOrchestrator =
    role === "sub-orchestrator" ||
    role === "task-spec-reviewer";

  // 2. For verifier: check accept-level verifier override
  if (isVerifier && stepPath && acceptId) {
    const step = findStep(taskYaml.steps, stepPath);
    if (step?.accept && Array.isArray(step.accept)) {
      const acceptArr = step.accept as AcceptObject[];
      const acceptObj = acceptArr.find((a) => a.id === acceptId);
      if (acceptObj?.verifier) {
        return acceptObj.verifier;
      }
    }
  }

  // 3. Step-level override
  if (stepPath) {
    const step = findStep(taskYaml.steps, stepPath);
    if (step?.agents) {
      if (isWorker && step.agents.worker) {
        return step.agents.worker;
      }
      if (isVerifier && step.agents.verifier) {
        return step.agents.verifier;
      }
    }
  }

  // 4. Task-level
  if (isWorker) {
    return taskYaml.agents.worker;
  }
  if (isVerifier) {
    return taskYaml.agents.verifier;
  }

  // 5. Orchestrator roles: use config orchestrator_cli
  if (isOrchestrator) {
    return configYaml.orchestrator_cli;
  }

  // Fallback
  return configYaml.orchestrator_cli;
}

// ============================================================================
// Hooks Rendering
// ============================================================================

/**
 * Compute the next NNN (3-digit zero-padded) for the .hooks directory.
 */
export function nextHooksIndex(hooksBaseDir: string): string {
  if (!existsSync(hooksBaseDir)) {
    return "001";
  }

  const entries = readdirSync(hooksBaseDir);
  let maxIndex = 0;

  for (const entry of entries) {
    const match = entry.match(/^(\d{3})_/);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxIndex) {
        maxIndex = num;
      }
    }
  }

  return String(maxIndex + 1).padStart(3, "0");
}

/**
 * Build the hooks directory name.
 * With step: `{NNN}_{step}_{role}`
 * Without step: `{NNN}_{role}`
 */
export function buildHooksDirName(
  index: string,
  role: string,
  stepId?: string,
): string {
  if (stepId) {
    return `${index}_${stepId}_${role}`;
  }
  return `${index}_${role}`;
}

/**
 * Find the haltr/ directory by searching up from the task.yaml path.
 * Returns the path to the haltr/ directory.
 */
export function findHaltrDir(taskPath: string): string {
  let dir = dirname(resolve(taskPath));

  while (true) {
    // Check if this directory IS a haltr directory
    if (existsSync(join(dir, "config.yaml"))) {
      return dir;
    }

    // Check if haltr/ subdirectory exists
    const haltrSubDir = join(dir, "haltr");
    if (
      existsSync(haltrSubDir) &&
      existsSync(join(haltrSubDir, "config.yaml"))
    ) {
      return haltrSubDir;
    }

    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not find haltr/ directory searching up from ${taskPath}`,
      );
    }
    dir = parent;
  }
}

/**
 * Render hooks template and prompt.md into .hooks/{NNN}_{step}_{role}/.
 *
 * @returns path to the created hooks directory
 */
export function renderHooks(
  haltrDir: string,
  role: string,
  taskPath: string,
  stepId?: string,
): string {
  const hooksBaseDir = taskPath
    ? join(dirname(taskPath), ".hooks")
    : join(haltrDir, ".hooks");
  mkdirSync(hooksBaseDir, { recursive: true });

  const index = nextHooksIndex(hooksBaseDir);
  const dirName = buildHooksDirName(index, role, stepId);
  const hooksDir = join(hooksBaseDir, dirName);
  mkdirSync(hooksDir, { recursive: true });

  // Get agent settings (user override or built-in default)
  const agentSettings = getAgentSettings(haltrDir, role);
  let rendered = agentSettings.replace(/\{\{task\}\}/g, taskPath);
  rendered = rendered.replace(/\{\{step\}\}/g, stepId ?? "");
  writeFileSync(join(hooksDir, "settings.yaml"), rendered, "utf-8");

  return hooksDir;
}

/**
 * Convert haltr agent settings to Claude Code --settings JSON format.
 * Reads settings.yaml from hooksDir, extracts hooks and disallowed_tools,
 * writes a settings.json compatible with Claude Code's --settings flag.
 *
 * Returns the path to the generated settings.json, or undefined if no settings.
 */
export interface ClaudeSettings {
  settingsPath?: string;
  disallowedTools?: string[];
  allowedTools?: string[];
  permissionMode?: string;
}

export function convertAgentSettingsForClaude(hooksDir: string): ClaudeSettings {
  const settingsPath = join(hooksDir, "settings.yaml");
  if (!existsSync(settingsPath)) return {};

  const content = readFileSync(settingsPath, "utf-8");
  const parsed = yaml.load(content) as Record<string, unknown> | null;
  if (!parsed) return {};

  const result: ClaudeSettings = {};

  // Convert hooks from haltr format to Claude Code format
  // All events use matcher + hooks array (Claude Code validates this uniformly):
  //   claude: { Stop: [{ matcher: "", hooks: [{type: "command", command: "..."}] }] }
  if (parsed.hooks && typeof parsed.hooks === "object") {
    const haltrHooks = parsed.hooks as Record<string, unknown[]>;
    const claudeHooks: Record<string, unknown[]> = {};

    for (const [event, entries] of Object.entries(haltrHooks)) {
      if (!Array.isArray(entries)) continue;
      claudeHooks[event] = entries.map((entry: any) => ({
        matcher: entry.matcher ?? "",
        hooks: entry.command
          ? [{ type: "command", command: entry.command }]
          : [],
      }));
    }

    const claudeSettings = { hooks: claudeHooks };
    const outputPath = join(hooksDir, "settings.json");
    writeFileSync(outputPath, JSON.stringify(claudeSettings, null, 2), "utf-8");
    result.settingsPath = outputPath;
  }

  // These must be passed as CLI flags, not in settings.json
  if (Array.isArray(parsed.disallowed_tools)) {
    result.disallowedTools = parsed.disallowed_tools as string[];
  }
  if (Array.isArray(parsed.allowed_tools)) {
    result.allowedTools = parsed.allowed_tools as string[];
  }
  if (typeof parsed.permission_mode === "string") {
    result.permissionMode = parsed.permission_mode;
  }

  return result;
}

/**
 * Build a launch script for a CLI agent and write it to hooksDir/launch.sh.
 * Returns the path to the script.
 *
 * Using a script file avoids tmux send-keys buffer overflow issues
 * with long prompts passed as command arguments.
 */
export function buildLaunchScript(
  cliSpec: string,
  role: string,
  hooksDir: string,
  promptPath: string,
): string {
  const { provider, model } = parseCli(cliSpec);
  const lines = ["#!/bin/bash"];

  if (provider !== "claude") {
    lines.push(`${provider} "$(cat '${promptPath}')"`);
  } else {
    const parts = [provider];
    if (model) parts.push(`--model ${model}`);

    const agentSettings = convertAgentSettingsForClaude(hooksDir);
    if (agentSettings.settingsPath) parts.push(`--settings '${agentSettings.settingsPath}'`);
    if (agentSettings.allowedTools?.length) parts.push(`--allowedTools "${agentSettings.allowedTools.join(",")}"`);
    if (agentSettings.disallowedTools?.length) parts.push(`--disallowedTools "${agentSettings.disallowedTools.join(",")}"`);
    if (agentSettings.permissionMode) parts.push(`--permission-mode ${agentSettings.permissionMode}`);

    // Always use --append-system-prompt for the full prompt content
    // (positional arg is silently truncated for long prompts)
    parts.push(`--append-system-prompt "$(cat '${promptPath}')"`);

    // Add a short initial user message to trigger action
    const isOrchestrator = role === "main-orchestrator" || role === "sub-orchestrator";
    if (!isOrchestrator) {
      const userMsg = role === "task-spec-reviewer"
        ? "このタスクの仕様をレビューしてください"
        : role === "verifier"
        ? "受入条件を検証してください"
        : "タスクを実行してください";
      parts.push(`'${userMsg}'`);
    }

    lines.push(parts.join(" \\\n  "));
  }

  const scriptPath = join(hooksDir, "launch.sh");
  writeFileSync(scriptPath, lines.join("\n") + "\n", { mode: 0o755 });
  return scriptPath;
}

// ============================================================================
// Prompt Assembly
// ============================================================================

/**
 * Read rules.md content from the haltr directory.
 */
export function readRules(haltrDir: string): string {
  const rulesPath = join(haltrDir, "rules.md");
  if (existsSync(rulesPath)) {
    return readFileSync(rulesPath, "utf-8");
  }
  return "";
}

/**
 * Build step details for prompt assembly.
 */
function buildStepDetails(
  taskYaml: TaskYaml,
  stepPath: string,
): string {
  const step = findStep(taskYaml.steps, stepPath);
  if (!step) {
    return `Step: ${stepPath} (not found)`;
  }

  let details = `## Step: ${step.id}\n`;
  details += `Goal: ${step.goal}\n`;
  if (step.status) {
    details += `Status: ${step.status}\n`;
  }
  if (step.accept) {
    if (typeof step.accept === "string") {
      details += `Accept: ${step.accept}\n`;
    } else {
      details += `Accept criteria:\n`;
      for (const a of step.accept) {
        details += `  - ${a.id}: ${a.check ?? a.instruction ?? ""}\n`;
      }
    }
  }
  return details;
}

/**
 * Build accept check details for verifier prompt.
 */
function buildAcceptCheckDetails(
  taskYaml: TaskYaml,
  stepPath: string,
): string {
  const step = findStep(taskYaml.steps, stepPath);
  if (!step) {
    return `Step: ${stepPath} (not found)`;
  }

  let details = `## Verification Target: ${step.id}\n`;
  details += `Goal: ${step.goal}\n\n`;
  details += `### Accept Checks\n`;

  if (step.accept) {
    if (typeof step.accept === "string") {
      details += `- ${step.accept}\n`;
    } else {
      for (const a of step.accept) {
        details += `- [${a.id}] ${a.check ?? a.instruction ?? ""}\n`;
        if (a.type) details += `  type: ${a.type}\n`;
      }
    }
  }

  return details;
}

/**
 * Assemble a prompt.md based on role, writing it to the hooks directory.
 *
 * @returns path to the prompt.md file
 */
/**
 * Assemble a prompt from the agent YAML's prompt template.
 * Template variables: {{rules}}, {{task}}, {{step}}, {{task_id}}, {{context}},
 * {{step_details}}, {{accept_details}}, {{steps_overview}}, {{workdir}}
 */
export function assemblePrompt(
  hooksDir: string,
  haltrDir: string,
  role: string,
  taskYaml: TaskYaml,
  taskPath: string,
  stepPath?: string,
): string {
  // Load prompt template from agent settings
  const agentYaml = getAgentSettings(haltrDir, role);
  const parsed = yaml.load(agentYaml) as Record<string, unknown> | null;
  let template = (parsed?.prompt as string) ?? `{{rules}}\n---\n\nRole: ${role}\nTask file: {{task}}\n`;

  // Build template variables
  const rules = readRules(haltrDir);
  const stepDetails = stepPath ? buildStepDetails(taskYaml, stepPath) : "";
  const acceptDetails = stepPath ? buildAcceptCheckDetails(taskYaml, stepPath) : "";
  let stepsOverview = "";
  for (const step of taskYaml.steps) {
    stepsOverview += `- ${step.id}: ${step.goal} (${step.status ?? "pending"})\n`;
    if (step.accept) {
      if (typeof step.accept === "string") {
        stepsOverview += `  accept: ${step.accept}\n`;
      } else if (Array.isArray(step.accept)) {
        for (const a of step.accept) {
          stepsOverview += `  accept [${(a as any).id}]: ${(a as any).check ?? (a as any).instruction ?? ""}\n`;
        }
      }
    }
  }
  const context = taskYaml.context ? `Context: ${taskYaml.context}` : "";
  const workdir = haltrDir.replace(/\/haltr$/, "");

  // Replace template variables
  template = template.replace(/\{\{rules\}\}/g, rules);
  template = template.replace(/\{\{task\}\}/g, taskPath);
  template = template.replace(/\{\{step\}\}/g, stepPath ?? "");
  template = template.replace(/\{\{task_id\}\}/g, taskYaml.id);
  template = template.replace(/\{\{context\}\}/g, context);
  template = template.replace(/\{\{step_details\}\}/g, stepDetails);
  template = template.replace(/\{\{accept_details\}\}/g, acceptDetails);
  template = template.replace(/\{\{steps_overview\}\}/g, stepsOverview);
  template = template.replace(/\{\{workdir\}\}/g, workdir);

  const promptPath = join(hooksDir, "prompt.md");
  writeFileSync(promptPath, template, "utf-8");
  return promptPath;
}

// ============================================================================
// Main spawn handler
// ============================================================================

/**
 * Core spawn logic, exported for testability.
 *
 * @param opts          command options
 * @param runtime       Runtime implementation (TmuxRuntime or mock)
 * @param basePath      base path for .panes.yaml, haltr/ lookup (defaults to cwd)
 */
export async function handleSpawn(
  opts: SpawnCommandOptions,
  runtime?: Runtime,
  basePath?: string,
): Promise<{
  hooksDir: string;
  promptPath: string;
  cli: string;
  paneId?: string;
}> {
  const { role, task: taskPath, step: stepPath, cli: cliOverride } = opts;

  // Validate role
  if (!VALID_ROLES.has(role)) {
    throw new Error(
      `Invalid role: "${role}". Valid roles: ${[...VALID_ROLES].join(", ")}`,
    );
  }

  const base = basePath ?? process.cwd();
  const resolvedTaskPath = resolve(taskPath);

  // Validate task path is within haltr/epics/ tree
  validateTaskPath(resolvedTaskPath);

  // Load task and config
  const taskYaml = loadAndValidateTask(resolvedTaskPath);
  const configYaml = loadConfig(resolvedTaskPath);

  // Validate step if provided
  if (stepPath) {
    const step = findStep(taskYaml.steps, stepPath);
    if (!step) {
      throw new Error(`Step not found: "${stepPath}"`);
    }
  }

  // 1. Resolve CLI
  const resolvedCli = resolveCli(
    role,
    taskYaml,
    configYaml,
    stepPath,
    cliOverride,
    opts.acceptId,
  );

  // Validate CLI against whitelist
  validateCli(resolvedCli);

  // 2. Find haltr directory
  const haltrDir = findHaltrDir(resolvedTaskPath);

  // 3. Render hooks
  const hooksDir = renderHooks(haltrDir, role, resolvedTaskPath, stepPath);

  // 4. Assemble prompt
  const promptPath = assemblePrompt(
    hooksDir,
    haltrDir,
    role,
    taskYaml,
    resolvedTaskPath,
    stepPath,
  );

  // 5. Check pre-execution gates for worker role
  if (role === "worker") {
    const history = taskYaml.history ?? [];
    const hasSpecReview = history.some((e) => e.type === "spec_reviewed");
    const hasApproval = history.some((e) => e.type === "execution_approved");

    if (!hasSpecReview) {
      throw new Error(
        `task-spec-reviewer によるレビューが完了していません。以下を実行してください:\n` +
        `  1. hal spawn task-spec-reviewer --task '${resolvedTaskPath}'\n` +
        `  2. レビュー完了後: hal history add --type spec_reviewed --task '${resolvedTaskPath}' --message 'レビュー結果'`,
      );
    }
    if (!hasApproval) {
      throw new Error(
        `実行が承認されていません。ユーザーに確認後、以下を実行してください:\n` +
        `  hal history add --type execution_approved --task '${resolvedTaskPath}'`,
      );
    }
  }

  // 6. Check pane limit
  // .panes.yaml is stored in the epic directory (alongside task.yaml)
  const epicDir = dirname(resolvedTaskPath);
  const panesManager = new PanesManager(epicDir);
  const currentCount = panesManager.count();
  if (currentCount >= configYaml.panes.max_concurrent) {
    throw new Error(
      `Pane limit reached: ${currentCount}/${configYaml.panes.max_concurrent}. Cannot spawn new agent.`,
    );
  }

  // 6. Spawn via runtime (if available)
  let paneId: string | undefined;
  if (runtime) {
    const parentPaneId = opts.parentPaneId ?? "%0";
    const spawnOpts: SpawnOptions = {
      step: stepPath ?? "",
      role,
      parentPaneId,
      cli: resolvedCli,
      taskPath: resolvedTaskPath,
      cwd: base,
    };

    const agentInfo = await runtime.spawn(spawnOpts);
    paneId = agentInfo.paneId;

    // Style the pane with role-based title and border color
    try {
      await tmuxEnableBorderStatus("haltr");
      const title = stepPath ? `${role}: ${stepPath}` : role;
      const color = ROLE_COLORS[role] ?? "white";
      await tmuxStylePane(paneId, title, color);
    } catch {
      // Best effort — styling is cosmetic
    }

    // Launch agent via script file (avoids tmux buffer overflow with long prompts)
    try {
      const scriptPath = buildLaunchScript(resolvedCli, role, hooksDir, promptPath);
      await runtime.send(agentInfo.agentId, `bash '${scriptPath}'`);
    } catch {
      // Best effort
    }
  } else {
    // No runtime — register manually in .panes.yaml (for testing/manual use)
    const parentPaneId = opts.parentPaneId ?? "%0";
    panesManager.add({
      pane_id: `%spawn-${Date.now()}`,
      step: stepPath ?? "",
      role,
      parent_pane_id: parentPaneId,
      cli: resolvedCli,
      task_path: resolvedTaskPath,
    });
  }

  console.log(
    `Spawned ${role}${stepPath ? ` for step ${stepPath}` : ""} using ${resolvedCli}`,
  );
  console.log(`  Hooks: ${hooksDir}`);
  console.log(`  Prompt: ${promptPath}`);

  return { hooksDir, promptPath, cli: resolvedCli, paneId };
}
