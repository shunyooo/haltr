/**
 * `hal next` — Advance to the next step.
 *
 * Combines: status done → history step_started → status in_progress → spawn/continue worker
 *
 * If worker_session is "shared", reuses the existing worker pane instead of spawning a new one.
 */

import { resolve, dirname } from "node:path";
import { writeFileSync } from "node:fs";
import * as yaml from "js-yaml";
import { loadAndValidateTask } from "../lib/validator.js";
import {
  findStep,
  validateTaskPath,
  validateStepTransition,
  loadConfig,
} from "../lib/task-utils.js";
import { handleSpawn, assemblePrompt, renderHooks, readRules } from "./spawn.js";
import { PanesManager } from "../lib/panes-manager.js";
import { tmuxSendKeys } from "../lib/tmux.js";
import type { Runtime } from "../lib/runtime.js";

export interface NextOptions {
  task: string;
  from: string;
  to: string;
}

export async function handleNext(
  opts: NextOptions,
  runtime?: Runtime,
  basePath?: string,
): Promise<void> {
  const taskPath = resolve(opts.task);
  validateTaskPath(taskPath);

  const task = loadAndValidateTask(taskPath);

  // 1. Mark "from" step as done
  const fromStep = findStep(task.steps, opts.from);
  if (!fromStep) {
    throw new Error(`Step not found: "${opts.from}"`);
  }
  validateStepTransition(fromStep.status ?? "pending", "done");
  fromStep.status = "done";

  // 2. Validate "to" step exists and is pending
  const toStep = findStep(task.steps, opts.to);
  if (!toStep) {
    throw new Error(`Step not found: "${opts.to}"`);
  }
  if (toStep.status && toStep.status !== "pending") {
    throw new Error(`Step "${opts.to}" is not pending (current: ${toStep.status})`);
  }
  toStep.status = "in_progress";

  // 3. Add history events
  const now = new Date().toISOString();
  let by = "orchestrator(claude)";
  try {
    const config = loadConfig(taskPath);
    by = `orchestrator(${config.orchestrator_cli})`;
  } catch {}

  if (!task.history) task.history = [];
  task.history.push({
    at: now,
    type: "step_started" as const,
    by,
    step: opts.to,
    attempt: countAttempts(task.history, opts.to) + 1,
  } as any);

  // 4. Save task
  writeFileSync(taskPath, yaml.dump(task, { lineWidth: -1 }));

  console.log(`${opts.from} → done`);
  console.log(`${opts.to} → in_progress`);

  // 5. Continue existing worker or spawn new one
  const isShared = task.worker_session === "shared";

  if (isShared) {
    // Find existing worker pane
    const epicDir = dirname(taskPath);
    const pm = new PanesManager(epicDir);
    const panes = pm.load();
    const workerPane = panes.find((p) => p.role === "worker");

    if (workerPane) {
      // Send next step instruction to existing worker pane
      const stepDetails = buildStepInstruction(task, opts.to, taskPath);
      try {
        await tmuxSendKeys(workerPane.pane_id, stepDetails);
        console.log(`Worker pane ${workerPane.pane_id} に次のステップを送信しました`);
      } catch {
        // Pane might be dead — fall back to spawn
        console.log("Worker pane が見つかりません。新しい worker を spawn します。");
        await handleSpawn(
          { role: "worker", task: opts.task, step: opts.to },
          runtime,
          basePath,
        );
      }
      return;
    }
  }

  // Default: spawn new worker
  await handleSpawn(
    { role: "worker", task: opts.task, step: opts.to },
    runtime,
    basePath,
  );
}

/**
 * Build a short instruction message for the next step (sent to existing worker).
 */
function buildStepInstruction(task: any, stepId: string, taskPath: string): string {
  const step = findStep(task.steps, stepId);
  if (!step) return `次のステップ: ${stepId}`;

  let msg = `次のステップに進んでください。\n\n`;
  msg += `## Step: ${step.id}\n`;
  msg += `Goal: ${step.goal}\n`;
  if (step.accept) {
    if (typeof step.accept === "string") {
      msg += `Accept: ${step.accept}\n`;
    } else if (Array.isArray(step.accept)) {
      msg += `Accept criteria:\n`;
      for (const a of step.accept) {
        msg += `  - ${(a as any).id}: ${(a as any).check ?? (a as any).instruction ?? ""}\n`;
      }
    }
  }
  msg += `\n完了したら: hal history add --type work_done --step '${stepId}' --task '${taskPath}' --message '作業内容'`;
  return msg;
}

function countAttempts(history: any[], stepId: string): number {
  return history.filter(
    (e: any) => e.type === "step_started" && e.step === stepId,
  ).length;
}
