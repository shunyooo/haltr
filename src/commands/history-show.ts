/**
 * `hal history show` — Display history events for a step.
 *
 * Workers can use this to read verification results, escalation details, etc.
 */

import { resolve } from "node:path";
import { loadAndValidateTask } from "../lib/validator.js";
import { validateTaskPath } from "../lib/task-utils.js";

export interface HistoryShowOptions {
  task: string;
  step?: string;
  type?: string;
  last?: boolean;
}

export function handleHistoryShow(opts: HistoryShowOptions): string {
  const taskPath = resolve(opts.task);
  validateTaskPath(taskPath);
  const task = loadAndValidateTask(taskPath);

  let events = task.history ?? [];

  // Filter by step
  if (opts.step) {
    events = events.filter((e: any) => e.step === opts.step);
  }

  // Filter by type
  if (opts.type) {
    events = events.filter((e) => e.type === opts.type);
  }

  if (events.length === 0) {
    return "該当するイベントはありません。";
  }

  // If --last, show only the most recent
  if (opts.last) {
    events = [events[events.length - 1]];
  }

  // Format output
  const lines: string[] = [];
  for (const e of events) {
    const ev = e as any;
    let line = `[${ev.at}] ${ev.type}`;
    if (ev.step) line += ` (${ev.step})`;
    if (ev.attempt) line += ` attempt:${ev.attempt}`;
    line += ` by:${ev.by}`;
    lines.push(line);
    if (ev.message) {
      lines.push(ev.message);
    }
    if (ev.accept_id) {
      lines.push(`accept_id: ${ev.accept_id}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}
