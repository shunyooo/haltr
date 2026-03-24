/**
 * Commands Test Script (v3)
 *
 * Tests for haltr v3 commands and libraries.
 * Run with: npx tsx src/test/commands-test.ts
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";

// Imports: session-manager
import {
	getSessionId,
	getTaskPathForSession,
	setSessionTask,
} from "../lib/session-manager.js";

// Imports: response-builder
import { buildResponse, formatResponse } from "../lib/response-builder.js";

// Imports: task-utils
import { resolveTaskFile } from "../lib/task-utils.js";

// Imports: commands
import { handleTaskCreate, handleTaskEdit } from "../commands/task.js";
import {
	handleStepAdd,
	handleStepDone,
	handleStepPause,
	handleStepResume,
	handleStepStart,
	handleStepVerify,
} from "../commands/step.js";

import type { TaskYaml } from "../types.js";

// ============================================================================
// Test infrastructure
// ============================================================================

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

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

// Suppress console.log during tests
function silenced<T>(fn: () => T): T {
	const orig = console.log;
	console.log = () => {};
	try {
		return fn();
	} finally {
		console.log = orig;
	}
}

function readTaskYaml(path: string): TaskYaml {
	return yaml.load(readFileSync(path, "utf-8")) as TaskYaml;
}

// ============================================================================
// Setup
// ============================================================================

const tmpDir = mkdtempSync(join(tmpdir(), "haltr-v3-test-"));
const sessionsDir = join(homedir(), ".haltr", "sessions");
mkdirSync(sessionsDir, { recursive: true });

// Save and restore session ID
const originalSessionId = process.env.HALTR_SESSION_ID;
const testSessionId = `test-${Date.now()}`;
process.env.HALTR_SESSION_ID = testSessionId;

// ============================================================================
// Session Manager Tests
// ============================================================================
console.log("\n--- Session Manager Tests ---");

test("getSessionId returns env var", () => {
	const id = getSessionId();
	assert(id === testSessionId, `Expected ${testSessionId}, got ${id}`);
});

test("getSessionId throws when not set", () => {
	const saved = process.env.HALTR_SESSION_ID;
	delete process.env.HALTR_SESSION_ID;
	try {
		expectThrows(() => getSessionId(), "HALTR_SESSION_ID");
	} finally {
		process.env.HALTR_SESSION_ID = saved;
	}
});

test("setSessionTask and getTaskPathForSession", () => {
	const taskPath = join(tmpDir, "test-task.yaml");
	setSessionTask(testSessionId, taskPath);
	const result = getTaskPathForSession(testSessionId);
	assert(result === taskPath, `Expected ${taskPath}, got ${result}`);
});

test("getTaskPathForSession returns null for unknown session", () => {
	const result = getTaskPathForSession("nonexistent-session-id-12345");
	assert(result === null, `Expected null, got ${result}`);
});

// ============================================================================
// Response Builder Tests
// ============================================================================
console.log("\n--- Response Builder Tests ---");

test("buildResponse creates minimal response", () => {
	const response = buildResponse({ status: "ok", message: "test" });
	assert(response.status === "ok", "status should be ok");
	assert(response.message === "test", "message should be test");
});

test("buildResponse includes data and commands_hint", () => {
	const response = buildResponse({
		status: "ok",
		message: "test",
		data: { key: "value" },
		commands_hint: "do something",
	});
	assert(response.data?.key === "value", "data.key should be value");
	assert(response.commands_hint === "do something", "commands_hint should match");
});

test("formatResponse returns YAML string", () => {
	const response = buildResponse({ status: "ok", message: "test" });
	const formatted = formatResponse(response);
	assert(formatted.includes("status: ok"), "should contain status: ok");
	assert(formatted.includes("message: test"), "should contain message: test");
});

// ============================================================================
// Task File Resolution Tests
// ============================================================================
console.log("\n--- Task File Resolution Tests ---");

test("resolveTaskFile with explicit --file", () => {
	const taskPath = join(tmpDir, "explicit.yaml");
	writeFileSync(taskPath, yaml.dump({ id: "test", goal: "test" }));
	const result = resolveTaskFile(taskPath);
	assert(result.endsWith("explicit.yaml"), `Expected explicit.yaml, got ${result}`);
});

test("resolveTaskFile throws for nonexistent file", () => {
	expectThrows(() => resolveTaskFile(join(tmpDir, "nonexistent.yaml")), "見つかりません");
});

test("resolveTaskFile falls back to session mapping", () => {
	const taskPath = join(tmpDir, "session-mapped.yaml");
	writeFileSync(taskPath, yaml.dump({ id: "test", goal: "test" }));
	setSessionTask(testSessionId, taskPath);
	const result = resolveTaskFile();
	assert(result === taskPath, `Expected ${taskPath}, got ${result}`);
});

test("resolveTaskFile auto-detects task.yaml in cwd", () => {
	const savedSession = process.env.HALTR_SESSION_ID;
	delete process.env.HALTR_SESSION_ID;

	const testDir = join(tmpDir, "autodetect");
	mkdirSync(testDir, { recursive: true });
	const taskPath = join(testDir, "task.yaml");
	writeFileSync(taskPath, yaml.dump({ id: "test", goal: "test" }));

	const originalCwd = process.cwd();
	process.chdir(testDir);
	try {
		const result = resolveTaskFile();
		assert(result === taskPath, `Expected ${taskPath}, got ${result}`);
	} finally {
		process.chdir(originalCwd);
		process.env.HALTR_SESSION_ID = savedSession;
	}
});

// ============================================================================
// Task Command Tests
// ============================================================================
console.log("\n--- Task Command Tests ---");

test("handleTaskCreate creates task file", () => {
	const filePath = join(tmpDir, "create-test.yaml");
	silenced(() => handleTaskCreate({ file: filePath, goal: "Test goal" }));
	assert(existsSync(filePath), "Task file should exist");
	const task = readTaskYaml(filePath);
	assert(task.goal === "Test goal", `goal should be 'Test goal', got '${task.goal}'`);
	assert(task.status === "pending", `status should be pending, got ${task.status}`);
});

test("handleTaskCreate with accept criteria", () => {
	const filePath = join(tmpDir, "create-accept.yaml");
	silenced(() => handleTaskCreate({ file: filePath, goal: "Test", accept: ["check1", "check2"] }));
	const task = readTaskYaml(filePath);
	assert(Array.isArray(task.accept), "accept should be array");
	assert((task.accept as string[]).length === 2, "should have 2 accept criteria");
});

test("handleTaskCreate fails if file exists", () => {
	const filePath = join(tmpDir, "create-dup.yaml");
	writeFileSync(filePath, "existing");
	expectThrows(
		() => silenced(() => handleTaskCreate({ file: filePath, goal: "Test" })),
		"既に存在します",
	);
});

test("handleTaskEdit updates goal", () => {
	const filePath = join(tmpDir, "edit-test.yaml");
	silenced(() => handleTaskCreate({ file: filePath, goal: "Original" }));
	silenced(() => handleTaskEdit({ file: filePath, goal: "Updated", message: "Changed" }));
	const task = readTaskYaml(filePath);
	assert(task.goal === "Updated", `goal should be 'Updated', got '${task.goal}'`);
});

test("handleTaskEdit adds history event", () => {
	const filePath = join(tmpDir, "edit-history.yaml");
	silenced(() => handleTaskCreate({ file: filePath, goal: "Original" }));
	silenced(() => handleTaskEdit({ file: filePath, goal: "Updated", message: "Reason" }));
	const task = readTaskYaml(filePath);
	const history = task.history as unknown as Array<Record<string, unknown>>;
	const updateEvent = history.find((e) => e.type === "updated");
	assert(updateEvent !== undefined, "should have updated event");
});

// ============================================================================
// Step Command Tests
// ============================================================================
console.log("\n--- Step Command Tests ---");

test("handleStepAdd adds step to task", () => {
	const filePath = join(tmpDir, "step-add.yaml");
	silenced(() => handleTaskCreate({ file: filePath, goal: "Test" }));
	silenced(() => handleStepAdd({ file: filePath, step: "impl", goal: "Implement" }));
	const task = readTaskYaml(filePath);
	assert(task.steps?.length === 1, "should have 1 step");
	assert(task.steps?.[0].id === "impl", "step id should be impl");
});

test("handleStepAdd with accept criteria", () => {
	const filePath = join(tmpDir, "step-add-accept.yaml");
	silenced(() => handleTaskCreate({ file: filePath, goal: "Test" }));
	silenced(() => handleStepAdd({ file: filePath, step: "impl", goal: "Implement", accept: ["tests pass"] }));
	const task = readTaskYaml(filePath);
	assert(task.steps?.[0].accept === "tests pass", "should have accept criteria");
});

test("handleStepAdd rejects duplicate step ID", () => {
	const filePath = join(tmpDir, "step-dup.yaml");
	silenced(() => handleTaskCreate({ file: filePath, goal: "Test" }));
	silenced(() => handleStepAdd({ file: filePath, step: "impl", goal: "v1" }));
	expectThrows(
		() => silenced(() => handleStepAdd({ file: filePath, step: "impl", goal: "v2" })),
		"既に存在します",
	);
});

test("handleStepStart changes step status to in_progress", () => {
	const filePath = join(tmpDir, "step-start.yaml");
	silenced(() => handleTaskCreate({ file: filePath, goal: "Test" }));
	silenced(() => handleStepAdd({ file: filePath, step: "impl", goal: "Implement" }));
	silenced(() => handleStepStart({ file: filePath, step: "impl" }));
	const task = readTaskYaml(filePath);
	assert(task.steps?.[0].status === "in_progress", "step should be in_progress");
	assert(task.status === "in_progress", "task should be in_progress");
});

test("handleStepStart updates session mapping", () => {
	const filePath = join(tmpDir, "step-start-session.yaml");
	silenced(() => handleTaskCreate({ file: filePath, goal: "Test" }));
	silenced(() => handleStepAdd({ file: filePath, step: "impl", goal: "Implement" }));

	// Change session to simulate cross-session handoff
	const newSessionId = `handoff-${Date.now()}`;
	process.env.HALTR_SESSION_ID = newSessionId;
	silenced(() => handleStepStart({ file: filePath, step: "impl" }));

	const mapped = getTaskPathForSession(newSessionId);
	assert(mapped === filePath, `Session should be mapped to ${filePath}, got ${mapped}`);

	// Restore
	process.env.HALTR_SESSION_ID = testSessionId;
});

test("handleStepDone PASS marks step as done", () => {
	const filePath = join(tmpDir, "step-done.yaml");
	silenced(() => handleTaskCreate({ file: filePath, goal: "Test" }));
	silenced(() => handleStepAdd({ file: filePath, step: "impl", goal: "Implement" }));
	silenced(() => handleStepStart({ file: filePath, step: "impl" }));
	silenced(() => handleStepDone({ file: filePath, step: "impl", result: "PASS", message: "Done" }));
	const task = readTaskYaml(filePath);
	assert(task.steps?.[0].status === "done", "step should be done");
	assert(task.status === "done", "task should be done (all steps complete)");
});

test("handleStepDone FAIL keeps step in_progress", () => {
	const filePath = join(tmpDir, "step-fail.yaml");
	silenced(() => handleTaskCreate({ file: filePath, goal: "Test" }));
	silenced(() => handleStepAdd({ file: filePath, step: "impl", goal: "Implement" }));
	silenced(() => handleStepStart({ file: filePath, step: "impl" }));
	silenced(() => handleStepDone({ file: filePath, step: "impl", result: "FAIL", message: "Failed" }));
	const task = readTaskYaml(filePath);
	assert(task.steps?.[0].status === "in_progress", "step should still be in_progress after FAIL");
});

test("handleStepDone PASS requires verification when accept exists", () => {
	const filePath = join(tmpDir, "step-verify-required.yaml");
	silenced(() => handleTaskCreate({ file: filePath, goal: "Test" }));
	silenced(() => handleStepAdd({ file: filePath, step: "impl", goal: "Implement", accept: ["tests pass"] }));
	silenced(() => handleStepStart({ file: filePath, step: "impl" }));
	expectThrows(
		() => silenced(() => handleStepDone({ file: filePath, step: "impl", result: "PASS", message: "Done" })),
		"未検証",
	);
});

test("handleStepVerify sets verified flag", () => {
	const filePath = join(tmpDir, "step-verify.yaml");
	silenced(() => handleTaskCreate({ file: filePath, goal: "Test" }));
	silenced(() => handleStepAdd({ file: filePath, step: "impl", goal: "Implement", accept: ["tests pass"] }));
	silenced(() => handleStepStart({ file: filePath, step: "impl" }));
	silenced(() => handleStepVerify({ file: filePath, step: "impl", result: "PASS", message: "Verified" }));
	const task = readTaskYaml(filePath);
	assert(task.steps?.[0].verified === true, "step should be verified");
});

test("handleStepPause adds paused event", () => {
	const filePath = join(tmpDir, "step-pause.yaml");
	silenced(() => handleTaskCreate({ file: filePath, goal: "Test" }));
	silenced(() => handleStepAdd({ file: filePath, step: "impl", goal: "Implement" }));
	silenced(() => handleStepStart({ file: filePath, step: "impl" }));
	silenced(() => handleStepPause({ file: filePath, message: "Need user input" }));
	const task = readTaskYaml(filePath);
	const history = task.history as unknown as Array<Record<string, unknown>>;
	const pauseEvent = history.find((e) => e.type === "paused");
	assert(pauseEvent !== undefined, "should have paused event");
});

test("handleStepResume adds resumed event", () => {
	const filePath = join(tmpDir, "step-resume.yaml");
	silenced(() => handleTaskCreate({ file: filePath, goal: "Test" }));
	silenced(() => handleStepAdd({ file: filePath, step: "impl", goal: "Implement" }));
	silenced(() => handleStepStart({ file: filePath, step: "impl" }));
	silenced(() => handleStepPause({ file: filePath, message: "Pause" }));
	silenced(() => handleStepResume({ file: filePath }));
	const task = readTaskYaml(filePath);
	const history = task.history as unknown as Array<Record<string, unknown>>;
	const resumeEvent = history.find((e) => e.type === "resumed");
	assert(resumeEvent !== undefined, "should have resumed event");
});

// ============================================================================
// Cleanup & Summary
// ============================================================================

// Restore original session ID
if (originalSessionId) {
	process.env.HALTR_SESSION_ID = originalSessionId;
} else {
	delete process.env.HALTR_SESSION_ID;
}

// Clean up session files
try {
	const sessionFile = join(sessionsDir, testSessionId);
	if (existsSync(sessionFile)) {
		rmSync(sessionFile);
	}
} catch { /* ignore */ }

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
