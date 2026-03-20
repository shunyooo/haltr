import React from "react";
import { Box, Text } from "ink";

interface DashboardProps {
  epicName?: string;
}

export const Dashboard: React.FC<DashboardProps> = ({ epicName }) => {
  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          haltr TUI Dashboard
        </Text>
      </Box>
      {epicName && (
        <Box>
          <Text>Epic: {epicName}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text dimColor>Press Ctrl+C to exit</Text>
      </Box>
    </Box>
  );
};
