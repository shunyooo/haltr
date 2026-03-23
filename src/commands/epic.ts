import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";

/**
 * Format date as YYYYMMDD string.
 */
function formatDate(date: Date): string {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${y}${m}${d}`;
}

/**
 * Create a new epic directory under haltr/epics/.
 * Directory naming: {YYYYMMDD}-{NNN}_{name}
 * NNN is auto-incremented based on existing epics for the same date.
 *
 * Returns the created directory path.
 */
export function createEpic(baseDir: string, name: string, date?: Date): string {
	if (/[/\\]/.test(name) || name === "." || name === "..") {
		throw new Error("Epic name must not contain path separators");
	}

	const epicsDir = join(baseDir, "haltr", "epics");

	if (!existsSync(epicsDir)) {
		throw new Error("haltr/epics/ directory not found. Run 'hal init' first.");
	}

	const dateStr = formatDate(date ?? new Date());

	// Find existing epics for this date to determine next index
	const existing = readdirSync(epicsDir).filter((entry) =>
		entry.startsWith(`${dateStr}-`),
	);

	// Extract indices
	let maxIndex = 0;
	for (const entry of existing) {
		const match = entry.match(/^\d{8}-(\d{3})_/);
		if (match) {
			const idx = parseInt(match[1], 10);
			if (idx > maxIndex) {
				maxIndex = idx;
			}
		}
	}

	const nextIndex = String(maxIndex + 1).padStart(3, "0");
	const dirName = `${dateStr}-${nextIndex}_${name}`;
	const epicPath = join(epicsDir, dirName);

	mkdirSync(epicPath, { recursive: true });

	return epicPath;
}

/**
 * Find an epic directory by name suffix match.
 * E.g., "implement-auth" matches "20260319-001_implement-auth".
 * Returns the full directory path, or throws if not found / ambiguous.
 */
export function findEpicDir(baseDir: string, name: string): string {
	const epicsDir = join(baseDir, "haltr", "epics");

	if (!existsSync(epicsDir)) {
		throw new Error("haltr/epics/ directory not found. Run 'hal init' first.");
	}

	const entries = readdirSync(epicsDir);

	// Try exact match first (e.g., "20260319-001_todo-app")
	const exact = entries.find((entry) => entry === name);
	if (exact) {
		return join(epicsDir, exact);
	}

	// Then try suffix match (e.g., "todo-app" matches "20260319-001_todo-app")
	const matches = entries.filter((entry) => entry.endsWith(`_${name}`));

	if (matches.length === 0) {
		throw new Error(`No epic found matching name "${name}"`);
	}
	if (matches.length > 1) {
		throw new Error(
			`Multiple epics match name "${name}": ${matches.join(", ")}`,
		);
	}

	return join(epicsDir, matches[0]);
}

/**
 * List all epic directories (excluding archive/).
 * For each epic, finds the latest *_task.yaml and shows its status.
 *
 * Returns an array of { name, status } objects.
 */
export function listEpics(
	baseDir: string,
): Array<{ name: string; status: string }> {
	const epicsDir = join(baseDir, "haltr", "epics");

	if (!existsSync(epicsDir)) {
		throw new Error("haltr/epics/ directory not found. Run 'hal init' first.");
	}

	const entries = readdirSync(epicsDir).filter((entry) => {
		if (entry === "archive") return false;
		const fullPath = join(epicsDir, entry);
		try {
			return statSync(fullPath).isDirectory();
		} catch {
			return false;
		}
	});

	entries.sort();

	const result: Array<{ name: string; status: string }> = [];

	for (const entry of entries) {
		const epicPath = join(epicsDir, entry);
		const status = getEpicStatus(epicPath);
		result.push({ name: entry, status });
	}

	return result;
}

/**
 * Find the most recent epic directory (by name/date sort).
 * Returns { name, taskPath } or null if no epics exist.
 */
export function currentEpic(
	baseDir: string,
): { name: string; taskPath: string | null } | null {
	const epicsDir = join(baseDir, "haltr", "epics");

	if (!existsSync(epicsDir)) {
		throw new Error("haltr/epics/ directory not found. Run 'hal init' first.");
	}

	const entries = readdirSync(epicsDir).filter((entry) => {
		if (entry === "archive") return false;
		const fullPath = join(epicsDir, entry);
		try {
			return statSync(fullPath).isDirectory();
		} catch {
			return false;
		}
	});

	if (entries.length === 0) return null;

	entries.sort();
	const latest = entries[entries.length - 1];
	const epicPath = join(epicsDir, latest);
	const latestTask = findLatestTaskYamlInDir(epicPath);

	return {
		name: latest,
		taskPath: latestTask ? join(epicPath, latestTask) : null,
	};
}

/**
 * Archive an epic by moving it to haltr/epics/archive/.
 * Creates archive/ if it doesn't exist.
 * Errors if destination already exists.
 */
export function archiveEpic(baseDir: string, name: string): void {
	const epicsDir = join(baseDir, "haltr", "epics");

	if (!existsSync(epicsDir)) {
		throw new Error("haltr/epics/ directory not found. Run 'hal init' first.");
	}

	// Find the epic directory (exact name or suffix match)
	const entries = readdirSync(epicsDir).filter((entry) => {
		if (entry === "archive") return false;
		return entry === name || entry.endsWith(`_${name}`);
	});

	if (entries.length === 0) {
		throw new Error(`No epic found matching: "${name}"`);
	}
	if (entries.length > 1) {
		throw new Error(`Multiple epics match "${name}": ${entries.join(", ")}`);
	}

	const epicDirName = entries[0];
	const srcPath = join(epicsDir, epicDirName);
	const archiveDir = join(epicsDir, "archive");
	const destPath = join(archiveDir, epicDirName);

	if (existsSync(destPath)) {
		throw new Error(`Destination already exists: ${destPath}`);
	}

	// Create archive/ if needed
	if (!existsSync(archiveDir)) {
		mkdirSync(archiveDir, { recursive: true });
	}

	renameSync(srcPath, destPath);
}

// ---- Internal helpers ----

/**
 * Find the latest *_task.yaml in a directory.
 */
function findLatestTaskYamlInDir(dirPath: string): string | null {
	try {
		const entries = readdirSync(dirPath);
		const taskFiles = entries
			.filter((e) => e.match(/^\d{3}_task\.yaml$/))
			.sort();
		return taskFiles.length > 0 ? taskFiles[taskFiles.length - 1] : null;
	} catch {
		return null;
	}
}

/**
 * Get the status of an epic from its latest task.yaml.
 */
function getEpicStatus(epicPath: string): string {
	const latestTask = findLatestTaskYamlInDir(epicPath);
	if (!latestTask) return "no_task";

	try {
		const content = readFileSync(join(epicPath, latestTask), "utf-8");
		const data = yaml.load(content) as { status?: string } | null;
		return data?.status ?? "pending";
	} catch {
		return "unknown";
	}
}
