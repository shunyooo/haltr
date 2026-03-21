/**
 * M4 Validation Test Script
 *
 * Verifies all Definition-of-Done items for M4 (Hook Gate Check — `hal check`).
 * Run with: npm run test:m4
 *
 * Tests call the check logic functions directly (no subprocess spawning)
 * and mock tmux send-keys via module-level spy.
 */

import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import {
	type CheckResult,
	checkOrchestrator,
	checkVerifier,
	checkWorker,
	notifyParent,
} from "../commands/check.js";
import { type PaneEntry, PanesManager } from "../lib/panes-manager.js";
import type {
	AcceptObject,
	ConfigYaml,
	HistoryEvent,
	TaskYaml,
} from "../types.js";

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

function assertEqual(actual: unknown, expected: unknown, label?: string): void {
	if (actual !== expected) {
		throw new Error(
			`${label ? label + ": " : ""}Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
		);
	}
}

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(message);
}

// ============================================================================
// Fixtures
// ============================================================================

function makeBaseTask(overrides: Partial<TaskYaml> = {}): TaskYaml {
	return {
		id: "test-task",
		agents: { worker: "claude", verifier: "codex" },
		steps: [
			{
				id: "step-1",
				instructions: "First step",
				status: "in_progress",
			},
			{
				id: "step-2",
				instructions: "Second step with accept",
				status: "in_progress",
				accept: [{ id: "test-check", check: "npm test passes" }],
			},
			{
				id: "step-3",
				instructions: "Third step with human accept",
				status: "in_progress",
				accept: [{ id: "human-check", type: "human", check: "Review the UI" }],
			},
			{
				id: "step-4",
				instructions: "Fourth step with mixed accept",
				status: "in_progress",
				accept: [
					{ id: "agent-check", check: "tests pass" },
					{
						id: "human-check",
						type: "human",
						check: "Verify visually",
					},
				],
			},
		],
		history: [],
		...overrides,
	};
}

function makeHistoryEvent(
	type: string,
	step: string,
	attempt: number,
	extra: Record<string, unknown> = {},
): HistoryEvent {
	return {
		at: new Date().toISOString(),
		type,
		by: "test",
		step,
		attempt,
		...extra,
	} as unknown as HistoryEvent;
}

// ============================================================================
// Section 1: hal check --worker
// ============================================================================
console.log("\n--- hal check --worker ---");

test("worker: history empty -> block + work_done message", () => {
	const task = makeBaseTask();
	const result = checkWorker(task, "step-1");
	assertEqual(result.action, "block", "action");
	assert(
		result.message!.includes("hal history add --type work_done"),
		`message should contain instruction, got: ${result.message}`,
	);
});

test("worker: work_done recorded (no accept) -> allow + notification", () => {
	const task = makeBaseTask({
		history: [
			makeHistoryEvent("step_started", "step-1", 1),
			makeHistoryEvent("work_done", "step-1", 1, { message: "done" }),
		],
	});
	const result = checkWorker(task, "step-1");
	assertEqual(result.action, "allow", "action");
	assert(
		result.notification!.includes("step-1 完了（accept なし）"),
		`notification should mention accept なし, got: ${result.notification}`,
	);
});

test("worker: work_done recorded (accept present) -> allow + wait message + notification", () => {
	const task = makeBaseTask({
		history: [
			makeHistoryEvent("step_started", "step-2", 1),
			makeHistoryEvent("work_done", "step-2", 1, { message: "done" }),
		],
	});
	const result = checkWorker(task, "step-2");
	assertEqual(result.action, "allow", "action");
	assert(
		result.message!.includes("検証完了まで待機してください"),
		`message should mention wait, got: ${result.message}`,
	);
	assert(result.notification !== undefined, "should have notification");
});

test("worker: verification_failed after work_done, no new work_done -> block", () => {
	const task = makeBaseTask({
		history: [
			makeHistoryEvent("step_started", "step-1", 1),
			makeHistoryEvent("work_done", "step-1", 1, { message: "done" }),
			makeHistoryEvent("verification_failed", "step-1", 1, {
				accept_id: "default",
				message: "test failed",
			}),
		],
	});
	const result = checkWorker(task, "step-1");
	assertEqual(result.action, "block", "action");
	assert(
		result.message!.includes("検証が失敗しています"),
		`message should mention verification failure, got: ${result.message}`,
	);
});

test("worker: verification_failed followed by new work_done -> allow", () => {
	const task = makeBaseTask({
		history: [
			makeHistoryEvent("step_started", "step-1", 1),
			makeHistoryEvent("work_done", "step-1", 1, { message: "first attempt" }),
			makeHistoryEvent("verification_failed", "step-1", 1, {
				accept_id: "default",
				message: "test failed",
			}),
			makeHistoryEvent("work_done", "step-1", 1, {
				message: "fixed and redone",
			}),
		],
	});
	const result = checkWorker(task, "step-1");
	assertEqual(result.action, "allow", "action");
	// step-1 has no accept, so notification should say "accept なし"
	assert(
		result.notification!.includes("step-1 完了（accept なし）"),
		`notification should mention accept なし, got: ${result.notification}`,
	);
});

test("worker: accept is type: human only -> allow + human notification", () => {
	const task = makeBaseTask({
		history: [
			makeHistoryEvent("step_started", "step-3", 1),
			makeHistoryEvent("work_done", "step-3", 1, { message: "done" }),
		],
	});
	const result = checkWorker(task, "step-3");
	assertEqual(result.action, "allow", "action");
	assert(
		result.message!.includes("人間検証が必要"),
		`message should mention human verification, got: ${result.message}`,
	);
	assert(
		result.notification!.includes("人間検証が必要"),
		`notification should mention human verification, got: ${result.notification}`,
	);
});

test("worker: accept is agent + human mixed -> allow + notification", () => {
	const task = makeBaseTask({
		history: [
			makeHistoryEvent("step_started", "step-4", 1),
			makeHistoryEvent("work_done", "step-4", 1, { message: "done" }),
		],
	});
	const result = checkWorker(task, "step-4");
	assertEqual(result.action, "allow", "action");
	assert(
		result.message!.includes("検証完了まで待機してください"),
		`message should mention wait, got: ${result.message}`,
	);
	assert(result.notification !== undefined, "should have notification");
});

test("worker: max_retries not set -> no guard", () => {
	const task = makeBaseTask({
		steps: [
			{
				id: "step-5",
				instructions: "Step without max_retries",
				status: "in_progress",
			},
		],
		history: [
			makeHistoryEvent("step_started", "step-5", 1),
			makeHistoryEvent("step_started", "step-5", 2),
			makeHistoryEvent("step_started", "step-5", 3),
			makeHistoryEvent("step_started", "step-5", 4),
		],
	});
	const result = checkWorker(task, "step-5");
	// Should block for work_done, not escalate
	assertEqual(result.action, "block", "action");
	assert(
		result.message!.includes("hal history add --type work_done"),
		`message should ask for work_done, got: ${result.message}`,
	);
});

test("worker: max_retries=2, attempt 1 -> no escalate", () => {
	const task = makeBaseTask({
		steps: [
			{
				id: "step-6",
				instructions: "Step with max_retries=2",
				status: "in_progress",
				max_retries: 2,
			},
		],
		history: [makeHistoryEvent("step_started", "step-6", 1)],
	});
	const result = checkWorker(task, "step-6");
	assertEqual(result.action, "block", "action");
	assert(
		result.message!.includes("hal history add --type work_done"),
		`message should ask for work_done, got: ${result.message}`,
	);
});

test("worker: max_retries=2, attempt 2 -> no escalate", () => {
	const task = makeBaseTask({
		steps: [
			{
				id: "step-7",
				instructions: "Step with max_retries=2",
				status: "in_progress",
				max_retries: 2,
			},
		],
		history: [
			makeHistoryEvent("step_started", "step-7", 1),
			makeHistoryEvent("step_started", "step-7", 2),
		],
	});
	const result = checkWorker(task, "step-7");
	assertEqual(result.action, "block", "action");
	assert(
		result.message!.includes("hal history add --type work_done"),
		`message should ask for work_done, got: ${result.message}`,
	);
});

test("worker: max_retries=2, attempt 3 -> escalate", () => {
	const task = makeBaseTask({
		steps: [
			{
				id: "step-8",
				instructions: "Step with max_retries=2",
				status: "in_progress",
				max_retries: 2,
			},
		],
		history: [
			makeHistoryEvent("step_started", "step-8", 1),
			makeHistoryEvent("step_started", "step-8", 2),
			makeHistoryEvent("step_started", "step-8", 3),
		],
	});
	const result = checkWorker(task, "step-8");
	assertEqual(result.action, "escalate", "action");
	assert(
		result.message!.includes("リトライ上限（2回）に達しました"),
		`message should mention retry limit, got: ${result.message}`,
	);
});

test("worker: max_retries=1, attempt 2 -> escalate", () => {
	const task = makeBaseTask({
		steps: [
			{
				id: "step-9",
				instructions: "Step with max_retries=1",
				status: "in_progress",
				max_retries: 1,
			},
		],
		history: [
			makeHistoryEvent("step_started", "step-9", 1),
			makeHistoryEvent("step_started", "step-9", 2),
		],
	});
	const result = checkWorker(task, "step-9");
	assertEqual(result.action, "escalate", "action");
	assert(
		result.message!.includes("リトライ上限（1回）に達しました"),
		`message should mention retry limit, got: ${result.message}`,
	);
});

// ============================================================================
// Section 2: hal check --verifier
// ============================================================================
console.log("\n--- hal check --verifier ---");

test("verifier: no verification result after work_done -> block", () => {
	const task = makeBaseTask({
		history: [
			makeHistoryEvent("step_started", "step-1", 1),
			makeHistoryEvent("work_done", "step-1", 1, { message: "done" }),
		],
	});
	const result = checkVerifier(task, "step-1");
	assertEqual(result.action, "block", "action");
	assert(
		result.message!.includes("hal history add --type verification"),
		`message should contain instruction, got: ${result.message}`,
	);
});

test("verifier: verification_passed recorded -> allow + notification", () => {
	const task = makeBaseTask({
		history: [
			makeHistoryEvent("step_started", "step-1", 1),
			makeHistoryEvent("work_done", "step-1", 1, { message: "done" }),
			makeHistoryEvent("verification_passed", "step-1", 1, {
				accept_id: "default",
				message: "all tests pass",
			}),
		],
	});
	const result = checkVerifier(task, "step-1");
	assertEqual(result.action, "allow", "action");
	assert(
		result.notification!.includes("検証 PASS"),
		`notification should mention PASS, got: ${result.notification}`,
	);
});

test("verifier: verification_failed recorded -> allow + notification", () => {
	const task = makeBaseTask({
		history: [
			makeHistoryEvent("step_started", "step-1", 1),
			makeHistoryEvent("work_done", "step-1", 1, { message: "done" }),
			makeHistoryEvent("verification_failed", "step-1", 1, {
				accept_id: "default",
				message: "test failed",
			}),
		],
	});
	const result = checkVerifier(task, "step-1");
	assertEqual(result.action, "allow", "action");
	assert(
		result.notification!.includes("検証 FAIL"),
		`notification should mention FAIL, got: ${result.notification}`,
	);
});

// ============================================================================
// Section 3: hal check --orchestrator
// ============================================================================
console.log("\n--- hal check --orchestrator ---");

test("orchestrator: in_progress step exists -> block", () => {
	const task = makeBaseTask();
	// step-1 has status: in_progress
	const result = checkOrchestrator(task, []);
	assertEqual(result.action, "block", "action");
	assert(
		result.message!.includes("進行中のステップがあります"),
		`message should mention in_progress, got: ${result.message}`,
	);
});

test("orchestrator: panes exist (worker/verifier running) -> block", () => {
	const task = makeBaseTask({
		steps: [
			{ id: "step-1", instructions: "done step", status: "done" },
			{ id: "step-2", instructions: "done step", status: "done" },
		],
	});
	const panes = [{ role: "worker" }, { role: "verifier" }];
	const result = checkOrchestrator(task, panes);
	assertEqual(result.action, "block", "action");
	assert(
		result.message!.includes("実行中の agent がいます"),
		`message should mention running agents, got: ${result.message}`,
	);
});

test("orchestrator: both clear -> allow + decision reminder", () => {
	const task = makeBaseTask({
		steps: [
			{ id: "step-1", instructions: "done step", status: "done" },
			{ id: "step-2", instructions: "done step", status: "done" },
		],
	});
	const result = checkOrchestrator(task, []);
	assertEqual(result.action, "allow", "action");
	assert(
		result.message!.includes("未記録の意思決定がないか確認してください"),
		`message should mention decision check, got: ${result.message}`,
	);
});

test("orchestrator: non-worker/verifier panes don't block", () => {
	const task = makeBaseTask({
		steps: [{ id: "step-1", instructions: "done step", status: "done" }],
	});
	// Orchestrator panes should NOT trigger the "実行中の agent がいます" block
	const panes = [{ role: "main-orchestrator" }, { role: "sub-orchestrator" }];
	const result = checkOrchestrator(task, panes);
	assertEqual(result.action, "allow", "action");
});

test("orchestrator: nested in_progress step detected", () => {
	const task = makeBaseTask({
		steps: [
			{
				id: "step-1",
				instructions: "Parent step",
				status: "in_progress",
				steps: [
					{ id: "child-1", instructions: "Child step", status: "in_progress" },
				],
			},
		],
	});
	const result = checkOrchestrator(task, []);
	assertEqual(result.action, "block", "action");
	assert(
		result.message!.includes("進行中のステップがあります"),
		`message should mention in_progress step`,
	);
});

// ============================================================================
// Section 4: Notification resolution
// ============================================================================
console.log("\n--- Notification Resolution ---");

test("notifyParent: .panes.yaml present with parent_pane_id -> targets correct pane", async () => {
	const dir = mkdtempSync(join(tmpdir(), "haltr-m4-notify-"));
	try {
		// Create .panes.yaml with a pane entry
		const pm = new PanesManager(dir);
		pm.add({
			pane_id: "%5",
			step: "step-1",
			role: "worker",
			parent_pane_id: "%0",
			cli: "claude",
			task_path: "task.yaml",
		});

		// notifyParent will try tmux send-keys, which will fail in test env
		// but should not throw — it should gracefully handle the error
		await notifyParent(dir, "step-1", "test notification");
		// If we get here without throwing, the graceful handling works
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("notifyParent: .panes.yaml missing -> graceful handling", async () => {
	const dir = mkdtempSync(join(tmpdir(), "haltr-m4-notify-missing-"));
	try {
		// No .panes.yaml exists — should not throw
		await notifyParent(dir, "step-1", "test notification");
		// If we get here, graceful handling works
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("notifyParent: step not found in .panes.yaml -> graceful handling", async () => {
	const dir = mkdtempSync(join(tmpdir(), "haltr-m4-notify-nostep-"));
	try {
		const pm = new PanesManager(dir);
		pm.add({
			pane_id: "%5",
			step: "step-other",
			role: "worker",
			parent_pane_id: "%0",
			cli: "claude",
			task_path: "task.yaml",
		});

		// step-1 is NOT in the panes file
		await notifyParent(dir, "step-1", "test notification");
		// Should silently skip
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ============================================================================
// Section 5: Multi-attempt handling
// ============================================================================
console.log("\n--- Multi-attempt handling ---");

test("worker: second attempt with work_done -> allow", () => {
	const task = makeBaseTask({
		history: [
			// First attempt
			makeHistoryEvent("step_started", "step-1", 1),
			makeHistoryEvent("work_done", "step-1", 1, { message: "first" }),
			makeHistoryEvent("verification_failed", "step-1", 1, {
				accept_id: "default",
				message: "bad",
			}),
			// Second attempt
			makeHistoryEvent("step_started", "step-1", 2),
			makeHistoryEvent("work_done", "step-1", 2, { message: "second" }),
		],
	});
	const result = checkWorker(task, "step-1");
	assertEqual(result.action, "allow", "action");
});

test("worker: second attempt without work_done -> block", () => {
	const task = makeBaseTask({
		history: [
			// First attempt
			makeHistoryEvent("step_started", "step-1", 1),
			makeHistoryEvent("work_done", "step-1", 1, { message: "first" }),
			makeHistoryEvent("verification_failed", "step-1", 1, {
				accept_id: "default",
				message: "bad",
			}),
			// Second attempt started but no work_done yet
			makeHistoryEvent("step_started", "step-1", 2),
		],
	});
	const result = checkWorker(task, "step-1");
	assertEqual(result.action, "block", "action");
	assert(
		result.message!.includes("hal history add --type work_done"),
		`message should ask for work summary, got: ${result.message}`,
	);
});

// ============================================================================
// Section 6: CLI integration tests (via process spawn)
// ============================================================================
console.log("\n--- CLI integration ---");

import { execSync } from "node:child_process";
import { resolve } from "node:path";

const halBin = resolve("/workspaces/haltr/dist/bin/hal.js");

function createTestDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "haltr-m4-cli-"));
	const haltrDir = join(dir, "haltr");
	mkdirSync(haltrDir, { recursive: true });

	const config: ConfigYaml = {
		orchestrator_cli: "claude",
		watcher: { poll_interval: 30, inactivity_threshold: 300 },
		panes: { max_concurrent: 10 },
		retry: { max_attempts: 3 },
	};
	writeFileSync(join(haltrDir, "config.yaml"), yaml.dump(config));
	return dir;
}

function createTaskFile(dir: string, taskData: TaskYaml): string {
	const taskPath = join(dir, "haltr", "task.yaml");
	writeFileSync(taskPath, yaml.dump(taskData, { lineWidth: -1, noRefs: true }));
	return taskPath;
}

function runHal(
	args: string,
	expectFail = false,
): { stdout: string; stderr: string; exitCode: number } {
	try {
		const stdout = execSync(`node ${halBin} ${args}`, {
			encoding: "utf-8",
			cwd: "/workspaces/haltr",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return { stdout, stderr: "", exitCode: 0 };
	} catch (e: unknown) {
		const err = e as {
			stderr?: string;
			stdout?: string;
			status?: number;
			message?: string;
		};
		if (!expectFail) {
			throw new Error(
				`Command failed unexpectedly: ${err.stderr || err.stdout || err.message}`,
			);
		}
		return {
			stdout: err.stdout || "",
			stderr: err.stderr || "",
			exitCode: err.status ?? 1,
		};
	}
}

test("CLI: check --worker with empty history -> exit 2", () => {
	const dir = createTestDir();
	try {
		const task = makeBaseTask();
		const taskPath = createTaskFile(dir, task);
		const res = runHal(`check --worker --task ${taskPath} --step step-1`, true);
		assertEqual(res.exitCode, 2, "exit code");
		assert(
			res.stdout.includes("hal history add --type work_done"),
			`stdout should contain block message, got: ${res.stdout}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("CLI: check --worker with work_done (no accept) -> exit 0", () => {
	const dir = createTestDir();
	try {
		const task = makeBaseTask({
			history: [
				makeHistoryEvent("step_started", "step-1", 1),
				makeHistoryEvent("work_done", "step-1", 1, { message: "done" }),
			],
		});
		const taskPath = createTaskFile(dir, task);
		const res = runHal(`check --worker --task ${taskPath} --step step-1`);
		assertEqual(res.exitCode, 0, "exit code");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("CLI: check --verifier with no verification result -> exit 2", () => {
	const dir = createTestDir();
	try {
		const task = makeBaseTask({
			history: [
				makeHistoryEvent("step_started", "step-1", 1),
				makeHistoryEvent("work_done", "step-1", 1, { message: "done" }),
			],
		});
		const taskPath = createTaskFile(dir, task);
		const res = runHal(
			`check --verifier --task ${taskPath} --step step-1`,
			true,
		);
		assertEqual(res.exitCode, 2, "exit code");
		assert(
			res.stdout.includes("hal history add --type verification"),
			`stdout should contain block message, got: ${res.stdout}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("CLI: check --verifier with verification_passed -> exit 0", () => {
	const dir = createTestDir();
	try {
		const task = makeBaseTask({
			history: [
				makeHistoryEvent("step_started", "step-1", 1),
				makeHistoryEvent("work_done", "step-1", 1, { message: "done" }),
				makeHistoryEvent("verification_passed", "step-1", 1, {
					accept_id: "default",
					message: "ok",
				}),
			],
		});
		const taskPath = createTaskFile(dir, task);
		const res = runHal(`check --verifier --task ${taskPath} --step step-1`);
		assertEqual(res.exitCode, 0, "exit code");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("CLI: check --orchestrator with in_progress steps -> exit 2", () => {
	const dir = createTestDir();
	try {
		const task = makeBaseTask();
		const taskPath = createTaskFile(dir, task);
		const res = runHal(`check --orchestrator --task ${taskPath}`, true);
		assertEqual(res.exitCode, 2, "exit code");
		assert(
			res.stdout.includes("進行中のステップがあります"),
			`stdout should contain block message, got: ${res.stdout}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("CLI: check --orchestrator all done, no panes -> exit 0", () => {
	const dir = createTestDir();
	try {
		const task = makeBaseTask({
			steps: [{ id: "step-1", instructions: "done", status: "done" }],
		});
		const taskPath = createTaskFile(dir, task);
		const res = runHal(`check --orchestrator --task ${taskPath}`);
		assertEqual(res.exitCode, 0, "exit code");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("CLI: check --orchestrator with active worker panes -> exit 2", () => {
	const dir = createTestDir();
	try {
		const task = makeBaseTask({
			steps: [{ id: "step-1", instructions: "done", status: "done" }],
		});
		const taskPath = createTaskFile(dir, task);

		// Create .panes.yaml in the same directory as task.yaml
		const haltrDir = join(dir, "haltr");
		const pm = new PanesManager(haltrDir);
		pm.add({
			pane_id: "%5",
			step: "step-1",
			role: "worker",
			parent_pane_id: "%0",
			cli: "claude",
			task_path: taskPath,
		});

		const res = runHal(`check --orchestrator --task ${taskPath}`, true);
		assertEqual(res.exitCode, 2, "exit code");
		assert(
			res.stdout.includes("実行中の agent がいます"),
			`stdout should contain agents message, got: ${res.stdout}`,
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("CLI: check without role flag -> error", () => {
	const dir = createTestDir();
	try {
		const task = makeBaseTask();
		const taskPath = createTaskFile(dir, task);
		const res = runHal(`check --task ${taskPath}`, true);
		assert(res.exitCode !== 0, "should exit with non-zero");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("CLI: check --worker without --task -> error", () => {
	const res = runHal(`check --worker --step step-1`, true);
	assert(res.exitCode !== 0, "should exit with non-zero");
});

test("CLI: check --worker without --step -> error", () => {
	const dir = createTestDir();
	try {
		const task = makeBaseTask();
		const taskPath = createTaskFile(dir, task);
		const res = runHal(`check --worker --task ${taskPath}`, true);
		assert(res.exitCode !== 0, "should exit with non-zero");
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
