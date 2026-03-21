/**
 * Standalone watcher process.
 * Forked by `hal start` to run in the background.
 *
 * Self-terminates when the tmux session no longer exists.
 *
 * Usage: node watcher-process.js <haltrDir> <baseDir> <sessionName>
 */

import { join } from "node:path";
import { tmuxListPanes, tmuxSendKeys, tmuxSessionExists } from "./tmux.js";
import { loadAndValidateConfig } from "./validator.js";
import { removeWatcherPid, Watcher } from "./watcher.js";

const [haltrDir, baseDir, sessionName] = process.argv.slice(2);

if (!haltrDir || !baseDir) {
	process.exit(1);
}

const session = sessionName || "haltr";
const configPath = join(haltrDir, "config.yaml");
const configYaml = loadAndValidateConfig(configPath);

const watcher = new Watcher(configYaml, haltrDir, baseDir, {
	listAlivePanes: () => tmuxListPanes(session),
	sendKeys: tmuxSendKeys,
});

watcher.start();

// Self-terminate when tmux session is gone
const sessionCheck = setInterval(async () => {
	try {
		const exists = await tmuxSessionExists(session);
		if (!exists) {
			watcher.stop();
			removeWatcherPid(haltrDir);
			clearInterval(sessionCheck);
			process.exit(0);
		}
	} catch {
		watcher.stop();
		removeWatcherPid(haltrDir);
		clearInterval(sessionCheck);
		process.exit(0);
	}
}, configYaml.watcher.poll_interval * 1000);
