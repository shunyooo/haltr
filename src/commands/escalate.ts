/**
 * `hal escalate` — convenience command that atomically:
 * 1. Sets the step's status to `blocked`
 * 2. Adds an `escalation` event to history
 * 3. Notifies parent orchestrator via tmux send-keys
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import * as yaml from "js-yaml";
import { loadAndValidateTask } from "../lib/validator.js";
import {
  findStep,
  validateStepTransition,
  resolveBy,
  resolveAttempt,
  loadConfig,
  validateTaskPath,
} from "../lib/task-utils.js";
import { tmuxSendKeys } from "../lib/tmux.js";
import { PanesManager } from "../lib/panes-manager.js";
import type { HistoryEvent } from "../types.js";

export interface EscalateOptions {
  task: string;
  step: string;
  reason: string;
}

/**
 * Core escalate logic, exported for testability.
 *
 * @param opts         command options
 * @param sendKeysFn   injectable tmux send-keys function (for mocking)
 * @param basePath     base path for .panes.yaml lookup (defaults to cwd)
 */
export async function handleEscalate(
  opts: EscalateOptions,
  sendKeysFn: (paneId: string, text: string) => Promise<void> = tmuxSendKeys,
  basePath?: string,
): Promise<void> {
  const { task: taskPath, step: stepPath, reason } = opts;

  if (!reason) {
    throw new Error("--reason is required for escalate");
  }

  const resolvedPath = resolve(taskPath);
  validateTaskPath(resolvedPath);
  const taskYaml = loadAndValidateTask(resolvedPath);

  // Validate step exists
  const step = findStep(taskYaml.steps, stepPath);
  if (!step) {
    throw new Error(`Step not found: "${stepPath}"`);
  }

  // 1. Transition status to blocked
  const currentStatus = step.status || "pending";
  validateStepTransition(currentStatus, "blocked");
  step.status = "blocked";

  // 2. Add escalation event to history
  const configYaml = loadConfig(resolvedPath);
  const history = taskYaml.history || [];
  const at = new Date().toISOString();
  const by = resolveBy("escalation", taskYaml, stepPath, configYaml);
  const attempt = resolveAttempt("escalation", history, stepPath);

  const event: Record<string, unknown> = {
    at,
    type: "escalation",
    by,
    step: stepPath,
    attempt,
    reason,
  };

  history.push(event as unknown as HistoryEvent);
  taskYaml.history = history;

  // Write back atomically
  const yamlContent = yaml.dump(taskYaml, {
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
  });
  writeFileSync(resolvedPath, yamlContent);

  // 3. Notify parent orchestrator via tmux
  // Look up the pane's parent from .panes.yaml (in epic directory)
  const panesManager = new PanesManager(dirname(resolvedPath));
  const panes = panesManager.load();
  const pane = panes.find(
    (p) => p.step === stepPath && p.task_path === resolvedPath,
  );
  const parentPaneId = pane?.parent_pane_id;

  if (parentPaneId) {
    try {
      await sendKeysFn(parentPaneId, `${stepPath} blocked: ${reason}`);
    } catch {
      // tmux may not be available — don't fail the command for notification
    }
  }

  console.log(
    `Escalated ${stepPath} to blocked: ${reason}`,
  );
}
