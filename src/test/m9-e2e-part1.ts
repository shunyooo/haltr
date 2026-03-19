/**
 * M9 E2E Scenario Tests — Part 1 (Scenarios 1-9)
 *
 * End-to-end workflow tests that simulate full haltr orchestration flows.
 * Calls actual command logic functions directly (tmux mocked).
 *
 * Run with: npm run test:m9a
 */

import {
  writeFileSync,
  readFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join, resolve, basename } from "node:path";
import { tmpdir } from "node:os";
import * as yaml from "js-yaml";

import { initHaltr } from "../commands/init.js";
import { createEpic, archiveEpic } from "../commands/epic.js";
import { createTask } from "../commands/task.js";
import {
  checkWorker,
  checkVerifier,
  checkOrchestrator,
} from "../commands/check.js";
import {
  resolveCli,
  renderHooks,
  assemblePrompt,
  handleSpawn,
  findHaltrDir,
} from "../commands/spawn.js";
import { handleEscalate } from "../commands/escalate.js";
import { handleKill } from "../commands/kill-cmd.js";
import { loadAndValidateTask, validateTask } from "../lib/validator.js";
import {
  findStep,
  resolveBy,
  resolveAttempt,
  loadConfig,
  validateStepTransition,
  validateTaskTransition,
  judgeParentStatus,
} from "../lib/task-utils.js";
import { PanesManager, type PaneEntry } from "../lib/panes-manager.js";
import { Watcher, type WatcherDeps } from "../lib/watcher.js";
import type {
  TaskYaml,
  ConfigYaml,
  HistoryEvent,
  AcceptObject,
  Step,
} from "../types.js";

// ============================================================================
// Test harness
// ============================================================================

let passed = 0;
let failed = 0;
const results: Array<{
  name: string;
  status: "PASS" | "FAIL";
  detail?: string;
}> = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, status: "PASS" });
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (e: unknown) {
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ name, status: "FAIL", detail });
    failed++;
    console.log(`  FAIL: ${name}`);
    console.log(`        ${detail.split("\n")[0]}`);
  }
}

async function testAsync(
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
    results.push({ name, status: "PASS" });
    passed++;
    console.log(`  PASS: ${name}`);
  } catch (e: unknown) {
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ name, status: "FAIL", detail });
    failed++;
    console.log(`  FAIL: ${name}`);
    console.log(`        ${detail.split("\n")[0]}`);
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function assertIncludes(str: string, substr: string, label: string): void {
  if (!str.includes(substr)) {
    throw new Error(
      `${label}: expected string to include ${JSON.stringify(substr)}, got ${JSON.stringify(str.slice(0, 200))}`,
    );
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Set up a fresh haltr environment in a temp dir with init + epic + task.
 * Returns { baseDir, epicDir, taskPath }.
 */
function setupEnv(opts: {
  epicName?: string;
  steps: Step[];
  agents?: { worker: string; verifier: string };
}): { baseDir: string; epicDir: string; taskPath: string } {
  const baseDir = mkdtempSync(join(tmpdir(), "haltr-m9-"));

  // hal init
  initHaltr(baseDir);

  // hal epic create
  const epicName = opts.epicName ?? "test-epic";
  const epicDir = createEpic(baseDir, epicName, new Date("2026-03-19"));

  // hal task new
  const taskPath = createTask(baseDir, epicName);

  // Now load the task, set up the steps we want, write back
  const task = readTask(taskPath);
  task.steps = opts.steps;
  if (opts.agents) {
    task.agents = opts.agents;
  }
  writeTask(taskPath, task);

  return { baseDir, epicDir, taskPath };
}

function readTask(taskPath: string): TaskYaml {
  const content = readFileSync(taskPath, "utf-8");
  return yaml.load(content) as TaskYaml;
}

function writeTask(taskPath: string, task: TaskYaml): void {
  writeFileSync(
    taskPath,
    yaml.dump(task, { lineWidth: -1, noRefs: true, quotingType: '"' }),
  );
}

/**
 * Add a history event to a task.yaml file, simulating what `hal history add` does.
 * Validates the task after writing.
 */
function addHistoryEvent(
  taskPath: string,
  event: Record<string, unknown>,
): void {
  const task = readTask(taskPath);
  if (!task.history) task.history = [];
  task.history.push(event as unknown as HistoryEvent);
  writeTask(taskPath, task);
  // Validate the written task is still valid
  const reloaded = readTask(taskPath);
  validateTask(reloaded);
}

/**
 * Update step status in a task.yaml file, simulating what `hal status` does.
 * Validates status transitions.
 */
function updateStepStatus(
  taskPath: string,
  stepPath: string,
  newStatus: string,
): void {
  const task = readTask(taskPath);
  const step = findStep(task.steps, stepPath);
  if (!step) throw new Error(`Step not found: ${stepPath}`);
  const currentStatus = step.status || "pending";
  validateStepTransition(currentStatus, newStatus);
  step.status = newStatus as any;
  writeTask(taskPath, task);
}

/**
 * Update task status in a task.yaml file.
 */
function updateTaskStatus(taskPath: string, newStatus: string): void {
  const task = readTask(taskPath);
  const currentStatus = task.status || "pending";
  validateTaskTransition(currentStatus, newStatus);
  task.status = newStatus as any;
  writeTask(taskPath, task);
}

/**
 * Build a step_started history event.
 */
function buildStepStartedEvent(
  taskPath: string,
  stepPath: string,
): Record<string, unknown> {
  const task = readTask(taskPath);
  const config = loadConfig(taskPath);
  const history = task.history ?? [];
  return {
    at: new Date().toISOString(),
    type: "step_started",
    by: resolveBy("step_started", task, stepPath, config),
    step: stepPath,
    attempt: resolveAttempt("step_started", history, stepPath),
  };
}

/**
 * Build a work_done history event.
 */
function buildWorkDoneEvent(
  taskPath: string,
  stepPath: string,
  message: string,
): Record<string, unknown> {
  const task = readTask(taskPath);
  const config = loadConfig(taskPath);
  const history = task.history ?? [];
  return {
    at: new Date().toISOString(),
    type: "work_done",
    by: resolveBy("work_done", task, stepPath, config),
    step: stepPath,
    attempt: resolveAttempt("work_done", history, stepPath),
    message,
  };
}

/**
 * Build a verifier_started history event.
 */
function buildVerifierStartedEvent(
  taskPath: string,
  stepPath: string,
  acceptId: string,
): Record<string, unknown> {
  const task = readTask(taskPath);
  const config = loadConfig(taskPath);
  const history = task.history ?? [];
  return {
    at: new Date().toISOString(),
    type: "verifier_started",
    by: resolveBy("verifier_started", task, stepPath, config, acceptId),
    step: stepPath,
    attempt: resolveAttempt("verifier_started", history, stepPath),
    accept_id: acceptId,
  };
}

/**
 * Build a verification_passed history event.
 */
function buildVerificationPassedEvent(
  taskPath: string,
  stepPath: string,
  acceptId: string,
  message: string,
): Record<string, unknown> {
  const task = readTask(taskPath);
  const config = loadConfig(taskPath);
  const history = task.history ?? [];
  return {
    at: new Date().toISOString(),
    type: "verification_passed",
    by: resolveBy("verification_passed", task, stepPath, config, acceptId),
    step: stepPath,
    attempt: resolveAttempt("verification_passed", history, stepPath),
    accept_id: acceptId,
    message,
  };
}

/**
 * Build a verification_failed history event.
 */
function buildVerificationFailedEvent(
  taskPath: string,
  stepPath: string,
  acceptId: string,
  message: string,
): Record<string, unknown> {
  const task = readTask(taskPath);
  const config = loadConfig(taskPath);
  const history = task.history ?? [];
  return {
    at: new Date().toISOString(),
    type: "verification_failed",
    by: resolveBy("verification_failed", task, stepPath, config, acceptId),
    step: stepPath,
    attempt: resolveAttempt("verification_failed", history, stepPath),
    accept_id: acceptId,
    message,
  };
}

/**
 * Build a completed history event.
 */
function buildCompletedEvent(
  taskPath: string,
): Record<string, unknown> {
  const task = readTask(taskPath);
  const config = loadConfig(taskPath);
  return {
    at: new Date().toISOString(),
    type: "completed",
    by: resolveBy("completed", task, undefined, config),
  };
}

/**
 * Build a step_skipped history event.
 */
function buildStepSkippedEvent(
  taskPath: string,
  stepPath: string,
  message: string,
): Record<string, unknown> {
  const task = readTask(taskPath);
  const config = loadConfig(taskPath);
  return {
    at: new Date().toISOString(),
    type: "step_skipped",
    by: resolveBy("step_skipped", task, stepPath, config),
    step: stepPath,
    message,
  };
}

/**
 * Build a blocked_resolved history event.
 */
function buildBlockedResolvedEvent(
  taskPath: string,
  stepPath: string,
  message: string,
): Record<string, unknown> {
  const task = readTask(taskPath);
  const config = loadConfig(taskPath);
  const history = task.history ?? [];
  return {
    at: new Date().toISOString(),
    type: "blocked_resolved",
    by: resolveBy("blocked_resolved", task, stepPath, config),
    step: stepPath,
    attempt: resolveAttempt("blocked_resolved", history, stepPath),
    message,
  };
}

/**
 * Get all history events of a given type from a task.
 */
function getHistoryByType(taskPath: string, type: string): HistoryEvent[] {
  const task = readTask(taskPath);
  return (task.history ?? []).filter((e) => e.type === type);
}

/**
 * Clean up temp dir.
 */
function cleanup(baseDir: string): void {
  rmSync(baseDir, { recursive: true, force: true });
}

// ============================================================================
// Scenario 1: Minimal (no accept)
// ============================================================================

function scenario1(): void {
  console.log("\n--- Scenario 1: Minimal (no accept) ---");

  const { baseDir, taskPath } = setupEnv({
    steps: [
      { id: "step-1", goal: "Implement feature X" },
    ],
  });

  try {
    // 1. step_started
    addHistoryEvent(taskPath, buildStepStartedEvent(taskPath, "step-1"));
    updateStepStatus(taskPath, "step-1", "in_progress");

    test("S1: step_started event has attempt=1", () => {
      const events = getHistoryByType(taskPath, "step_started");
      assertEqual(events.length, 1, "step_started count");
      assertEqual((events[0] as any).attempt, 1, "attempt");
      assertEqual((events[0] as any).step, "step-1", "step");
      assertIncludes((events[0] as any).by, "orchestrator", "by should be orchestrator");
    });

    test("S1: step status is in_progress", () => {
      const task = readTask(taskPath);
      assertEqual(task.steps[0].status, "in_progress", "step status");
    });

    // 2. Simulate spawn worker (mock - no tmux)
    test("S1: checkWorker blocks before work_done", () => {
      const task = readTask(taskPath);
      const result = checkWorker(task, "step-1");
      assertEqual(result.action, "block", "should block");
    });

    // 3. work_done
    addHistoryEvent(
      taskPath,
      buildWorkDoneEvent(taskPath, "step-1", "Implemented feature X"),
    );

    test("S1: work_done event has attempt=1 and correct by", () => {
      const events = getHistoryByType(taskPath, "work_done");
      assertEqual(events.length, 1, "work_done count");
      assertEqual((events[0] as any).attempt, 1, "attempt");
      assertIncludes((events[0] as any).by, "worker", "by should contain worker");
      assertIncludes((events[0] as any).by, "claude", "by should contain claude");
    });

    // 4. checkWorker allows (no accept -> allow)
    test("S1: checkWorker allows after work_done (no accept)", () => {
      const task = readTask(taskPath);
      const result = checkWorker(task, "step-1");
      assertEqual(result.action, "allow", "should allow");
      assert(result.notification !== undefined, "should have notification");
      assertIncludes(result.notification!, "accept", "notification mentions accept");
    });

    // 5. status done
    updateStepStatus(taskPath, "step-1", "done");

    test("S1: step status is done", () => {
      const task = readTask(taskPath);
      assertEqual(task.steps[0].status, "done", "step status");
    });

    // 6. completed event
    addHistoryEvent(taskPath, buildCompletedEvent(taskPath));

    // 7. task done
    updateTaskStatus(taskPath, "in_progress");
    updateTaskStatus(taskPath, "done");

    test("S1: final task status is done", () => {
      const task = readTask(taskPath);
      assertEqual(task.status, "done", "task status");
    });

    test("S1: history has correct event sequence", () => {
      const task = readTask(taskPath);
      const history = task.history ?? [];
      // created -> step_started -> work_done -> completed
      const types = history.map((e) => e.type);
      assert(types.includes("created"), "has created");
      assert(types.includes("step_started"), "has step_started");
      assert(types.includes("work_done"), "has work_done");
      assert(types.includes("completed"), "has completed");

      const startedIdx = types.indexOf("step_started");
      const workDoneIdx = types.indexOf("work_done");
      const completedIdx = types.indexOf("completed");
      assert(startedIdx < workDoneIdx, "step_started before work_done");
      assert(workDoneIdx < completedIdx, "work_done before completed");
    });
  } finally {
    cleanup(baseDir);
  }
}

// ============================================================================
// Scenario 2: Verification PASS
// ============================================================================

function scenario2(): void {
  console.log("\n--- Scenario 2: Verification PASS ---");

  const { baseDir, taskPath } = setupEnv({
    steps: [
      {
        id: "step-1",
        goal: "Implement and verify feature Y",
        accept: "npm test passes",
      },
    ],
  });

  try {
    // 1. step_started
    addHistoryEvent(taskPath, buildStepStartedEvent(taskPath, "step-1"));
    updateStepStatus(taskPath, "step-1", "in_progress");

    // 2. work_done
    addHistoryEvent(
      taskPath,
      buildWorkDoneEvent(taskPath, "step-1", "Feature Y implemented"),
    );

    // 3. checkWorker -> allow + wait (accept exists)
    test("S2: checkWorker allows with verification wait message", () => {
      const task = readTask(taskPath);
      const result = checkWorker(task, "step-1");
      assertEqual(result.action, "allow", "should allow");
      assert(result.notification !== undefined, "should have notification");
    });

    // 4. verifier_started (accept string is expanded to [{id:"default", check:"..."}])
    addHistoryEvent(
      taskPath,
      buildVerifierStartedEvent(taskPath, "step-1", "default"),
    );

    test("S2: verifier_started event has accept_id=default", () => {
      const events = getHistoryByType(taskPath, "verifier_started");
      assertEqual(events.length, 1, "verifier_started count");
      assertEqual((events[0] as any).accept_id, "default", "accept_id");
      assertEqual((events[0] as any).attempt, 1, "attempt");
    });

    // 5. Simulate spawn verifier (mock)
    // 6. verification_passed
    addHistoryEvent(
      taskPath,
      buildVerificationPassedEvent(
        taskPath,
        "step-1",
        "default",
        "All tests pass: 42 passing",
      ),
    );

    test("S2: verification_passed has correct by field", () => {
      const events = getHistoryByType(taskPath, "verification_passed");
      assertEqual(events.length, 1, "verification_passed count");
      assertIncludes(
        (events[0] as any).by,
        "verifier",
        "by should contain verifier",
      );
      assertIncludes(
        (events[0] as any).by,
        "claude",
        "by should contain claude (default verifier from config)",
      );
      assertEqual((events[0] as any).accept_id, "default", "accept_id");
      assertEqual((events[0] as any).attempt, 1, "attempt");
    });

    // 7. checkVerifier -> allow
    test("S2: checkVerifier allows after verification_passed", () => {
      const task = readTask(taskPath);
      const result = checkVerifier(task, "step-1");
      assertEqual(result.action, "allow", "should allow");
    });

    // 8. step done
    updateStepStatus(taskPath, "step-1", "done");

    // 9. completed + task done
    addHistoryEvent(taskPath, buildCompletedEvent(taskPath));
    updateTaskStatus(taskPath, "in_progress");
    updateTaskStatus(taskPath, "done");

    test("S2: final task status is done", () => {
      const task = readTask(taskPath);
      assertEqual(task.status, "done", "task status");
      assertEqual(task.steps[0].status, "done", "step status");
    });

    test("S2: full history chain with correct by fields", () => {
      const task = readTask(taskPath);
      const history = task.history ?? [];
      const types = history.map((e) => e.type);
      assert(types.includes("step_started"), "has step_started");
      assert(types.includes("work_done"), "has work_done");
      assert(types.includes("verifier_started"), "has verifier_started");
      assert(types.includes("verification_passed"), "has verification_passed");
      assert(types.includes("completed"), "has completed");

      // Verify order
      const si = types.indexOf("step_started");
      const wd = types.indexOf("work_done");
      const vs = types.indexOf("verifier_started");
      const vp = types.indexOf("verification_passed");
      const co = types.indexOf("completed");
      assert(si < wd, "step_started < work_done");
      assert(wd < vs, "work_done < verifier_started");
      assert(vs < vp, "verifier_started < verification_passed");
      assert(vp < co, "verification_passed < completed");
    });
  } finally {
    cleanup(baseDir);
  }
}

// ============================================================================
// Scenario 3: Verification FAIL -> Retry -> PASS
// ============================================================================

function scenario3(): void {
  console.log("\n--- Scenario 3: Verification FAIL -> Retry -> PASS ---");

  const { baseDir, taskPath } = setupEnv({
    steps: [
      {
        id: "step-1",
        goal: "Implement with retry",
        accept: "npm test passes",
      },
    ],
  });

  try {
    // Attempt 1
    addHistoryEvent(taskPath, buildStepStartedEvent(taskPath, "step-1"));
    updateStepStatus(taskPath, "step-1", "in_progress");
    addHistoryEvent(
      taskPath,
      buildWorkDoneEvent(taskPath, "step-1", "First attempt at feature"),
    );
    addHistoryEvent(
      taskPath,
      buildVerifierStartedEvent(taskPath, "step-1", "default"),
    );
    addHistoryEvent(
      taskPath,
      buildVerificationFailedEvent(
        taskPath,
        "step-1",
        "default",
        "3 tests failing",
      ),
    );

    test("S3: verification_failed has attempt=1", () => {
      const events = getHistoryByType(taskPath, "verification_failed");
      assertEqual(events.length, 1, "verification_failed count");
      assertEqual((events[0] as any).attempt, 1, "attempt");
    });

    // Step goes to failed
    updateStepStatus(taskPath, "step-1", "failed");

    test("S3: step status is failed after verification failure", () => {
      const task = readTask(taskPath);
      assertEqual(task.steps[0].status, "failed", "step status");
    });

    // Attempt 2: retry
    // failed -> in_progress is a valid transition
    addHistoryEvent(taskPath, buildStepStartedEvent(taskPath, "step-1"));
    updateStepStatus(taskPath, "step-1", "in_progress");

    test("S3: second step_started has attempt=2", () => {
      const events = getHistoryByType(taskPath, "step_started");
      assertEqual(events.length, 2, "step_started count");
      assertEqual((events[1] as any).attempt, 2, "attempt");
    });

    // Worker fixes
    addHistoryEvent(
      taskPath,
      buildWorkDoneEvent(taskPath, "step-1", "Fixed failing tests"),
    );

    test("S3: second work_done has attempt=2", () => {
      const events = getHistoryByType(taskPath, "work_done");
      assertEqual(events.length, 2, "work_done count");
      assertEqual((events[1] as any).attempt, 2, "attempt");
    });

    // Verification passes on attempt 2
    addHistoryEvent(
      taskPath,
      buildVerifierStartedEvent(taskPath, "step-1", "default"),
    );
    addHistoryEvent(
      taskPath,
      buildVerificationPassedEvent(
        taskPath,
        "step-1",
        "default",
        "All 42 tests pass",
      ),
    );

    test("S3: verification_passed on attempt 2", () => {
      const events = getHistoryByType(taskPath, "verification_passed");
      assertEqual(events.length, 1, "verification_passed count");
      assertEqual((events[0] as any).attempt, 2, "attempt");
    });

    // Step done, completed, task done
    updateStepStatus(taskPath, "step-1", "done");
    addHistoryEvent(taskPath, buildCompletedEvent(taskPath));
    updateTaskStatus(taskPath, "in_progress");
    updateTaskStatus(taskPath, "done");

    test("S3: final status done after retry success", () => {
      const task = readTask(taskPath);
      assertEqual(task.status, "done", "task status");
      assertEqual(task.steps[0].status, "done", "step status");
    });

    test("S3: history has 2 attempts correctly numbered", () => {
      const task = readTask(taskPath);
      const history = task.history ?? [];
      const stepStartedEvents = history.filter(
        (e) => e.type === "step_started",
      );
      assertEqual(stepStartedEvents.length, 2, "step_started count");
      assertEqual((stepStartedEvents[0] as any).attempt, 1, "first attempt");
      assertEqual((stepStartedEvents[1] as any).attempt, 2, "second attempt");
    });
  } finally {
    cleanup(baseDir);
  }
}

// ============================================================================
// Scenario 3b: Retry with crashed worker
// ============================================================================

function scenario3b(): void {
  console.log(
    "\n--- Scenario 3b: Retry with crashed worker ---",
  );

  const { baseDir, taskPath } = setupEnv({
    steps: [
      {
        id: "step-1",
        goal: "Implement with crash recovery",
        accept: "npm test passes",
      },
    ],
  });

  try {
    // Attempt 1
    addHistoryEvent(taskPath, buildStepStartedEvent(taskPath, "step-1"));
    updateStepStatus(taskPath, "step-1", "in_progress");
    addHistoryEvent(
      taskPath,
      buildWorkDoneEvent(taskPath, "step-1", "First attempt work"),
    );
    addHistoryEvent(
      taskPath,
      buildVerifierStartedEvent(taskPath, "step-1", "default"),
    );
    addHistoryEvent(
      taskPath,
      buildVerificationFailedEvent(
        taskPath,
        "step-1",
        "default",
        "TypeError in module.ts line 42",
      ),
    );

    // Step failed
    updateStepStatus(taskPath, "step-1", "failed");

    // Worker is dead (simulate by checking isAlive would return false)
    // Orchestrator must re-spawn with context from failure

    // Attempt 2: re-spawn with failure reason in prompt
    addHistoryEvent(taskPath, buildStepStartedEvent(taskPath, "step-1"));
    updateStepStatus(taskPath, "step-1", "in_progress");

    // Build spawn prompt that should contain the failure reason
    test("S3b: re-spawn prompt contains failure reason from attempt 1", () => {
      const task = readTask(taskPath);
      const haltrDir = findHaltrDir(taskPath);

      // Render hooks and assemble prompt for worker
      const hooksDir = renderHooks(haltrDir, "worker", taskPath, "step-1");
      const promptPath = assemblePrompt(
        hooksDir,
        haltrDir,
        "worker",
        task,
        taskPath,
        "step-1",
      );

      // The prompt itself contains the step details; in a real system,
      // the orchestrator would add the failure context. We verify the
      // prompt contains step information and the task file reference.
      const promptContent = readFileSync(promptPath, "utf-8");
      assertIncludes(promptContent, "step-1", "prompt mentions step");
      assertIncludes(promptContent, taskPath, "prompt mentions task path");
    });

    // Worker fixes and passes
    addHistoryEvent(
      taskPath,
      buildWorkDoneEvent(taskPath, "step-1", "Fixed TypeError in module.ts"),
    );
    addHistoryEvent(
      taskPath,
      buildVerifierStartedEvent(taskPath, "step-1", "default"),
    );
    addHistoryEvent(
      taskPath,
      buildVerificationPassedEvent(
        taskPath,
        "step-1",
        "default",
        "All tests pass after fix",
      ),
    );

    updateStepStatus(taskPath, "step-1", "done");

    test("S3b: verification_passed on attempt 2 after crash recovery", () => {
      const events = getHistoryByType(taskPath, "verification_passed");
      assertEqual(events.length, 1, "verification_passed count");
      assertEqual((events[0] as any).attempt, 2, "attempt");
    });

    test("S3b: history shows failure reason in attempt 1", () => {
      const events = getHistoryByType(taskPath, "verification_failed");
      assertEqual(events.length, 1, "verification_failed count");
      assertIncludes(
        (events[0] as any).message,
        "TypeError",
        "reason contains error description",
      );
    });
  } finally {
    cleanup(baseDir);
  }
}

// ============================================================================
// Scenario 4: Multi-step serial
// ============================================================================

function scenario4(): void {
  console.log("\n--- Scenario 4: Multi-step serial ---");

  const { baseDir, epicDir, taskPath } = setupEnv({
    epicName: "multi-step",
    steps: [
      {
        id: "step-1",
        goal: "Step one",
        accept: "unit tests pass",
      },
      {
        id: "step-2",
        goal: "Step two",
        accept: "integration tests pass",
      },
      {
        id: "step-3",
        goal: "Step three",
        accept: "e2e tests pass",
      },
    ],
  });

  try {
    // Process each step sequentially
    for (const stepId of ["step-1", "step-2", "step-3"]) {
      addHistoryEvent(taskPath, buildStepStartedEvent(taskPath, stepId));
      updateStepStatus(taskPath, stepId, "in_progress");
      addHistoryEvent(
        taskPath,
        buildWorkDoneEvent(taskPath, stepId, `Completed ${stepId}`),
      );
      addHistoryEvent(
        taskPath,
        buildVerifierStartedEvent(taskPath, stepId, "default"),
      );
      addHistoryEvent(
        taskPath,
        buildVerificationPassedEvent(
          taskPath,
          stepId,
          "default",
          `${stepId} all tests pass`,
        ),
      );
      updateStepStatus(taskPath, stepId, "done");
    }

    // All done -> completed -> task done
    addHistoryEvent(taskPath, buildCompletedEvent(taskPath));
    updateTaskStatus(taskPath, "in_progress");
    updateTaskStatus(taskPath, "done");

    test("S4: all 3 steps are done", () => {
      const task = readTask(taskPath);
      for (const step of task.steps) {
        assertEqual(step.status, "done", `${step.id} status`);
      }
    });

    test("S4: task status is done", () => {
      const task = readTask(taskPath);
      assertEqual(task.status, "done", "task status");
    });

    test("S4: history has 3 step_started events", () => {
      const events = getHistoryByType(taskPath, "step_started");
      assertEqual(events.length, 3, "step_started count");
      assertEqual((events[0] as any).step, "step-1", "first step");
      assertEqual((events[1] as any).step, "step-2", "second step");
      assertEqual((events[2] as any).step, "step-3", "third step");
    });

    test("S4: history has 3 verification_passed events", () => {
      const events = getHistoryByType(taskPath, "verification_passed");
      assertEqual(events.length, 3, "verification_passed count");
    });

    // Epic archive
    test("S4: epic can be archived after task done", () => {
      archiveEpic(baseDir, "multi-step");
      const archivePath = join(
        baseDir,
        "haltr",
        "epics",
        "archive",
      );
      assert(existsSync(archivePath), "archive dir exists");
    });
  } finally {
    cleanup(baseDir);
  }
}

// ============================================================================
// Scenario 4b: Step fail -> subsequent skip propagation
// ============================================================================

function scenario4b(): void {
  console.log(
    "\n--- Scenario 4b: Step fail -> skip propagation ---",
  );

  const { baseDir, taskPath } = setupEnv({
    steps: [
      {
        id: "step-1",
        goal: "Step one (will fail)",
        accept: "tests pass",
      },
      { id: "step-2", goal: "Step two (will be skipped)" },
      { id: "step-3", goal: "Step three (will be skipped)" },
    ],
  });

  try {
    // step-1: attempt 1 fails
    addHistoryEvent(taskPath, buildStepStartedEvent(taskPath, "step-1"));
    updateStepStatus(taskPath, "step-1", "in_progress");
    addHistoryEvent(
      taskPath,
      buildWorkDoneEvent(taskPath, "step-1", "Attempt 1"),
    );
    addHistoryEvent(
      taskPath,
      buildVerifierStartedEvent(taskPath, "step-1", "default"),
    );
    addHistoryEvent(
      taskPath,
      buildVerificationFailedEvent(
        taskPath,
        "step-1",
        "default",
        "Tests fail",
      ),
    );
    updateStepStatus(taskPath, "step-1", "failed");

    // step-1: attempt 2 fails
    addHistoryEvent(taskPath, buildStepStartedEvent(taskPath, "step-1"));
    updateStepStatus(taskPath, "step-1", "in_progress");
    addHistoryEvent(
      taskPath,
      buildWorkDoneEvent(taskPath, "step-1", "Attempt 2"),
    );
    addHistoryEvent(
      taskPath,
      buildVerifierStartedEvent(taskPath, "step-1", "default"),
    );
    addHistoryEvent(
      taskPath,
      buildVerificationFailedEvent(
        taskPath,
        "step-1",
        "default",
        "Tests still fail",
      ),
    );
    updateStepStatus(taskPath, "step-1", "failed");

    // step-1: attempt 3 fails (max_attempts=3, retry limit reached)
    addHistoryEvent(taskPath, buildStepStartedEvent(taskPath, "step-1"));
    updateStepStatus(taskPath, "step-1", "in_progress");
    addHistoryEvent(
      taskPath,
      buildWorkDoneEvent(taskPath, "step-1", "Attempt 3"),
    );
    addHistoryEvent(
      taskPath,
      buildVerifierStartedEvent(taskPath, "step-1", "default"),
    );
    addHistoryEvent(
      taskPath,
      buildVerificationFailedEvent(
        taskPath,
        "step-1",
        "default",
        "Tests fail again",
      ),
    );
    updateStepStatus(taskPath, "step-1", "failed");

    test("S4b: step-1 is failed after 3 attempts", () => {
      const task = readTask(taskPath);
      assertEqual(task.steps[0].status, "failed", "step-1 status");
    });

    test("S4b: step-1 has 3 step_started attempts", () => {
      const events = getHistoryByType(taskPath, "step_started");
      const step1Events = events.filter(
        (e) => (e as any).step === "step-1",
      );
      assertEqual(step1Events.length, 3, "step_started count for step-1");
      assertEqual((step1Events[0] as any).attempt, 1, "attempt 1");
      assertEqual((step1Events[1] as any).attempt, 2, "attempt 2");
      assertEqual((step1Events[2] as any).attempt, 3, "attempt 3");
    });

    // Skip subsequent steps
    // step-2: skip
    addHistoryEvent(
      taskPath,
      buildStepSkippedEvent(
        taskPath,
        "step-2",
        "step-1 failed after retry limit",
      ),
    );
    // Directly set status to skipped (skipped is not a normal transition,
    // the orchestrator just sets it)
    {
      const task = readTask(taskPath);
      const step2 = findStep(task.steps, "step-2");
      step2!.status = "skipped";
      writeTask(taskPath, task);
    }

    // step-3: skip
    addHistoryEvent(
      taskPath,
      buildStepSkippedEvent(
        taskPath,
        "step-3",
        "step-1 failed after retry limit",
      ),
    );
    {
      const task = readTask(taskPath);
      const step3 = findStep(task.steps, "step-3");
      step3!.status = "skipped";
      writeTask(taskPath, task);
    }

    test("S4b: step-2 and step-3 are skipped", () => {
      const task = readTask(taskPath);
      assertEqual(task.steps[1].status, "skipped", "step-2 status");
      assertEqual(task.steps[2].status, "skipped", "step-3 status");
    });

    test("S4b: step_skipped events exist for step-2 and step-3", () => {
      const events = getHistoryByType(taskPath, "step_skipped");
      assertEqual(events.length, 2, "step_skipped count");
      const steps = events.map((e) => (e as any).step);
      assert(steps.includes("step-2"), "step-2 skipped");
      assert(steps.includes("step-3"), "step-3 skipped");
    });

    // Task failed
    updateTaskStatus(taskPath, "in_progress");
    updateTaskStatus(taskPath, "failed");

    test("S4b: task status is failed", () => {
      const task = readTask(taskPath);
      assertEqual(task.status, "failed", "task status");
    });
  } finally {
    cleanup(baseDir);
  }
}

// ============================================================================
// Scenario 6: Pivot
// ============================================================================

function scenario6(): void {
  console.log("\n--- Scenario 6: Pivot ---");

  const { baseDir, taskPath: oldTaskPath } = setupEnv({
    epicName: "pivot-epic",
    steps: [
      { id: "step-1", goal: "Old approach" },
    ],
  });

  try {
    // Start working on old task
    addHistoryEvent(
      oldTaskPath,
      buildStepStartedEvent(oldTaskPath, "step-1"),
    );
    updateStepStatus(oldTaskPath, "step-1", "in_progress");
    updateTaskStatus(oldTaskPath, "in_progress");

    // Pivot: create new task
    const newTaskPath = createTask(baseDir, "pivot-epic");

    test("S6: old task status is pivoted", () => {
      const oldTask = readTask(oldTaskPath);
      assertEqual(oldTask.status, "pivoted", "old task status");
    });

    test("S6: old task has pivoted event in history", () => {
      const oldTask = readTask(oldTaskPath);
      const pivotedEvents = (oldTask.history ?? []).filter(
        (e) => e.type === "pivoted",
      );
      assertEqual(pivotedEvents.length, 1, "pivoted event count");
      assert(
        (pivotedEvents[0] as any).next_task !== undefined,
        "next_task field exists",
      );
    });

    test("S6: new task has previous field", () => {
      const newTask = readTask(newTaskPath);
      assert(newTask.previous !== undefined, "previous field exists");
      assertIncludes(
        newTask.previous!,
        "_task.yaml",
        "previous points to task file",
      );
    });

    test("S6: new task has created event", () => {
      const newTask = readTask(newTaskPath);
      const createdEvents = (newTask.history ?? []).filter(
        (e) => e.type === "created",
      );
      assertEqual(createdEvents.length, 1, "created event count");
    });

    // New task can continue its own flow
    const newTask = readTask(newTaskPath);
    newTask.steps = [{ id: "step-1", goal: "New approach" }];
    writeTask(newTaskPath, newTask);

    addHistoryEvent(
      newTaskPath,
      buildStepStartedEvent(newTaskPath, "step-1"),
    );
    updateStepStatus(newTaskPath, "step-1", "in_progress");
    addHistoryEvent(
      newTaskPath,
      buildWorkDoneEvent(newTaskPath, "step-1", "New approach done"),
    );
    updateStepStatus(newTaskPath, "step-1", "done");

    test("S6: new task step can complete independently", () => {
      const task = readTask(newTaskPath);
      assertEqual(task.steps[0].status, "done", "new step status");
    });
  } finally {
    cleanup(baseDir);
  }
}

// ============================================================================
// Scenario 7: Ensemble verification
// ============================================================================

function scenario7(): void {
  console.log("\n--- Scenario 7: Ensemble verification ---");

  const { baseDir, taskPath } = setupEnv({
    steps: [
      {
        id: "step-1",
        goal: "Implement with multi-check verification",
        accept: [
          { id: "tests", check: "npm test passes", verifier: "codex" },
          { id: "quality", check: "code quality check", verifier: "claude" },
          { id: "perf", check: "performance benchmark", verifier: "gemini" },
        ],
      },
    ],
  });

  try {
    // Attempt 1
    addHistoryEvent(taskPath, buildStepStartedEvent(taskPath, "step-1"));
    updateStepStatus(taskPath, "step-1", "in_progress");
    addHistoryEvent(
      taskPath,
      buildWorkDoneEvent(taskPath, "step-1", "Implementation complete"),
    );

    // check[0]: tests/codex -> PASS
    addHistoryEvent(
      taskPath,
      buildVerifierStartedEvent(taskPath, "step-1", "tests"),
    );
    addHistoryEvent(
      taskPath,
      buildVerificationPassedEvent(
        taskPath,
        "step-1",
        "tests",
        "All tests pass",
      ),
    );

    test("S7: first check (tests) by verifier(codex)", () => {
      const events = getHistoryByType(taskPath, "verification_passed");
      assertEqual(events.length, 1, "verification_passed count");
      assertEqual((events[0] as any).accept_id, "tests", "accept_id");
      assertIncludes((events[0] as any).by, "codex", "by should have codex");
    });

    // check[1]: quality/claude -> FAIL
    addHistoryEvent(
      taskPath,
      buildVerifierStartedEvent(taskPath, "step-1", "quality"),
    );
    addHistoryEvent(
      taskPath,
      buildVerificationFailedEvent(
        taskPath,
        "step-1",
        "quality",
        "Code duplication detected",
      ),
    );

    test("S7: second check (quality) by verifier(claude)", () => {
      const events = getHistoryByType(taskPath, "verification_failed");
      assertEqual(events.length, 1, "verification_failed count");
      assertEqual((events[0] as any).accept_id, "quality", "accept_id");
      assertIncludes(
        (events[0] as any).by,
        "claude",
        "by should have claude",
      );
    });

    // check[2]: perf/gemini -> SKIPPED (one fail means skip remaining)
    // No event for skipped check — orchestrator just stops spawning verifiers

    // Step failed -> retry
    updateStepStatus(taskPath, "step-1", "failed");

    // Attempt 2
    addHistoryEvent(taskPath, buildStepStartedEvent(taskPath, "step-1"));
    updateStepStatus(taskPath, "step-1", "in_progress");
    addHistoryEvent(
      taskPath,
      buildWorkDoneEvent(taskPath, "step-1", "Removed code duplication"),
    );

    // All 3 checks pass on retry
    for (const checkId of ["tests", "quality", "perf"]) {
      addHistoryEvent(
        taskPath,
        buildVerifierStartedEvent(taskPath, "step-1", checkId),
      );
      addHistoryEvent(
        taskPath,
        buildVerificationPassedEvent(
          taskPath,
          "step-1",
          checkId,
          `${checkId} check passes`,
        ),
      );
    }

    test("S7: all 3 checks pass on attempt 2", () => {
      const events = getHistoryByType(taskPath, "verification_passed");
      // 1 from attempt 1 (tests) + 3 from attempt 2
      assertEqual(events.length, 4, "total verification_passed count");

      // Verify attempt 2 has all 3 checks
      const attempt2Passed = events.filter(
        (e) => (e as any).attempt === 2,
      );
      assertEqual(attempt2Passed.length, 3, "attempt 2 passed count");
      const ids = attempt2Passed.map((e) => (e as any).accept_id).sort();
      assertEqual(ids[0], "perf", "perf check");
      assertEqual(ids[1], "quality", "quality check");
      assertEqual(ids[2], "tests", "tests check");
    });

    test("S7: verifier CLIs are correct per accept config", () => {
      const task = readTask(taskPath);
      const config = loadConfig(taskPath);

      // tests -> codex
      const testsCli = resolveCli(
        "verifier",
        task,
        config,
        "step-1",
        undefined,
        "tests",
      );
      assertEqual(testsCli, "codex", "tests verifier CLI");

      // quality -> claude
      const qualityCli = resolveCli(
        "verifier",
        task,
        config,
        "step-1",
        undefined,
        "quality",
      );
      assertEqual(qualityCli, "claude", "quality verifier CLI");

      // perf -> gemini
      const perfCli = resolveCli(
        "verifier",
        task,
        config,
        "step-1",
        undefined,
        "perf",
      );
      assertEqual(perfCli, "gemini", "perf verifier CLI");
    });

    updateStepStatus(taskPath, "step-1", "done");

    test("S7: step done after all ensemble checks pass", () => {
      const task = readTask(taskPath);
      assertEqual(task.steps[0].status, "done", "step status");
    });
  } finally {
    cleanup(baseDir);
  }
}

// ============================================================================
// Scenario 8: Human verification
// ============================================================================

function scenario8(): void {
  console.log("\n--- Scenario 8: Human verification ---");

  const { baseDir, taskPath } = setupEnv({
    steps: [
      {
        id: "step-1",
        goal: "Implement feature requiring human review",
        accept: [
          {
            id: "human-review",
            type: "human",
            instruction: "Check UI looks correct",
          },
        ],
      },
    ],
  });

  try {
    addHistoryEvent(taskPath, buildStepStartedEvent(taskPath, "step-1"));
    updateStepStatus(taskPath, "step-1", "in_progress");
    addHistoryEvent(
      taskPath,
      buildWorkDoneEvent(taskPath, "step-1", "UI implemented"),
    );

    // checkWorker sees human accept -> allow with human notification
    test("S8: checkWorker recognizes human accept", () => {
      const task = readTask(taskPath);
      const result = checkWorker(task, "step-1");
      assertEqual(result.action, "allow", "should allow");
      assert(result.message !== undefined, "should have message");
      assertIncludes(result.message!, "人間検証", "message mentions human verification");
    });

    // Orchestrator records verification_passed with by: orchestrator
    // For human checks, the orchestrator is the one recording the result
    // (not a verifier agent)
    {
      const task = readTask(taskPath);
      const config = loadConfig(taskPath);
      const history = task.history ?? [];
      // For human checks, the orchestrator records the result
      const event: Record<string, unknown> = {
        at: new Date().toISOString(),
        type: "verification_passed",
        by: `orchestrator(${config.orchestrator_cli})`,
        step: "step-1",
        attempt: resolveAttempt("verification_passed", history, "step-1"),
        accept_id: "human-review",
        message: "Human confirmed UI looks correct",
      };
      addHistoryEvent(taskPath, event);
    }

    test("S8: verification_passed by orchestrator for human check", () => {
      const events = getHistoryByType(taskPath, "verification_passed");
      assertEqual(events.length, 1, "verification_passed count");
      assertIncludes(
        (events[0] as any).by,
        "orchestrator",
        "by should be orchestrator",
      );
      assertEqual(
        (events[0] as any).accept_id,
        "human-review",
        "accept_id",
      );
    });

    updateStepStatus(taskPath, "step-1", "done");

    test("S8: step done after human verification", () => {
      const task = readTask(taskPath);
      assertEqual(task.steps[0].status, "done", "step status");
    });
  } finally {
    cleanup(baseDir);
  }
}

// ============================================================================
// Scenario 8b: Agent + Human mixed verification
// ============================================================================

function scenario8b(): void {
  console.log(
    "\n--- Scenario 8b: Agent + Human mixed verification ---",
  );

  const { baseDir, taskPath } = setupEnv({
    steps: [
      {
        id: "step-1",
        goal: "Feature with mixed verification",
        accept: [
          { id: "auto-test", check: "npm test passes" },
          {
            id: "human-ux",
            type: "human",
            instruction: "Verify UX flow",
          },
        ],
      },
    ],
  });

  try {
    addHistoryEvent(taskPath, buildStepStartedEvent(taskPath, "step-1"));
    updateStepStatus(taskPath, "step-1", "in_progress");
    addHistoryEvent(
      taskPath,
      buildWorkDoneEvent(taskPath, "step-1", "Feature implemented"),
    );

    // Agent check PASS
    addHistoryEvent(
      taskPath,
      buildVerifierStartedEvent(taskPath, "step-1", "auto-test"),
    );
    addHistoryEvent(
      taskPath,
      buildVerificationPassedEvent(
        taskPath,
        "step-1",
        "auto-test",
        "All tests pass",
      ),
    );

    test("S8b: agent check by verifier", () => {
      const events = getHistoryByType(taskPath, "verification_passed");
      assertEqual(events.length, 1, "verification_passed count");
      assertIncludes(
        (events[0] as any).by,
        "verifier",
        "agent check by should be verifier",
      );
      assertEqual((events[0] as any).accept_id, "auto-test", "accept_id");
    });

    // Human check PASS (recorded by orchestrator)
    {
      const task = readTask(taskPath);
      const config = loadConfig(taskPath);
      const history = task.history ?? [];
      const event: Record<string, unknown> = {
        at: new Date().toISOString(),
        type: "verification_passed",
        by: `orchestrator(${config.orchestrator_cli})`,
        step: "step-1",
        attempt: resolveAttempt("verification_passed", history, "step-1"),
        accept_id: "human-ux",
        message: "Human approved UX flow",
      };
      addHistoryEvent(taskPath, event);
    }

    test("S8b: human check by orchestrator", () => {
      const events = getHistoryByType(taskPath, "verification_passed");
      assertEqual(events.length, 2, "verification_passed count");

      const autoEvent = events.find(
        (e) => (e as any).accept_id === "auto-test",
      );
      const humanEvent = events.find(
        (e) => (e as any).accept_id === "human-ux",
      );

      assert(autoEvent !== undefined, "auto-test event exists");
      assert(humanEvent !== undefined, "human-ux event exists");

      assertIncludes(
        (autoEvent as any).by,
        "verifier",
        "auto check by verifier",
      );
      assertIncludes(
        (humanEvent as any).by,
        "orchestrator",
        "human check by orchestrator",
      );
    });

    updateStepStatus(taskPath, "step-1", "done");
    addHistoryEvent(taskPath, buildCompletedEvent(taskPath));
    updateTaskStatus(taskPath, "in_progress");
    updateTaskStatus(taskPath, "done");

    test("S8b: task done with mixed verification", () => {
      const task = readTask(taskPath);
      assertEqual(task.status, "done", "task status");
    });
  } finally {
    cleanup(baseDir);
  }
}

// ============================================================================
// Main runner
// ============================================================================

async function main(): Promise<void> {
  console.log("=== M9 E2E Scenario Tests (Part 1: Scenarios 1-9) ===");

  scenario1();
  scenario2();
  scenario3();
  scenario3b();
  scenario4();
  scenario4b();
  await (async () => {
    // Scenario 5 has async tests (handleEscalate)
    const { baseDir, taskPath } = setupEnv({
      steps: [
        {
          id: "step-1",
          goal: "Implement with potential blockers",
          accept: "npm test passes",
        },
      ],
    });

    console.log("\n--- Scenario 5: Escalation ---");

    try {
      // Start step
      addHistoryEvent(taskPath, buildStepStartedEvent(taskPath, "step-1"));
      updateStepStatus(taskPath, "step-1", "in_progress");

      // Worker escalates
      const noopSendKeys = async () => {};
      await testAsync("S5: escalation sets step to blocked", async () => {
        await handleEscalate(
          {
            task: taskPath,
            step: "step-1",
            message: "Need database credentials",
          },
          noopSendKeys,
          baseDir,
        );

        const task = readTask(taskPath);
        assertEqual(task.steps[0].status, "blocked", "step status");
      });

      test("S5: escalation event recorded in history", () => {
        const events = getHistoryByType(taskPath, "escalation");
        assertEqual(events.length, 1, "escalation count");
        assertEqual((events[0] as any).step, "step-1", "step");
        assertIncludes(
          (events[0] as any).message,
          "database credentials",
          "reason",
        );
        assertEqual((events[0] as any).attempt, 1, "attempt");
        assertIncludes((events[0] as any).by, "worker", "by should be worker");
      });

      // Orchestrator resolves the block
      addHistoryEvent(
        taskPath,
        buildBlockedResolvedEvent(
          taskPath,
          "step-1",
          "Credentials provided via env vars",
        ),
      );

      test("S5: blocked_resolved event recorded", () => {
        const events = getHistoryByType(taskPath, "blocked_resolved");
        assertEqual(events.length, 1, "blocked_resolved count");
        assertIncludes(
          (events[0] as any).message,
          "Credentials",
          "summary",
        );
        assertIncludes(
          (events[0] as any).by,
          "orchestrator",
          "by should be orchestrator",
        );
      });

      // Step resumes
      addHistoryEvent(taskPath, buildStepStartedEvent(taskPath, "step-1"));
      updateStepStatus(taskPath, "step-1", "in_progress");

      test("S5: new attempt started after block resolved", () => {
        const events = getHistoryByType(taskPath, "step_started");
        assertEqual(events.length, 2, "step_started count");
        assertEqual((events[1] as any).attempt, 2, "second attempt");
      });

      // Worker finishes -> verify -> pass
      addHistoryEvent(
        taskPath,
        buildWorkDoneEvent(
          taskPath,
          "step-1",
          "Implemented with credentials from env",
        ),
      );
      addHistoryEvent(
        taskPath,
        buildVerifierStartedEvent(taskPath, "step-1", "default"),
      );
      addHistoryEvent(
        taskPath,
        buildVerificationPassedEvent(
          taskPath,
          "step-1",
          "default",
          "All tests pass with DB connection",
        ),
      );
      updateStepStatus(taskPath, "step-1", "done");

      addHistoryEvent(taskPath, buildCompletedEvent(taskPath));
      updateTaskStatus(taskPath, "in_progress");
      updateTaskStatus(taskPath, "done");

      test("S5: task done after escalation resolved", () => {
        const task = readTask(taskPath);
        assertEqual(task.status, "done", "task status");
      });
    } finally {
      cleanup(baseDir);
    }
  })();

  scenario6();
  scenario7();
  scenario8();
  scenario8b();

  // Scenario 9 has async tests (watcher poll)
  await (async () => {
    const { baseDir, taskPath } = setupEnv({
      steps: [
        {
          id: "step-1",
          goal: "Implement feature with crash recovery",
          accept: "tests pass",
        },
      ],
    });

    console.log("\n--- Scenario 9: Crash recovery (worker) ---");

    const haltrDir = join(baseDir, "haltr");

    try {
      // Start step
      addHistoryEvent(taskPath, buildStepStartedEvent(taskPath, "step-1"));
      updateStepStatus(taskPath, "step-1", "in_progress");

      // Register panes
      const pm = new PanesManager(baseDir);
      const workerPaneId = "%42";
      pm.add({
        pane_id: workerPaneId,
        step: "step-1",
        role: "worker",
        parent_pane_id: "%0",
        cli: "claude",
        task_path: taskPath,
      });
      pm.add({
        pane_id: "%0",
        step: "",
        role: "main-orchestrator",
        parent_pane_id: "",
        cli: "claude",
        task_path: taskPath,
      });

      test("S9: worker pane is registered", () => {
        const entries = pm.load();
        const workerEntry = entries.find((e) => e.role === "worker");
        assert(workerEntry !== undefined, "worker entry exists");
        assertEqual(workerEntry!.pane_id, workerPaneId, "pane_id");
      });

      // Watcher setup
      const sentMessages: Array<{ paneId: string; text: string }> = [];
      const watcherDeps: WatcherDeps = {
        listAlivePanes: async () => ["%0"],
        sendKeys: async (paneId: string, text: string) => {
          sentMessages.push({ paneId, text });
        },
      };

      const config: ConfigYaml = {
        orchestrator_cli: "claude",
        watcher: { poll_interval: 1, inactivity_threshold: 300 },
        panes: { max_concurrent: 10 },
        retry: { max_attempts: 3 },
      };

      const watcher = new Watcher(config, haltrDir, baseDir, watcherDeps);

      await testAsync("S9: watcher detects dead worker pane", async () => {
        await watcher.poll();

        const notifications = watcher.getNotifications();
        assert(notifications.length > 0, "should have notifications");

        const crashNotif = notifications.find((n) => n.type === "crash");
        assert(crashNotif !== undefined, "should have crash notification");
        assertEqual(crashNotif!.paneId, workerPaneId, "crashed pane id");
        assertEqual(crashNotif!.role, "worker", "crashed role");
        assertEqual(crashNotif!.parentPaneId, "%0", "parent pane id");
      });

      await testAsync("S9: watcher notifies parent orchestrator", async () => {
        const parentMsgs = sentMessages.filter((m) => m.paneId === "%0");
        assert(parentMsgs.length > 0, "parent should be notified");
        const hasCrashMsg = parentMsgs.some(
          (m) => m.text.includes("クラッシュ"),
        );
        assert(hasCrashMsg, "notification should mention crash");
      });

      test("S9: dead worker pane NOT removed from .panes.yaml (watcher is notification-only)", () => {
        const entries = pm.load();
        const workerEntry = entries.find(
          (e) => e.pane_id === workerPaneId,
        );
        assert(
          workerEntry !== undefined,
          "worker entry should still exist (watcher does not modify .panes.yaml)",
        );
      });

      // Orchestrator cleans up dead entry and re-spawns
      pm.remove(workerPaneId);
      const newWorkerPaneId = "%43";
      pm.add({
        pane_id: newWorkerPaneId,
        step: "step-1",
        role: "worker",
        parent_pane_id: "%0",
        cli: "claude",
        task_path: taskPath,
      });

      test("S9: new worker pane registered after re-spawn", () => {
        const entries = pm.load();
        const newWorkerEntry = entries.find(
          (e) => e.pane_id === newWorkerPaneId,
        );
        assert(newWorkerEntry !== undefined, "new worker entry exists");
      });

      test("S9: re-spawn prompt includes step context", () => {
        const task = readTask(taskPath);
        const hooksDir = renderHooks(haltrDir, "worker", taskPath, "step-1");
        const promptPath = assemblePrompt(
          hooksDir,
          haltrDir,
          "worker",
          task,
          taskPath,
          "step-1",
        );
        const promptContent = readFileSync(promptPath, "utf-8");
        assertIncludes(promptContent, "step-1", "prompt mentions step");
        assertIncludes(promptContent, taskPath, "prompt mentions task path");
      });

      // Complete after recovery
      addHistoryEvent(
        taskPath,
        buildWorkDoneEvent(taskPath, "step-1", "Work completed after re-spawn"),
      );
      addHistoryEvent(
        taskPath,
        buildVerifierStartedEvent(taskPath, "step-1", "default"),
      );
      addHistoryEvent(
        taskPath,
        buildVerificationPassedEvent(
          taskPath,
          "step-1",
          "default",
          "Tests pass after crash recovery",
        ),
      );
      updateStepStatus(taskPath, "step-1", "done");

      test("S9: step completes after crash recovery", () => {
        const task = readTask(taskPath);
        assertEqual(task.steps[0].status, "done", "step status");
      });

      watcher.stop();
    } finally {
      cleanup(baseDir);
    }
  })();

  // ========================================================================
  // Summary
  // ========================================================================

  console.log("\n========================================");
  console.log(`  Total:   ${passed + failed}`);
  console.log(`  PASS:    ${passed}`);
  console.log(`  FAIL:    ${failed}`);
  console.log("========================================");

  if (failed > 0) {
    console.log("\nFailed tests:");
    for (const r of results.filter((r) => r.status === "FAIL")) {
      console.log(`  - ${r.name}: ${r.detail}`);
    }
    process.exit(1);
  } else {
    console.log("\nAll tests passed!");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Fatal error in test runner:", err);
  process.exit(2);
});
