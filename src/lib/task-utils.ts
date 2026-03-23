import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { HaltrConfig, Step } from "../types.js";

/** Config file name */
const CONFIG_FILE = ".haltr.json";

/** Default directory name */
const DEFAULT_DIR = "work";

/**
 * Find .haltr.json by searching upward from the given directory.
 * Returns the parsed config and the directory containing the config file.
 */
export function findHaltrConfig(startPath: string): { config: HaltrConfig; projectDir: string } {
	const resolved = resolve(startPath);
	let dir: string;
	try {
		const stats = statSync(resolved);
		dir = stats.isDirectory() ? resolved : dirname(resolved);
	} catch {
		dir = dirname(resolved);
	}

	while (true) {
		const configPath = join(dir, CONFIG_FILE);
		if (existsSync(configPath)) {
			try {
				const content = readFileSync(configPath, "utf-8");
				const config = JSON.parse(content) as HaltrConfig;
				return { config, projectDir: dir };
			} catch {
				throw new Error(`Invalid ${CONFIG_FILE} at ${configPath}`);
			}
		}

		const parent = dirname(dir);
		if (parent === dir) {
			throw new Error(
				`Could not find ${CONFIG_FILE}. Run 'hal init' first.`,
			);
		}
		dir = parent;
	}
}

/**
 * Find the haltr directory by searching up for .haltr.json.
 * Returns the path to the haltr directory.
 *
 * @param path - A file path (e.g., task.yaml) or directory path
 * @param searchUpward - If true, search upward from the path. If false, only check the path itself.
 * @throws Error if haltr directory cannot be found
 */
export function findHaltrDir(path: string, searchUpward = true): string {
	const { config, projectDir } = findHaltrConfig(path);
	const haltrDir = join(projectDir, config.directory);

	if (!existsSync(haltrDir)) {
		throw new Error(
			`Haltr directory "${config.directory}" not found. Run 'hal init' first.`,
		);
	}

	return haltrDir;
}

/**
 * Load config from .haltr.json.
 */
export function loadConfig(path: string): HaltrConfig {
	const { config } = findHaltrConfig(path);
	return config;
}

/**
 * Validate that a resolved task path is within a haltr directory tree.
 * Checks that findHaltrDir can find the haltr directory from this path.
 * Throws an error if the path is not within a valid haltr tree.
 */
export function validateTaskPath(resolvedPath: string): void {
	const normalized = resolve(resolvedPath);
	try {
		findHaltrDir(normalized);
	} catch {
		throw new Error(
			`Invalid task path: "${resolvedPath}" is not within a haltr directory tree`,
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
 * Used for both task and step status changes.
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

/** @deprecated Use validateStatusTransition instead */
export const validateStepTransition = (
	currentStatus: string,
	newStatus: string,
): void => validateStatusTransition(currentStatus, newStatus, "step status");

/** @deprecated Use validateStatusTransition instead */
export const validateTaskTransition = (
	currentStatus: string,
	newStatus: string,
): void => validateStatusTransition(currentStatus, newStatus, "task status");

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
