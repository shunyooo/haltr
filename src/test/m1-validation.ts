/**
 * M1 Validation Test Script
 *
 * Verifies all Definition-of-Done items for M1 (Project Scaffolding & Schema).
 * Run with: npm run test:m1
 */

import { execSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as yaml from "js-yaml";
import { validateTask, validateConfig, loadAndValidateTask, loadAndValidateConfig } from "../lib/validator.js";

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

function expectThrows(fn: () => void, containsMsg?: string): void {
  try {
    fn();
    throw new Error("Expected an error to be thrown, but none was");
  } catch (e: unknown) {
    if (e instanceof Error && e.message === "Expected an error to be thrown, but none was") {
      throw e;
    }
    if (containsMsg) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes(containsMsg)) {
        throw new Error(`Expected error containing "${containsMsg}", got: ${msg.split("\n")[0]}`);
      }
    }
  }
}

// Helper: create a temp dir for test files
const tmpDir = mkdtempSync(join(tmpdir(), "haltr-m1-test-"));

// ============================================================================
// Section 1: CLI Tests
// ============================================================================
console.log("\n--- CLI Tests ---");

test("hal --help shows subcommands", () => {
  const output = execSync("node dist/bin/hal.js --help", { cwd: "/workspaces/haltr", encoding: "utf-8" });
  const expectedCommands = [
    "init", "epic", "task", "history", "status", "check",
    "spawn", "start", "stop", "escalate", "kill", "panes",
    "rule", "hook"
  ];
  for (const cmd of expectedCommands) {
    if (!output.includes(cmd)) {
      throw new Error(`Missing subcommand "${cmd}" in --help output`);
    }
  }
});

test("hal --version shows version", () => {
  const output = execSync("node dist/bin/hal.js --version", { cwd: "/workspaces/haltr", encoding: "utf-8" });
  if (!output.trim().match(/^\d+\.\d+\.\d+$/)) {
    throw new Error(`Expected semver version, got: "${output.trim()}"`);
  }
});

// ============================================================================
// Section 2: Task Schema Validation
// ============================================================================
console.log("\n--- Task Schema Validation ---");

// Full sample task.yaml from design doc
const fullTaskData = {
  id: "implement-auth",
  status: "in_progress",
  previous: "001_task.yaml",
  agents: {
    worker: "claude",
    verifier: "codex",
  },
  steps: [
    {
      id: "step-1",
      instructions: "Build evaluation data and tune prompts",
      status: "done",
      steps: [
        {
          id: "data-collection",
          instructions: "Collect reference x generated image pairs from prd logs",
          accept: "data/pairs/ contains 100+ JSON files",
          status: "done",
        },
        {
          id: "vlm-judgment",
          instructions: "Run initial plagiarism judgment with VLM",
          status: "done",
        },
        {
          id: "annotation-ui",
          instructions: "Build annotation UI and share the URL",
          accept: [
            {
              id: "ui-check",
              type: "human" as const,
              check: "Verify the UI works correctly",
            },
          ],
          status: "done",
        },
      ],
    },
    {
      id: "step-2",
      instructions: "Optimize plagiarism detection prompt",
      status: "in_progress",
      steps: [
        {
          id: "plagiarism-prompt",
          instructions: "Create and tune plagiarism detection prompt",
          accept: "Precision > 95%, Recall > 90%",
          status: "in_progress",
        },
      ],
    },
    {
      id: "step-3",
      instructions: "Implement cheap quality filter",
      status: "pending",
      steps: [
        {
          id: "eval-data",
          instructions: "Build evaluation data",
          status: "pending",
        },
        {
          id: "prompt-tuning",
          instructions: "Optimize cheap detection prompt",
          status: "pending",
        },
      ],
    },
  ],
  history: [
    {
      at: "2026-03-16T14:00:00Z",
      type: "created",
      by: "orchestrator(claude)",
      message: "Reference quality improvement task created",
    },
    {
      at: "2026-03-16T14:50:00Z",
      type: "step_started",
      step: "step-1/data-collection",
      by: "orchestrator(claude)",
      attempt: 1,
    },
    {
      at: "2026-03-16T15:00:00Z",
      type: "work_done",
      step: "step-1/data-collection",
      by: "worker(claude)",
      attempt: 1,
      message: "Implemented fetch_pairs.py. Fetched 2 weeks of data from BQ and generated 152 JSON files in data/pairs/",
    },
    {
      at: "2026-03-16T15:05:00Z",
      type: "verifier_started",
      step: "step-1/data-collection",
      by: "orchestrator(claude)",
      attempt: 1,
      accept_id: "default",
    },
    {
      at: "2026-03-16T15:10:00Z",
      type: "verification_passed",
      step: "step-1/data-collection",
      by: "verifier(codex)",
      attempt: 1,
      accept_id: "default",
      message: "152 pairs collected (ls data/pairs/*.json | wc -l -> 152)",
    },
    {
      at: "2026-03-16T16:10:00Z",
      type: "verification_failed",
      step: "step-2/plagiarism-prompt",
      by: "verifier(codex)",
      attempt: 1,
      accept_id: "default",
      message: "Precision 89% (< 95%)",
    },
  ],
  context: "# Background\n\nReference search/build/selection logic issues.\n",
};

test("Full sample task.yaml validates successfully", () => {
  const result = validateTask(structuredClone(fullTaskData));
  if (result.id !== "implement-auth") {
    throw new Error(`Expected id "implement-auth", got "${result.id}"`);
  }
});

// Accept format tests
test("Accept as string shorthand", () => {
  const data = {
    id: "test-string-accept",
    agents: { worker: "claude", verifier: "codex" },
    steps: [
      {
        id: "s1",
        instructions: "test",
        accept: "npm test passes",
      },
    ],
  };
  const result = validateTask(structuredClone(data));
  // After validation, string should be expanded to array
  const step = result.steps[0];
  if (!Array.isArray(step.accept)) {
    throw new Error("Expected accept to be expanded to array");
  }
  const acceptArr = step.accept as Array<{ id: string; check: string }>;
  if (acceptArr[0].id !== "default" || acceptArr[0].check !== "npm test passes") {
    throw new Error("Accept string shorthand not expanded correctly");
  }
});

test("Accept as array with agent type (default)", () => {
  const data = {
    id: "test-array-accept",
    agents: { worker: "claude", verifier: "codex" },
    steps: [
      {
        id: "s1",
        instructions: "test",
        accept: [
          { id: "tests", check: "npm test exits 0" },
          { id: "quality", check: "code review passes", type: "agent" },
        ],
      },
    ],
  };
  validateTask(structuredClone(data));
});

test("Accept with human type requires instruction", () => {
  const data = {
    id: "test-human-accept",
    agents: { worker: "claude", verifier: "codex" },
    steps: [
      {
        id: "s1",
        instructions: "test",
        accept: [
          {
            id: "ux",
            type: "human",
            check: "Check the UI manually",
          },
        ],
      },
    ],
  };
  validateTask(structuredClone(data));
});

test("Accept human type without instruction fails", () => {
  const data = {
    id: "test-human-no-instruction",
    agents: { worker: "claude", verifier: "codex" },
    steps: [
      {
        id: "s1",
        instructions: "test",
        accept: [
          {
            id: "ux",
            type: "human",
            // missing instruction
          },
        ],
      },
    ],
  };
  expectThrows(() => validateTask(structuredClone(data)));
});

test("Accept mixed agent + human", () => {
  const data = {
    id: "test-mixed-accept",
    agents: { worker: "claude", verifier: "codex" },
    steps: [
      {
        id: "s1",
        instructions: "test",
        accept: [
          { id: "tests", check: "npm test exits 0" },
          { id: "visual", type: "human", check: "Check the dashboard" },
        ],
      },
    ],
  };
  validateTask(structuredClone(data));
});

test("Accept with verifier override", () => {
  const data = {
    id: "test-verifier-override",
    agents: { worker: "claude", verifier: "codex" },
    steps: [
      {
        id: "s1",
        instructions: "test",
        accept: [
          { id: "tests", check: "npm test exits 0", verifier: "codex" },
          { id: "quality", check: "SOLID principles check", verifier: "claude" },
          { id: "security", check: "Security review", verifier: "gemini" },
        ],
      },
    ],
  };
  validateTask(structuredClone(data));
});

// Nested steps
test("Nested steps validation (3 levels deep)", () => {
  const data = {
    id: "test-nested",
    agents: { worker: "claude", verifier: "codex" },
    steps: [
      {
        id: "level-1",
        instructions: "L1",
        steps: [
          {
            id: "level-2",
            instructions: "L2",
            steps: [
              {
                id: "level-3",
                instructions: "L3",
                accept: "deepest check passes",
              },
            ],
          },
        ],
      },
    ],
  };
  validateTask(structuredClone(data));
});

// step.agents override
test("Step-level agents override", () => {
  const data = {
    id: "test-step-agents",
    agents: { worker: "claude", verifier: "codex" },
    steps: [
      {
        id: "s1",
        instructions: "test",
        agents: { worker: "gemini", verifier: "claude" },
      },
    ],
  };
  validateTask(structuredClone(data));
});

// previous field
test("Previous field is optional and accepted", () => {
  const data = {
    id: "test-previous",
    previous: "001_task.yaml",
    agents: { worker: "claude", verifier: "codex" },
    steps: [{ id: "s1", instructions: "test" }],
  };
  validateTask(structuredClone(data));
});

// ============================================================================
// Section 3: Error Cases
// ============================================================================
console.log("\n--- Error Cases ---");

test("Missing agents.worker -> error", () => {
  const data = {
    id: "test-missing-worker",
    agents: { verifier: "codex" },
    steps: [{ id: "s1", instructions: "test" }],
  };
  expectThrows(() => validateTask(structuredClone(data)));
});

test("Missing agents.verifier -> error", () => {
  const data = {
    id: "test-missing-verifier",
    agents: { worker: "claude" },
    steps: [{ id: "s1", instructions: "test" }],
  };
  expectThrows(() => validateTask(structuredClone(data)));
});

test("Step status 'pivoted' -> error (invalid for steps)", () => {
  const data = {
    id: "test-step-pivoted",
    agents: { worker: "claude", verifier: "codex" },
    steps: [
      { id: "s1", instructions: "test", status: "pivoted" },
    ],
  };
  expectThrows(() => validateTask(structuredClone(data)));
});

test("Task status 'blocked' -> error (invalid for tasks)", () => {
  const data = {
    id: "test-task-blocked",
    status: "blocked",
    agents: { worker: "claude", verifier: "codex" },
    steps: [{ id: "s1", instructions: "test" }],
  };
  expectThrows(() => validateTask(structuredClone(data)));
});

test("Task status 'pivoted' -> PASS (valid for tasks)", () => {
  const data = {
    id: "test-task-pivoted",
    status: "pivoted",
    agents: { worker: "claude", verifier: "codex" },
    steps: [{ id: "s1", instructions: "test" }],
  };
  validateTask(structuredClone(data));
});

test("Step status 'skipped' -> PASS (valid for steps)", () => {
  const data = {
    id: "test-step-skipped",
    agents: { worker: "claude", verifier: "codex" },
    steps: [
      { id: "s1", instructions: "test", status: "skipped" },
    ],
  };
  validateTask(structuredClone(data));
});

test("Invalid status 'running' -> error", () => {
  const data = {
    id: "test-invalid-status",
    status: "running",
    agents: { worker: "claude", verifier: "codex" },
    steps: [{ id: "s1", instructions: "test" }],
  };
  expectThrows(() => validateTask(structuredClone(data)));
});

test("Missing step id -> error", () => {
  const data = {
    id: "test-missing-step-id",
    agents: { worker: "claude", verifier: "codex" },
    steps: [{ instructions: "test" }],
  };
  expectThrows(() => validateTask(structuredClone(data)));
});

test("Missing step instructions -> error", () => {
  const data = {
    id: "test-missing-step-instructions",
    agents: { worker: "claude", verifier: "codex" },
    steps: [{ id: "s1" }],
  };
  expectThrows(() => validateTask(structuredClone(data)));
});

// ============================================================================
// Section 4: File I/O (loadAndValidate*)
// ============================================================================
console.log("\n--- File I/O Tests ---");

test("loadAndValidateTask with YAML file", () => {
  const taskYaml = yaml.dump(fullTaskData);
  const filePath = join(tmpDir, "test-task.yaml");
  writeFileSync(filePath, taskYaml);
  const result = loadAndValidateTask(filePath);
  if (result.id !== "implement-auth") {
    throw new Error(`Expected id "implement-auth", got "${result.id}"`);
  }
});

test("loadAndValidateTask with invalid YAML -> error", () => {
  const filePath = join(tmpDir, "bad-task.yaml");
  writeFileSync(filePath, yaml.dump({
    id: "bad",
    // missing agents and steps
  }));
  expectThrows(() => loadAndValidateTask(filePath));
});

// ============================================================================
// Section 5: Config Schema Validation
// ============================================================================
console.log("\n--- Config Schema Validation ---");

const validConfig = {
  orchestrator_cli: "claude",
  watcher: {
    poll_interval: 30,
    inactivity_threshold: 300,
  },
  panes: {
    max_concurrent: 10,
  },
  retry: {
    max_attempts: 3,
  },
};

test("Valid config.yaml validates successfully", () => {
  const result = validateConfig(structuredClone(validConfig));
  if (result.orchestrator_cli !== "claude") {
    throw new Error(`Expected orchestrator_cli "claude", got "${result.orchestrator_cli}"`);
  }
});

test("loadAndValidateConfig with YAML file", () => {
  const configYaml = yaml.dump(validConfig);
  const filePath = join(tmpDir, "test-config.yaml");
  writeFileSync(filePath, configYaml);
  const result = loadAndValidateConfig(filePath);
  if (result.retry.max_attempts !== 3) {
    throw new Error(`Expected max_attempts 3, got ${result.retry.max_attempts}`);
  }
});

test("Config: orchestrator_cli must be string", () => {
  const data = { ...validConfig, orchestrator_cli: 123 };
  expectThrows(() => validateConfig(structuredClone(data)));
});

test("Config: retry.max_attempts must be positive integer", () => {
  const data = structuredClone(validConfig);
  (data.retry as any).max_attempts = 0;
  expectThrows(() => validateConfig(data));
});

test("Config: retry.max_attempts must be integer (not float)", () => {
  const data = structuredClone(validConfig);
  (data.retry as any).max_attempts = 1.5;
  expectThrows(() => validateConfig(data));
});

test("Config: watcher.poll_interval must be positive", () => {
  const data = structuredClone(validConfig);
  data.watcher.poll_interval = 0;
  expectThrows(() => validateConfig(data));
});

test("Config: watcher.inactivity_threshold must be positive", () => {
  const data = structuredClone(validConfig);
  data.watcher.inactivity_threshold = -1;
  expectThrows(() => validateConfig(data));
});

test("Config: panes.max_concurrent must be positive", () => {
  const data = structuredClone(validConfig);
  data.panes.max_concurrent = 0;
  expectThrows(() => validateConfig(data));
});

test("Config: missing orchestrator_cli -> error", () => {
  const { orchestrator_cli, ...rest } = validConfig;
  expectThrows(() => validateConfig(structuredClone(rest)));
});

// ============================================================================
// Section 6: History Event Validation
// ============================================================================
console.log("\n--- History Event Validation ---");

test("History: all event types in full task sample", () => {
  // Already validated in the full task test above, but let's explicitly check
  const result = validateTask(structuredClone(fullTaskData));
  if (!result.history || result.history.length !== 6) {
    throw new Error(`Expected 6 history events, got ${result.history?.length}`);
  }
  const types = result.history.map((e) => e.type);
  if (!types.includes("created")) throw new Error("Missing 'created' event");
  if (!types.includes("step_started")) throw new Error("Missing 'step_started' event");
  if (!types.includes("work_done")) throw new Error("Missing 'work_done' event");
  if (!types.includes("verifier_started")) throw new Error("Missing 'verifier_started' event");
  if (!types.includes("verification_passed")) throw new Error("Missing 'verification_passed' event");
  if (!types.includes("verification_failed")) throw new Error("Missing 'verification_failed' event");
});

test("History: escalation event", () => {
  const data = {
    id: "test-escalation",
    agents: { worker: "claude", verifier: "codex" },
    steps: [{ id: "s1", instructions: "test" }],
    history: [
      {
        at: "2026-03-16T14:00:00Z",
        type: "escalation",
        by: "worker(claude)",
        step: "s1",
        attempt: 1,
        message: "Cannot access the database",
      },
    ],
  };
  validateTask(structuredClone(data));
});

test("History: blocked_resolved event", () => {
  const data = {
    id: "test-blocked-resolved",
    agents: { worker: "claude", verifier: "codex" },
    steps: [{ id: "s1", instructions: "test" }],
    history: [
      {
        at: "2026-03-16T14:00:00Z",
        type: "blocked_resolved",
        by: "orchestrator(claude)",
        step: "s1",
        attempt: 1,
        message: "Database access granted",
      },
    ],
  };
  validateTask(structuredClone(data));
});

test("History: step_skipped event", () => {
  const data = {
    id: "test-step-skipped",
    agents: { worker: "claude", verifier: "codex" },
    steps: [{ id: "s1", instructions: "test" }],
    history: [
      {
        at: "2026-03-16T14:00:00Z",
        type: "step_skipped",
        by: "orchestrator(claude)",
        step: "s1",
        message: "Previous step failed",
      },
    ],
  };
  validateTask(structuredClone(data));
});

test("History: completed event", () => {
  const data = {
    id: "test-completed",
    agents: { worker: "claude", verifier: "codex" },
    steps: [{ id: "s1", instructions: "test" }],
    history: [
      {
        at: "2026-03-16T14:00:00Z",
        type: "completed",
        by: "orchestrator(claude)",
      },
    ],
  };
  validateTask(structuredClone(data));
});

test("History: pivoted event", () => {
  const data = {
    id: "test-pivoted",
    agents: { worker: "claude", verifier: "codex" },
    steps: [{ id: "s1", instructions: "test" }],
    history: [
      {
        at: "2026-03-16T14:00:00Z",
        type: "pivoted",
        by: "orchestrator(claude)",
        message: "Requirements changed",
        next_task: "004_task.yaml",
      },
    ],
  };
  validateTask(structuredClone(data));
});

test("History: updated event with diff", () => {
  const data = {
    id: "test-updated",
    agents: { worker: "claude", verifier: "codex" },
    steps: [{ id: "s1", instructions: "test" }],
    history: [
      {
        at: "2026-03-16T14:00:00Z",
        type: "updated",
        by: "orchestrator(claude)",
        diff: "added step-2",
      },
    ],
  };
  validateTask(structuredClone(data));
});

// ============================================================================
// Cleanup & Summary
// ============================================================================
rmSync(tmpDir, { recursive: true, force: true });

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
