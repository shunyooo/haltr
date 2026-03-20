/**
 * TUI Hooks Test
 *
 * Verifies:
 * 1. task.yaml changes trigger use-task-data reload
 * 2. .panes.yaml changes trigger use-panes-data reload
 * 3. use-epic-list returns epic directory listing
 *
 * Run with: npx tsx src/test/tui-hooks-test.ts
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, watch } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as yaml from "js-yaml";
import { loadTasks } from "../tui/hooks/use-task-data.js";
import { loadPanes } from "../tui/hooks/use-panes-data.js";
import { loadEpicList } from "../tui/hooks/use-epic-list.js";
import type { TaskYaml } from "../types.js";

let passed = 0;
let failed = 0;
const results: Array<{ name: string; status: "PASS" | "FAIL"; detail?: string }> = [];

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

async function asyncTest(name: string, fn: () => Promise<void>): Promise<void> {
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

function assertEqual<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label}: expected ${e}, got ${a}`);
  }
}

function makeTask(id: string, status: "pending" | "in_progress" = "pending"): TaskYaml {
  return {
    id,
    status,
    agents: { worker: "claude", verifier: "claude" },
    steps: [{ id: "step-1", instructions: "do something" }],
  };
}

// ============================================================================
// Setup
// ============================================================================
const tmpDir = mkdtempSync(join(tmpdir(), "haltr-tui-hooks-test-"));

// ============================================================================
// Section 1: use-task-data (loadTasks)
// ============================================================================
console.log("\n--- use-task-data ---");

test("loadTasks returns empty array for dir with no task files", () => {
  const dir = join(tmpDir, "empty-epic");
  mkdirSync(dir);
  const tasks = loadTasks(dir);
  assertEqual(tasks.length, 0, "task count");
});

test("loadTasks loads single task file", () => {
  const dir = join(tmpDir, "single-epic");
  mkdirSync(dir);
  const task = makeTask("test-task");
  writeFileSync(join(dir, "001_task.yaml"), yaml.dump(task));
  const tasks = loadTasks(dir);
  assertEqual(tasks.length, 1, "task count");
  assertEqual(tasks[0].id, "test-task", "task id");
});

test("loadTasks loads multiple task files sorted", () => {
  const dir = join(tmpDir, "multi-epic");
  mkdirSync(dir);
  writeFileSync(join(dir, "002_task.yaml"), yaml.dump(makeTask("second")));
  writeFileSync(join(dir, "001_task.yaml"), yaml.dump(makeTask("first")));
  const tasks = loadTasks(dir);
  assertEqual(tasks.length, 2, "task count");
  assertEqual(tasks[0].id, "first", "first task id");
  assertEqual(tasks[1].id, "second", "second task id");
});

test("loadTasks ignores non-task files", () => {
  const dir = join(tmpDir, "ignore-epic");
  mkdirSync(dir);
  writeFileSync(join(dir, "001_task.yaml"), yaml.dump(makeTask("real")));
  writeFileSync(join(dir, ".panes.yaml"), "panes: []");
  writeFileSync(join(dir, "notes.md"), "hello");
  const tasks = loadTasks(dir);
  assertEqual(tasks.length, 1, "task count");
});

await asyncTest("fs.watch detects task.yaml changes and loadTasks returns updated data", async () => {
  const dir = join(tmpDir, "watch-epic");
  mkdirSync(dir);
  const task = makeTask("watch-task", "pending");
  writeFileSync(join(dir, "001_task.yaml"), yaml.dump(task));

  const initial = loadTasks(dir);
  assertEqual(initial[0].status, "pending", "initial status");

  const changed = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      watcher.close();
      resolve(false);
    }, 3000);

    const watcher = watch(dir, (_event, filename) => {
      if (filename?.endsWith("_task.yaml")) {
        clearTimeout(timeout);
        watcher.close();
        resolve(true);
      }
    });

    // Modify after watcher is set up
    setTimeout(() => {
      const updated = makeTask("watch-task", "in_progress");
      writeFileSync(join(dir, "001_task.yaml"), yaml.dump(updated));
    }, 100);
  });

  if (!changed) {
    throw new Error("fs.watch did not detect task.yaml change within timeout");
  }

  const updated = loadTasks(dir);
  assertEqual(updated[0].status, "in_progress", "updated status");
});

// ============================================================================
// Section 2: use-panes-data (loadPanes)
// ============================================================================
console.log("\n--- use-panes-data ---");

test("loadPanes returns empty array when no .panes.yaml", () => {
  const dir = join(tmpDir, "no-panes");
  mkdirSync(dir);
  const panes = loadPanes(dir);
  assertEqual(panes.length, 0, "panes count");
});

test("loadPanes loads panes from .panes.yaml", () => {
  const dir = join(tmpDir, "with-panes");
  mkdirSync(dir);
  writeFileSync(
    join(dir, ".panes.yaml"),
    yaml.dump({
      panes: [
        {
          pane_id: "%3",
          step: "step-1",
          role: "worker",
          parent_pane_id: "%0",
          cli: "claude",
          task_path: "/tmp/task.yaml",
        },
      ],
    }),
  );
  const panes = loadPanes(dir);
  assertEqual(panes.length, 1, "panes count");
  assertEqual(panes[0].pane_id, "%3", "pane_id");
  assertEqual(panes[0].step, "step-1", "step");
});

await asyncTest("fs.watch detects .panes.yaml changes and loadPanes returns updated data", async () => {
  const dir = join(tmpDir, "watch-panes");
  mkdirSync(dir);
  writeFileSync(
    join(dir, ".panes.yaml"),
    yaml.dump({ panes: [{ pane_id: "%1", step: "s1", role: "worker", parent_pane_id: "%0", cli: "claude", task_path: "/tmp/t.yaml" }] }),
  );

  const initial = loadPanes(dir);
  assertEqual(initial.length, 1, "initial panes count");

  const panesPath = join(dir, ".panes.yaml");
  const changed = await new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      watcher.close();
      resolve(false);
    }, 3000);

    const watcher = watch(panesPath, () => {
      clearTimeout(timeout);
      watcher.close();
      resolve(true);
    });

    setTimeout(() => {
      writeFileSync(
        panesPath,
        yaml.dump({
          panes: [
            { pane_id: "%1", step: "s1", role: "worker", parent_pane_id: "%0", cli: "claude", task_path: "/tmp/t.yaml" },
            { pane_id: "%2", step: "s2", role: "verifier", parent_pane_id: "%0", cli: "claude", task_path: "/tmp/t.yaml" },
          ],
        }),
      );
    }, 100);
  });

  if (!changed) {
    throw new Error("fs.watch did not detect .panes.yaml change within timeout");
  }

  const updated = loadPanes(dir);
  assertEqual(updated.length, 2, "updated panes count");
  assertEqual(updated[1].pane_id, "%2", "new pane_id");
});

// ============================================================================
// Section 3: use-epic-list (loadEpicList)
// ============================================================================
console.log("\n--- use-epic-list ---");

test("loadEpicList returns empty array for empty dir", () => {
  const dir = join(tmpDir, "empty-epics");
  mkdirSync(dir);
  const epics = loadEpicList(dir);
  assertEqual(epics.length, 0, "epics count");
});

test("loadEpicList returns sorted directory names", () => {
  const dir = join(tmpDir, "sorted-epics");
  mkdirSync(dir);
  mkdirSync(join(dir, "20260320-002_second"));
  mkdirSync(join(dir, "20260320-001_first"));
  const epics = loadEpicList(dir);
  assertEqual(epics.length, 2, "epics count");
  assertEqual(epics[0], "20260320-001_first", "first epic");
  assertEqual(epics[1], "20260320-002_second", "second epic");
});

test("loadEpicList excludes archive directory", () => {
  const dir = join(tmpDir, "archive-epics");
  mkdirSync(dir);
  mkdirSync(join(dir, "20260320-001_real"));
  mkdirSync(join(dir, "archive"));
  const epics = loadEpicList(dir);
  assertEqual(epics.length, 1, "epics count");
  assertEqual(epics[0], "20260320-001_real", "epic name");
});

test("loadEpicList ignores files (non-directories)", () => {
  const dir = join(tmpDir, "files-epics");
  mkdirSync(dir);
  mkdirSync(join(dir, "20260320-001_epic"));
  writeFileSync(join(dir, "README.md"), "hello");
  const epics = loadEpicList(dir);
  assertEqual(epics.length, 1, "epics count");
});

// ============================================================================
// Cleanup & Summary
// ============================================================================
rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) {
  process.exit(1);
}
