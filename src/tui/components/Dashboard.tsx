import type React from "react";
import { useState, useEffect } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { join } from "node:path";
import { useTaskData } from "../hooks/use-task-data.js";
import { usePanesData } from "../hooks/use-panes-data.js";
import { useEpicList } from "../hooks/use-epic-list.js";
import { useTmuxPaneStatus } from "../hooks/use-tmux-pane-status.js";
import { Header } from "./Header.js";
import { StepList } from "./StepList.js";
import { PaneList } from "./PaneList.js";
import { HistoryTimeline } from "./HistoryTimeline.js";
import type { TaskYaml } from "../../types.js";

interface DashboardProps {
  epicsDir: string;
}

function findCurrentTask(tasks: TaskYaml[]): TaskYaml | null {
  const inProgress = tasks.find((t) => t.status === "in_progress");
  if (inProgress) return inProgress;
  return tasks.length > 0 ? tasks[tasks.length - 1] : null;
}

export const Dashboard: React.FC<DashboardProps> = ({ epicsDir }) => {
  const { exit } = useApp();
  const epics = useEpicList(epicsDir);
  const [epicIndex, setEpicIndex] = useState(() =>
    Math.max(0, epics.length - 1),
  );
  const currentEpicName = epics[epicIndex] ?? "";
  const epicDir = currentEpicName ? join(epicsDir, currentEpicName) : epicsDir;

  const tasks = useTaskData(epicDir);
  const panes = usePanesData(epicDir);
  const { alivePaneIds, tmuxAvailable } = useTmuxPaneStatus();
  const currentTask = findCurrentTask(tasks);

  useEffect(() => {
    if (epicIndex >= epics.length && epics.length > 0) {
      setEpicIndex(epics.length - 1);
    }
  }, [epics.length, epicIndex]);

  useInput((input, key) => {
    if (key.leftArrow && epics.length > 1) {
      setEpicIndex((prev) => (prev > 0 ? prev - 1 : epics.length - 1));
    }
    if (key.rightArrow && epics.length > 1) {
      setEpicIndex((prev) => (prev < epics.length - 1 ? prev + 1 : 0));
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
    <Box flexDirection="column">
      <Header
        epicName={currentEpicName}
        task={currentTask}
        epicIndex={epicIndex}
        epicCount={epics.length}
      />
      <Box flexDirection="row" marginTop={1}>
        <StepList
          steps={currentTask?.steps ?? []}
          history={currentTask?.history ?? []}
        />
        <Box width={2} />
        <PaneList panes={panes} alivePaneIds={alivePaneIds} tmuxAvailable={tmuxAvailable} />
      </Box>
      <Box marginTop={1}>
        <HistoryTimeline history={currentTask?.history ?? []} />
      </Box>
    </Box>
  );
};
