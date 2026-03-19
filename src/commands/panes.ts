/**
 * `hal panes` — list current panes in a formatted table.
 *
 * Scans all epic directories for .panes.yaml and aggregates entries.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PanesManager, type PaneEntry } from "../lib/panes-manager.js";

/**
 * Core panes list logic, exported for testability.
 *
 * @param basePath  base path for haltr/ lookup (defaults to cwd)
 * @returns         formatted output string
 */
export function handlePanes(basePath?: string): string {
  const base = basePath ?? process.cwd();
  const allPanes: PaneEntry[] = [];

  // Collect from haltr/.panes.yaml (fallback location)
  const haltrCandidates = [join(base, "haltr"), base];
  for (const haltrDir of haltrCandidates) {
    const pm = new PanesManager(haltrDir);
    allPanes.push(...pm.load());

    // Collect from each epic directory
    const epicsDir = join(haltrDir, "epics");
    if (existsSync(epicsDir)) {
      try {
        for (const entry of readdirSync(epicsDir)) {
          if (entry === "archive" || entry.startsWith(".")) continue;
          const epicDir = join(epicsDir, entry);
          const epicPm = new PanesManager(epicDir);
          allPanes.push(...epicPm.load());
        }
      } catch {
        // ignore
      }
    }
  }

  if (allPanes.length === 0) {
    return "No panes tracked.";
  }

  return formatPanesTable(allPanes);
}

/**
 * Format panes into a table string.
 */
export function formatPanesTable(panes: PaneEntry[]): string {
  // Column headers
  const headers = ["PANE", "STEP", "ROLE", "CLI", "PARENT"];

  // Build rows
  const rows = panes.map((p) => [
    p.pane_id,
    p.step,
    p.role,
    p.cli,
    p.parent_pane_id,
  ]);

  // Calculate column widths
  const widths = headers.map((h, i) => {
    const maxData = rows.reduce(
      (max, row) => Math.max(max, row[i].length),
      0,
    );
    return Math.max(h.length, maxData);
  });

  // Format header
  const headerLine = headers
    .map((h, i) => h.padEnd(widths[i]))
    .join("  ");

  // Format data rows
  const dataLines = rows.map((row) =>
    row.map((cell, i) => cell.padEnd(widths[i])).join("  "),
  );

  return [headerLine, ...dataLines].join("\n");
}
