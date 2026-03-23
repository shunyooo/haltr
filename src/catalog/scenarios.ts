/**
 * Message Catalog Scenarios
 *
 * Defines all command + state combinations for documentation.
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
	category: "task" | "step" | "status" | "check" | "context";
	setup: (ctx: ScenarioContext) => void;
	run: (ctx: ScenarioContext) => void;
}

export interface ScenarioContext {
	tmpDir: string;
	haltrDir: string;
	epicDir: string;
	taskPath: string;
}

/**
 * Create a fresh scenario context with temp directories.
 */
export function createContext(): ScenarioContext {
	const tmpDir = join("/tmp", `hal-catalog-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const haltrDir = join(tmpDir, "haltr");
	const epicDir = join(haltrDir, "epics", "test-epic");
	const taskPath = join(epicDir, "001_task.yaml");

	mkdirSync(join(haltrDir, "epics", "test-epic"), { recursive: true });
	mkdirSync(join(haltrDir, "context"), { recursive: true });

	// Create minimal config
	writeFileSync(join(haltrDir, "config.yaml"), yaml.dump({ timezone: "Asia/Tokyo" }));

	// Create context index
	writeFileSync(join(haltrDir, "context", "index.yaml"), yaml.dump([]));

	return { tmpDir, haltrDir, epicDir, taskPath };
}

/**
 * Clean up scenario context.
 */
export function cleanupContext(ctx: ScenarioContext): void {
	rmSync(ctx.tmpDir, { recursive: true, force: true });
}

/**
 * Create a basic task file.
 */
export function createTask(
	ctx: ScenarioContext,
	overrides: Record<string, unknown> = {},
): void {
	const task = {
		id: "test-001",
		goal: "テスト用タスク",
		status: "pending",
		history: [{ at: new Date().toISOString(), type: "created" }],
		...overrides,
	};
	writeFileSync(ctx.taskPath, yaml.dump(task, { lineWidth: -1 }));
}

// ============================================================
// Scenario Definitions
// ============================================================

export const scenarios: Scenario[] = [
	// ---- Task Commands ----
	{
		id: "task-create",
		name: "hal task create",
		description: "新規タスク作成",
		category: "task",
		setup: () => {
			// No task exists yet - but we need an epic dir
		},
		run: () => {
			handleTaskCreate({ goal: "新機能を実装する", accept: ["テストが通る", "ドキュメント更新"] });
		},
	},
	{
		id: "task-edit",
		name: "hal task edit",
		description: "タスクのゴール更新",
		category: "task",
		setup: (ctx) => {
			createTask(ctx);
		},
		run: () => {
			handleTaskEdit({ goal: "OAuth2を使用してユーザー認証を実装する", message: "OAuth2採用に伴いゴール更新" });
		},
	},

	// ---- Step Commands ----
	{
		id: "step-add",
		name: "hal step add",
		description: "ステップ追加",
		category: "step",
		setup: (ctx) => {
			createTask(ctx);
		},
		run: () => {
			handleStepAdd({ step: "impl", goal: "機能を実装する", accept: ["コンパイル通る"] });
		},
	},
	{
		id: "step-start",
		name: "hal step start",
		description: "ステップ開始",
		category: "step",
		setup: (ctx) => {
			createTask(ctx, {
				steps: [{ id: "impl", goal: "機能を実装する", status: "pending" }],
			});
		},
		run: () => {
			handleStepStart({ step: "impl" });
		},
	},
	{
		id: "step-verify-pass",
		name: "hal step verify (PASS)",
		description: "検証成功",
		category: "step",
		setup: (ctx) => {
			createTask(ctx, {
				status: "in_progress",
				steps: [{ id: "impl", goal: "機能を実装する", status: "in_progress" }],
			});
		},
		run: () => {
			handleStepVerify({ step: "impl", result: "PASS", message: "全テストが通過、accept条件を満たしている" });
		},
	},
	{
		id: "step-verify-fail",
		name: "hal step verify (FAIL)",
		description: "検証失敗",
		category: "step",
		setup: (ctx) => {
			createTask(ctx, {
				status: "in_progress",
				steps: [{ id: "impl", goal: "機能を実装する", status: "in_progress" }],
			});
		},
		run: () => {
			handleStepVerify({ step: "impl", result: "FAIL", message: "テストが2件失敗している" });
		},
	},
	{
		id: "step-done-pass",
		name: "hal step done (PASS)",
		description: "ステップ完了 (次のステップあり)",
		category: "step",
		setup: (ctx) => {
			createTask(ctx, {
				status: "in_progress",
				steps: [
					{ id: "impl", goal: "機能を実装する", status: "in_progress", verified: true },
					{ id: "test", goal: "テスト追加", status: "pending" },
				],
			});
		},
		run: () => {
			handleStepDone({ step: "impl", result: "PASS", message: "実装完了、全テスト通過" });
		},
	},
	{
		id: "step-done-all-complete",
		name: "hal step done (all complete)",
		description: "全ステップ完了時",
		category: "step",
		setup: (ctx) => {
			createTask(ctx, {
				status: "in_progress",
				steps: [{ id: "impl", goal: "機能を実装する", status: "in_progress", verified: true }],
			});
		},
		run: () => {
			handleStepDone({ step: "impl", result: "PASS", message: "実装完了" });
		},
	},
	{
		id: "step-pause",
		name: "hal step pause",
		description: "対話モードへ切替",
		category: "step",
		setup: (ctx) => {
			createTask(ctx, {
				status: "in_progress",
				steps: [{ id: "impl", goal: "機能を実装する", status: "in_progress" }],
			});
		},
		run: () => {
			handleStepPause({ message: "ユーザーから設計方針について質問があった" });
		},
	},
	{
		id: "step-resume",
		name: "hal step resume",
		description: "タスク作業再開",
		category: "step",
		setup: (ctx) => {
			createTask(ctx, {
				status: "in_progress",
				steps: [{ id: "impl", goal: "機能を実装する", status: "in_progress" }],
				history: [
					{ at: new Date().toISOString(), type: "created" },
					{ at: new Date().toISOString(), type: "paused", message: "ユーザー質問" },
				],
			});
		},
		run: () => {
			handleStepResume();
		},
	},

	// ---- Status Command ----
	{
		id: "status-pending",
		name: "hal status (pending)",
		description: "タスク未開始",
		category: "status",
		setup: (ctx) => {
			createTask(ctx, {
				steps: [{ id: "impl", goal: "実装", status: "pending" }],
			});
		},
		run: () => {
			handleStatus();
		},
	},
	{
		id: "status-in-progress",
		name: "hal status (in_progress)",
		description: "タスク実行中",
		category: "status",
		setup: (ctx) => {
			createTask(ctx, {
				status: "in_progress",
				steps: [
					{ id: "impl", goal: "実装", status: "done", verified: true },
					{ id: "test", goal: "テスト", status: "in_progress" },
				],
			});
		},
		run: () => {
			handleStatus();
		},
	},
	{
		id: "status-done",
		name: "hal status (done)",
		description: "タスク完了",
		category: "status",
		setup: (ctx) => {
			createTask(ctx, {
				status: "done",
				steps: [{ id: "impl", goal: "実装", status: "done", verified: true }],
			});
		},
		run: () => {
			handleStatus();
		},
	},

	// ---- Check Command (simulated output) ----
	{
		id: "check-allow-no-task",
		name: "hal check (no task)",
		description: "タスクなし → 通過",
		category: "check",
		setup: () => {
			// No task
		},
		run: () => {
			console.log(JSON.stringify({
				status: "allow",
				message: "対話モードです",
				commands_hint: "対話モードです。複数ステップの作業が必要な場合は hal task create でタスクを作成してください",
			}, null, 2));
		},
	},
	{
		id: "check-allow-pending",
		name: "hal check (pending)",
		description: "タスク未開始 → 通過",
		category: "check",
		setup: (ctx) => {
			createTask(ctx);
		},
		run: () => {
			console.log(JSON.stringify({
				status: "allow",
				message: "タスクは未開始です",
			}, null, 2));
		},
	},
	{
		id: "check-block",
		name: "hal check (in_progress)",
		description: "タスク実行中 → ブロック",
		category: "check",
		setup: (ctx) => {
			createTask(ctx, {
				status: "in_progress",
				steps: [{ id: "impl", goal: "実装", status: "in_progress" }],
			});
		},
		run: () => {
			console.log(JSON.stringify({
				status: "block",
				message: "未完了のステップがあります",
				data: { current_step: "impl", step_goal: "実装" },
				commands_hint: "未完了のステップがあります。タスク作業を続行してください。ユーザーから対話のリクエストがあった場合は hal step pause --message '<理由>' で一時停止してください",
			}, null, 2));
		},
	},
	{
		id: "check-allow-done",
		name: "hal check (done)",
		description: "タスク完了 → 通過",
		category: "check",
		setup: (ctx) => {
			createTask(ctx, { status: "done" });
		},
		run: () => {
			console.log(JSON.stringify({
				status: "allow",
				message: "タスクは完了しています",
			}, null, 2));
		},
	},
];
