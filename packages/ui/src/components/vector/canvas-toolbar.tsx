// The toolbar both canvas apps mount: File + Edit menus, the Insert menu, the shape-tool cluster and
// the share/comments/activity cluster. The apps differ only in their File-menu identity (export
// formats, the "New …" row) and in the deck's two extra actions, which arrive as slots — so the tool
// cluster, the undo wiring and the compact-breakpoint rule cannot drift between them.

import { useYjsUndoState } from '@workspace/lib/collab';
import { useIsCompactToolbar } from '@workspace/lib/media';
import type { DrivePath, EigenDocType } from '@workspace/lib/types/drive';
import type { LucideIcon } from 'lucide-react';
import { ImagePlus } from 'lucide-react';
import type { ReactNode } from 'react';
import { ExportProgressDialog, useDocumentExport } from '../drive/use-document-export';
import { DropdownMenuCheckboxItem, DropdownMenuItem, DropdownMenuShortcut } from '../dropdown-menu';
import { DocumentShareCluster } from '../layout/toolbar/document-share-cluster';
import { EditMenu } from '../layout/toolbar/edit-menu';
import { FileMenu } from '../layout/toolbar/file-menu';
import { CenteredToolbar } from '../layout/toolbar/toolbar';
import { ToolbarMenu } from '../layout/toolbar/toolbar-menu';
import { TooltipButton } from '../layout/toolbar/tooltip-button';
import type { VectorTool } from './hooks/use-tool';
import { EDIT_TOOLS, INSERT_TOOLS, ToolButtons, ToolMenuItems } from './toolbar-tools';

type CanvasToolbarProps = {
    path: DrivePath;
    canWrite: boolean;
    canEdit: boolean;
    offline: boolean;
    storageUnavailable: boolean;
    // Exactly what useYjsUndoState consumes (Y.UndoManager | null) — named via the hook so an app
    // needn't take a direct yjs dependency just to type one prop.
    undoManager: Parameters<typeof useYjsUndoState>[0];
    tool: VectorTool;
    setTool: (tool: VectorTool) => void;
    // Tool lock (Q): keeps the selected tool active for repeated placement — a toggle in the Edit menu.
    toolLocked: boolean;
    setToolLocked: (locked: boolean) => void;
    // Present when the container has a media/ folder — opens the host's image picker.
    onInsertImage?: () => void;
    onAccessDialogOpen: () => void;
    // Document-level comments + activity. Always offered: desktop draws the side panel, mobile the Column.
    onToggleCommentPanel: () => void;
    commentPanelOpen: boolean;
    assignedCommentCount: number;
    onToggleActivityPanel: () => void;
    activityPanelOpen: boolean;
    // The File menu's per-app identity.
    exportFormats: string[];
    createLabel: string;
    createIcon: LucideIcon;
    createType: EigenDocType;
    // Rows above the shape tools in the Insert menu (the deck's "Slide").
    insertItems?: ReactNode;
    // Buttons left of the shape cluster; they fold away with it below the compact breakpoint.
    toolItems?: ReactNode;
    // Buttons a read-only viewer keeps at any width (the deck's Present).
    centerItems?: ReactNode;
};

export function CanvasToolbar({
    path,
    canWrite,
    canEdit,
    offline,
    storageUnavailable,
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
    exportFormats,
    createLabel,
    createIcon,
    createType,
    insertItems,
    toolItems,
    centerItems,
}: CanvasToolbarProps) {
    const { canUndo, canRedo, undo, redo } = useYjsUndoState(undoManager, canEdit);
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
                            exportFormats={exportFormats}
                            createLabel={createLabel}
                            createIcon={createIcon}
                            createType={createType}
                        />
                        {/* Unconditional: EditMenu drops its edit section itself, and its Find entries
                            are the read-only viewer's only menu route to the find bar. */}
                        <EditMenu canEdit={canEdit} canUndo={canUndo} canRedo={canRedo} onUndo={undo} onRedo={redo}>
                            <ToolMenuItems tools={EDIT_TOOLS} setTool={setTool} />
                            <DropdownMenuCheckboxItem checked={toolLocked} onCheckedChange={setToolLocked}>
                                Keep selected tool
                                <DropdownMenuShortcut>Q</DropdownMenuShortcut>
                            </DropdownMenuCheckboxItem>
                        </EditMenu>
                        {canEdit && (
                            <ToolbarMenu label="Insert">
                                {insertItems}
                                <ToolMenuItems tools={INSERT_TOOLS} setTool={setTool} />
                                {onInsertImage && (
                                    <DropdownMenuItem onClick={onInsertImage}>
                                        <ImagePlus className="h-4 w-4 mr-2" /> Image
                                    </DropdownMenuItem>
                                )}
                            </ToolbarMenu>
                        )}
                    </div>
                }
                center={
                    <>
                        {/* Below the compact-toolbar breakpoint the cluster folds into the menus. */}
                        {canEdit && !isCompact && (
                            <>
                                {toolItems}
                                <ToolButtons tool={tool} setTool={setTool} />
                                {onInsertImage && (
                                    <TooltipButton icon={ImagePlus} tooltipText="Add image" onClick={onInsertImage} />
                                )}
                            </>
                        )}
                        {centerItems}
                    </>
                }
                right={
                    <div className="flex items-center gap-1">
                        <DocumentShareCluster
                            canWrite={canWrite}
                            offline={offline}
                            storageUnavailable={storageUnavailable}
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
