/**
 * `hal send` — Send a message to an agent pane.
 *
 * Used by the orchestrator to send instructions to worker/verifier panes.
 */

import { dirname } from "node:path";
import { PanesManager } from "../lib/panes-manager.js";
import { tmuxSendKeys } from "../lib/tmux.js";
import { resolve } from "node:path";
import { validateTaskPath } from "../lib/task-utils.js";

export interface SendOptions {
  task: string;
  step: string;
  role?: string;
  message: string;
}

export async function handleSend(opts: SendOptions): Promise<void> {
  const taskPath = resolve(opts.task);
  validateTaskPath(taskPath);

  const epicDir = dirname(taskPath);
  const pm = new PanesManager(epicDir);
  const panes = pm.load();

  const role = opts.role ?? "worker";
  const target = panes.find(
    (p) => p.step === opts.step && p.role === role,
  );

  if (!target) {
    throw new Error(
      `Pane not found: role=${role}, step=${opts.step}. hal panes で確認してください。`,
    );
  }

  await tmuxSendKeys(target.pane_id, opts.message);
  console.log(`Sent to ${role} (${target.pane_id}): ${opts.message.substring(0, 80)}${opts.message.length > 80 ? "..." : ""}`);
}
