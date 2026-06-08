import { useYjsUndoState } from '@workspace/lib/collab';
import { useExportDocument } from '@workspace/lib/drive';
import { useMediaQuery } from '@workspace/lib/media';
import type { DrivePath } from '@workspace/lib/types/drive';
import { CenteredToolbar, TooltipButton } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { useLayout } from '@workspace/ui/components/layout/app/layout-context';
import { ExportProgressDialog } from '@workspace/ui/components/layout/drive/export-progress-dialog';
import { DocumentShareCluster } from '@workspace/ui/components/layout/toolbar/document-share-cluster';
import { FileMenu } from '@workspace/ui/components/layout/toolbar/file-menu';
import { UndoRedoButtons } from '@workspace/ui/components/layout/toolbar/undo-redo-buttons';
import { ImagePlus, Play, Plus, Presentation, Redo, Type, Undo } from 'lucide-react';
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
    // Below the 768px system breakpoint the slide canvas unmounts (view-only), so the mobile
    // Edit menu belongs only in the 769–1200px band: editing is live but the inline toolbar
    // buttons have collapsed. isCanvasHidden mirrors the editor's own useLayout().isMobile gate.
    const { isMobile: isCanvasHidden } = useLayout();
    const showMobileEditMenu = canWrite && isMobile && !isCanvasHidden;

    return (
        <>
            <CenteredToolbar
                left={
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

                        {showMobileEditMenu && (
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="ghost">Edit</Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="start">
                                    <DropdownMenuItem onClick={undo} disabled={!canUndo}>
                                        <Undo className="h-4 w-4 mr-2" /> Undo
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={redo} disabled={!canRedo}>
                                        <Redo className="h-4 w-4 mr-2" /> Redo
                                    </DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem onClick={onAddSlide}>
                                        <Plus className="h-4 w-4 mr-2" /> Add slide
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={onAddText}>
                                        <Type className="h-4 w-4 mr-2" /> Add text
                                    </DropdownMenuItem>
                                    <DropdownMenuItem onClick={onAddImage}>
                                        <ImagePlus className="h-4 w-4 mr-2" /> Add image
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        )}

                        {canWrite && !isMobile && (
                            <UndoRedoButtons canUndo={canUndo} canRedo={canRedo} onUndo={undo} onRedo={redo} />
                        )}
                    </div>
                }
                center={
                    <>
                        {canWrite && !isMobile && (
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
                    <DocumentShareCluster
                        canWrite={canWrite}
                        onAccessDialogOpen={onAccessDialogOpen}
                        onToggleCommentPanel={onToggleCommentPanel}
                        commentPanelOpen={commentPanelOpen}
                        unresolvedCommentCount={unresolvedCommentCount}
                    />
                }
            />
            <ExportProgressDialog open={isExporting} />
        </>
    );
}
