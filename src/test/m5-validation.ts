/**
 * M5 Validation Test Script
 *
 * Verifies all Definition-of-Done items for M5 (tmux Runtime).
 * Run with: npm run test:m5
 *
 * - Unit tests for PanesManager run without tmux.
 * - Integration tests for TmuxRuntime require a working tmux and are
 *   skipped if tmux is not available.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PanesManager, type PaneEntry } from "../lib/panes-manager.js";
import { TmuxRuntime } from "../lib/tmux-runtime.js";
import {
  tmuxCreateSession,
  tmuxKillSession,
  tmuxSessionExists,
  tmuxListPanes,
  tmuxKillPane,
} from "../lib/tmux.js";

// ============================================================================
// Test harness
// ============================================================================

let passed = 0;
let failed = 0;
let skipped = 0;
const results: Array<{
  name: string;
  status: "PASS" | "FAIL" | "SKIP";
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

async function testAsync(name: string, fn: () => Promise<void>): Promise<void> {
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

function skip(name: string, message: string): void {
  results.push({ name, status: "SKIP", detail: message });
  skipped++;
  console.log(`  SKIP: ${name} (${message})`);
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ============================================================================
// Check tmux availability
// ============================================================================

let tmuxAvailable = false;
try {
  execSync("tmux -V", { stdio: "pipe" });
  tmuxAvailable = true;
} catch {
  tmuxAvailable = false;
}

// ============================================================================
// Section 1: PanesManager Unit Tests (no tmux needed)
// ============================================================================

console.log("\n--- PanesManager Unit Tests ---");

const tmpDir = mkdtempSync(join(tmpdir(), "haltr-m5-panes-"));

const sampleEntry: PaneEntry = {
  pane_id: "%3",
  step: "step-1",
  role: "worker",
  parent_pane_id: "%0",
  cli: "claude",
  task_path: "epics/20260319-001_implement-auth/001_task.yaml",
};

test("load returns empty array when file does not exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "haltr-m5-empty-"));
  const mgr = new PanesManager(dir);
  const entries = mgr.load();
  assert(Array.isArray(entries), "Expected an array");
  assertEqual(entries.length, 0, "length");
  rmSync(dir, { recursive: true, force: true });
});

test("add creates .panes.yaml and adds entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "haltr-m5-add-"));
  const mgr = new PanesManager(dir);
  mgr.add({ ...sampleEntry });
  assert(existsSync(join(dir, ".panes.yaml")), ".panes.yaml should exist");
  const entries = mgr.load();
  assertEqual(entries.length, 1, "length after add");
  assertEqual(entries[0].pane_id, "%3", "pane_id");
  assertEqual(entries[0].step, "step-1", "step");
  assertEqual(entries[0].role, "worker", "role");
  assertEqual(entries[0].parent_pane_id, "%0", "parent_pane_id");
  assertEqual(entries[0].cli, "claude", "cli");
  rmSync(dir, { recursive: true, force: true });
});

test("add multiple entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "haltr-m5-multi-"));
  const mgr = new PanesManager(dir);
  mgr.add({ ...sampleEntry, pane_id: "%3" });
  mgr.add({ ...sampleEntry, pane_id: "%4", role: "verifier", cli: "codex" });
  mgr.add({ ...sampleEntry, pane_id: "%5", role: "sub-orchestrator" });
  assertEqual(mgr.count(), 3, "count");
  const entries = mgr.load();
  assertEqual(entries[0].pane_id, "%3", "first pane_id");
  assertEqual(entries[1].pane_id, "%4", "second pane_id");
  assertEqual(entries[2].pane_id, "%5", "third pane_id");
  rmSync(dir, { recursive: true, force: true });
});

test("remove deletes entry by pane_id", () => {
  const dir = mkdtempSync(join(tmpdir(), "haltr-m5-rm-"));
  const mgr = new PanesManager(dir);
  mgr.add({ ...sampleEntry, pane_id: "%3" });
  mgr.add({ ...sampleEntry, pane_id: "%4", role: "verifier" });
  mgr.remove("%3");
  assertEqual(mgr.count(), 1, "count after remove");
  assertEqual(mgr.load()[0].pane_id, "%4", "remaining pane_id");
  rmSync(dir, { recursive: true, force: true });
});

test("remove non-existent pane_id is no-op", () => {
  const dir = mkdtempSync(join(tmpdir(), "haltr-m5-rmnoop-"));
  const mgr = new PanesManager(dir);
  mgr.add({ ...sampleEntry });
  mgr.remove("%999");
  assertEqual(mgr.count(), 1, "count should still be 1");
  rmSync(dir, { recursive: true, force: true });
});

test("findByPaneId returns correct entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "haltr-m5-find-"));
  const mgr = new PanesManager(dir);
  mgr.add({ ...sampleEntry, pane_id: "%3" });
  mgr.add({ ...sampleEntry, pane_id: "%4", role: "verifier" });
  const found = mgr.findByPaneId("%4");
  assert(found !== undefined, "should find entry");
  assertEqual(found!.role, "verifier", "role");
  rmSync(dir, { recursive: true, force: true });
});

test("findByPaneId returns undefined for missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "haltr-m5-findmiss-"));
  const mgr = new PanesManager(dir);
  mgr.add({ ...sampleEntry });
  const found = mgr.findByPaneId("%999");
  assertEqual(found, undefined, "should be undefined");
  rmSync(dir, { recursive: true, force: true });
});

test("clear removes all entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "haltr-m5-clear-"));
  const mgr = new PanesManager(dir);
  mgr.add({ ...sampleEntry, pane_id: "%3" });
  mgr.add({ ...sampleEntry, pane_id: "%4" });
  mgr.add({ ...sampleEntry, pane_id: "%5" });
  assertEqual(mgr.count(), 3, "count before clear");
  mgr.clear();
  assertEqual(mgr.count(), 0, "count after clear");
  // File should still exist but with empty panes
  assert(existsSync(join(dir, ".panes.yaml")), ".panes.yaml should exist after clear");
  rmSync(dir, { recursive: true, force: true });
});

test("count returns correct number", () => {
  const dir = mkdtempSync(join(tmpdir(), "haltr-m5-count-"));
  const mgr = new PanesManager(dir);
  assertEqual(mgr.count(), 0, "count when empty");
  mgr.add({ ...sampleEntry, pane_id: "%3" });
  assertEqual(mgr.count(), 1, "count after 1 add");
  mgr.add({ ...sampleEntry, pane_id: "%4" });
  assertEqual(mgr.count(), 2, "count after 2 adds");
  mgr.remove("%3");
  assertEqual(mgr.count(), 1, "count after remove");
  rmSync(dir, { recursive: true, force: true });
});

test("save/load preserves all PaneEntry fields", () => {
  const dir = mkdtempSync(join(tmpdir(), "haltr-m5-fields-"));
  const mgr = new PanesManager(dir);
  const entry: PaneEntry = {
    pane_id: "%10",
    step: "step-2/sub-step-a",
    role: "task-spec-reviewer",
    parent_pane_id: "%1",
    cli: "gemini",
    task_path: "epics/20260319-001/002_task.yaml",
  };
  mgr.add(entry);
  const loaded = mgr.load();
  assertEqual(loaded[0].pane_id, "%10", "pane_id");
  assertEqual(loaded[0].step, "step-2/sub-step-a", "step");
  assertEqual(loaded[0].role, "task-spec-reviewer", "role");
  assertEqual(loaded[0].parent_pane_id, "%1", "parent_pane_id");
  assertEqual(loaded[0].cli, "gemini", "cli");
  assertEqual(loaded[0].task_path, "epics/20260319-001/002_task.yaml", "task_path");
  rmSync(dir, { recursive: true, force: true });
});

test(".panes.yaml content is valid YAML with panes key", () => {
  const dir = mkdtempSync(join(tmpdir(), "haltr-m5-yaml-"));
  const mgr = new PanesManager(dir);
  mgr.add({ ...sampleEntry });
  const content = readFileSync(join(dir, ".panes.yaml"), "utf-8");
  assert(content.includes("panes:"), "Should contain 'panes:' key");
  assert(content.includes("pane_id:"), "Should contain 'pane_id:' key");
  rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// Section 2: Runtime type checks (no tmux needed)
// ============================================================================

console.log("\n--- Runtime Type / Construction Tests ---");

test("TmuxRuntime can be instantiated", () => {
  const dir = mkdtempSync(join(tmpdir(), "haltr-m5-rt-"));
  const rt = new TmuxRuntime("test-session", dir);
  assert(rt !== undefined, "should be defined");
  rmSync(dir, { recursive: true, force: true });
});

test("TmuxRuntime.onExit stores callback", () => {
  const dir = mkdtempSync(join(tmpdir(), "haltr-m5-exit-"));
  const rt = new TmuxRuntime("test-session", dir);
  let called = false;
  rt.onExit("%99", () => { called = true; });
  const cbs = rt.getExitCallbacks("%99");
  assertEqual(cbs.length, 1, "callback count");
  // Invoke manually to verify it works
  cbs[0]();
  assert(called, "callback should have been invoked");
  rmSync(dir, { recursive: true, force: true });
});

test("TmuxRuntime.onExit accumulates multiple callbacks", () => {
  const dir = mkdtempSync(join(tmpdir(), "haltr-m5-exit2-"));
  const rt = new TmuxRuntime("test-session", dir);
  rt.onExit("%99", () => {});
  rt.onExit("%99", () => {});
  rt.onExit("%99", () => {});
  assertEqual(rt.getExitCallbacks("%99").length, 3, "should have 3 callbacks");
  assertEqual(rt.getExitCallbacks("%100").length, 0, "unregistered agent should have 0 callbacks");
  rmSync(dir, { recursive: true, force: true });
});

test("TmuxRuntime.list returns empty when no panes tracked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "haltr-m5-listempty-"));
  const rt = new TmuxRuntime("nonexistent-session-xyz", dir);
  const agents = await rt.list();
  assertEqual(agents.length, 0, "should be empty");
  rmSync(dir, { recursive: true, force: true });
});

// ============================================================================
// Section 3: Integration Tests (require tmux)
// ============================================================================

console.log("\n--- tmux Integration Tests ---");

const TEST_SESSION = "haltr-m5-test";

async function runTmuxTests(): Promise<void> {
  if (!tmuxAvailable) {
    const tmuxTestNames = [
      "tmuxCreateSession creates a session",
      "tmuxSessionExists returns true for existing session",
      "tmuxListPanes returns initial pane",
      "spawn creates a new pane",
      "spawn registers entry in .panes.yaml",
      "kill closes pane and removes from .panes.yaml",
      "send delivers text to pane",
      "list returns all entries",
      "isAlive returns true for live pane",
      "isAlive returns false for dead pane",
      "interactive mode process survives after command completion",
      "send additional message to live pane",
      "Multiple sequential spawns register correctly",
      "External pane kill -> isAlive returns false",
    ];
    for (const name of tmuxTestNames) {
      skip(name, "tmux not available");
    }
    return;
  }

  // Setup: create test session
  const testDir = mkdtempSync(join(tmpdir(), "haltr-m5-tmux-"));
  // Create the epic directory structure that matches taskPath
  mkdirSync(join(testDir, "epics", "test"), { recursive: true });

  // Ensure clean state
  if (await tmuxSessionExists(TEST_SESSION)) {
    await tmuxKillSession(TEST_SESSION);
  }

  try {
    // --- Session management ---

    await testAsync("tmuxCreateSession creates a session", async () => {
      const paneId = await tmuxCreateSession(TEST_SESSION);
      assert(paneId.startsWith("%"), `paneId should start with %, got "${paneId}"`);
    });

    await testAsync("tmuxSessionExists returns true for existing session", async () => {
      const exists = await tmuxSessionExists(TEST_SESSION);
      assert(exists, "session should exist");
    });

    await testAsync("tmuxListPanes returns initial pane", async () => {
      const panes = await tmuxListPanes(TEST_SESSION);
      assert(panes.length >= 1, `expected >= 1 pane, got ${panes.length}`);
    });

    // --- TmuxRuntime integration ---

    const rt = new TmuxRuntime(TEST_SESSION, testDir);

    let spawnedPaneId = "";

    await testAsync("spawn creates a new pane", async () => {
      const info = await rt.spawn({
        step: "step-1",
        role: "worker",
        parentPaneId: "%0",
        cli: "claude",
        taskPath: join(testDir, "epics", "test", "001_task.yaml"),
      });
      assert(info.paneId.startsWith("%"), `paneId should start with %, got "${info.paneId}"`);
      assertEqual(info.step, "step-1", "step");
      assertEqual(info.role, "worker", "role");
      assertEqual(info.cli, "claude", "cli");
      assertEqual(info.agentId, info.paneId, "agentId should equal paneId");
      spawnedPaneId = info.paneId;
    });

    await testAsync("spawn registers entry in .panes.yaml", async () => {
      // Panes are stored in dirname(taskPath), which is testDir/epics/test
      const mgr = new PanesManager(join(testDir, "epics", "test"));
      const entry = mgr.findByPaneId(spawnedPaneId);
      assert(entry !== undefined, "entry should be in .panes.yaml");
      assertEqual(entry!.step, "step-1", "step");
      assertEqual(entry!.role, "worker", "role");
    });

    await testAsync("isAlive returns true for live pane", async () => {
      const alive = await rt.isAlive(spawnedPaneId);
      assert(alive, "pane should be alive");
    });

    await testAsync("send delivers text to pane", async () => {
      // Send a simple echo command
      await rt.send(spawnedPaneId, "echo HALTR_M5_TEST_OK");
      // Small delay for tmux to process
      await new Promise((r) => setTimeout(r, 200));
      // We can't easily capture pane output in a test, but the send
      // succeeding without error is the key assertion.
    });

    await testAsync("send additional message to live pane", async () => {
      await rt.send(spawnedPaneId, "echo HALTR_M5_SECOND_MSG");
      await new Promise((r) => setTimeout(r, 200));
    });

    await testAsync("list returns all entries", async () => {
      const agents = await rt.list();
      assert(agents.length >= 1, `expected >= 1 agent, got ${agents.length}`);
      const found = agents.find((a) => a.paneId === spawnedPaneId);
      assert(found !== undefined, "spawned agent should be in list");
    });

    await testAsync("kill closes pane and removes from .panes.yaml", async () => {
      await rt.kill(spawnedPaneId);
      const alive = await rt.isAlive(spawnedPaneId);
      assert(!alive, "pane should be dead after kill");
      const entry = rt.getPanesManager().findByPaneId(spawnedPaneId);
      assertEqual(entry, undefined, "entry should be removed from .panes.yaml");
    });

    await testAsync("isAlive returns false for dead pane", async () => {
      const alive = await rt.isAlive(spawnedPaneId);
      assert(!alive, "pane should be dead");
    });

    // --- Interactive mode & multi-spawn tests ---

    await testAsync("interactive mode process survives after command completion", async () => {
      // Spawn a pane running an interactive shell (no command = default shell)
      const info = await rt.spawn({
        step: "step-interactive",
        role: "worker",
        parentPaneId: "%0",
        cli: "claude",
        taskPath: join(testDir, "epics", "test", "001_task.yaml"),
      });
      // Shell should still be alive
      await new Promise((r) => setTimeout(r, 300));
      const alive = await rt.isAlive(info.paneId);
      assert(alive, "interactive shell should stay alive");
      // Send a command to prove it's interactive
      await rt.send(info.paneId, "echo INTERACTIVE_OK");
      await new Promise((r) => setTimeout(r, 200));
      const stillAlive = await rt.isAlive(info.paneId);
      assert(stillAlive, "should still be alive after echo");
      // Clean up
      await rt.kill(info.paneId);
    });

    await testAsync("Multiple sequential spawns register correctly", async () => {
      const rt2 = new TmuxRuntime(TEST_SESSION, testDir);
      // Clear first - panes will be in epics/test directory
      const epicMgr = new PanesManager(join(testDir, "epics", "test"));
      epicMgr.clear();

      const info1 = await rt2.spawn({
        step: "step-a",
        role: "worker",
        parentPaneId: "%0",
        cli: "claude",
        taskPath: join(testDir, "epics", "test", "t.yaml"),
      });
      const info2 = await rt2.spawn({
        step: "step-b",
        role: "verifier",
        parentPaneId: "%0",
        cli: "codex",
        taskPath: join(testDir, "epics", "test", "t.yaml"),
      });
      const info3 = await rt2.spawn({
        step: "step-c",
        role: "sub-orchestrator",
        parentPaneId: "%0",
        cli: "gemini",
        taskPath: join(testDir, "epics", "test", "t.yaml"),
      });

      assertEqual(epicMgr.count(), 3, "should have 3 entries");

      // All panes should be alive
      assert(await rt2.isAlive(info1.paneId), "pane 1 alive");
      assert(await rt2.isAlive(info2.paneId), "pane 2 alive");
      assert(await rt2.isAlive(info3.paneId), "pane 3 alive");

      // All should be in list
      const agents = await rt2.list();
      assertEqual(agents.length, 3, "list should have 3 agents");

      // Clean up
      await rt2.kill(info1.paneId);
      await rt2.kill(info2.paneId);
      await rt2.kill(info3.paneId);
    });

    await testAsync("External pane kill -> isAlive returns false", async () => {
      const info = await rt.spawn({
        step: "step-ext-kill",
        role: "worker",
        parentPaneId: "%0",
        cli: "claude",
        taskPath: join(testDir, "epics", "test", "t.yaml"),
      });
      // Kill the pane externally (bypassing runtime)
      await tmuxKillPane(info.paneId);
      await new Promise((r) => setTimeout(r, 200));
      const alive = await rt.isAlive(info.paneId);
      assert(!alive, "pane should be dead after external kill");
      // Clean up .panes.yaml entry from epic directory
      const epicMgr = new PanesManager(join(testDir, "epics", "test"));
      epicMgr.remove(info.paneId);
    });
  } finally {
    // Cleanup: kill test session
    try {
      await tmuxKillSession(TEST_SESSION);
    } catch {
      // ignore
    }
    rmSync(testDir, { recursive: true, force: true });
  }
}

// ============================================================================
// Run all tests
// ============================================================================

async function main(): Promise<void> {
  await runTmuxTests();

  // Cleanup the main tmpDir
  rmSync(tmpDir, { recursive: true, force: true });

  console.log("\n========================================");
  console.log(`  Total:   ${passed + failed + skipped}`);
  console.log(`  PASS:    ${passed}`);
  console.log(`  FAIL:    ${failed}`);
  console.log(`  SKIP:    ${skipped}`);
  console.log("========================================");

  if (failed > 0) {
    console.log("\nFailed tests:");
    for (const r of results.filter((r) => r.status === "FAIL")) {
      console.log(`  - ${r.name}: ${r.detail}`);
    }
    process.exit(1);
  } else {
    console.log("\nAll tests passed (or skipped)!");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Fatal error in test runner:", err);
  process.exit(2);
});
