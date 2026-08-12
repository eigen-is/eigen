import { useYjsUndoState } from '@workspace/lib/collab';
import { useIsCompactToolbar } from '@workspace/lib/media';
import type { DrivePath } from '@workspace/lib/types/drive';
import { CenteredToolbar, TooltipButton } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { useLayout } from '@workspace/ui/components/layout/app/layout-context';
import { ExportProgressDialog, useDocumentExport } from '@workspace/ui/components/layout/drive/use-document-export';
import { DocumentShareCluster } from '@workspace/ui/components/layout/toolbar';
import { EditMenu } from '@workspace/ui/components/layout/toolbar/edit-menu';
import { FileMenu } from '@workspace/ui/components/layout/toolbar/file-menu';
import { ImagePlus, Play, Plus, Presentation, Type } from 'lucide-react';
import type * as Y from 'yjs';

type ToolbarProps = {
    canWrite: boolean;
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
    unresolvedCommentCount?: number;
};

export function Toolbar({
    canWrite,
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
    unresolvedCommentCount,
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
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="ghost">Insert</Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="start">
                                    <DropdownMenuItem onClick={onAddSlide}>
                                        <Plus className="h-4 w-4 mr-2" /> Slide
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={onAddText}>
                                        <Type className="h-4 w-4 mr-2" /> Text
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={onAddImage}>
                                        <ImagePlus className="h-4 w-4 mr-2" /> Image
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
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
                            onAccessDialogOpen={onAccessDialogOpen}
                            onToggleCommentPanel={onToggleCommentPanel}
                            commentPanelOpen={commentPanelOpen}
                            onToggleActivityPanel={onToggleActivityPanel}
                            activityPanelOpen={activityPanelOpen}
                            unresolvedCommentCount={unresolvedCommentCount}
                            watchTarget={{ ownerId: path.ownerId, mountId: path.mountId, pathId: path.id }}
                        />
                    </div>
                }
            />
            <ExportProgressDialog open={isExporting} />
        </>
    );
}
