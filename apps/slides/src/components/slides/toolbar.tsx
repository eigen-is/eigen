import { useYjsUndoState } from '@workspace/lib/collab';
import { useIsCompactToolbar } from '@workspace/lib/media';
import type { DrivePath } from '@workspace/lib/types/drive';
import {
    CenteredToolbar,
    DocumentShareCluster,
    EditMenu,
    FileMenu,
    ToolbarMenu,
    TooltipButton,
    useLayout,
} from '@workspace/ui';
import { ExportProgressDialog, useDocumentExport } from '@workspace/ui/components/drive/use-document-export';
import { DropdownMenuItem } from '@workspace/ui/components/dropdown-menu';
import { ImagePlus, Play, Plus, Presentation, Type } from 'lucide-react';
import type * as Y from 'yjs';

type ToolbarProps = {
    canWrite: boolean;
    offline: boolean;
    storageUnavailable: boolean;
    undoManager: Y.UndoManager | null;
    onAccessDialogOpen: () => void;
    path: DrivePath;
    onAddText: () => void;
    onAddImage: () => void;
    onAddSlide: () => void;
    onPresent: () => void;
    onToggleCommentPanel?: () => void;
    commentPanelOpen?: boolean;
    onToggleActivityPanel?: () => void;
    activityPanelOpen?: boolean;
    assignedCommentCount?: number;
};

export function Toolbar({
    canWrite,
    offline,
    storageUnavailable,
    undoManager,
    onAccessDialogOpen,
    path,
    onAddText,
    onAddImage,
    onAddSlide,
    onPresent,
    onToggleCommentPanel,
    commentPanelOpen,
    onToggleActivityPanel,
    activityPanelOpen,
    assignedCommentCount,
}: ToolbarProps) {
    const { exportPath, isExporting } = useDocumentExport();
    const { canUndo, canRedo, undo, redo } = useYjsUndoState(undoManager, canWrite);
    const isCompact = useIsCompactToolbar();
    // Below the 768px system breakpoint the slide canvas unmounts (view-only), so editing entries
    // (undo/redo, Insert) disappear there. isCanvasHidden mirrors the editor's useLayout().isMobile gate.
    const { isMobile: isCanvasHidden } = useLayout();
    const canEdit = canWrite && !isCanvasHidden;

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
                            createLabel="New slide"
                            createIcon={Presentation}
                            createType="slides"
                        />

                        <EditMenu canEdit={canEdit} canUndo={canUndo} canRedo={canRedo} onUndo={undo} onRedo={redo} />

                        {canEdit && (
                            <ToolbarMenu label="Insert">
                                <DropdownMenuItem onClick={onAddSlide}>
                                    <Plus className="h-4 w-4 mr-2" /> Slide
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={onAddText}>
                                    <Type className="h-4 w-4 mr-2" /> Text
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={onAddImage}>
                                    <ImagePlus className="h-4 w-4 mr-2" /> Image
                                </DropdownMenuItem>
                            </ToolbarMenu>
                        )}
                    </div>
                }
                center={
                    <>
                        {canWrite && !isCompact && (
                            <>
                                <TooltipButton icon={Plus} tooltipText="Add slide" onClick={onAddSlide} />
                                <TooltipButton icon={Type} tooltipText="Add text" onClick={onAddText} />
                                <TooltipButton icon={ImagePlus} tooltipText="Add image" onClick={onAddImage} />
                            </>
                        )}
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
                            onToggleCommentPanel={onToggleCommentPanel}
                            commentPanelOpen={commentPanelOpen}
                            onToggleActivityPanel={onToggleActivityPanel}
                            activityPanelOpen={activityPanelOpen}
                            assignedCommentCount={assignedCommentCount}
                            watchTarget={{ ownerId: path.ownerId, mountId: path.mountId, pathId: path.id }}
                        />
                    </div>
                }
            />
            <ExportProgressDialog open={isExporting} />
        </>
    );
}
