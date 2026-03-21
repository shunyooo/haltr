/**
 * `hal hook` -- Hook utility subcommands.
 *
 * Subcommands:
 *   guard-bash -- Check if a bash command starts with `hal`
 *
 * Usage:
 *   hal hook guard-bash -- <command>
 *   hal hook guard-bash "<command>"
 */

import { Command } from "commander";

/**
 * Check whether a bash command consists entirely of `hal` commands.
 *
 * Checks ALL commands in a chain (split on &&, ||, ;, |).
 * Every command must start with `hal`. If any non-hal command is found,
 * the entire command is blocked.
 *   - `hal status ... && hal check ...` -> allow (all hal)
 *   - `hal status ... && echo done` -> block (echo is not hal)
 *   - `ls -la` -> block
 *
 * @returns { allowed: boolean, message?: string }
 */
export function guardBash(command: string): {
	allowed: boolean;
	message?: string;
} {
	const trimmed = command.trim();

	if (!trimmed) {
		return {
			allowed: false,
			message: "hal コマンド以外の実行は許可されていません",
		};
	}

	// Reject subshells, backticks, and redirections before splitting
	if (/\$\(|\$\{|`|[<>]|\n|\r/.test(trimmed)) {
		return {
			allowed: false,
			message: "サブシェル、バッククォート、リダイレクトは許可されていません",
		};
	}

	// Split on all chain/pipe operators: &&, ||, ;, |
	const commands = trimmed.split(/\s*(?:&&|\|\||[;|])\s*/);

	// Check that EVERY command starts with `hal`
	for (const cmd of commands) {
		const trimmedCmd = cmd.trim();
		if (!trimmedCmd) continue;
		const executable = trimmedCmd.split(/\s+/)[0];
		if (executable !== "hal") {
			return {
				allowed: false,
				message: "hal コマンド以外の実行は許可されていません",
			};
		}
	}

	return { allowed: true };
}

/**
 * Register the `hal hook` command with subcommands.
 */
export function registerHookCommand(program: Command): void {
	const hookCmd = new Command("hook").description("Hook utilities");

	hookCmd
		.command("guard-bash")
		.description("Check if a bash command starts with `hal`")
		.argument("[command...]", "Command to check")
		.action((commandParts: string[]) => {
			const command = commandParts.join(" ");
			const result = guardBash(command);

			if (result.allowed) {
				process.exit(0);
			} else {
				if (result.message) {
					console.log(result.message);
				}
				process.exit(2); // exit 2 = blocking in Claude Code hooks
			}
		});

	hookCmd
		.command("guard-task-yaml")
		.description("Block Edit/Write to task.yaml files (PreToolUse hook)")
		.action(() => {
			let input = "";
			process.stdin.setEncoding("utf-8");
			process.stdin.on("data", (chunk: string) => {
				input += chunk;
			});
			process.stdin.on("end", () => {
				try {
					const data = JSON.parse(input);
					const filePath: string =
						data?.tool_input?.file_path ?? data?.tool_input?.filePath ?? "";
					if (/_task\.yaml$|\/task\.yaml$/.test(filePath)) {
						const result = JSON.stringify({
							decision: "block",
							reason:
								"task.yaml は直接編集できません。hal コマンドを使ってください。",
						});
						console.log(result);
						process.exit(2);
					}
				} catch {
					// Parse error — allow
				}
				process.exit(0);
			});
		});

	program.addCommand(hookCmd);
}
