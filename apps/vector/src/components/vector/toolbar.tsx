import { useYjsUndoState } from '@workspace/lib/collab';
import type { DrivePath } from '@workspace/lib/types/drive';
import { CenteredToolbar, DocumentShareCluster, EditMenu, FileMenu, TooltipButton } from '@workspace/ui';
import { VECTOR_TOOLS, type VectorTool } from '@workspace/ui/components/vector';
import { Diamond } from 'lucide-react';

type ToolbarProps = {
    path: DrivePath;
    canWrite: boolean;
    // Exactly what useYjsUndoState consumes (Y.UndoManager | null) — named via the hook so the app
    // needn't take a direct yjs dependency just to type one prop.
    undoManager: Parameters<typeof useYjsUndoState>[0];
    tool: VectorTool;
    setTool: (tool: VectorTool) => void;
    onAccessDialogOpen: () => void;
    // Document-level comments + activity (the props U1 deliberately omitted until vector had a
    // comment lifecycle). Always offered when the panels are wired: desktop draws the side panel,
    // mobile the Column.
    onToggleCommentPanel: () => void;
    commentPanelOpen: boolean;
    assignedCommentCount: number;
    onToggleActivityPanel: () => void;
    activityPanelOpen: boolean;
};

export function Toolbar({
    path,
    canWrite,
    undoManager,
    tool,
    setTool,
    onAccessDialogOpen,
    onToggleCommentPanel,
    commentPanelOpen,
    assignedCommentCount,
    onToggleActivityPanel,
    activityPanelOpen,
}: ToolbarProps) {
    const { canUndo, canRedo, undo, redo } = useYjsUndoState(undoManager, canWrite);

    return (
        <CenteredToolbar
            left={
                <div className="flex items-center">
                    <FileMenu
                        path={path}
                        canWrite={canWrite}
                        onAccessDialogOpen={onAccessDialogOpen}
                        createLabel="New vector"
                        createIcon={Diamond}
                        createType="vector"
                    />
                    {/* Render unconditionally once vector has a DocSearchProvider (Find items survive read-only). */}
                    {canWrite && (
                        <EditMenu canEdit={canWrite} canUndo={canUndo} canRedo={canRedo} onUndo={undo} onRedo={redo} />
                    )}
                </div>
            }
            center={
                canWrite &&
                VECTOR_TOOLS.map((t) => (
                    <TooltipButton
                        key={t.tool}
                        icon={t.icon}
                        tooltipText={`${t.label} (${t.shortcut})`}
                        active={tool === t.tool}
                        preventFocusLoss
                        onClick={() => setTool(t.tool)}
                    />
                ))
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
    );
}
