/**
 * Session management commands.
 *
 * hal          → interactive session picker (attach/new)
 * hal new      → start new session
 * hal ls       → list sessions
 * hal attach   → attach to existing session
 * hal stop     → stop session(s)
 *
 * Session naming: haltr-<epic-name> (or haltr-<timestamp> before epic is created)
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as readline from "node:readline";
import {
  tmuxListSessions,
  tmuxKillSession,
  tmuxSessionExists,
} from "../lib/tmux.js";
import { readWatcherPid, removeWatcherPid } from "../lib/watcher.js";

const SESSION_PREFIX = "haltr-";

/**
 * List all haltr sessions with their status.
 */
export async function listSessions(): Promise<
  Array<{ name: string; epicName: string; display: string }>
> {
  const sessions = await tmuxListSessions(SESSION_PREFIX);
  return sessions.map((name) => {
    const epicName = name.replace(SESSION_PREFIX, "");
    return {
      name,
      epicName,
      display: `${epicName}`,
    };
  });
}

/**
 * Generate a temporary session name (before epic is created).
 */
export function generateSessionName(): string {
  const ts = Date.now().toString(36);
  return `${SESSION_PREFIX}${ts}`;
}

/**
 * Get the session name for an epic.
 */
export function epicSessionName(epicName: string): string {
  // Strip date prefix if full epic dir name is passed (e.g., "20260319-001_implement-auth" → "implement-auth")
  const match = epicName.match(/^\d{8}-\d{3}_(.+)$/);
  const shortName = match ? match[1] : epicName;
  return `${SESSION_PREFIX}${shortName}`;
}

/**
 * Interactive session picker.
 * - No sessions → start new
 * - One session → attach
 * - Multiple → let user choose
 */
export async function handleDefault(basePath?: string): Promise<void> {
  const sessions = await listSessions();

  if (sessions.length === 0) {
    console.log("セッションがありません。新規セッションを開始します。");
    await handleNew(basePath);
    return;
  }

  if (sessions.length === 1) {
    console.log(`セッション "${sessions[0].epicName}" に接続します。`);
    attachToSession(sessions[0].name);
    return;
  }

  // Multiple sessions — show picker
  console.log("haltr セッション:\n");
  sessions.forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.display}`);
  });
  console.log(`  ${sessions.length + 1}. 新規セッション`);
  console.log();

  const choice = await promptUser(`選択 (1-${sessions.length + 1}): `);
  const num = parseInt(choice, 10);

  if (num === sessions.length + 1) {
    await handleNew(basePath);
  } else if (num >= 1 && num <= sessions.length) {
    attachToSession(sessions[num - 1].name);
  } else {
    console.log("無効な選択です。");
    process.exit(1);
  }
}

/**
 * Start a new session.
 */
export async function handleNew(basePath?: string): Promise<void> {
  // Import handleStart dynamically to avoid circular deps
  const { handleStart } = await import("./start.js");
  const base = basePath ?? process.cwd();

  // Generate temporary session name
  const sessionName = generateSessionName();

  await handleStart({ sessionName }, base);
}

/**
 * Attach to an existing session by epic name.
 */
export async function handleAttach(epicName: string): Promise<void> {
  const sessionName = epicSessionName(epicName);
  const exists = await tmuxSessionExists(sessionName);

  if (!exists) {
    // Try full session name match
    const sessions = await tmuxListSessions(SESSION_PREFIX);
    const match = sessions.find((s) => s.includes(epicName));
    if (match) {
      attachToSession(match);
      return;
    }
    console.error(`セッション "${epicName}" が見つかりません。`);
    console.error("hal ls で一覧を確認してください。");
    process.exit(1);
  }

  attachToSession(sessionName);
}

/**
 * Stop sessions interactively or all at once.
 */
export async function handleStopSession(
  target?: string,
  all = false,
  basePath?: string,
): Promise<void> {
  const base = basePath ?? process.cwd();

  if (all) {
    const sessions = await listSessions();
    if (sessions.length === 0) {
      console.log("停止するセッションがありません。");
      return;
    }
    for (const s of sessions) {
      await stopOneSession(s.name, base);
      console.log(`停止: ${s.epicName}`);
    }
    return;
  }

  if (target) {
    const sessionName = epicSessionName(target);
    const exists = await tmuxSessionExists(sessionName);
    if (!exists) {
      console.error(`セッション "${target}" が見つかりません。`);
      process.exit(1);
    }
    await stopOneSession(sessionName, base);
    console.log(`停止: ${target}`);
    return;
  }

  // Interactive picker
  const sessions = await listSessions();
  if (sessions.length === 0) {
    console.log("停止するセッションがありません。");
    return;
  }

  console.log("停止するセッションを選択:\n");
  sessions.forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.display}`);
  });
  console.log(`  ${sessions.length + 1}. すべて停止`);
  console.log();

  const choice = await promptUser(`選択 (1-${sessions.length + 1}): `);
  const num = parseInt(choice, 10);

  if (num === sessions.length + 1) {
    for (const s of sessions) {
      await stopOneSession(s.name, base);
      console.log(`停止: ${s.epicName}`);
    }
  } else if (num >= 1 && num <= sessions.length) {
    await stopOneSession(sessions[num - 1].name, base);
    console.log(`停止: ${sessions[num - 1].epicName}`);
  } else {
    console.log("無効な選択です。");
    process.exit(1);
  }
}

/**
 * Stop a single tmux session and clean up.
 */
async function stopOneSession(sessionName: string, base: string): Promise<void> {
  try {
    await tmuxKillSession(sessionName);
  } catch {
    // Session may already be gone
  }

  // Clean up watcher PID
  const haltrCandidates = [join(base, "haltr"), base];
  for (const haltrDir of haltrCandidates) {
    if (existsSync(join(haltrDir, ".watcher.pid"))) {
      const pid = readWatcherPid(haltrDir);
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Process may already be dead
        }
      }
      removeWatcherPid(haltrDir);
    }
  }
}

/**
 * Attach to a tmux session (blocks until detach).
 */
function attachToSession(sessionName: string): void {
  try {
    execFileSync("tmux", ["attach", "-t", sessionName], { stdio: "inherit" });
  } catch {
    // User detached — that's fine
  }
}

/**
 * Simple readline prompt.
 */
function promptUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
