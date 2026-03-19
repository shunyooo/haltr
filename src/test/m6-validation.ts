/**
 * CLI resolution and core spawn logic tests.
 *
 * Run with: npm run test:m6
 */

import {
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as yaml from "js-yaml";
import type { TaskYaml, ConfigYaml } from "../types.js";
import { resolveCli } from "../commands/spawn.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

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

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
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
      { at: "2026-01-01T00:01:00Z", type: "spec_reviewed" as const, by: "task-spec-reviewer(claude)" },
      { at: "2026-01-01T00:02:00Z", type: "execution_approved" as const, by: "orchestrator(claude)" },
    ],
    ...overrides,
  };
}

// ============================================================================
// CLI Resolution
// ============================================================================

console.log("--- CLI Resolution ---");

test("CLI resolution: --cli flag overrides everything", () => {
  const taskYaml = makeBaseTask();
  const config: ConfigYaml = {
    orchestrator_cli: "claude",
    watcher: { poll_interval: 30, inactivity_threshold: 300 },
    panes: { max_concurrent: 5 },
    retry: { max_attempts: 3 },
  };
  const cli = resolveCli("worker", taskYaml, config, "step-1", "codex");
  assertEqual(cli, "codex", "should use --cli override");
});

test("CLI resolution: worker uses task.agents.worker", () => {
  const taskYaml = makeBaseTask();
  const config: ConfigYaml = {
    orchestrator_cli: "claude",
    watcher: { poll_interval: 30, inactivity_threshold: 300 },
    panes: { max_concurrent: 5 },
    retry: { max_attempts: 3 },
  };
  // step-2 has no step-level agents, so falls back to task.agents.worker
  const cli = resolveCli("worker", taskYaml, config, "step-2");
  assertEqual(cli, "claude", "should use task.agents.worker");
});

test("CLI resolution: step.agents.worker overrides task level", () => {
  const taskYaml = makeBaseTask();
  const config: ConfigYaml = {
    orchestrator_cli: "claude",
    watcher: { poll_interval: 30, inactivity_threshold: 300 },
    panes: { max_concurrent: 5 },
    retry: { max_attempts: 3 },
  };
  // step-1 has agents: { worker: "gemini" }
  const cli = resolveCli("worker", taskYaml, config, "step-1");
  assertEqual(cli, "gemini", "should use step.agents.worker");
});

test("CLI resolution: accept[].verifier overrides (highest priority)", () => {
  const taskYaml = makeBaseTask();
  const config: ConfigYaml = {
    orchestrator_cli: "claude",
    watcher: { poll_interval: 30, inactivity_threshold: 300 },
    panes: { max_concurrent: 5 },
    retry: { max_attempts: 3 },
  };
  // accept "perf" has verifier: "gemini"
  const cli = resolveCli("verifier", taskYaml, config, "step-1", undefined, "perf");
  assertEqual(cli, "gemini", "should use accept[].verifier");
});

test("CLI resolution: orchestrator roles use config.orchestrator_cli", () => {
  const taskYaml = makeBaseTask();
  const config: ConfigYaml = {
    orchestrator_cli: "gemini",
    watcher: { poll_interval: 30, inactivity_threshold: 300 },
    panes: { max_concurrent: 5 },
    retry: { max_attempts: 3 },
  };
  for (const role of ["sub-orchestrator", "task-spec-reviewer"]) {
    const cli = resolveCli(role, taskYaml, config);
    assertEqual(cli, "gemini", `${role} uses orchestrator_cli`);
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
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
} else {
  console.log("\nAll tests passed!");
}
