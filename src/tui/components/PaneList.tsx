import { Box, Text } from "ink";
import type React from "react";
import type { PaneEntry } from "../../lib/panes-manager.js";

interface PaneListProps {
	panes: PaneEntry[];
	alivePaneIds: Set<string>;
	tmuxAvailable: boolean;
}

export const PaneList: React.FC<PaneListProps> = ({
	panes,
	alivePaneIds,
	tmuxAvailable,
}) => {
	return (
		<Box flexDirection="column" flexGrow={1}>
			<Text bold underline>
				Panes
			</Text>
			{panes.map((pane) => {
				let label: string;
				let color: string;
				if (!tmuxAvailable) {
					label = "???";
					color = "yellow";
				} else if (alivePaneIds.has(pane.pane_id)) {
					label = "ALIVE";
					color = "green";
				} else {
					label = "DEAD";
					color = "red";
				}
				return (
					<Box key={pane.pane_id}>
						<Text color={color}>{label} </Text>
						<Text>{pane.role}</Text>
						<Text dimColor> -&gt; {pane.step}</Text>
					</Box>
				);
			})}
			{panes.length === 0 && <Text dimColor>(no panes)</Text>}
		</Box>
	);
};
