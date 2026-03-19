/**
 * M6 Validation Test Script
 *
 * Verifies all Definition-of-Done items for M6 (hal spawn & hal start).
 * Run with: npm run test:m6
 *
 * Tests:
 *   - Hooks rendering: directory naming, template rendering, incrementing
 *   - Prompt assembly: role-specific prompt content
 *   - CLI resolution: priority chain (--cli, accept, step, task, config)
 *   - Pane limit enforcement
 *   - hal start/stop logic (mocked tmux)
 */

import {
  writeFileSync,
  readFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import * as yaml from "js-yaml";
import type { TaskYaml, ConfigYaml, AcceptObject } from "../types.js";
import { PanesManager, type PaneEntry } from "../lib/panes-manager.js";
import {
  handleSpawn,
  resolveCli,
  nextHooksIndex,
  buildHooksDirName,
  renderHooks,
  assemblePrompt,
  findHaltrDir,
  VALID_ROLES,
} from "../commands/spawn.js";
import { handleStart, type StartDeps } from "../commands/start.js";
import { handleStop, type StopDeps } from "../commands/stop.js";

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
  fn: () => Promise<unknown>,
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
  const dir = mkdtempSync(join(tmpdir(), "haltr-m6-test-"));
  const haltrDir = join(dir, "haltr");
  mkdirSync(haltrDir, { recursive: true });
  mkdirSync(join(haltrDir, "agents"), { recursive: true });
  mkdirSync(join(haltrDir, "epics"), { recursive: true });

  const config: ConfigYaml = {
    orchestrator_cli: "claude",
    watcher: { poll_interval: 30, inactivity_threshold: 300 },
    panes: { max_concurrent: 5 },
    retry: { max_attempts: 3 },
  };
  writeFileSync(join(haltrDir, "config.yaml"), yaml.dump(config));
  writeFileSync(join(haltrDir, "rules.md"), "# Rules\n- Always write tests\n");

  // Agent definitions are built-in (src/agents/*.yaml).
  // No need to write them here — getAgentSettings falls back to built-in.

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

function makeBaseTask(overrides: Partial<TaskYaml> = {}): TaskYaml {
  return {
    id: "test-task",
    agents: { worker: "claude", verifier: "codex" },
    steps: [
      {
        id: "step-1",
        goal: "First step",
        status: "in_progress",
        accept: [
          { id: "default", check: "data collected" },
          { id: "perf", check: "performance is good", verifier: "gemini" },
        ],
        agents: { worker: "gemini", verifier: "codex" },
      },
      {
        id: "step-2",
        goal: "Second step",
        status: "pending",
      },
    ],
    context: "Test task context",
    history: [
      { at: "2026-01-01T00:00:00Z", type: "created" as const, by: "orchestrator(claude)" },
      { at: "2026-01-01T00:01:00Z", type: "spec_reviewed" as const, by: "task-spec-reviewer(claude)", message: "OK" },
      { at: "2026-01-01T00:02:00Z", type: "execution_approved" as const, by: "orchestrator(claude)" },
    ],
    ...overrides,
  };
}

// ============================================================================
// Section 1: CLI Resolution
// ============================================================================

console.log("\n--- CLI Resolution ---");

test("CLI resolution: --cli flag overrides everything", () => {
  const dir = createTestDir();
  try {
    const taskPath = createTaskFile(dir, makeBaseTask());
    const taskYaml = makeBaseTask();
    const config: ConfigYaml = {
      orchestrator_cli: "claude",
      watcher: { poll_interval: 30, inactivity_threshold: 300 },
      panes: { max_concurrent: 5 },
      retry: { max_attempts: 3 },
    };

    const cli = resolveCli("worker", taskYaml, config, "step-1", "codex");
    assertEqual(cli, "codex", "explicit override");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI resolution: worker uses task.agents.worker", () => {
  const taskYaml = makeBaseTask();
  const config: ConfigYaml = {
    orchestrator_cli: "claude",
    watcher: { poll_interval: 30, inactivity_threshold: 300 },
    panes: { max_concurrent: 5 },
    retry: { max_attempts: 3 },
  };

  // No step override, no --cli flag -> use task.agents.worker
  const cli = resolveCli("worker", taskYaml, config);
  assertEqual(cli, "claude", "task-level worker");
});

test("CLI resolution: step.agents.worker overrides task level", () => {
  const taskYaml = makeBaseTask();
  const config: ConfigYaml = {
    orchestrator_cli: "claude",
    watcher: { poll_interval: 30, inactivity_threshold: 300 },
    panes: { max_concurrent: 5 },
    retry: { max_attempts: 3 },
  };

  // step-1 has agents.worker: gemini
  const cli = resolveCli("worker", taskYaml, config, "step-1");
  assertEqual(cli, "gemini", "step-level worker override");
});

test("CLI resolution: step without agents uses task level", () => {
  const taskYaml = makeBaseTask();
  const config: ConfigYaml = {
    orchestrator_cli: "claude",
    watcher: { poll_interval: 30, inactivity_threshold: 300 },
    panes: { max_concurrent: 5 },
    retry: { max_attempts: 3 },
  };

  // step-2 has no agents override
  const cli = resolveCli("worker", taskYaml, config, "step-2");
  assertEqual(cli, "claude", "falls back to task.agents.worker");
});

test("CLI resolution: verifier uses task.agents.verifier", () => {
  const taskYaml = makeBaseTask();
  const config: ConfigYaml = {
    orchestrator_cli: "claude",
    watcher: { poll_interval: 30, inactivity_threshold: 300 },
    panes: { max_concurrent: 5 },
    retry: { max_attempts: 3 },
  };

  const cli = resolveCli("verifier", taskYaml, config);
  assertEqual(cli, "codex", "task-level verifier");
});

test("CLI resolution: step.agents.verifier overrides", () => {
  const taskYaml = makeBaseTask();
  const config: ConfigYaml = {
    orchestrator_cli: "claude",
    watcher: { poll_interval: 30, inactivity_threshold: 300 },
    panes: { max_concurrent: 5 },
    retry: { max_attempts: 3 },
  };

  // step-1 has agents.verifier: codex (same as task-level, but explicitly set)
  const cli = resolveCli("verifier", taskYaml, config, "step-1");
  assertEqual(cli, "codex", "step-level verifier override");
});

test("CLI resolution: accept[].verifier overrides (highest priority)", () => {
  const taskYaml = makeBaseTask();
  const config: ConfigYaml = {
    orchestrator_cli: "claude",
    watcher: { poll_interval: 30, inactivity_threshold: 300 },
    panes: { max_concurrent: 5 },
    retry: { max_attempts: 3 },
  };

  // step-1 has accept[1] with verifier: "gemini"
  const cli = resolveCli(
    "verifier",
    taskYaml,
    config,
    "step-1",
    undefined,
    "perf",
  );
  assertEqual(cli, "gemini", "accept-level verifier override");
});

test("CLI resolution: accept[].verifier not set falls to step/task", () => {
  const taskYaml = makeBaseTask();
  const config: ConfigYaml = {
    orchestrator_cli: "claude",
    watcher: { poll_interval: 30, inactivity_threshold: 300 },
    panes: { max_concurrent: 5 },
    retry: { max_attempts: 3 },
  };

  // "default" accept has no verifier override
  const cli = resolveCli(
    "verifier",
    taskYaml,
    config,
    "step-1",
    undefined,
    "default",
  );
  assertEqual(cli, "codex", "falls to step.agents.verifier");
});

test("CLI resolution: orchestrator roles use config.orchestrator_cli", () => {
  const taskYaml = makeBaseTask();
  const config: ConfigYaml = {
    orchestrator_cli: "gemini",
    watcher: { poll_interval: 30, inactivity_threshold: 300 },
    panes: { max_concurrent: 5 },
    retry: { max_attempts: 3 },
  };

  for (const role of ["sub-orchestrator", "task-spec-reviewer", "rules-agent"]) {
    const cli = resolveCli(role, taskYaml, config);
    assertEqual(cli, "gemini", `${role} uses orchestrator_cli`);
  }
});

// ============================================================================
// Section 2: Hooks Rendering
// ============================================================================

console.log("\n--- Hooks Rendering ---");

test("nextHooksIndex: returns 001 when no .hooks dir", () => {
  const dir = createTestDir();
  try {
    const idx = nextHooksIndex(join(dir, "haltr", ".hooks"));
    assertEqual(idx, "001", "first index");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nextHooksIndex: increments from existing", () => {
  const dir = createTestDir();
  try {
    const hooksBase = join(dir, "haltr", ".hooks");
    mkdirSync(hooksBase, { recursive: true });
    mkdirSync(join(hooksBase, "001_step-1_worker"));
    mkdirSync(join(hooksBase, "002_step-1_verifier"));

    const idx = nextHooksIndex(hooksBase);
    assertEqual(idx, "003", "next index after 002");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildHooksDirName: with step", () => {
  const name = buildHooksDirName("001", "worker", "step-1");
  assertEqual(name, "001_step-1_worker", "dir name with step");
});

test("buildHooksDirName: without step", () => {
  const name = buildHooksDirName("001", "task-spec-reviewer");
  assertEqual(name, "001_task-spec-reviewer", "dir name without step");
});

test("renderHooks: creates .hooks/001_step-1_worker/ with rendered settings.yaml", () => {
  const dir = createTestDir();
  try {
    const haltrDir = join(dir, "haltr");
    const taskPath = join(haltrDir, "task.yaml");

    const hooksDir = renderHooks(haltrDir, "worker", taskPath, "step-1");

    // Check directory was created
    assert(existsSync(hooksDir), "hooks directory should exist");
    assert(hooksDir.includes("001_step-1_worker"), "dir name includes step and role");

    // Check settings.yaml was rendered with placeholders replaced
    const settingsContent = readFileSync(join(hooksDir, "settings.yaml"), "utf-8");
    assert(!settingsContent.includes("{{task}}"), "{{task}} should be replaced");
    assert(!settingsContent.includes("{{step}}"), "{{step}} should be replaced");
    assert(settingsContent.includes(taskPath), "should contain task path");
    assert(settingsContent.includes("step-1"), "should contain step ID");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderHooks: second spawn increments to 002", () => {
  const dir = createTestDir();
  try {
    const haltrDir = join(dir, "haltr");
    const taskPath = join(haltrDir, "task.yaml");

    const hooksDir1 = renderHooks(haltrDir, "worker", taskPath, "step-1");
    assert(hooksDir1.includes("001_step-1_worker"), "first is 001");

    const hooksDir2 = renderHooks(haltrDir, "verifier", taskPath, "step-1");
    assert(hooksDir2.includes("002_step-1_verifier"), "second is 002");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderHooks: no step -> dir name without step", () => {
  const dir = createTestDir();
  try {
    const haltrDir = join(dir, "haltr");
    const taskPath = join(haltrDir, "task.yaml");

    const hooksDir = renderHooks(haltrDir, "task-spec-reviewer", taskPath);

    assert(
      hooksDir.includes("001_task-spec-reviewer"),
      "dir name without step",
    );
    assert(
      !hooksDir.includes("001__task-spec-reviewer"),
      "no double underscore",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderHooks: no step -> settings.yaml {{step}} replaced with empty string", () => {
  const dir = createTestDir();
  try {
    const haltrDir = join(dir, "haltr");
    const taskPath = join(haltrDir, "task.yaml");

    const hooksDir = renderHooks(haltrDir, "task-spec-reviewer", taskPath);

    const settingsContent = readFileSync(join(hooksDir, "settings.yaml"), "utf-8");
    assert(!settingsContent.includes("{{step}}"), "{{step}} should be replaced");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Section 3: Prompt Assembly
// ============================================================================

console.log("\n--- Prompt Assembly ---");

test("assemblePrompt: worker prompt contains rules + role instruction", () => {
  const dir = createTestDir();
  try {
    const haltrDir = join(dir, "haltr");
    const taskYaml = makeBaseTask();
    const taskPath = join(haltrDir, "task.yaml");
    const hooksDir = renderHooks(haltrDir, "worker", taskPath, "step-1");

    const promptPath = assemblePrompt(
      hooksDir,
      haltrDir,
      "worker",
      taskYaml,
      taskPath,
      "step-1",
    );

    assert(existsSync(promptPath), "prompt.md should exist");
    const content = readFileSync(promptPath, "utf-8");
    assert(content.includes("# Rules"), "should contain rules header");
    assert(content.includes("Always write tests"), "should contain rule content");
    assert(
      content.includes("割り当てられたステップだけを実装すること"),
      "should contain worker instruction",
    );
    assert(content.includes("step-1"), "should contain step ID");
    assert(content.includes("First step"), "should contain step goal");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assemblePrompt: verifier prompt contains accept check instruction", () => {
  const dir = createTestDir();
  try {
    const haltrDir = join(dir, "haltr");
    const taskYaml = makeBaseTask();
    const taskPath = join(haltrDir, "task.yaml");
    const hooksDir = renderHooks(haltrDir, "verifier", taskPath, "step-1");

    const promptPath = assemblePrompt(
      hooksDir,
      haltrDir,
      "verifier",
      taskYaml,
      taskPath,
      "step-1",
    );

    const content = readFileSync(promptPath, "utf-8");
    assert(
      content.includes("accept check に加え、以下のルールへの準拠も確認してください"),
      "should contain verifier instruction",
    );
    assert(content.includes("data collected"), "should contain accept check");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assemblePrompt: task-spec-reviewer prompt contains review instruction", () => {
  const dir = createTestDir();
  try {
    const haltrDir = join(dir, "haltr");
    const taskYaml = makeBaseTask();
    const taskPath = join(haltrDir, "task.yaml");
    const hooksDir = renderHooks(haltrDir, "task-spec-reviewer", taskPath);

    const promptPath = assemblePrompt(
      hooksDir,
      haltrDir,
      "task-spec-reviewer",
      taskYaml,
      taskPath,
    );

    const content = readFileSync(promptPath, "utf-8");
    assert(
      content.includes("タスク仕様のレビューのみ行う"),
      "should contain task-spec-reviewer instruction",
    );
    assert(content.includes("test-task"), "should contain task ID");
    assert(content.includes("step-1"), "should contain step listing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assemblePrompt: sub-orchestrator prompt contains orchestrator instructions", () => {
  const dir = createTestDir();
  try {
    const haltrDir = join(dir, "haltr");
    const taskYaml = makeBaseTask();
    const taskPath = join(haltrDir, "task.yaml");
    const hooksDir = renderHooks(haltrDir, "sub-orchestrator", taskPath, "step-1");

    const promptPath = assemblePrompt(
      hooksDir,
      haltrDir,
      "sub-orchestrator",
      taskYaml,
      taskPath,
      "step-1",
    );

    const content = readFileSync(promptPath, "utf-8");
    assert(content.includes("# Rules"), "should contain rules");
    assert(
      content.includes("サブオーケストレータ"),
      "should contain sub-orchestrator instruction",
    );
    assert(content.includes("step-1"), "should contain step details");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assemblePrompt: rules-agent prompt contains rule update instructions", () => {
  const dir = createTestDir();
  try {
    const haltrDir = join(dir, "haltr");
    const taskYaml = makeBaseTask();
    const taskPath = join(haltrDir, "task.yaml");
    const hooksDir = renderHooks(haltrDir, "rules-agent", taskPath);

    const promptPath = assemblePrompt(
      hooksDir,
      haltrDir,
      "rules-agent",
      taskYaml,
      taskPath,
    );

    const content = readFileSync(promptPath, "utf-8");
    assert(content.includes("# Rules"), "should contain rules");
    assert(
      content.includes("ルールエージェント"),
      "should contain rules-agent instruction",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assemblePrompt: main-orchestrator prompt contains task overview", () => {
  const dir = createTestDir();
  try {
    const haltrDir = join(dir, "haltr");
    const taskYaml = makeBaseTask();
    const taskPath = join(haltrDir, "task.yaml");
    const hooksDir = renderHooks(haltrDir, "main-orchestrator", taskPath);

    const promptPath = assemblePrompt(
      hooksDir,
      haltrDir,
      "main-orchestrator",
      taskYaml,
      taskPath,
    );

    const content = readFileSync(promptPath, "utf-8");
    assert(content.includes("# Rules"), "should contain rules");
    assert(
      content.includes("メインオーケストレーター"),
      "should contain main-orchestrator instruction",
    );
    assert(content.includes("hal spawn worker"), "should contain spawn command");
    assert(content.includes("hal kill"), "should contain kill command");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Section 4: handleSpawn (integrated, no tmux)
// ============================================================================

console.log("\n--- handleSpawn (no tmux) ---");

await testAsync(
  "handleSpawn: creates hooks dir and prompt for worker with step",
  async () => {
    const dir = createTestDir();
    try {
      const taskPath = createTaskFile(dir, makeBaseTask());

      const result = await handleSpawn(
        { role: "worker", task: taskPath, step: "step-1" },
        undefined, // no runtime
        dir,
      );

      assert(existsSync(result.hooksDir), "hooks dir should exist");
      assert(result.hooksDir.includes("001_step-1_worker"), "hooks dir name");
      assert(existsSync(result.promptPath), "prompt should exist");
      assertEqual(result.cli, "gemini", "step-level worker override");

      // Check .panes.yaml was updated (in epic directory, same as task.yaml)
      const mgr = new PanesManager(dirname(taskPath));
      const panes = mgr.load();
      assertEqual(panes.length, 1, "one pane registered");
      assertEqual(panes[0].role, "worker", "role recorded");
      assertEqual(panes[0].cli, "gemini", "resolved CLI recorded");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

await testAsync(
  "handleSpawn: resolved CLI is recorded in .panes.yaml",
  async () => {
    const dir = createTestDir();
    try {
      const taskPath = createTaskFile(dir, makeBaseTask());

      await handleSpawn(
        { role: "worker", task: taskPath, step: "step-2" },
        undefined,
        dir,
      );

      const mgr = new PanesManager(dirname(taskPath));
      const panes = mgr.load();
      assertEqual(panes.length, 1, "one pane");
      // step-2 has no agents override, should use task.agents.worker = "claude"
      assertEqual(panes[0].cli, "claude", "CLI should be task-level worker");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

await testAsync(
  "handleSpawn: invalid role -> error",
  async () => {
    const dir = createTestDir();
    try {
      const taskPath = createTaskFile(dir, makeBaseTask());

      await expectThrowsAsync(
        () =>
          handleSpawn(
            { role: "invalid-role", task: taskPath, step: "step-1" },
            undefined,
            dir,
          ),
        "Invalid role",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

await testAsync(
  "handleSpawn: step not found -> error",
  async () => {
    const dir = createTestDir();
    try {
      const taskPath = createTaskFile(dir, makeBaseTask());

      await expectThrowsAsync(
        () =>
          handleSpawn(
            { role: "worker", task: taskPath, step: "nonexistent" },
            undefined,
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
// Section 5: Pane Limit
// ============================================================================

console.log("\n--- Pane Limit ---");

await testAsync(
  "handleSpawn: pane count at max_concurrent -> error",
  async () => {
    const dir = createTestDir();
    try {
      const taskPath = createTaskFile(dir, makeBaseTask());

      // Pre-fill .panes.yaml to max_concurrent (5) in epic directory
      const mgr = new PanesManager(dirname(taskPath));
      for (let i = 0; i < 5; i++) {
        mgr.add({
          pane_id: `%${i}`,
          step: "step-1",
          role: "worker",
          parent_pane_id: "%0",
          cli: "claude",
          task_path: taskPath,
        });
      }

      await expectThrowsAsync(
        () =>
          handleSpawn(
            { role: "worker", task: taskPath, step: "step-1" },
            undefined,
            dir,
          ),
        "Pane limit reached",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

await testAsync(
  "handleSpawn: pane count below max_concurrent -> succeeds",
  async () => {
    const dir = createTestDir();
    try {
      const taskPath = createTaskFile(dir, makeBaseTask());

      // Pre-fill .panes.yaml to 4 (below max_concurrent of 5) in epic directory
      const mgr = new PanesManager(dirname(taskPath));
      for (let i = 0; i < 4; i++) {
        mgr.add({
          pane_id: `%${i}`,
          step: "step-1",
          role: "worker",
          parent_pane_id: "%0",
          cli: "claude",
          task_path: taskPath,
        });
      }

      // Should succeed
      const result = await handleSpawn(
        { role: "worker", task: taskPath, step: "step-1" },
        undefined,
        dir,
      );

      assertEqual(result.cli, "gemini", "CLI resolved");

      // Should now have 5 panes
      const panes = mgr.load();
      assertEqual(panes.length, 5, "5 panes total");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ============================================================================
// Section 6: Hooks incrementing and directory naming
// ============================================================================

console.log("\n--- Hooks Incrementing ---");

await testAsync(
  "handleSpawn: second spawn creates 002_ directory",
  async () => {
    const dir = createTestDir();
    try {
      const taskPath = createTaskFile(dir, makeBaseTask());

      const result1 = await handleSpawn(
        { role: "worker", task: taskPath, step: "step-1" },
        undefined,
        dir,
      );
      assert(result1.hooksDir.includes("001_"), "first is 001");

      const result2 = await handleSpawn(
        { role: "verifier", task: taskPath, step: "step-1" },
        undefined,
        dir,
      );
      assert(result2.hooksDir.includes("002_"), "second is 002");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

await testAsync(
  "handleSpawn: spawn without --step -> directory name without step",
  async () => {
    const dir = createTestDir();
    try {
      const taskPath = createTaskFile(dir, makeBaseTask());

      const result = await handleSpawn(
        { role: "task-spec-reviewer", task: taskPath },
        undefined,
        dir,
      );

      assert(
        result.hooksDir.includes("001_task-spec-reviewer"),
        "dir name without step",
      );
      assert(
        !result.hooksDir.includes("001__task-spec-reviewer"),
        "no double underscore",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ============================================================================
// Section 7: hal start (mocked tmux)
// ============================================================================

console.log("\n--- hal start (mocked tmux) ---");

function createMockStartDeps(options?: {
  sessionExists?: boolean;
}): { deps: StartDeps; calls: string[][] } {
  const calls: string[][] = [];
  const deps: StartDeps = {
    sessionExists: async (name: string) => {
      calls.push(["sessionExists", name]);
      return options?.sessionExists ?? false;
    },
    createSession: async (name: string) => {
      calls.push(["createSession", name]);
      return "%0";
    },
    sendKeys: async (paneId: string, text: string) => {
      calls.push(["sendKeys", paneId, text]);
    },
  };
  return { deps, calls };
}

await testAsync(
  "start: creates session, clears .panes.yaml, registers pane 0",
  async () => {
    const dir = createTestDir();
    try {
      const taskPath = createTaskFile(dir, makeBaseTask());
      const { deps, calls } = createMockStartDeps();

      // Pre-fill .panes.yaml with leftover data (in epic directory)
      const mgr = new PanesManager(dirname(taskPath));
      mgr.add({
        pane_id: "%99",
        step: "old-step",
        role: "worker",
        parent_pane_id: "%0",
        cli: "claude",
        task_path: "old.yaml",
      });

      const result = await handleStart({ task: taskPath }, dir, deps);

      // Session was created
      assert(
        calls.some((c) => c[0] === "createSession" && c[1] === "haltr"),
        "createSession called",
      );

      // Pane 0 registered as main-orchestrator
      const panes = mgr.load();
      assertEqual(panes.length, 1, "one pane registered");
      assertEqual(panes[0].pane_id, "%0", "pane_id is %0");
      assertEqual(panes[0].role, "main-orchestrator", "role is main-orchestrator");
      assertEqual(result.paneId, "%0", "returned pane id");
      assertEqual(result.cli, "claude", "orchestrator cli");

      // Old pane data was cleared
      assert(
        !panes.some((p) => p.pane_id === "%99"),
        "old pane data should be cleared",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

await testAsync(
  "start: existing session -> error",
  async () => {
    const dir = createTestDir();
    try {
      const { deps } = createMockStartDeps({ sessionExists: true });

      await expectThrowsAsync(
        () => handleStart({}, dir, deps),
        "already exists",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

await testAsync(
  "start: --cli overrides orchestrator_cli",
  async () => {
    const dir = createTestDir();
    try {
      const taskPath = createTaskFile(dir, makeBaseTask());
      const { deps } = createMockStartDeps();

      const result = await handleStart(
        { cli: "codex", task: taskPath },
        dir,
        deps,
      );

      assertEqual(result.cli, "codex", "CLI overridden");

      // Check .panes.yaml also records the override (in epic directory)
      const mgr = new PanesManager(dirname(taskPath));
      const panes = mgr.load();
      assertEqual(panes[0].cli, "codex", "panes.yaml records override");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

await testAsync(
  "start: uses config.orchestrator_cli when no --cli",
  async () => {
    const dir = createTestDir();
    try {
      const taskPath = createTaskFile(dir, makeBaseTask());
      const { deps } = createMockStartDeps();

      const result = await handleStart({ task: taskPath }, dir, deps);

      assertEqual(result.cli, "claude", "uses config orchestrator_cli");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ============================================================================
// Section 8: hal stop (mocked tmux)
// ============================================================================

console.log("\n--- hal stop (mocked tmux) ---");

function createMockStopDeps(options?: {
  sessionExists?: boolean;
}): { deps: StopDeps; calls: string[][] } {
  const calls: string[][] = [];
  const deps: StopDeps = {
    sessionExists: async (name: string) => {
      calls.push(["sessionExists", name]);
      return options?.sessionExists ?? true;
    },
    killSession: async (name: string) => {
      calls.push(["killSession", name]);
    },
  };
  return { deps, calls };
}

await testAsync(
  "stop: kills session and clears .panes.yaml",
  async () => {
    const dir = createTestDir();
    try {
      // Pre-fill .panes.yaml in haltr/ (fallback location)
      const haltrDir = join(dir, "haltr");
      const mgr = new PanesManager(haltrDir);
      mgr.add({
        pane_id: "%0",
        step: "",
        role: "main-orchestrator",
        parent_pane_id: "",
        cli: "claude",
        task_path: "task.yaml",
      });
      mgr.add({
        pane_id: "%3",
        step: "step-1",
        role: "worker",
        parent_pane_id: "%0",
        cli: "claude",
        task_path: "task.yaml",
      });

      const { deps, calls } = createMockStopDeps();

      await handleStop(dir, deps);

      // Session was killed
      assert(
        calls.some((c) => c[0] === "killSession" && c[1] === "haltr"),
        "killSession called",
      );

      // .panes.yaml cleared
      const panes = mgr.load();
      assertEqual(panes.length, 0, "panes cleared");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

await testAsync(
  "stop: no session -> still clears .panes.yaml",
  async () => {
    const dir = createTestDir();
    try {
      const haltrDir = join(dir, "haltr");
      const mgr = new PanesManager(haltrDir);
      mgr.add({
        pane_id: "%0",
        step: "",
        role: "main-orchestrator",
        parent_pane_id: "",
        cli: "claude",
        task_path: "task.yaml",
      });

      const { deps, calls } = createMockStopDeps({ sessionExists: false });

      await handleStop(dir, deps);

      // killSession should NOT have been called
      assert(
        !calls.some((c) => c[0] === "killSession"),
        "killSession should not be called when session does not exist",
      );

      // .panes.yaml still cleared
      const panes = mgr.load();
      assertEqual(panes.length, 0, "panes cleared");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ============================================================================
// Section 9: findHaltrDir
// ============================================================================

console.log("\n--- findHaltrDir ---");

test("findHaltrDir: finds haltr/ from task path", () => {
  const dir = createTestDir();
  try {
    const taskPath = join(dir, "haltr", "task.yaml");
    writeFileSync(taskPath, "test: true");

    const haltrDir = findHaltrDir(taskPath);
    assertEqual(haltrDir, join(dir, "haltr"), "found haltr dir");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findHaltrDir: finds haltr/ from epic subdirectory", () => {
  const dir = createTestDir();
  try {
    const epicDir = join(dir, "haltr", "epics", "20260319-001_test");
    mkdirSync(epicDir, { recursive: true });
    const taskPath = join(epicDir, "001_task.yaml");
    writeFileSync(taskPath, "test: true");

    const haltrDir = findHaltrDir(taskPath);
    assertEqual(haltrDir, join(dir, "haltr"), "found haltr dir");
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
