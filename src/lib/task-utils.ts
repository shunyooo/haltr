import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import type {
  Step,
  StepStatus,
  TaskYaml,
  ConfigYaml,
  HistoryEvent,
  AcceptObject,
} from "../types.js";
import { loadAndValidateConfig } from "./validator.js";

/**
 * Whitelist of valid CLI provider names.
 */
export const VALID_CLIS = new Set(["claude", "codex", "gemini"]);

/**
 * Parsed CLI specification.
 * Format: "provider" or "provider:model"
 * Examples: "claude", "claude:sonnet", "claude:haiku", "codex"
 */
export interface ParsedCli {
  provider: string;
  model?: string;
}

/**
 * Parse a CLI specification string.
 * "claude" → { provider: "claude" }
 * "claude:sonnet" → { provider: "claude", model: "sonnet" }
 */
export function parseCli(cli: string): ParsedCli {
  const parts = cli.split(":");
  const provider = parts[0];
  const model = parts[1] || undefined;
  return { provider, model };
}

/**
 * Validate that a CLI specification is valid.
 * Accepts "provider" or "provider:model" format.
 * Throws an error if the provider is not valid.
 */
export function validateCli(cli: string): void {
  const { provider } = parseCli(cli);
  if (!VALID_CLIS.has(provider)) {
    throw new Error(
      `Invalid CLI: "${cli}". Valid providers: ${[...VALID_CLIS].join(", ")}`,
    );
  }
}

/**
 * Validate that a resolved task path is within a haltr directory tree.
 * The resolved path must contain `/haltr/` somewhere in the path,
 * and must not contain path traversal sequences after resolution.
 * Throws an error if the path escapes the expected tree.
 */
export function validateTaskPath(resolvedPath: string): void {
  const normalized = resolve(resolvedPath);
  // path.resolve() already normalizes traversal sequences;
  // primary guard is /haltr/ check below
  // The path must be within a haltr/ directory tree
  if (!normalized.includes("/haltr/")) {
    throw new Error(
      `Invalid task path: "${resolvedPath}" is not within a haltr/ directory tree`,
    );
  }
}

/**
 * Find a step by path (supports nested paths like "step-1/data-collection").
 * Returns the step or undefined if not found.
 */
export function findStep(steps: Step[], stepPath: string): Step | undefined {
  const parts = stepPath.split("/");
  let current: Step[] = steps;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const found = current.find((s) => s.id === part);
    if (!found) return undefined;
    if (i === parts.length - 1) return found;
    if (!found.steps) return undefined;
    current = found.steps;
  }
  return undefined;
}

/**
 * Find the parent step of a given step path.
 * Returns undefined if the step is at root level or path is invalid.
 */
export function findParentStep(
  steps: Step[],
  stepPath: string,
): Step | undefined {
  const parts = stepPath.split("/");
  if (parts.length <= 1) return undefined;

  const parentPath = parts.slice(0, -1).join("/");
  return findStep(steps, parentPath);
}

/**
 * Event types that are resolved by the orchestrator.
 */
const orchestratorEvents = new Set([
  "step_started",
  "verifier_started",
  "blocked_resolved",
  "spec_reviewed",
  "execution_approved",
  "completed",
  "step_skipped",
]);

/**
 * Event types that are resolved by the worker.
 */
const workerEvents = new Set(["work_done", "escalation"]);

/**
 * Event types that are resolved by the verifier.
 */
const verifierEvents = new Set(["verification_passed", "verification_failed"]);

/**
 * Resolve the `by` field for a history event.
 */
export function resolveBy(
  type: string,
  taskYaml: TaskYaml,
  stepPath: string | undefined,
  configYaml: ConfigYaml,
  acceptId?: string,
  acceptType?: string,
): string {
  if (type === "user_feedback") {
    return "user";
  }

  if (orchestratorEvents.has(type)) {
    return `orchestrator(${configYaml.orchestrator_cli})`;
  }

  if (workerEvents.has(type)) {
    // Check step-level agent override
    if (stepPath) {
      const step = findStep(taskYaml.steps, stepPath);
      if (step?.agents?.worker) {
        return `worker(${step.agents.worker})`;
      }
    }
    return `worker(${taskYaml.agents.worker})`;
  }

  if (verifierEvents.has(type)) {
    // For human checks, the orchestrator records the result
    if (acceptType === "human") {
      return `orchestrator(${configYaml.orchestrator_cli})`;
    }
    // Check accept-level verifier override
    if (stepPath && acceptId) {
      const step = findStep(taskYaml.steps, stepPath);
      if (step?.accept && Array.isArray(step.accept)) {
        const acceptArr = step.accept as AcceptObject[];
        const acceptObj = acceptArr.find((a) => a.id === acceptId);
        if (acceptObj?.verifier) {
          return `verifier(${acceptObj.verifier})`;
        }
      }
    }
    // Check step-level agent override
    if (stepPath) {
      const step = findStep(taskYaml.steps, stepPath);
      if (step?.agents?.verifier) {
        return `verifier(${step.agents.verifier})`;
      }
    }
    return `verifier(${taskYaml.agents.verifier})`;
  }

  throw new Error(`Unknown event type for by resolution: ${type}`);
}

/**
 * Calculate the attempt number for a history event.
 * For step_started: count of previous step_started events for same step + 1
 * For other step events: inherit from latest step_started for that step
 */
export function resolveAttempt(
  type: string,
  history: HistoryEvent[],
  stepPath: string,
): number {
  const stepStartedCount = history.filter(
    (e) => e.type === "step_started" && "step" in e && e.step === stepPath,
  ).length;

  if (type === "step_started") {
    return stepStartedCount + 1;
  }

  // For non-step_started events, inherit from the latest step_started
  // If no step_started exists, default to 1
  return Math.max(stepStartedCount, 1);
}

/**
 * Find the haltr/ directory by searching up from the given path.
 * Accepts both file paths (e.g., task.yaml) and directory paths.
 * Returns the path to the haltr/ directory.
 *
 * @param path - A file path (e.g., task.yaml) or directory path
 * @param searchUpward - If true, search upward from the path. If false, only check the path itself.
 * @throws Error if haltr directory cannot be found
 */
export function findHaltrDir(path: string, searchUpward = true): string {
  const resolved = resolve(path);

  // Determine starting directory
  let dir: string;
  try {
    const stats = statSync(resolved);
    dir = stats.isDirectory() ? resolved : dirname(resolved);
  } catch {
    // If path doesn't exist, assume it's a file path and use its directory
    dir = dirname(resolved);
  }

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

    if (!searchUpward) {
      throw new Error(
        `Could not find haltr/ directory in ${path}. Run 'hal init' first.`,
      );
    }

    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not find haltr/ directory searching up from ${path}`,
      );
    }
    dir = parent;
  }
}

/**
 * Load config.yaml by searching upward from the task.yaml location
 * for a haltr/ directory containing config.yaml.
 */
export function loadConfig(taskPath: string): ConfigYaml {
  let dir = dirname(resolve(taskPath));

  // Walk upward to find haltr/ directory
  while (true) {
    // Check if this directory IS a haltr directory (contains config.yaml)
    try {
      const configPath = resolve(dir, "config.yaml");
      readFileSync(configPath, "utf-8");
      return loadAndValidateConfig(configPath);
    } catch {
      // not found here
    }

    // Check if parent/haltr/config.yaml exists
    try {
      const configPath = resolve(dir, "haltr", "config.yaml");
      readFileSync(configPath, "utf-8");
      return loadAndValidateConfig(configPath);
    } catch {
      // not found here
    }

    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not find haltr/config.yaml searching up from ${taskPath}`,
      );
    }
    dir = parent;
  }
}

/**
 * Valid step status values.
 */
const VALID_STEP_STATUSES = new Set([
  "pending",
  "in_progress",
  "done",
  "failed",
  "blocked",
  "skipped",
]);

/**
 * Valid task status values.
 */
const VALID_TASK_STATUSES = new Set([
  "pending",
  "in_progress",
  "done",
  "failed",
  "pivoted",
]);

/**
 * Allowed status transitions for steps.
 */
const STEP_TRANSITIONS: Record<string, Set<string>> = {
  pending: new Set(["in_progress", "skipped"]),
  in_progress: new Set(["done", "failed", "blocked"]),
  done: new Set(),
  failed: new Set(["in_progress"]),
  blocked: new Set(["in_progress"]),
  skipped: new Set(),
};

/**
 * Allowed status transitions for tasks.
 */
const TASK_TRANSITIONS: Record<string, Set<string>> = {
  pending: new Set(["in_progress", "pivoted"]),
  in_progress: new Set(["done", "failed", "pivoted"]),
  done: new Set(),
  failed: new Set(["in_progress"]),
  pivoted: new Set(),
};

/**
 * Validate a step status transition.
 */
export function validateStepTransition(
  currentStatus: string,
  newStatus: string,
): void {
  if (!VALID_STEP_STATUSES.has(newStatus)) {
    throw new Error(`Invalid step status: "${newStatus}"`);
  }

  const current = currentStatus || "pending";
  const allowed = STEP_TRANSITIONS[current];
  if (!allowed || !allowed.has(newStatus)) {
    throw new Error(
      `Invalid status transition: ${current} -> ${newStatus}`,
    );
  }
}

/**
 * Validate a task status transition.
 */
export function validateTaskTransition(
  currentStatus: string,
  newStatus: string,
): void {
  if (!VALID_TASK_STATUSES.has(newStatus)) {
    throw new Error(`Invalid task status: "${newStatus}"`);
  }

  const current = currentStatus || "pending";
  const allowed = TASK_TRANSITIONS[current];
  if (!allowed || !allowed.has(newStatus)) {
    throw new Error(
      `Invalid status transition: ${current} -> ${newStatus}`,
    );
  }
}

/**
 * Judge parent step status based on children.
 * Returns the new status or undefined if no change needed.
 */
export function judgeParentStatus(parent: Step): StepStatus | undefined {
  const children = parent.steps;
  if (!children || children.length === 0) return undefined;

  const statuses = children.map((c) => c.status || "pending");

  // Any child blocked → parent blocked
  if (statuses.some((s) => s === "blocked")) return "blocked";

  // Any child in_progress → parent in_progress
  if (statuses.some((s) => s === "in_progress")) return "in_progress";

  // Any child failed (and no in_progress, no blocked) → parent failed
  if (statuses.some((s) => s === "failed")) return "failed";

  // All children done or skipped → parent done
  if (statuses.every((s) => s === "done" || s === "skipped")) return "done";

  return undefined;
}
