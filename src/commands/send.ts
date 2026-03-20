/**
 * `hal send` — Send a message to an agent pane.
 *
 * Used by the orchestrator to send instructions to worker/verifier panes.
 */

import { dirname, resolve } from "node:path";
import { PanesManager } from "../lib/panes-manager.js";
import { tmuxSendKeys, tmuxListPanes, tmuxCurrentSession } from "../lib/tmux.js";
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

  // Check if the pane is actually alive
  const sessionName = await tmuxCurrentSession() ?? "haltr";
  const alivePanes = await tmuxListPanes(sessionName);
  if (!alivePanes.includes(target.pane_id)) {
    throw new Error(
      `Pane ${target.pane_id} (${role}: ${opts.step}) は既に終了しています。hal spawn で再起動してください。`,
    );
  }

  await tmuxSendKeys(target.pane_id, opts.message);
  console.log(`Sent to ${role} (${target.pane_id}): ${opts.message.substring(0, 80)}${opts.message.length > 80 ? "..." : ""}`);
}
