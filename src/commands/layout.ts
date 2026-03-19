/**
 * `hal layout` — change tmux layout for the haltr session.
 */

import { tmuxRun } from "../lib/tmux.js";

const VALID_LAYOUTS = new Set([
  "tiled",
  "even-horizontal",
  "even-vertical",
  "main-horizontal",
  "main-vertical",
]);

/**
 * Core layout logic, exported for testability.
 *
 * @param layoutType    layout type string
 * @param runFn         injectable tmux run function (for mocking)
 * @param sessionName   tmux session name (default: "haltr")
 */
export async function handleLayout(
  layoutType: string,
  runFn: (args: string[]) => Promise<string> = tmuxRun,
  sessionName = "haltr",
): Promise<void> {
  if (!VALID_LAYOUTS.has(layoutType)) {
    throw new Error(
      `Invalid layout type: "${layoutType}". Valid types: ${[...VALID_LAYOUTS].join(", ")}`,
    );
  }

  try {
    await runFn(["select-layout", "-t", sessionName, layoutType]);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      msg.includes("no current target") ||
      msg.includes("session not found") ||
      msg.includes("can't find session")
    ) {
      throw new Error(
        `tmux session "${sessionName}" not found. Run 'hal start' first.`,
      );
    }
    throw e;
  }

  console.log(`Layout set to ${layoutType}`);
}

/**
 * Get the set of valid layout types.
 */
export function getValidLayouts(): Set<string> {
  return new Set(VALID_LAYOUTS);
}
