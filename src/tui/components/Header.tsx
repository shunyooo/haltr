import type React from "react";
import { Box, Text } from "ink";
import type { TaskYaml, TaskStatus } from "../../types.js";

interface HeaderProps {
  epicName: string;
  task: TaskYaml | null;
  epicIndex: number;
  epicCount: number;
}

function statusColor(status: TaskStatus | undefined): string {
  switch (status) {
    case "in_progress":
      return "blue";
    case "done":
      return "green";
    case "failed":
      return "red";
    case "pivoted":
      return "magenta";
    default:
      return "yellow";
  }
}

export const Header: React.FC<HeaderProps> = ({
  epicName,
  task,
  epicIndex,
  epicCount,
}) => {
  const taskStatus = task?.status ?? "pending";
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="cyan"
      paddingX={1}
    >
      <Box>
        <Text bold color="cyan">
          haltr
        </Text>
        <Text> | Epic: </Text>
        <Text bold>{epicName}</Text>
        <Text dimColor>
          {" "}
          ({epicIndex + 1}/{epicCount})
        </Text>
      </Box>
      {task && (
        <Box>
          <Text>Task: </Text>
          <Text bold>{task.id}</Text>
          <Text> | Status: </Text>
          <Text color={statusColor(task.status)}>{taskStatus}</Text>
        </Box>
      )}
      <Box>
        {epicCount > 1 && (
          <>
            <Text dimColor>{"<- -> Epic"}</Text>
            <Text dimColor>{" | "}</Text>
          </>
        )}
        <Text dimColor>q exit</Text>
      </Box>
    </Box>
  );
};
