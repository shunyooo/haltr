import {
	existsSync,
	mkdirSync,
	readdirSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import * as yaml from "js-yaml";
import { HINTS } from "../lib/hints.js";
import { buildResponse, formatResponse } from "../lib/response-builder.js";
import {
	getCurrentTaskPath,
	setSessionTask,
} from "../lib/session-manager.js";
import { findHaltrDir } from "../lib/task-utils.js";
import { loadAndValidateTask, validateTask } from "../lib/validator.js";
import type { HistoryEvent, TaskYaml } from "../types.js";

/**
 * Find the current (latest) epic directory.
 * Returns the path to the most recent epic dir under haltr/epics/.
 */
function findCurrentEpicDir(haltrDir: string): string {
	const epicsDir = join(haltrDir, "epics");

	if (!existsSync(epicsDir)) {
		throw new Error(
			"haltr/epics/ directory not found. Run 'hal init' first.",
		);
	}

	const entries = readdirSync(epicsDir)
		.filter((entry) => {
			if (entry === "archive") return false;
			const fullPath = join(epicsDir, entry);
			try {
				return statSync(fullPath).isDirectory();
			} catch {
				return false;
			}
		})
		.sort();

	if (entries.length === 0) {
		throw new Error(
			"No epics found. Run 'hal epic create <name>' first.",
		);
	}

	return join(epicsDir, entries[entries.length - 1]);
}

/**
 * Generate the next task filename in an epic directory.
 * Scans existing NNN_task.yaml files and returns the next sequence number.
 */
function getNextTaskFilename(epicDir: string): string {
	const entries = readdirSync(epicDir);
	let maxIndex = 0;

	for (const entry of entries) {
		const match = entry.match(/^(\d{3})_task\.yaml$/);
		if (match) {
			const idx = parseInt(match[1], 10);
			if (idx > maxIndex) {
				maxIndex = idx;
			}
		}
	}

	const nextIndex = String(maxIndex + 1).padStart(3, "0");
	return `${nextIndex}_task.yaml`;
}

/**
 * hal task create
 *
 * Creates a new task in the current epic directory.
 */
export function handleTaskCreate(opts: {
	goal: string;
	accept?: string[];
	plan?: string;
}): void {
	const haltrDir = findHaltrDir(process.cwd());
	const epicDir = findCurrentEpicDir(haltrDir);
	const fileName = getNextTaskFilename(epicDir);
	const filePath = join(epicDir, fileName);

	const epicDirName = basename(epicDir);
	const taskId = `${epicDirName.replace(/^\d{8}-\d{3}_/, "")}-${fileName.replace("_task.yaml", "")}`;

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

	// Validate before writing
	validateTask(newTask);

	mkdirSync(epicDir, { recursive: true });
	writeFileSync(filePath, yaml.dump(newTask, { lineWidth: -1 }));

	// Save session -> task mapping
	setSessionTask(filePath);

	const response = buildResponse({
		status: "ok",
		message: `タスクを作成しました: ${filePath}`,
		data: {
			task_path: filePath,
			task_id: taskId,
			goal: opts.goal,
			status: "pending",
		},
		haltrDir,
		commands_hint: HINTS.TASK_CREATED,
	});

	console.log(formatResponse(response));
}

/**
 * hal task edit
 *
 * Edit the current task's fields.
 */
export function handleTaskEdit(opts: {
	goal?: string;
	accept?: string[];
	plan?: string;
	message: string;
}): void {
	const taskPath = getCurrentTaskPath();

	if (!existsSync(taskPath)) {
		throw new Error(`Task file not found: ${taskPath}`);
	}

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
		throw new Error("変更するフィールドが指定されていません");
	}

	// Add updated event to history
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

	// Validate and save
	validateTask(task);
	writeFileSync(taskPath, yaml.dump(task, { lineWidth: -1 }));

	const haltrDir = findHaltrDir(taskPath);

	const response = buildResponse({
		status: "ok",
		message: `タスクを更新しました: ${changes.join(", ")}`,
		data: {
			task_path: taskPath,
			updated_fields: changes,
		},
		haltrDir,
		commands_hint: HINTS.TASK_UPDATED,
	});

	console.log(formatResponse(response));
}
