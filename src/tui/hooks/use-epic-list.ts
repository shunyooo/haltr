import { type FSWatcher, readdirSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { useEffect, useState } from "react";

export function loadEpicList(epicsDir: string): string[] {
	return readdirSync(epicsDir)
		.filter((entry) => {
			if (entry === "archive") return false;
			try {
				return statSync(join(epicsDir, entry)).isDirectory();
			} catch {
				return false;
			}
		})
		.sort();
}

export function useEpicList(epicsDir: string): string[] {
	const [epics, setEpics] = useState<string[]>(() => loadEpicList(epicsDir));

	useEffect(() => {
		let watcher: FSWatcher;
		try {
			watcher = watch(epicsDir, () => {
				setEpics(loadEpicList(epicsDir));
			});
		} catch {
			return;
		}
		return () => watcher.close();
	}, [epicsDir]);

	return epics;
}
