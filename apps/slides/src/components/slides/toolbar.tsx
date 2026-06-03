import { useYjsUndoState } from '@workspace/lib/collab';
import { useExportDocument } from '@workspace/lib/drive';
import { useMediaQuery } from '@workspace/lib/media';
import type { DrivePath } from '@workspace/lib/types/drive';
import { Toolbar as SharedToolbar, TooltipButton } from '@workspace/ui';

import { ExportProgressDialog } from '@workspace/ui/components/layout/drive/export-progress-dialog';
import { DocumentShareCluster } from '@workspace/ui/components/layout/toolbar/document-share-cluster';
import { FileMenu } from '@workspace/ui/components/layout/toolbar/file-menu';
import { UndoRedoButtons } from '@workspace/ui/components/layout/toolbar/undo-redo-buttons';
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
    unresolvedCommentCount,
}: ToolbarProps) {
    const { exportDocument, isExporting } = useExportDocument();
    const handleExport = (format: string) => exportDocument(path.ownerId, path.mountId, path.id, format);
    const { canUndo, canRedo, undo, redo } = useYjsUndoState(undoManager, canWrite);
    const isMobile = useMediaQuery('(max-width: 1200px)');

    return (
        <>
            <SharedToolbar>
                <div className="flex items-center">
                    <FileMenu
                        path={path}
                        canWrite={canWrite}
                        onAccessDialogOpen={onAccessDialogOpen}
                        onExport={handleExport}
                        exportFormats={['pdf', 'html']}
                        createLabel="New slide"
                        createIcon={Presentation}
                        createType="slides"
                    />

                    {canWrite && !isMobile && (
                        <UndoRedoButtons canUndo={canUndo} canRedo={canRedo} onUndo={undo} onRedo={redo} />
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
                    <DocumentShareCluster
                        canWrite={canWrite}
                        onAccessDialogOpen={onAccessDialogOpen}
                        onToggleCommentPanel={onToggleCommentPanel}
                        commentPanelOpen={commentPanelOpen}
                        unresolvedCommentCount={unresolvedCommentCount}
                    />
                </div>
            </SharedToolbar>
            <ExportProgressDialog open={isExporting} />
        </>
    );
}
