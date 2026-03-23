import { existsSync } from "node:fs";
import { HINTS } from "../lib/hints.js";
import { buildResponse, formatResponse } from "../lib/response-builder.js";
import { getCurrentTaskPath } from "../lib/session-manager.js";
import { findHaltrDir } from "../lib/task-utils.js";
import { loadAndValidateTask } from "../lib/validator.js";

/**
 * hal status
 *
 * Show the current task status, all steps, knowledge list, and hints.
 */
export function handleStatus(): void {
	const taskPath = getCurrentTaskPath();

	if (!existsSync(taskPath)) {
		throw new Error(`Task file not found: ${taskPath}`);
	}

	const task = loadAndValidateTask(taskPath);
	const haltrDir = findHaltrDir(taskPath);

	const steps = (task.steps ?? []).map((s) => ({
		id: s.id,
		goal: s.goal,
		status: s.status ?? "pending",
		accept: s.accept,
	}));

	const responseData: Record<string, unknown> = {
		task_path: taskPath,
		task_id: task.id,
		goal: task.goal,
		status: task.status ?? "pending",
		steps,
	};

	if (task.accept) {
		responseData.accept = task.accept;
	}

	if (task.plan) {
		responseData.plan = task.plan;
	}

	// Determine commands_hint based on state
	let commandsHint: string;
	const taskStatus = task.status ?? "pending";

	if (taskStatus === "done") {
		commandsHint = HINTS.STATUS_DONE;
	} else if (taskStatus === "pending") {
		if (steps.length === 0) {
			commandsHint = HINTS.STATUS_NO_STEPS;
		} else {
			commandsHint = HINTS.STATUS_PENDING;
		}
	} else {
		// in_progress or failed
		const currentStep = steps.find((s) => s.status === "in_progress");
		const nextPending = steps.find((s) => s.status === "pending");

		if (currentStep) {
			commandsHint = HINTS.STEP_IN_PROGRESS(currentStep.id);
		} else if (nextPending) {
			commandsHint = HINTS.STEP_DONE_NEXT(nextPending.id);
		} else {
			commandsHint = HINTS.STATUS_ADD_OR_CHECK;
		}
	}

	const response = buildResponse({
		status: "ok",
		message: `タスク状態: ${taskStatus}`,
		data: responseData,
		haltrDir,
		notes_prompt: HINTS.STATUS_NOTES,
		commands_hint: commandsHint,
	});

	console.log(formatResponse(response));
}
