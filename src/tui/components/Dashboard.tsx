import { join } from "node:path";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type React from "react";
import { useEffect, useState } from "react";
import type { TaskYaml } from "../../types.js";
import { useEpicList } from "../hooks/use-epic-list.js";
import { usePanesData } from "../hooks/use-panes-data.js";
import { useTaskData } from "../hooks/use-task-data.js";
import { useTmuxPaneStatus } from "../hooks/use-tmux-pane-status.js";
import { Header } from "./Header.js";
import { HistoryTimeline } from "./HistoryTimeline.js";
import { PaneList } from "./PaneList.js";
import { TimelineBar } from "./TimelineBar.js";

interface DashboardProps {
	epicsDir: string;
	timezone: string;
}

type FocusSection = "epic" | "timeline" | "history";

function findCurrentTask(tasks: TaskYaml[]): TaskYaml | null {
	const inProgress = tasks.find((t) => t.status === "in_progress");
	if (inProgress) return inProgress;
	return tasks.length > 0 ? tasks[tasks.length - 1] : null;
}

export const Dashboard: React.FC<DashboardProps> = ({ epicsDir, timezone }) => {
	const { exit } = useApp();
	const { stdout } = useStdout();
	const termRows = stdout?.rows ?? 24;
	const epics = useEpicList(epicsDir);
	const [epicIndex, setEpicIndex] = useState(() =>
		Math.max(0, epics.length - 1),
	);
	const [focusSection, setFocusSection] = useState<FocusSection>("epic");
	const currentEpicName = epics[epicIndex] ?? "";
	const epicDir = currentEpicName ? join(epicsDir, currentEpicName) : epicsDir;

	const tasks = useTaskData(epicDir);
	const panes = usePanesData(epicDir);
	const { alivePaneIds, tmuxAvailable } = useTmuxPaneStatus();
	const currentTask = findCurrentTask(tasks);

	// Dynamic height allocation
	const HEADER_H = 5; // border(2) + 3 content lines
	const TIMELINE_H = focusSection === "timeline" ? 6 : 4; // with/without border
	const MARGINS = 2; // marginTop={1} x 2
	const fixedH = HEADER_H + TIMELINE_H + MARGINS;
	const remaining = Math.max(4, termRows - fixedH);
	const panesContentH = panes.length > 0 ? panes.length + 1 : 2;
	const panesH = Math.max(2, Math.min(panesContentH, Math.ceil(remaining * 0.3)));
	const historyH = remaining - panesH;
	const historyMaxVisible = Math.max(1, historyH - 3); // 3 = border(2) + title(1)

	useEffect(() => {
		if (epicIndex >= epics.length && epics.length > 0) {
			setEpicIndex(epics.length - 1);
		}
	}, [epics.length, epicIndex]);

	useInput((input, key) => {
		// Up/Down: Focus navigation (disabled when history is focused — history handles ↑↓ internally)
		if (focusSection !== "history") {
			if (key.upArrow) {
				setFocusSection((prev) => {
					if (prev === "timeline") return "epic";
					return prev;
				});
			}
			if (key.downArrow) {
				setFocusSection((prev) => {
					if (prev === "epic") return "timeline";
					if (prev === "timeline") return "history";
					return prev;
				});
			}
		}

		// Left/Right: Epic navigation (only when epic section is focused)
		if (focusSection === "epic") {
			if (key.leftArrow && epics.length > 1) {
				setEpicIndex((prev) => (prev > 0 ? prev - 1 : epics.length - 1));
			}
			if (key.rightArrow && epics.length > 1) {
				setEpicIndex((prev) => (prev < epics.length - 1 ? prev + 1 : 0));
			}
		}

		if (input === "q") {
			exit();
		}
	});

	if (epics.length === 0) {
		return (
			<Box flexDirection="column" padding={1}>
				<Text color="yellow">No epics found in {epicsDir}</Text>
				<Text dimColor>Press q to exit</Text>
			</Box>
		);
	}

	return (
		<Box flexDirection="column" height={termRows} overflow="hidden">
			<Header
				epicName={currentEpicName}
				task={currentTask}
				epicIndex={epicIndex}
				epicCount={epics.length}
				focused={focusSection === "epic"}
			/>
			<Box height={TIMELINE_H} overflow="hidden">
				<TimelineBar
					steps={currentTask?.steps ?? []}
					history={currentTask?.history ?? []}
					focused={focusSection === "timeline"}
					timezone={timezone}
				/>
			</Box>
			<Box flexDirection="row" marginTop={1} height={panesH} overflow="hidden">
				<PaneList
					panes={panes}
					alivePaneIds={alivePaneIds}
					tmuxAvailable={tmuxAvailable}
				/>
			</Box>
			<Box marginTop={1} height={historyH} overflow="hidden">
				<HistoryTimeline
					history={currentTask?.history ?? []}
					focused={focusSection === "history"}
					onExit={() => setFocusSection("timeline")}
					maxVisible={historyMaxVisible}
					timezone={timezone}
				/>
			</Box>
		</Box>
	);
};
