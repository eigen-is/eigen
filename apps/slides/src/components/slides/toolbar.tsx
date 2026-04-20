import { formatForDisplay } from '@tanstack/react-hotkeys';
import { useExportDocument } from '@workspace/lib/drive';
import { useMediaQuery } from '@workspace/lib/media';
import type { DrivePath } from '@workspace/lib/types/drive';
import { CountBadge, Toolbar as SharedToolbar, TooltipButton } from '@workspace/ui';
import { DriveCreateSlides } from '@workspace/ui/components/layout/drive/drive-create-slides';
import { ExportProgressDialog } from '@workspace/ui/components/layout/drive/export-progress-dialog';
import { DocumentModeButton } from '@workspace/ui/components/layout/toolbar/document-mode-button';
import { FileMenu } from '@workspace/ui/components/layout/toolbar/file-menu';
import { ImagePlus, MessageSquare, Play, Plus, Presentation, Redo, Type, Undo, UserRoundPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import type * as Y from 'yjs';

type ToolbarProps = {
    canWrite: boolean;
    undoManager: Y.UndoManager | null;
    onAccessDialogOpen: () => void;
    onRestore: (state: Uint8Array) => void;
    path: DrivePath;
    onAddText: () => void;
    onAddImage: () => void;
    onAddSlide: () => void;
    onPresent: () => void;
    onToggleCommentPanel?: () => void;
    commentPanelOpen?: boolean;
    unresolvedCommentCount?: number;
};

export function Toolbar({
    canWrite,
    undoManager,
    onAccessDialogOpen,
    onRestore,
    path,
    onAddText,
    onAddImage,
    onAddSlide,
    onPresent,
    onToggleCommentPanel,
    commentPanelOpen,
    unresolvedCommentCount,
}: ToolbarProps) {
    const { exportDocument, isExporting } = useExportDocument();
    const handleExport = (format: string) => exportDocument(path.ownerId, path.mountId, path.id, format);
    const [canUndo, setCanUndo] = useState(false);
    const [canRedo, setCanRedo] = useState(false);
    const isMobile = useMediaQuery('(max-width: 1200px)');

    useEffect(() => {
        if (!undoManager?.undoStack || !canWrite) {
            setCanUndo(false);
            setCanRedo(false);
            return;
        }
        const update = () => {
            setCanUndo(undoManager.undoStack.length > 0);
            setCanRedo(undoManager.redoStack.length > 0);
        };
        update();
        undoManager.on('stack-item-added', update);
        undoManager.on('stack-item-popped', update);
        undoManager.on('stack-item-updated', update);
        return () => {
            undoManager.off('stack-item-added', update);
            undoManager.off('stack-item-popped', update);
            undoManager.off('stack-item-updated', update);
        };
    }, [undoManager, canWrite]);

    return (
        <>
            <SharedToolbar>
                <div className="flex items-center">
                    <FileMenu
                        path={path}
                        canWrite={canWrite}
                        onAccessDialogOpen={onAccessDialogOpen}
                        onRestore={onRestore}
                        onExport={handleExport}
                        exportFormats={['pdf', 'html']}
                        createLabel="New slides"
                        createIcon={Presentation}
                        CreateDialog={DriveCreateSlides}
                    />

                    {canWrite && !isMobile && (
                        <>
                            <TooltipButton
                                icon={Undo}
                                tooltipText={`Undo (${formatForDisplay('Mod+Z')})`}
                                onClick={() => undoManager?.undo?.()}
                                disabled={!canUndo}
                            />
                            <TooltipButton
                                icon={Redo}
                                tooltipText={`Redo (${formatForDisplay('Mod+Y')})`}
                                onClick={() => undoManager?.redo?.()}
                                disabled={!canRedo}
                            />
                        </>
                    )}
                </div>
                <div className="flex items-center">
                    {canWrite && !isMobile && (
                        <>
                            <TooltipButton icon={Plus} tooltipText="Add slide" onClick={onAddSlide} />
                            <TooltipButton icon={Type} tooltipText="Add text" onClick={onAddText} />
                            <TooltipButton icon={ImagePlus} tooltipText="Add image" onClick={onAddImage} />
                        </>
                    )}
                    <TooltipButton icon={Play} tooltipText="Present" onClick={onPresent} />
                </div>
                <div className="flex items-center">
                    {onToggleCommentPanel && (
                        <div className="relative">
                            <TooltipButton
                                icon={MessageSquare}
                                tooltipText="Comments"
                                onClick={onToggleCommentPanel}
                                active={commentPanelOpen}
                            />
                            <CountBadge count={unresolvedCommentCount ?? 0} />
                        </div>
                    )}
                    {canWrite ? (
                        <TooltipButton icon={UserRoundPlus} tooltipText="Share" onClick={onAccessDialogOpen} />
                    ) : (
                        <DocumentModeButton canWrite={canWrite} />
                    )}
                </div>
            </SharedToolbar>
            <ExportProgressDialog open={isExporting} />
        </>
    );
}
