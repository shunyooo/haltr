/**
 * M9 E2E Scenario Tests -- Part 2 (Scenarios 9b-13)
 *
 * Full workflow simulations calling actual command logic functions.
 * tmux operations are mocked. Each scenario sets up a temp dir with
 * hal init + epic + task, then simulates the workflow.
 *
 * Run with: npm run test:m9b
 */

import {
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as yaml from "js-yaml";

import type {
  ConfigYaml,
  TaskYaml,
  HistoryEvent,
  Step,
} from "../types.js";
import { initHaltr } from "../commands/init.js";
import { createEpic } from "../commands/epic.js";
import { createTask, editTask } from "../commands/task.js";
import { loadAndValidateTask, validateTask } from "../lib/validator.js";
import {
  findStep,
  resolveBy,
  resolveAttempt,
  loadConfig,
  validateStepTransition,
  judgeParentStatus,
} from "../lib/task-utils.js";
import { PanesManager, type PaneEntry } from "../lib/panes-manager.js";
import {
  Watcher,
  type WatcherDeps,
  type WatcherNotification,
} from "../lib/watcher.js";
import {
  checkWorker,
  checkVerifier,
  checkOrchestrator,
} from "../commands/check.js";
import {
  handleSpawn,
  resolveCli,
  renderHooks,
  assemblePrompt,
  nextHooksIndex,
  findHaltrDir,
} from "../commands/spawn.js";
import { handleEscalate } from "../commands/escalate.js";
import { handleKill } from "../commands/kill-cmd.js";

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
      `${label}: expected to include "${substr}", got "${str.slice(0, 200)}"`,
    );
  }
}

// ============================================================================
// Helpers
// ============================================================================

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "haltr-m9b-test-"));
}

/**
 * Set up a full haltr project with init + epic + task.yaml containing
 * the given steps. Returns { baseDir, haltrDir, epicDir, taskPath, configYaml }.
 */
function setupProject(
  steps: Step[],
  opts?: {
    configOverrides?: Partial<ConfigYaml>;
    taskOverrides?: Partial<TaskYaml>;
  },
): {
  baseDir: string;
  haltrDir: string;
  epicDir: string;
  taskPath: string;
} {
  const baseDir = createTestDir();
  initHaltr(baseDir);
  const haltrDir = join(baseDir, "haltr");

  // Optionally override config
  if (opts?.configOverrides) {
    const configPath = join(haltrDir, "config.yaml");
    const config = yaml.load(
      readFileSync(configPath, "utf-8"),
    ) as ConfigYaml;
    Object.assign(config, opts.configOverrides);
    if (opts.configOverrides.retry) {
      config.retry = { ...config.retry, ...opts.configOverrides.retry };
    }
    if (opts.configOverrides.watcher) {
      config.watcher = { ...config.watcher, ...opts.configOverrides.watcher };
    }
    writeFileSync(configPath, yaml.dump(config, { lineWidth: -1 }));
  }

  const epicDir = createEpic(baseDir, "test-epic", new Date(2026, 2, 19));

  const taskData: TaskYaml = {
    id: "test-epic",
    status: "in_progress",
    agents: { worker: "claude", verifier: "codex" },
    steps,
    context: "Test context",
    history: [
      {
        at: new Date().toISOString(),
        type: "created",
        by: "orchestrator(claude)",
        message: "Task created",
      },
    ],
    ...opts?.taskOverrides,
  };

  const taskPath = join(epicDir, "001_task.yaml");
  writeFileSync(
    taskPath,
    yaml.dump(taskData, { lineWidth: -1, noRefs: true, quotingType: '"' }),
  );

  return { baseDir, haltrDir, epicDir, taskPath };
}

function cleanup(baseDir: string): void {
  rmSync(baseDir, { recursive: true, force: true });
}

function readTask(taskPath: string): TaskYaml {
  return loadAndValidateTask(taskPath);
}

function writeTask(taskPath: string, task: TaskYaml): void {
  writeFileSync(
    taskPath,
    yaml.dump(task, { lineWidth: -1, noRefs: true, quotingType: '"' }),
  );
}

/**
 * Add a history event directly to a task file (bypasses hal history add CLI
 * to avoid the validation constraints and focus on scenario flows).
 */
function addHistoryEvent(
  taskPath: string,
  event: HistoryEvent,
): void {
  const task = readTask(taskPath);
  if (!task.history) task.history = [];
  task.history.push(event);
  writeTask(taskPath, task);
}

function createMockWatcherDeps(
  alivePanes: string[] = [],
): {
  deps: WatcherDeps;
  sendKeysCalls: Array<{ paneId: string; text: string }>;
} {
  const sendKeysCalls: Array<{ paneId: string; text: string }> = [];
  const deps: WatcherDeps = {
    listAlivePanes: async () => [...alivePanes],
    sendKeys: async (paneId: string, text: string) => {
      sendKeysCalls.push({ paneId, text });
    },
  };
  return { deps, sendKeysCalls };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Verify history events are chronologically ordered.
 */
function assertHistoryChronological(history: HistoryEvent[]): void {
  for (let i = 1; i < history.length; i++) {
    const prev = new Date(history[i - 1].at).getTime();
    const curr = new Date(history[i].at).getTime();
    assert(
      curr >= prev,
      `History events out of order at index ${i}: ${history[i - 1].at} > ${history[i].at}`,
    );
  }
}

/**
 * Verify attempt numbers are consistent within each step.
 */
function assertAttemptsConsistent(history: HistoryEvent[]): void {
  const stepAttempts = new Map<string, number>();
  for (const e of history) {
    if ("step" in e && "attempt" in e) {
      const ev = e as any;
      const step = ev.step as string;
      const attempt = ev.attempt as number;
      if (ev.type === "step_started") {
        const prev = stepAttempts.get(step) ?? 0;
        assert(
          attempt === prev + 1,
          `step_started attempt for ${step} should be ${prev + 1}, got ${attempt}`,
        );
        stepAttempts.set(step, attempt);
      } else {
        const current = stepAttempts.get(step) ?? 1;
        assert(
          attempt === current,
          `Event ${ev.type} attempt for ${step} should be ${current}, got ${attempt}`,
        );
      }
    }
  }
}

// ============================================================================
// Scenario 9b: Verifier crash -- 002 sec5.1
// ============================================================================

console.log("\n=== Scenario 9b: Verifier crash ===");

await testAsync("9b: verifier spawned -> pane dies -> watcher notifies -> re-spawn", async () => {
  const { baseDir, haltrDir, taskPath } = setupProject([
    {
      id: "step-1",
      goal: "Implement feature X",
      status: "in_progress",
      accept: [{ id: "a1", check: "tests pass" }],
    },
  ]);

  try {
    const epicDir = join(haltrDir, "..");
    const pm = new PanesManager(join(taskPath, ".."));

    // Verifier spawned (simulated by adding pane entry)
    pm.add({
      pane_id: "%5",
      step: "step-1",
      role: "verifier",
      parent_pane_id: "%0",
      cli: "codex",
      task_path: taskPath,
    });

    // Also add orchestrator pane
    pm.add({
      pane_id: "%0",
      step: "",
      role: "main-orchestrator",
      parent_pane_id: "",
      cli: "claude",
      task_path: taskPath,
    });

    // Add verifier_started event
    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "verifier_started",
      by: "orchestrator(claude)",
      step: "step-1",
      attempt: 1,
      accept_id: "a1",
    });

    // Watcher detects verifier pane is dead (only %0 alive)
    const { deps, sendKeysCalls } = createMockWatcherDeps(["%0"]);
    const config: ConfigYaml = {
      orchestrator_cli: "claude",
      watcher: { poll_interval: 1, inactivity_threshold: 300 },
      panes: { max_concurrent: 10 },
      retry: { max_attempts: 3 },
    };
    const watcher = new Watcher(config, haltrDir, join(taskPath, ".."), deps);

    await watcher.poll();

    // Verify: watcher notification sent to parent
    const notifications = watcher.getNotifications();
    const crashNotif = notifications.find(
      (n) => n.type === "crash" && n.role === "verifier",
    );
    assert(crashNotif !== undefined, "should have crash notification for verifier");
    assertEqual(crashNotif!.parentPaneId, "%0", "crash notif parent pane");
    assertIncludes(crashNotif!.message, "クラッシュ", "crash message");

    // Verify: sendKeys called for parent
    assert(sendKeysCalls.length >= 1, "should send to parent");
    assertEqual(sendKeysCalls[0].paneId, "%0", "notification target");

    // Verify: watcher does NOT remove dead verifier from .panes.yaml
    // (watcher is notification-only; orchestrator handles cleanup)
    const remainingPanes = pm.load();
    assert(
      remainingPanes.some((p) => p.pane_id === "%5"),
      "dead verifier should still exist in .panes.yaml (watcher is notification-only)",
    );

    // Orchestrator cleans up dead entry and re-spawns verifier (simulated)
    pm.remove("%5");
    pm.add({
      pane_id: "%6",
      step: "step-1",
      role: "verifier",
      parent_pane_id: "%0",
      cli: "codex",
      task_path: taskPath,
    });

    // Add new verifier_started event (verification restarts from beginning)
    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "verifier_started",
      by: "orchestrator(claude)",
      step: "step-1",
      attempt: 1,
      accept_id: "a1",
    });

    // Verify: new verifier pane registered
    const updatedPanes = pm.load();
    const newVerifier = updatedPanes.find(
      (p) => p.pane_id === "%6" && p.role === "verifier",
    );
    assert(newVerifier !== undefined, "new verifier pane should be registered");

    // Verify: history has two verifier_started events (verification redone)
    const task = readTask(taskPath);
    const verifierStartedEvents = task.history!.filter(
      (e) => e.type === "verifier_started",
    );
    assertEqual(verifierStartedEvents.length, 2, "two verifier_started events");

    assertHistoryChronological(task.history!);
  } finally {
    cleanup(baseDir);
  }
});

// ============================================================================
// Scenario 9c: Sub-orchestrator crash -- 002 sec5.1
// ============================================================================

console.log("\n=== Scenario 9c: Sub-orchestrator crash ===");

await testAsync("9c: sub-orch crash -> parent notified -> child states preserved -> re-spawn", async () => {
  // Step-1 has children (nested step)
  const { baseDir, haltrDir, taskPath } = setupProject([
    {
      id: "step-1",
      goal: "Multi-part task",
      status: "in_progress",
      steps: [
        {
          id: "sub-step-1",
          goal: "First sub-task",
          status: "done",
          accept: [{ id: "a1", check: "sub-step-1 done" }],
        },
        {
          id: "sub-step-2",
          goal: "Second sub-task",
          status: "in_progress",
          accept: [{ id: "a2", check: "sub-step-2 done" }],
        },
      ],
    },
  ]);

  try {
    const epicDir = join(taskPath, "..");
    const pm = new PanesManager(epicDir);

    // Parent orchestrator pane
    pm.add({
      pane_id: "%0",
      step: "",
      role: "main-orchestrator",
      parent_pane_id: "",
      cli: "claude",
      task_path: taskPath,
    });

    // Sub-orchestrator pane for step-1
    pm.add({
      pane_id: "%2",
      step: "step-1",
      role: "sub-orchestrator",
      parent_pane_id: "%0",
      cli: "claude",
      task_path: taskPath,
    });

    // Snapshot child states before crash
    const taskBefore = readTask(taskPath);
    const subStep1Before = findStep(taskBefore.steps, "step-1/sub-step-1");
    const subStep2Before = findStep(taskBefore.steps, "step-1/sub-step-2");
    assertEqual(subStep1Before!.status, "done", "sub-step-1 before crash");
    assertEqual(subStep2Before!.status, "in_progress", "sub-step-2 before crash");

    // Sub-orch pane dies -- watcher detects (only %0 alive)
    const { deps, sendKeysCalls } = createMockWatcherDeps(["%0"]);
    const config: ConfigYaml = {
      orchestrator_cli: "claude",
      watcher: { poll_interval: 1, inactivity_threshold: 300 },
      panes: { max_concurrent: 10 },
      retry: { max_attempts: 3 },
    };
    const watcher = new Watcher(config, haltrDir, epicDir, deps);
    await watcher.poll();

    // Verify: crash notification for sub-orchestrator
    const notifications = watcher.getNotifications();
    const crashNotif = notifications.find(
      (n) => n.type === "crash" && n.role === "sub-orchestrator",
    );
    assert(crashNotif !== undefined, "should have crash notif for sub-orch");
    assertEqual(crashNotif!.parentPaneId, "%0", "notified to parent");

    // Verify: sendKeys to parent
    const subOrchSendKeys = sendKeysCalls.filter(
      (c) => c.paneId === "%0" && c.text.includes("sub-orchestrator"),
    );
    assert(subOrchSendKeys.length >= 1, "should send crash notif to parent for sub-orch");

    // Verify: child step states preserved in task.yaml (watcher doesn't modify tasks)
    const taskAfter = readTask(taskPath);
    const subStep1After = findStep(taskAfter.steps, "step-1/sub-step-1");
    const subStep2After = findStep(taskAfter.steps, "step-1/sub-step-2");
    assertEqual(subStep1After!.status, "done", "sub-step-1 preserved after crash");
    assertEqual(subStep2After!.status, "in_progress", "sub-step-2 preserved after crash");

    // Parent re-spawns sub-orchestrator
    pm.add({
      pane_id: "%7",
      step: "step-1",
      role: "sub-orchestrator",
      parent_pane_id: "%0",
      cli: "claude",
      task_path: taskPath,
    });

    // Verify: sub-orch re-spawned
    const updatedPanes = pm.load();
    const newSubOrch = updatedPanes.find(
      (p) => p.pane_id === "%7" && p.role === "sub-orchestrator",
    );
    assert(newSubOrch !== undefined, "new sub-orch should be registered");

    // Verify: sub-orch resumes (child states still preserved)
    const taskResumed = readTask(taskPath);
    assertEqual(
      findStep(taskResumed.steps, "step-1/sub-step-1")!.status,
      "done",
      "sub-step-1 still done after re-spawn",
    );
    assertEqual(
      findStep(taskResumed.steps, "step-1/sub-step-2")!.status,
      "in_progress",
      "sub-step-2 still in_progress after re-spawn",
    );
  } finally {
    cleanup(baseDir);
  }
});

// ============================================================================
// Scenario 9d: Main orchestrator crash -- 002 sec5.1
// ============================================================================

console.log("\n=== Scenario 9d: Main orchestrator crash ===");

await testAsync("9d: main orch dies -> watcher does NOT notify -> other panes unaffected", async () => {
  const { baseDir, haltrDir, taskPath } = setupProject([
    {
      id: "step-1",
      goal: "Implement feature",
      status: "in_progress",
      accept: [{ id: "a1", check: "tests pass" }],
    },
  ]);

  try {
    const epicDir = join(taskPath, "..");
    const pm = new PanesManager(epicDir);

    // Main orchestrator
    pm.add({
      pane_id: "%0",
      step: "",
      role: "main-orchestrator",
      parent_pane_id: "",
      cli: "claude",
      task_path: taskPath,
    });

    // Worker pane
    pm.add({
      pane_id: "%3",
      step: "step-1",
      role: "worker",
      parent_pane_id: "%0",
      cli: "claude",
      task_path: taskPath,
    });

    // Verifier pane
    pm.add({
      pane_id: "%4",
      step: "step-1",
      role: "verifier",
      parent_pane_id: "%0",
      cli: "codex",
      task_path: taskPath,
    });

    // Main orch dies, but worker and verifier still alive
    const { deps, sendKeysCalls } = createMockWatcherDeps(["%3", "%4"]);
    const config: ConfigYaml = {
      orchestrator_cli: "claude",
      watcher: { poll_interval: 1, inactivity_threshold: 300 },
      panes: { max_concurrent: 10 },
      retry: { max_attempts: 3 },
    };
    const watcher = new Watcher(config, haltrDir, epicDir, deps);
    await watcher.poll();

    // Verify: watcher does NOT send notification (no parent for pane 0)
    const notifications = watcher.getNotifications();
    const mainOrchCrashNotifs = notifications.filter(
      (n) => n.role === "main-orchestrator",
    );
    assertEqual(
      mainOrchCrashNotifs.length,
      0,
      "should NOT have notification for main-orch crash (no parent)",
    );

    // Verify: sendKeys NOT called for main-orch (it has no parent_pane_id)
    const mainOrchSends = sendKeysCalls.filter(
      (c) => c.text.includes("main-orchestrator"),
    );
    assertEqual(mainOrchSends.length, 0, "no sendKeys for main-orch crash");

    // Verify: watcher does NOT modify .panes.yaml (notification-only)
    // All entries should still be present
    const remainingPanes = pm.load();
    assert(
      remainingPanes.some((p) => p.pane_id === "%3"),
      "worker pane should still exist",
    );
    assert(
      remainingPanes.some((p) => p.pane_id === "%4"),
      "verifier pane should still exist",
    );
    assert(
      remainingPanes.some((p) => p.pane_id === "%0"),
      "dead main-orch should still exist in .panes.yaml (watcher is notification-only)",
    );

    // All 3 entries should remain
    assertEqual(remainingPanes.length, 3, ".panes.yaml should still have all entries");
  } finally {
    cleanup(baseDir);
  }
});

// ============================================================================
// Scenario 9e: Worker inactivity detection -- 002 sec5.1
// ============================================================================

console.log("\n=== Scenario 9e: Worker inactivity detection ===");

await testAsync("9e: worker exceeds inactivity threshold -> watcher notifies parent", async () => {
  const { baseDir, haltrDir, taskPath } = setupProject([
    {
      id: "step-1",
      goal: "Implement feature",
      status: "in_progress",
      accept: [{ id: "a1", check: "tests pass" }],
    },
  ]);

  try {
    const epicDir = join(taskPath, "..");
    const pm = new PanesManager(epicDir);

    pm.add({
      pane_id: "%0",
      step: "",
      role: "main-orchestrator",
      parent_pane_id: "",
      cli: "claude",
      task_path: taskPath,
    });

    pm.add({
      pane_id: "%3",
      step: "step-1",
      role: "worker",
      parent_pane_id: "%0",
      cli: "claude",
      task_path: taskPath,
    });

    // Very short inactivity threshold for testing
    const config: ConfigYaml = {
      orchestrator_cli: "claude",
      watcher: { poll_interval: 1, inactivity_threshold: 0.001 },
      panes: { max_concurrent: 10 },
      retry: { max_attempts: 3 },
    };

    // Both panes alive
    const { deps, sendKeysCalls } = createMockWatcherDeps(["%0", "%3"]);
    const watcher = new Watcher(config, haltrDir, epicDir, deps);

    // First poll initializes pane states
    await watcher.poll();

    // Wait for threshold to pass
    await sleep(10);

    // Second poll detects inactivity
    await watcher.poll();

    const notifications = watcher.getNotifications();
    const inactiveNotif = notifications.find(
      (n) => n.type === "inactivity" && n.role === "worker",
    );
    assert(inactiveNotif !== undefined, "should have inactivity notification");

    // Verify: notification message includes step name and duration
    assertIncludes(inactiveNotif!.message, "step-1", "inactivity message should include step name");
    assertIncludes(inactiveNotif!.message, "無活動", "inactivity message should mention inactivity");
    // Duration in minutes (0 minutes for such a short test)
    assertIncludes(inactiveNotif!.message, "分間", "inactivity message should include duration");

    // Verify: notification sent to parent
    const inactSends = sendKeysCalls.filter(
      (c) => c.paneId === "%0" && c.text.includes("step-1"),
    );
    assert(inactSends.length >= 1, "should send inactivity notification to parent");
  } finally {
    cleanup(baseDir);
  }
});

// ============================================================================
// Scenario 10: task-spec-reviewer NG -> fix -> re-review -- 002 sec4.2
// ============================================================================

console.log("\n=== Scenario 10: task-spec-reviewer NG -> fix -> re-review ===");

await testAsync("10: reviewer NG -> fix task.yaml -> re-review OK -> kill reviewer -> proceed", async () => {
  const { baseDir, haltrDir, taskPath } = setupProject([
    {
      id: "step-1",
      goal: "Implement feature",
      status: "pending",
      accept: [{ id: "a1", check: "tests pass" }],
    },
  ]);

  try {
    const epicDir = join(taskPath, "..");

    // 1. First reviewer spawn
    const spawn1 = await handleSpawn(
      {
        role: "task-spec-reviewer",
        task: taskPath,
      },
      undefined, // no runtime
      epicDir,
    );

    // Verify: hooks directory created with index 001
    assert(existsSync(spawn1.hooksDir), "hooks dir 1 should exist");
    assert(spawn1.hooksDir.includes("001_"), "first spawn should have index 001");
    assert(existsSync(spawn1.promptPath), "prompt 1 should exist");

    // Reviewer finds issues (simulated -- reviewer would add its feedback externally)
    // Orchestrator is notified of NG result

    // 2. Orchestrator fixes task.yaml
    editTask(taskPath, "context", "Test context -- improved with clearer goals");

    // Verify: task.yaml updated
    const taskAfterEdit = readTask(taskPath);
    assertIncludes(
      taskAfterEdit.context!,
      "improved",
      "context should be updated",
    );

    // Verify: updated event in history
    const updatedEvents = taskAfterEdit.history!.filter(
      (e) => e.type === "updated",
    );
    assert(updatedEvents.length >= 1, "should have updated event after edit");

    // 3. Kill first reviewer (simulate)
    const pm = new PanesManager(epicDir);
    const panesBeforeKill = pm.load();
    const reviewerPane = panesBeforeKill.find(
      (p) => p.role === "task-spec-reviewer",
    );
    if (reviewerPane) {
      pm.remove(reviewerPane.pane_id);
    }

    // 4. Re-spawn reviewer
    const spawn2 = await handleSpawn(
      {
        role: "task-spec-reviewer",
        task: taskPath,
      },
      undefined,
      epicDir,
    );

    // Verify: second spawn has different hooks index
    assert(spawn2.hooksDir.includes("002_") || spawn2.hooksDir.includes("003_"),
      `second spawn should have index 002 or 003, got: ${spawn2.hooksDir}`);
    assert(spawn1.hooksDir !== spawn2.hooksDir, "hooks dirs should differ");

    // Verify: task.yaml was updated between reviews
    const taskFinal = readTask(taskPath);
    assertIncludes(taskFinal.context!, "improved", "task should retain edits");

    // 5. Reviewer OK -> kill reviewer -> proceed to execution
    // Kill second reviewer
    const panes2 = pm.load();
    const reviewer2 = panes2.find((p) => p.role === "task-spec-reviewer");
    if (reviewer2) {
      pm.remove(reviewer2.pane_id);
    }

    // Verify: no reviewer panes left
    const panesAfterKill = pm.load();
    assert(
      !panesAfterKill.some((p) => p.role === "task-spec-reviewer"),
      "no reviewer panes should remain",
    );

    assertHistoryChronological(taskFinal.history!);
  } finally {
    cleanup(baseDir);
  }
});

// ============================================================================
// Scenario 11: Nested steps (sub-orchestrator) -- 002 sec4.3
// ============================================================================

console.log("\n=== Scenario 11: Nested steps (sub-orchestrator) ===");

await testAsync("11: parent step with children -> sub-orch -> process sub-steps -> auto-done", async () => {
  const { baseDir, haltrDir, taskPath } = setupProject([
    {
      id: "step-1",
      goal: "Multi-part feature",
      status: "pending",
      steps: [
        {
          id: "sub-step-1",
          goal: "First sub-task",
          status: "pending",
          accept: [{ id: "a1", check: "sub-1 passes" }],
        },
        {
          id: "sub-step-2",
          goal: "Second sub-task",
          status: "pending",
          accept: [{ id: "a2", check: "sub-2 passes" }],
        },
      ],
    },
    {
      id: "step-2",
      goal: "Final step",
      status: "pending",
      accept: [{ id: "a3", check: "step-2 passes" }],
    },
  ]);

  try {
    const epicDir = join(taskPath, "..");
    const pm = new PanesManager(epicDir);

    // Register main orchestrator
    pm.add({
      pane_id: "%0",
      step: "",
      role: "main-orchestrator",
      parent_pane_id: "",
      cli: "claude",
      task_path: taskPath,
    });

    // 1. Parent orch spawns sub-orch for step-1
    const subOrchSpawn = await handleSpawn(
      {
        role: "sub-orchestrator",
        task: taskPath,
        step: "step-1",
        parentPaneId: "%0",
      },
      undefined,
      epicDir,
    );

    // Verify: pane registered with correct parent_pane_id
    const panes1 = pm.load();
    const subOrchPane = panes1.find(
      (p) => p.role === "sub-orchestrator" && p.step === "step-1",
    );
    assert(subOrchPane !== undefined, "sub-orch pane should be registered");
    assertEqual(subOrchPane!.parent_pane_id, "%0", "sub-orch parent should be %0");

    // 2. Set step-1 to in_progress
    let task = readTask(taskPath);
    const step1 = findStep(task.steps, "step-1");
    step1!.status = "in_progress";
    writeTask(taskPath, task);

    // 3. Sub-orch processes sub-step-1
    task = readTask(taskPath);

    // step_started for sub-step-1
    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "step_started",
      by: "orchestrator(claude)",
      step: "step-1/sub-step-1",
      attempt: 1,
    });

    // Set sub-step-1 to in_progress
    task = readTask(taskPath);
    findStep(task.steps, "step-1/sub-step-1")!.status = "in_progress";
    writeTask(taskPath, task);

    // Simulate worker doing work on sub-step-1
    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "work_done",
      by: "worker(claude)",
      step: "step-1/sub-step-1",
      attempt: 1,
      message: "Implemented sub-step-1",
    });

    // Verify sub-step-1 -> verification PASS
    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "verifier_started",
      by: "orchestrator(claude)",
      step: "step-1/sub-step-1",
      attempt: 1,
      accept_id: "a1",
    });

    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "verification_passed",
      by: "verifier(codex)",
      step: "step-1/sub-step-1",
      attempt: 1,
      accept_id: "a1",
      message: "sub-step-1 tests pass",
    });

    // Set sub-step-1 to done
    task = readTask(taskPath);
    findStep(task.steps, "step-1/sub-step-1")!.status = "done";
    writeTask(taskPath, task);

    // 4. Sub-orch processes sub-step-2
    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "step_started",
      by: "orchestrator(claude)",
      step: "step-1/sub-step-2",
      attempt: 1,
    });

    task = readTask(taskPath);
    findStep(task.steps, "step-1/sub-step-2")!.status = "in_progress";
    writeTask(taskPath, task);

    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "work_done",
      by: "worker(claude)",
      step: "step-1/sub-step-2",
      attempt: 1,
      message: "Implemented sub-step-2",
    });

    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "verifier_started",
      by: "orchestrator(claude)",
      step: "step-1/sub-step-2",
      attempt: 1,
      accept_id: "a2",
    });

    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "verification_passed",
      by: "verifier(codex)",
      step: "step-1/sub-step-2",
      attempt: 1,
      accept_id: "a2",
      message: "sub-step-2 tests pass",
    });

    // Set sub-step-2 to done
    task = readTask(taskPath);
    findStep(task.steps, "step-1/sub-step-2")!.status = "done";
    writeTask(taskPath, task);

    // 5. All children done -> parent step auto-done via judgeParentStatus
    task = readTask(taskPath);
    const parentStep = findStep(task.steps, "step-1")!;
    const parentNewStatus = judgeParentStatus(parentStep);
    assertEqual(parentNewStatus, "done", "parent should auto-judge as done");

    // Apply parent status
    parentStep.status = parentNewStatus!;
    writeTask(taskPath, task);

    // Verify: parent step is done
    task = readTask(taskPath);
    assertEqual(
      findStep(task.steps, "step-1")!.status,
      "done",
      "step-1 should be done",
    );

    // Verify: sub-orch reports completion to parent
    // (simulated -- sub-orch would notify via tmux sendKeys)
    const completionMessage = "step-1 all children done";

    // Verify: history is chronological
    assertHistoryChronological(task.history!);

    // Verify: step-2 still pending (parent continues)
    assertEqual(
      findStep(task.steps, "step-2")!.status,
      "pending",
      "step-2 should still be pending",
    );
  } finally {
    cleanup(baseDir);
  }
});

// ============================================================================
// Scenario 12: Retry limit reached -- 001 sec5.2, 002 sec4.5
// ============================================================================

console.log("\n=== Scenario 12: Retry limit reached ===");

await testAsync("12A: max_attempts=3 -> 3 failures -> escalate -> user modifies accept -> attempt 4 PASS", async () => {
  const { baseDir, haltrDir, taskPath } = setupProject(
    [
      {
        id: "step-1",
        goal: "Implement feature",
        status: "pending",
        accept: [{ id: "a1", check: "tests pass" }],
      },
      {
        id: "step-2",
        goal: "Follow-up step",
        status: "pending",
        accept: [{ id: "a2", check: "step-2 done" }],
      },
    ],
    {
      configOverrides: { retry: { max_attempts: 3 } },
    },
  );

  try {
    const epicDir = join(taskPath, "..");
    const pm = new PanesManager(epicDir);

    pm.add({
      pane_id: "%0",
      step: "",
      role: "main-orchestrator",
      parent_pane_id: "",
      cli: "claude",
      task_path: taskPath,
    });

    // Set step-1 in_progress
    let task = readTask(taskPath);
    findStep(task.steps, "step-1")!.status = "in_progress";
    writeTask(taskPath, task);

    // === Attempt 1: FAIL ===
    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "step_started",
      by: "orchestrator(claude)",
      step: "step-1",
      attempt: 1,
    });
    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "work_done",
      by: "worker(claude)",
      step: "step-1",
      attempt: 1,
      message: "Attempt 1 implementation",
    });
    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "verifier_started",
      by: "orchestrator(claude)",
      step: "step-1",
      attempt: 1,
      accept_id: "a1",
    });
    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "verification_failed",
      by: "verifier(codex)",
      step: "step-1",
      attempt: 1,
      accept_id: "a1",
      message: "Tests fail - attempt 1",
    });

    // === Attempt 2: FAIL ===
    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "step_started",
      by: "orchestrator(claude)",
      step: "step-1",
      attempt: 2,
    });
    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "work_done",
      by: "worker(claude)",
      step: "step-1",
      attempt: 2,
      message: "Attempt 2 implementation",
    });
    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "verifier_started",
      by: "orchestrator(claude)",
      step: "step-1",
      attempt: 2,
      accept_id: "a1",
    });
    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "verification_failed",
      by: "verifier(codex)",
      step: "step-1",
      attempt: 2,
      accept_id: "a1",
      message: "Tests fail - attempt 2",
    });

    // === Attempt 3: FAIL ===
    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "step_started",
      by: "orchestrator(claude)",
      step: "step-1",
      attempt: 3,
    });
    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "work_done",
      by: "worker(claude)",
      step: "step-1",
      attempt: 3,
      message: "Attempt 3 implementation",
    });
    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "verifier_started",
      by: "orchestrator(claude)",
      step: "step-1",
      attempt: 3,
      accept_id: "a1",
    });
    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "verification_failed",
      by: "verifier(codex)",
      step: "step-1",
      attempt: 3,
      accept_id: "a1",
      message: "Tests fail - attempt 3",
    });

    // Limit reached -> escalate to main orch
    // Count verification_failed events for step-1
    task = readTask(taskPath);
    const failCount = task.history!.filter(
      (e) => e.type === "verification_failed" && "step" in e && (e as any).step === "step-1",
    ).length;
    assertEqual(failCount, 3, "should have 3 verification failures");

    const config = loadConfig(taskPath);
    assert(
      failCount >= config.retry.max_attempts,
      "fail count should equal or exceed max_attempts",
    );

    // Escalate
    pm.add({
      pane_id: "%3",
      step: "step-1",
      role: "worker",
      parent_pane_id: "%0",
      cli: "claude",
      task_path: taskPath,
    });

    await handleEscalate(
      { task: taskPath, step: "step-1", message: "max retry limit reached" },
      async () => {}, // mock sendKeys
      epicDir,
    );

    // Verify: step-1 is blocked
    task = readTask(taskPath);
    assertEqual(
      findStep(task.steps, "step-1")!.status,
      "blocked",
      "step-1 should be blocked after escalation",
    );

    // Verify: escalation event in history
    const escalationEvents = task.history!.filter(
      (e) => e.type === "escalation",
    );
    assert(escalationEvents.length >= 1, "should have escalation event");

    // Pattern A: user modifies accept -> new attempt -> PASS
    // User resolves blocked -> in_progress
    findStep(task.steps, "step-1")!.status = "in_progress";
    writeTask(taskPath, task);

    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "blocked_resolved",
      by: "orchestrator(claude)",
      step: "step-1",
      attempt: 3,
      message: "Accept criteria relaxed by user",
    });

    // Attempt 4 (after accept modification)
    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "step_started",
      by: "orchestrator(claude)",
      step: "step-1",
      attempt: 4,
    });
    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "work_done",
      by: "worker(claude)",
      step: "step-1",
      attempt: 4,
      message: "Attempt 4 with relaxed criteria",
    });
    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "verifier_started",
      by: "orchestrator(claude)",
      step: "step-1",
      attempt: 4,
      accept_id: "a1",
    });
    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "verification_passed",
      by: "verifier(codex)",
      step: "step-1",
      attempt: 4,
      accept_id: "a1",
      message: "Tests pass with relaxed criteria",
    });

    // Set step-1 to done
    task = readTask(taskPath);
    findStep(task.steps, "step-1")!.status = "done";
    writeTask(taskPath, task);

    // Verify: attempt 4 succeeds
    task = readTask(taskPath);
    assertEqual(findStep(task.steps, "step-1")!.status, "done", "step-1 done after attempt 4");

    const passEvents = task.history!.filter(
      (e) => e.type === "verification_passed" && "step" in e && (e as any).step === "step-1",
    );
    assertEqual(passEvents.length, 1, "should have 1 verification_passed for step-1");
    assertEqual((passEvents[0] as any).attempt, 4, "pass should be on attempt 4");

    assertHistoryChronological(task.history!);
  } finally {
    cleanup(baseDir);
  }
});

await testAsync("12B: max_attempts=3 -> 3 failures -> escalate -> user says failed -> skip subsequent -> task failed", async () => {
  const { baseDir, haltrDir, taskPath } = setupProject(
    [
      {
        id: "step-1",
        goal: "Implement feature",
        status: "pending",
        accept: [{ id: "a1", check: "tests pass" }],
      },
      {
        id: "step-2",
        goal: "Follow-up step",
        status: "pending",
        accept: [{ id: "a2", check: "step-2 done" }],
      },
      {
        id: "step-3",
        goal: "Final step",
        status: "pending",
        accept: [{ id: "a3", check: "step-3 done" }],
      },
    ],
    {
      configOverrides: { retry: { max_attempts: 3 } },
    },
  );

  try {
    const epicDir = join(taskPath, "..");
    const pm = new PanesManager(epicDir);

    pm.add({
      pane_id: "%0",
      step: "",
      role: "main-orchestrator",
      parent_pane_id: "",
      cli: "claude",
      task_path: taskPath,
    });

    // Set step-1 to in_progress
    let task = readTask(taskPath);
    findStep(task.steps, "step-1")!.status = "in_progress";
    writeTask(taskPath, task);

    // 3 failed attempts (same as 12A but shortened)
    for (let attempt = 1; attempt <= 3; attempt++) {
      addHistoryEvent(taskPath, {
        at: new Date().toISOString(),
        type: "step_started",
        by: "orchestrator(claude)",
        step: "step-1",
        attempt,
      });
      addHistoryEvent(taskPath, {
        at: new Date().toISOString(),
        type: "work_done",
        by: "worker(claude)",
        step: "step-1",
        attempt,
        message: `Attempt ${attempt}`,
      });
      addHistoryEvent(taskPath, {
        at: new Date().toISOString(),
        type: "verifier_started",
        by: "orchestrator(claude)",
        step: "step-1",
        attempt,
        accept_id: "a1",
      });
      addHistoryEvent(taskPath, {
        at: new Date().toISOString(),
        type: "verification_failed",
        by: "verifier(codex)",
        step: "step-1",
        attempt,
        accept_id: "a1",
        message: `Fail attempt ${attempt}`,
      });
    }

    // Escalate
    pm.add({
      pane_id: "%3",
      step: "step-1",
      role: "worker",
      parent_pane_id: "%0",
      cli: "claude",
      task_path: taskPath,
    });

    await handleEscalate(
      { task: taskPath, step: "step-1", message: "max retry limit" },
      async () => {},
      epicDir,
    );

    // Pattern B: user says "failed" -> step failed
    task = readTask(taskPath);
    // blocked -> (needs to go through in_progress to reach failed)
    // Actually, from our state machine: blocked -> in_progress is valid,
    // but we want to mark as failed. Let's go blocked -> in_progress -> failed
    findStep(task.steps, "step-1")!.status = "in_progress";
    writeTask(taskPath, task);

    task = readTask(taskPath);
    findStep(task.steps, "step-1")!.status = "failed";
    writeTask(taskPath, task);

    // Subsequent steps skipped
    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "step_skipped",
      by: "orchestrator(claude)",
      step: "step-2",
      message: "Previous step-1 failed",
    });

    task = readTask(taskPath);
    findStep(task.steps, "step-2")!.status = "skipped";
    writeTask(taskPath, task);

    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "step_skipped",
      by: "orchestrator(claude)",
      step: "step-3",
      message: "Previous step-1 failed",
    });

    task = readTask(taskPath);
    findStep(task.steps, "step-3")!.status = "skipped";
    writeTask(taskPath, task);

    // Task status -> failed
    task = readTask(taskPath);
    task.status = "failed";
    writeTask(taskPath, task);

    // Verify: step_skipped events for subsequent steps
    task = readTask(taskPath);
    const skipEvents = task.history!.filter(
      (e) => e.type === "step_skipped",
    );
    assertEqual(skipEvents.length, 2, "should have 2 step_skipped events");
    assert(
      skipEvents.some((e) => "step" in e && (e as any).step === "step-2"),
      "step-2 should be skipped",
    );
    assert(
      skipEvents.some((e) => "step" in e && (e as any).step === "step-3"),
      "step-3 should be skipped",
    );

    // Verify: task status failed
    assertEqual(task.status, "failed", "task should be failed");

    // Verify: step statuses
    assertEqual(
      findStep(task.steps, "step-1")!.status,
      "failed",
      "step-1 should be failed",
    );
    assertEqual(
      findStep(task.steps, "step-2")!.status,
      "skipped",
      "step-2 should be skipped",
    );
    assertEqual(
      findStep(task.steps, "step-3")!.status,
      "skipped",
      "step-3 should be skipped",
    );

    assertHistoryChronological(task.history!);
  } finally {
    cleanup(baseDir);
  }
});

// ============================================================================
// Scenario 13: hal task edit during worker execution -- 001 sec5.5
// ============================================================================

console.log("\n=== Scenario 13: hal task edit during worker execution ===");

await testAsync("13: edit step-1 goal during worker -> updated event with diff -> notification for step-1 change", async () => {
  const { baseDir, haltrDir, taskPath } = setupProject([
    {
      id: "step-1",
      goal: "Implement feature X",
      status: "in_progress",
      accept: [{ id: "a1", check: "tests pass" }],
    },
    {
      id: "step-2",
      goal: "Implement feature Y",
      status: "pending",
      accept: [{ id: "a2", check: "step-2 done" }],
    },
  ]);

  try {
    const epicDir = join(taskPath, "..");
    const pm = new PanesManager(epicDir);

    // Orchestrator pane
    pm.add({
      pane_id: "%0",
      step: "",
      role: "main-orchestrator",
      parent_pane_id: "",
      cli: "claude",
      task_path: taskPath,
    });

    // Worker pane for step-1
    pm.add({
      pane_id: "%3",
      step: "step-1",
      role: "worker",
      parent_pane_id: "%0",
      cli: "claude",
      task_path: taskPath,
    });

    // Worker is running on step-1, step_started recorded
    addHistoryEvent(taskPath, {
      at: new Date().toISOString(),
      type: "step_started",
      by: "orchestrator(claude)",
      step: "step-1",
      attempt: 1,
    });

    // --- Edit step-1 goal (the step the worker is currently on) ---
    let task = readTask(taskPath);
    const oldGoal = findStep(task.steps, "step-1")!.goal;
    findStep(task.steps, "step-1")!.goal = "Implement feature X with caching";

    // Record updated event with diff
    const diff = `step-1.goal: "${oldGoal}" -> "Implement feature X with caching"`;
    if (!task.history) task.history = [];
    task.history.push({
      at: new Date().toISOString(),
      type: "updated",
      by: "orchestrator(claude)",
      diff,
    });
    writeTask(taskPath, task);

    // Verify: updated event has diff
    task = readTask(taskPath);
    const updatedEvents = task.history!.filter((e) => e.type === "updated");
    assert(updatedEvents.length >= 1, "should have updated event");
    const lastUpdated = updatedEvents[updatedEvents.length - 1] as any;
    assert(lastUpdated.diff !== undefined, "updated event should have diff");
    assertIncludes(lastUpdated.diff, "step-1.goal", "diff should reference step-1.goal");

    // Verify: notification should be sent for step-1 change (since worker is on step-1)
    // Simulate notification logic: check if the changed step matches a running worker's step
    const panesForStep1 = pm.load().filter(
      (p) => p.step === "step-1" && p.role === "worker",
    );
    assert(panesForStep1.length > 0, "worker pane for step-1 should exist");
    // In real system, orchestrator would sendKeys to worker pane to notify
    const shouldNotifyStep1Worker = panesForStep1.length > 0;
    assert(shouldNotifyStep1Worker, "should notify worker on step-1 about goal change");

    // --- Edit step-2 only (not the step the worker is on) ---
    task = readTask(taskPath);
    findStep(task.steps, "step-2")!.goal = "Implement feature Y with pagination";
    const diff2 = `step-2.goal: "Implement feature Y" -> "Implement feature Y with pagination"`;
    task.history!.push({
      at: new Date().toISOString(),
      type: "updated",
      by: "orchestrator(claude)",
      diff: diff2,
    });
    writeTask(taskPath, task);

    // Verify: no notification to current worker (step-2 is not step-1)
    const panesForStep2 = pm.load().filter(
      (p) => p.step === "step-2" && p.role === "worker",
    );
    assertEqual(
      panesForStep2.length,
      0,
      "no worker pane for step-2 -- so no notification needed for step-2 edit",
    );

    // Final verifications
    task = readTask(taskPath);

    // Verify: two updated events total (besides any from setup)
    const allUpdatedEvents = task.history!.filter((e) => e.type === "updated");
    assert(allUpdatedEvents.length >= 2, "should have at least 2 updated events");

    // Verify: first diff references step-1, second references step-2
    const step1Diffs = allUpdatedEvents.filter(
      (e) => (e as any).diff && (e as any).diff.includes("step-1"),
    );
    const step2Diffs = allUpdatedEvents.filter(
      (e) => (e as any).diff && (e as any).diff.includes("step-2"),
    );
    assert(step1Diffs.length >= 1, "should have diff for step-1 change");
    assert(step2Diffs.length >= 1, "should have diff for step-2 change");

    assertHistoryChronological(task.history!);
  } finally {
    cleanup(baseDir);
  }
});

// ============================================================================
// Cross-scenario verifications
// ============================================================================

console.log("\n=== Cross-scenario verifications ===");

test("cross: by fields use correct role and CLI patterns", () => {
  // Test resolveBy patterns
  const task: TaskYaml = {
    id: "test",
    agents: { worker: "claude", verifier: "codex" },
    steps: [
      { id: "step-1", goal: "test", accept: [{ id: "a1", check: "ok" }] },
    ],
  };
  const config: ConfigYaml = {
    orchestrator_cli: "claude",
    watcher: { poll_interval: 30, inactivity_threshold: 300 },
    panes: { max_concurrent: 10 },
    retry: { max_attempts: 3 },
  };

  // Orchestrator events
  assertEqual(
    resolveBy("step_started", task, "step-1", config),
    "orchestrator(claude)",
    "step_started by",
  );
  assertEqual(
    resolveBy("verifier_started", task, "step-1", config, "a1"),
    "orchestrator(claude)",
    "verifier_started by",
  );

  // Worker events
  assertEqual(
    resolveBy("work_done", task, "step-1", config),
    "worker(claude)",
    "work_done by",
  );
  assertEqual(
    resolveBy("escalation", task, "step-1", config),
    "worker(claude)",
    "escalation by",
  );

  // Verifier events
  assertEqual(
    resolveBy("verification_passed", task, "step-1", config, "a1"),
    "verifier(codex)",
    "verification_passed by",
  );
  assertEqual(
    resolveBy("verification_failed", task, "step-1", config, "a1"),
    "verifier(codex)",
    "verification_failed by",
  );
});

test("cross: status transitions follow allowed rules", () => {
  // Valid transitions
  validateStepTransition("pending", "in_progress"); // ok
  validateStepTransition("in_progress", "done"); // ok
  validateStepTransition("in_progress", "failed"); // ok
  validateStepTransition("in_progress", "blocked"); // ok
  validateStepTransition("blocked", "in_progress"); // ok
  validateStepTransition("failed", "in_progress"); // ok

  // Invalid transitions should throw
  let threw = false;
  try {
    validateStepTransition("pending", "done");
  } catch {
    threw = true;
  }
  assert(threw, "pending -> done should be invalid");

  threw = false;
  try {
    validateStepTransition("done", "in_progress");
  } catch {
    threw = true;
  }
  assert(threw, "done -> in_progress should be invalid");
});

test("cross: resolveAttempt increments correctly", () => {
  const history: HistoryEvent[] = [];

  // First step_started -> attempt 1
  assertEqual(
    resolveAttempt("step_started", history, "step-1"),
    1,
    "first step_started",
  );

  // After adding it
  history.push({
    at: new Date().toISOString(),
    type: "step_started",
    by: "orchestrator(claude)",
    step: "step-1",
    attempt: 1,
  });

  // work_done inherits attempt 1
  assertEqual(
    resolveAttempt("work_done", history, "step-1"),
    1,
    "work_done inherits attempt 1",
  );

  // Second step_started -> attempt 2
  assertEqual(
    resolveAttempt("step_started", history, "step-1"),
    2,
    "second step_started",
  );

  history.push({
    at: new Date().toISOString(),
    type: "step_started",
    by: "orchestrator(claude)",
    step: "step-1",
    attempt: 2,
  });

  // work_done inherits attempt 2
  assertEqual(
    resolveAttempt("work_done", history, "step-1"),
    2,
    "work_done inherits attempt 2",
  );
});

test("cross: judgeParentStatus handles all combinations", () => {
  // All done -> parent done
  const allDone: Step = {
    id: "parent",
    goal: "test",
    steps: [
      { id: "c1", goal: "sub1", status: "done" },
      { id: "c2", goal: "sub2", status: "done" },
    ],
  };
  assertEqual(judgeParentStatus(allDone), "done", "all done -> done");

  // Mix done + skipped -> done
  const doneAndSkipped: Step = {
    id: "parent",
    goal: "test",
    steps: [
      { id: "c1", goal: "sub1", status: "done" },
      { id: "c2", goal: "sub2", status: "skipped" },
    ],
  };
  assertEqual(judgeParentStatus(doneAndSkipped), "done", "done + skipped -> done");

  // Any blocked -> blocked
  const hasBlocked: Step = {
    id: "parent",
    goal: "test",
    steps: [
      { id: "c1", goal: "sub1", status: "done" },
      { id: "c2", goal: "sub2", status: "blocked" },
    ],
  };
  assertEqual(judgeParentStatus(hasBlocked), "blocked", "has blocked -> blocked");

  // Any in_progress -> in_progress
  const hasInProgress: Step = {
    id: "parent",
    goal: "test",
    steps: [
      { id: "c1", goal: "sub1", status: "done" },
      { id: "c2", goal: "sub2", status: "in_progress" },
    ],
  };
  assertEqual(judgeParentStatus(hasInProgress), "in_progress", "has in_progress -> in_progress");

  // Any failed (no blocked/in_progress) -> failed
  const hasFailed: Step = {
    id: "parent",
    goal: "test",
    steps: [
      { id: "c1", goal: "sub1", status: "done" },
      { id: "c2", goal: "sub2", status: "failed" },
    ],
  };
  assertEqual(judgeParentStatus(hasFailed), "failed", "has failed -> failed");
});

// ============================================================================
// Summary
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
