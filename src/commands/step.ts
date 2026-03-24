import { readFileSync, writeFileSync } from "node:fs";
import * as yaml from "js-yaml";
import { HINTS } from "../lib/hints.js";
import { buildResponse, formatResponse } from "../lib/response-builder.js";
import { getSessionId, setSessionTask } from "../lib/session-manager.js";
import { findStep, resolveTaskFile } from "../lib/task-utils.js";
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
 */
export function handleStepAdd(opts: {
	file?: string;
	step: string;
	goal: string;
	accept?: string[];
	after?: string;
}): void {
	const taskPath = resolveTaskFile(opts.file);
	const task = loadAndValidateTask(taskPath);

	if (!task.steps) {
		task.steps = [];
	}

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

	if (opts.after) {
		const afterIndex = task.steps.findIndex((s) => s.id === opts.after);
		if (afterIndex === -1) {
			throw new Error(`--after で指定されたステップ "${opts.after}" が見つかりません`);
		}
		task.steps.splice(afterIndex + 1, 0, newStep);
	} else {
		task.steps.push(newStep);
	}

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

	validateTask(task);
	writeFileSync(taskPath, yaml.dump(task, { lineWidth: -1 }));

	const response = buildResponse({
		status: "ok",
		message: `ステップを追加しました: ${opts.step}`,
		data: {
			step_id: opts.step,
			goal: opts.goal,
			status: "pending",
		},
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
 */
export function handleStepAddBatch(opts: { file?: string }): void {
	const input = readStdin().trim();
	if (!input) {
		throw new Error("stdin からステップデータを読み取れませんでした");
	}

	const stepsInput = yaml.load(input) as StepInput[];
	if (!Array.isArray(stepsInput) || stepsInput.length === 0) {
		throw new Error("stdin は YAML 配列形式で指定してください");
	}

	const taskPath = resolveTaskFile(opts.file);
	const task = loadAndValidateTask(taskPath);

	if (!task.steps) {
		task.steps = [];
	}

	const now = new Date().toISOString();
	if (!task.history) {
		task.history = [];
	}

	const inputIds = new Set<string>();
	for (const stepInput of stepsInput) {
		if (!stepInput.id || !stepInput.goal) {
			throw new Error(`ステップには id と goal が必要です: ${JSON.stringify(stepInput)}`);
		}
		if (inputIds.has(stepInput.id)) {
			throw new Error(`入力内でステップ ID "${stepInput.id}" が重複しています`);
		}
		inputIds.add(stepInput.id);
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

		const event: HistoryEvent = {
			at: now,
			type: "step_added",
			step: stepInput.id,
			message: `Step added: ${stepInput.goal}`,
		};
		task.history.push(event);
	}

	validateTask(task);
	writeFileSync(taskPath, yaml.dump(task, { lineWidth: -1 }));

	const response = buildResponse({
		status: "ok",
		message: `${addedSteps.length} ステップを追加しました`,
		data: {
			added: addedSteps,
			steps: formatStepsList(task.steps),
		},
		commands_hint: HINTS.STEP_ADDED,
	});

	console.log(formatResponse(response));
}

/**
 * hal step start
 *
 * Start working on a step. Updates session mapping.
 */
export function handleStepStart(opts: { file?: string; step: string }): void {
	const taskPath = resolveTaskFile(opts.file);
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

	if (task.status === "pending" || !task.status) {
		task.status = "in_progress";
	}

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

	validateTask(task);
	writeFileSync(taskPath, yaml.dump(task, { lineWidth: -1 }));

	// Update session mapping (supports cross-session handoff)
	try {
		const sessionId = getSessionId();
		setSessionTask(sessionId, taskPath);
	} catch {
		// No session ID — skip mapping
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

	const response = buildResponse({
		status: "ok",
		message: `ステップを開始しました: ${opts.step}`,
		data: responseData,
		commands_hint: HINTS.STEP_STARTED,
	});

	console.log(formatResponse(response));
}

/**
 * hal step done
 */
export function handleStepDone(opts: {
	file?: string;
	step: string;
	result: string;
	message: string;
}): void {
	const result = opts.result.toUpperCase();
	if (result !== "PASS" && result !== "FAIL") {
		throw new Error("--result は PASS または FAIL を指定してください");
	}

	const taskPath = resolveTaskFile(opts.file);
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
		const event: HistoryEvent = {
			at: now,
			type: "step_failed",
			step: opts.step,
			message: opts.message,
		};
		task.history.push(event);
	}

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

	validateTask(task);
	writeFileSync(taskPath, yaml.dump(task, { lineWidth: -1 }));

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
		commands_hint: commandsHint,
	});

	console.log(formatResponse(response));
}

/**
 * hal step pause
 */
export function handleStepPause(opts: { file?: string; message: string }): void {
	const taskPath = resolveTaskFile(opts.file);
	const task = loadAndValidateTask(taskPath);

	const now = new Date().toISOString();
	if (!task.history) {
		task.history = [];
	}
	const event: HistoryEvent = {
		at: now,
		type: "paused",
		message: opts.message,
	};
	task.history.push(event);

	validateTask(task);
	writeFileSync(taskPath, yaml.dump(task, { lineWidth: -1 }));

	const currentStep = task.steps?.find((s) => s.status === "in_progress");

	const responseData: Record<string, unknown> = {
		task_status: task.status,
		paused: true,
	};

	if (currentStep) {
		responseData.current_step = currentStep.id;
		responseData.step_goal = currentStep.goal;
	}

	responseData.pause_reason = opts.message;

	const response = buildResponse({
		status: "ok",
		message: `作業を一時停止しました: ${opts.message}`,
		data: responseData,
		commands_hint: HINTS.STEP_PAUSED,
	});

	console.log(formatResponse(response));
}

/**
 * hal step resume
 */
export function handleStepResume(opts: { file?: string }): void {
	const taskPath = resolveTaskFile(opts.file);
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

	validateTask(task);
	writeFileSync(taskPath, yaml.dump(task, { lineWidth: -1 }));

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
		commands_hint: HINTS.STEP_RESUMED,
	});

	console.log(formatResponse(response));
}

/**
 * hal step verify
 */
export function handleStepVerify(opts: {
	file?: string;
	step: string;
	result: string;
	message: string;
}): void {
	const taskPath = resolveTaskFile(opts.file);
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

	step.verified = result === "PASS";

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

	validateTask(task);
	writeFileSync(taskPath, yaml.dump(task, { lineWidth: -1 }));

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
		commands_hint: result === "PASS"
			? HINTS.STEP_DONE_NEXT(opts.step)
			: HINTS.STEP_DONE_FAIL,
	});

	console.log(formatResponse(response));
}
