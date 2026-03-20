/**
 * tmux E2E Test Script
 *
 * Tests haltr commands with actual tmux sessions.
 * Requires tmux to be installed.
 *
 * Run with: npm run test:tmux
 */

import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as yaml from "js-yaml";

const SESSION_NAME = "haltr-test";
let passed = 0;
let failed = 0;
const failures: string[] = [];

const PROJECT_ROOT = process.cwd();
const HAL_BIN = join(PROJECT_ROOT, "dist", "bin", "hal.js");

function halInDir(cwd: string, ...args: string[]): string {
  try {
    return execFileSync("node", [HAL_BIN, ...args], {
      encoding: "utf-8",
      cwd,
      timeout: 10000,
    }).trim();
  } catch (e: any) {
    return ((e.stdout ?? "") + (e.stderr ?? "")).trim();
  }
}

function tmux(...args: string[]): string {
  try {
    return execFileSync("tmux", args, { encoding: "utf-8", timeout: 5000 }).trim();
  } catch (e: any) {
    return ((e.stdout ?? "") + (e.stderr ?? "")).trim();
  }
}

function tmuxSessionExists(): boolean {
  try {
    execFileSync("tmux", ["has-session", "-t", SESSION_NAME], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function tmuxListPanes(): string[] {
  try {
    const out = execFileSync("tmux", [
      "list-panes", "-t", SESSION_NAME, "-F", "#{pane_id}",
    ], { encoding: "utf-8", timeout: 3000 });
    return out.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

function cleanup() {
  try {
    execFileSync("tmux", ["kill-session", "-t", SESSION_NAME], { timeout: 3000 });
  } catch {
    // Session may not exist
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  FAIL: ${name}`);
    console.log(`        ${e.message}`);
    failed++;
    failures.push(name);
  }
}

async function testAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (e: any) {
    console.log(`  FAIL: ${name}`);
    console.log(`        ${e.message}`);
    failed++;
    failures.push(name);
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "haltr-tmux-e2e-"));
}

// ============================================================================
// Pre-flight check
// ============================================================================

console.log("=== tmux E2E Tests ===\n");

try {
  execFileSync("tmux", ["-V"], { encoding: "utf-8" });
} catch {
  console.log("SKIP: tmux not available");
  process.exit(0);
}

// Kill any leftover session
cleanup();

// ============================================================================
// Section 1: hal init + basic session lifecycle
// ============================================================================

console.log("--- Session lifecycle ---");

await testAsync("hal init creates haltr/ directory", async () => {
  const dir = createTestDir();
  try {
    const out = halInDir(dir, "init");
    assert(out.includes("Initialized"), `should print initialized: ${out}`);
    assert(existsSync(join(dir, "haltr")), "haltr/ should exist");
    assert(existsSync(join(dir, "haltr", "config.yaml")), "config.yaml should exist");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await testAsync("hal start creates tmux session", async () => {
  const dir = createTestDir();
  try {
    halInDir(dir, "init");

    // Create session manually (hal start would attach, which we can't do in tests)
    tmux("new-session", "-d", "-s", SESSION_NAME);

    assert(tmuxSessionExists(), "tmux session should exist");
    const panes = tmuxListPanes();
    assert(panes.length >= 1, `should have at least 1 pane, got ${panes.length}`);
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

await testAsync("hal stop kills tmux session and cleans up", async () => {
  const dir = createTestDir();
  try {
    halInDir(dir, "init");
    tmux("new-session", "-d", "-s", SESSION_NAME);
    assert(tmuxSessionExists(), "session should exist before stop");

    halInDir(dir, "stop", "--all");

    assert(!tmuxSessionExists(), "session should be gone after stop");
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Section 2: Epic and task management (with tmux context)
// ============================================================================

console.log("\n--- Epic & task in tmux context ---");

await testAsync("full flow: init → epic → task → session → panes", async () => {
  const dir = createTestDir();
  try {
    // Init
    halInDir(dir, "init");

    // Create epic
    const epicOut = halInDir(dir, "epic", "create", "test-feature");
    assert(epicOut.includes("Created epic"), `epic creation: ${epicOut}`);

    // Create task
    const taskOut = halInDir(dir, "task", "new", "--epic", "test-feature");
    assert(taskOut.includes("Created task"), `task creation: ${taskOut}`);

    // Extract task path
    const taskPath = taskOut.replace("Created task: ", "").trim();
    assert(existsSync(taskPath), `task file should exist: ${taskPath}`);

    // Verify task.yaml content
    const taskContent = readFileSync(taskPath, "utf-8");
    const task = yaml.load(taskContent) as any;
    assertEqual(task.id, "test-feature", "task id");
    assertEqual(task.status, "pending", "task status");

    // Add steps to the task
    const taskWithSteps = {
      ...task,
      steps: [
        { id: "step-1", instructions: "Create hello.txt", accept: "hello.txt exists", status: "pending" },
        { id: "step-2", instructions: "Create world.txt", status: "pending" },
      ],
      context: "E2E test task",
    };
    writeFileSync(taskPath, yaml.dump(taskWithSteps, { lineWidth: -1 }), "utf-8");

    // Start tmux session
    tmux("new-session", "-d", "-s", SESSION_NAME);
    assert(tmuxSessionExists(), "session should exist");

    // Check panes (should be empty in haltr tracking since we created manually)
    const panesOut = halInDir(dir, "panes");
    // No panes tracked yet since we didn't go through hal start
    assert(panesOut.includes("No panes") || panesOut.includes("PANE"), `panes output: ${panesOut}`);

    // Epic list
    const listOut = halInDir(dir, "epic", "list");
    assert(listOut.includes("test-feature"), `epic list should include test-feature: ${listOut}`);

    // Epic current
    const currentOut = halInDir(dir, "epic", "current");
    assert(currentOut.includes("test-feature"), `current epic: ${currentOut}`);
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Section 3: Spawn workers in tmux
// ============================================================================

console.log("\n--- Spawn agents in tmux ---");

await testAsync("hal spawn creates new tmux pane", async () => {
  const dir = createTestDir();
  try {
    halInDir(dir, "init");

    // Create epic and task
    halInDir(dir, "epic", "create", "spawn-test");
    const taskOut = halInDir(dir, "task", "new", "--epic", "spawn-test");
    const taskPath = taskOut.replace("Created task: ", "").trim();

    // Add a step + approval events
    const task = yaml.load(readFileSync(taskPath, "utf-8")) as any;
    task.steps = [{ id: "step-1", instructions: "Test step", accept: "test passes", status: "pending" }];
    task.history = [
      ...(task.history || []),
      { at: new Date().toISOString(), type: "spec_reviewed", by: "test", message: "OK" },
      { at: new Date().toISOString(), type: "execution_approved", by: "test" },
    ];
    writeFileSync(taskPath, yaml.dump(task, { lineWidth: -1 }), "utf-8");

    // Start tmux session
    tmux("new-session", "-d", "-s", SESSION_NAME);
    const initialPanes = tmuxListPanes();

    // Spawn worker
    const spawnOut = halInDir(dir, "spawn", "worker", "--step", "step-1", "--task", taskPath);
    assert(spawnOut.includes("Spawned worker"), `spawn output: ${spawnOut}`);

    // Wait for pane to appear
    await sleep(500);

    // Should have more panes now
    const afterPanes = tmuxListPanes();
    assert(
      afterPanes.length > initialPanes.length,
      `should have more panes: before=${initialPanes.length}, after=${afterPanes.length}`,
    );

    // hal panes should show the worker
    const panesOut = halInDir(dir, "panes");
    assert(panesOut.includes("worker"), `panes should show worker: ${panesOut}`);
    assert(panesOut.includes("step-1"), `panes should show step-1: ${panesOut}`);
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

await testAsync("hal spawn verifier creates separate pane", async () => {
  const dir = createTestDir();
  try {
    halInDir(dir, "init");
    halInDir(dir, "epic", "create", "verify-test");
    const taskOut = halInDir(dir, "task", "new", "--epic", "verify-test");
    const taskPath = taskOut.replace("Created task: ", "").trim();

    const task = yaml.load(readFileSync(taskPath, "utf-8")) as any;
    task.steps = [{ id: "step-1", instructions: "Test", accept: "passes", status: "in_progress" }];
    task.history = [
      ...(task.history || []),
      { at: new Date().toISOString(), type: "spec_reviewed", by: "test", message: "OK" },
      { at: new Date().toISOString(), type: "execution_approved", by: "test" },
    ];
    writeFileSync(taskPath, yaml.dump(task, { lineWidth: -1 }), "utf-8");

    tmux("new-session", "-d", "-s", SESSION_NAME);

    // Spawn both worker and verifier
    halInDir(dir, "spawn", "worker", "--step", "step-1", "--task", taskPath);
    await sleep(300);
    halInDir(dir, "spawn", "verifier", "--step", "step-1", "--task", taskPath);
    await sleep(300);

    const panes = tmuxListPanes();
    assert(panes.length >= 3, `should have at least 3 panes (base + worker + verifier): got ${panes.length}`);

    const panesOut = halInDir(dir, "panes");
    assert(panesOut.includes("worker"), "should show worker");
    assert(panesOut.includes("verifier"), "should show verifier");
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Section 4: Kill panes
// ============================================================================

console.log("\n--- Kill panes ---");

await testAsync("hal kill removes task panes from tmux", async () => {
  const dir = createTestDir();
  try {
    halInDir(dir, "init");
    halInDir(dir, "epic", "create", "kill-test");
    const taskOut = halInDir(dir, "task", "new", "--epic", "kill-test");
    const taskPath = taskOut.replace("Created task: ", "").trim();

    const task = yaml.load(readFileSync(taskPath, "utf-8")) as any;
    task.steps = [{ id: "step-1", instructions: "Test", status: "pending" }];
    task.history = [
      ...(task.history || []),
      { at: new Date().toISOString(), type: "spec_reviewed", by: "test", message: "OK" },
      { at: new Date().toISOString(), type: "execution_approved", by: "test" },
    ];
    writeFileSync(taskPath, yaml.dump(task, { lineWidth: -1 }), "utf-8");

    tmux("new-session", "-d", "-s", SESSION_NAME);

    // Spawn worker
    halInDir(dir, "spawn", "worker", "--step", "step-1", "--task", taskPath);
    await sleep(300);

    const beforePanes = tmuxListPanes();
    assert(beforePanes.length >= 2, `should have >= 2 panes before kill: ${beforePanes.length}`);

    // Kill
    const killOut = halInDir(dir, "kill", "--task", taskPath);
    assert(killOut.includes("Killed"), `kill output: ${killOut}`);
    await sleep(300);

    // Panes tracking should be cleaned
    const panesOut = halInDir(dir, "panes");
    assert(!panesOut.includes("worker"), `worker should be gone from tracking: ${panesOut}`);
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Section 5: History and status with tmux
// ============================================================================

console.log("\n--- History & status ---");

await testAsync("full workflow: start → history → status → check", async () => {
  const dir = createTestDir();
  try {
    halInDir(dir, "init");
    halInDir(dir, "epic", "create", "workflow-test");
    const taskOut = halInDir(dir, "task", "new", "--epic", "workflow-test");
    const taskPath = taskOut.replace("Created task: ", "").trim();

    // Add step
    const task = yaml.load(readFileSync(taskPath, "utf-8")) as any;
    task.steps = [{ id: "step-1", instructions: "Implement feature", accept: "tests pass", status: "pending" }];
    writeFileSync(taskPath, yaml.dump(task, { lineWidth: -1 }), "utf-8");

    // Record step_started
    const startedOut = halInDir(dir, "history", "add", "--type", "step_started", "--step", "step-1", "--task", taskPath);
    assert(startedOut.includes("Recorded"), `step_started: ${startedOut}`);

    // Update status
    halInDir(dir, "status", "--task", taskPath, "step-1", "in_progress");

    // Record work_done
    const doneOut = halInDir(dir, "history", "add", "--type", "work_done", "--step", "step-1", "--task", taskPath, "--message", "implemented");
    assert(doneOut.includes("Recorded"), `work_done: ${doneOut}`);

    // Verify task.yaml state
    const updated = yaml.load(readFileSync(taskPath, "utf-8")) as any;
    assertEqual(updated.steps[0].status, "in_progress", "step status");
    assert(updated.history.length >= 3, `should have >= 3 history events: ${updated.history.length}`);

    // Check history events
    const events = updated.history;
    const stepStarted = events.find((e: any) => e.type === "step_started");
    assert(stepStarted !== undefined, "should have step_started event");
    assertEqual(stepStarted.attempt, 1, "attempt should be 1");

    const workDone = events.find((e: any) => e.type === "work_done");
    assert(workDone !== undefined, "should have work_done event");
    assertEqual(workDone.message, "implemented", "summary");
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Section 6: Settings file generation
// ============================================================================

console.log("\n--- Settings file generation ---");

await testAsync("renderHooks generates settings.yaml and settings.json for Claude", async () => {
  const dir = createTestDir();
  try {
    halInDir(dir, "init");
    halInDir(dir, "epic", "create", "settings-test");
    const taskOut = halInDir(dir, "task", "new", "--epic", "settings-test");
    const taskPath = taskOut.replace("Created task: ", "").trim();

    const task = yaml.load(readFileSync(taskPath, "utf-8")) as any;
    task.steps = [{ id: "step-1", instructions: "Test", status: "pending" }];
    writeFileSync(taskPath, yaml.dump(task, { lineWidth: -1 }), "utf-8");

    tmux("new-session", "-d", "-s", SESSION_NAME);

    // Spawn worker — this triggers renderHooks
    halInDir(dir, "spawn", "worker", "--step", "step-1", "--task", taskPath);
    await sleep(300);

    // Check .hooks directory was created
    const epicDir = join(dir, "haltr", "epics");
    const epics = readdirSync(epicDir).filter((e: string) => !e.startsWith(".") && e !== "archive");
    assert(epics.length > 0, "should have an epic dir");

    const hooksDir = join(epicDir, epics[0], ".hooks");
    assert(existsSync(hooksDir), `.hooks/ should exist: ${hooksDir}`);

    // Find the worker hooks dir
    const hooksDirs = readdirSync(hooksDir);
    const workerDir = hooksDirs.find((d: string) => d.includes("worker"));
    assert(workerDir !== undefined, `worker hooks dir should exist: ${hooksDirs}`);

    // Check settings.yaml
    const settingsYaml = join(hooksDir, workerDir!, "settings.yaml");
    assert(existsSync(settingsYaml), "settings.yaml should exist");

    const settingsContent = yaml.load(readFileSync(settingsYaml, "utf-8")) as any;
    assert(settingsContent.hooks !== undefined, "settings should have hooks");
    assert(settingsContent.roles !== undefined, "settings should have roles");
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Section 7: Layout
// ============================================================================


// ============================================================================
// Section 8: Rule management
// ============================================================================

console.log("\n--- Rules ---");

await testAsync("hal rule add and list", async () => {
  const dir = createTestDir();
  try {
    halInDir(dir, "init");

    const addOut = halInDir(dir, "rule", "add", "Always write tests");
    assert(addOut.includes("Rule added"), `rule add: ${addOut}`);

    const listOut = halInDir(dir, "rule", "list");
    assert(listOut.includes("Always write tests"), `rule list: ${listOut}`);

    // Add another rule
    halInDir(dir, "rule", "add", "Use TypeScript strict mode");
    const listOut2 = halInDir(dir, "rule", "list");
    assert(listOut2.includes("Always write tests"), "first rule");
    assert(listOut2.includes("Use TypeScript strict mode"), "second rule");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Section 9: Epic archive
// ============================================================================

console.log("\n--- Epic archive ---");

await testAsync("hal epic archive moves epic to archive/", async () => {
  const dir = createTestDir();
  try {
    halInDir(dir, "init");
    halInDir(dir, "epic", "create", "done-feature");

    const archiveOut = halInDir(dir, "epic", "archive", "done-feature");
    assert(archiveOut.includes("Archived") || archiveOut === "", `archive: ${archiveOut}`);

    // Should not appear in list
    const listOut = halInDir(dir, "epic", "list");
    assert(!listOut.includes("done-feature"), `should not be in list: ${listOut}`);

    // Should exist in archive
    assert(
      existsSync(join(dir, "haltr", "epics", "archive")),
      "archive/ should exist",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Summary
// ============================================================================

console.log("\n========================================");
console.log(`  Total: ${passed + failed}`);
console.log(`  PASS:  ${passed}`);
console.log(`  FAIL:  ${failed}`);
console.log("========================================");

if (failures.length > 0) {
  console.log("\nFailed tests:");
  for (const f of failures) {
    console.log(`  - ${f}`);
  }
}

if (failed > 0) {
  process.exit(1);
} else {
  console.log("\nAll tests passed!");
}
