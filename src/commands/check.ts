/**
 * `hal check` — Stop hook gate.
 *
 * Used as a Stop Hook for Claude Code (and other CLI agents).
 * Reads session_id from stdin JSON (hooks pass JSON with session_id).
 *
 * Exit codes:
 *   0 = allow (agent can stop)
 *   2 = block (agent must continue)
 */

import { readFileSync } from "node:fs";
import { HINTS } from "../lib/hints.js";
import { buildResponse, formatResponse } from "../lib/response-builder.js";
import { getTaskPathForSession } from "../lib/session-manager.js";
import { findHaltrDir } from "../lib/task-utils.js";
import { loadAndValidateTask } from "../lib/validator.js";

/**
 * Handle the check command.
 * Reads session_id from stdin JSON.
 */
export function handleCheck(): void {
	// Read stdin JSON
	let stdinContent: string;
	try {
		stdinContent = readFileSync(0, "utf-8").trim();
	} catch {
		// No stdin — allow
		process.exit(0);
	}

	if (!stdinContent) {
		process.exit(0);
	}

	let stdinData: { session_id?: string };
	try {
		stdinData = JSON.parse(stdinContent);
	} catch {
		// Invalid JSON — allow
		process.exit(0);
	}

	const sessionId = stdinData.session_id;
	if (!sessionId) {
		// No session_id in stdin — allow
		process.exit(0);
	}

	// Look up task path for this session
	const taskPath = getTaskPathForSession(sessionId);
	if (!taskPath) {
		// No task mapping — allow stop
		process.exit(0);
	}

	let task: import("../types.js").TaskYaml;
	try {
		task = loadAndValidateTask(taskPath);
	} catch {
		// Can't load task — allow stop
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

	// Task status is pending (not started) or done — allow stop
	if (task.status === "pending" || task.status === "done") {
		process.exit(0);
	}

	// Otherwise — block with message about remaining steps
	const remainingSteps = steps.filter((s) => s.status !== "done");

	let haltrDir: string | undefined;
	try {
		haltrDir = findHaltrDir(taskPath);
	} catch {
		// Can't find haltr dir — proceed without context
	}

	const response = buildResponse({
		status: "blocked",
		message: "未完了のステップがあります",
		data: {
			task_goal: task.goal,
			task_status: task.status ?? "pending",
			remaining_steps: remainingSteps.map((s) => ({
				id: s.id,
				goal: s.goal,
				status: s.status ?? "pending",
			})),
		},
		haltrDir,
		commands_hint: HINTS.CHECK_BLOCKED,
	});

	console.log(formatResponse(response));
	process.exit(2);
}
