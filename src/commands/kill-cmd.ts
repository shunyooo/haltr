/**
 * `hal kill` — kill all panes related to a task.
 *
 * Reads .panes.yaml, finds entries for the given task, kills each pane
 * via tmux, and removes entries from .panes.yaml.
 */

import { resolve, dirname } from "node:path";
import { PanesManager } from "../lib/panes-manager.js";
import { tmuxKillPane } from "../lib/tmux.js";
import { validateTaskPath } from "../lib/task-utils.js";

export interface KillOptions {
  task: string;
}

/**
 * Core kill logic, exported for testability.
 *
 * @param opts          command options
 * @param killPaneFn    injectable tmux kill-pane function (for mocking)
 * @param basePath      base path for .panes.yaml lookup (defaults to cwd)
 */
export async function handleKill(
  opts: KillOptions,
  killPaneFn: (paneId: string) => Promise<void> = tmuxKillPane,
  basePath?: string,
): Promise<void> {
  const { task: taskPath } = opts;
  const resolvedPath = resolve(taskPath);
  validateTaskPath(resolvedPath);

  const panesManager = new PanesManager(dirname(resolvedPath));
  const allPanes = panesManager.load();

  // Find panes matching the task (use resolved path for consistent comparison)
  const matching = allPanes.filter((p) => p.task_path === resolvedPath);

  if (matching.length === 0) {
    console.log(`No panes found for task: ${taskPath}`);
    return;
  }

  // Kill each pane
  for (const pane of matching) {
    try {
      await killPaneFn(pane.pane_id);
    } catch {
      // Pane may already be dead — that's fine, just clean up
    }
  }

  // Remove entries from .panes.yaml
  const remaining = allPanes.filter((p) => p.task_path !== resolvedPath);
  panesManager.save(remaining);

  console.log(`Killed ${matching.length} pane(s) for task: ${taskPath}`);
}
