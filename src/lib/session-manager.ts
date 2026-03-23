import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findHaltrDir } from "./task-utils.js";

/**
 * Get the sessions directory path within the haltr directory.
 */
function getSessionsDir(): string {
	const haltrDir = findHaltrDir(process.cwd());
	const sessionsDir = join(haltrDir, ".sessions");
	return sessionsDir;
}

/**
 * Get the current session ID from the HALTR_SESSION_ID environment variable.
 * Throws if not set.
 */
export function getSessionId(): string {
	const sessionId = process.env.HALTR_SESSION_ID;
	if (!sessionId) {
		throw new Error(
			"HALTR_SESSION_ID が設定されていません。SessionStart hook を確認してください",
		);
	}
	return sessionId;
}

/**
 * Resolve the task path from the current session.
 * Reads the session file from haltr/.sessions/<session_id>.
 * Throws if no session is set or no mapping exists.
 */
export function getCurrentTaskPath(): string {
	const sessionId = getSessionId();
	const sessionsDir = getSessionsDir();
	const sessionFile = join(sessionsDir, sessionId);

	if (!existsSync(sessionFile)) {
		throw new Error(
			`セッション ${sessionId} のタスクマッピングが見つかりません。hal task create でタスクを作成してください`,
		);
	}

	const taskPath = readFileSync(sessionFile, "utf-8").trim();
	if (!taskPath) {
		throw new Error(
			`セッション ${sessionId} のタスクパスが空です`,
		);
	}

	return taskPath;
}

/**
 * Save the session_id -> task path mapping.
 * Creates the .sessions directory if it doesn't exist.
 */
export function setSessionTask(taskPath: string): void {
	const sessionId = getSessionId();
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
 * Used by hal check which receives session_id from stdin.
 */
export function getTaskPathForSession(sessionId: string): string | null {
	try {
		const haltrDir = findHaltrDir(process.cwd());
		const sessionsDir = join(haltrDir, ".sessions");
		const sessionFile = join(sessionsDir, sessionId);

		if (!existsSync(sessionFile)) {
			return null;
		}

		const taskPath = readFileSync(sessionFile, "utf-8").trim();
		return taskPath || null;
	} catch {
		return null;
	}
}
