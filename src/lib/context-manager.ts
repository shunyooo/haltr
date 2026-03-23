import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";

// ---- Types ----

export interface ContextEntry {
	id: string;
	type: "skill" | "knowledge";
	description: string;
	path: string;
}

export interface ContextHistoryEvent {
	at: string; // ISO timestamp
	type:
		| "created"
		| "used"
		| "updated"
		| "confirmed"
		| "deprecated"
		| "promoted"
		| "deleted";
	epic?: string;
	task?: string;
	step?: string;
	context?: string; // usage context description
	message?: string;
}

const DEFAULT_STALENESS_DAYS = 90;

// ---- Index operations ----

/**
 * Load context/index.yaml.
 * Returns an empty array if the file doesn't exist or is empty.
 */
export function loadIndex(haltrDir: string): ContextEntry[] {
	const indexPath = join(haltrDir, "context", "index.yaml");
	if (!existsSync(indexPath)) {
		return [];
	}

	try {
		const content = readFileSync(indexPath, "utf-8");
		const data = yaml.load(content);
		if (Array.isArray(data)) {
			return data as ContextEntry[];
		}
		return [];
	} catch {
		return [];
	}
}

/**
 * Save entries to context/index.yaml.
 */
export function saveIndex(haltrDir: string, entries: ContextEntry[]): void {
	const contextDir = join(haltrDir, "context");
	if (!existsSync(contextDir)) {
		mkdirSync(contextDir, { recursive: true });
	}
	const indexPath = join(contextDir, "index.yaml");
	writeFileSync(indexPath, yaml.dump(entries, { lineWidth: -1, noRefs: true }));
}

// ---- History operations ----

/**
 * Load context/history.yaml.
 * Returns an empty object if the file doesn't exist or is empty.
 */
export function loadHistory(
	haltrDir: string,
): Record<string, ContextHistoryEvent[]> {
	const historyPath = join(haltrDir, "context", "history.yaml");
	if (!existsSync(historyPath)) {
		return {};
	}

	try {
		const content = readFileSync(historyPath, "utf-8");
		const data = yaml.load(content);
		if (data && typeof data === "object" && !Array.isArray(data)) {
			return data as Record<string, ContextHistoryEvent[]>;
		}
		return {};
	} catch {
		return {};
	}
}

/**
 * Save history to context/history.yaml.
 */
export function saveHistory(
	haltrDir: string,
	history: Record<string, ContextHistoryEvent[]>,
): void {
	const contextDir = join(haltrDir, "context");
	if (!existsSync(contextDir)) {
		mkdirSync(contextDir, { recursive: true });
	}
	const historyPath = join(contextDir, "history.yaml");
	writeFileSync(
		historyPath,
		yaml.dump(history, { lineWidth: -1, noRefs: true }),
	);
}

/**
 * Add a history event for an entry.
 * Automatically sets the 'at' timestamp.
 */
export function addHistoryEvent(
	haltrDir: string,
	id: string,
	event: Omit<ContextHistoryEvent, "at">,
): void {
	const history = loadHistory(haltrDir);
	if (!history[id]) {
		history[id] = [];
	}

	const fullEvent: ContextHistoryEvent = {
		at: new Date().toISOString(),
		...event,
	};

	history[id].push(fullEvent);
	saveHistory(haltrDir, history);
}

// ---- Entry operations ----

/**
 * Find an entry by id in the entries array.
 */
export function findEntry(
	entries: ContextEntry[],
	id: string,
): ContextEntry | undefined {
	return entries.find((e) => e.id === id);
}

/**
 * Get the content of a skill/knowledge file.
 * Reads the file at entry.path relative to haltrDir.
 */
export function getContent(haltrDir: string, entry: ContextEntry): string {
	const filePath = join(haltrDir, entry.path);
	if (!existsSync(filePath)) {
		throw new Error(`Content file not found: ${filePath}`);
	}
	return readFileSync(filePath, "utf-8");
}

/**
 * Create a new context entry.
 * Creates the directory and empty file, adds to index, records 'created' event.
 * Returns the path to the created file (relative to haltrDir).
 */
export function createEntry(
	haltrDir: string,
	type: "skill" | "knowledge",
	id: string,
	description: string,
): string {
	const entries = loadIndex(haltrDir);

	// Check for duplicate
	if (findEntry(entries, id)) {
		throw new Error(`Context entry "${id}" already exists`);
	}

	// Create directory and file
	const subDir = type === "skill" ? "skills" : "knowledge";
	const fileName = type === "skill" ? "SKILL.md" : "README.md";
	const dirPath = join(haltrDir, "context", subDir, id);
	const filePath = join(dirPath, fileName);
	const relativePath = `context/${subDir}/${id}/${fileName}`;

	mkdirSync(dirPath, { recursive: true });
	writeFileSync(filePath, "");

	// Add entry to index
	const newEntry: ContextEntry = {
		id,
		type,
		description,
		path: relativePath,
	};
	entries.push(newEntry);
	saveIndex(haltrDir, entries);

	// Record created event
	addHistoryEvent(haltrDir, id, {
		type: "created",
		message: `Created ${type}: ${description}`,
	});

	return relativePath;
}

/**
 * Delete a context entry.
 * Removes the directory, removes from index, records 'deleted' event.
 */
export function deleteEntry(
	haltrDir: string,
	id: string,
	reason: string,
): void {
	const entries = loadIndex(haltrDir);
	const entry = findEntry(entries, id);

	if (!entry) {
		throw new Error(`Context entry "${id}" not found`);
	}

	// Delete the directory
	const subDir = entry.type === "skill" ? "skills" : "knowledge";
	const dirPath = join(haltrDir, "context", subDir, id);
	if (existsSync(dirPath)) {
		rmSync(dirPath, { recursive: true, force: true });
	}

	// Remove from index
	const filtered = entries.filter((e) => e.id !== id);
	saveIndex(haltrDir, filtered);

	// Record deleted event
	addHistoryEvent(haltrDir, id, {
		type: "deleted",
		message: reason,
	});
}

// ---- Staleness check ----

/**
 * Check if an entry might be stale.
 * An entry is stale if its last used/confirmed/updated/promoted event
 * is older than thresholdDays (default: 90).
 */
export function checkStaleness(
	haltrDir: string,
	id: string,
	thresholdDays?: number,
): { stale: boolean; lastActivity?: string; daysSince?: number } {
	const threshold = thresholdDays ?? DEFAULT_STALENESS_DAYS;
	const history = loadHistory(haltrDir);
	const events = history[id];

	if (!events || events.length === 0) {
		return { stale: true };
	}

	// Find the most recent activity event
	const activityTypes = new Set([
		"created",
		"used",
		"updated",
		"confirmed",
		"promoted",
	]);
	const activityEvents = events.filter((e) => activityTypes.has(e.type));

	if (activityEvents.length === 0) {
		return { stale: true };
	}

	// Get the latest activity timestamp
	const lastEvent = activityEvents[activityEvents.length - 1];
	const lastDate = new Date(lastEvent.at);
	const now = new Date();
	const daysSince = Math.floor(
		(now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24),
	);

	return {
		stale: daysSince >= threshold,
		lastActivity: lastEvent.at,
		daysSince,
	};
}
