import { existsSync } from "node:fs";
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

	if (task.notes) {
		responseData.notes = task.notes;
	}

	// Determine commands_hint based on state
	let commandsHint: string;
	const taskStatus = task.status ?? "pending";

	if (taskStatus === "done") {
		commandsHint = "タスクは完了しています。CCR を作成してください";
	} else if (taskStatus === "pending") {
		if (steps.length === 0) {
			commandsHint =
				"hal step add --step <step-id> --goal '<goal>' でステップを追加してください";
		} else {
			commandsHint =
				"hal step start --step <step-id> でステップを開始してください";
		}
	} else {
		// in_progress or failed
		const currentStep = steps.find((s) => s.status === "in_progress");
		const nextPending = steps.find((s) => s.status === "pending");

		if (currentStep) {
			commandsHint = `現在のステップ: ${currentStep.id}。完了したら hal step done --step ${currentStep.id} --result PASS で報告してください`;
		} else if (nextPending) {
			commandsHint = `次のステップ: hal step start --step ${nextPending.id}`;
		} else {
			commandsHint = "hal step add で新しいステップを追加するか、残りの作業を確認してください";
		}
	}

	const response = buildResponse({
		status: "ok",
		message: `タスク状態: ${taskStatus}`,
		data: responseData,
		haltrDir,
		notes_prompt: "重要な情報があれば hal task edit --notes '<notes>' --message '<reason>' で記録してください",
		commands_hint: commandsHint,
	});

	console.log(formatResponse(response));
}
