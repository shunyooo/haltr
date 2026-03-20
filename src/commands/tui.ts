import React from "react";
import { render } from "ink";
import { Dashboard } from "../tui/app.js";
import { currentEpic } from "./epic.js";

export async function handleTui(): Promise<void> {
  const cwd = process.cwd();

  // Get current epic if available
  const epic = currentEpic(cwd);
  const epicName = epic?.name;

  // Render the dashboard
  const { waitUntilExit } = render(
    React.createElement(Dashboard, { epicName })
  );

  // Wait for user to exit
  await waitUntilExit();
}
