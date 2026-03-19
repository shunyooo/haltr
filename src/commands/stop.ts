/**
 * `hal stop` -- Stop tmux session and watcher process.
 *
 * hal stop
 *
 * Steps:
 *   1. Kill tmux session `haltr`
 *   2. Stop watcher process (if running) -- placeholder for M8
 *   3. Clear .panes.yaml
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PanesManager } from "../lib/panes-manager.js";
import { tmuxKillSession, tmuxSessionExists } from "../lib/tmux.js";
import { readWatcherPid, removeWatcherPid } from "../lib/watcher.js";

/**
 * Dependencies that can be injected for testing.
 */
export interface StopDeps {
  sessionExists: (name: string) => Promise<boolean>;
  killSession: (name: string) => Promise<void>;
}

const defaultDeps: StopDeps = {
  sessionExists: tmuxSessionExists,
  killSession: tmuxKillSession,
};

/**
 * Core stop logic, exported for testability.
 *
 * @param basePath  base path for .panes.yaml (defaults to cwd)
 * @param deps      injectable dependencies for testing
 */
export async function handleStop(
  basePath?: string,
  deps: StopDeps = defaultDeps,
): Promise<void> {
  const base = basePath ?? process.cwd();
  const sessionName = "haltr";

  // 1. Kill tmux session
  const exists = await deps.sessionExists(sessionName);
  if (exists) {
    try {
      await deps.killSession(sessionName);
    } catch {
      // Session may have already been killed — that's fine
    }
  }

  // 2. Stop watcher process
  // Try to find haltr directory for PID file
  const haltrCandidates = [
    join(base, "haltr"),
    base,
  ];
  for (const haltrDir of haltrCandidates) {
    const pidPath = join(haltrDir, ".watcher.pid");
    if (existsSync(pidPath)) {
      const pid = readWatcherPid(haltrDir);
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // Process may already be dead
        }
      }
      removeWatcherPid(haltrDir);
      break;
    }
  }

  // 3. Clear .panes.yaml from all epic directories and haltr/
  for (const haltrDir of haltrCandidates) {
    // Clear haltr/.panes.yaml (fallback location)
    new PanesManager(haltrDir).clear();
    // Clear each epic's .panes.yaml
    const epicsDir = join(haltrDir, "epics");
    if (existsSync(epicsDir)) {
      try {
        const entries = readdirSync(epicsDir);
        for (const entry of entries) {
          if (entry === "archive" || entry.startsWith(".")) continue;
          const epicDir = join(epicsDir, entry);
          new PanesManager(epicDir).clear();
        }
      } catch {
        // ignore
      }
    }
  }

  console.log("Stopped haltr session.");
}
