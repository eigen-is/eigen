import { useYjsUndoState } from '@workspace/lib/collab';
import { useIsCompactToolbar } from '@workspace/lib/media';
import type { DrivePath } from '@workspace/lib/types/drive';
import { CenteredToolbar, DocumentShareCluster, EditMenu, FileMenu, TooltipButton } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import { ExportProgressDialog, useDocumentExport } from '@workspace/ui/components/drive/use-document-export';
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuShortcut,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { VECTOR_TOOLS, type VectorTool } from '@workspace/ui/components/vector';
import { Diamond, ImagePlus } from 'lucide-react';

type ToolbarProps = {
    path: DrivePath;
    canWrite: boolean;
    // Exactly what useYjsUndoState consumes (Y.UndoManager | null) — named via the hook so the app
    // needn't take a direct yjs dependency just to type one prop.
    undoManager: Parameters<typeof useYjsUndoState>[0];
    tool: VectorTool;
    setTool: (tool: VectorTool) => void;
    // Tool lock (Q): keeps the selected tool active for repeated placement — a toggle in the Edit menu.
    toolLocked: boolean;
    setToolLocked: (locked: boolean) => void;
    // Present when the container has a media/ folder — opens the editor's image picker.
    onInsertImage?: () => void;
    onAccessDialogOpen: () => void;
    // Document-level comments + activity (the props deliberately omitted until vector had a
    // comment lifecycle). Always offered when the panels are wired: desktop draws the side panel,
    // mobile the Column.
    onToggleCommentPanel: () => void;
    commentPanelOpen: boolean;
    assignedCommentCount: number;
    onToggleActivityPanel: () => void;
    activityPanelOpen: boolean;
};

// The registry's `inserts` flag splits the menus: inserting tools fill the Insert menu; Select +
// Eraser live in the Edit menu — also the only surface that reaches them below the compact breakpoint.
const INSERT_TOOLS = VECTOR_TOOLS.filter((t) => t.inserts);
const EDIT_TOOLS = VECTOR_TOOLS.filter((t) => !t.inserts);

function ToolMenuItem({ tool, setTool }: { tool: (typeof VECTOR_TOOLS)[number]; setTool: (t: VectorTool) => void }) {
    return (
        <DropdownMenuItem onClick={() => setTool(tool.tool)}>
            <tool.icon className="h-4 w-4 mr-2" /> {tool.label}
            <DropdownMenuShortcut>{tool.shortcut}</DropdownMenuShortcut>
        </DropdownMenuItem>
    );
}

export function Toolbar({
    path,
    canWrite,
    undoManager,
    tool,
    setTool,
    toolLocked,
    setToolLocked,
    onInsertImage,
    onAccessDialogOpen,
    onToggleCommentPanel,
    commentPanelOpen,
    assignedCommentCount,
    onToggleActivityPanel,
    activityPanelOpen,
}: ToolbarProps) {
    const { canUndo, canRedo, undo, redo } = useYjsUndoState(undoManager, canWrite);
    const { exportPath, isExporting } = useDocumentExport();
    const isCompact = useIsCompactToolbar();

    return (
        <>
            <CenteredToolbar
                left={
                    <div className="flex items-center">
                        <FileMenu
                            path={path}
                            canWrite={canWrite}
                            onAccessDialogOpen={onAccessDialogOpen}
                            onExport={(format) => exportPath(path, format)}
                            exportFormats={['svg', 'pdf']}
                            createLabel="New vector"
                            createIcon={Diamond}
                            createType="vector"
                        />
                        {/* Render unconditionally once vector has a DocSearchProvider (Find items survive read-only). */}
                        {canWrite && (
                            <>
                                <EditMenu
                                    canEdit={canWrite}
                                    canUndo={canUndo}
                                    canRedo={canRedo}
                                    onUndo={undo}
                                    onRedo={redo}
                                >
                                    {EDIT_TOOLS.map((t) => (
                                        <ToolMenuItem key={t.tool} tool={t} setTool={setTool} />
                                    ))}
                                    <DropdownMenuCheckboxItem checked={toolLocked} onCheckedChange={setToolLocked}>
                                        Keep selected tool
                                        <DropdownMenuShortcut>Q</DropdownMenuShortcut>
                                    </DropdownMenuCheckboxItem>
                                </EditMenu>
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button variant="ghost">Insert</Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="start">
                                        {INSERT_TOOLS.map((t) => (
                                            <ToolMenuItem key={t.tool} tool={t} setTool={setTool} />
                                        ))}
                                        {onInsertImage && (
                                            <DropdownMenuItem onClick={onInsertImage}>
                                                <ImagePlus className="h-4 w-4 mr-2" /> Image
                                            </DropdownMenuItem>
                                        )}
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </>
                        )}
                    </div>
                }
                center={
                    // Below the compact-toolbar breakpoint the cluster folds into the Insert menu (the slides idiom).
                    canWrite &&
                    !isCompact && (
                        <>
                            {VECTOR_TOOLS.map((t) => (
                                <TooltipButton
                                    key={t.tool}
                                    icon={t.icon}
                                    tooltipText={`${t.label} (${t.shortcut})`}
                                    active={tool === t.tool}
                                    preventFocusLoss
                                    onClick={() => setTool(t.tool)}
                                />
                            ))}
                            {onInsertImage && (
                                <TooltipButton icon={ImagePlus} tooltipText="Add image" onClick={onInsertImage} />
                            )}
                        </>
                    )
                }
                right={
                    <div className="flex items-center gap-1">
                        <DocumentShareCluster
                            canWrite={canWrite}
                            onAccessDialogOpen={onAccessDialogOpen}
                            watchTarget={{ ownerId: path.ownerId, mountId: path.mountId, pathId: path.id }}
                            onToggleCommentPanel={onToggleCommentPanel}
                            commentPanelOpen={commentPanelOpen}
                            assignedCommentCount={assignedCommentCount}
                            onToggleActivityPanel={onToggleActivityPanel}
                            activityPanelOpen={activityPanelOpen}
                        />
                    </div>
                }
            />
            <ExportProgressDialog open={isExporting} />
        </>
    );
}
