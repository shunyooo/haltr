import { execSync } from "node:child_process";
import { useCallback, useEffect, useState } from "react";

const POLL_INTERVAL_MS = 5000;

export interface TmuxPaneStatus {
	alivePaneIds: Set<string>;
	tmuxAvailable: boolean;
}

function queryTmuxPanes(): TmuxPaneStatus {
	try {
		const output = execSync("tmux list-panes -t haltr -F '#{pane_id}'", {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		});
		return {
			alivePaneIds: new Set(output.trim().split("\n").filter(Boolean)),
			tmuxAvailable: true,
		};
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		const isTmuxMissing =
			message.includes("ENOENT") || message.includes("not found");
		if (isTmuxMissing) {
			return { alivePaneIds: new Set(), tmuxAvailable: false };
		}
		// tmux is installed but session/window not found — panes are dead
		return { alivePaneIds: new Set(), tmuxAvailable: true };
	}
}

export function useTmuxPaneStatus(): TmuxPaneStatus {
	const [status, setStatus] = useState<TmuxPaneStatus>(() => ({
		alivePaneIds: new Set(),
		tmuxAvailable: true,
	}));

	const poll = useCallback(() => {
		setStatus(queryTmuxPanes());
	}, []);

	useEffect(() => {
		poll();
		const interval = setInterval(poll, POLL_INTERVAL_MS);
		return () => clearInterval(interval);
	}, [poll]);

	return status;
}
