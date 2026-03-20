/**
 * Watcher Process -- Background polling loop for haltr.
 *
 * Responsibilities (notification only -- never takes action):
 *   1. Pane crash detection: pane dead + still in .panes.yaml after grace period
 *   2. Inactivity detection: pane alive but no tmux activity for threshold
 *
 * Started by `hal start`, stopped by `hal stop`.
 * PID written to `haltr/.watcher.pid`.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { PanesManager, type PaneEntry } from "./panes-manager.js";
import type { ConfigYaml } from "../types.js";

// ============================================================================
// Types
// ============================================================================

export interface WatcherNotification {
  type: "crash" | "inactivity";
  paneId: string;
  step: string;
  role: string;
  parentPaneId: string;
  message: string;
}

export interface WatcherDeps {
  listAlivePanes: () => Promise<string[]>;
  sendKeys: (paneId: string, text: string) => Promise<void>;
}

interface PaneState {
  /** When we first saw this pane as dead (undefined = still alive or never seen dead). */
  deathDetectedAt?: number;
  /** Whether we've sent a crash notification for this pane. */
  crashNotified: boolean;
  /** Whether we've sent an inactivity notification for this pane. */
  inactivityNotified: boolean;
}

// ============================================================================
// Watcher
// ============================================================================

export class Watcher {
  private readonly haltrDir: string;
  private readonly panesManager: PanesManager;
  private readonly deps: WatcherDeps;
  private readonly pollIntervalMs: number;
  private readonly inactivityThresholdMs: number;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private paneStates: Map<string, PaneState> = new Map();
  private notifications: WatcherNotification[] = [];

  constructor(
    config: ConfigYaml,
    haltrDir: string,
    basePath: string,
    deps: WatcherDeps,
  ) {
    this.haltrDir = haltrDir;
    this.panesManager = new PanesManager(basePath);
    this.deps = deps;
    this.pollIntervalMs = config.watcher.poll_interval * 1000;
    this.inactivityThresholdMs = config.watcher.inactivity_threshold * 1000;
  }

  start(): void {
    if (this.intervalHandle !== null) return;

    const pidPath = join(this.haltrDir, ".watcher.pid");
    writeFileSync(pidPath, String(process.pid), "utf-8");

    this.intervalHandle = setInterval(() => {
      this.poll().catch((err) => {
        console.error("[watcher] Poll error:", err);
      });
    }, this.pollIntervalMs);
  }

  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    const pidPath = join(this.haltrDir, ".watcher.pid");
    try {
      if (existsSync(pidPath)) unlinkSync(pidPath);
    } catch {}
  }

  isRunning(): boolean {
    return this.intervalHandle !== null;
  }

  getNotifications(): WatcherNotification[] {
    return [...this.notifications];
  }

  clearNotifications(): void {
    this.notifications = [];
  }

  async poll(): Promise<void> {
    const entries = this.loadAllPanes();
    const alivePanes = await this.deps.listAlivePanes();
    const aliveSet = new Set(alivePanes);
    const now = Date.now();

    // Initialize states for new entries
    for (const entry of entries) {
      if (!this.paneStates.has(entry.pane_id)) {
        this.paneStates.set(entry.pane_id, {
          crashNotified: false,
          inactivityNotified: false,
        });
      }
    }

    // Clean up states for entries no longer in .panes.yaml
    for (const [paneId] of this.paneStates) {
      if (!entries.some((e) => e.pane_id === paneId)) {
        this.paneStates.delete(paneId);
      }
    }

    for (const entry of entries) {
      const state = this.paneStates.get(entry.pane_id)!;
      const isAlive = aliveSet.has(entry.pane_id);

      if (isAlive) {
        // Pane is alive — reset death detection
        state.deathDetectedAt = undefined;
      } else {
        // Pane is dead
        if (entry.role === "main-orchestrator") continue;

        if (!state.deathDetectedAt) {
          // First time seeing this pane dead — start grace period
          state.deathDetectedAt = now;
        } else if (!state.crashNotified) {
          // Grace period elapsed (pane still in .panes.yaml after 1+ polls)
          // This means stop hook didn't clean it up → crash
          const message = `${entry.step || entry.role} の ${entry.role} pane がクラッシュしました`;
          await this.notify(entry, "crash", message);
          state.crashNotified = true;
        }
      }
    }

    // Inactivity detection for alive panes
    for (const entry of entries) {
      const state = this.paneStates.get(entry.pane_id);
      if (!state || state.inactivityNotified) continue;

      const isAlive = aliveSet.has(entry.pane_id);
      if (!isAlive) continue;
      if (entry.role === "main-orchestrator") continue;

      // Check tmux pane activity timestamp
      try {
        const lastActivity = await this.getPaneLastActivity(entry.pane_id);
        if (lastActivity > 0) {
          const inactiveDuration = now - lastActivity * 1000;
          if (inactiveDuration >= this.inactivityThresholdMs) {
            const minutes = Math.floor(inactiveDuration / 60000);
            const message = `${entry.step || entry.role} の ${entry.role} が ${minutes} 分間無活動です`;
            await this.notify(entry, "inactivity", message);
            state.inactivityNotified = true;
          }
        }
      } catch {
        // Can't get activity — skip
      }
    }
  }

  // ---------- Internal ----------

  private loadAllPanes(): PaneEntry[] {
    const all: PaneEntry[] = [];
    all.push(...this.panesManager.load());
    const epicsDir = join(this.haltrDir, "epics");
    if (existsSync(epicsDir)) {
      try {
        for (const entry of readdirSync(epicsDir)) {
          if (entry === "archive" || entry.startsWith(".")) continue;
          const epicDir = join(epicsDir, entry);
          const pm = new PanesManager(epicDir);
          all.push(...pm.load());
        }
      } catch {}
    }
    return all;
  }

  private async getPaneLastActivity(paneId: string): Promise<number> {
    // Use tmux to get last activity timestamp
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("tmux", [
      "display-message", "-t", paneId, "-p", "#{pane_activity}",
    ]);
    return parseInt(stdout.trim(), 10) || 0;
  }

  private async notify(
    entry: PaneEntry,
    type: "crash" | "inactivity",
    message: string,
  ): Promise<void> {
    const notification: WatcherNotification = {
      type,
      paneId: entry.pane_id,
      step: entry.step,
      role: entry.role,
      parentPaneId: entry.parent_pane_id,
      message,
    };
    this.notifications.push(notification);

    if (entry.parent_pane_id) {
      try {
        await this.deps.sendKeys(entry.parent_pane_id, message);
      } catch {}
    }
  }
}

// ============================================================================
// PID file helpers
// ============================================================================

export function readWatcherPid(haltrDir: string): number | undefined {
  const pidPath = join(haltrDir, ".watcher.pid");
  try {
    const content = readFileSync(pidPath, "utf-8").trim();
    const pid = parseInt(content, 10);
    return isNaN(pid) ? undefined : pid;
  } catch {
    return undefined;
  }
}

export function removeWatcherPid(haltrDir: string): void {
  const pidPath = join(haltrDir, ".watcher.pid");
  try {
    if (existsSync(pidPath)) unlinkSync(pidPath);
  } catch {}
}
