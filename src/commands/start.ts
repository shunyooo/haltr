/**
 * `hal start` -- Start tmux session and main orchestrator agent.
 *
 * hal start [--cli <cli>]
 *
 * Steps:
 *   1. Check if tmux session `haltr` already exists -> error
 *   2. Clear any leftover .panes.yaml
 *   3. Create tmux session `haltr`
 *   4. The initial pane (pane 0) becomes the main orchestrator
 *   5. Generate prompt.md for pane 0
 *   6. Register pane 0 in .panes.yaml as main-orchestrator
 *   7. Start watcher process (placeholder for M8)
 */

import { execFileSync, fork } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import { getAgentSettings } from "../lib/agent-defaults.js";
import { PanesManager } from "../lib/panes-manager.js";
import { findHaltrDir, parseCli, validateCli } from "../lib/task-utils.js";
import {
	tmuxCreateSession,
	tmuxListPanes,
	tmuxSendKeys,
	tmuxSessionExists,
} from "../lib/tmux.js";
import {
	loadAndValidateConfig,
	loadAndValidateTask,
} from "../lib/validator.js";
import { Watcher, type WatcherDeps } from "../lib/watcher.js";
import {
	assemblePrompt,
	buildLaunchScript,
	type ClaudeSettings,
	convertAgentSettingsForClaude,
	readRules,
	renderHooks,
} from "./spawn.js";

export interface StartOptions {
	cli?: string;
	task?: string;
	sessionName?: string;
}

/**
 * Dependencies that can be injected for testing.
 */
export interface StartDeps {
	sessionExists: (name: string) => Promise<boolean>;
	createSession: (name: string, cwd?: string) => Promise<string>;
	sendKeys: (paneId: string, text: string) => Promise<void>;
	listAlivePanes?: () => Promise<string[]>;
}

const defaultDeps: StartDeps = {
	sessionExists: tmuxSessionExists,
	createSession: tmuxCreateSession,
	sendKeys: tmuxSendKeys,
	listAlivePanes: () => tmuxListPanes("haltr"), // default, overridden at runtime
};

/**
 * Core start logic, exported for testability.
 *
 * @param opts      command options
 * @param basePath  base path for haltr/ and .panes.yaml (defaults to cwd)
 * @param deps      injectable dependencies for testing
 */
export async function handleStart(
	opts: StartOptions = {},
	basePath?: string,
	deps: StartDeps = defaultDeps,
): Promise<{ paneId: string; cli: string }> {
	const base = basePath ?? process.cwd();
	const sessionName = opts.sessionName ?? "haltr";

	// 1. Check if session already exists
	const exists = await deps.sessionExists(sessionName);
	if (exists) {
		throw new Error(
			`tmux session "${sessionName}" already exists. Run 'hal stop' first.`,
		);
	}

	// 2. Find haltr directory and load config
	const haltrDir = findHaltrDir(base, false);
	const configPath = join(haltrDir, "config.yaml");
	const configYaml = loadAndValidateConfig(configPath);

	// Resolve CLI
	const resolvedCli = opts.cli ?? configYaml.orchestrator_cli;

	// Validate CLI against whitelist
	validateCli(resolvedCli);

	// 4. Create tmux session
	const paneId = await deps.createSession(sessionName, base);

	// 5. Generate prompt and hooks for main orchestrator
	let promptPath: string | undefined;
	let agentSettings: ClaudeSettings = {};
	const taskPath = opts.task ? resolve(opts.task) : undefined;

	try {
		// Render agent settings for main-orchestrator
		const hooksDir = renderHooks(haltrDir, "main-orchestrator", taskPath ?? "");
		agentSettings = convertAgentSettingsForClaude(hooksDir);

		if (taskPath && existsSync(taskPath)) {
			const taskYaml = loadAndValidateTask(taskPath);
			promptPath = assemblePrompt(
				hooksDir,
				haltrDir,
				"main-orchestrator",
				taskYaml,
				taskPath,
			);
		} else {
			promptPath = assembleOrchestratorPromptWithoutTask(hooksDir, haltrDir);
		}
	} catch {
		// Continue without prompt if anything fails
	}

	// 6. Register pane 0 as main-orchestrator
	// .panes.yaml is stored in the epic directory (if task exists) or haltr/ (fallback)
	const panesBase = taskPath ? dirname(taskPath) : haltrDir;
	const panesManager = new PanesManager(panesBase);
	panesManager.clear();
	panesManager.add({
		pane_id: paneId,
		step: "",
		role: "main-orchestrator",
		parent_pane_id: "",
		cli: resolvedCli,
		task_path: taskPath ?? "",
	});

	// Style orchestrator pane and enable border status
	if (deps === defaultDeps) {
		try {
			const { tmuxStylePane, tmuxEnableBorderStatus } = await import(
				"../lib/tmux.js"
			);
			await tmuxEnableBorderStatus(sessionName);
			await tmuxStylePane(paneId, "orchestrator", "yellow");
		} catch {
			// Best effort
		}
	}

	// 7. Start watcher as background process
	if (deps === defaultDeps) {
		// Production: fork watcher as detached child process
		const watcherScript = join(
			dirname(fileURLToPath(import.meta.url)),
			"..",
			"lib",
			"watcher-process.js",
		);
		const child = fork(watcherScript, [haltrDir, base, sessionName], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
	} else {
		// Test: start watcher in-process
		const watcherDeps: WatcherDeps = {
			listAlivePanes: deps.listAlivePanes ?? (() => tmuxListPanes(sessionName)),
			sendKeys: deps.sendKeys,
		};
		const watcher = new Watcher(configYaml, haltrDir, base, watcherDeps);
		watcher.start();
	}

	// Launch orchestrator CLI in pane 0
	try {
		const hooksDir = join(haltrDir, ".hooks", "001_main-orchestrator");
		if (promptPath) {
			const scriptPath = buildLaunchScript(
				resolvedCli,
				"main-orchestrator",
				hooksDir,
				promptPath,
			);
			await deps.sendKeys(paneId, `bash '${scriptPath}'`);
		} else {
			const { provider, model } = parseCli(resolvedCli);
			let cliCommand = provider;
			if (model) cliCommand += ` --model ${model}`;
			await deps.sendKeys(paneId, cliCommand);
		}
	} catch {
		// Best effort
	}

	console.log(`Started haltr session with main orchestrator (${resolvedCli})`);
	console.log(`  Pane: ${paneId}`);
	if (promptPath) {
		console.log(`  Prompt: ${promptPath}`);
	}

	// 8. Attach to tmux session (gives control to the user)
	if (deps === defaultDeps) {
		try {
			execFileSync("tmux", ["attach", "-t", sessionName], { stdio: "inherit" });
		} catch {
			// User detached from tmux — that's fine
		}
	}

	return { paneId, cli: resolvedCli };
}

/**
 * Generate a prompt for the main orchestrator when no task exists yet.
 * Uses the prompt template from the agent YAML.
 */
function assembleOrchestratorPromptWithoutTask(
	hooksDir: string,
	haltrDir: string,
): string {
	const agentYaml = getAgentSettings(haltrDir, "main-orchestrator");
	const parsed = yaml.load(agentYaml) as Record<string, unknown> | null;
	let template = (parsed?.prompt as string) ?? "You are the orchestrator.";

	const rules = readRules(haltrDir);
	const workdir = haltrDir.replace(/\/haltr$/, "");

	template = template.replace(/\{\{rules\}\}/g, rules);
	template = template.replace(/\{\{task\}\}/g, "");
	template = template.replace(/\{\{step\}\}/g, "");
	template = template.replace(/\{\{task_id\}\}/g, "");
	template = template.replace(/\{\{context\}\}/g, "");
	template = template.replace(/\{\{step_details\}\}/g, "");
	template = template.replace(/\{\{accept_details\}\}/g, "");
	template = template.replace(/\{\{steps_overview\}\}/g, "");
	template = template.replace(/\{\{workdir\}\}/g, workdir);

	const promptPath = join(hooksDir, "prompt.md");
	writeFileSync(promptPath, template, "utf-8");
	return promptPath;
}
