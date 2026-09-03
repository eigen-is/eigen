import { useYjsUndoState } from '@workspace/lib/collab';
import { useIsCompactToolbar } from '@workspace/lib/media';
import type { DrivePath } from '@workspace/lib/types/drive';
import { CenteredToolbar, DocumentShareCluster, EditMenu, FileMenu, ToolbarMenu, TooltipButton } from '@workspace/ui';
import { ExportProgressDialog, useDocumentExport } from '@workspace/ui/components/drive/use-document-export';
import {
    DropdownMenuCheckboxItem,
    DropdownMenuItem,
    DropdownMenuShortcut,
} from '@workspace/ui/components/dropdown-menu';
import { EDIT_TOOLS, INSERT_TOOLS, ToolButtons, ToolMenuItems, type VectorTool } from '@workspace/ui/components/vector';
import { ImagePlus, Play, Plus, Presentation } from 'lucide-react';

type ToolbarProps = {
    path: DrivePath;
    canWrite: boolean;
    canEdit: boolean;
    offline: boolean;
    storageUnavailable: boolean;
    // Exactly what useYjsUndoState consumes (Y.UndoManager | null) — named via the hook so the app
    // needn't take a direct yjs dependency just to type one prop.
    undoManager: Parameters<typeof useYjsUndoState>[0];
    tool: VectorTool;
    setTool: (tool: VectorTool) => void;
    // Tool lock (Q): keeps the selected tool active for repeated placement — a toggle in the Edit menu.
    toolLocked: boolean;
    setToolLocked: (locked: boolean) => void;
    onAddSlide: () => void;
    onPresent: () => void;
    // Present when the container has a media/ folder — opens the editor's image picker.
    onInsertImage?: () => void;
    onAccessDialogOpen: () => void;
    onToggleCommentPanel: () => void;
    commentPanelOpen: boolean;
    assignedCommentCount: number;
    onToggleActivityPanel: () => void;
    activityPanelOpen: boolean;
};

export function Toolbar({
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
    onAddSlide,
    onPresent,
    onInsertImage,
    onAccessDialogOpen,
    onToggleCommentPanel,
    commentPanelOpen,
    assignedCommentCount,
    onToggleActivityPanel,
    activityPanelOpen,
}: ToolbarProps) {
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
                            exportFormats={['pdf', 'html']}
                            createLabel="New slides"
                            createIcon={Presentation}
                            createType="slides"
                        />
                        {canEdit && (
                            <>
                                <EditMenu
                                    canEdit={canEdit}
                                    canUndo={canUndo}
                                    canRedo={canRedo}
                                    onUndo={undo}
                                    onRedo={redo}
                                >
                                    <ToolMenuItems tools={EDIT_TOOLS} setTool={setTool} />
                                    <DropdownMenuCheckboxItem checked={toolLocked} onCheckedChange={setToolLocked}>
                                        Keep selected tool
                                        <DropdownMenuShortcut>Q</DropdownMenuShortcut>
                                    </DropdownMenuCheckboxItem>
                                </EditMenu>
                                <ToolbarMenu label="Insert">
                                    <DropdownMenuItem onClick={onAddSlide}>
                                        <Plus className="h-4 w-4 mr-2" /> Slide
                                    </DropdownMenuItem>
                                    <ToolMenuItems tools={INSERT_TOOLS} setTool={setTool} />
                                    {onInsertImage && (
                                        <DropdownMenuItem onClick={onInsertImage}>
                                            <ImagePlus className="h-4 w-4 mr-2" /> Image
                                        </DropdownMenuItem>
                                    )}
                                </ToolbarMenu>
                            </>
                        )}
                    </div>
                }
                center={
                    <>
                        {/* Below the compact-toolbar breakpoint the cluster folds into the menus. */}
                        {canEdit && !isCompact && (
                            <>
                                <TooltipButton icon={Plus} tooltipText="Add slide" onClick={onAddSlide} />
                                <ToolButtons tool={tool} setTool={setTool} />
                                {onInsertImage && (
                                    <TooltipButton icon={ImagePlus} tooltipText="Add image" onClick={onInsertImage} />
                                )}
                            </>
                        )}
                        {/* Present is the one action a read-only viewer on any screen still gets. */}
                        <TooltipButton icon={Play} tooltipText="Present" onClick={onPresent} />
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
