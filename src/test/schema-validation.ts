/**
 * Schema Validation Test Script
 *
 * Verifies schema, types, and validation for haltr.
 * Run with: npm run test:schema
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import {
	findStep,
	validateStatusTransition,
} from "../lib/task-utils.js";
import {
	loadAndValidateTask,
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

const tmpDir = mkdtempSync(join(tmpdir(), "haltr-test-"));

// ============================================================================
// Section 1: Task Schema Validation
// ============================================================================
console.log("\n--- Task Schema Validation ---");

const fullTask = {
	id: "reference-quality",
	goal: "リファレンス品質改善",
	accept: ["Precision > 95%, Recall > 90%"],
	plan: "001_plan.md",
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

test("Full task.yaml validates successfully", () => {
	const result = validateTask(structuredClone(fullTask));
	assertEqual(result.id, "reference-quality", "id");
	assertEqual(result.goal, "リファレンス品質改善", "goal");
	assertEqual(result.plan, "001_plan.md", "plan");
});

test("Minimal task (id + goal only)", () => {
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
console.log("\n--- Task Schema Error Cases ---");

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

test("Invalid task status 'pivoted' -> error (not supported)", () => {
	const data = {
		id: "bad-status",
		goal: "Test",
		status: "pivoted",
	};
	expectThrows(() => validateTask(structuredClone(data)));
});

test("Invalid step status 'blocked' -> error (not supported)", () => {
	const data = {
		id: "bad-step-status",
		goal: "Test",
		steps: [{ id: "s1", goal: "step", status: "blocked" }],
	};
	expectThrows(() => validateTask(structuredClone(data)));
});

test("Invalid step status 'skipped' -> error (not supported)", () => {
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

test("'instructions' field on step -> error (use 'goal' instead)", () => {
	const data = {
		id: "test-step",
		goal: "Test",
		steps: [{ id: "s1", instructions: "do something" }],
	};
	expectThrows(() => validateTask(structuredClone(data)));
});

test("Nested steps -> error (not supported)", () => {
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

test("'previous' field -> error (not supported)", () => {
	const data = {
		id: "with-previous",
		goal: "Test",
		previous: "001_task.yaml",
	};
	expectThrows(() => validateTask(structuredClone(data)));
});

test("'worker_session' field -> error (not supported)", () => {
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
// Section 3: History Event Validation
// ============================================================================
console.log("\n--- History Event Validation ---");

const eventTypes = [
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

for (const eventType of eventTypes) {
	test(`History: ${eventType} event validates`, () => {
		const event: Record<string, unknown> = {
			at: "2026-03-22T10:00:00Z",
			type: eventType,
		};
		if (
			["step_added", "step_started", "step_done", "step_failed"].includes(
				eventType,
			)
		) {
			event.step = "s1";
		}
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
			},
		],
	};
	expectThrows(() => validateTask(structuredClone(data)));
});

test("History: event type 'work_done' -> error (not supported)", () => {
	const data = {
		id: "test-history",
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

test("History: event type 'pivoted' -> error (not supported)", () => {
	const data = {
		id: "test-history",
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

test("History: 'by' field is optional", () => {
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
// Section 4: File I/O
// ============================================================================
console.log("\n--- File I/O Tests ---");

test("loadAndValidateTask with YAML file", () => {
	const taskYaml = yaml.dump(fullTask);
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

// ============================================================================
// Section 5: Status Transitions
// ============================================================================
console.log("\n--- Status Transitions ---");

test("pending -> in_progress (valid)", () => {
	validateStatusTransition("pending", "in_progress");
});

test("in_progress -> done (valid)", () => {
	validateStatusTransition("in_progress", "done");
});

test("in_progress -> failed (valid)", () => {
	validateStatusTransition("in_progress", "failed");
});

test("failed -> in_progress (retry, valid)", () => {
	validateStatusTransition("failed", "in_progress");
});

test("pending -> done (invalid)", () => {
	expectThrows(() => validateStatusTransition("pending", "done"));
});

test("done -> in_progress (invalid)", () => {
	expectThrows(() => validateStatusTransition("done", "in_progress"));
});

test("pending -> failed (invalid)", () => {
	expectThrows(() => validateStatusTransition("pending", "failed"));
});

test("invalid status 'blocked' -> error", () => {
	expectThrows(() => validateStatusTransition("pending", "blocked"));
});

test("invalid status 'skipped' -> error", () => {
	expectThrows(() => validateStatusTransition("pending", "skipped"));
});

// ============================================================================
// Section 6: Task Utils
// ============================================================================
console.log("\n--- Task Utils ---");

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

// ============================================================================
// Section 7: All valid statuses
// ============================================================================
console.log("\n--- Valid Statuses ---");

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
