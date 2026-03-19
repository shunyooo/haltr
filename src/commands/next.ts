/**
 * `hal next` — Advance to the next step.
 *
 * Combines: status done → history step_started → status in_progress → spawn worker
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
import { handleSpawn } from "./spawn.js";
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

  // 5. Spawn worker for the new step
  await handleSpawn(
    { role: "worker", task: opts.task, step: opts.to },
    runtime,
    basePath,
  );
}

function countAttempts(history: any[], stepId: string): number {
  return history.filter(
    (e: any) => e.type === "step_started" && e.step === stepId,
  ).length;
}
