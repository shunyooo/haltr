import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Step } from "../types.js";
import { getTaskPathForSession } from "./session-manager.js";

/**
 * Resolve the task file path using a 3-level fallback:
 * 1. Explicit --file option
 * 2. Session mapping (HALTR_SESSION_ID -> ~/.haltr/sessions/)
 * 3. Auto-detect from current directory (task.yaml or *.task.yaml)
 */
export function resolveTaskFile(file?: string): string {
	// 1. Explicit --file
	if (file) {
		const resolved = resolve(file);
		if (!existsSync(resolved)) {
			throw new Error(`タスクファイルが見つかりません: ${resolved}`);
		}
		return resolved;
	}

	// 2. Session mapping
	const sessionId = process.env.HALTR_SESSION_ID;
	if (sessionId) {
		const mapped = getTaskPathForSession(sessionId);
		if (mapped && existsSync(mapped)) {
			return mapped;
		}
	}

	// 3. Auto-detect from current directory
	const detected = detectTaskFile(process.cwd());
	if (detected) {
		return detected;
	}

	throw new Error(
		"タスクファイルが見つかりません。--file で指定してください",
	);
}

/**
 * Detect a task file in the given directory.
 * Looks for task.yaml first, then *.task.yaml.
 * Returns null if no task file is found.
 */
function detectTaskFile(dir: string): string | null {
	// Check for task.yaml
	const taskYaml = resolve(dir, "task.yaml");
	if (existsSync(taskYaml)) {
		return taskYaml;
	}

	// Check for *.task.yaml
	try {
		const entries = readdirSync(dir);
		const taskFiles = entries.filter((e) => e.endsWith(".task.yaml"));
		if (taskFiles.length === 1) {
			return resolve(dir, taskFiles[0]);
		}
		if (taskFiles.length > 1) {
			throw new Error(
				`複数のタスクファイルが見つかりました: ${taskFiles.join(", ")}。--file で指定してください`,
			);
		}
	} catch (e) {
		if (e instanceof Error && e.message.includes("複数のタスクファイル")) {
			throw e;
		}
	}

	return null;
}

/**
 * Find a step by id in a flat step array.
 */
export function findStep(steps: Step[], stepId: string): Step | undefined {
	return steps.find((s) => s.id === stepId);
}

/**
 * Valid status values (unified for tasks and steps).
 */
const VALID_STATUSES = new Set(["pending", "in_progress", "done", "failed"]);

/**
 * Allowed status transitions (unified for tasks and steps).
 */
const STATUS_TRANSITIONS: Record<string, Set<string>> = {
	pending: new Set(["in_progress"]),
	in_progress: new Set(["done", "failed"]),
	done: new Set(),
	failed: new Set(["in_progress"]),
};

/**
 * Validate a status transition.
 */
export function validateStatusTransition(
	currentStatus: string,
	newStatus: string,
	label = "status",
): void {
	if (!VALID_STATUSES.has(newStatus)) {
		throw new Error(`Invalid ${label}: "${newStatus}"`);
	}

	const current = currentStatus || "pending";
	const allowed = STATUS_TRANSITIONS[current];
	if (!allowed || !allowed.has(newStatus)) {
		throw new Error(`Invalid status transition: ${current} -> ${newStatus}`);
	}
}
