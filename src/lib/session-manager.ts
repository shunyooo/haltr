import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * Get the global sessions directory (~/.haltr/sessions/).
 */
function getSessionsDir(): string {
	return join(homedir(), ".haltr", "sessions");
}

/**
 * Get the current session ID from the HALTR_SESSION_ID environment variable.
 * Throws if not set.
 */
export function getSessionId(): string {
	const sessionId = process.env.HALTR_SESSION_ID;
	if (!sessionId) {
		throw new Error(
			"HALTR_SESSION_ID is not set. Run hal setup first",
		);
	}
	return sessionId;
}

/**
 * Save the session_id -> task path mapping.
 * Creates the sessions directory if it doesn't exist.
 */
export function setSessionTask(sessionId: string, taskPath: string): void {
	const sessionsDir = getSessionsDir();

	if (!existsSync(sessionsDir)) {
		mkdirSync(sessionsDir, { recursive: true });
	}

	const sessionFile = join(sessionsDir, sessionId);
	writeFileSync(sessionFile, taskPath, "utf-8");
}

/**
 * Try to get the task path for a given session ID.
 * Returns null if the session file doesn't exist (no mapping).
 */
export function getTaskPathForSession(sessionId: string): string | null {
	const sessionsDir = getSessionsDir();
	const sessionFile = join(sessionsDir, sessionId);

	if (!existsSync(sessionFile)) {
		return null;
	}

	try {
		const taskPath = readFileSync(sessionFile, "utf-8").trim();
		return taskPath || null;
	} catch {
		return null;
	}
}
