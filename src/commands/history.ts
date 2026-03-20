import type { Command } from "commander";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";
import { loadAndValidateTask } from "../lib/validator.js";
import {
  resolveBy,
  resolveAttempt,
  loadConfig,
  findStep,
  validateTaskPath,
} from "../lib/task-utils.js";
import type { HistoryEvent, } from "../types.js";

/**
 * Event types that require --step.
 */
const STEP_REQUIRED_TYPES = new Set([
  "step_started",
  "work_done",
  "verifier_started",
  "verification_passed",
  "verification_failed",
  "escalation",
  "blocked_resolved",
  "step_skipped",
]);

/**
 * Event types that must NOT have --step (task-level events).
 */
const STEP_NOT_ALLOWED_TYPES = new Set(["completed", "spec_reviewed", "execution_approved", "user_feedback"]);

/**
 * Event types not supported by `hal history add`.
 */
const UNSUPPORTED_TYPES = new Set(["created", "updated", "pivoted"]);

/**
 * Event types that require --accept-id.
 */
const ACCEPT_ID_REQUIRED_TYPES = new Set([
  "verifier_started",
  "verification_passed",
  "verification_failed",
]);

/**
 * Event types that have an `attempt` field.
 */
const ATTEMPT_TYPES = new Set([
  "step_started",
  "work_done",
  "verifier_started",
  "verification_passed",
  "verification_failed",
  "escalation",
  "blocked_resolved",
]);

export function registerHistoryCommand(program: Command): void {
  const history = program
    .command("history")
    .description("Manage task history events");

  history
    .command("add")
    .description("Add a history event to a task")
    .requiredOption("--type <type>", "Event type")
    .requiredOption("--task <path>", "Path to task.yaml")
    .option("--step <step>", "Step path (e.g., step-1/data-collection)")
    .option("--message <text>", "Message text")
    .option("--accept-id <id>", "Accept criterion ID")
    .action((opts) => {
      try {
        handleHistoryAdd(opts);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    });

  history
    .command("show")
    .description("Show history events")
    .requiredOption("--task <path>", "Path to task.yaml")
    .option("--step <step>", "Filter by step")
    .option("--type <type>", "Filter by event type")
    .option("--last", "Show only the most recent matching event")
    .action(async (opts) => {
      try {
        const { handleHistoryShow } = await import("./history-show.js");
        const output = handleHistoryShow(opts);
        console.log(output);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    });
}

function handleHistoryAdd(opts: {
  type: string;
  task: string;
  step?: string;
  message?: string;
  acceptId?: string;
}): void {
  const { type, task: taskPath, step, message, acceptId } =
    opts;

  // Validate event type
  if (UNSUPPORTED_TYPES.has(type)) {
    throw new Error(
      `Event type "${type}" is not supported by hal history add (use hal task new/edit instead)`,
    );
  }

  const allKnownTypes = new Set([
    ...STEP_REQUIRED_TYPES,
    ...STEP_NOT_ALLOWED_TYPES,
    ...UNSUPPORTED_TYPES,
  ]);
  if (!allKnownTypes.has(type)) {
    throw new Error(`Unknown event type: "${type}"`);
  }

  // Validate step requirement
  if (STEP_REQUIRED_TYPES.has(type) && !step) {
    throw new Error(`--step is required for event type "${type}"`);
  }
  if (STEP_NOT_ALLOWED_TYPES.has(type) && step) {
    throw new Error(`--step is not allowed for event type "${type}"`);
  }

  // Validate accept-id requirement
  if (ACCEPT_ID_REQUIRED_TYPES.has(type) && !acceptId) {
    throw new Error(`--accept-id is required for event type "${type}"`);
  }

  // No type-specific required message fields anymore (all optional)

  // Load task.yaml
  const resolvedPath = resolve(taskPath);
  validateTaskPath(resolvedPath);
  const taskYaml = loadAndValidateTask(resolvedPath);

  // Validate step exists if provided
  if (step) {
    const foundStep = findStep(taskYaml.steps, step);
    if (!foundStep) {
      throw new Error(`Step not found: "${step}"`);
    }
  }

  // Load config for `by` resolution
  const configYaml = loadConfig(resolvedPath);

  // Resolve acceptType for verification events
  let acceptType: string | undefined;
  if (
    acceptId &&
    step &&
    (type === "verification_passed" || type === "verification_failed")
  ) {
    const foundStepObj = findStep(taskYaml.steps, step);
    if (foundStepObj?.accept && Array.isArray(foundStepObj.accept)) {
      const acceptObj = (foundStepObj.accept as import("../types.js").AcceptObject[]).find(
        (a) => a.id === acceptId,
      );
      if (acceptObj?.type) {
        acceptType = acceptObj.type;
      }
    }
  }

  // Resolve auto fields
  const at = new Date().toISOString();
  const by = resolveBy(type, taskYaml, step, configYaml, acceptId, acceptType);

  const history = taskYaml.history || [];

  // Build the event
  const event: Record<string, unknown> = {
    at,
    type,
    by,
  };

  if (step) {
    event.step = step;
  }

  // Add attempt for types that need it
  if (ATTEMPT_TYPES.has(type) && step) {
    event.attempt = resolveAttempt(type, history, step);
  }

  // Add type-specific fields
  if (message) event.message = message;
  if (acceptId) event.accept_id = acceptId;

  // Append to history
  history.push(event as unknown as HistoryEvent);
  taskYaml.history = history;

  // Write back to disk
  const yamlContent = yaml.dump(taskYaml, {
    lineWidth: -1,
    noRefs: true,
    quotingType: '"',
  });
  writeFileSync(resolvedPath, yamlContent);

  console.log(`Recorded ${type} event`);
}
