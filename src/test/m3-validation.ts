/**
 * M3 Validation Test Script
 *
 * Verifies all Definition-of-Done items for M3 (History & Status).
 * Run with: npm run test:m3
 */

import { execSync } from "node:child_process";
import {
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as yaml from "js-yaml";
import type { TaskYaml, ConfigYaml, HistoryEvent } from "../types.js";
import {
  findStep,
  findParentStep,
  resolveBy,
  resolveAttempt,
  validateStepTransition,
  validateTaskTransition,
  judgeParentStatus,
} from "../lib/task-utils.js";

let passed = 0;
let failed = 0;
const results: Array<{ name: string; status: "PASS" | "FAIL"; detail?: string }> =
  [];

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

function expectThrows(fn: () => void, containsMsg?: string): void {
  try {
    fn();
    throw new Error("Expected an error to be thrown, but none was");
  } catch (e: unknown) {
    if (
      e instanceof Error &&
      e.message === "Expected an error to be thrown, but none was"
    ) {
      throw e;
    }
    if (containsMsg) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes(containsMsg)) {
        throw new Error(
          `Expected error containing "${containsMsg}", got: ${msg.split("\n")[0]}`,
        );
      }
    }
  }
}

function assertEqual(actual: unknown, expected: unknown, label?: string): void {
  if (actual !== expected) {
    throw new Error(
      `${label ? label + ": " : ""}Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// ============================================================================
// Test Fixture Setup
// ============================================================================

function createTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "haltr-m3-test-"));
  // Create haltr directory with config.yaml
  const haltrDir = join(dir, "haltr");
  mkdirSync(haltrDir, { recursive: true });

  const config: ConfigYaml = {
    orchestrator_cli: "claude",
    watcher: { poll_interval: 30, inactivity_threshold: 300 },
    panes: { max_concurrent: 10 },
    retry: { max_attempts: 3 },
  };
  writeFileSync(join(haltrDir, "config.yaml"), yaml.dump(config));
  return dir;
}

function createTaskFile(dir: string, taskData: TaskYaml): string {
  const taskPath = join(dir, "haltr", "task.yaml");
  writeFileSync(taskPath, yaml.dump(taskData, { lineWidth: -1, noRefs: true }));
  return taskPath;
}

function readTask(taskPath: string): TaskYaml {
  const content = readFileSync(taskPath, "utf-8");
  return yaml.load(content) as TaskYaml;
}

function makeBaseTask(overrides: Partial<TaskYaml> = {}): TaskYaml {
  return {
    id: "test-task",
    agents: { worker: "claude", verifier: "codex" },
    steps: [
      {
        id: "step-1",
        goal: "First step",
        status: "pending",
        steps: [
          {
            id: "data-collection",
            goal: "Collect data",
            status: "pending",
            accept: [{ id: "default", check: "data collected" }],
          },
          {
            id: "analysis",
            goal: "Analyze data",
            status: "pending",
          },
        ],
      },
      {
        id: "step-2",
        goal: "Second step",
        status: "pending",
        agents: { worker: "gemini", verifier: "claude" },
      },
    ],
    history: [],
    ...overrides,
  };
}

const halBin = resolve("/workspaces/haltr/dist/bin/hal.js");

function runHal(args: string, expectFail = false): string {
  try {
    return execSync(`node ${halBin} ${args}`, {
      encoding: "utf-8",
      cwd: "/workspaces/haltr",
    });
  } catch (e: unknown) {
    if (expectFail) {
      const err = e as { stderr?: string; stdout?: string; message?: string };
      return err.stderr || err.stdout || err.message || "";
    }
    throw e;
  }
}

// ============================================================================
// Section 1: Attempt Auto-Assignment
// ============================================================================
console.log("\n--- Attempt Auto-Assignment ---");

test("step_started -> attempt: 1", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    runHal(
      `history add --type step_started --step step-1/data-collection --task ${taskPath}`,
    );
    const task = readTask(taskPath);
    const event = task.history![task.history!.length - 1];
    assertEqual(event.type, "step_started");
    assertEqual((event as any).attempt, 1, "attempt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Second step_started same step -> attempt: 2", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    runHal(
      `history add --type step_started --step step-1/data-collection --task ${taskPath}`,
    );
    runHal(
      `history add --type step_started --step step-1/data-collection --task ${taskPath}`,
    );
    const task = readTask(taskPath);
    const events = task.history!.filter(
      (e) => e.type === "step_started" && (e as any).step === "step-1/data-collection",
    );
    assertEqual(events.length, 2, "number of step_started events");
    assertEqual((events[0] as any).attempt, 1, "first attempt");
    assertEqual((events[1] as any).attempt, 2, "second attempt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("work_done after step_started -> inherits attempt: 1", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    runHal(
      `history add --type step_started --step step-1/data-collection --task ${taskPath}`,
    );
    runHal(
      `history add --type work_done --step step-1/data-collection --message "done" --task ${taskPath}`,
    );
    const task = readTask(taskPath);
    const workDone = task.history!.find((e) => e.type === "work_done");
    assertEqual((workDone as any).attempt, 1, "attempt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("work_done after second step_started -> attempt: 2", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    runHal(
      `history add --type step_started --step step-1/data-collection --task ${taskPath}`,
    );
    runHal(
      `history add --type step_started --step step-1/data-collection --task ${taskPath}`,
    );
    runHal(
      `history add --type work_done --step step-1/data-collection --message "retry done" --task ${taskPath}`,
    );
    const task = readTask(taskPath);
    const workDone = task.history!.filter((e) => e.type === "work_done");
    assertEqual((workDone[0] as any).attempt, 2, "attempt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Nested step path attempt calculation", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    // step-1/data-collection and step-1/analysis are different steps
    runHal(
      `history add --type step_started --step step-1/data-collection --task ${taskPath}`,
    );
    runHal(
      `history add --type step_started --step step-1/analysis --task ${taskPath}`,
    );
    const task = readTask(taskPath);
    const dc = task.history!.filter(
      (e) => e.type === "step_started" && (e as any).step === "step-1/data-collection",
    );
    const an = task.history!.filter(
      (e) => e.type === "step_started" && (e as any).step === "step-1/analysis",
    );
    assertEqual((dc[0] as any).attempt, 1, "data-collection attempt");
    assertEqual((an[0] as any).attempt, 1, "analysis attempt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Section 2: By Auto-Resolution
// ============================================================================
console.log("\n--- By Auto-Resolution ---");

test("step_started -> orchestrator(claude)", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    runHal(
      `history add --type step_started --step step-1/data-collection --task ${taskPath}`,
    );
    const task = readTask(taskPath);
    const event = task.history![task.history!.length - 1];
    assertEqual(event.by, "orchestrator(claude)", "by");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("work_done -> worker(claude)", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    runHal(
      `history add --type step_started --step step-1/data-collection --task ${taskPath}`,
    );
    runHal(
      `history add --type work_done --step step-1/data-collection --message "done" --task ${taskPath}`,
    );
    const task = readTask(taskPath);
    const event = task.history!.find((e) => e.type === "work_done");
    assertEqual(event!.by, "worker(claude)", "by");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifier_started -> orchestrator(claude)", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    runHal(
      `history add --type step_started --step step-1/data-collection --task ${taskPath}`,
    );
    runHal(
      `history add --type verifier_started --step step-1/data-collection --accept-id default --task ${taskPath}`,
    );
    const task = readTask(taskPath);
    const event = task.history!.find((e) => e.type === "verifier_started");
    assertEqual(event!.by, "orchestrator(claude)", "by");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verification_passed -> verifier(codex)", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    runHal(
      `history add --type step_started --step step-1/data-collection --task ${taskPath}`,
    );
    runHal(
      `history add --type verification_passed --step step-1/data-collection --accept-id default --message "all good" --task ${taskPath}`,
    );
    const task = readTask(taskPath);
    const event = task.history!.find((e) => e.type === "verification_passed");
    assertEqual(event!.by, "verifier(codex)", "by");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Step-level agents override -> uses step's worker", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    // step-2 has agents: { worker: "gemini", verifier: "claude" }
    runHal(
      `history add --type step_started --step step-2 --task ${taskPath}`,
    );
    runHal(
      `history add --type work_done --step step-2 --message "done" --task ${taskPath}`,
    );
    const task = readTask(taskPath);
    const workDone = task.history!.find((e) => e.type === "work_done");
    assertEqual(workDone!.by, "worker(gemini)", "by uses step-level worker");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Step-level agents override -> uses step's verifier", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    runHal(
      `history add --type step_started --step step-2 --task ${taskPath}`,
    );
    runHal(
      `history add --type verification_passed --step step-2 --accept-id default --message "checked" --task ${taskPath}`,
    );
    const task = readTask(taskPath);
    const event = task.history!.find((e) => e.type === "verification_passed");
    assertEqual(event!.by, "verifier(claude)", "by uses step-level verifier");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Section 3: Accept ID
// ============================================================================
console.log("\n--- Accept ID ---");

test("verifier_started with --accept-id -> recorded", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    runHal(
      `history add --type step_started --step step-1/data-collection --task ${taskPath}`,
    );
    runHal(
      `history add --type verifier_started --step step-1/data-collection --accept-id default --task ${taskPath}`,
    );
    const task = readTask(taskPath);
    const event = task.history!.find((e) => e.type === "verifier_started") as any;
    assertEqual(event.accept_id, "default", "accept_id");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verification_passed with --accept-id -> recorded", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    runHal(
      `history add --type step_started --step step-1/data-collection --task ${taskPath}`,
    );
    runHal(
      `history add --type verification_passed --step step-1/data-collection --accept-id default --message "ok" --task ${taskPath}`,
    );
    const task = readTask(taskPath);
    const event = task.history!.find((e) => e.type === "verification_passed") as any;
    assertEqual(event.accept_id, "default", "accept_id");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifier_started without --accept-id -> error", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    const output = runHal(
      `history add --type verifier_started --step step-1/data-collection --task ${taskPath}`,
      true,
    );
    if (!output.includes("--accept-id is required")) {
      throw new Error(`Expected error about --accept-id, got: ${output}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Section 4: Type-Specific Field Validation
// ============================================================================
console.log("\n--- Type-Specific Field Validation ---");

test("work_done without --message -> allowed (optional)", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    runHal(
      `history add --type work_done --step step-1/data-collection --task ${taskPath}`,
    );
    const task = readTask(taskPath);
    const event = task.history!.find((e) => e.type === "work_done");
    if (!event) throw new Error("work_done event not recorded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verification_failed without --message -> allowed (optional)", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    runHal(
      `history add --type verification_failed --step step-1/data-collection --accept-id default --task ${taskPath}`,
    );
    const task = readTask(taskPath);
    const event = task.history!.find((e) => e.type === "verification_failed");
    if (!event) throw new Error("verification_failed event not recorded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verification_passed without --message -> allowed (optional)", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    runHal(
      `history add --type verification_passed --step step-1/data-collection --accept-id default --task ${taskPath}`,
    );
    const task = readTask(taskPath);
    const event = task.history!.find((e) => e.type === "verification_passed");
    if (!event) throw new Error("verification_passed event not recorded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("escalation without --message -> allowed (optional)", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    runHal(
      `history add --type escalation --step step-1/data-collection --task ${taskPath}`,
    );
    const task = readTask(taskPath);
    const event = task.history!.find((e) => e.type === "escalation");
    if (!event) throw new Error("escalation event not recorded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blocked_resolved without --message -> allowed (optional)", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    runHal(
      `history add --type blocked_resolved --step step-1/data-collection --task ${taskPath}`,
    );
    const task = readTask(taskPath);
    const event = task.history!.find((e) => e.type === "blocked_resolved");
    if (!event) throw new Error("blocked_resolved event not recorded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("step_skipped without --message -> allowed (optional)", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    runHal(
      `history add --type step_skipped --step step-1/data-collection --task ${taskPath}`,
    );
    const task = readTask(taskPath);
    const event = task.history!.find((e) => e.type === "step_skipped");
    if (!event) throw new Error("step_skipped event not recorded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("step_skipped with --step -> recorded correctly", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    runHal(
      `history add --type step_skipped --step step-1/data-collection --message "not needed" --task ${taskPath}`,
    );
    const task = readTask(taskPath);
    const event = task.history!.find((e) => e.type === "step_skipped") as any;
    assertEqual(event.step, "step-1/data-collection", "step");
    assertEqual(event.message, "not needed", "reason");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("completed without --step -> recorded (task-level)", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    runHal(`history add --type completed --task ${taskPath}`);
    const task = readTask(taskPath);
    const event = task.history!.find((e) => e.type === "completed") as any;
    if (!event) throw new Error("completed event not found");
    if (event.step) throw new Error("completed should not have step field");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("completed with --step -> error", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    const output = runHal(
      `history add --type completed --step step-1 --task ${taskPath}`,
      true,
    );
    if (!output.includes("not allowed")) {
      throw new Error(`Expected error about --step not allowed, got: ${output}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Section 5: at Timestamp
// ============================================================================
console.log("\n--- at Timestamp ---");

test("All events get ISO 8601 at field", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    runHal(
      `history add --type step_started --step step-1/data-collection --task ${taskPath}`,
    );
    runHal(
      `history add --type work_done --step step-1/data-collection --message "done" --task ${taskPath}`,
    );
    runHal(`history add --type completed --task ${taskPath}`);
    const task = readTask(taskPath);
    for (const event of task.history!) {
      const at = event.at;
      // Verify ISO 8601 format (basic check)
      if (!at || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(at)) {
        throw new Error(
          `Event ${event.type} has invalid at field: "${at}"`,
        );
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Section 6: hal status - Valid Transitions
// ============================================================================
console.log("\n--- hal status - Valid Transitions ---");

test("pending -> in_progress -> OK", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    runHal(`status step-1/data-collection in_progress --task ${taskPath}`);
    const task = readTask(taskPath);
    const step = findStep(task.steps, "step-1/data-collection");
    assertEqual(step!.status, "in_progress", "status");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("in_progress -> done -> OK", () => {
  const dir = createTestDir();
  try {
    const t = makeBaseTask();
    findStep(t.steps, "step-1/data-collection")!.status = "in_progress";
    const taskPath = createTaskFile(dir, t);
    runHal(`status step-1/data-collection done --task ${taskPath}`);
    const task = readTask(taskPath);
    const step = findStep(task.steps, "step-1/data-collection");
    assertEqual(step!.status, "done", "status");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("in_progress -> failed -> OK", () => {
  const dir = createTestDir();
  try {
    const t = makeBaseTask();
    findStep(t.steps, "step-1/data-collection")!.status = "in_progress";
    const taskPath = createTaskFile(dir, t);
    runHal(`status step-1/data-collection failed --task ${taskPath}`);
    const task = readTask(taskPath);
    const step = findStep(task.steps, "step-1/data-collection");
    assertEqual(step!.status, "failed", "status");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("failed -> in_progress (retry) -> OK", () => {
  const dir = createTestDir();
  try {
    const t = makeBaseTask();
    findStep(t.steps, "step-1/data-collection")!.status = "failed";
    const taskPath = createTaskFile(dir, t);
    runHal(`status step-1/data-collection in_progress --task ${taskPath}`);
    const task = readTask(taskPath);
    const step = findStep(task.steps, "step-1/data-collection");
    assertEqual(step!.status, "in_progress", "status");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("in_progress -> blocked -> OK", () => {
  const dir = createTestDir();
  try {
    const t = makeBaseTask();
    findStep(t.steps, "step-1/data-collection")!.status = "in_progress";
    const taskPath = createTaskFile(dir, t);
    runHal(`status step-1/data-collection blocked --task ${taskPath}`);
    const task = readTask(taskPath);
    const step = findStep(task.steps, "step-1/data-collection");
    assertEqual(step!.status, "blocked", "status");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("blocked -> in_progress -> OK", () => {
  const dir = createTestDir();
  try {
    const t = makeBaseTask();
    findStep(t.steps, "step-1/data-collection")!.status = "blocked";
    const taskPath = createTaskFile(dir, t);
    runHal(`status step-1/data-collection in_progress --task ${taskPath}`);
    const task = readTask(taskPath);
    const step = findStep(task.steps, "step-1/data-collection");
    assertEqual(step!.status, "in_progress", "status");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Section 7: hal status - Invalid Transitions
// ============================================================================
console.log("\n--- hal status - Invalid Transitions ---");

test("pending -> done -> error", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    const output = runHal(
      `status step-1/data-collection done --task ${taskPath}`,
      true,
    );
    if (!output.includes("Invalid status transition")) {
      throw new Error(
        `Expected 'Invalid status transition' error, got: ${output}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("done -> in_progress -> error", () => {
  const dir = createTestDir();
  try {
    const t = makeBaseTask();
    findStep(t.steps, "step-1/data-collection")!.status = "done";
    const taskPath = createTaskFile(dir, t);
    const output = runHal(
      `status step-1/data-collection in_progress --task ${taskPath}`,
      true,
    );
    if (!output.includes("Invalid status transition")) {
      throw new Error(
        `Expected 'Invalid status transition' error, got: ${output}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("done -> failed -> error", () => {
  const dir = createTestDir();
  try {
    const t = makeBaseTask();
    findStep(t.steps, "step-1/data-collection")!.status = "done";
    const taskPath = createTaskFile(dir, t);
    const output = runHal(
      `status step-1/data-collection failed --task ${taskPath}`,
      true,
    );
    if (!output.includes("Invalid status transition")) {
      throw new Error(
        `Expected 'Invalid status transition' error, got: ${output}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skipped -> in_progress -> error", () => {
  const dir = createTestDir();
  try {
    const t = makeBaseTask();
    findStep(t.steps, "step-1/data-collection")!.status = "skipped";
    const taskPath = createTaskFile(dir, t);
    const output = runHal(
      `status step-1/data-collection in_progress --task ${taskPath}`,
      true,
    );
    if (!output.includes("Invalid status transition")) {
      throw new Error(
        `Expected 'Invalid status transition' error, got: ${output}`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Invalid status "running" -> error', () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    const output = runHal(
      `status step-1/data-collection running --task ${taskPath}`,
      true,
    );
    if (!output.includes("Invalid step status")) {
      throw new Error(`Expected 'Invalid step status' error, got: ${output}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Non-existent step -> error", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    const output = runHal(
      `status nonexistent in_progress --task ${taskPath}`,
      true,
    );
    if (!output.includes("Step not found")) {
      throw new Error(`Expected 'Step not found' error, got: ${output}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Nested step path resolution", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    runHal(`status step-1/data-collection in_progress --task ${taskPath}`);
    const task = readTask(taskPath);
    const step = findStep(task.steps, "step-1/data-collection");
    assertEqual(step!.status, "in_progress", "nested step status");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Section 8: Task-level status
// ============================================================================
console.log("\n--- Task-level Status ---");

test("Task: pending -> in_progress -> OK", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask({ status: "pending" }));
    runHal(`status task in_progress --task ${taskPath}`);
    const task = readTask(taskPath);
    assertEqual(task.status, "in_progress", "task status");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Task: in_progress -> done -> OK", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(
      dir,
      makeBaseTask({ status: "in_progress" }),
    );
    runHal(`status task done --task ${taskPath}`);
    const task = readTask(taskPath);
    assertEqual(task.status, "done", "task status");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Task: in_progress -> failed -> OK", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(
      dir,
      makeBaseTask({ status: "in_progress" }),
    );
    runHal(`status task failed --task ${taskPath}`);
    const task = readTask(taskPath);
    assertEqual(task.status, "failed", "task status");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Task: failed -> in_progress (retry) -> OK", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask({ status: "failed" }));
    runHal(`status task in_progress --task ${taskPath}`);
    const task = readTask(taskPath);
    assertEqual(task.status, "in_progress", "task status");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Section 9: Parent Status Auto-Judgment
// ============================================================================
console.log("\n--- Parent Status Auto-Judgment ---");

test("All children done -> parent done", () => {
  const dir = createTestDir();
  try {
    const t = makeBaseTask();
    // Set both children to in_progress first, then done
    findStep(t.steps, "step-1/data-collection")!.status = "in_progress";
    findStep(t.steps, "step-1/analysis")!.status = "done";
    findStep(t.steps, "step-1")!.status = "in_progress";
    const taskPath = createTaskFile(dir, t);
    runHal(`status step-1/data-collection done --task ${taskPath}`);
    const task = readTask(taskPath);
    const parent = findStep(task.steps, "step-1");
    assertEqual(parent!.status, "done", "parent status");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Child in_progress -> parent in_progress", () => {
  const dir = createTestDir();
  try {
    const t = makeBaseTask();
    findStep(t.steps, "step-1")!.status = "pending";
    const taskPath = createTaskFile(dir, t);
    runHal(`status step-1/data-collection in_progress --task ${taskPath}`);
    const task = readTask(taskPath);
    const parent = findStep(task.steps, "step-1");
    assertEqual(parent!.status, "in_progress", "parent status");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Child failed (no in_progress) -> parent failed", () => {
  const dir = createTestDir();
  try {
    const t = makeBaseTask();
    findStep(t.steps, "step-1/data-collection")!.status = "in_progress";
    findStep(t.steps, "step-1/analysis")!.status = "pending";
    findStep(t.steps, "step-1")!.status = "in_progress";
    const taskPath = createTaskFile(dir, t);
    runHal(`status step-1/data-collection failed --task ${taskPath}`);
    const task = readTask(taskPath);
    const parent = findStep(task.steps, "step-1");
    assertEqual(parent!.status, "failed", "parent status");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Child blocked -> parent blocked", () => {
  const dir = createTestDir();
  try {
    const t = makeBaseTask();
    findStep(t.steps, "step-1/data-collection")!.status = "in_progress";
    findStep(t.steps, "step-1/analysis")!.status = "pending";
    findStep(t.steps, "step-1")!.status = "in_progress";
    const taskPath = createTaskFile(dir, t);
    runHal(`status step-1/data-collection blocked --task ${taskPath}`);
    const task = readTask(taskPath);
    const parent = findStep(task.steps, "step-1");
    assertEqual(parent!.status, "blocked", "parent status");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Children done + skipped mix -> parent done", () => {
  const dir = createTestDir();
  try {
    const t = makeBaseTask();
    findStep(t.steps, "step-1/data-collection")!.status = "in_progress";
    findStep(t.steps, "step-1/analysis")!.status = "skipped";
    findStep(t.steps, "step-1")!.status = "in_progress";
    const taskPath = createTaskFile(dir, t);
    runHal(`status step-1/data-collection done --task ${taskPath}`);
    const task = readTask(taskPath);
    const parent = findStep(task.steps, "step-1");
    assertEqual(parent!.status, "done", "parent status");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Section 10: Unit Tests for task-utils
// ============================================================================
console.log("\n--- Unit Tests: task-utils ---");

test("findStep: root-level step", () => {
  const steps = [
    { id: "s1", goal: "g1" },
    { id: "s2", goal: "g2" },
  ];
  const found = findStep(steps, "s1");
  if (!found || found.id !== "s1") throw new Error("Expected to find step s1");
});

test("findStep: nested step", () => {
  const steps = [
    {
      id: "s1",
      goal: "g1",
      steps: [
        { id: "child", goal: "gc" },
      ],
    },
  ];
  const found = findStep(steps, "s1/child");
  if (!found || found.id !== "child")
    throw new Error("Expected to find step s1/child");
});

test("findStep: non-existent returns undefined", () => {
  const steps = [{ id: "s1", goal: "g1" }];
  const found = findStep(steps, "nonexistent");
  if (found !== undefined) throw new Error("Expected undefined");
});

test("findParentStep: root-level has no parent", () => {
  const steps = [{ id: "s1", goal: "g1" }];
  const parent = findParentStep(steps, "s1");
  if (parent !== undefined) throw new Error("Expected undefined");
});

test("findParentStep: nested step returns parent", () => {
  const steps = [
    {
      id: "s1",
      goal: "g1",
      steps: [{ id: "child", goal: "gc" }],
    },
  ];
  const parent = findParentStep(steps, "s1/child");
  if (!parent || parent.id !== "s1") throw new Error("Expected parent s1");
});

test("resolveAttempt: first step_started -> 1", () => {
  const result = resolveAttempt("step_started", [], "step-1");
  assertEqual(result, 1, "attempt");
});

test("resolveAttempt: second step_started -> 2", () => {
  const history: HistoryEvent[] = [
    {
      at: "2026-01-01T00:00:00Z",
      type: "step_started",
      by: "orchestrator(claude)",
      step: "step-1",
      attempt: 1,
    },
  ];
  const result = resolveAttempt("step_started", history, "step-1");
  assertEqual(result, 2, "attempt");
});

test("resolveAttempt: work_done inherits from step_started count", () => {
  const history: HistoryEvent[] = [
    {
      at: "2026-01-01T00:00:00Z",
      type: "step_started",
      by: "orchestrator(claude)",
      step: "step-1",
      attempt: 1,
    },
  ];
  const result = resolveAttempt("work_done", history, "step-1");
  assertEqual(result, 1, "attempt");
});

test("validateStepTransition: pending -> in_progress OK", () => {
  validateStepTransition("pending", "in_progress");
});

test("validateStepTransition: pending -> done throws", () => {
  expectThrows(
    () => validateStepTransition("pending", "done"),
    "Invalid status transition",
  );
});

test("validateTaskTransition: pending -> in_progress OK", () => {
  validateTaskTransition("pending", "in_progress");
});

test("validateTaskTransition: done -> in_progress throws", () => {
  expectThrows(
    () => validateTaskTransition("done", "in_progress"),
    "Invalid status transition",
  );
});

test("validateStepTransition: pending -> skipped OK", () => {
  validateStepTransition("pending", "skipped");
});

test("validateTaskTransition: in_progress -> pivoted OK", () => {
  validateTaskTransition("in_progress", "pivoted");
});

test("validateTaskTransition: pending -> pivoted OK", () => {
  validateTaskTransition("pending", "pivoted");
});

test("judgeParentStatus: all children done -> done", () => {
  const parent = {
    id: "p",
    goal: "g",
    steps: [
      { id: "c1", goal: "g1", status: "done" as const },
      { id: "c2", goal: "g2", status: "done" as const },
    ],
  };
  assertEqual(judgeParentStatus(parent), "done", "parent status");
});

test("judgeParentStatus: mixed done + skipped -> done", () => {
  const parent = {
    id: "p",
    goal: "g",
    steps: [
      { id: "c1", goal: "g1", status: "done" as const },
      { id: "c2", goal: "g2", status: "skipped" as const },
    ],
  };
  assertEqual(judgeParentStatus(parent), "done", "parent status");
});

test("judgeParentStatus: child in_progress -> in_progress", () => {
  const parent = {
    id: "p",
    goal: "g",
    steps: [
      { id: "c1", goal: "g1", status: "in_progress" as const },
      { id: "c2", goal: "g2", status: "pending" as const },
    ],
  };
  assertEqual(judgeParentStatus(parent), "in_progress", "parent status");
});

test("judgeParentStatus: child failed -> failed", () => {
  const parent = {
    id: "p",
    goal: "g",
    steps: [
      { id: "c1", goal: "g1", status: "failed" as const },
      { id: "c2", goal: "g2", status: "pending" as const },
    ],
  };
  assertEqual(judgeParentStatus(parent), "failed", "parent status");
});

test("judgeParentStatus: child blocked -> blocked", () => {
  const parent = {
    id: "p",
    goal: "g",
    steps: [
      { id: "c1", goal: "g1", status: "blocked" as const },
      { id: "c2", goal: "g2", status: "pending" as const },
    ],
  };
  assertEqual(judgeParentStatus(parent), "blocked", "parent status");
});

// ============================================================================
// Cleanup & Summary
// ============================================================================

console.log("\n========================================");
console.log(`  Total: ${passed + failed}`);
console.log(`  PASS:  ${passed}`);
console.log(`  FAIL:  ${failed}`);
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
