import React from "react";
import { render } from "ink";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { Dashboard } from "../tui/app.js";

export async function handleTui(): Promise<void> {
  const cwd = process.cwd();
  const epicsDir = join(cwd, "haltr", "epics");

  if (!existsSync(epicsDir)) {
    throw new Error("haltr/epics/ directory not found. Run 'hal init' first.");
  }

  const { waitUntilExit } = render(
    React.createElement(Dashboard, { epicsDir }),
  );

  await waitUntilExit();
}
