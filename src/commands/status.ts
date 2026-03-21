import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import * as yaml from "js-yaml";
import {
	findStep,
	judgeParentStatus,
	validateStepTransition,
	validateTaskPath,
	validateTaskTransition,
} from "../lib/task-utils.js";
import { loadAndValidateTask } from "../lib/validator.js";
import type { StepStatus, TaskStatus } from "../types.js";

export function registerStatusCommand(program: Command): void {
	program
		.command("status")
		.description("Update step or task status")
		.argument("<target>", 'Step path (e.g., "step-1") or "task"')
		.argument("<status>", "New status value")
		.requiredOption("--task <path>", "Path to task.yaml")
		.action((target: string, status: string, opts: { task: string }) => {
			try {
				handleStatusUpdate(target, status, opts.task);
			} catch (e: unknown) {
				const msg = e instanceof Error ? e.message : String(e);
				console.error(`Error: ${msg}`);
				process.exit(1);
			}
		});
}

function handleStatusUpdate(
	target: string,
	newStatus: string,
	taskPath: string,
): void {
	const resolvedPath = resolve(taskPath);
	validateTaskPath(resolvedPath);
	const taskYaml = loadAndValidateTask(resolvedPath);

	if (target === "task") {
		// Task-level status update
		const currentStatus = taskYaml.status || "pending";
		validateTaskTransition(currentStatus, newStatus);
		taskYaml.status = newStatus as TaskStatus;
	} else {
		// Step-level status update
		const step = findStep(taskYaml.steps, target);
		if (!step) {
			throw new Error(`Step not found: "${target}"`);
		}

		const currentStatus = step.status || "pending";
		validateStepTransition(currentStatus, newStatus);
		step.status = newStatus as StepStatus;

		// Auto-judge parent status
		propagateParentStatus(taskYaml.steps, target);
	}

	// Write back to disk
	const yamlContent = yaml.dump(taskYaml, {
		lineWidth: -1,
		noRefs: true,
		quotingType: '"',
	});
	writeFileSync(resolvedPath, yamlContent);

	console.log(`Updated ${target} status to ${newStatus}`);
}

/**
 * Propagate status changes upward through parent steps.
 */
function propagateParentStatus(steps: Step[], stepPath: string): void {
	// Walk up the path, judging each parent
	const parts = stepPath.split("/");

	// Build parent paths from deepest to shallowest
	for (let i = parts.length - 1; i >= 1; i--) {
		const parentPath = parts.slice(0, i).join("/");
		const parent = findStep(steps, parentPath);
		if (!parent) continue;

		const newStatus = judgeParentStatus(parent);
		if (newStatus !== undefined) {
			parent.status = newStatus;
		}
	}
}

// Re-export Step type for propagateParentStatus
import type { Step } from "../types.js";
