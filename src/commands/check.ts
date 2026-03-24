/**
 * `hal check` — Stop hook gate.
 *
 * Exit codes:
 *   0 = allow (agent can stop)
 *   2 = block (agent must continue)
 */

import { readFileSync } from "node:fs";
import { HINTS } from "../lib/hints.js";
import { buildResponse, formatResponse } from "../lib/response-builder.js";
import { getTaskPathForSession } from "../lib/session-manager.js";
import { loadAndValidateTask } from "../lib/validator.js";

/**
 * Handle the check command.
 * Reads session_id from stdin JSON.
 */
export function handleCheck(): void {
	let stdinContent: string;
	try {
		stdinContent = readFileSync(0, "utf-8").trim();
	} catch {
		process.exit(0);
	}

	if (!stdinContent) {
		process.exit(0);
	}

	let stdinData: { session_id?: string };
	try {
		stdinData = JSON.parse(stdinContent);
	} catch {
		process.exit(0);
	}

	const sessionId = stdinData.session_id;
	if (!sessionId) {
		process.exit(0);
	}

	const taskPath = getTaskPathForSession(sessionId);
	if (!taskPath) {
		process.exit(0);
	}

	let task: import("../types.js").TaskYaml;
	try {
		task = loadAndValidateTask(taskPath);
	} catch {
		process.exit(0);
	}

	// Check if paused (copilot mode) — allow stop
	const lastHistoryEvent =
		task.history && task.history.length > 0
			? task.history[task.history.length - 1]
			: null;
	if (lastHistoryEvent?.type === "paused") {
		process.exit(0);
	}

	// Check if all steps are done — allow stop
	const steps = task.steps ?? [];
	const allDone =
		steps.length > 0 && steps.every((s) => s.status === "done");
	if (allDone) {
		process.exit(0);
	}

	// Task status is pending or done — allow stop
	if (task.status === "pending" || task.status === "done") {
		process.exit(0);
	}

	// Block — remaining steps
	const remainingSteps = steps.filter((s) => s.status !== "done");

	const response = buildResponse({
		status: "blocked",
		message: "Incomplete steps remain",
		data: {
			task_goal: task.goal,
			task_status: task.status ?? "pending",
			remaining_steps: remainingSteps.map((s) => ({
				id: s.id,
				goal: s.goal,
				status: s.status ?? "pending",
			})),
		},
		commands_hint: HINTS.CHECK_BLOCKED,
	});

	console.error(formatResponse(response));
	process.exit(2);
}
