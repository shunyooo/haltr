import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ConfigYaml, Step } from "../types.js";
import { loadAndValidateConfig } from "./validator.js";

/**
 * Validate that a resolved task path is within a haltr directory tree.
 * The resolved path must contain `/haltr/` somewhere in the path,
 * and must not contain path traversal sequences after resolution.
 * Throws an error if the path escapes the expected tree.
 */
export function validateTaskPath(resolvedPath: string): void {
	const normalized = resolve(resolvedPath);
	// path.resolve() already normalizes traversal sequences;
	// primary guard is /haltr/ check below
	// The path must be within a haltr/ directory tree
	if (!normalized.includes("/haltr/")) {
		throw new Error(
			`Invalid task path: "${resolvedPath}" is not within a haltr/ directory tree`,
		);
	}
}

/**
 * Find a step by id in a flat step array.
 * Returns the step or undefined if not found.
 */
export function findStep(steps: Step[], stepId: string): Step | undefined {
	return steps.find((s) => s.id === stepId);
}

/**
 * Find the haltr/ directory by searching up from the given path.
 * Accepts both file paths (e.g., task.yaml) and directory paths.
 * Returns the path to the haltr/ directory.
 *
 * @param path - A file path (e.g., task.yaml) or directory path
 * @param searchUpward - If true, search upward from the path. If false, only check the path itself.
 * @throws Error if haltr directory cannot be found
 */
export function findHaltrDir(path: string, searchUpward = true): string {
	const resolved = resolve(path);

	// Determine starting directory
	let dir: string;
	try {
		const stats = statSync(resolved);
		dir = stats.isDirectory() ? resolved : dirname(resolved);
	} catch {
		// If path doesn't exist, assume it's a file path and use its directory
		dir = dirname(resolved);
	}

	while (true) {
		// Check if this directory IS a haltr directory
		if (existsSync(join(dir, "config.yaml"))) {
			return dir;
		}

		// Check if haltr/ subdirectory exists
		const haltrSubDir = join(dir, "haltr");
		if (
			existsSync(haltrSubDir) &&
			existsSync(join(haltrSubDir, "config.yaml"))
		) {
			return haltrSubDir;
		}

		if (!searchUpward) {
			throw new Error(
				`Could not find haltr/ directory in ${path}. Run 'hal init' first.`,
			);
		}

		const parent = dirname(dir);
		if (parent === dir) {
			throw new Error(
				`Could not find haltr/ directory searching up from ${path}`,
			);
		}
		dir = parent;
	}
}

/**
 * Load config.yaml by searching upward from the task.yaml location
 * for a haltr/ directory containing config.yaml.
 */
export function loadConfig(taskPath: string): ConfigYaml {
	let dir = dirname(resolve(taskPath));

	// Walk upward to find haltr/ directory
	while (true) {
		// Check if this directory IS a haltr directory (contains config.yaml)
		try {
			const configPath = resolve(dir, "config.yaml");
			readFileSync(configPath, "utf-8");
			return loadAndValidateConfig(configPath);
		} catch {
			// not found here
		}

		// Check if parent/haltr/config.yaml exists
		try {
			const configPath = resolve(dir, "haltr", "config.yaml");
			readFileSync(configPath, "utf-8");
			return loadAndValidateConfig(configPath);
		} catch {
			// not found here
		}

		const parent = dirname(dir);
		if (parent === dir) {
			throw new Error(
				`Could not find haltr/config.yaml searching up from ${taskPath}`,
			);
		}
		dir = parent;
	}
}

/**
 * Valid step status values.
 */
const VALID_STEP_STATUSES = new Set([
	"pending",
	"in_progress",
	"done",
	"failed",
]);

/**
 * Valid task status values.
 */
const VALID_TASK_STATUSES = new Set([
	"pending",
	"in_progress",
	"done",
	"failed",
]);

/**
 * Allowed status transitions for steps.
 */
const STEP_TRANSITIONS: Record<string, Set<string>> = {
	pending: new Set(["in_progress"]),
	in_progress: new Set(["done", "failed"]),
	done: new Set(),
	failed: new Set(["in_progress"]),
};

/**
 * Allowed status transitions for tasks.
 */
const TASK_TRANSITIONS: Record<string, Set<string>> = {
	pending: new Set(["in_progress"]),
	in_progress: new Set(["done", "failed"]),
	done: new Set(),
	failed: new Set(["in_progress"]),
};

/**
 * Validate a step status transition.
 */
export function validateStepTransition(
	currentStatus: string,
	newStatus: string,
): void {
	if (!VALID_STEP_STATUSES.has(newStatus)) {
		throw new Error(`Invalid step status: "${newStatus}"`);
	}

	const current = currentStatus || "pending";
	const allowed = STEP_TRANSITIONS[current];
	if (!allowed || !allowed.has(newStatus)) {
		throw new Error(`Invalid status transition: ${current} -> ${newStatus}`);
	}
}

/**
 * Validate a task status transition.
 */
export function validateTaskTransition(
	currentStatus: string,
	newStatus: string,
): void {
	if (!VALID_TASK_STATUSES.has(newStatus)) {
		throw new Error(`Invalid task status: "${newStatus}"`);
	}

	const current = currentStatus || "pending";
	const allowed = TASK_TRANSITIONS[current];
	if (!allowed || !allowed.has(newStatus)) {
		throw new Error(`Invalid status transition: ${current} -> ${newStatus}`);
	}
}

/**
 * Resolve task.yaml path from a session ID.
 * Session ID is expected to be set via HALTR_SESSION_ID env var.
 * The task path is: <haltr_dir>/tasks/<sessionId>/task.yaml
 *
 * @param sessionId - The session ID (from HALTR_SESSION_ID)
 * @param haltrDir - Path to the haltr directory
 * @returns Resolved absolute path to task.yaml
 */
export function resolveTaskPath(sessionId: string, haltrDir: string): string {
	if (!sessionId) {
		throw new Error(
			"Session ID is required. Set HALTR_SESSION_ID environment variable.",
		);
	}
	return resolve(haltrDir, "tasks", sessionId, "task.yaml");
}
