/**
 * M7 Validation Test Script
 *
 * Verifies all Definition-of-Done items for M7 (Support Commands).
 * Run with: npm run test:m7
 *
 * Tests:
 *   - hal escalate: sets status to blocked, adds escalation event, notifies parent (mock tmux)
 *   - hal kill: kills panes for a task, cleans .panes.yaml, handles dead panes
 *   - hal panes: shows formatted table, empty message
 *   - hal epic list/current/archive: list, most recent, move to archive
 *   - hal rule add/list: list rules.md, append to rules.md
 *   - hal layout: calls tmux select-layout (mock), invalid type error
 */

import {
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import * as yaml from "js-yaml";
import type { TaskYaml, ConfigYaml } from "../types.js";
import { PanesManager, type PaneEntry } from "../lib/panes-manager.js";
import { handleEscalate } from "../commands/escalate.js";
import { handleKill } from "../commands/kill-cmd.js";
import { handlePanes, formatPanesTable } from "../commands/panes.js";
import {
  listEpics,
  currentEpic,
  archiveEpic,
  createEpic,
} from "../commands/epic.js";
import { listRules, addRule } from "../commands/rule.js";
import { handleLayout, getValidLayouts } from "../commands/layout.js";
import { findStep } from "../lib/task-utils.js";

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

async function expectThrowsAsync(
  fn: () => Promise<void>,
  containsMsg?: string,
): Promise<void> {
  try {
    await fn();
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

// ============================================================================
// Test Fixtures
// ============================================================================

function createTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "haltr-m7-test-"));
  const haltrDir = join(dir, "haltr");
  mkdirSync(haltrDir, { recursive: true });
  mkdirSync(join(haltrDir, "epics"), { recursive: true });

  const config: ConfigYaml = {
    orchestrator_cli: "claude",
    watcher: { poll_interval: 30, inactivity_threshold: 300 },
    panes: { max_concurrent: 10 },
    retry: { max_attempts: 3 },
  };
  writeFileSync(join(haltrDir, "config.yaml"), yaml.dump(config));
  writeFileSync(join(haltrDir, "rules.md"), "# Rules\n");
  return dir;
}

function createTaskFile(dir: string, taskData: TaskYaml): string {
  const taskPath = join(dir, "haltr", "task.yaml");
  writeFileSync(
    taskPath,
    yaml.dump(taskData, { lineWidth: -1, noRefs: true }),
  );
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
        status: "in_progress",
        steps: [
          {
            id: "data-collection",
            goal: "Collect data",
            status: "in_progress",
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
      },
    ],
    history: [
      {
        at: "2026-03-19T00:00:00.000Z",
        type: "step_started",
        by: "orchestrator(claude)",
        step: "step-1/data-collection",
        attempt: 1,
      },
    ],
    ...overrides,
  };
}

// Mock tmux send-keys function
function createMockSendKeys(): {
  fn: (paneId: string, text: string) => Promise<void>;
  calls: Array<{ paneId: string; text: string }>;
} {
  const calls: Array<{ paneId: string; text: string }> = [];
  const fn = async (paneId: string, text: string): Promise<void> => {
    calls.push({ paneId, text });
  };
  return { fn, calls };
}

// Mock tmux kill-pane function
function createMockKillPane(): {
  fn: (paneId: string) => Promise<void>;
  calls: string[];
  failOn: Set<string>;
} {
  const calls: string[] = [];
  const failOn = new Set<string>();
  const fn = async (paneId: string): Promise<void> => {
    calls.push(paneId);
    if (failOn.has(paneId)) {
      throw new Error("pane not found");
    }
  };
  return { fn, calls, failOn };
}

// Mock tmux run function
function createMockTmuxRun(): {
  fn: (args: string[]) => Promise<string>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const fn = async (args: string[]): Promise<string> => {
    calls.push(args);
    return "";
  };
  return { fn, calls };
}

// ============================================================================
// Section 1: hal escalate
// ============================================================================

console.log("\n--- hal escalate ---");

await testAsync(
  "escalate: sets step status to blocked and adds escalation event",
  async () => {
    const dir = createTestDir();
    try {
      const taskPath = createTaskFile(dir, makeBaseTask());
      const mock = createMockSendKeys();

      await handleEscalate(
        {
          task: taskPath,
          step: "step-1/data-collection",
          reason: "API unavailable",
        },
        mock.fn,
        dir,
      );

      const task = readTask(taskPath);

      // Check status is blocked
      const step = findStep(task.steps, "step-1/data-collection");
      assertEqual(step!.status, "blocked", "step status");

      // Check escalation event
      const escEvent = task.history!.find((e) => e.type === "escalation");
      assert(escEvent !== undefined, "escalation event should exist");
      assertEqual(
        (escEvent as any).reason,
        "API unavailable",
        "reason",
      );
      assertEqual(
        (escEvent as any).step,
        "step-1/data-collection",
        "step",
      );
      assert(
        (escEvent as any).attempt >= 1,
        "attempt should be >= 1",
      );
      assert(
        typeof escEvent!.by === "string" && escEvent!.by.includes("worker"),
        "by should be worker",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

await testAsync(
  "escalate: notifies parent via tmux send-keys",
  async () => {
    const dir = createTestDir();
    try {
      const taskPath = createTaskFile(dir, makeBaseTask());
      const mock = createMockSendKeys();

      // Set up .panes.yaml with a pane that matches
      // PanesManager should use dirname(taskPath) to match handleEscalate's lookup
      const mgr = new PanesManager(dirname(taskPath));
      mgr.add({
        pane_id: "%5",
        step: "step-1/data-collection",
        role: "worker",
        parent_pane_id: "%0",
        cli: "claude",
        task_path: taskPath,
      });

      await handleEscalate(
        {
          task: taskPath,
          step: "step-1/data-collection",
          reason: "test error",
        },
        mock.fn,
        dir,
      );

      // Verify send-keys was called to parent pane
      assertEqual(mock.calls.length, 1, "sendKeys call count");
      assertEqual(mock.calls[0].paneId, "%0", "parent pane id");
      assert(
        mock.calls[0].text.includes("blocked"),
        "message should contain 'blocked'",
      );
      assert(
        mock.calls[0].text.includes("test error"),
        "message should contain reason",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

await testAsync(
  "escalate: history has escalation event with correct fields",
  async () => {
    const dir = createTestDir();
    try {
      const taskPath = createTaskFile(dir, makeBaseTask());
      const mock = createMockSendKeys();

      await handleEscalate(
        {
          task: taskPath,
          step: "step-1/data-collection",
          reason: "dependency failed",
        },
        mock.fn,
        dir,
      );

      const task = readTask(taskPath);
      const escEvent = task.history!.find(
        (e) => e.type === "escalation",
      ) as any;

      assert(escEvent !== undefined, "escalation event should exist");
      assert(typeof escEvent.at === "string", "at should be a string");
      assert(
        /^\d{4}-\d{2}-\d{2}T/.test(escEvent.at),
        "at should be ISO 8601",
      );
      assertEqual(escEvent.type, "escalation", "type");
      assert(typeof escEvent.by === "string", "by should be a string");
      assertEqual(escEvent.step, "step-1/data-collection", "step");
      assertEqual(escEvent.reason, "dependency failed", "reason");
      assert(typeof escEvent.attempt === "number", "attempt should be number");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

await testAsync(
  "escalate: step not in_progress -> error (invalid transition)",
  async () => {
    const dir = createTestDir();
    try {
      const task = makeBaseTask();
      // step-2 is pending, cannot go to blocked
      const taskPath = createTaskFile(dir, task);
      const mock = createMockSendKeys();

      await expectThrowsAsync(
        () =>
          handleEscalate(
            { task: taskPath, step: "step-2", reason: "test" },
            mock.fn,
            dir,
          ),
        "Invalid status transition",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

await testAsync(
  "escalate: step not found -> error",
  async () => {
    const dir = createTestDir();
    try {
      const taskPath = createTaskFile(dir, makeBaseTask());
      const mock = createMockSendKeys();

      await expectThrowsAsync(
        () =>
          handleEscalate(
            { task: taskPath, step: "nonexistent", reason: "test" },
            mock.fn,
            dir,
          ),
        "Step not found",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ============================================================================
// Section 2: hal kill
// ============================================================================

console.log("\n--- hal kill ---");

await testAsync(
  "kill: kills all panes for a task and cleans .panes.yaml",
  async () => {
    const dir = createTestDir();
    try {
      const mockKill = createMockKillPane();
      const taskPath = createTaskFile(dir, makeBaseTask());
      const otherTaskPath = join(dir, "haltr", "other-task.yaml");
      writeFileSync(otherTaskPath, yaml.dump(makeBaseTask(), { lineWidth: -1, noRefs: true }));

      // PanesManager should use dirname(taskPath) to match handleKill's lookup
      const mgr = new PanesManager(dirname(taskPath));
      mgr.add({
        pane_id: "%3",
        step: "step-1",
        role: "worker",
        parent_pane_id: "%0",
        cli: "claude",
        task_path: taskPath,
      });
      mgr.add({
        pane_id: "%4",
        step: "step-1",
        role: "verifier",
        parent_pane_id: "%0",
        cli: "codex",
        task_path: taskPath,
      });
      mgr.add({
        pane_id: "%5",
        step: "step-2",
        role: "worker",
        parent_pane_id: "%0",
        cli: "claude",
        task_path: otherTaskPath,
      });

      await handleKill(
        { task: taskPath },
        mockKill.fn,
        dir,
      );

      // Should have killed %3 and %4
      assertEqual(mockKill.calls.length, 2, "kill call count");
      assert(mockKill.calls.includes("%3"), "should kill %3");
      assert(mockKill.calls.includes("%4"), "should kill %4");

      // .panes.yaml should only have %5
      const remaining = mgr.load();
      assertEqual(remaining.length, 1, "remaining panes");
      assertEqual(remaining[0].pane_id, "%5", "remaining pane");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

await testAsync(
  "kill: already-dead pane doesn't cause error",
  async () => {
    const dir = createTestDir();
    try {
      const mockKill = createMockKillPane();
      // Make %3 fail (already dead)
      mockKill.failOn.add("%3");

      const taskPath = createTaskFile(dir, makeBaseTask());

      // PanesManager should use dirname(taskPath) to match handleKill's lookup
      const mgr = new PanesManager(dirname(taskPath));
      mgr.add({
        pane_id: "%3",
        step: "step-1",
        role: "worker",
        parent_pane_id: "%0",
        cli: "claude",
        task_path: taskPath,
      });
      mgr.add({
        pane_id: "%4",
        step: "step-1",
        role: "verifier",
        parent_pane_id: "%0",
        cli: "codex",
        task_path: taskPath,
      });

      // Should NOT throw even though %3 kill fails
      await handleKill(
        { task: taskPath },
        mockKill.fn,
        dir,
      );

      // Both should have been attempted
      assertEqual(mockKill.calls.length, 2, "kill call count");

      // .panes.yaml should be cleaned up
      const remaining = mgr.load();
      assertEqual(remaining.length, 0, "remaining panes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

await testAsync(
  "kill: no matching panes -> no error",
  async () => {
    const dir = createTestDir();
    try {
      const mockKill = createMockKillPane();
      const taskPath = createTaskFile(dir, makeBaseTask());
      const otherTaskPath = join(dir, "haltr", "other.yaml");
      writeFileSync(otherTaskPath, yaml.dump(makeBaseTask(), { lineWidth: -1, noRefs: true }));

      // PanesManager should use dirname(taskPath) to match handleKill's lookup
      const mgr = new PanesManager(dirname(taskPath));
      mgr.add({
        pane_id: "%3",
        step: "step-1",
        role: "worker",
        parent_pane_id: "%0",
        cli: "claude",
        task_path: otherTaskPath,
      });

      await handleKill(
        { task: taskPath },
        mockKill.fn,
        dir,
      );

      assertEqual(mockKill.calls.length, 0, "no kills");
      // Other entries preserved
      assertEqual(mgr.load().length, 1, "other entries preserved");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ============================================================================
// Section 3: hal panes
// ============================================================================

console.log("\n--- hal panes ---");

test("panes: shows formatted table from .panes.yaml", () => {
  const dir = createTestDir();
  try {
    const mgr = new PanesManager(dir);
    mgr.add({
      pane_id: "%3",
      step: "step-1",
      role: "worker",
      parent_pane_id: "%0",
      cli: "claude",
      task_path: "task.yaml",
    });
    mgr.add({
      pane_id: "%4",
      step: "step-1",
      role: "verifier",
      parent_pane_id: "%0",
      cli: "codex",
      task_path: "task.yaml",
    });

    const output = handlePanes(dir);

    assert(output.includes("PANE"), "should have PANE header");
    assert(output.includes("STEP"), "should have STEP header");
    assert(output.includes("ROLE"), "should have ROLE header");
    assert(output.includes("CLI"), "should have CLI header");
    assert(output.includes("PARENT"), "should have PARENT header");
    assert(output.includes("%3"), "should show pane %3");
    assert(output.includes("%4"), "should show pane %4");
    assert(output.includes("worker"), "should show worker role");
    assert(output.includes("verifier"), "should show verifier role");
    assert(output.includes("claude"), "should show claude CLI");
    assert(output.includes("codex"), "should show codex CLI");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("panes: empty .panes.yaml -> empty message", () => {
  const dir = createTestDir();
  try {
    const output = handlePanes(dir);
    assertEqual(output, "No panes tracked.", "empty message");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("panes: formatPanesTable produces correct table", () => {
  const panes: PaneEntry[] = [
    {
      pane_id: "%3",
      step: "step-1",
      role: "worker",
      parent_pane_id: "%0",
      cli: "claude",
      task_path: "task.yaml",
    },
  ];

  const output = formatPanesTable(panes);
  const lines = output.split("\n");

  // First line is header
  assert(lines[0].includes("PANE"), "header line");
  // Second line is data
  assert(lines[1].includes("%3"), "data line");
  assert(lines[1].includes("step-1"), "step in data");
  assert(lines[1].includes("worker"), "role in data");
  assert(lines[1].includes("claude"), "cli in data");
  assert(lines[1].includes("%0"), "parent in data");
});

// ============================================================================
// Section 4: hal epic list / current / archive
// ============================================================================

console.log("\n--- hal epic list/current/archive ---");

test("epic list: lists epics with status (excludes archive)", () => {
  const dir = createTestDir();
  try {
    const epicsDir = join(dir, "haltr", "epics");

    // Create two epic dirs with task.yaml
    mkdirSync(join(epicsDir, "20260319-001_implement-auth"), {
      recursive: true,
    });
    writeFileSync(
      join(
        epicsDir,
        "20260319-001_implement-auth",
        "001_task.yaml",
      ),
      yaml.dump({ id: "auth", status: "in_progress", agents: { worker: "claude", verifier: "codex" }, steps: [] }),
    );

    mkdirSync(join(epicsDir, "20260319-002_fix-bug"), {
      recursive: true,
    });
    writeFileSync(
      join(epicsDir, "20260319-002_fix-bug", "001_task.yaml"),
      yaml.dump({ id: "bug", status: "done", agents: { worker: "claude", verifier: "codex" }, steps: [] }),
    );

    // Create archive dir (should be excluded)
    mkdirSync(join(epicsDir, "archive"), { recursive: true });

    const epics = listEpics(dir);

    assertEqual(epics.length, 2, "epic count");
    assertEqual(epics[0].name, "20260319-001_implement-auth", "first epic");
    assertEqual(epics[0].status, "in_progress", "first status");
    assertEqual(epics[1].name, "20260319-002_fix-bug", "second epic");
    assertEqual(epics[1].status, "done", "second status");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("epic list: empty epics dir -> empty array", () => {
  const dir = createTestDir();
  try {
    const epics = listEpics(dir);
    assertEqual(epics.length, 0, "epic count");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("epic current: shows most recent epic", () => {
  const dir = createTestDir();
  try {
    const epicsDir = join(dir, "haltr", "epics");

    mkdirSync(join(epicsDir, "20260318-001_old-epic"), {
      recursive: true,
    });
    mkdirSync(join(epicsDir, "20260319-001_new-epic"), {
      recursive: true,
    });
    writeFileSync(
      join(epicsDir, "20260319-001_new-epic", "001_task.yaml"),
      yaml.dump({ id: "new", status: "pending", agents: { worker: "claude", verifier: "codex" }, steps: [] }),
    );

    const epic = currentEpic(dir);

    assert(epic !== null, "should find epic");
    assertEqual(epic!.name, "20260319-001_new-epic", "most recent epic");
    assert(
      epic!.taskPath !== null && epic!.taskPath!.includes("001_task.yaml"),
      "taskPath should point to task.yaml",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("epic current: no epics -> null", () => {
  const dir = createTestDir();
  try {
    const epic = currentEpic(dir);
    assertEqual(epic, null, "should be null");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("epic archive: moves to archive/", () => {
  const dir = createTestDir();
  try {
    const epicsDir = join(dir, "haltr", "epics");

    mkdirSync(join(epicsDir, "20260319-001_test-epic"), {
      recursive: true,
    });
    writeFileSync(
      join(epicsDir, "20260319-001_test-epic", "001_task.yaml"),
      "test content",
    );

    archiveEpic(dir, "test-epic");

    // Original should be gone
    assert(
      !existsSync(join(epicsDir, "20260319-001_test-epic")),
      "original should be gone",
    );

    // Should be in archive
    assert(
      existsSync(
        join(epicsDir, "archive", "20260319-001_test-epic"),
      ),
      "should exist in archive",
    );

    // Content should be preserved
    const content = readFileSync(
      join(
        epicsDir,
        "archive",
        "20260319-001_test-epic",
        "001_task.yaml",
      ),
      "utf-8",
    );
    assertEqual(content, "test content", "content preserved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("epic archive: creates archive/ if needed", () => {
  const dir = createTestDir();
  try {
    const epicsDir = join(dir, "haltr", "epics");
    const archiveDir = join(epicsDir, "archive");

    assert(!existsSync(archiveDir), "archive should not exist initially");

    mkdirSync(join(epicsDir, "20260319-001_test-epic"), {
      recursive: true,
    });

    archiveEpic(dir, "test-epic");

    assert(existsSync(archiveDir), "archive should be created");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("epic archive: error if destination exists", () => {
  const dir = createTestDir();
  try {
    const epicsDir = join(dir, "haltr", "epics");

    // Create the epic
    mkdirSync(join(epicsDir, "20260319-001_dupe-epic"), {
      recursive: true,
    });

    // Pre-create destination in archive
    mkdirSync(
      join(epicsDir, "archive", "20260319-001_dupe-epic"),
      { recursive: true },
    );

    expectThrows(
      () => archiveEpic(dir, "dupe-epic"),
      "Destination already exists",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("epic archive: not found -> error", () => {
  const dir = createTestDir();
  try {
    expectThrows(
      () => archiveEpic(dir, "nonexistent"),
      "No epic found",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Section 5: hal rule add / list
// ============================================================================

console.log("\n--- hal rule add / list ---");

test("rule list: shows rules.md content", () => {
  const dir = createTestDir();
  try {
    const content = listRules(dir);
    assertEqual(content, "# Rules\n", "initial rules.md content");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rule add: appends rule to rules.md", () => {
  const dir = createTestDir();
  try {
    addRule(dir, "Always write tests");
    const content = listRules(dir);
    assert(content.includes("# Rules"), "should keep header");
    assert(
      content.includes("- Always write tests"),
      "should contain the rule",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rule add: multiple rules appended", () => {
  const dir = createTestDir();
  try {
    addRule(dir, "Rule one");
    addRule(dir, "Rule two");
    addRule(dir, "Rule three");
    const content = listRules(dir);
    assert(content.includes("- Rule one"), "should have rule one");
    assert(content.includes("- Rule two"), "should have rule two");
    assert(content.includes("- Rule three"), "should have rule three");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rule list: no haltr dir -> error", () => {
  const dir = mkdtempSync(join(tmpdir(), "haltr-m7-norules-"));
  try {
    expectThrows(() => listRules(dir), "rules.md not found");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rule add: no haltr dir -> error", () => {
  const dir = mkdtempSync(join(tmpdir(), "haltr-m7-norules2-"));
  try {
    expectThrows(() => addRule(dir, "test"), "rules.md not found");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Section 6: hal layout
// ============================================================================

console.log("\n--- hal layout ---");

await testAsync(
  "layout: calls tmux select-layout (mock)",
  async () => {
    const mockRun = createMockTmuxRun();

    await handleLayout("tiled", mockRun.fn, "haltr");

    assertEqual(mockRun.calls.length, 1, "tmuxRun call count");
    const args = mockRun.calls[0];
    assertEqual(args[0], "select-layout", "command");
    assertEqual(args[1], "-t", "flag");
    assertEqual(args[2], "haltr", "session name");
    assertEqual(args[3], "tiled", "layout type");
  },
);

await testAsync(
  "layout: all valid types accepted",
  async () => {
    for (const layoutType of getValidLayouts()) {
      const mockRun = createMockTmuxRun();
      await handleLayout(layoutType, mockRun.fn, "haltr");
      assertEqual(mockRun.calls.length, 1, `call count for ${layoutType}`);
    }
  },
);

await testAsync(
  "layout: invalid type -> error",
  async () => {
    const mockRun = createMockTmuxRun();

    await expectThrowsAsync(
      () => handleLayout("invalid-layout", mockRun.fn, "haltr"),
      "Invalid layout type",
    );

    assertEqual(mockRun.calls.length, 0, "no tmux calls on invalid type");
  },
);

await testAsync(
  "layout: session not found -> graceful error",
  async () => {
    const mockRun = {
      fn: async (_args: string[]): Promise<string> => {
        throw new Error("can't find session: haltr");
      },
      calls: [] as string[][],
    };

    await expectThrowsAsync(
      () => handleLayout("tiled", mockRun.fn, "haltr"),
      "not found",
    );
  },
);

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
