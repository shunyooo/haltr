/**
 * Watcher Process -- Background polling loop for haltr.
 *
 * Responsibilities (notification only -- never takes action):
 *   1. Pane crash detection: detect dead panes, notify parent orchestrator
 *   2. Inactivity detection: if threshold exceeded, notify parent
 *   3. Stop Hook miss detection: pane gone without check notification
 *
 * Started by `hal start`, stopped by `hal stop`.
 * PID written to `haltr/.watcher.pid`.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { PanesManager, type PaneEntry } from "./panes-manager.js";
import type { ConfigYaml } from "../types.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Notification from the watcher.
 */
export interface WatcherNotification {
  type: "crash" | "inactivity" | "stop_hook_miss";
  paneId: string;
  step: string;
  role: string;
  parentPaneId: string;
  message: string;
}

/**
 * Dependencies that can be injected for testing.
 */
export interface WatcherDeps {
  /** Check if a pane is alive in tmux. Returns list of alive pane IDs. */
  listAlivePanes: () => Promise<string[]>;
  /** Send a notification message to a pane. */
  sendKeys: (paneId: string, text: string) => Promise<void>;
}

/**
 * Tracking state for each pane.
 */
interface PaneState {
  /** When we first saw this pane alive (or entry appeared). */
  firstSeen: number;
  /** Last time we confirmed this pane was alive. */
  lastAlive: number;
  /** Whether we've sent a stop hook miss notification for this pane. */
  stopHookMissNotified: boolean;
  /** Whether we've sent an inactivity notification for this pane. */
  inactivityNotified: boolean;
  /** Whether we've sent a crash notification for this pane. */
  crashNotified: boolean;
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

  /**
   * Start the polling loop.
   * Writes PID to haltr/.watcher.pid.
   */
  start(): void {
    if (this.intervalHandle !== null) {
      return; // Already running
    }

    // Write PID file
    const pidPath = join(this.haltrDir, ".watcher.pid");
    writeFileSync(pidPath, String(process.pid), "utf-8");

    // Start polling
    this.intervalHandle = setInterval(() => {
      this.poll().catch((err) => {
        // Log but don't crash the watcher
        console.error("[watcher] Poll error:", err);
      });
    }, this.pollIntervalMs);
  }

  /**
   * Stop the polling loop.
   * Removes the PID file.
   */
  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }

    // Remove PID file
    const pidPath = join(this.haltrDir, ".watcher.pid");
    try {
      if (existsSync(pidPath)) {
        unlinkSync(pidPath);
      }
    } catch {
      // Best effort
    }
  }

  /**
   * Check if the watcher is running.
   */
  isRunning(): boolean {
    return this.intervalHandle !== null;
  }

  /**
   * Get all notifications that have been generated.
   */
  getNotifications(): WatcherNotification[] {
    return [...this.notifications];
  }

  /**
   * Clear recorded notifications.
   */
  clearNotifications(): void {
    this.notifications = [];
  }

  /**
   * Single poll iteration. Exposed for testing.
   */
  async poll(): Promise<void> {
    const entries = this.panesManager.load();
    const alivePanes = await this.deps.listAlivePanes();
    const aliveSet = new Set(alivePanes);
    const now = Date.now();

    // Initialize states for new entries
    for (const entry of entries) {
      if (!this.paneStates.has(entry.pane_id)) {
        this.paneStates.set(entry.pane_id, {
          firstSeen: now,
          lastAlive: now,
          stopHookMissNotified: false,
          inactivityNotified: false,
          crashNotified: false,
        });
      }
    }

    // Track which panes to remove
    const deadPaneIds: string[] = [];

    for (const entry of entries) {
      const state = this.paneStates.get(entry.pane_id)!;
      const isAlive = aliveSet.has(entry.pane_id);

      if (isAlive) {
        // Note: We do NOT update lastAlive here.
        // lastAlive is set only on first-seen (initialization).
        // In a full implementation, we would compare against actual
        // pane output timestamps (via tmux capture-pane).
        // This simple approach detects inactivity since registration.
      } else {
        // Pane is dead

        // 1. Crash detection (only notify once)
        if (entry.role === "main-orchestrator") {
          // Main orchestrator crash: no notification target, just log
          // (no parent to notify)
        } else if (!state.crashNotified) {
          // Notify parent orchestrator
          const message = `${entry.step || entry.role} の ${entry.role} pane がクラッシュしました`;
          await this.notify(entry, "crash", message);
          state.crashNotified = true;
        }

        // 3. Stop hook miss detection
        if (!state.stopHookMissNotified && entry.role !== "main-orchestrator") {
          const missMessage = `${entry.step || entry.role} の ${entry.role} が終了しましたが通知がありません`;
          await this.notify(entry, "stop_hook_miss", missMessage);
          state.stopHookMissNotified = true;
        }

        deadPaneIds.push(entry.pane_id);
      }
    }

    // 2. Inactivity detection for alive panes
    for (const entry of entries) {
      const state = this.paneStates.get(entry.pane_id)!;
      const isAlive = aliveSet.has(entry.pane_id);

      if (isAlive && !state.inactivityNotified) {
        const inactiveDuration = now - state.lastAlive;
        if (inactiveDuration >= this.inactivityThresholdMs) {
          const minutes = Math.floor(inactiveDuration / 60000);
          const message = `${entry.step || entry.role} の ${entry.role} が ${minutes} 分間無活動です`;
          if (entry.role !== "main-orchestrator") {
            await this.notify(entry, "inactivity", message);
          }
          state.inactivityNotified = true;
        }
      }
    }

    // Track dead panes internally (do NOT modify .panes.yaml —
    // watcher is notification-only; orchestrator handles cleanup)
    if (deadPaneIds.length > 0) {
      for (const id of deadPaneIds) {
        const state = this.paneStates.get(id);
        if (state) {
          state.stopHookMissNotified = true;
        }
      }
    }
  }

  // ---------- Internal ----------

  private async notify(
    entry: PaneEntry,
    type: WatcherNotification["type"],
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

    // Send to parent pane via tmux
    if (entry.parent_pane_id) {
      try {
        await this.deps.sendKeys(entry.parent_pane_id, message);
      } catch {
        // Best effort — parent may also be dead
      }
    }
  }
}

// ============================================================================
// PID file helpers
// ============================================================================

/**
 * Read the watcher PID from haltr/.watcher.pid.
 * Returns undefined if the file doesn't exist.
 */
export function readWatcherPid(haltrDir: string): number | undefined {
  const pidPath = join(haltrDir, ".watcher.pid");
  if (!existsSync(pidPath)) {
    return undefined;
  }
  try {
    const content = readFileSync(pidPath, "utf-8").trim();
    const pid = parseInt(content, 10);
    return Number.isNaN(pid) ? undefined : pid;
  } catch {
    return undefined;
  }
}

/**
 * Remove the watcher PID file.
 */
export function removeWatcherPid(haltrDir: string): void {
  const pidPath = join(haltrDir, ".watcher.pid");
  try {
    if (existsSync(pidPath)) {
      unlinkSync(pidPath);
    }
  } catch {
    // Best effort
  }
}
