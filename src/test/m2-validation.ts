/**
 * M2 Validation Test Script
 *
 * Verifies all Definition-of-Done items for M2 (Directory Operations & Task Management).
 * Run with: npm run test:m2
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { createEpic } from "../commands/epic.js";
import { initHaltr } from "../commands/init.js";
import { createTask, editTask } from "../commands/task.js";
import type { ConfigYaml, TaskYaml } from "../types.js";

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

function assert(condition: boolean, message: string): void {
	if (!condition) {
		throw new Error(message);
	}
}

// ============================================================================
// Section 1: hal init
// ============================================================================
console.log("\n--- hal init ---");

test("hal init creates haltr/ with all required files and directories", () => {
	const tmp = mkdtempSync(join(tmpdir(), "haltr-m2-init-"));
	try {
		initHaltr(tmp);

		const haltrDir = join(tmp, "haltr");
		assert(existsSync(haltrDir), "haltr/ directory not created");
		assert(
			existsSync(join(haltrDir, "config.yaml")),
			"config.yaml not created",
		);
		assert(existsSync(join(haltrDir, "rules.md")), "rules.md not created");
		assert(existsSync(join(haltrDir, "epics")), "epics/ not created");
		assert(existsSync(join(haltrDir, "decisions")), "decisions/ not created");

		// Validate config.yaml content
		const configContent = readFileSync(join(haltrDir, "config.yaml"), "utf-8");
		const config = yaml.load(configContent) as ConfigYaml;
		assert(
			config.orchestrator_cli === "claude:sonnet",
			"config.orchestrator_cli should be 'claude:sonnet'",
		);
		assert(
			config.watcher.poll_interval === 30,
			"config.watcher.poll_interval should be 30",
		);
		assert(
			config.watcher.inactivity_threshold === 300,
			"config.watcher.inactivity_threshold should be 300",
		);
		assert(
			config.panes.max_concurrent === 10,
			"config.panes.max_concurrent should be 10",
		);
		assert(
			config.retry.max_attempts === 3,
			"config.retry.max_attempts should be 3",
		);

		// Check rules.md content
		const rulesContent = readFileSync(join(haltrDir, "rules.md"), "utf-8");
		assert(rulesContent.includes("# Rules"), "rules.md should have header");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("hal init when haltr/ already exists -> error", () => {
	const tmp = mkdtempSync(join(tmpdir(), "haltr-m2-init-exists-"));
	try {
		initHaltr(tmp);

		// Second init should throw
		let threw = false;
		try {
			initHaltr(tmp);
		} catch (e: unknown) {
			threw = true;
			const msg = e instanceof Error ? e.message : String(e);
			assert(
				msg.includes("already exists"),
				`Expected 'already exists' in error, got: ${msg}`,
			);
		}
		assert(threw, "Expected error when haltr/ already exists");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

// ============================================================================
// Section 2: hal epic create
// ============================================================================
console.log("\n--- hal epic create ---");

test("hal epic create creates dated directory with 001 index", () => {
	const tmp = mkdtempSync(join(tmpdir(), "haltr-m2-epic-"));
	try {
		initHaltr(tmp);

		const testDate = new Date(2026, 2, 19); // 2026-03-19
		const epicPath = createEpic(tmp, "implement-auth", testDate);

		assert(existsSync(epicPath), "Epic directory not created");
		assert(
			epicPath.includes("20260319-001_implement-auth"),
			`Expected directory name with 20260319-001_implement-auth, got: ${epicPath}`,
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("Second epic same day -> 002 index", () => {
	const tmp = mkdtempSync(join(tmpdir(), "haltr-m2-epic-seq-"));
	try {
		initHaltr(tmp);

		const testDate = new Date(2026, 2, 19);
		createEpic(tmp, "implement-auth", testDate);
		const secondPath = createEpic(tmp, "add-logging", testDate);

		assert(
			secondPath.includes("20260319-002_add-logging"),
			`Expected 002 index, got: ${secondPath}`,
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("Epic create without init -> error", () => {
	const tmp = mkdtempSync(join(tmpdir(), "haltr-m2-epic-noinit-"));
	try {
		let threw = false;
		try {
			createEpic(tmp, "test-epic");
		} catch {
			threw = true;
		}
		assert(threw, "Expected error when haltr/epics/ doesn't exist");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

// ============================================================================
// Section 3: hal task new
// ============================================================================
console.log("\n--- hal task new ---");

test("hal task new creates 001_task.yaml with created event and status: pending", () => {
	const tmp = mkdtempSync(join(tmpdir(), "haltr-m2-task-"));
	try {
		initHaltr(tmp);
		const testDate = new Date(2026, 2, 19);
		createEpic(tmp, "implement-auth", testDate);

		const taskPath = createTask(tmp, "implement-auth");

		assert(existsSync(taskPath), "Task file not created");
		assert(
			taskPath.endsWith("001_task.yaml"),
			`Expected 001_task.yaml, got: ${taskPath}`,
		);

		const content = readFileSync(taskPath, "utf-8");
		const task = yaml.load(content) as TaskYaml;

		assert(
			task.id === "implement-auth",
			`Expected id 'implement-auth', got '${task.id}'`,
		);
		assert(
			task.status === "pending",
			`Expected status 'pending', got '${task.status}'`,
		);
		assert(
			task.agents?.worker === "claude:sonnet",
			"Expected worker 'claude:sonnet'",
		);
		assert(
			task.agents?.verifier === "claude:haiku",
			"Expected verifier 'claude:haiku'",
		);
		assert(
			Array.isArray(task.steps) && task.steps.length === 0,
			"Expected empty steps array",
		);
		assert(task.context === "", "Expected empty context string");
		assert(
			Array.isArray(task.history) && task.history.length === 1,
			"Expected 1 history event",
		);
		assert(task.history![0].type === "created", "Expected created event");
		assert(
			task.history![0].by.startsWith("orchestrator("),
			"Expected by orchestrator(...)",
		);
		assert(
			(task.history![0] as any).message === "Task created",
			"Expected note 'Task created'",
		);
		assert(!task.previous, "First task should not have previous field");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("Second hal task new -> 002_task.yaml, old gets pivoted event + pivoted status, new has previous field", () => {
	const tmp = mkdtempSync(join(tmpdir(), "haltr-m2-task-pivot-"));
	try {
		initHaltr(tmp);
		const testDate = new Date(2026, 2, 19);
		createEpic(tmp, "implement-auth", testDate);

		const firstPath = createTask(tmp, "implement-auth");
		const secondPath = createTask(tmp, "implement-auth");

		assert(
			secondPath.endsWith("002_task.yaml"),
			`Expected 002_task.yaml, got: ${secondPath}`,
		);

		// Check the old task
		const oldContent = readFileSync(firstPath, "utf-8");
		const oldTask = yaml.load(oldContent) as TaskYaml;
		assert(
			oldTask.status === "pivoted",
			`Expected old task status 'pivoted', got '${oldTask.status}'`,
		);

		const pivotedEvents = oldTask.history!.filter((e) => e.type === "pivoted");
		assert(pivotedEvents.length === 1, "Expected 1 pivoted event in old task");
		assert(
			(pivotedEvents[0] as any).next_task === "002_task.yaml",
			"Expected pivoted event to reference 002_task.yaml",
		);
		assert(
			(pivotedEvents[0] as any).message === "New task created",
			"Expected pivoted reason 'New task created'",
		);

		// Check the new task
		const newContent = readFileSync(secondPath, "utf-8");
		const newTask = yaml.load(newContent) as TaskYaml;
		assert(
			newTask.previous === "001_task.yaml",
			`Expected previous '001_task.yaml', got '${newTask.previous}'`,
		);
		assert(
			newTask.status === "pending",
			`Expected new task status 'pending', got '${newTask.status}'`,
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("Gap handling: if 001_task.yaml and 003_report.md exist -> next is 004_task.yaml", () => {
	const tmp = mkdtempSync(join(tmpdir(), "haltr-m2-task-gap-"));
	try {
		initHaltr(tmp);
		const testDate = new Date(2026, 2, 19);
		const epicPath = createEpic(tmp, "implement-auth", testDate);

		// Create 001_task.yaml with valid content
		const task001: TaskYaml = {
			id: "implement-auth",
			status: "pending",
			agents: { worker: "claude", verifier: "codex" },
			steps: [],
			context: "",
			history: [
				{
					at: new Date().toISOString(),
					type: "created",
					by: "orchestrator(claude)",
					message: "Task created",
				},
			],
		};
		writeFileSync(
			join(epicPath, "001_task.yaml"),
			yaml.dump(task001, { lineWidth: -1 }),
		);

		// Create 003_report.md (non-task file with higher index)
		writeFileSync(join(epicPath, "003_report.md"), "# Report\n");

		// Next task should be 004_task.yaml
		const taskPath = createTask(tmp, "implement-auth");
		assert(
			taskPath.endsWith("004_task.yaml"),
			`Expected 004_task.yaml, got: ${taskPath}`,
		);

		// Old task should be pivoted (001_task.yaml was the latest task.yaml)
		const oldContent = readFileSync(join(epicPath, "001_task.yaml"), "utf-8");
		const oldTask = yaml.load(oldContent) as TaskYaml;
		assert(oldTask.status === "pivoted", "Expected old task to be pivoted");

		// New task should reference previous
		const newContent = readFileSync(taskPath, "utf-8");
		const newTask = yaml.load(newContent) as TaskYaml;
		assert(
			newTask.previous === "001_task.yaml",
			`Expected previous '001_task.yaml', got '${newTask.previous}'`,
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

// ============================================================================
// Section 4: hal task edit
// ============================================================================
console.log("\n--- hal task edit ---");

test("hal task edit adds updated event to history", () => {
	const tmp = mkdtempSync(join(tmpdir(), "haltr-m2-task-edit-"));
	try {
		initHaltr(tmp);
		const testDate = new Date(2026, 2, 19);
		createEpic(tmp, "implement-auth", testDate);

		const taskPath = createTask(tmp, "implement-auth");

		// Edit with --field and --value
		editTask(taskPath, "context", "Updated context");

		const content = readFileSync(taskPath, "utf-8");
		const task = yaml.load(content) as TaskYaml;

		assert(
			task.context === "Updated context",
			`Expected context 'Updated context', got '${task.context}'`,
		);
		assert(
			task.history!.length === 2,
			`Expected 2 history events, got ${task.history!.length}`,
		);
		assert(
			task.history![1].type === "updated",
			"Expected second event to be 'updated'",
		);
		assert(
			task.history![1].by.startsWith("orchestrator("),
			"Expected by orchestrator(...)",
		);

		// Verify the 'at' field is a valid ISO 8601 date
		const atDate = new Date(task.history![1].at);
		assert(
			!isNaN(atDate.getTime()),
			"Expected 'at' to be a valid ISO 8601 date",
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("hal task edit without field/value still adds updated event", () => {
	const tmp = mkdtempSync(join(tmpdir(), "haltr-m2-task-edit-noop-"));
	try {
		initHaltr(tmp);
		const testDate = new Date(2026, 2, 19);
		createEpic(tmp, "implement-auth", testDate);

		const taskPath = createTask(tmp, "implement-auth");

		// Edit without field/value (just adds updated event)
		editTask(taskPath);

		const content = readFileSync(taskPath, "utf-8");
		const task = yaml.load(content) as TaskYaml;

		assert(
			task.history!.length === 2,
			`Expected 2 history events, got ${task.history!.length}`,
		);
		assert(
			task.history![1].type === "updated",
			"Expected second event to be 'updated'",
		);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("hal task edit on non-existent file -> error", () => {
	let threw = false;
	try {
		editTask("/nonexistent/path/task.yaml");
	} catch {
		threw = true;
	}
	assert(threw, "Expected error for non-existent task file");
});

// ============================================================================
// Section 5: Multiple edits accumulate history
// ============================================================================
console.log("\n--- Multiple operations ---");

test("Multiple edits accumulate history events", () => {
	const tmp = mkdtempSync(join(tmpdir(), "haltr-m2-multi-edit-"));
	try {
		initHaltr(tmp);
		const testDate = new Date(2026, 2, 19);
		createEpic(tmp, "implement-auth", testDate);

		const taskPath = createTask(tmp, "implement-auth");
		editTask(taskPath, "context", "First edit");
		editTask(taskPath, "context", "Second edit");

		const content = readFileSync(taskPath, "utf-8");
		const task = yaml.load(content) as TaskYaml;

		assert(
			task.history!.length === 3,
			`Expected 3 history events (created + 2 updated), got ${task.history!.length}`,
		);
		assert(
			task.history![0].type === "created",
			"First event should be created",
		);
		assert(
			task.history![1].type === "updated",
			"Second event should be updated",
		);
		assert(
			task.history![2].type === "updated",
			"Third event should be updated",
		);
		assert(task.context === "Second edit", "Context should reflect last edit");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("Three tasks in sequence with correct pivoting chain", () => {
	const tmp = mkdtempSync(join(tmpdir(), "haltr-m2-chain-"));
	try {
		initHaltr(tmp);
		const testDate = new Date(2026, 2, 19);
		const epicPath = createEpic(tmp, "implement-auth", testDate);

		const task1 = createTask(tmp, "implement-auth");
		const task2 = createTask(tmp, "implement-auth");
		const task3 = createTask(tmp, "implement-auth");

		assert(
			task3.endsWith("003_task.yaml"),
			`Expected 003_task.yaml, got: ${task3}`,
		);

		// Task 1: should be pivoted, pointing to task 2
		const t1 = yaml.load(readFileSync(task1, "utf-8")) as TaskYaml;
		assert(t1.status === "pivoted", "Task 1 should be pivoted");

		// Task 2: should be pivoted, pointing to task 3
		const t2 = yaml.load(readFileSync(task2, "utf-8")) as TaskYaml;
		assert(t2.status === "pivoted", "Task 2 should be pivoted");
		assert(t2.previous === "001_task.yaml", "Task 2 should reference task 1");
		const t2Pivoted = t2.history!.find((e) => e.type === "pivoted") as any;
		assert(
			t2Pivoted?.next_task === "003_task.yaml",
			"Task 2 pivot should point to task 3",
		);

		// Task 3: should be pending with previous
		const t3 = yaml.load(readFileSync(task3, "utf-8")) as TaskYaml;
		assert(t3.status === "pending", "Task 3 should be pending");
		assert(t3.previous === "002_task.yaml", "Task 3 should reference task 2");
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
});

// ============================================================================
// Cleanup & Summary
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
