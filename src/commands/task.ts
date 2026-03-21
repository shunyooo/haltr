import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import * as yaml from "js-yaml";
import {
	loadConfig,
	validateTaskPath,
	validateTaskTransition,
} from "../lib/task-utils.js";
import { loadAndValidateTask, validateTask } from "../lib/validator.js";
import type { CreatedEvent, HistoryEvent, TaskYaml } from "../types.js";
import { findEpicDir } from "./epic.js";

function resolveOrchestratorBy(pathInHaltrTree: string): string {
	try {
		const config = loadConfig(pathInHaltrTree);
		return `orchestrator(${config.orchestrator_cli})`;
	} catch {
		return "orchestrator(claude)";
	}
}

/**
 * Scan an epic directory for all files matching NNN_* pattern and return
 * the next available index number.
 */
function getNextFileIndex(epicDir: string): number {
	const entries = readdirSync(epicDir);
	let maxIndex = 0;

	for (const entry of entries) {
		const match = entry.match(/^(\d{3})_/);
		if (match) {
			const idx = parseInt(match[1], 10);
			if (idx > maxIndex) {
				maxIndex = idx;
			}
		}
	}

	return maxIndex + 1;
}

/**
 * Find the most recent task.yaml file in an epic directory.
 * Returns the filename (e.g., "001_task.yaml") or null if none exist.
 */
function findLatestTaskYaml(epicDir: string): string | null {
	const entries = readdirSync(epicDir);
	const taskFiles = entries.filter((e) => e.match(/^\d{3}_task\.yaml$/)).sort();

	return taskFiles.length > 0 ? taskFiles[taskFiles.length - 1] : null;
}

/**
 * Create a new task.yaml in the specified epic directory.
 * Handles pivoting from previous task if one exists.
 *
 * Returns the path to the new task.yaml.
 */
export function createTask(baseDir: string, epicName: string): string {
	const epicDir = findEpicDir(baseDir, epicName);
	const nextIndex = getNextFileIndex(epicDir);
	const fileName = `${String(nextIndex).padStart(3, "0")}_task.yaml`;
	const filePath = join(epicDir, fileName);

	const now = new Date().toISOString();

	// Extract epic id from directory name (the part after NNN_)
	const epicDirName = basename(epicDir);
	const epicId = epicDirName.replace(/^\d{8}-\d{3}_/, "");

	// Read defaults from config
	let defaultWorker = "claude";
	let defaultVerifier = "codex";
	let defaultWorkerSession: "shared" | "per-step" | undefined;
	try {
		const config = loadConfig(filePath);
		defaultWorker = config.defaults?.worker ?? defaultWorker;
		defaultVerifier = config.defaults?.verifier ?? defaultVerifier;
		defaultWorkerSession = config.defaults?.worker_session;
	} catch {}

	const newTask: TaskYaml = {
		id: epicId,
		status: "pending",
		agents: {
			worker: defaultWorker,
			verifier: defaultVerifier,
		},
		worker_session: defaultWorkerSession,
		steps: [],
		context: "",
		history: [
			{
				at: now,
				type: "created",
				by: resolveOrchestratorBy(filePath),
				message: "Task created",
			},
		],
	};

	// Check for previous task.yaml
	const previousTaskFile = findLatestTaskYaml(epicDir);
	if (previousTaskFile) {
		newTask.previous = previousTaskFile;

		// Update the previous task: set status to pivoted and add pivoted event
		const previousPath = join(epicDir, previousTaskFile);
		const previousTask = loadAndValidateTask(previousPath);

		validateTaskTransition(previousTask.status || "pending", "pivoted");
		previousTask.status = "pivoted";
		if (!previousTask.history) {
			previousTask.history = [];
		}
		const pivotedEvent: HistoryEvent = {
			at: now,
			type: "pivoted",
			by: resolveOrchestratorBy(previousPath),
			message: "New task created",
			next_task: fileName,
		};
		previousTask.history.push(pivotedEvent);

		writeFileSync(previousPath, yaml.dump(previousTask, { lineWidth: -1 }));
	}

	writeFileSync(filePath, yaml.dump(newTask, { lineWidth: -1 }));

	return filePath;
}

/**
 * Edit a task.yaml file. For now, supports programmatic field updates
 * via --field and --value, or opens $EDITOR.
 *
 * After editing, adds an 'updated' event to history.
 */
export function editTask(
	taskPath: string,
	field?: string,
	value?: string,
): void {
	validateTaskPath(resolve(taskPath));

	if (!existsSync(taskPath)) {
		throw new Error(`Task file not found: ${taskPath}`);
	}

	const task = loadAndValidateTask(taskPath);

	if (field && value !== undefined) {
		// Whitelist of allowed fields for programmatic update
		const ALLOWED_FIELDS = new Set(["context", "id"]);
		const BLOCKED_FIELDS = new Set(["__proto__", "constructor", "prototype"]);

		if (!ALLOWED_FIELDS.has(field)) {
			throw new Error(
				`Field "${field}" is not allowed. Allowed fields: ${[...ALLOWED_FIELDS].join(", ")}`,
			);
		}
		// Defense-in-depth: block prototype pollution even if ALLOWED_FIELDS changes
		if (BLOCKED_FIELDS.has(field)) {
			throw new Error(`Field "${field}" is not allowed`);
		}

		// Programmatic update: set a whitelisted top-level field
		(task as unknown as Record<string, unknown>)[field] = value;
	}

	// Add updated event
	const now = new Date().toISOString();
	if (!task.history) {
		task.history = [];
	}
	task.history.push({
		at: now,
		type: "updated",
		by: resolveOrchestratorBy(taskPath),
	});

	writeFileSync(taskPath, yaml.dump(task, { lineWidth: -1 }));
}

/**
 * Write a task.yaml from stdin content.
 * Validates against schema before writing.
 * Preserves existing history and appends an 'updated' event.
 */
export function writeTask(taskPath: string, content: string): void {
	validateTaskPath(resolve(taskPath));

	// Parse and validate the incoming YAML
	const data = yaml.load(content);
	const validated = validateTask(data);

	// Apply config defaults for agents if not specified
	try {
		const config = loadConfig(taskPath);
		const defaults = config.defaults;
		if (defaults) {
			if (!validated.agents) {
				validated.agents = {};
			}
			if (!validated.agents.worker) {
				validated.agents.worker = defaults.worker;
			}
			if (!validated.agents.verifier) {
				validated.agents.verifier = defaults.verifier;
			}
		}
	} catch {}

	const now = new Date().toISOString();

	// If the file already exists, preserve history from the existing task
	if (existsSync(taskPath)) {
		const existing = loadAndValidateTask(taskPath);
		if (existing.history && existing.history.length > 0) {
			validated.history = existing.history;
		}
	}

	// Ensure created event exists
	if (!validated.history) {
		validated.history = [];
	}
	const hasCreated = validated.history.some((e) => e.type === "created");
	if (!hasCreated) {
		const createdEvent: CreatedEvent = {
			at: now,
			type: "created",
			by: resolveOrchestratorBy(taskPath),
			message: "Task created",
		};
		validated.history.unshift(createdEvent);
	}
	validated.history.push({
		at: now,
		type: "updated",
		by: resolveOrchestratorBy(taskPath),
	});

	writeFileSync(taskPath, yaml.dump(validated, { lineWidth: -1 }));
}
