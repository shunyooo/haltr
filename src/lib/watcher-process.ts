/**
 * Standalone watcher process.
 * Forked by `hal start` to run in the background.
 *
 * Self-terminates when the tmux session `haltr` no longer exists.
 *
 * Usage: node watcher-process.js <haltrDir> <baseDir>
 */

import { join } from "node:path";
import { loadAndValidateConfig } from "./validator.js";
import {
  tmuxListPanes,
  tmuxSendKeys,
  tmuxSessionExists,
} from "./tmux.js";
import { Watcher, removeWatcherPid } from "./watcher.js";

const [haltrDir, baseDir] = process.argv.slice(2);

if (!haltrDir || !baseDir) {
  process.exit(1);
}

const configPath = join(haltrDir, "config.yaml");
const configYaml = loadAndValidateConfig(configPath);

const watcher = new Watcher(configYaml, haltrDir, baseDir, {
  listAlivePanes: () => tmuxListPanes("haltr"),
  sendKeys: tmuxSendKeys,
});

watcher.start();

// Self-terminate when tmux session is gone
const sessionCheck = setInterval(async () => {
  try {
    const exists = await tmuxSessionExists("haltr");
    if (!exists) {
      watcher.stop();
      removeWatcherPid(haltrDir);
      clearInterval(sessionCheck);
      process.exit(0);
    }
  } catch {
    // tmux not available — exit
    watcher.stop();
    removeWatcherPid(haltrDir);
    clearInterval(sessionCheck);
    process.exit(0);
  }
}, configYaml.watcher.poll_interval * 1000);
