import { readFileSync, writeFileSync } from "node:fs";
import * as yaml from "js-yaml";
import { HINTS } from "../lib/hints.js";
import { buildResponse, formatResponse } from "../lib/response-builder.js";
import { getCurrentTaskPath } from "../lib/session-manager.js";
import { findHaltrDir, findStep } from "../lib/task-utils.js";
import { loadAndValidateTask, validateTask } from "../lib/validator.js";
import type { HistoryEvent, Step, TaskYaml } from "../types.js";

/**
 * Read stdin synchronously (for YAML input).
 */
function readStdin(): string {
	try {
		return readFileSync(0, "utf-8");
	} catch {
		return "";
	}
}

/**
 * Format steps list for output.
 */
function formatStepsList(steps: Step[]): Array<{
	id: string;
	goal: string;
	status: string;
	accept?: string | string[];
}> {
	return steps.map((s) => {
		const result: {
			id: string;
			goal: string;
			status: string;
			accept?: string | string[];
		} = {
			id: s.id,
			goal: s.goal,
			status: s.status ?? "pending",
		};
		if (s.accept) {
			result.accept = s.accept;
		}
		return result;
	});
}

/**
 * hal step add (single step mode)
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
		commands_hint: HINTS.STEP_ADDED,
	});

	console.log(formatResponse(response));
}

/**
 * Input format for batch step add.
 */
interface StepInput {
	id: string;
	goal: string;
	accept?: string | string[];
}

/**
 * hal step add --stdin (batch mode)
 *
 * Add multiple steps from stdin YAML.
 */
export function handleStepAddBatch(): void {
	const input = readStdin().trim();
	if (!input) {
		throw new Error("stdin からステップデータを読み取れませんでした");
	}

	const stepsInput = yaml.load(input) as StepInput[];
	if (!Array.isArray(stepsInput) || stepsInput.length === 0) {
		throw new Error("stdin は YAML 配列形式で指定してください");
	}

	const taskPath = getCurrentTaskPath();
	const task = loadAndValidateTask(taskPath);

	if (!task.steps) {
		task.steps = [];
	}

	const now = new Date().toISOString();
	if (!task.history) {
		task.history = [];
	}

	// Pre-validate: check for duplicates in input and existing steps
	const inputIds = new Set<string>();
	for (const stepInput of stepsInput) {
		if (!stepInput.id || !stepInput.goal) {
			throw new Error(`ステップには id と goal が必要です: ${JSON.stringify(stepInput)}`);
		}
		// Check duplicate within input
		if (inputIds.has(stepInput.id)) {
			throw new Error(`入力内でステップ ID "${stepInput.id}" が重複しています`);
		}
		inputIds.add(stepInput.id);
		// Check duplicate with existing steps
		const existing = findStep(task.steps, stepInput.id);
		if (existing) {
			throw new Error(`ステップ ID "${stepInput.id}" は既に存在します`);
		}
	}

	const addedSteps: string[] = [];

	for (const stepInput of stepsInput) {

		const newStep: Step = {
			id: stepInput.id,
			goal: stepInput.goal,
			status: "pending",
		};

		if (stepInput.accept) {
			newStep.accept = stepInput.accept;
		}

		task.steps.push(newStep);
		addedSteps.push(stepInput.id);

		// Add history event
		const event: HistoryEvent = {
			at: now,
			type: "step_added",
			step: stepInput.id,
			message: `Step added: ${stepInput.goal}`,
		};
		task.history.push(event);
	}

	// Validate and save
	validateTask(task);
	writeFileSync(taskPath, yaml.dump(task, { lineWidth: -1 }));

	const haltrDir = findHaltrDir(taskPath);

	const response = buildResponse({
		status: "ok",
		message: `${addedSteps.length} ステップを追加しました`,
		data: {
			added: addedSteps,
			steps: formatStepsList(task.steps),
		},
		haltrDir,
		commands_hint: HINTS.STEP_ADDED,
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

	const response = buildResponse({
		status: "ok",
		message: `ステップを開始しました: ${opts.step}`,
		data: responseData,
		haltrDir,
		notes_prompt: HINTS.STATUS_NOTES_IN_PROGRESS,
		commands_hint: HINTS.STEP_STARTED,
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
	message: string;
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

	// Check verification status (only required if accept criteria exist)
	if (result === "PASS" && step.accept && !step.verified) {
		throw new Error(
			`ステップ "${opts.step}" は未検証です。先にサブエージェントで hal step verify --step ${opts.step} --result PASS|FAIL を実行してください`,
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
		commandsHint = HINTS.STEP_DONE_ALL;
	} else if (result === "FAIL") {
		commandsHint = HINTS.STEP_DONE_FAIL;
	} else {
		// Find next pending step
		const nextStep = task.steps.find((s) => (s.status ?? "pending") === "pending");
		if (nextStep) {
			commandsHint = HINTS.STEP_DONE_NEXT(nextStep.id);
		} else {
			commandsHint = HINTS.STEP_DONE_CHECK_STATUS;
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
		notes_prompt: HINTS.STATUS_NOTES_DONE,
		commands_hint: commandsHint,
	});

	console.log(formatResponse(response));
}

/**
 * hal step pause
 *
 * Pause the current work (copilot mode).
 */
export function handleStepPause({ message }: { message: string }): void {
	const taskPath = getCurrentTaskPath();
	const task = loadAndValidateTask(taskPath);

	const now = new Date().toISOString();
	if (!task.history) {
		task.history = [];
	}
	const event: HistoryEvent = {
		at: now,
		type: "paused",
		message,
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

	responseData.pause_reason = message;

	const response = buildResponse({
		status: "ok",
		message: `作業を一時停止しました: ${message}`,
		data: responseData,
		haltrDir,
		commands_hint: HINTS.STEP_PAUSED,
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

	// Find current in_progress step(s)
	const inProgressSteps = (task.steps ?? []).filter((s) => s.status === "in_progress");
	const pendingSteps = (task.steps ?? []).filter((s) => s.status === "pending" || !s.status);

	const data: Record<string, unknown> = {
		task_status: task.status ?? "pending",
	};

	if (inProgressSteps.length > 0) {
		data.current_step = {
			id: inProgressSteps[0].id,
			goal: inProgressSteps[0].goal,
		};
	} else if (pendingSteps.length > 0) {
		data.next_step = {
			id: pendingSteps[0].id,
			goal: pendingSteps[0].goal,
		};
	}

	data.steps = formatStepsList(task.steps ?? []);

	const response = buildResponse({
		status: "ok",
		message: "作業を再開しました",
		data,
		haltrDir,
		commands_hint: HINTS.STEP_RESUMED,
	});

	console.log(formatResponse(response));
}

/**
 * hal step verify
 *
 * Record verification result for a step.
 * Called by a verify agent (not the executor).
 */
export function handleStepVerify(opts: {
	step: string;
	result: string;
	message: string;
}): void {
	const taskPath = getCurrentTaskPath();
	const task = loadAndValidateTask(taskPath);

	if (!task.steps || task.steps.length === 0) {
		throw new Error("タスクにステップがありません");
	}

	const step = findStep(task.steps, opts.step);
	if (!step) {
		throw new Error(`ステップ "${opts.step}" が見つかりません`);
	}

	const result = opts.result.toUpperCase();
	if (result !== "PASS" && result !== "FAIL") {
		throw new Error('result は PASS または FAIL を指定してください');
	}

	// Update verified flag
	step.verified = result === "PASS";

	// Add history event
	const now = new Date().toISOString();
	if (!task.history) {
		task.history = [];
	}
	const event: HistoryEvent = {
		at: now,
		type: "step_verified",
		step: opts.step,
		result: result as "PASS" | "FAIL",
		message: opts.message,
	};
	task.history.push(event);

	// Validate and save
	validateTask(task);
	writeFileSync(taskPath, yaml.dump(task, { lineWidth: -1 }));

	const haltrDir = findHaltrDir(taskPath);

	const response = buildResponse({
		status: "ok",
		message: result === "PASS"
			? `検証完了: ステップ ${opts.step} は PASS`
			: `検証失敗: ステップ ${opts.step} は FAIL`,
		data: {
			step_id: opts.step,
			result,
			verified: step.verified,
		},
		haltrDir,
		commands_hint: result === "PASS"
			? HINTS.STEP_DONE_NEXT(opts.step)
			: HINTS.STEP_DONE_FAIL,
	});

	console.log(formatResponse(response));
}
