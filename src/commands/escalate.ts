/**
 * `hal escalate` — convenience command that atomically:
 * 1. Sets the step's status to `blocked`
 * 2. Adds an `escalation` event to history
 * 3. Notifies parent orchestrator via tmux send-keys
 */

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as yaml from "js-yaml";
import { PanesManager } from "../lib/panes-manager.js";
import {
	findStep,
	loadConfig,
	resolveAttempt,
	resolveBy,
	validateStepTransition,
	validateTaskPath,
} from "../lib/task-utils.js";
import { tmuxSendKeys } from "../lib/tmux.js";
import { loadAndValidateTask } from "../lib/validator.js";
import type { HistoryEvent } from "../types.js";

export interface EscalateOptions {
	task: string;
	step: string;
	message: string;
}

/**
 * Core escalate logic, exported for testability.
 *
 * @param opts         command options
 * @param sendKeysFn   injectable tmux send-keys function (for mocking)
 * @param basePath     base path for .panes.yaml lookup (defaults to cwd)
 */
export async function handleEscalate(
	opts: EscalateOptions,
	sendKeysFn: (paneId: string, text: string) => Promise<void> = tmuxSendKeys,
	basePath?: string,
): Promise<void> {
	const { task: taskPath, step: stepPath, message } = opts;

	if (!message) {
		throw new Error("--message is required for escalate");
	}

	const resolvedPath = resolve(taskPath);
	validateTaskPath(resolvedPath);
	const taskYaml = loadAndValidateTask(resolvedPath);

	// Validate step exists
	const step = findStep(taskYaml.steps, stepPath);
	if (!step) {
		throw new Error(`Step not found: "${stepPath}"`);
	}

	// Check: caller must have a parent pane (escalate = report to parent)
	const currentPaneId = process.env.TMUX_PANE;
	if (currentPaneId) {
		const epicDir = dirname(resolvedPath);
		const pmCheck = new PanesManager(epicDir);
		const allPanes = pmCheck.load();
		const myPane = allPanes.find((p) => p.pane_id === currentPaneId);
		if (myPane && !myPane.parent_pane_id) {
			throw new Error(
				"エスカレート先がありません（親 pane がない）。worker に修正を指示するには hal send を使ってください:\n" +
					`  hal send --task '${taskPath}' --step '${stepPath}' --message '修正指示'`,
			);
		}
	}

	// 1. Transition status to blocked
	const currentStatus = step.status || "pending";
	validateStepTransition(currentStatus, "blocked");
	step.status = "blocked";

	// 2. Add escalation event to history
	const configYaml = loadConfig(resolvedPath);
	const history = taskYaml.history || [];
	const at = new Date().toISOString();
	const by = resolveBy("escalation", taskYaml, stepPath, configYaml);
	const attempt = resolveAttempt("escalation", history, stepPath);

	const event: Record<string, unknown> = {
		at,
		type: "escalation",
		by,
		step: stepPath,
		attempt,
		message,
	};

	history.push(event as unknown as HistoryEvent);
	taskYaml.history = history;

	// Write back atomically
	const yamlContent = yaml.dump(taskYaml, {
		lineWidth: -1,
		noRefs: true,
		quotingType: '"',
	});
	writeFileSync(resolvedPath, yamlContent);

	// 3. Notify parent orchestrator via tmux
	// Look up the pane's parent from .panes.yaml (in epic directory)
	const panesManager = new PanesManager(dirname(resolvedPath));
	const panes = panesManager.load();
	const pane = panes.find(
		(p) => p.step === stepPath && p.task_path === resolvedPath,
	);
	const parentPaneId = pane?.parent_pane_id;

	if (parentPaneId) {
		try {
			await sendKeysFn(parentPaneId, `${stepPath} blocked: ${message}`);
		} catch {
			// tmux may not be available — don't fail the command for notification
		}
	}

	console.log(`Escalated ${stepPath} to blocked: ${message}`);
}
