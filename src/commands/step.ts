import { writeFileSync } from "node:fs";
import * as yaml from "js-yaml";
import { buildResponse, formatResponse } from "../lib/response-builder.js";
import { getCurrentTaskPath } from "../lib/session-manager.js";
import { findHaltrDir, findStep } from "../lib/task-utils.js";
import { loadAndValidateTask, validateTask } from "../lib/validator.js";
import type { HistoryEvent, Step } from "../types.js";

/**
 * hal step add
 *
 * Add a new step to the current task.
 */
export function handleStepAdd(opts: {
	step: string;
	goal: string;
	accept?: string[];
	after?: string;
}): void {
	const taskPath = getCurrentTaskPath();
	const task = loadAndValidateTask(taskPath);

	if (!task.steps) {
		task.steps = [];
	}

	// Check for duplicate step ID
	const existing = findStep(task.steps, opts.step);
	if (existing) {
		throw new Error(`ステップ ID "${opts.step}" は既に存在します`);
	}

	const newStep: Step = {
		id: opts.step,
		goal: opts.goal,
		status: "pending",
	};

	if (opts.accept && opts.accept.length > 0) {
		newStep.accept = opts.accept.length === 1 ? opts.accept[0] : opts.accept;
	}

	// Insert step at the right position
	if (opts.after) {
		const afterIndex = task.steps.findIndex((s) => s.id === opts.after);
		if (afterIndex === -1) {
			throw new Error(`--after で指定されたステップ "${opts.after}" が見つかりません`);
		}
		task.steps.splice(afterIndex + 1, 0, newStep);
	} else {
		task.steps.push(newStep);
	}

	// Add history event
	const now = new Date().toISOString();
	if (!task.history) {
		task.history = [];
	}
	const event: HistoryEvent = {
		at: now,
		type: "step_added",
		step: opts.step,
		message: `Step added: ${opts.goal}`,
	};
	task.history.push(event);

	// Validate and save
	validateTask(task);
	writeFileSync(taskPath, yaml.dump(task, { lineWidth: -1 }));

	const haltrDir = findHaltrDir(taskPath);

	const response = buildResponse({
		status: "ok",
		message: `ステップを追加しました: ${opts.step}`,
		data: {
			step_id: opts.step,
			goal: opts.goal,
			status: "pending",
		},
		haltrDir,
		commands_hint:
			"hal step start --step <step-id> でステップを開始できます",
	});

	console.log(formatResponse(response));
}

/**
 * hal step start
 *
 * Start working on a step.
 */
export function handleStepStart(opts: { step: string }): void {
	const taskPath = getCurrentTaskPath();
	const task = loadAndValidateTask(taskPath);

	if (!task.steps) {
		task.steps = [];
	}

	const step = findStep(task.steps, opts.step);
	if (!step) {
		throw new Error(`ステップ "${opts.step}" が見つかりません`);
	}

	const currentStatus = step.status ?? "pending";
	if (currentStatus !== "pending" && currentStatus !== "failed") {
		throw new Error(
			`ステップ "${opts.step}" は現在 ${currentStatus} です。pending または failed のステップのみ start できます`,
		);
	}

	step.status = "in_progress";

	// Also set task to in_progress if still pending
	if (task.status === "pending" || !task.status) {
		task.status = "in_progress";
	}

	// Add history event
	const now = new Date().toISOString();
	if (!task.history) {
		task.history = [];
	}
	const event: HistoryEvent = {
		at: now,
		type: "step_started",
		step: opts.step,
	};
	task.history.push(event);

	// Validate and save
	validateTask(task);
	writeFileSync(taskPath, yaml.dump(task, { lineWidth: -1 }));

	const haltrDir = findHaltrDir(taskPath);

	// Load notes content if available
	let notesContent: string | undefined;
	if (task.notes) {
		notesContent = task.notes;
	}

	const responseData: Record<string, unknown> = {
		step_id: opts.step,
		step_goal: step.goal,
		step_status: "in_progress",
		task_goal: task.goal,
		task_status: task.status,
	};

	if (step.accept) {
		responseData.step_accept = step.accept;
	}

	if (notesContent) {
		responseData.notes = notesContent;
	}

	const response = buildResponse({
		status: "ok",
		message: `ステップを開始しました: ${opts.step}`,
		data: responseData,
		haltrDir,
		notes_prompt: "作業中に重要な発見や決定事項があれば hal task edit --notes '<notes>' --message '<reason>' で記録してください",
		commands_hint:
			"作業が完了したら hal step done --step <step-id> --result PASS で報告してください。問題があれば hal step done --step <step-id> --result FAIL --message '<reason>' で報告してください",
	});

	console.log(formatResponse(response));
}

/**
 * hal step done
 *
 * Mark a step as done (PASS) or record failure (FAIL).
 */
export function handleStepDone(opts: {
	step: string;
	result: string;
	message?: string;
}): void {
	const result = opts.result.toUpperCase();
	if (result !== "PASS" && result !== "FAIL") {
		throw new Error("--result は PASS または FAIL を指定してください");
	}

	const taskPath = getCurrentTaskPath();
	const task = loadAndValidateTask(taskPath);

	if (!task.steps) {
		task.steps = [];
	}

	const step = findStep(task.steps, opts.step);
	if (!step) {
		throw new Error(`ステップ "${opts.step}" が見つかりません`);
	}

	const currentStatus = step.status ?? "pending";
	if (currentStatus !== "in_progress") {
		throw new Error(
			`ステップ "${opts.step}" は現在 ${currentStatus} です。in_progress のステップのみ done にできます`,
		);
	}

	const now = new Date().toISOString();
	if (!task.history) {
		task.history = [];
	}

	if (result === "PASS") {
		step.status = "done";
		const event: HistoryEvent = {
			at: now,
			type: "step_done",
			step: opts.step,
			message: opts.message,
		};
		task.history.push(event);
	} else {
		// FAIL: keep as in_progress for retry
		const event: HistoryEvent = {
			at: now,
			type: "step_failed",
			step: opts.step,
			message: opts.message,
		};
		task.history.push(event);
	}

	// Check if all steps are done
	const allDone =
		task.steps.length > 0 &&
		task.steps.every((s) => s.status === "done");

	if (allDone) {
		task.status = "done";
		const completedEvent: HistoryEvent = {
			at: now,
			type: "completed",
			message: "All steps completed",
		};
		task.history.push(completedEvent);
	}

	// Validate and save
	validateTask(task);
	writeFileSync(taskPath, yaml.dump(task, { lineWidth: -1 }));

	const haltrDir = findHaltrDir(taskPath);

	const responseData: Record<string, unknown> = {
		step_id: opts.step,
		result,
		step_status: step.status,
		task_status: task.status,
	};

	if (opts.message) {
		responseData.message = opts.message;
	}

	let commandsHint: string;
	if (allDone) {
		commandsHint =
			"全ステップが完了しました。CCR (Context Carry-over Report) を作成して、次のタスクに引き継ぐ情報をまとめてください";
	} else if (result === "FAIL") {
		commandsHint =
			"失敗した内容を修正して、再度 hal step done --step <step-id> --result PASS で報告してください";
	} else {
		// Find next pending step
		const nextStep = task.steps.find((s) => (s.status ?? "pending") === "pending");
		if (nextStep) {
			commandsHint = `次のステップ: hal step start --step ${nextStep.id}`;
		} else {
			commandsHint = "hal status で残りのステップを確認してください";
		}
	}

	const response = buildResponse({
		status: "ok",
		message:
			result === "PASS"
				? `ステップ完了: ${opts.step}`
				: `ステップ失敗: ${opts.step}`,
		data: responseData,
		haltrDir,
		notes_prompt: "作業結果や重要な発見を hal task edit --notes '<notes>' --message '<reason>' で記録してください",
		commands_hint: commandsHint,
	});

	console.log(formatResponse(response));
}

/**
 * hal step pause
 *
 * Pause the current work (copilot mode).
 */
export function handleStepPause(): void {
	const taskPath = getCurrentTaskPath();
	const task = loadAndValidateTask(taskPath);

	const now = new Date().toISOString();
	if (!task.history) {
		task.history = [];
	}
	const event: HistoryEvent = {
		at: now,
		type: "paused",
		message: "Work paused",
	};
	task.history.push(event);

	// Validate and save
	validateTask(task);
	writeFileSync(taskPath, yaml.dump(task, { lineWidth: -1 }));

	const haltrDir = findHaltrDir(taskPath);

	// Find current in_progress step
	const currentStep = task.steps?.find((s) => s.status === "in_progress");

	const responseData: Record<string, unknown> = {
		task_status: task.status,
		paused: true,
	};

	if (currentStep) {
		responseData.current_step = currentStep.id;
		responseData.step_goal = currentStep.goal;
	}

	if (task.notes) {
		responseData.notes = task.notes;
	}

	const response = buildResponse({
		status: "ok",
		message: "作業を一時停止しました",
		data: responseData,
		haltrDir,
		commands_hint:
			"hal step resume で作業を再開できます",
	});

	console.log(formatResponse(response));
}

/**
 * hal step resume
 *
 * Resume paused work.
 */
export function handleStepResume(): void {
	const taskPath = getCurrentTaskPath();
	const task = loadAndValidateTask(taskPath);

	const now = new Date().toISOString();
	if (!task.history) {
		task.history = [];
	}
	const event: HistoryEvent = {
		at: now,
		type: "resumed",
		message: "Work resumed",
	};
	task.history.push(event);

	// Validate and save
	validateTask(task);
	writeFileSync(taskPath, yaml.dump(task, { lineWidth: -1 }));

	const haltrDir = findHaltrDir(taskPath);

	const response = buildResponse({
		status: "ok",
		message: "作業を再開しました",
		haltrDir,
		commands_hint:
			"hal status で現在の状態を確認できます。hal step done --step <step-id> --result PASS で完了を報告してください",
	});

	console.log(formatResponse(response));
}
