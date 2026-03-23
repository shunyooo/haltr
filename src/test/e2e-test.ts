/**
 * haltr End-to-End Test
 *
 * Tests the full CLI workflow:
 * hal init → hal task create → hal step add → hal step start → hal step done → completion
 */

import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import yaml from "js-yaml";

// ============================================================
// Test Runner
// ============================================================

interface TestResult {
	name: string;
	passed: boolean;
	error?: string;
}

const results: TestResult[] = [];

function test(name: string, fn: () => void) {
	try {
		fn();
		results.push({ name, passed: true });
		console.log(`  PASS: ${name}`);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		results.push({ name, passed: false, error: msg });
		console.log(`  FAIL: ${name}`);
		console.log(`        ${msg}`);
	}
}

function assert(condition: boolean, message: string) {
	if (!condition) throw new Error(message);
}

// ============================================================
// Helper: run hal CLI
// ============================================================

const HAL_BIN = join(process.cwd(), "dist/bin/hal.js");

function hal(args: string, opts: { cwd: string; sessionId?: string; stdin?: string }): string {
	const env = {
		...process.env,
		HALTR_SESSION_ID: opts.sessionId || "e2e-test-session",
	};

	try {
		const result = execSync(`node ${HAL_BIN} ${args}`, {
			cwd: opts.cwd,
			env,
			encoding: "utf-8",
			input: opts.stdin,
			timeout: 10000,
		});
		return result;
	} catch (e: unknown) {
		if (e && typeof e === "object" && "stdout" in e) {
			const execError = e as { stdout: string; stderr: string; status: number };
			// For hal check, exit code 2 is expected (block)
			if (execError.status === 2) {
				return execError.stdout || execError.stderr || "";
			}
			throw new Error(`hal ${args} failed (exit ${execError.status}): ${execError.stderr || execError.stdout}`);
		}
		throw e;
	}
}

function halWithExitCode(args: string, opts: { cwd: string; sessionId?: string; stdin?: string }): { stdout: string; exitCode: number } {
	const env = {
		...process.env,
		HALTR_SESSION_ID: opts.sessionId || "e2e-test-session",
	};

	try {
		const result = execSync(`node ${HAL_BIN} ${args}`, {
			cwd: opts.cwd,
			env,
			encoding: "utf-8",
			input: opts.stdin,
			timeout: 10000,
		});
		return { stdout: result, exitCode: 0 };
	} catch (e: unknown) {
		if (e && typeof e === "object" && "stdout" in e) {
			const execError = e as { stdout: string; stderr: string; status: number };
			return { stdout: execError.stdout || execError.stderr || "", exitCode: execError.status };
		}
		throw e;
	}
}

function readTaskYaml(cwd: string): Record<string, unknown> {
	// Find the latest task.yaml in epics
	const haltrDir = join(cwd, "haltr");
	const epicsDir = join(haltrDir, "epics");
	if (!existsSync(epicsDir)) return {};

	const epicDirs = execSync(`ls -d ${epicsDir}/*/`, { encoding: "utf-8" }).trim().split("\n").filter(Boolean);
	if (epicDirs.length === 0) return {};

	const latestEpic = epicDirs[epicDirs.length - 1].replace(/\/$/, "");
	const files = execSync(`ls ${latestEpic}/*_task.yaml 2>/dev/null || true`, { encoding: "utf-8" }).trim().split("\n").filter(Boolean);
	if (files.length === 0) return {};

	const latestTask = files[files.length - 1];
	return yaml.load(readFileSync(latestTask, "utf-8")) as Record<string, unknown>;
}

// ============================================================
// Setup
// ============================================================

// Build first
console.log("Building haltr...");
execSync("npm run build", { encoding: "utf-8", stdio: "pipe" });
console.log("Build complete.\n");

// ============================================================
// Test: Full Workflow (hal init → task create → step lifecycle → completion)
// ============================================================

console.log("--- E2E: Full Task Lifecycle ---");

const tmpDir = mkdtempSync(join(tmpdir(), "haltr-e2e-"));

try {
	// --- hal init ---
	test("hal init creates haltr directory structure", () => {
		const output = hal("init", { cwd: tmpDir });
		assert(existsSync(join(tmpDir, "haltr")), "haltr/ should exist");
		assert(existsSync(join(tmpDir, "haltr/config.yaml")), "config.yaml should exist");
		assert(existsSync(join(tmpDir, "haltr/README.md")), "README.md should exist");
		assert(existsSync(join(tmpDir, "haltr/context/index.yaml")), "context/index.yaml should exist");
		assert(existsSync(join(tmpDir, "haltr/context/history.yaml")), "context/history.yaml should exist");
		assert(existsSync(join(tmpDir, "haltr/context/skills")), "context/skills/ should exist");
		assert(existsSync(join(tmpDir, "haltr/context/knowledge")), "context/knowledge/ should exist");
		assert(existsSync(join(tmpDir, "haltr/epics")), "epics/ should exist");
		assert(existsSync(join(tmpDir, "haltr/.sessions")), ".sessions/ should exist");
	});

	// --- hal epic create ---
	test("hal epic create creates epic directory", () => {
		const output = hal("epic create test-epic", { cwd: tmpDir });
		const epicsDir = join(tmpDir, "haltr/epics");
		const dirs = execSync(`ls ${epicsDir}`, { encoding: "utf-8" }).trim();
		assert(dirs.includes("test-epic"), "epic directory should contain 'test-epic'");
	});

	// --- hal task create ---
	test("hal task create generates task.yaml", () => {
		const output = hal('task create --goal "Implement login feature" --accept "npm test passes" --accept "lint clean"', { cwd: tmpDir });
		assert(output.includes("task.yaml"), "output should mention task.yaml");

		const task = readTaskYaml(tmpDir);
		assert(task.goal === "Implement login feature", `goal should match, got: ${task.goal}`);
		assert(Array.isArray(task.accept), "accept should be array");
		assert((task.accept as string[]).length === 2, "accept should have 2 items");
		assert(task.status === "pending", `status should be pending, got: ${task.status}`);
		assert(Array.isArray(task.history), "history should exist");
		assert((task.history as Array<Record<string, unknown>>).length === 1, "history should have 1 event");
		assert((task.history as Array<Record<string, unknown>>)[0].type === "created", "first event should be created");
	});

	// --- hal step add ---
	test("hal step add adds step to task", () => {
		hal('step add --step setup --goal "Set up project structure"', { cwd: tmpDir });
		hal('step add --step implement --goal "Implement the feature" --accept "tests pass"', { cwd: tmpDir });
		hal('step add --step review --goal "Code review"', { cwd: tmpDir });

		const task = readTaskYaml(tmpDir);
		const steps = task.steps as Array<Record<string, unknown>>;
		assert(steps.length === 3, `should have 3 steps, got: ${steps.length}`);
		assert(steps[0].id === "setup", "first step should be setup");
		assert(steps[1].id === "implement", "second step should be implement");
		assert(steps[2].id === "review", "third step should be review");
		assert(steps[0].status === "pending", "setup should be pending");
	});

	// --- hal step add duplicate error ---
	test("hal step add rejects duplicate step ID", () => {
		try {
			hal('step add --step setup --goal "Duplicate"', { cwd: tmpDir });
			assert(false, "should have thrown");
		} catch (e) {
			assert(String(e).includes("setup"), "error should mention step ID");
		}
	});

	// --- hal step start ---
	test("hal step start sets step to in_progress", () => {
		const output = hal("step start --step setup", { cwd: tmpDir });
		const task = readTaskYaml(tmpDir);
		const steps = task.steps as Array<Record<string, unknown>>;
		assert(steps[0].status === "in_progress", "setup should be in_progress");
		assert(task.status === "in_progress", "task should be in_progress");
	});

	// --- hal status ---
	test("hal status shows current state", () => {
		const output = hal("status", { cwd: tmpDir });
		assert(output.includes("Implement login feature"), "should show goal");
		assert(output.includes("setup"), "should show step");
		assert(output.includes("in_progress"), "should show status");
	});

	// --- hal step done PASS ---
	test("hal step done PASS completes step", () => {
		const output = hal('step done --step setup --result PASS --message "Project structure ready"', { cwd: tmpDir });
		const task = readTaskYaml(tmpDir);
		const steps = task.steps as Array<Record<string, unknown>>;
		assert(steps[0].status === "done", "setup should be done");
	});

	// --- hal step done FAIL ---
	test("hal step done FAIL keeps step in_progress", () => {
		hal("step start --step implement", { cwd: tmpDir });
		hal('step done --step implement --result FAIL --message "Tests failing"', { cwd: tmpDir });

		const task = readTaskYaml(tmpDir);
		const steps = task.steps as Array<Record<string, unknown>>;
		assert(steps[1].status === "in_progress", "implement should remain in_progress after FAIL");
	});

	// --- hal step done PASS after FAIL ---
	test("hal step done PASS after previous FAIL", () => {
		hal('step done --step implement --result PASS --message "Tests fixed and passing"', { cwd: tmpDir });
		const task = readTaskYaml(tmpDir);
		const steps = task.steps as Array<Record<string, unknown>>;
		assert(steps[1].status === "done", "implement should be done after PASS");
	});

	// --- hal step pause/resume ---
	test("hal step pause and resume work", () => {
		hal("step start --step review", { cwd: tmpDir });
		hal("step pause", { cwd: tmpDir });

		let task = readTaskYaml(tmpDir);
		let history = task.history as Array<Record<string, unknown>>;
		const pauseEvent = history.find(e => e.type === "paused");
		assert(pauseEvent !== undefined, "should have paused event");

		hal("step resume", { cwd: tmpDir });
		task = readTaskYaml(tmpDir);
		history = task.history as Array<Record<string, unknown>>;
		const resumeEvent = history.find(e => e.type === "resumed");
		assert(resumeEvent !== undefined, "should have resumed event");
	});

	// --- hal check (stop hook) ---
	test("hal check blocks when steps remain", () => {
		const stdinJson = JSON.stringify({ session_id: "e2e-test-session" });
		const { exitCode } = halWithExitCode("check", { cwd: tmpDir, stdin: stdinJson });
		assert(exitCode === 2, `should exit with 2 (block), got: ${exitCode}`);
	});

	// --- Complete last step ---
	test("hal step done on last step completes task", () => {
		const output = hal('step done --step review --result PASS --message "Review complete"', { cwd: tmpDir });
		const task = readTaskYaml(tmpDir);
		assert(task.status === "done", `task should be done, got: ${task.status}`);

		const history = task.history as Array<Record<string, unknown>>;
		const completedEvent = history.find(e => e.type === "completed");
		assert(completedEvent !== undefined, "should have completed event");

		// Output should mention CCR
		assert(output.includes("CCR") || output.includes("検証") || output.includes("完了"), "should mention completion or CCR");
	});

	// --- hal check allows stop when done ---
	test("hal check allows stop when task is done", () => {
		const stdinJson = JSON.stringify({ session_id: "e2e-test-session" });
		const { exitCode } = halWithExitCode("check", { cwd: tmpDir, stdin: stdinJson });
		assert(exitCode === 0, `should exit with 0 (allow), got: ${exitCode}`);
	});

	// --- hal task edit ---
	test("hal task edit updates goal", () => {
		hal('task edit --goal "Implement login feature v2" --message "Scope expanded"', { cwd: tmpDir });
		const task = readTaskYaml(tmpDir);
		assert(task.goal === "Implement login feature v2", `goal should be updated, got: ${task.goal}`);

		const history = task.history as Array<Record<string, unknown>>;
		const updateEvent = history.find(e => e.type === "updated");
		assert(updateEvent !== undefined, "should have updated event");
	});

	// --- History integrity ---
	test("history records full lifecycle", () => {
		const task = readTaskYaml(tmpDir);
		const history = task.history as Array<Record<string, unknown>>;
		const types = history.map(e => e.type);

		assert(types.includes("created"), "should have created");
		assert(types.includes("step_added"), "should have step_added");
		assert(types.includes("step_started"), "should have step_started");
		assert(types.includes("step_done"), "should have step_done");
		assert(types.includes("step_failed"), "should have step_failed");
		assert(types.includes("paused"), "should have paused");
		assert(types.includes("resumed"), "should have resumed");
		assert(types.includes("completed"), "should have completed");
		assert(types.includes("updated"), "should have updated");

		// All events should have timestamps
		for (const event of history) {
			assert(typeof event.at === "string", `event ${event.type} should have 'at' timestamp`);
		}
	});

} finally {
	rmSync(tmpDir, { recursive: true, force: true });
}

// ============================================================
// Test: Context Workflow
// ============================================================

console.log("\n--- E2E: Context Workflow ---");

const tmpDir2 = mkdtempSync(join(tmpdir(), "haltr-e2e-ctx-"));

try {
	// Init
	hal("init", { cwd: tmpDir2 });

	// --- hal context create skill ---
	test("hal context create skill creates SKILL.md", () => {
		const output = hal('context create --type skill --id reporting --description "レポーティングの項目と形式"', { cwd: tmpDir2 });
		assert(existsSync(join(tmpDir2, "haltr/context/skills/reporting/SKILL.md")), "SKILL.md should exist");
		assert(output.includes("reporting"), "output should mention id");
	});

	// --- hal context create knowledge ---
	test("hal context create knowledge creates README.md", () => {
		hal('context create --type knowledge --id bq-patterns --description "BigQuery クエリのパターン"', { cwd: tmpDir2 });
		assert(existsSync(join(tmpDir2, "haltr/context/knowledge/bq-patterns/README.md")), "README.md should exist");
	});

	// --- Write content to skill ---
	test("write content to skill file and show it", () => {
		const skillPath = join(tmpDir2, "haltr/context/skills/reporting/SKILL.md");
		writeFileSync(skillPath, "# Reporting\n\n- 概要\n- 手法\n- 結果\n- 考察\n");

		const output = hal("context show --id reporting", { cwd: tmpDir2 });
		assert(output.includes("概要"), "should show skill content");
		assert(output.includes("手法"), "should show skill content");
	});

	// --- hal context list ---
	test("hal context list shows all entries", () => {
		const output = hal("context list", { cwd: tmpDir2 });
		assert(output.includes("reporting"), "should list reporting");
		assert(output.includes("bq-patterns"), "should list bq-patterns");
		assert(output.includes("skill"), "should show type");
		assert(output.includes("knowledge"), "should show type");
	});

	// --- hal context log ---
	test("hal context log records event", () => {
		hal('context log --id reporting --type updated --message "考察セクションを追加"', { cwd: tmpDir2 });

		const historyPath = join(tmpDir2, "haltr/context/history.yaml");
		const history = yaml.load(readFileSync(historyPath, "utf-8")) as Record<string, Array<Record<string, unknown>>>;
		const events = history.reporting;
		assert(Array.isArray(events), "should have events for reporting");
		const updateEvent = events.find(e => e.type === "updated");
		assert(updateEvent !== undefined, "should have updated event");
		assert(updateEvent?.message === "考察セクションを追加", "message should match");
	});

	// --- hal context show records used event ---
	test("hal context show records used event in history", () => {
		hal("context show --id bq-patterns", { cwd: tmpDir2 });

		const historyPath = join(tmpDir2, "haltr/context/history.yaml");
		const history = yaml.load(readFileSync(historyPath, "utf-8")) as Record<string, Array<Record<string, unknown>>>;
		const events = history["bq-patterns"];
		const usedEvent = events.find(e => e.type === "used");
		assert(usedEvent !== undefined, "should have used event");
	});

	// --- hal context delete ---
	test("hal context delete removes entry", () => {
		hal('context delete --id bq-patterns --reason "もう使わない"', { cwd: tmpDir2 });
		assert(!existsSync(join(tmpDir2, "haltr/context/knowledge/bq-patterns")), "directory should be removed");

		const indexPath = join(tmpDir2, "haltr/context/index.yaml");
		const index = yaml.load(readFileSync(indexPath, "utf-8")) as Array<Record<string, unknown>>;
		const found = index.find(e => e.id === "bq-patterns");
		assert(found === undefined, "should not be in index");
	});

} finally {
	rmSync(tmpDir2, { recursive: true, force: true });
}

// ============================================================
// Test: Parallel Sessions
// ============================================================

console.log("\n--- E2E: Parallel Sessions ---");

const tmpDir3 = mkdtempSync(join(tmpdir(), "haltr-e2e-parallel-"));

try {
	hal("init", { cwd: tmpDir3 });
	hal("epic create parallel-test", { cwd: tmpDir3 });

	test("parallel sessions have independent task mappings", () => {
		// Session A creates a task
		hal('task create --goal "Task A"', { cwd: tmpDir3, sessionId: "session-a" });

		// Session B creates a different task
		hal('task create --goal "Task B"', { cwd: tmpDir3, sessionId: "session-b" });

		// Session A's status should show Task A
		const statusA = hal("status", { cwd: tmpDir3, sessionId: "session-a" });
		assert(statusA.includes("Task A"), `session A should see Task A, got: ${statusA}`);

		// Session B's status should show Task B
		const statusB = hal("status", { cwd: tmpDir3, sessionId: "session-b" });
		assert(statusB.includes("Task B"), `session B should see Task B, got: ${statusB}`);
	});

	test("hal check with parallel sessions only checks own task", () => {
		// Session A adds and starts a step
		hal('step add --step work-a --goal "Work A"', { cwd: tmpDir3, sessionId: "session-a" });
		hal("step start --step work-a", { cwd: tmpDir3, sessionId: "session-a" });

		// Session B completes its task
		hal('step add --step work-b --goal "Work B"', { cwd: tmpDir3, sessionId: "session-b" });
		hal("step start --step work-b", { cwd: tmpDir3, sessionId: "session-b" });
		hal('step done --step work-b --result PASS', { cwd: tmpDir3, sessionId: "session-b" });

		// Session B's check should allow (task done)
		const stdinB = JSON.stringify({ session_id: "session-b" });
		const { exitCode: exitB } = halWithExitCode("check", { cwd: tmpDir3, stdin: stdinB });
		assert(exitB === 0, `session B should be allowed (done), got exit: ${exitB}`);

		// Session A's check should block (step in_progress)
		const stdinA = JSON.stringify({ session_id: "session-a" });
		const { exitCode: exitA } = halWithExitCode("check", { cwd: tmpDir3, stdin: stdinA });
		assert(exitA === 2, `session A should be blocked, got exit: ${exitA}`);
	});

} finally {
	rmSync(tmpDir3, { recursive: true, force: true });
}

// ============================================================
// Summary
// ============================================================

console.log("\n========================================");
console.log(`  Total: ${results.length}`);
console.log(`  PASS:  ${results.filter((r) => r.passed).length}`);
console.log(`  FAIL:  ${results.filter((r) => !r.passed).length}`);
console.log("========================================");

const failed = results.filter((r) => !r.passed);
if (failed.length > 0) {
	console.log("\nFailed tests:");
	for (const f of failed) {
		console.log(`  - ${f.name}: ${f.error}`);
	}
	process.exit(1);
} else {
	console.log("\nAll tests passed!");
}
