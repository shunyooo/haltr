/**
 * Message Catalog Scenarios
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import {
	handleStepAdd,
	handleStepDone,
	handleStepPause,
	handleStepResume,
	handleStepStart,
	handleStepVerify,
} from "../commands/step.js";
import { handleStatus } from "../commands/status.js";
import { handleTaskCreate, handleTaskEdit } from "../commands/task.js";

export interface Scenario {
	id: string;
	name: string;
	description: string;
	category: "task" | "step" | "status" | "check";
	setup: (ctx: ScenarioContext) => void;
	run: (ctx: ScenarioContext) => void;
}

export interface ScenarioContext {
	tmpDir: string;
	taskPath: string;
}

export function createContext(): ScenarioContext {
	const tmpDir = join("/tmp", `hal-catalog-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const taskPath = join(tmpDir, "task.yaml");
	mkdirSync(tmpDir, { recursive: true });
	return { tmpDir, taskPath };
}

export function cleanupContext(ctx: ScenarioContext): void {
	rmSync(ctx.tmpDir, { recursive: true, force: true });
}

export function createTask(
	ctx: ScenarioContext,
	overrides: Record<string, unknown> = {},
): void {
	const task = {
		id: "test-001",
		goal: "Test task",
		status: "pending",
		history: [{ at: new Date().toISOString(), type: "created" }],
		...overrides,
	};
	writeFileSync(ctx.taskPath, yaml.dump(task, { lineWidth: -1 }));
}

export const scenarios: Scenario[] = [
	// ---- Task Commands ----
	{
		id: "task-create",
		name: "hal task create",
		description: "Create new task",
		category: "task",
		setup: () => {},
		run: (ctx) => {
			handleTaskCreate({ file: join(ctx.tmpDir, "new-task.yaml"), goal: "Implement new feature", accept: ["Tests pass", "Docs updated"] });
		},
	},
	{
		id: "task-edit",
		name: "hal task edit",
		description: "Update task goal",
		category: "task",
		setup: (ctx) => {
			createTask(ctx);
		},
		run: (ctx) => {
			handleTaskEdit({ file: ctx.taskPath, goal: "Implement OAuth2 user authentication", message: "Switched to OAuth2" });
		},
	},

	// ---- Step Commands ----
	{
		id: "step-add",
		name: "hal step add",
		description: "Add step",
		category: "step",
		setup: (ctx) => {
			createTask(ctx);
		},
		run: (ctx) => {
			handleStepAdd({ file: ctx.taskPath, step: "impl", goal: "Implement feature", accept: ["Compiles"] });
		},
	},
	{
		id: "step-start",
		name: "hal step start",
		description: "Start step",
		category: "step",
		setup: (ctx) => {
			createTask(ctx, {
				steps: [{ id: "impl", goal: "Implement feature", status: "pending" }],
			});
		},
		run: (ctx) => {
			handleStepStart({ file: ctx.taskPath, step: "impl" });
		},
	},
	{
		id: "step-verify-pass",
		name: "hal step verify (PASS)",
		description: "Verification passed",
		category: "step",
		setup: (ctx) => {
			createTask(ctx, {
				status: "in_progress",
				steps: [{ id: "impl", goal: "Implement feature", status: "in_progress" }],
			});
		},
		run: (ctx) => {
			handleStepVerify({ file: ctx.taskPath, step: "impl", result: "PASS", message: "All tests pass, accept criteria met" });
		},
	},
	{
		id: "step-verify-fail",
		name: "hal step verify (FAIL)",
		description: "Verification failed",
		category: "step",
		setup: (ctx) => {
			createTask(ctx, {
				status: "in_progress",
				steps: [{ id: "impl", goal: "Implement feature", status: "in_progress" }],
			});
		},
		run: (ctx) => {
			handleStepVerify({ file: ctx.taskPath, step: "impl", result: "FAIL", message: "2 tests failing" });
		},
	},
	{
		id: "step-done-pass",
		name: "hal step done (PASS)",
		description: "Step completed (next step exists)",
		category: "step",
		setup: (ctx) => {
			createTask(ctx, {
				status: "in_progress",
				steps: [
					{ id: "impl", goal: "Implement feature", status: "in_progress", verified: true },
					{ id: "test", goal: "Add tests", status: "pending" },
				],
			});
		},
		run: (ctx) => {
			handleStepDone({ file: ctx.taskPath, step: "impl", result: "PASS", message: "Implementation complete, all tests pass" });
		},
	},
	{
		id: "step-done-all-complete",
		name: "hal step done (all complete)",
		description: "All steps completed",
		category: "step",
		setup: (ctx) => {
			createTask(ctx, {
				status: "in_progress",
				steps: [{ id: "impl", goal: "Implement feature", status: "in_progress", verified: true }],
			});
		},
		run: (ctx) => {
			handleStepDone({ file: ctx.taskPath, step: "impl", result: "PASS", message: "Implementation complete" });
		},
	},
	{
		id: "step-pause",
		name: "hal step pause",
		description: "Switch to dialogue mode",
		category: "step",
		setup: (ctx) => {
			createTask(ctx, {
				status: "in_progress",
				steps: [{ id: "impl", goal: "Implement feature", status: "in_progress" }],
			});
		},
		run: (ctx) => {
			handleStepPause({ file: ctx.taskPath, message: "User asked about design approach" });
		},
	},
	{
		id: "step-resume",
		name: "hal step resume",
		description: "Resume task work",
		category: "step",
		setup: (ctx) => {
			createTask(ctx, {
				status: "in_progress",
				steps: [{ id: "impl", goal: "Implement feature", status: "in_progress" }],
				history: [
					{ at: new Date().toISOString(), type: "created" },
					{ at: new Date().toISOString(), type: "paused", message: "User question" },
				],
			});
		},
		run: (ctx) => {
			handleStepResume({ file: ctx.taskPath });
		},
	},

	// ---- Status Command ----
	{
		id: "status-pending",
		name: "hal status (pending)",
		description: "Task not started",
		category: "status",
		setup: (ctx) => {
			createTask(ctx, {
				steps: [{ id: "impl", goal: "Implement", status: "pending" }],
			});
		},
		run: (ctx) => {
			handleStatus({ file: ctx.taskPath });
		},
	},
	{
		id: "status-in-progress",
		name: "hal status (in_progress)",
		description: "Task in progress",
		category: "status",
		setup: (ctx) => {
			createTask(ctx, {
				status: "in_progress",
				steps: [
					{ id: "impl", goal: "Implement", status: "done", verified: true },
					{ id: "test", goal: "Test", status: "in_progress" },
				],
			});
		},
		run: (ctx) => {
			handleStatus({ file: ctx.taskPath });
		},
	},
	{
		id: "status-done",
		name: "hal status (done)",
		description: "Task completed",
		category: "status",
		setup: (ctx) => {
			createTask(ctx, {
				status: "done",
				steps: [{ id: "impl", goal: "Implement", status: "done", verified: true }],
			});
		},
		run: (ctx) => {
			handleStatus({ file: ctx.taskPath });
		},
	},

	// ---- Check Command (simulated output) ----
	{
		id: "check-allow-no-task",
		name: "hal check (no task)",
		description: "No task -> allow",
		category: "check",
		setup: () => {},
		run: () => {
			console.log(JSON.stringify({
				status: "allow",
				message: "Dialogue mode",
				commands_hint: "Dialogue mode. If multi-step work is needed, create a task with hal task create",
			}, null, 2));
		},
	},
	{
		id: "check-allow-pending",
		name: "hal check (pending)",
		description: "Task not started -> allow",
		category: "check",
		setup: (ctx) => {
			createTask(ctx);
		},
		run: () => {
			console.log(JSON.stringify({
				status: "allow",
				message: "Task not started",
			}, null, 2));
		},
	},
	{
		id: "check-block",
		name: "hal check (in_progress)",
		description: "Task in progress -> block",
		category: "check",
		setup: (ctx) => {
			createTask(ctx, {
				status: "in_progress",
				steps: [{ id: "impl", goal: "Implement", status: "in_progress" }],
			});
		},
		run: () => {
			console.log(JSON.stringify({
				status: "block",
				message: "Incomplete steps remain",
				data: { current_step: "impl", step_goal: "Implement" },
				commands_hint: "Incomplete steps remain. Continue task work. If the user requests dialogue, use hal step pause --message '<reason>'",
			}, null, 2));
		},
	},
	{
		id: "check-allow-done",
		name: "hal check (done)",
		description: "Task completed -> allow",
		category: "check",
		setup: (ctx) => {
			createTask(ctx, { status: "done" });
		},
		run: () => {
			console.log(JSON.stringify({
				status: "allow",
				message: "Task is complete",
			}, null, 2));
		},
	},
];
