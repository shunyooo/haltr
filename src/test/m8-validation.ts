/**
 * M8 Validation Test Script
 *
 * Verifies all Definition-of-Done items for M8 (Agent Definitions & Watcher).
 * Run with: npm run test:m8
 *
 * Tests:
 *   - Agent definition files (content, structure)
 *   - Hooks template files (content, placeholders)
 *   - PostToolUse Hook behavior (via guard-bash)
 *   - hal hook guard-bash
 *   - hal setup claude / codex
 *   - Watcher — pane crash detection (mock tmux)
 *   - Watcher — inactivity detection (mock)
 *   - Watcher — Stop Hook miss detection (mock)
 *   - Watcher — lifecycle (start/stop, PID file)
 *   - Watcher — notification only
 *   - hal init copies agent definitions + hooks templates
 */

import {
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as yaml from "js-yaml";
import type { ConfigYaml, TaskYaml } from "../types.js";
import { PanesManager, type PaneEntry } from "../lib/panes-manager.js";
import { guardBash } from "../commands/hook.js";
import { getAgentSettings } from "../lib/agent-defaults.js";

import { initHaltr } from "../commands/init.js";
import {
  Watcher,
  readWatcherPid,
  removeWatcherPid,
  type WatcherDeps,
  type WatcherNotification,
} from "../lib/watcher.js";

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

// ============================================================================
// Helpers
// ============================================================================

function createTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "haltr-m8-test-"));
  return dir;
}

function createHaltrDir(baseDir: string): string {
  // Use initHaltr to create a properly initialized haltr directory
  initHaltr(baseDir);
  return join(baseDir, "haltr");
}

const defaultConfig: ConfigYaml = {
  orchestrator_cli: "claude",
  watcher: { poll_interval: 1, inactivity_threshold: 5 },
  panes: { max_concurrent: 10 },
  retry: { max_attempts: 3 },
};

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

// ============================================================================
// Section 1: Agent Definition Files
// ============================================================================

console.log("\n--- Agent Definition Files ---");

test("getAgentSettings returns defaults for all 6 agent roles", () => {
  const dir = createTestDir();
  try {
    const haltrDir = createHaltrDir(dir);
    const agentRoles = [
      "main-orchestrator",
      "sub-orchestrator",
      "worker",
      "verifier",
      "task-spec-reviewer",
    ];

    for (const role of agentRoles) {
      const content = getAgentSettings(haltrDir, role);
      assert(content.length > 0, `Agent settings should exist for: ${role}`);
      const data = yaml.load(content) as any;
      assert(data !== null && typeof data === "object", `${role} should parse to object`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("each agent definition has hooks field", () => {
  const dir = createTestDir();
  try {
    const haltrDir = createHaltrDir(dir);
    const agentRoles = [
      "main-orchestrator",
      "sub-orchestrator",
      "worker",
      "verifier",
      "task-spec-reviewer",
    ];

    for (const role of agentRoles) {
      const content = getAgentSettings(haltrDir, role);
      const data = yaml.load(content) as any;
      assert(
        data.hooks !== undefined,
        `${role} should have hooks field`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("main-orchestrator.yaml has roles: [orchestrate, spec]", () => {
  const dir = createTestDir();
  try {
    const haltrDir = createHaltrDir(dir);
    const content = getAgentSettings(haltrDir, "main-orchestrator");
    const data = yaml.load(content) as any;
    assert(Array.isArray(data.roles), "roles should be array");
    assert(
      data.roles.includes("orchestrate"),
      "should include orchestrate",
    );
    assert(data.roles.includes("spec"), "should include spec");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task-spec-reviewer.yaml has review criteria in prompt", () => {
  const dir = createTestDir();
  try {
    const haltrDir = createHaltrDir(dir);
    const content = getAgentSettings(haltrDir, "task-spec-reviewer");
    const data = yaml.load(content) as any;
    assert(data.prompt, "should have prompt field");
    assert(data.prompt.includes("goal"), "prompt should mention goal");
    assert(data.prompt.includes("accept"), "prompt should mention accept");
    assert(data.prompt.includes("スコープ"), "prompt should mention scope");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker.yaml has roles: [implement]", () => {
  const dir = createTestDir();
  try {
    const haltrDir = createHaltrDir(dir);
    const content = getAgentSettings(haltrDir, "worker");
    const data = yaml.load(content) as any;
    assert(Array.isArray(data.roles), "roles should be array");
    assert(data.roles.includes("implement"), "should include implement");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifier.yaml has roles: [verify]", () => {
  const dir = createTestDir();
  try {
    const haltrDir = createHaltrDir(dir);
    const content = getAgentSettings(haltrDir, "verifier");
    const data = yaml.load(content) as any;
    assert(Array.isArray(data.roles), "roles should be array");
    assert(data.roles.includes("verify"), "should include verify");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker.yaml has roles: [implement]", () => {
  const dir = createTestDir();
  try {
    const haltrDir = createHaltrDir(dir);
    const content = getAgentSettings(haltrDir, "worker");
    const data = yaml.load(content) as any;
    assert(Array.isArray(data.roles), "roles should be array");
    assert(
      data.roles.includes("implement"),
      "should include implement",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Section 2: Hooks Template Files
// ============================================================================

console.log("\n--- Hooks Template Files ---");

test("main-orchestrator has Stop + disallowed_tools", () => {
  const dir = createTestDir();
  try {
    const haltrDir = createHaltrDir(dir);
    const content = getAgentSettings(haltrDir, "main-orchestrator");
    const data = yaml.load(content) as any;

    assert(data.hooks !== undefined, "hooks should exist");

    // Stop hook
    assert(data.hooks.Stop !== undefined, "Stop should exist");
    assert(Array.isArray(data.hooks.Stop), "Stop should be array");
    assert(
      data.hooks.Stop[0].command.includes("hal check"),
      "Stop should use hal check",
    );
    assert(
      data.hooks.Stop[0].command.includes("{{task}}"),
      "Stop should have {{task}} placeholder",
    );

    // disallowed_tools
    assert(Array.isArray(data.disallowed_tools), "disallowed_tools should be array");
    assert(
      data.disallowed_tools.includes("Edit"),
      "should disallow Edit",
    );
    assert(
      data.disallowed_tools.includes("Write"),
      "should disallow Write",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sub-orchestrator has hooks and disallowed_tools similar to main-orchestrator", () => {
  const dir = createTestDir();
  try {
    const haltrDir = createHaltrDir(dir);
    const content = getAgentSettings(haltrDir, "sub-orchestrator");
    const data = yaml.load(content) as any;

    assert(data.hooks !== undefined, "hooks should exist");
    assert(data.hooks.Stop !== undefined, "Stop should exist");

    assert(Array.isArray(data.disallowed_tools), "disallowed_tools should be array");
    assert(
      data.disallowed_tools.includes("Edit"),
      "should disallow Edit",
    );
    assert(
      data.disallowed_tools.includes("Write"),
      "should disallow Write",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker has Stop hook with {{task}} and {{step}} placeholders", () => {
  const dir = createTestDir();
  try {
    const haltrDir = createHaltrDir(dir);
    const content = getAgentSettings(haltrDir, "worker");
    const data = yaml.load(content) as any;

    assert(data.hooks !== undefined, "hooks should exist");
    assert(data.hooks.Stop !== undefined, "Stop should exist");
    assert(Array.isArray(data.hooks.Stop), "Stop should be array");

    const stopCmd = data.hooks.Stop[0].command;
    assert(stopCmd.includes("{{task}}"), "should have {{task}}");
    assert(stopCmd.includes("{{step}}"), "should have {{step}}");
    assert(stopCmd.includes("--worker"), "should have --worker flag");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifier has Stop hook with {{task}} and {{step}} placeholders", () => {
  const dir = createTestDir();
  try {
    const haltrDir = createHaltrDir(dir);
    const content = getAgentSettings(haltrDir, "verifier");
    const data = yaml.load(content) as any;

    assert(data.hooks !== undefined, "hooks should exist");
    assert(data.hooks.Stop !== undefined, "Stop should exist");

    const stopCmd = data.hooks.Stop[0].command;
    assert(stopCmd.includes("{{task}}"), "should have {{task}}");
    assert(stopCmd.includes("{{step}}"), "should have {{step}}");
    assert(stopCmd.includes("--verifier"), "should have --verifier flag");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task-spec-reviewer has hooks section", () => {
  const dir = createTestDir();
  try {
    const haltrDir = createHaltrDir(dir);
    const content = getAgentSettings(haltrDir, "task-spec-reviewer");
    const data = yaml.load(content) as any;
    assert(data.hooks !== undefined, "hooks should exist");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


// ============================================================================
// Section 3: hal hook guard-bash
// ============================================================================

console.log("\n--- hal hook guard-bash ---");

test("guard-bash: hal command -> allowed", () => {
  const result = guardBash("hal status step-1 done");
  assertEqual(result.allowed, true, "should be allowed");
});

test("guard-bash: non-hal command -> blocked with message", () => {
  const result = guardBash("ls -la");
  assertEqual(result.allowed, false, "should be blocked");
  assert(result.message !== undefined, "should have message");
  assert(
    result.message!.includes("hal コマンド以外"),
    "message should mention restriction",
  );
});

test("guard-bash: hal status ... && echo done -> blocked (echo is not hal)", () => {
  const result = guardBash("hal status step-1 done && echo done");
  assertEqual(result.allowed, false, "should be blocked (echo is not hal)");
});

test("guard-bash: hal spawn worker ... -> allowed", () => {
  const result = guardBash("hal spawn worker --task task.yaml --step step-1");
  assertEqual(result.allowed, true, "should be allowed");
});

test("guard-bash: empty command -> blocked", () => {
  const result = guardBash("");
  assertEqual(result.allowed, false, "should be blocked");
});

test("guard-bash: chained non-hal command -> blocked", () => {
  const result = guardBash("npm test && hal check");
  assertEqual(result.allowed, false, "should be blocked (first command is npm)");
});

test("guard-bash: hal with pipe to non-hal -> blocked", () => {
  const result = guardBash("hal panes | grep worker");
  assertEqual(result.allowed, false, "should be blocked (grep is not hal)");
});

test("guard-bash: hal with pipe to hal -> allowed", () => {
  const result = guardBash("hal panes | hal status task done");
  assertEqual(result.allowed, true, "should be allowed (all commands are hal)");
});

test("guard-bash: hal && hal -> allowed", () => {
  const result = guardBash("hal status step-1 done && hal check --worker --task t.yaml --step s");
  assertEqual(result.allowed, true, "should be allowed (all commands are hal)");
});

test("guard-bash: subshell $(...) -> blocked", () => {
  const result = guardBash("hal spawn --task $(rm -rf /)");
  assertEqual(result.allowed, false, "should be blocked (subshell)");
  assert(
    result.message!.includes("サブシェル"),
    "message should mention subshell restriction",
  );
});

test("guard-bash: backtick subshell -> blocked", () => {
  const result = guardBash("hal spawn --task `cat /etc/passwd`");
  assertEqual(result.allowed, false, "should be blocked (backtick)");
  assert(
    result.message!.includes("バッククォート"),
    "message should mention backtick restriction",
  );
});

test("guard-bash: redirect > -> blocked", () => {
  const result = guardBash("hal status step-1 done > /tmp/output");
  assertEqual(result.allowed, false, "should be blocked (redirect)");
  assert(
    result.message!.includes("リダイレクト"),
    "message should mention redirect restriction",
  );
});

test("guard-bash: redirect < -> blocked", () => {
  const result = guardBash("hal spawn worker < /tmp/input");
  assertEqual(result.allowed, false, "should be blocked (redirect)");
});

test("guard-bash: nested subshell in chained command -> blocked", () => {
  const result = guardBash("hal status step-1 done && hal spawn --task $(whoami)");
  assertEqual(result.allowed, false, "should be blocked (subshell in chain)");
});

// ============================================================================
// Section 4: PostToolUse Hook behavior (via check.ts logic)
// ============================================================================

console.log("\n--- PostToolUse Hook behavior ---");

test("orchestrator Edit -> blocked via disallowed_tools", () => {
  const dir = createTestDir();
  try {
    const haltrDir = createHaltrDir(dir);
    const content = getAgentSettings(haltrDir, "main-orchestrator");
    const data = yaml.load(content) as any;
    assert(Array.isArray(data.disallowed_tools), "disallowed_tools should be array");
    assert(
      data.disallowed_tools.includes("Edit"),
      "Edit should be in disallowed_tools",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("orchestrator Write -> blocked via disallowed_tools", () => {
  const dir = createTestDir();
  try {
    const haltrDir = createHaltrDir(dir);
    const content = getAgentSettings(haltrDir, "main-orchestrator");
    const data = yaml.load(content) as any;
    assert(Array.isArray(data.disallowed_tools), "disallowed_tools should be array");
    assert(
      data.disallowed_tools.includes("Write"),
      "Write should be in disallowed_tools",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("orchestrator Bash `hal status step-1 done` -> allowed", () => {
  const result = guardBash("hal status step-1 done");
  assertEqual(result.allowed, true, "hal command should be allowed");
});

test("orchestrator Bash `ls -la` -> blocked", () => {
  const result = guardBash("ls -la");
  assertEqual(result.allowed, false, "non-hal command should be blocked");
});

test("orchestrator Bash `hal spawn worker ...` -> allowed", () => {
  const result = guardBash("hal spawn worker --task t.yaml --step step-1");
  assertEqual(result.allowed, true, "hal spawn should be allowed");
});

// ============================================================================
// Section 5: Watcher — Pane crash detection
// ============================================================================

console.log("\n--- Watcher: Pane crash detection ---");

await testAsync(
  "watcher: dead pane detected -> parent notified",
  async () => {
    const dir = createTestDir();
    try {
      const haltrDir = join(dir, "haltr");
      mkdirSync(haltrDir, { recursive: true });

      const pm = new PanesManager(dir);
      pm.add({
        pane_id: "%3",
        step: "step-1",
        role: "worker",
        parent_pane_id: "%0",
        cli: "claude",
        task_path: "task.yaml",
      });

      // Mock: %3 is NOT alive
      const { deps, sendKeysCalls } = createMockWatcherDeps([]);

      const watcher = new Watcher(defaultConfig, haltrDir, dir, deps);
      await watcher.poll();

      // Should have sent notification to parent (%0)
      assert(sendKeysCalls.length >= 1, "should send notification");
      assertEqual(sendKeysCalls[0].paneId, "%0", "should notify parent");
      assert(
        sendKeysCalls[0].text.includes("クラッシュ"),
        "message should mention crash",
      );

      // Watcher is notification-only: dead entry should NOT be removed
      // from .panes.yaml (orchestrator handles cleanup)
      const remaining = pm.load();
      assertEqual(remaining.length, 1, "dead entry should NOT be removed by watcher");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

await testAsync(
  "watcher: main-orchestrator crash -> no notification (no parent)",
  async () => {
    const dir = createTestDir();
    try {
      const haltrDir = join(dir, "haltr");
      mkdirSync(haltrDir, { recursive: true });

      const pm = new PanesManager(dir);
      pm.add({
        pane_id: "%0",
        step: "",
        role: "main-orchestrator",
        parent_pane_id: "",
        cli: "claude",
        task_path: "task.yaml",
      });

      // Mock: %0 is NOT alive
      const { deps, sendKeysCalls } = createMockWatcherDeps([]);

      const watcher = new Watcher(defaultConfig, haltrDir, dir, deps);
      await watcher.poll();

      // Should NOT have sent any notification (no parent for main-orch)
      assertEqual(
        sendKeysCalls.length,
        0,
        "should not notify for main-orch crash",
      );

      // Watcher is notification-only: dead entry should NOT be removed
      // from .panes.yaml (orchestrator handles cleanup)
      const remaining = pm.load();
      assertEqual(remaining.length, 1, "dead entry should NOT be removed by watcher");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

await testAsync(
  "watcher: dead entry NOT removed from .panes.yaml (notification only)",
  async () => {
    const dir = createTestDir();
    try {
      const haltrDir = join(dir, "haltr");
      mkdirSync(haltrDir, { recursive: true });

      const pm = new PanesManager(dir);
      pm.add({
        pane_id: "%3",
        step: "step-1",
        role: "worker",
        parent_pane_id: "%0",
        cli: "claude",
        task_path: "task.yaml",
      });
      pm.add({
        pane_id: "%4",
        step: "step-2",
        role: "worker",
        parent_pane_id: "%0",
        cli: "claude",
        task_path: "task.yaml",
      });

      // Mock: only %4 is alive, %3 is dead
      const { deps } = createMockWatcherDeps(["%4"]);

      const watcher = new Watcher(defaultConfig, haltrDir, dir, deps);
      await watcher.poll();

      // Watcher is notification-only: .panes.yaml should be untouched
      const remaining = pm.load();
      assertEqual(remaining.length, 2, "both entries should remain (watcher does not modify .panes.yaml)");

      // But watcher should still have generated crash notification
      const notifications = watcher.getNotifications();
      const crashNotif = notifications.find((n) => n.type === "crash" && n.paneId === "%3");
      assert(crashNotif !== undefined, "should have crash notification for dead pane");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ============================================================================
// Section 7: Watcher — Inactivity detection
// ============================================================================

console.log("\n--- Watcher: Inactivity detection ---");

await testAsync(
  "watcher: inactivity threshold exceeded -> notification sent",
  async () => {
    const dir = createTestDir();
    try {
      const haltrDir = join(dir, "haltr");
      mkdirSync(haltrDir, { recursive: true });

      const pm = new PanesManager(dir);
      pm.add({
        pane_id: "%3",
        step: "step-1",
        role: "worker",
        parent_pane_id: "%0",
        cli: "claude",
        task_path: "task.yaml",
      });

      // Config with very short inactivity threshold (1ms = 0.001s)
      const shortConfig: ConfigYaml = {
        ...defaultConfig,
        watcher: { poll_interval: 1, inactivity_threshold: 0.001 },
      };

      // Mock: %3 is alive
      const { deps, sendKeysCalls } = createMockWatcherDeps(["%3"]);

      const watcher = new Watcher(shortConfig, haltrDir, dir, deps);

      // First poll — initializes lastAlive
      await watcher.poll();

      // Wait for threshold to pass
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Second poll — should detect inactivity
      await watcher.poll();

      const notifications = watcher.getNotifications();
      const inactivityNotif = notifications.find(
        (n) => n.type === "inactivity",
      );
      assert(
        inactivityNotif !== undefined,
        "should have inactivity notification",
      );
      assert(
        inactivityNotif!.message.includes("無活動"),
        "message should mention inactivity",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ============================================================================
// Section 8: Watcher — Stop Hook miss detection
// ============================================================================

console.log("\n--- Watcher: Stop Hook miss detection ---");

await testAsync(
  "watcher: pane ended without check notification -> parent notified",
  async () => {
    const dir = createTestDir();
    try {
      const haltrDir = join(dir, "haltr");
      mkdirSync(haltrDir, { recursive: true });

      const pm = new PanesManager(dir);
      pm.add({
        pane_id: "%3",
        step: "step-1",
        role: "worker",
        parent_pane_id: "%0",
        cli: "claude",
        task_path: "task.yaml",
      });

      // Mock: %3 is NOT alive (died without check)
      const { deps, sendKeysCalls } = createMockWatcherDeps([]);

      const watcher = new Watcher(defaultConfig, haltrDir, dir, deps);
      await watcher.poll();

      const notifications = watcher.getNotifications();
      const missNotif = notifications.find(
        (n) => n.type === "stop_hook_miss",
      );
      assert(
        missNotif !== undefined,
        "should have stop_hook_miss notification",
      );
      assert(
        missNotif!.message.includes("通知がありません"),
        "message should mention missing notification",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ============================================================================
// Section 9: Watcher — Lifecycle
// ============================================================================

console.log("\n--- Watcher: Lifecycle ---");

test("watcher: start writes PID file", () => {
  const dir = createTestDir();
  try {
    const haltrDir = join(dir, "haltr");
    mkdirSync(haltrDir, { recursive: true });

    const { deps } = createMockWatcherDeps([]);
    const watcher = new Watcher(defaultConfig, haltrDir, dir, deps);

    watcher.start();
    assert(watcher.isRunning(), "watcher should be running");

    // PID file should exist
    const pid = readWatcherPid(haltrDir);
    assert(pid !== undefined, "PID file should exist");
    assertEqual(pid, process.pid, "PID should match current process");

    watcher.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watcher: stop clears PID file", () => {
  const dir = createTestDir();
  try {
    const haltrDir = join(dir, "haltr");
    mkdirSync(haltrDir, { recursive: true });

    const { deps } = createMockWatcherDeps([]);
    const watcher = new Watcher(defaultConfig, haltrDir, dir, deps);

    watcher.start();
    watcher.stop();

    assert(!watcher.isRunning(), "watcher should be stopped");

    // PID file should be gone
    const pid = readWatcherPid(haltrDir);
    assertEqual(pid, undefined, "PID file should be removed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watcher: config changes reflected via new Watcher instance", () => {
  const dir = createTestDir();
  try {
    const haltrDir = join(dir, "haltr");
    mkdirSync(haltrDir, { recursive: true });

    const { deps } = createMockWatcherDeps([]);

    const config1: ConfigYaml = {
      ...defaultConfig,
      watcher: { poll_interval: 10, inactivity_threshold: 100 },
    };
    const watcher1 = new Watcher(config1, haltrDir, dir, deps);
    watcher1.start();
    watcher1.stop();

    // New config
    const config2: ConfigYaml = {
      ...defaultConfig,
      watcher: { poll_interval: 5, inactivity_threshold: 50 },
    };
    const watcher2 = new Watcher(config2, haltrDir, dir, deps);
    watcher2.start();
    assert(watcher2.isRunning(), "new watcher should be running");
    watcher2.stop();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("watcher: removeWatcherPid works on missing file", () => {
  const dir = createTestDir();
  try {
    const haltrDir = join(dir, "haltr");
    mkdirSync(haltrDir, { recursive: true });

    // Should not throw
    removeWatcherPid(haltrDir);
    const pid = readWatcherPid(haltrDir);
    assertEqual(pid, undefined, "should be undefined");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ============================================================================
// Section 10: Watcher — Notification only
// ============================================================================

console.log("\n--- Watcher: Notification only ---");

await testAsync(
  "watcher: never kills/respawns/modifies tasks (only notifies)",
  async () => {
    const dir = createTestDir();
    try {
      const haltrDir = join(dir, "haltr");
      mkdirSync(haltrDir, { recursive: true });

      // Create a task file to ensure watcher doesn't modify it
      const taskPath = join(haltrDir, "task.yaml");
      const taskContent = "id: test\nstatus: in_progress\n";
      writeFileSync(taskPath, taskContent, "utf-8");

      const pm = new PanesManager(dir);
      pm.add({
        pane_id: "%3",
        step: "step-1",
        role: "worker",
        parent_pane_id: "%0",
        cli: "claude",
        task_path: taskPath,
      });
      pm.add({
        pane_id: "%4",
        step: "step-2",
        role: "verifier",
        parent_pane_id: "%0",
        cli: "codex",
        task_path: taskPath,
      });

      // All panes dead
      const { deps, sendKeysCalls } = createMockWatcherDeps([]);

      const watcher = new Watcher(defaultConfig, haltrDir, dir, deps);
      await watcher.poll();

      // Task file should be unmodified
      const taskAfter = readFileSync(taskPath, "utf-8");
      assertEqual(
        taskAfter,
        taskContent,
        "task file should not be modified by watcher",
      );

      // Watcher only sent notifications, didn't kill anything
      // (it uses sendKeys, not killPane)
      for (const call of sendKeysCalls) {
        assert(
          typeof call.paneId === "string" && call.paneId.length > 0,
          "notifications should target a pane",
        );
        assert(
          typeof call.text === "string" && call.text.length > 0,
          "notifications should have text",
        );
      }

      // Notifications were generated
      const notifications = watcher.getNotifications();
      assert(
        notifications.length > 0,
        "should have generated notifications",
      );

      // Verify all notifications are only of notify types
      for (const n of notifications) {
        assert(
          ["crash", "inactivity", "stop_hook_miss"].includes(n.type),
          `notification type should be valid: ${n.type}`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ============================================================================
// Section 11: hal init integration (agent definitions + hooks templates)
// ============================================================================

console.log("\n--- hal init integration ---");

test("getAgentSettings returns agent definitions with hooks sections", () => {
  const dir = createTestDir();
  try {
    initHaltr(dir);
    const haltrDir = join(dir, "haltr");

    // Agent definitions should be available via getAgentSettings
    const agentRoles = [
      "main-orchestrator",
      "sub-orchestrator",
      "worker",
      "verifier",
      "task-spec-reviewer",
    ];
    for (const role of agentRoles) {
      const content = getAgentSettings(haltrDir, role);
      const data = yaml.load(content) as any;
      assert(
        data.hooks !== undefined,
        `${role} should have hooks section`,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent definitions have correct content (not empty placeholders)", () => {
  const dir = createTestDir();
  try {
    initHaltr(dir);
    const haltrDir = join(dir, "haltr");

    // Worker should have roles: [implement]
    const workerContent = getAgentSettings(haltrDir, "worker");
    const workerData = yaml.load(workerContent) as any;
    assert(
      Array.isArray(workerData.roles),
      "worker should have roles array",
    );
    assert(
      workerData.roles.includes("implement"),
      "worker should have implement role",
    );

    // Main orchestrator should have Stop hooks and disallowed_tools
    const orchContent = getAgentSettings(haltrDir, "main-orchestrator");
    const orchData = yaml.load(orchContent) as any;
    assert(
      orchData.hooks.Stop !== undefined,
      "main-orch should have Stop hooks",
    );
    assert(
      Array.isArray(orchData.disallowed_tools),
      "main-orch should have disallowed_tools array",
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
