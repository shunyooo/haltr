import AjvModule, { type ValidateFunction } from "ajv";
import * as yaml from "js-yaml";
import { readFileSync } from "node:fs";
import type { TaskYaml, ConfigYaml, Step } from "../types.js";

import taskSchemaJson from "../schemas/task.schema.json" with { type: "json" };
import configSchemaJson from "../schemas/config.schema.json" with { type: "json" };

// Handle both ESM default and CJS interop
const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true, discriminator: true });

const taskValidator: ValidateFunction = ajv.compile(taskSchemaJson);
const configValidator: ValidateFunction = ajv.compile(configSchemaJson);

/**
 * Expand accept string shorthand to array format.
 * When accept is a plain string, expand to [{id: "default", check: "..."}].
 * Operates recursively on nested steps.
 */
function expandAcceptShorthand(steps: Step[]): void {
  for (const step of steps) {
    if (typeof step.accept === "string") {
      step.accept = [{ id: "default", check: step.accept }];
    }
    if (step.steps) {
      expandAcceptShorthand(step.steps);
    }
  }
}

/**
 * Validate parsed task data against the task schema.
 * Returns typed TaskYaml or throws with clear error messages.
 */
export function validateTask(data: unknown): TaskYaml {
  const valid = taskValidator(data);
  if (!valid) {
    const errors = taskValidator.errors ?? [];
    const messages = errors.map((e) => {
      const path = e.instancePath || "(root)";
      return `  ${path}: ${e.message}${e.params ? ` (${JSON.stringify(e.params)})` : ""}`;
    });
    throw new Error(`Task validation failed:\n${messages.join("\n")}`);
  }

  const task = data as TaskYaml;

  // Expand accept string shorthand after validation
  if (task.steps) {
    expandAcceptShorthand(task.steps);
  }

  return task;
}

/**
 * Validate parsed config data against the config schema.
 * Returns typed ConfigYaml or throws with clear error messages.
 */
export function validateConfig(data: unknown): ConfigYaml {
  const valid = configValidator(data);
  if (!valid) {
    const errors = configValidator.errors ?? [];
    const messages = errors.map((e) => {
      const path = e.instancePath || "(root)";
      return `  ${path}: ${e.message}${e.params ? ` (${JSON.stringify(e.params)})` : ""}`;
    });
    throw new Error(`Config validation failed:\n${messages.join("\n")}`);
  }
  return data as ConfigYaml;
}

/**
 * Load a YAML file, parse it, and validate against the task schema.
 */
export function loadAndValidateTask(filePath: string): TaskYaml {
  const content = readFileSync(filePath, "utf-8");
  const data = yaml.load(content);
  return validateTask(data);
}

/**
 * Load a YAML file, parse it, and validate against the config schema.
 */
export function loadAndValidateConfig(filePath: string): ConfigYaml {
  const content = readFileSync(filePath, "utf-8");
  const data = yaml.load(content);
  return validateConfig(data);
}
