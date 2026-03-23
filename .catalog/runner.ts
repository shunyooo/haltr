/**
 * Story runner - executes stories and captures output
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import type { Story } from "./stories.js";

export interface StoryResult {
	story: Story;
	output: string;
	exitCode: number;
	error?: string;
}

/**
 * Setup types for different test scenarios
 */
type SetupType = NonNullable<Story["setup"]>;

/**
 * Create a temporary directory with haltr structure
 */
function createTempDir(): string {
	const tmpDir = mkdirSync(join(tmpdir(), `haltr-catalog-${Date.now()}`), { recursive: true });
	return tmpDir!;
}

/**
 * Setup minimal haltr structure
 */
function setupMinimal(baseDir: string): string {
	const workDir = join(baseDir, "work");
	mkdirSync(workDir, { recursive: true });
	mkdirSync(join(workDir, "context", "skills"), { recursive: true });
	mkdirSync(join(workDir, "context", "knowledge"), { recursive: true });
	mkdirSync(join(workDir, "epics"), { recursive: true });
	mkdirSync(join(workDir, ".sessions"), { recursive: true });

	// Write .haltr.json
	writeFileSync(join(baseDir, ".haltr.json"), JSON.stringify({ directory: "work" }, null, 2));

	// Write context files
	writeFileSync(join(workDir, "context", "index.yaml"), yaml.dump([]));
	writeFileSync(join(workDir, "context", "history.yaml"), yaml.dump({}));

	return workDir;
}

/**
 * Setup with an epic
 */
function setupWithEpic(baseDir: string): string {
	const workDir = setupMinimal(baseDir);
	const epicDir = join(workDir, "epics", "20260323-001_test-epic");
	mkdirSync(epicDir, { recursive: true });
	return workDir;
}

/**
 * Setup with a task
 */
function setupWithTask(baseDir: string, sessionId = "test-session-001"): string {
	const workDir = setupWithEpic(baseDir);
	const epicDir = join(workDir, "epics", "20260323-001_test-epic");

	// Create task.yaml
	const task = {
		id: "task-001",
		goal: "テスト用タスク",
		status: "pending",
		steps: [],
	};
	writeFileSync(join(epicDir, "task.yaml"), yaml.dump(task));

	// Create session mapping
	const sessionsDir = join(workDir, ".sessions");
	writeFileSync(join(sessionsDir, sessionId), join(epicDir, "task.yaml"));

	return workDir;
}

/**
 * Setup with steps (all pending)
 */
function setupWithSteps(baseDir: string, sessionId = "test-session-001"): string {
	const workDir = setupWithEpic(baseDir);
	const epicDir = join(workDir, "epics", "20260323-001_test-epic");

	// Create task.yaml with steps (all pending)
	const task = {
		id: "task-001",
		goal: "テスト用タスク",
		status: "in_progress",
		steps: [
			{ id: "s1", goal: "ステップ1", status: "pending" },
			{ id: "s2", goal: "ステップ2", status: "pending" },
		],
	};
	writeFileSync(join(epicDir, "task.yaml"), yaml.dump(task));

	// Create session mapping
	const sessionsDir = join(workDir, ".sessions");
	writeFileSync(join(sessionsDir, sessionId), join(epicDir, "task.yaml"));

	return workDir;
}

/**
 * Setup with steps (s1 is in_progress with accept + verified)
 */
function setupWithStepsActive(baseDir: string, sessionId = "test-session-001"): string {
	const workDir = setupWithEpic(baseDir);
	const epicDir = join(workDir, "epics", "20260323-001_test-epic");

	// Create task.yaml with steps (s1 is in_progress, has accept, and verified)
	const task = {
		id: "task-001",
		goal: "テスト用タスク",
		status: "in_progress",
		steps: [
			{
				id: "s1",
				goal: "ステップ1",
				accept: "受入条件を満たしている",
				status: "in_progress",
				verified: true,
			},
			{ id: "s2", goal: "ステップ2", status: "pending" },
		],
	};
	writeFileSync(join(epicDir, "task.yaml"), yaml.dump(task));

	// Create session mapping
	const sessionsDir = join(workDir, ".sessions");
	writeFileSync(join(sessionsDir, sessionId), join(epicDir, "task.yaml"));

	return workDir;
}

/**
 * Setup with steps (s1 is in_progress, no accept criteria)
 */
function setupWithStepsActiveNoAccept(baseDir: string, sessionId = "test-session-001"): string {
	const workDir = setupWithEpic(baseDir);
	const epicDir = join(workDir, "epics", "20260323-001_test-epic");

	// Create task.yaml with steps (s1 is in_progress, no accept)
	const task = {
		id: "task-001",
		goal: "テスト用タスク",
		status: "in_progress",
		steps: [
			{
				id: "s1",
				goal: "ステップ1",
				status: "in_progress",
			},
			{ id: "s2", goal: "ステップ2", status: "pending" },
		],
	};
	writeFileSync(join(epicDir, "task.yaml"), yaml.dump(task));

	// Create session mapping
	const sessionsDir = join(workDir, ".sessions");
	writeFileSync(join(sessionsDir, sessionId), join(epicDir, "task.yaml"));

	return workDir;
}

/**
 * Setup with steps (s1 is in_progress with accept but NOT verified)
 */
function setupWithStepsActiveUnverified(baseDir: string, sessionId = "test-session-001"): string {
	const workDir = setupWithEpic(baseDir);
	const epicDir = join(workDir, "epics", "20260323-001_test-epic");

	// Create task.yaml with steps (s1 is in_progress, has accept, not verified)
	const task = {
		id: "task-001",
		goal: "テスト用タスク",
		status: "in_progress",
		steps: [
			{
				id: "s1",
				goal: "ステップ1",
				accept: "受入条件を満たしている",
				status: "in_progress",
			},
			{ id: "s2", goal: "ステップ2", status: "pending" },
		],
	};
	writeFileSync(join(epicDir, "task.yaml"), yaml.dump(task));

	// Create session mapping
	const sessionsDir = join(workDir, ".sessions");
	writeFileSync(join(sessionsDir, sessionId), join(epicDir, "task.yaml"));

	return workDir;
}

/**
 * Setup with context entries
 */
function setupWithContext(baseDir: string): string {
	const workDir = setupMinimal(baseDir);

	// Create skill entry
	const skillDir = join(workDir, "context", "skills", "typescript-patterns");
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(join(skillDir, "SKILL.md"), "# TypeScript Patterns\n\nコーディングパターン集");

	// Update index (must include path field)
	const index = [
		{
			id: "typescript-patterns",
			type: "skill",
			description: "TypeScriptのコーディングパターン",
			path: "context/skills/typescript-patterns/SKILL.md",
		},
	];
	writeFileSync(join(workDir, "context", "index.yaml"), yaml.dump(index));

	return workDir;
}

/**
 * Run setup for a story
 */
function runSetup(setupType: SetupType, baseDir: string, sessionId?: string): void {
	switch (setupType) {
		case "minimal":
			setupMinimal(baseDir);
			break;
		case "with-epic":
			setupWithEpic(baseDir);
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
		case "with-context":
			setupWithContext(baseDir);
			break;
	}
}

/**
 * Execute a single story and capture output
 */
export function runStory(story: Story, halBinPath: string): StoryResult {
	const tmpDir = join(tmpdir(), `haltr-catalog-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tmpDir, { recursive: true });

	try {
		// Run setup if specified
		const sessionId = story.env?.HALTR_SESSION_ID;
		if (story.setup) {
			runSetup(story.setup, tmpDir, sessionId);
		}

		// Build command
		// Replace 'hal' with actual path
		const cmd = story.input.replace(/^hal\s/, `node ${halBinPath} `);

		// Build environment
		const env: Record<string, string> = {
			...process.env as Record<string, string>,
			...story.env,
		};

		// Execute command
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
		// Cleanup
		try {
			rmSync(tmpDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	}
}

/**
 * Run all stories
 */
export function runAllStories(stories: Story[], halBinPath: string): StoryResult[] {
	return stories.map((story) => runStory(story, halBinPath));
}

/**
 * Run stories by category
 */
export function runStoriesByCategory(
	stories: Story[],
	category: string,
	halBinPath: string,
): StoryResult[] {
	const filtered = stories.filter((s) => s.category === category);
	return runAllStories(filtered, halBinPath);
}

/**
 * Run stories by tag
 */
export function runStoriesByTag(
	stories: Story[],
	tag: string,
	halBinPath: string,
): StoryResult[] {
	const filtered = stories.filter((s) => s.tags.includes(tag as any));
	return runAllStories(filtered, halBinPath);
}
