/**
 * v2 Schema Validation Test Script
 *
 * Verifies schema, types, and validation for haltr v2.
 * Run with: npm run test:v2
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import {
	findStep,
	resolveTaskPath,
	validateStepTransition,
	validateTaskTransition,
} from "../lib/task-utils.js";
import {
	loadAndValidateConfig,
	loadAndValidateTask,
	validateConfig,
	validateTask,
} from "../lib/validator.js";

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
			`${label ? `${label}: ` : ""}Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
		);
	}
}

// Helper: create a temp dir for test files
const tmpDir = mkdtempSync(join(tmpdir(), "haltr-v2-test-"));

// ============================================================================
// Section 1: Task Schema Validation (v2)
// ============================================================================
console.log("\n--- v2 Task Schema Validation ---");

const fullV2Task = {
	id: "reference-quality",
	goal: "リファレンス品質改善",
	accept: ["Precision > 95%, Recall > 90%"],
	plan: "001_plan.md",
	notes: "001_notes.md",
	status: "in_progress",
	steps: [
		{
			id: "data-collection",
			goal: "データ収集",
			status: "done",
		},
		{
			id: "annotation-ui",
			goal: "アノテーション UI",
			accept: ["playwright で横並び表示を確認"],
			status: "pending",
		},
	],
	history: [
		{
			at: "2026-03-22T10:00:00Z",
			type: "created",
			message: "タスク作成",
		},
	],
};

test("Full v2 task.yaml validates successfully", () => {
	const result = validateTask(structuredClone(fullV2Task));
	assertEqual(result.id, "reference-quality", "id");
	assertEqual(result.goal, "リファレンス品質改善", "goal");
	assertEqual(result.plan, "001_plan.md", "plan");
	assertEqual(result.notes, "001_notes.md", "notes");
});

test("Minimal v2 task (id + goal only)", () => {
	const data = { id: "minimal", goal: "Do something" };
	const result = validateTask(structuredClone(data));
	assertEqual(result.id, "minimal");
	assertEqual(result.goal, "Do something");
});

test("Task with context field", () => {
	const data = {
		id: "with-context",
		goal: "Test context",
		context: "# Background\nSome context here",
	};
	validateTask(structuredClone(data));
});

test("Task with accept as single string", () => {
	const data = {
		id: "string-accept",
		goal: "Test accept string",
		accept: "npm test passes",
	};
	const result = validateTask(structuredClone(data));
	assertEqual(result.accept, "npm test passes");
});

test("Task with accept as string array", () => {
	const data = {
		id: "array-accept",
		goal: "Test accept array",
		accept: ["check 1", "check 2"],
	};
	const result = validateTask(structuredClone(data));
	if (!Array.isArray(result.accept) || result.accept.length !== 2) {
		throw new Error("Expected accept to be array of 2 strings");
	}
});

test("Step with accept as single string", () => {
	const data = {
		id: "step-string-accept",
		goal: "Test step accept",
		steps: [
			{
				id: "s1",
				goal: "step goal",
				accept: "npm test passes",
			},
		],
	};
	validateTask(structuredClone(data));
});

test("Step with accept as string array", () => {
	const data = {
		id: "step-array-accept",
		goal: "Test step accept array",
		steps: [
			{
				id: "s1",
				goal: "step goal",
				accept: ["check 1", "check 2"],
			},
		],
	};
	validateTask(structuredClone(data));
});

test("Task without steps is valid", () => {
	const data = {
		id: "no-steps",
		goal: "A task without steps",
		status: "pending",
	};
	validateTask(structuredClone(data));
});

// ============================================================================
// Section 2: Task Schema Error Cases
// ============================================================================
console.log("\n--- v2 Task Schema Error Cases ---");

test("Missing goal -> error", () => {
	const data = { id: "no-goal" };
	expectThrows(() => validateTask(structuredClone(data)));
});

test("Missing id -> error", () => {
	const data = { goal: "no id" };
	expectThrows(() => validateTask(structuredClone(data)));
});

test("Missing step goal -> error", () => {
	const data = {
		id: "bad-step",
		goal: "Test",
		steps: [{ id: "s1" }],
	};
	expectThrows(() => validateTask(structuredClone(data)));
});

test("Missing step id -> error", () => {
	const data = {
		id: "bad-step",
		goal: "Test",
		steps: [{ goal: "step goal" }],
	};
	expectThrows(() => validateTask(structuredClone(data)));
});

test("Invalid task status 'pivoted' -> error (removed in v2)", () => {
	const data = {
		id: "bad-status",
		goal: "Test",
		status: "pivoted",
	};
	expectThrows(() => validateTask(structuredClone(data)));
});

test("Invalid step status 'blocked' -> error (removed in v2)", () => {
	const data = {
		id: "bad-step-status",
		goal: "Test",
		steps: [{ id: "s1", goal: "step", status: "blocked" }],
	};
	expectThrows(() => validateTask(structuredClone(data)));
});

test("Invalid step status 'skipped' -> error (removed in v2)", () => {
	const data = {
		id: "bad-step-status",
		goal: "Test",
		steps: [{ id: "s1", goal: "step", status: "skipped" }],
	};
	expectThrows(() => validateTask(structuredClone(data)));
});

test("Invalid status 'running' -> error", () => {
	const data = {
		id: "bad-status",
		goal: "Test",
		status: "running",
	};
	expectThrows(() => validateTask(structuredClone(data)));
});

test("Unknown field at root -> error (additionalProperties: false)", () => {
	const data = {
		id: "extra",
		goal: "Test",
		agents: { worker: "claude", verifier: "codex" },
	};
	expectThrows(() => validateTask(structuredClone(data)));
});

test("v1 'instructions' field on step -> error (replaced by goal)", () => {
	const data = {
		id: "v1-step",
		goal: "Test",
		steps: [{ id: "s1", instructions: "do something" }],
	};
	expectThrows(() => validateTask(structuredClone(data)));
});

test("Nested steps -> error (removed in v2)", () => {
	const data = {
		id: "nested",
		goal: "Test",
		steps: [
			{
				id: "s1",
				goal: "outer",
				steps: [{ id: "s1a", goal: "inner" }],
			},
		],
	};
	expectThrows(() => validateTask(structuredClone(data)));
});

test("v1 'previous' field -> error (removed in v2)", () => {
	const data = {
		id: "with-previous",
		goal: "Test",
		previous: "001_task.yaml",
	};
	expectThrows(() => validateTask(structuredClone(data)));
});

test("v1 'worker_session' field -> error (removed in v2)", () => {
	const data = {
		id: "with-ws",
		goal: "Test",
		worker_session: "shared",
	};
	expectThrows(() => validateTask(structuredClone(data)));
});

test("Empty accept array -> error (minItems: 1)", () => {
	const data = {
		id: "empty-accept",
		goal: "Test",
		accept: [],
	};
	expectThrows(() => validateTask(structuredClone(data)));
});

// ============================================================================
// Section 3: History Event Validation (v2)
// ============================================================================
console.log("\n--- v2 History Event Validation ---");

const v2EventTypes = [
	"created",
	"updated",
	"step_added",
	"step_started",
	"step_done",
	"step_failed",
	"paused",
	"resumed",
	"completed",
	"user_feedback",
];

for (const eventType of v2EventTypes) {
	test(`History: ${eventType} event validates`, () => {
		const event: Record<string, unknown> = {
			at: "2026-03-22T10:00:00Z",
			type: eventType,
		};
		// Step events require step field
		if (
			["step_added", "step_started", "step_done", "step_failed"].includes(
				eventType,
			)
		) {
			event.step = "s1";
		}
		// All events can have optional message
		event.message = `Test ${eventType}`;

		const data = {
			id: "history-test",
			goal: "Test history",
			history: [event],
		};
		validateTask(structuredClone(data));
	});
}

test("History: step event without step field -> error", () => {
	const data = {
		id: "bad-history",
		goal: "Test",
		history: [
			{
				at: "2026-03-22T10:00:00Z",
				type: "step_started",
				// missing step field
			},
		],
	};
	expectThrows(() => validateTask(structuredClone(data)));
});

test("History: v1 event type 'work_done' -> error (removed in v2)", () => {
	const data = {
		id: "v1-history",
		goal: "Test",
		history: [
			{
				at: "2026-03-22T10:00:00Z",
				type: "work_done",
				by: "worker(claude)",
				step: "s1",
				attempt: 1,
			},
		],
	};
	expectThrows(() => validateTask(structuredClone(data)));
});

test("History: v1 event type 'pivoted' -> error (removed in v2)", () => {
	const data = {
		id: "v1-history",
		goal: "Test",
		history: [
			{
				at: "2026-03-22T10:00:00Z",
				type: "pivoted",
				by: "orchestrator(claude)",
			},
		],
	};
	expectThrows(() => validateTask(structuredClone(data)));
});

test("History: no 'by' field required in v2", () => {
	const data = {
		id: "no-by",
		goal: "Test",
		history: [
			{
				at: "2026-03-22T10:00:00Z",
				type: "created",
				message: "task created without by",
			},
		],
	};
	validateTask(structuredClone(data));
});

// ============================================================================
// Section 4: Config Schema Validation (v2)
// ============================================================================
console.log("\n--- v2 Config Schema Validation ---");

test("Empty config validates (all optional)", () => {
	const result = validateConfig({});
	if (result.timezone !== undefined) {
		throw new Error("Expected no timezone");
	}
});

test("Config with timezone only", () => {
	const result = validateConfig({ timezone: "Asia/Tokyo" });
	assertEqual(result.timezone, "Asia/Tokyo");
});

test("Config with haltr_dir only", () => {
	const result = validateConfig({ haltr_dir: "my-haltr" });
	assertEqual(result.haltr_dir, "my-haltr");
});

test("Config with both timezone and haltr_dir", () => {
	const result = validateConfig({
		timezone: "UTC",
		haltr_dir: "haltr",
	});
	assertEqual(result.timezone, "UTC");
	assertEqual(result.haltr_dir, "haltr");
});

test("Config: v1 orchestrator_cli -> error (removed in v2)", () => {
	expectThrows(() => validateConfig({ orchestrator_cli: "claude" }));
});

test("Config: v1 watcher -> error (removed in v2)", () => {
	expectThrows(
		() =>
			validateConfig({
				watcher: { poll_interval: 30, inactivity_threshold: 300 },
			}),
	);
});

test("Config: v1 panes -> error (removed in v2)", () => {
	expectThrows(() => validateConfig({ panes: { max_concurrent: 10 } }));
});

test("Config: v1 retry -> error (removed in v2)", () => {
	expectThrows(() => validateConfig({ retry: { max_attempts: 3 } }));
});

test("Config: unknown field -> error", () => {
	expectThrows(() => validateConfig({ unknown_field: "value" }));
});

// ============================================================================
// Section 5: File I/O (loadAndValidate*)
// ============================================================================
console.log("\n--- v2 File I/O Tests ---");

test("loadAndValidateTask with YAML file", () => {
	const taskYaml = yaml.dump(fullV2Task);
	const filePath = join(tmpDir, "test-task.yaml");
	writeFileSync(filePath, taskYaml);
	const result = loadAndValidateTask(filePath);
	assertEqual(result.id, "reference-quality");
	assertEqual(result.goal, "リファレンス品質改善");
});

test("loadAndValidateTask with invalid YAML -> error", () => {
	const filePath = join(tmpDir, "bad-task.yaml");
	writeFileSync(filePath, yaml.dump({ id: "bad" }));
	expectThrows(() => loadAndValidateTask(filePath));
});

test("loadAndValidateConfig with YAML file", () => {
	const configYaml = yaml.dump({ timezone: "Asia/Tokyo" });
	const filePath = join(tmpDir, "test-config.yaml");
	writeFileSync(filePath, configYaml);
	const result = loadAndValidateConfig(filePath);
	assertEqual(result.timezone, "Asia/Tokyo");
});

test("loadAndValidateConfig with empty YAML -> valid (v2 config is all optional)", () => {
	const filePath = join(tmpDir, "empty-config.yaml");
	writeFileSync(filePath, yaml.dump({}));
	loadAndValidateConfig(filePath);
});

// ============================================================================
// Section 6: Step Status Transitions (v2)
// ============================================================================
console.log("\n--- v2 Step Status Transitions ---");

test("Step: pending -> in_progress (valid)", () => {
	validateStepTransition("pending", "in_progress");
});

test("Step: in_progress -> done (valid)", () => {
	validateStepTransition("in_progress", "done");
});

test("Step: in_progress -> failed (valid)", () => {
	validateStepTransition("in_progress", "failed");
});

test("Step: failed -> in_progress (retry, valid)", () => {
	validateStepTransition("failed", "in_progress");
});

test("Step: pending -> done (invalid)", () => {
	expectThrows(() => validateStepTransition("pending", "done"));
});

test("Step: done -> in_progress (invalid)", () => {
	expectThrows(() => validateStepTransition("done", "in_progress"));
});

test("Step: pending -> failed (invalid)", () => {
	expectThrows(() => validateStepTransition("pending", "failed"));
});

test("Step: invalid status 'blocked' -> error (removed in v2)", () => {
	expectThrows(() => validateStepTransition("pending", "blocked"));
});

test("Step: invalid status 'skipped' -> error (removed in v2)", () => {
	expectThrows(() => validateStepTransition("pending", "skipped"));
});

// ============================================================================
// Section 7: Task Status Transitions (v2)
// ============================================================================
console.log("\n--- v2 Task Status Transitions ---");

test("Task: pending -> in_progress (valid)", () => {
	validateTaskTransition("pending", "in_progress");
});

test("Task: in_progress -> done (valid)", () => {
	validateTaskTransition("in_progress", "done");
});

test("Task: in_progress -> failed (valid)", () => {
	validateTaskTransition("in_progress", "failed");
});

test("Task: failed -> in_progress (retry, valid)", () => {
	validateTaskTransition("failed", "in_progress");
});

test("Task: pending -> done (invalid)", () => {
	expectThrows(() => validateTaskTransition("pending", "done"));
});

test("Task: done -> failed (invalid)", () => {
	expectThrows(() => validateTaskTransition("done", "failed"));
});

test("Task: invalid status 'pivoted' -> error (removed in v2)", () => {
	expectThrows(() => validateTaskTransition("pending", "pivoted"));
});

// ============================================================================
// Section 8: Task Utils (v2)
// ============================================================================
console.log("\n--- v2 Task Utils ---");

test("findStep finds step by id in flat array", () => {
	const steps = [
		{ id: "s1", goal: "step 1" },
		{ id: "s2", goal: "step 2" },
		{ id: "s3", goal: "step 3" },
	];
	const found = findStep(steps, "s2");
	if (!found || found.id !== "s2") {
		throw new Error(`Expected to find step s2, got ${found?.id}`);
	}
});

test("findStep returns undefined for missing step", () => {
	const steps = [{ id: "s1", goal: "step 1" }];
	const found = findStep(steps, "missing");
	if (found !== undefined) {
		throw new Error("Expected undefined for missing step");
	}
});

test("resolveTaskPath builds correct path", () => {
	const result = resolveTaskPath("my-session", "/project/haltr");
	if (!result.endsWith("/project/haltr/tasks/my-session/task.yaml")) {
		throw new Error(`Unexpected path: ${result}`);
	}
});

test("resolveTaskPath throws on empty session ID", () => {
	expectThrows(() => resolveTaskPath("", "/project/haltr"), "Session ID");
});

// ============================================================================
// Section 9: All valid task statuses
// ============================================================================
console.log("\n--- v2 Valid Statuses ---");

for (const status of ["pending", "in_progress", "done", "failed"]) {
	test(`Task status '${status}' is valid`, () => {
		const data = { id: "test", goal: "Test", status };
		validateTask(structuredClone(data));
	});
}

for (const status of ["pending", "in_progress", "done", "failed"]) {
	test(`Step status '${status}' is valid`, () => {
		const data = {
			id: "test",
			goal: "Test",
			steps: [{ id: "s1", goal: "step", status }],
		};
		validateTask(structuredClone(data));
	});
}

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
