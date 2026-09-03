// The engine's tool list as toolbar surfaces: dropdown rows for a host's Edit/Insert menus, and the
// centred button cluster. The list, its order and its icons come from VECTOR_TOOLS (which derives
// from the registry), so a new kind appears in both apps' toolbars without either app being edited.

import { DropdownMenuItem, DropdownMenuShortcut } from '../dropdown-menu';
import { TooltipButton } from '../layout/toolbar/tooltip-button';
import { VECTOR_TOOLS, type VectorTool, type VectorToolEntry } from './hooks/use-tool';

export function ToolMenuItems({ tools, setTool }: { tools: VectorToolEntry[]; setTool: (tool: VectorTool) => void }) {
    return (
        <>
            {tools.map((entry) => (
                <DropdownMenuItem key={entry.tool} onClick={() => setTool(entry.tool)}>
                    <entry.icon className="h-4 w-4 mr-2" /> {entry.label}
                    <DropdownMenuShortcut>{entry.shortcut}</DropdownMenuShortcut>
                </DropdownMenuItem>
            ))}
        </>
    );
}

export function ToolButtons({ tool, setTool }: { tool: VectorTool; setTool: (tool: VectorTool) => void }) {
    return (
        <>
            {VECTOR_TOOLS.map((entry) => (
                <TooltipButton
                    key={entry.tool}
                    icon={entry.icon}
                    tooltipText={`${entry.label} (${entry.shortcut})`}
                    active={tool === entry.tool}
                    preventFocusLoss
                    onClick={() => setTool(entry.tool)}
                />
            ))}
        </>
    );
}

// The registry's `inserts` flag splits the menus: inserting tools fill the Insert menu; Select +
// Eraser live in the Edit menu — also the only surface that reaches them below the compact breakpoint.
export const INSERT_TOOLS = VECTOR_TOOLS.filter((entry) => entry.inserts);
export const EDIT_TOOLS = VECTOR_TOOLS.filter((entry) => !entry.inserts);
