/**
 * TmuxRuntime — Runtime implementation backed by tmux.
 *
 * Uses the tmux helpers for low-level commands and PanesManager
 * for persistence of pane state in .panes.yaml.
 */

import { join, dirname } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import type { AgentInfo, Runtime, SpawnOptions } from "./runtime.js";
import { PanesManager, type PaneEntry } from "./panes-manager.js";
import {
  tmuxSplitWindow,
  tmuxKillPane,
  tmuxSendKeys,
  tmuxListPanes,
} from "./tmux.js";

export class TmuxRuntime implements Runtime {
  private readonly sessionName: string;
  private readonly panesManager: PanesManager;
  private readonly exitCallbacks: Map<string, Array<() => void>> = new Map();

  /**
   * @param sessionName  tmux session name (default: "haltr")
   * @param basePath     project root directory (default: cwd); haltr/ is expected to be within this
   */
  constructor(sessionName = "haltr", basePath = process.cwd()) {
    this.sessionName = sessionName;
    // Look for haltr/ directory within basePath
    const haltrDir = join(basePath, "haltr");
    const panesDir = existsSync(haltrDir) ? haltrDir : basePath;
    this.panesManager = new PanesManager(panesDir);
  }

  /**
   * Spawn a new pane inside the tmux session.
   *
   * The pane runs either the given command or a plain shell.
   * The pane is registered in .panes.yaml in the epic directory (dirname of taskPath).
   */
  async spawn(options: SpawnOptions): Promise<AgentInfo> {
    const paneId = await tmuxSplitWindow(
      this.sessionName,
      options.command,
      options.cwd,
    );

    const entry: PaneEntry = {
      pane_id: paneId,
      step: options.step,
      role: options.role,
      parent_pane_id: options.parentPaneId,
      cli: options.cli,
      task_path: options.taskPath,
    };

    // .panes.yaml is stored in the epic directory (same directory as task.yaml)
    // If taskPath is empty (e.g., for main-orchestrator), use the base path
    const panesDir = options.taskPath ? dirname(options.taskPath) : this.panesManager.getPanesDir();
    const panesManager = new PanesManager(panesDir);
    panesManager.add(entry);

    return this.entryToAgentInfo(entry);
  }

  /**
   * Kill a pane and remove it from .panes.yaml.
   * Scans all epic directories to find the pane.
   */
  async kill(agentId: string): Promise<void> {
    try {
      await tmuxKillPane(agentId);
    } catch {
      // Pane may already be gone — that's fine.
    }

    // Try to remove from base path first
    const baseEntry = this.panesManager.findByPaneId(agentId);
    if (baseEntry) {
      this.panesManager.remove(agentId);
      return;
    }

    // Scan epic directories
    const basePath = this.panesManager.getPanesDir();
    const epicsDir = join(basePath, "epics");
    if (existsSync(epicsDir)) {
      try {
        for (const entry of readdirSync(epicsDir)) {
          if (entry === "archive" || entry.startsWith(".")) continue;
          const epicDir = join(epicsDir, entry);
          const epicPm = new PanesManager(epicDir);
          const epicEntry = epicPm.findByPaneId(agentId);
          if (epicEntry) {
            epicPm.remove(agentId);
            return;
          }
        }
      } catch {
        // ignore
      }
    }
  }

  /**
   * Send a message to a pane (text followed by Enter).
   */
  async send(agentId: string, message: string): Promise<void> {
    await tmuxSendKeys(agentId, message);
  }

  /**
   * List all tracked agents.
   *
   * Scans all epic directories for .panes.yaml files and aggregates entries.
   */
  async list(): Promise<AgentInfo[]> {
    const allEntries: PaneEntry[] = [];

    // Collect from base path .panes.yaml (fallback location)
    allEntries.push(...this.panesManager.load());

    // Collect from each epic directory
    const basePath = this.panesManager.getPanesDir();
    const epicsDir = join(basePath, "epics");
    if (existsSync(epicsDir)) {
      try {
        for (const entry of readdirSync(epicsDir)) {
          if (entry === "archive" || entry.startsWith(".")) continue;
          const epicDir = join(epicsDir, entry);
          const epicPm = new PanesManager(epicDir);
          allEntries.push(...epicPm.load());
        }
      } catch {
        // ignore
      }
    }

    return allEntries.map((e) => this.entryToAgentInfo(e));
  }

  /**
   * Check whether a pane is still alive in tmux.
   */
  async isAlive(agentId: string): Promise<boolean> {
    const livePanes = await tmuxListPanes(this.sessionName);
    return livePanes.includes(agentId);
  }

  /**
   * Register a callback for when a pane exits.
   *
   * The actual polling loop that invokes these callbacks will be
   * implemented in M8 (watcher). For now we just store them.
   */
  onExit(agentId: string, callback: () => void): void {
    const existing = this.exitCallbacks.get(agentId) ?? [];
    existing.push(callback);
    this.exitCallbacks.set(agentId, existing);
  }

  /**
   * Retrieve the registered exit callbacks (used by the watcher in M8).
   */
  getExitCallbacks(agentId: string): Array<() => void> {
    return this.exitCallbacks.get(agentId) ?? [];
  }

  /** Expose the PanesManager for direct access when needed. */
  getPanesManager(): PanesManager {
    return this.panesManager;
  }

  // ---------- internal ----------

  private entryToAgentInfo(entry: PaneEntry): AgentInfo {
    return {
      agentId: entry.pane_id,
      step: entry.step,
      role: entry.role,
      paneId: entry.pane_id,
      parentPaneId: entry.parent_pane_id,
      cli: entry.cli,
      taskPath: entry.task_path,
    };
  }
}
