/**
 * PanesManager — manages the .panes.yaml file that tracks live tmux panes.
 *
 * The file is stored at `<basePath>/.panes.yaml` and has the structure:
 *
 *   panes:
 *     - pane_id: "%3"
 *       step: "step-1"
 *       role: "worker"
 *       parent_pane_id: "%0"
 *       cli: "claude"
 *       task_path: "epics/20260319-001_implement-auth/001_task.yaml"
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";

export interface PaneEntry {
  pane_id: string;
  step: string;
  role: string;
  parent_pane_id: string;
  cli: string;
  task_path: string;
}

interface PanesFile {
  panes: PaneEntry[];
}

export class PanesManager {
  private readonly filePath: string;

  constructor(basePath: string) {
    this.filePath = join(basePath, ".panes.yaml");
  }

  /**
   * Read .panes.yaml and return the list of entries.
   * Returns an empty list if the file does not exist.
   */
  load(): PaneEntry[] {
    if (!existsSync(this.filePath)) {
      return [];
    }
    const raw = readFileSync(this.filePath, "utf-8");
    const data = yaml.load(raw) as PanesFile | null;
    return data?.panes ?? [];
  }

  /**
   * Write the given list of entries to .panes.yaml.
   */
  save(entries: PaneEntry[]): void {
    const data: PanesFile = { panes: entries };
    const content = yaml.dump(data, { lineWidth: -1 });
    writeFileSync(this.filePath, content, "utf-8");
  }

  /**
   * Add an entry and persist.
   */
  add(entry: PaneEntry): void {
    const entries = this.load();
    entries.push(entry);
    this.save(entries);
  }

  /**
   * Remove the entry with the given pane ID and persist.
   * No-op if the pane ID is not found.
   */
  remove(paneId: string): void {
    const entries = this.load();
    const filtered = entries.filter((e) => e.pane_id !== paneId);
    this.save(filtered);
  }

  /**
   * Find an entry by pane ID, or undefined if not found.
   */
  findByPaneId(paneId: string): PaneEntry | undefined {
    return this.load().find((e) => e.pane_id === paneId);
  }

  /**
   * Remove all entries (writes an empty list).
   */
  clear(): void {
    this.save([]);
  }

  /**
   * Return the number of tracked panes.
   */
  count(): number {
    return this.load().length;
  }

  /**
   * Get the directory where .panes.yaml is stored.
   */
  getPanesDir(): string {
    return this.filePath.replace("/.panes.yaml", "");
  }
}
