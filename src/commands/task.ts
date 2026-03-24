import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";
import { HINTS } from "../lib/hints.js";
import { buildResponse, formatResponse } from "../lib/response-builder.js";
import { getSessionId, setSessionTask } from "../lib/session-manager.js";
import { resolveTaskFile } from "../lib/task-utils.js";
import { loadAndValidateTask, validateTask } from "../lib/validator.js";
import type { HistoryEvent, TaskYaml } from "../types.js";

/**
 * hal task create --file <name> --goal '<goal>'
 */
export function handleTaskCreate(opts: {
	file: string;
	goal: string;
	accept?: string[];
	plan?: string;
}): void {
	const filePath = resolve(opts.file);

	if (existsSync(filePath)) {
		throw new Error(`File already exists: ${filePath}`);
	}

	const taskId = opts.file.replace(/\.(task\.)?ya?ml$/, "");

	const now = new Date().toISOString();

	const newTask: TaskYaml = {
		id: taskId,
		goal: opts.goal,
		status: "pending",
		steps: [],
		history: [
			{
				at: now,
				type: "created",
				message: "Task created",
			},
		],
	};

	if (opts.accept && opts.accept.length > 0) {
		newTask.accept = opts.accept.length === 1 ? opts.accept[0] : opts.accept;
	}

	if (opts.plan) {
		newTask.plan = opts.plan;
	}

	validateTask(newTask);
	writeFileSync(filePath, yaml.dump(newTask, { lineWidth: -1 }));

	try {
		const sessionId = getSessionId();
		setSessionTask(sessionId, filePath);
	} catch {
		// No session ID — skip mapping
	}

	const response = buildResponse({
		status: "ok",
		message: `Task created: ${filePath}`,
		data: {
			task_path: filePath,
			task_id: taskId,
			goal: opts.goal,
			status: "pending",
		},
		commands_hint: HINTS.TASK_CREATED,
	});

	console.log(formatResponse(response));
}

/**
 * hal task edit
 */
export function handleTaskEdit(opts: {
	file?: string;
	goal?: string;
	accept?: string[];
	plan?: string;
	message: string;
}): void {
	const taskPath = resolveTaskFile(opts.file);

	const task = loadAndValidateTask(taskPath);
	const changes: string[] = [];

	if (opts.goal !== undefined) {
		task.goal = opts.goal;
		changes.push("goal");
	}

	if (opts.accept !== undefined && opts.accept.length > 0) {
		task.accept = opts.accept.length === 1 ? opts.accept[0] : opts.accept;
		changes.push("accept");
	}

	if (opts.plan !== undefined) {
		task.plan = opts.plan;
		changes.push("plan");
	}

	if (changes.length === 0) {
		throw new Error("No fields specified to update");
	}

	const now = new Date().toISOString();
	if (!task.history) {
		task.history = [];
	}
	const event: HistoryEvent = {
		at: now,
		type: "updated",
		message: `${opts.message} (changed: ${changes.join(", ")})`,
	};
	task.history.push(event);

	validateTask(task);
	writeFileSync(taskPath, yaml.dump(task, { lineWidth: -1 }));

	const response = buildResponse({
		status: "ok",
		message: `Task updated: ${changes.join(", ")}`,
		data: {
			task_path: taskPath,
			updated_fields: changes,
		},
		commands_hint: HINTS.TASK_UPDATED,
	});

	console.log(formatResponse(response));
}
