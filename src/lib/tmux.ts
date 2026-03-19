/**
 * Low-level tmux command wrappers.
 *
 * Each function shells out to tmux and returns the result.
 * If tmux is not installed or the command fails, the promise rejects.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Run an arbitrary tmux command and return stdout (trimmed).
 */
export async function tmuxRun(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("tmux", args);
  return stdout.trim();
}

/**
 * Check whether a tmux session with the given name exists.
 */
export async function tmuxSessionExists(sessionName: string): Promise<boolean> {
  try {
    await tmuxRun(["has-session", "-t", sessionName]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a new tmux session (detached) and return the pane ID of the
 * initial pane.
 */
export async function tmuxCreateSession(sessionName: string): Promise<string> {
  const paneId = await tmuxRun([
    "new-session",
    "-d",
    "-s",
    sessionName,
    "-P",
    "-F",
    "#{pane_id}",
  ]);
  return paneId;
}

/**
 * Split the current window in the given session and optionally run a command.
 * Returns the pane ID of the newly created pane.
 */
export async function tmuxSplitWindow(
  sessionName: string,
  command?: string,
  cwd?: string,
): Promise<string> {
  const args = ["split-window", "-h", "-t", sessionName, "-P", "-F", "#{pane_id}"];
  if (cwd) {
    args.push("-c", cwd);
  }
  if (command) {
    args.push(command);
  }
  const paneId = await tmuxRun(args);
  // Re-layout: left = orchestrator, right = children stacked
  await tmuxRun(["select-layout", "-t", sessionName, "main-vertical"]).catch(() => {});
  return paneId;
}

/**
 * Kill a pane by its pane ID.
 */
export async function tmuxKillPane(paneId: string): Promise<void> {
  await tmuxRun(["kill-pane", "-t", paneId]);
  // Re-layout after pane removal
  await tmuxRun(["select-layout", "main-vertical"]).catch(() => {});
}

/**
 * Send keys (text) to a pane. The text is sent literally and followed by Enter.
 *
 * Special characters are escaped so they are delivered verbatim to the pane.
 */
export async function tmuxSendKeys(
  paneId: string,
  text: string,
): Promise<void> {
  // Send without -l so shell expansion ($(cat ...)) works in the target pane.
  await tmuxRun(["send-keys", "-t", paneId, text, "Enter"]);
}

/**
 * Set pane role label and border color.
 * Uses custom tmux option @haltr_role to avoid Claude Code overriding pane_title.
 */
export async function tmuxStylePane(
  paneId: string,
  title: string,
  borderColor: string,
): Promise<void> {
  await tmuxRun(["set-option", "-p", "-t", paneId, "@haltr_role", title]);
  await tmuxRun(["set-option", "-p", "-t", paneId, "pane-border-style", `fg=${borderColor}`]);
}

/**
 * Enable pane border status, mouse support, and styling for the session.
 */
export async function tmuxEnableBorderStatus(sessionName: string): Promise<void> {
  await tmuxRun(["set-option", "-t", sessionName, "pane-border-status", "top"]);
  await tmuxRun(["set-option", "-t", sessionName, "pane-border-lines", "heavy"]);
  await tmuxRun(["set-option", "-t", sessionName, "pane-border-format", " #{@haltr_role} "]);
}

/**
 * List all pane IDs in a session.
 */
export async function tmuxListPanes(
  sessionName: string,
): Promise<string[]> {
  try {
    const output = await tmuxRun([
      "list-panes",
      "-t",
      sessionName,
      "-F",
      "#{pane_id}",
    ]);
    if (!output) return [];
    return output.split("\n").filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

/**
 * Kill an entire tmux session.
 */
export async function tmuxKillSession(sessionName: string): Promise<void> {
  await tmuxRun(["kill-session", "-t", sessionName]);
}

/**
 * List all tmux sessions matching a prefix.
 * Returns session names.
 */
export async function tmuxListSessions(prefix?: string): Promise<string[]> {
  try {
    const output = await tmuxRun(["list-sessions", "-F", "#{session_name}"]);
    if (!output) return [];
    const sessions = output.split("\n").filter(Boolean);
    if (prefix) return sessions.filter((s) => s.startsWith(prefix));
    return sessions;
  } catch {
    return [];
  }
}

/**
 * Rename a tmux session.
 */
export async function tmuxRenameSession(
  oldName: string,
  newName: string,
): Promise<void> {
  await tmuxRun(["rename-session", "-t", oldName, newName]);
}

/**
 * Get the current tmux session name (from within a tmux pane).
 */
export async function tmuxCurrentSession(): Promise<string | undefined> {
  try {
    const name = await tmuxRun(["display-message", "-p", "#S"]);
    return name || undefined;
  } catch {
    return undefined;
  }
}
