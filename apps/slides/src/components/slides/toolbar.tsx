import {useEffect, useState} from 'react';
import {formatForDisplay} from '@tanstack/react-hotkeys';
import {ImagePlus, Play, Plus, Redo, Type, Undo, UserRoundPlus} from 'lucide-react';
import {Toolbar as SharedToolbar, TooltipButton} from '@workspace/ui';
import {Button} from '@workspace/ui/components/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import {DocumentModeButton} from '@workspace/ui/components/layout/toolbar/document-mode-button';
import {FileMenu} from '@workspace/ui/components/layout/toolbar/file-menu';
import {DriveCreateSlides} from '@workspace/ui/components/layout/drive/drive-create-slides';
import {useMediaQuery} from '@workspace/lib/media';
import * as Y from 'yjs';
import type {DrivePath} from '@workspace/lib/types/drive';

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
}

export function Toolbar({
                            canWrite,
                            undoManager,
                            onAccessDialogOpen,
                            onRestore,
                            path,
                            onAddText,
                            onAddImage,
                            onAddSlide,
                            onPresent
                        }: ToolbarProps) {
    const [canUndo, setCanUndo] = useState(false);
    const [canRedo, setCanRedo] = useState(false);
    const isMobile = useMediaQuery('(max-width: 1200px)');

    useEffect(() => {
        if (!undoManager || !undoManager.undoStack || !canWrite) {
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
        <SharedToolbar>
            <div className="flex items-center">
                <FileMenu
                    path={path}
                    canWrite={canWrite}
                    onAccessDialogOpen={onAccessDialogOpen}
                    onRestore={onRestore}
                    createLabel="New slides"
                    CreateDialog={DriveCreateSlides}
                />

                {canWrite && isMobile && (
                    <>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost">Edit</Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                                <DropdownMenuItem onClick={() => undoManager?.undo?.()} disabled={!canUndo}>
                                    <Undo className="h-4 w-4 mr-2"/> Undo
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => undoManager?.redo?.()} disabled={!canRedo}>
                                    <Redo className="h-4 w-4 mr-2"/> Redo
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>

                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost">Insert</Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                                <DropdownMenuItem onClick={onAddSlide}>
                                    <Plus className="h-4 w-4 mr-2"/> Slide
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={onAddText}>
                                    <Type className="h-4 w-4 mr-2"/> Text
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={onAddImage}>
                                    <ImagePlus className="h-4 w-4 mr-2"/> Image
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </>
                )}

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
                        <TooltipButton icon={Plus} tooltipText="Add slide" onClick={onAddSlide}/>
                        <TooltipButton icon={Type} tooltipText="Add text" onClick={onAddText}/>
                        <TooltipButton icon={ImagePlus} tooltipText="Add image" onClick={onAddImage}/>
                    </>
                )}
                <TooltipButton icon={Play} tooltipText="Present" onClick={onPresent}/>
            </div>
            <div className="flex items-center">
                {canWrite ? (
                    <TooltipButton icon={UserRoundPlus} tooltipText="Share" onClick={onAccessDialogOpen}/>
                ) : (
                    <DocumentModeButton canWrite={canWrite}/>
                )}
            </div>
        </SharedToolbar>
    );
}
