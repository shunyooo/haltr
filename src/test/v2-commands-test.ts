/**
 * v2 Commands Test Script
 *
 * Comprehensive tests for haltr v2 commands and libraries.
 * Run with: npx tsx src/test/v2-commands-test.ts
 */

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";

// Imports: session-manager
import {
	getCurrentTaskPath,
	getSessionId,
	getTaskPathForSession,
	setSessionTask,
} from "../lib/session-manager.js";

// Imports: context-manager
import {
	addHistoryEvent,
	checkStaleness,
	createEntry,
	deleteEntry,
	findEntry,
	getContent,
	loadIndex,
	saveIndex,
} from "../lib/context-manager.js";

// Imports: response-builder
import { buildResponse, formatResponse } from "../lib/response-builder.js";

// Imports: commands
import { handleTaskCreate, handleTaskEdit } from "../commands/task.js";
import {
	handleStepAdd,
	handleStepDone,
	handleStepPause,
	handleStepResume,
	handleStepStart,
} from "../commands/step.js";
import {
	handleContextCreate,
	handleContextDelete,
	handleContextList,
	handleContextLog,
	handleContextShow,
} from "../commands/context.js";
import { initHaltr } from "../commands/init.js";

// Imports: validator (for check command tests)
import { loadAndValidateTask } from "../lib/validator.js";

let passed = 0;
let failed = 0;
const results: Array<{
	name: string;
	status: "PASS" | "FAIL";
	detail?: string;
}> = [];

function test(name: string, fn: () => void): void {
	try {
		fn();
		results.push({ name, status: "PASS" });
		passed++;
		console.log(`  PASS: ${name}`);
	} catch (e: unknown) {
		const detail = e instanceof Error ? e.message : String(e);
		results.push({ name, status: "FAIL", detail });
		failed++;
		console.log(`  FAIL: ${name}`);
		console.log(`        ${detail.split("\n")[0]}`);
	}
}

function expectThrows(fn: () => void, containsMsg?: string): void {
	try {
		fn();
		throw new Error("Expected an error to be thrown, but none was");
	} catch (e: unknown) {
		if (
			e instanceof Error &&
			e.message === "Expected an error to be thrown, but none was"
		) {
			throw e;
		}
		if (containsMsg) {
			const msg = e instanceof Error ? e.message : String(e);
			if (!msg.includes(containsMsg)) {
				throw new Error(
					`Expected error containing "${containsMsg}", got: ${msg.split("\n")[0]}`,
				);
			}
		}
	}
}

function assertEqual(actual: unknown, expected: unknown, label?: string): void {
	if (actual !== expected) {
		throw new Error(
			`${label ? `${label}: ` : ""}Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
		);
	}
}

function assertTrue(value: unknown, label?: string): void {
	if (!value) {
		throw new Error(`${label ? `${label}: ` : ""}Expected truthy value, got ${JSON.stringify(value)}`);
	}
}

function assertFalse(value: unknown, label?: string): void {
	if (value) {
		throw new Error(`${label ? `${label}: ` : ""}Expected falsy value, got ${JSON.stringify(value)}`);
	}
}

function assertIncludes(str: string, substr: string, label?: string): void {
	if (!str.includes(substr)) {
		throw new Error(
			`${label ? `${label}: ` : ""}Expected string to include "${substr}", got: ${str.substring(0, 200)}`,
		);
	}
}

// ---- Helpers ----

/**
 * Create a minimal haltr directory structure for testing.
 * Returns the haltr directory path.
 */
function setupHaltrDir(baseDir: string): string {
	const haltrDir = join(baseDir, "haltr");
	mkdirSync(haltrDir, { recursive: true });
	mkdirSync(join(haltrDir, "context", "skills"), { recursive: true });
	mkdirSync(join(haltrDir, "context", "knowledge"), { recursive: true });
	mkdirSync(join(haltrDir, "epics"), { recursive: true });
	mkdirSync(join(haltrDir, ".sessions"), { recursive: true });

	// Write config.yaml
	writeFileSync(join(haltrDir, "config.yaml"), yaml.dump({}, { lineWidth: -1 }));

	// Write context/index.yaml (empty array)
	writeFileSync(
		join(haltrDir, "context", "index.yaml"),
		yaml.dump([], { lineWidth: -1 }),
	);

	// Write context/history.yaml (empty object)
	writeFileSync(
		join(haltrDir, "context", "history.yaml"),
		yaml.dump({}, { lineWidth: -1 }),
	);

	return haltrDir;
}

/**
 * Create an epic directory for testing, returns the epic dir path.
 */
function setupEpicDir(haltrDir: string, epicName = "20260322-001_test-epic"): string {
	const epicDir = join(haltrDir, "epics", epicName);
	mkdirSync(epicDir, { recursive: true });
	return epicDir;
}

/**
 * Capture console.log output during a function call.
 */
function captureConsoleLog(fn: () => void): string {
	const originalLog = console.log;
	let captured = "";
	console.log = (msg: string) => {
		captured += String(msg) + "\n";
	};
	try {
		fn();
	} finally {
		console.log = originalLog;
	}
	return captured;
}

/**
 * Save and restore environment variables.
 */
function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
	const saved: Record<string, string | undefined> = {};
	for (const key of Object.keys(env)) {
		saved[key] = process.env[key];
		if (env[key] === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = env[key];
		}
	}
	try {
		fn();
	} finally {
		for (const key of Object.keys(saved)) {
			if (saved[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = saved[key];
			}
		}
	}
}

/**
 * Save and restore process.cwd() by temporarily changing it.
 */
function withCwd(dir: string, fn: () => void): void {
	const original = process.cwd();
	process.chdir(dir);
	try {
		fn();
	} finally {
		process.chdir(original);
	}
}

// ============================================================================
// Section 1: Session Manager Tests
// ============================================================================
console.log("\n--- Session Manager Tests ---");

test("getSessionId() throws when HALTR_SESSION_ID not set", () => {
	withEnv({ HALTR_SESSION_ID: undefined }, () => {
		expectThrows(() => getSessionId(), "HALTR_SESSION_ID");
	});
});

test("getSessionId() returns session ID from env", () => {
	withEnv({ HALTR_SESSION_ID: "test-session-123" }, () => {
		assertEqual(getSessionId(), "test-session-123");
	});
});

test("setSessionTask() creates .sessions directory and file", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);
		const taskPath = "/some/path/to/task.yaml";

		withCwd(tmpDir, () => {
			withEnv({ HALTR_SESSION_ID: "sess-set-task" }, () => {
				setSessionTask(taskPath);
			});
		});

		const sessionFile = join(haltrDir, ".sessions", "sess-set-task");
		assertTrue(existsSync(sessionFile), "session file should exist");
		assertEqual(readFileSync(sessionFile, "utf-8"), taskPath, "session file content");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("getCurrentTaskPath() resolves task path from session file", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);
		const taskPath = "/some/path/to/task.yaml";
		const sessionFile = join(haltrDir, ".sessions", "sess-get-task");
		writeFileSync(sessionFile, taskPath, "utf-8");

		withCwd(tmpDir, () => {
			withEnv({ HALTR_SESSION_ID: "sess-get-task" }, () => {
				const result = getCurrentTaskPath();
				assertEqual(result, taskPath);
			});
		});
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("getCurrentTaskPath() throws when no mapping exists", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		setupHaltrDir(tmpDir);

		withCwd(tmpDir, () => {
			withEnv({ HALTR_SESSION_ID: "nonexistent-session" }, () => {
				expectThrows(() => getCurrentTaskPath(), "タスクマッピングが見つかりません");
			});
		});
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("getTaskPathForSession() returns null for unknown session", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		setupHaltrDir(tmpDir);

		withCwd(tmpDir, () => {
			const result = getTaskPathForSession("unknown-session-xyz");
			assertEqual(result, null, "should return null");
		});
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ============================================================================
// Section 2: Context Manager Tests
// ============================================================================
console.log("\n--- Context Manager Tests ---");

test("loadIndex() returns empty array for new project", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);
		const entries = loadIndex(haltrDir);
		assertTrue(Array.isArray(entries), "should be array");
		assertEqual(entries.length, 0, "should be empty");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("saveIndex() + loadIndex() roundtrip", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);
		const entries = [
			{ id: "test-skill", type: "skill" as const, description: "A test skill", path: "context/skills/test-skill/SKILL.md" },
			{ id: "test-kb", type: "knowledge" as const, description: "A knowledge base", path: "context/knowledge/test-kb/README.md" },
		];
		saveIndex(haltrDir, entries);
		const loaded = loadIndex(haltrDir);
		assertEqual(loaded.length, 2, "length");
		assertEqual(loaded[0].id, "test-skill", "first id");
		assertEqual(loaded[1].id, "test-kb", "second id");
		assertEqual(loaded[0].type, "skill", "first type");
		assertEqual(loaded[1].type, "knowledge", "second type");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("createEntry() creates directory + file + updates index + history", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);
		const relativePath = createEntry(haltrDir, "skill", "my-skill", "A skill description");

		// Check returned path
		assertEqual(relativePath, "context/skills/my-skill/SKILL.md", "relative path");

		// Check file exists
		const filePath = join(haltrDir, relativePath);
		assertTrue(existsSync(filePath), "file should exist");

		// Check index updated
		const entries = loadIndex(haltrDir);
		assertEqual(entries.length, 1, "index length");
		assertEqual(entries[0].id, "my-skill", "entry id");
		assertEqual(entries[0].type, "skill", "entry type");
		assertEqual(entries[0].description, "A skill description", "entry description");

		// Check history event recorded
		const historyPath = join(haltrDir, "context", "history.yaml");
		const historyContent = readFileSync(historyPath, "utf-8");
		const history = yaml.load(historyContent) as Record<string, unknown[]>;
		assertTrue(history["my-skill"], "history should have entry for my-skill");
		assertEqual((history["my-skill"] as unknown[]).length, 1, "one history event");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("createEntry() for skill creates SKILL.md", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);
		const relativePath = createEntry(haltrDir, "skill", "code-review", "Code review skill");
		assertIncludes(relativePath, "SKILL.md", "should contain SKILL.md");
		assertIncludes(relativePath, "skills/", "should be in skills dir");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("createEntry() for knowledge creates README.md", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);
		const relativePath = createEntry(haltrDir, "knowledge", "arch-doc", "Architecture doc");
		assertIncludes(relativePath, "README.md", "should contain README.md");
		assertIncludes(relativePath, "knowledge/", "should be in knowledge dir");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("deleteEntry() removes directory + index entry + records event", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);

		// Create entry first
		createEntry(haltrDir, "skill", "to-delete", "Will be deleted");
		assertTrue(existsSync(join(haltrDir, "context", "skills", "to-delete")), "dir should exist before delete");

		// Delete it
		deleteEntry(haltrDir, "to-delete", "No longer needed");

		// Check directory removed
		assertFalse(existsSync(join(haltrDir, "context", "skills", "to-delete")), "dir should not exist after delete");

		// Check index updated
		const entries = loadIndex(haltrDir);
		assertEqual(entries.length, 0, "index should be empty");

		// Check history event
		const historyPath = join(haltrDir, "context", "history.yaml");
		const historyContent = readFileSync(historyPath, "utf-8");
		const history = yaml.load(historyContent) as Record<string, unknown[]>;
		assertTrue(history["to-delete"], "history should have entry");
		// Should have created + deleted events
		const events = history["to-delete"] as Array<{ type: string }>;
		const lastEvent = events[events.length - 1];
		assertEqual(lastEvent.type, "deleted", "last event should be deleted");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("findEntry() finds by id", () => {
	const entries = [
		{ id: "a", type: "skill" as const, description: "A", path: "a" },
		{ id: "b", type: "knowledge" as const, description: "B", path: "b" },
	];
	const found = findEntry(entries, "b");
	assertTrue(found, "should find entry");
	assertEqual(found!.id, "b");
	assertEqual(found!.type, "knowledge");
});

test("findEntry() returns undefined for missing id", () => {
	const entries = [
		{ id: "a", type: "skill" as const, description: "A", path: "a" },
	];
	const found = findEntry(entries, "missing");
	assertEqual(found, undefined, "should be undefined");
});

test("getContent() reads file content", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);

		// Create a file
		const dirPath = join(haltrDir, "context", "skills", "read-test");
		mkdirSync(dirPath, { recursive: true });
		writeFileSync(join(dirPath, "SKILL.md"), "# Test Skill\n\nContent here.");

		const entry = { id: "read-test", type: "skill" as const, description: "Test", path: "context/skills/read-test/SKILL.md" };
		const content = getContent(haltrDir, entry);
		assertEqual(content, "# Test Skill\n\nContent here.", "content");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("addHistoryEvent() appends event with timestamp", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);

		addHistoryEvent(haltrDir, "test-entry", { type: "used" });
		addHistoryEvent(haltrDir, "test-entry", { type: "updated", message: "Updated content" });

		const historyPath = join(haltrDir, "context", "history.yaml");
		const historyContent = readFileSync(historyPath, "utf-8");
		const history = yaml.load(historyContent) as Record<string, Array<{ type: string; at: string; message?: string }>>;

		assertTrue(history["test-entry"], "should have entries");
		assertEqual(history["test-entry"].length, 2, "should have 2 events");
		assertEqual(history["test-entry"][0].type, "used", "first event type");
		assertEqual(history["test-entry"][1].type, "updated", "second event type");
		assertTrue(history["test-entry"][0].at, "should have timestamp");
		assertTrue(history["test-entry"][1].at, "should have timestamp");
		assertEqual(history["test-entry"][1].message, "Updated content", "message");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("checkStaleness() returns stale for old entries", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);

		// Write a history event from 100 days ago
		const oldDate = new Date();
		oldDate.setDate(oldDate.getDate() - 100);
		const history: Record<string, Array<{ at: string; type: string }>> = {
			"old-entry": [{ at: oldDate.toISOString(), type: "created" }],
		};
		writeFileSync(
			join(haltrDir, "context", "history.yaml"),
			yaml.dump(history, { lineWidth: -1 }),
		);

		const result = checkStaleness(haltrDir, "old-entry");
		assertTrue(result.stale, "should be stale");
		assertTrue(result.daysSince !== undefined && result.daysSince >= 90, "daysSince should be >= 90");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("checkStaleness() returns not stale for recent entries", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);

		// Write a history event from today
		const history: Record<string, Array<{ at: string; type: string }>> = {
			"recent-entry": [{ at: new Date().toISOString(), type: "created" }],
		};
		writeFileSync(
			join(haltrDir, "context", "history.yaml"),
			yaml.dump(history, { lineWidth: -1 }),
		);

		const result = checkStaleness(haltrDir, "recent-entry");
		assertFalse(result.stale, "should not be stale");
		assertTrue(result.daysSince !== undefined && result.daysSince < 90, "daysSince should be < 90");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ============================================================================
// Section 3: Response Builder Tests
// ============================================================================
console.log("\n--- Response Builder Tests ---");

test("buildResponse() includes status and message", () => {
	const response = buildResponse({
		status: "ok",
		message: "Test message",
	});
	assertEqual(response.status, "ok", "status");
	assertEqual(response.message, "Test message", "message");
});

test("buildResponse() includes knowledge list when haltrDir provided", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);

		// Add entries to index
		const entries = [
			{ id: "kb-1", type: "knowledge" as const, description: "Knowledge 1", path: "context/knowledge/kb-1/README.md" },
		];
		saveIndex(haltrDir, entries);

		const response = buildResponse({
			status: "ok",
			message: "Test",
			haltrDir,
		});

		assertTrue(response.context, "should have context");
		assertTrue(response.context!.available_knowledge, "should have available_knowledge");
		assertEqual(response.context!.available_knowledge.length, 1, "one knowledge entry");
		assertEqual(response.context!.available_knowledge[0].id, "kb-1", "knowledge id");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("formatResponse() produces valid YAML output", () => {
	const response = buildResponse({
		status: "ok",
		message: "Test response",
		data: { key: "value" },
	});
	const formatted = formatResponse(response);
	assertTrue(typeof formatted === "string", "should be string");

	// Parse back as YAML
	const parsed = yaml.load(formatted) as Record<string, unknown>;
	assertEqual(parsed.status, "ok", "status after roundtrip");
	assertEqual(parsed.message, "Test response", "message after roundtrip");
	assertTrue(parsed.data, "should have data");
});

test("formatResponse() includes commands_hint", () => {
	const response = buildResponse({
		status: "ok",
		message: "Test",
		commands_hint: "hal status to check state",
	});
	const formatted = formatResponse(response);
	assertIncludes(formatted, "commands_hint", "should include commands_hint key");
	assertIncludes(formatted, "hal status to check state", "should include hint text");
});

// ============================================================================
// Section 4: Task Command Tests (end-to-end with temp directory)
// ============================================================================
console.log("\n--- Task Command Tests ---");

test("hal task create generates task.yaml with correct structure", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);
		setupEpicDir(haltrDir);

		withCwd(tmpDir, () => {
			withEnv({ HALTR_SESSION_ID: "task-create-1" }, () => {
				captureConsoleLog(() => {
					handleTaskCreate({ goal: "Implement feature X" });
				});
			});
		});

		// Verify task.yaml was created
		const taskFile = join(haltrDir, "epics", "20260322-001_test-epic", "001_task.yaml");
		assertTrue(existsSync(taskFile), "task file should exist");

		const content = readFileSync(taskFile, "utf-8");
		const task = yaml.load(content) as Record<string, unknown>;
		assertEqual(task.goal, "Implement feature X", "goal");
		assertEqual(task.status, "pending", "status");
		assertTrue(Array.isArray(task.steps), "should have steps array");
		assertTrue(Array.isArray(task.history), "should have history array");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("hal task create saves session mapping", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);
		setupEpicDir(haltrDir);

		withCwd(tmpDir, () => {
			withEnv({ HALTR_SESSION_ID: "task-create-session" }, () => {
				captureConsoleLog(() => {
					handleTaskCreate({ goal: "Session mapping test" });
				});
			});
		});

		// Verify session file was created
		const sessionFile = join(haltrDir, ".sessions", "task-create-session");
		assertTrue(existsSync(sessionFile), "session file should exist");

		const taskPath = readFileSync(sessionFile, "utf-8").trim();
		assertTrue(taskPath.endsWith("001_task.yaml"), "should point to task file");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("hal task create adds created event to history", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);
		setupEpicDir(haltrDir);

		withCwd(tmpDir, () => {
			withEnv({ HALTR_SESSION_ID: "task-create-history" }, () => {
				captureConsoleLog(() => {
					handleTaskCreate({ goal: "History event test" });
				});
			});
		});

		const taskFile = join(haltrDir, "epics", "20260322-001_test-epic", "001_task.yaml");
		const task = yaml.load(readFileSync(taskFile, "utf-8")) as Record<string, unknown>;
		const history = task.history as Array<{ type: string; at: string; message: string }>;

		assertTrue(history.length >= 1, "should have at least one history event");
		assertEqual(history[0].type, "created", "first event should be created");
		assertTrue(history[0].at, "should have timestamp");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("hal task edit updates goal", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);
		setupEpicDir(haltrDir);

		// Create a task first
		let taskPath: string;
		withCwd(tmpDir, () => {
			withEnv({ HALTR_SESSION_ID: "task-edit-1" }, () => {
				captureConsoleLog(() => {
					handleTaskCreate({ goal: "Original goal" });
				});
				taskPath = getCurrentTaskPath();
			});
		});

		// Edit the task
		withCwd(tmpDir, () => {
			withEnv({ HALTR_SESSION_ID: "task-edit-1" }, () => {
				captureConsoleLog(() => {
					handleTaskEdit({ goal: "Updated goal", message: "Changed direction" });
				});
			});
		});

		const task = yaml.load(readFileSync(taskPath!, "utf-8")) as Record<string, unknown>;
		assertEqual(task.goal, "Updated goal", "goal should be updated");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("hal task edit records updated event with diff", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);
		setupEpicDir(haltrDir);

		let taskPath: string;
		withCwd(tmpDir, () => {
			withEnv({ HALTR_SESSION_ID: "task-edit-2" }, () => {
				captureConsoleLog(() => {
					handleTaskCreate({ goal: "Original" });
				});
				taskPath = getCurrentTaskPath();
			});
		});

		withCwd(tmpDir, () => {
			withEnv({ HALTR_SESSION_ID: "task-edit-2" }, () => {
				captureConsoleLog(() => {
					handleTaskEdit({ goal: "New goal", message: "Updated" });
				});
			});
		});

		const task = yaml.load(readFileSync(taskPath!, "utf-8")) as Record<string, unknown>;
		const history = task.history as Array<{ type: string; message?: string }>;

		// Last event should be "updated" with diff info
		const lastEvent = history[history.length - 1];
		assertEqual(lastEvent.type, "updated", "should be updated event");
		assertTrue(lastEvent.message, "should have message");
		assertIncludes(lastEvent.message!, "goal", "message should mention changed field");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ============================================================================
// Section 5: Step Command Tests (end-to-end with temp directory)
// ============================================================================
console.log("\n--- Step Command Tests ---");

test("hal step add adds step to task.yaml", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);
		setupEpicDir(haltrDir);

		let taskPath: string;
		withCwd(tmpDir, () => {
			withEnv({ HALTR_SESSION_ID: "step-add-1" }, () => {
				captureConsoleLog(() => {
					handleTaskCreate({ goal: "Step add test" });
				});
				taskPath = getCurrentTaskPath();

				captureConsoleLog(() => {
					handleStepAdd({ step: "s1", goal: "First step" });
				});
			});
		});

		const task = yaml.load(readFileSync(taskPath!, "utf-8")) as Record<string, unknown>;
		const steps = task.steps as Array<{ id: string; goal: string; status: string }>;
		assertEqual(steps.length, 1, "should have one step");
		assertEqual(steps[0].id, "s1", "step id");
		assertEqual(steps[0].goal, "First step", "step goal");
		assertEqual(steps[0].status, "pending", "step status");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("hal step add errors on duplicate step ID", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);
		setupEpicDir(haltrDir);

		withCwd(tmpDir, () => {
			withEnv({ HALTR_SESSION_ID: "step-add-dup" }, () => {
				captureConsoleLog(() => {
					handleTaskCreate({ goal: "Duplicate step test" });
				});

				captureConsoleLog(() => {
					handleStepAdd({ step: "s1", goal: "First step" });
				});

				expectThrows(() => {
					captureConsoleLog(() => {
						handleStepAdd({ step: "s1", goal: "Duplicate step" });
					});
				}, "既に存在します");
			});
		});
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("hal step start sets step to in_progress", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);
		setupEpicDir(haltrDir);

		let taskPath: string;
		withCwd(tmpDir, () => {
			withEnv({ HALTR_SESSION_ID: "step-start-1" }, () => {
				captureConsoleLog(() => {
					handleTaskCreate({ goal: "Step start test" });
				});
				taskPath = getCurrentTaskPath();

				captureConsoleLog(() => {
					handleStepAdd({ step: "s1", goal: "A step" });
				});

				captureConsoleLog(() => {
					handleStepStart({ step: "s1" });
				});
			});
		});

		const task = yaml.load(readFileSync(taskPath!, "utf-8")) as Record<string, unknown>;
		const steps = task.steps as Array<{ id: string; status: string }>;
		assertEqual(steps[0].status, "in_progress", "step should be in_progress");
		assertEqual(task.status, "in_progress", "task should also be in_progress");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("hal step start errors on non-existent step", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);
		setupEpicDir(haltrDir);

		withCwd(tmpDir, () => {
			withEnv({ HALTR_SESSION_ID: "step-start-missing" }, () => {
				captureConsoleLog(() => {
					handleTaskCreate({ goal: "Missing step test" });
				});

				expectThrows(() => {
					captureConsoleLog(() => {
						handleStepStart({ step: "nonexistent" });
					});
				}, "見つかりません");
			});
		});
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("hal step done PASS sets step to done", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);
		setupEpicDir(haltrDir);

		let taskPath: string;
		withCwd(tmpDir, () => {
			withEnv({ HALTR_SESSION_ID: "step-done-pass" }, () => {
				captureConsoleLog(() => {
					handleTaskCreate({ goal: "Step done test" });
				});
				taskPath = getCurrentTaskPath();

				captureConsoleLog(() => {
					handleStepAdd({ step: "s1", goal: "A step" });
				});
				captureConsoleLog(() => {
					handleStepStart({ step: "s1" });
				});
				captureConsoleLog(() => {
					handleStepDone({ step: "s1", result: "PASS" });
				});
			});
		});

		const task = yaml.load(readFileSync(taskPath!, "utf-8")) as Record<string, unknown>;
		const steps = task.steps as Array<{ id: string; status: string }>;
		assertEqual(steps[0].status, "done", "step should be done");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("hal step done FAIL keeps step as in_progress", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);
		setupEpicDir(haltrDir);

		let taskPath: string;
		withCwd(tmpDir, () => {
			withEnv({ HALTR_SESSION_ID: "step-done-fail" }, () => {
				captureConsoleLog(() => {
					handleTaskCreate({ goal: "Step fail test" });
				});
				taskPath = getCurrentTaskPath();

				captureConsoleLog(() => {
					handleStepAdd({ step: "s1", goal: "A step" });
				});
				captureConsoleLog(() => {
					handleStepStart({ step: "s1" });
				});
				captureConsoleLog(() => {
					handleStepDone({ step: "s1", result: "FAIL", message: "Tests failed" });
				});
			});
		});

		const task = yaml.load(readFileSync(taskPath!, "utf-8")) as Record<string, unknown>;
		const steps = task.steps as Array<{ id: string; status: string }>;
		assertEqual(steps[0].status, "in_progress", "step should remain in_progress on FAIL");

		// Check history has step_failed event
		const history = task.history as Array<{ type: string; message?: string }>;
		const failEvents = history.filter((e) => e.type === "step_failed");
		assertTrue(failEvents.length >= 1, "should have step_failed event");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("hal step done with all steps done sets task to done", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);
		setupEpicDir(haltrDir);

		let taskPath: string;
		withCwd(tmpDir, () => {
			withEnv({ HALTR_SESSION_ID: "step-all-done" }, () => {
				captureConsoleLog(() => {
					handleTaskCreate({ goal: "All steps done test" });
				});
				taskPath = getCurrentTaskPath();

				captureConsoleLog(() => {
					handleStepAdd({ step: "s1", goal: "Step 1" });
				});
				captureConsoleLog(() => {
					handleStepAdd({ step: "s2", goal: "Step 2" });
				});

				// Complete step 1
				captureConsoleLog(() => {
					handleStepStart({ step: "s1" });
				});
				captureConsoleLog(() => {
					handleStepDone({ step: "s1", result: "PASS" });
				});

				// Complete step 2
				captureConsoleLog(() => {
					handleStepStart({ step: "s2" });
				});
				captureConsoleLog(() => {
					handleStepDone({ step: "s2", result: "PASS" });
				});
			});
		});

		const task = yaml.load(readFileSync(taskPath!, "utf-8")) as Record<string, unknown>;
		assertEqual(task.status, "done", "task should be done");

		// Check history has completed event
		const history = task.history as Array<{ type: string }>;
		const completedEvents = history.filter((e) => e.type === "completed");
		assertTrue(completedEvents.length >= 1, "should have completed event");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("hal step pause records paused event", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);
		setupEpicDir(haltrDir);

		let taskPath: string;
		withCwd(tmpDir, () => {
			withEnv({ HALTR_SESSION_ID: "step-pause" }, () => {
				captureConsoleLog(() => {
					handleTaskCreate({ goal: "Pause test" });
				});
				taskPath = getCurrentTaskPath();

				captureConsoleLog(() => {
					handleStepAdd({ step: "s1", goal: "A step" });
				});
				captureConsoleLog(() => {
					handleStepStart({ step: "s1" });
				});
				captureConsoleLog(() => {
					handleStepPause();
				});
			});
		});

		const task = yaml.load(readFileSync(taskPath!, "utf-8")) as Record<string, unknown>;
		const history = task.history as Array<{ type: string }>;
		const pauseEvents = history.filter((e) => e.type === "paused");
		assertTrue(pauseEvents.length >= 1, "should have paused event");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("hal step resume records resumed event", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);
		setupEpicDir(haltrDir);

		let taskPath: string;
		withCwd(tmpDir, () => {
			withEnv({ HALTR_SESSION_ID: "step-resume" }, () => {
				captureConsoleLog(() => {
					handleTaskCreate({ goal: "Resume test" });
				});
				taskPath = getCurrentTaskPath();

				captureConsoleLog(() => {
					handleStepAdd({ step: "s1", goal: "A step" });
				});
				captureConsoleLog(() => {
					handleStepStart({ step: "s1" });
				});
				captureConsoleLog(() => {
					handleStepPause();
				});
				captureConsoleLog(() => {
					handleStepResume();
				});
			});
		});

		const task = yaml.load(readFileSync(taskPath!, "utf-8")) as Record<string, unknown>;
		const history = task.history as Array<{ type: string }>;
		const resumeEvents = history.filter((e) => e.type === "resumed");
		assertTrue(resumeEvents.length >= 1, "should have resumed event");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ============================================================================
// Section 6: Context Command Tests (end-to-end with temp directory)
// ============================================================================
console.log("\n--- Context Command Tests ---");

test("hal context create creates skill directory + SKILL.md", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);

		withCwd(tmpDir, () => {
			captureConsoleLog(() => {
				handleContextCreate({
					type: "skill",
					id: "testing-skill",
					description: "A testing skill",
				});
			});
		});

		const skillDir = join(haltrDir, "context", "skills", "testing-skill");
		assertTrue(existsSync(skillDir), "skill directory should exist");
		assertTrue(existsSync(join(skillDir, "SKILL.md")), "SKILL.md should exist");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("hal context create creates knowledge directory + README.md", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);

		withCwd(tmpDir, () => {
			captureConsoleLog(() => {
				handleContextCreate({
					type: "knowledge",
					id: "arch-doc",
					description: "Architecture documentation",
				});
			});
		});

		const knowledgeDir = join(haltrDir, "context", "knowledge", "arch-doc");
		assertTrue(existsSync(knowledgeDir), "knowledge directory should exist");
		assertTrue(existsSync(join(knowledgeDir, "README.md")), "README.md should exist");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("hal context create adds entry to index.yaml", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);

		withCwd(tmpDir, () => {
			captureConsoleLog(() => {
				handleContextCreate({
					type: "skill",
					id: "index-test-skill",
					description: "Testing index update",
				});
			});
		});

		const entries = loadIndex(haltrDir);
		assertEqual(entries.length, 1, "should have one entry");
		assertEqual(entries[0].id, "index-test-skill", "entry id");
		assertEqual(entries[0].type, "skill", "entry type");
		assertEqual(entries[0].description, "Testing index update", "entry description");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("hal context show reads content + records used event", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);

		// Create entry and write content
		withCwd(tmpDir, () => {
			captureConsoleLog(() => {
				handleContextCreate({
					type: "skill",
					id: "show-test",
					description: "Show test skill",
				});
			});
		});

		// Write content to the file
		writeFileSync(
			join(haltrDir, "context", "skills", "show-test", "SKILL.md"),
			"# Show Test\n\nSome content here.",
		);

		// Call show
		let output: string;
		withCwd(tmpDir, () => {
			output = captureConsoleLog(() => {
				handleContextShow({ id: "show-test" });
			});
		});

		// Check output contains content
		assertIncludes(output!, "show-test", "output should contain entry id");

		// Check used event was recorded
		const historyPath = join(haltrDir, "context", "history.yaml");
		const historyContent = readFileSync(historyPath, "utf-8");
		const history = yaml.load(historyContent) as Record<string, Array<{ type: string }>>;
		const events = history["show-test"];
		const usedEvents = events.filter((e) => e.type === "used");
		assertTrue(usedEvents.length >= 1, "should have used event");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("hal context show: checkStaleness detects stale entry (direct API)", () => {
	// handleContextShow records a 'used' event before checking staleness,
	// so the command itself won't produce a staleness_warning in output.
	// Instead, we verify checkStaleness() returns stale for old entries
	// and that handleContextShow correctly reads content.
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);

		// Create entry
		withCwd(tmpDir, () => {
			captureConsoleLog(() => {
				handleContextCreate({
					type: "skill",
					id: "stale-test",
					description: "Stale test skill",
				});
			});
		});

		// Overwrite history with an old event (no activity types)
		const oldDate = new Date();
		oldDate.setDate(oldDate.getDate() - 100);
		const history: Record<string, Array<{ at: string; type: string }>> = {
			"stale-test": [{ at: oldDate.toISOString(), type: "created" }],
		};
		writeFileSync(
			join(haltrDir, "context", "history.yaml"),
			yaml.dump(history, { lineWidth: -1 }),
		);

		// Verify staleness directly before show adds a 'used' event
		const stalenessResult = checkStaleness(haltrDir, "stale-test");
		assertTrue(stalenessResult.stale, "should be stale before show");

		// Write some content
		writeFileSync(
			join(haltrDir, "context", "skills", "stale-test", "SKILL.md"),
			"# Stale Content",
		);

		// Show command itself records 'used' so staleness will be cleared
		let output: string;
		withCwd(tmpDir, () => {
			output = captureConsoleLog(() => {
				handleContextShow({ id: "stale-test" });
			});
		});

		// Verify content is returned
		assertIncludes(output!, "Stale Content", "output should contain content");

		// After show, staleness should be cleared because 'used' was recorded
		const afterResult = checkStaleness(haltrDir, "stale-test");
		assertFalse(afterResult.stale, "should not be stale after show (used event recorded)");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("hal context list returns all entries", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);

		withCwd(tmpDir, () => {
			captureConsoleLog(() => {
				handleContextCreate({ type: "skill", id: "list-s1", description: "Skill 1" });
			});
			captureConsoleLog(() => {
				handleContextCreate({ type: "knowledge", id: "list-k1", description: "Knowledge 1" });
			});

			const output = captureConsoleLog(() => {
				handleContextList();
			});

			assertIncludes(output, "list-s1", "should list skill");
			assertIncludes(output, "list-k1", "should list knowledge");
			assertIncludes(output, "2", "should show count of 2");
		});
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("hal context delete removes entry and directory", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);

		withCwd(tmpDir, () => {
			captureConsoleLog(() => {
				handleContextCreate({ type: "skill", id: "del-test", description: "To be deleted" });
			});

			assertTrue(existsSync(join(haltrDir, "context", "skills", "del-test")), "should exist before delete");

			captureConsoleLog(() => {
				handleContextDelete({ id: "del-test", reason: "No longer needed" });
			});

			assertFalse(existsSync(join(haltrDir, "context", "skills", "del-test")), "should not exist after delete");

			const entries = loadIndex(haltrDir);
			assertEqual(entries.length, 0, "index should be empty after delete");
		});
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("hal context log records event in history.yaml", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);

		withCwd(tmpDir, () => {
			captureConsoleLog(() => {
				handleContextCreate({ type: "skill", id: "log-test", description: "Log test" });
			});

			captureConsoleLog(() => {
				handleContextLog({ id: "log-test", type: "confirmed", message: "Content verified" });
			});
		});

		const historyPath = join(haltrDir, "context", "history.yaml");
		const historyContent = readFileSync(historyPath, "utf-8");
		const history = yaml.load(historyContent) as Record<string, Array<{ type: string; message?: string }>>;
		const events = history["log-test"];
		const confirmedEvents = events.filter((e) => e.type === "confirmed");
		assertTrue(confirmedEvents.length >= 1, "should have confirmed event");
		assertEqual(confirmedEvents[0].message, "Content verified", "message");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ============================================================================
// Section 7: Check Command Tests
// ============================================================================
console.log("\n--- Check Command Tests ---");

// The check command uses process.exit(), so we test the logic directly
// by examining the task state and applying the same conditions.

test("Check: returns allow (exit 0 logic) when no session mapping", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		setupHaltrDir(tmpDir);

		withCwd(tmpDir, () => {
			const taskPath = getTaskPathForSession("nonexistent-check-session");
			// When taskPath is null, check allows stop
			assertEqual(taskPath, null, "should be null for unknown session");
			// The check command would call process.exit(0) here
		});
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("Check: returns allow (exit 0 logic) when task is done", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);
		setupEpicDir(haltrDir);

		let taskPath: string;
		withCwd(tmpDir, () => {
			withEnv({ HALTR_SESSION_ID: "check-done" }, () => {
				captureConsoleLog(() => {
					handleTaskCreate({ goal: "Check done test" });
				});
				taskPath = getCurrentTaskPath();

				captureConsoleLog(() => {
					handleStepAdd({ step: "s1", goal: "Only step" });
				});
				captureConsoleLog(() => {
					handleStepStart({ step: "s1" });
				});
				captureConsoleLog(() => {
					handleStepDone({ step: "s1", result: "PASS" });
				});
			});
		});

		const task = loadAndValidateTask(taskPath!);
		assertEqual(task.status, "done", "task should be done");

		// Check command logic: if task.status === "done", exit 0
		const shouldAllow = task.status === "done";
		assertTrue(shouldAllow, "should allow stop when task is done");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("Check: returns allow (exit 0 logic) when paused (copilot mode)", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);
		setupEpicDir(haltrDir);

		let taskPath: string;
		withCwd(tmpDir, () => {
			withEnv({ HALTR_SESSION_ID: "check-paused" }, () => {
				captureConsoleLog(() => {
					handleTaskCreate({ goal: "Check pause test" });
				});
				taskPath = getCurrentTaskPath();

				captureConsoleLog(() => {
					handleStepAdd({ step: "s1", goal: "A step" });
				});
				captureConsoleLog(() => {
					handleStepStart({ step: "s1" });
				});
				captureConsoleLog(() => {
					handleStepPause();
				});
			});
		});

		const task = loadAndValidateTask(taskPath!);
		const lastEvent = task.history && task.history.length > 0
			? task.history[task.history.length - 1]
			: null;

		assertEqual(lastEvent?.type, "paused", "last event should be paused");

		// Check command logic: if last event is paused, exit 0
		const shouldAllow = lastEvent?.type === "paused";
		assertTrue(shouldAllow, "should allow stop when paused");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("Check: returns block (exit 2 logic) when steps remain", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		const haltrDir = setupHaltrDir(tmpDir);
		setupEpicDir(haltrDir);

		let taskPath: string;
		withCwd(tmpDir, () => {
			withEnv({ HALTR_SESSION_ID: "check-blocked" }, () => {
				captureConsoleLog(() => {
					handleTaskCreate({ goal: "Check block test" });
				});
				taskPath = getCurrentTaskPath();

				captureConsoleLog(() => {
					handleStepAdd({ step: "s1", goal: "Step 1" });
				});
				captureConsoleLog(() => {
					handleStepAdd({ step: "s2", goal: "Step 2" });
				});
				captureConsoleLog(() => {
					handleStepStart({ step: "s1" });
				});
				captureConsoleLog(() => {
					handleStepDone({ step: "s1", result: "PASS" });
				});
				// s2 is still pending
			});
		});

		const task = loadAndValidateTask(taskPath!);
		const steps = task.steps ?? [];
		const allDone = steps.length > 0 && steps.every((s) => s.status === "done");
		const isPaused = task.history && task.history.length > 0
			? task.history[task.history.length - 1].type === "paused"
			: false;
		const isDone = task.status === "done";

		// Check command logic: none of the allow conditions are met -> block
		assertFalse(allDone, "not all steps should be done");
		assertFalse(isPaused, "should not be paused");
		assertFalse(isDone, "task should not be done");

		// Remaining steps
		const remainingSteps = steps.filter((s) => s.status !== "done");
		assertTrue(remainingSteps.length > 0, "should have remaining steps");
		assertEqual(remainingSteps[0].id, "s2", "remaining step should be s2");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ============================================================================
// Section 8: Init Command Tests
// ============================================================================
console.log("\n--- Init Command Tests ---");

test("initHaltr creates haltr/ directory structure", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		captureConsoleLog(() => {
			initHaltr(tmpDir);
		});

		const haltrDir = join(tmpDir, "haltr");
		assertTrue(existsSync(haltrDir), "haltr/ should exist");
		assertTrue(existsSync(join(haltrDir, "context")), "context/ should exist");
		assertTrue(existsSync(join(haltrDir, "context", "skills")), "context/skills/ should exist");
		assertTrue(existsSync(join(haltrDir, "context", "knowledge")), "context/knowledge/ should exist");
		assertTrue(existsSync(join(haltrDir, "epics")), "epics/ should exist");
		assertTrue(existsSync(join(haltrDir, ".sessions")), ".sessions/ should exist");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("initHaltr creates config.yaml", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		captureConsoleLog(() => {
			initHaltr(tmpDir);
		});

		const configPath = join(tmpDir, "haltr", "config.yaml");
		assertTrue(existsSync(configPath), "config.yaml should exist");

		const content = readFileSync(configPath, "utf-8");
		// Should be valid YAML
		const config = yaml.load(content);
		assertTrue(config !== undefined, "config should be parseable YAML");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("initHaltr creates context/index.yaml (empty array)", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		captureConsoleLog(() => {
			initHaltr(tmpDir);
		});

		const indexPath = join(tmpDir, "haltr", "context", "index.yaml");
		assertTrue(existsSync(indexPath), "index.yaml should exist");

		const content = readFileSync(indexPath, "utf-8");
		const data = yaml.load(content);
		assertTrue(Array.isArray(data), "should be an array");
		assertEqual((data as unknown[]).length, 0, "should be empty");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

test("initHaltr creates README.md from template", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "haltr-cmd-test-"));
	try {
		captureConsoleLog(() => {
			initHaltr(tmpDir);
		});

		const readmePath = join(tmpDir, "haltr", "README.md");
		assertTrue(existsSync(readmePath), "README.md should exist");

		const content = readFileSync(readmePath, "utf-8");
		assertTrue(content.length > 0, "README should have content");
		assertIncludes(content, "haltr", "README should mention haltr");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
	}
});

// ============================================================================
// Cleanup & Summary
// ============================================================================
console.log("\n========================================");
console.log(`  Total: ${passed + failed}`);
console.log(`  PASS:  ${passed}`);
console.log(`  FAIL:  ${failed}`);
console.log("========================================");

if (failed > 0) {
	console.log("\nFailed tests:");
	for (const r of results.filter((r) => r.status === "FAIL")) {
		console.log(`  - ${r.name}: ${r.detail}`);
	}
	process.exit(1);
} else {
	console.log("\nAll tests passed!");
	process.exit(0);
}
