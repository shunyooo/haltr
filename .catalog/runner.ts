/**
 * Story runner - executes stories and captures output (v3)
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import type { Story } from "./stories.js";

export interface StoryResult {
	story: Story;
	output: string;
	exitCode: number;
	error?: string;
}

type SetupType = NonNullable<Story["setup"]>;

function setupWithTask(baseDir: string, sessionId?: string): void {
	const task = {
		id: "task-001",
		goal: "Test task",
		status: "pending",
		steps: [],
		history: [{ at: new Date().toISOString(), type: "created" }],
	};
	writeFileSync(join(baseDir, "task.yaml"), yaml.dump(task, { lineWidth: -1 }));

	if (sessionId) {
		const sessionsDir = join(homedir(), ".haltr", "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		writeFileSync(join(sessionsDir, sessionId), join(baseDir, "task.yaml"));
	}
}

function setupWithSteps(baseDir: string, sessionId?: string): void {
	const task = {
		id: "task-001",
		goal: "Test task",
		status: "in_progress",
		steps: [
			{ id: "s1", goal: "Step 1", status: "pending" },
			{ id: "s2", goal: "Step 2", status: "pending" },
		],
		history: [{ at: new Date().toISOString(), type: "created" }],
	};
	writeFileSync(join(baseDir, "task.yaml"), yaml.dump(task, { lineWidth: -1 }));

	if (sessionId) {
		const sessionsDir = join(homedir(), ".haltr", "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		writeFileSync(join(sessionsDir, sessionId), join(baseDir, "task.yaml"));
	}
}

function setupWithStepsActive(baseDir: string, sessionId?: string): void {
	const task = {
		id: "task-001",
		goal: "Test task",
		status: "in_progress",
		steps: [
			{ id: "s1", goal: "Step 1", accept: "Accept criteria met", status: "in_progress", verified: true },
			{ id: "s2", goal: "Step 2", status: "pending" },
		],
		history: [{ at: new Date().toISOString(), type: "created" }],
	};
	writeFileSync(join(baseDir, "task.yaml"), yaml.dump(task, { lineWidth: -1 }));

	if (sessionId) {
		const sessionsDir = join(homedir(), ".haltr", "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		writeFileSync(join(sessionsDir, sessionId), join(baseDir, "task.yaml"));
	}
}

function setupWithStepsActiveNoAccept(baseDir: string, sessionId?: string): void {
	const task = {
		id: "task-001",
		goal: "Test task",
		status: "in_progress",
		steps: [
			{ id: "s1", goal: "Step 1", status: "in_progress" },
			{ id: "s2", goal: "Step 2", status: "pending" },
		],
		history: [{ at: new Date().toISOString(), type: "created" }],
	};
	writeFileSync(join(baseDir, "task.yaml"), yaml.dump(task, { lineWidth: -1 }));

	if (sessionId) {
		const sessionsDir = join(homedir(), ".haltr", "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		writeFileSync(join(sessionsDir, sessionId), join(baseDir, "task.yaml"));
	}
}

function setupWithStepsActiveUnverified(baseDir: string, sessionId?: string): void {
	const task = {
		id: "task-001",
		goal: "Test task",
		status: "in_progress",
		steps: [
			{ id: "s1", goal: "Step 1", accept: "Accept criteria met", status: "in_progress" },
			{ id: "s2", goal: "Step 2", status: "pending" },
		],
		history: [{ at: new Date().toISOString(), type: "created" }],
	};
	writeFileSync(join(baseDir, "task.yaml"), yaml.dump(task, { lineWidth: -1 }));

	if (sessionId) {
		const sessionsDir = join(homedir(), ".haltr", "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		writeFileSync(join(sessionsDir, sessionId), join(baseDir, "task.yaml"));
	}
}

function runSetup(setupType: SetupType, baseDir: string, sessionId?: string): void {
	switch (setupType) {
		case "none":
			break;
		case "with-task":
			setupWithTask(baseDir, sessionId);
			break;
		case "with-steps":
			setupWithSteps(baseDir, sessionId);
			break;
		case "with-steps-active":
			setupWithStepsActive(baseDir, sessionId);
			break;
		case "with-steps-active-no-accept":
			setupWithStepsActiveNoAccept(baseDir, sessionId);
			break;
		case "with-steps-active-unverified":
			setupWithStepsActiveUnverified(baseDir, sessionId);
			break;
	}
}

export function runStory(story: Story, halBinPath: string): StoryResult {
	const tmpDir = join(tmpdir(), `haltr-catalog-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tmpDir, { recursive: true });

	try {
		const sessionId = story.env?.HALTR_SESSION_ID;
		if (story.setup) {
			runSetup(story.setup, tmpDir, sessionId);
		}

		const cmd = story.input.replace(/\bhal\s/g, `node ${halBinPath} `);

		const env: Record<string, string> = {
			...process.env as Record<string, string>,
			...story.env,
		};

		const result = spawnSync("bash", ["-c", cmd], {
			cwd: tmpDir,
			env,
			encoding: "utf-8",
			timeout: 10000,
		});

		const output = (result.stdout || "") + (result.stderr || "");

		return {
			story,
			output: output.trim(),
			exitCode: result.status ?? 1,
			error: result.error?.message,
		};
	} finally {
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch { /* ignore */ }
	}
}

export function runAllStories(stories: Story[], halBinPath: string): StoryResult[] {
	return stories.map((story) => runStory(story, halBinPath));
}
