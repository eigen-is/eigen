import {useEffect, useState} from 'react';
import {formatForDisplay} from '@tanstack/react-hotkeys';
import {Check, Plus, Redo, Undo, UserRoundPlus} from 'lucide-react';
import {Button} from '@workspace/ui/components/button';
import {Separator} from '@workspace/ui/components/separator';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import {TooltipButton} from '@workspace/ui';
import {isLightColor} from '@workspace/ui/components/layout/media/color-picker';
import {DocumentModeButton} from '@workspace/ui/components/layout/toolbar/document-mode-button';
import {FileMenu} from '@workspace/ui/components/layout/toolbar/file-menu';
import {DriveCreateStickies} from '@workspace/ui/components/layout/drive/drive-create-stickies';
import {useMediaQuery} from '@workspace/lib/media';
import * as Y from 'yjs';
import {EIGEN_STICKIES_COLORS} from '@workspace/lib/constants';
import type {DrivePath} from '@workspace/lib/types/drive';

type ToolbarProps = {
    canWrite: boolean;
    undoManager: Y.UndoManager | null;
    onAccessDialogOpen: () => void;
    onRestore: (state: Uint8Array) => void;
    onAddColumn: () => void;
    path: DrivePath;
    colorFilter: Set<string>;
    onColorFilterChange: (filter: Set<string>) => void;
}

export function Toolbar({
                            canWrite,
                            undoManager,
                            onAccessDialogOpen,
                            onRestore,
                            onAddColumn,
                            path,
                            colorFilter,
                            onColorFilterChange
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
        <div className="bg-background h-12 flex items-center justify-between px-4 border-b no-print">
            <div className="flex items-center gap-1">
                <FileMenu
                    path={path}
                    canWrite={canWrite}
                    onAccessDialogOpen={onAccessDialogOpen}
                    onRestore={onRestore}
                    createLabel="New stickies"
                    CreateDialog={DriveCreateStickies}
                />
                {canWrite && isMobile && (
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
                            <DropdownMenuSeparator/>
                            <DropdownMenuItem onClick={onAddColumn}>
                                <Plus className="h-4 w-4 mr-2"/> Add column
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}
                {canWrite && !isMobile && (
                    <>
                        <Separator orientation="vertical" className="h-4"/>
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
                        <Separator orientation="vertical" className="h-4"/>
                        <TooltipButton
                            icon={Plus}
                            tooltipText="Add column"
                            onClick={onAddColumn}
                        />
                    </>
                )}
            </div>

            <div className="flex items-center gap-1.5">
                {EIGEN_STICKIES_COLORS[0].map((c) => {
                    const active = colorFilter.has(c.value);
                    return (
                        <button
                            key={c.value}
                            className={`h-4 w-4 rounded-full border border-border/50 transition-transform hover:scale-125 flex items-center justify-center ${active ? 'ring-2 ring-ring ring-offset-1' : ''}`}
                            style={{backgroundColor: c.value}}
                            title={c.label}
                            onClick={() => {
                                const next = new Set(colorFilter);
                                if (active) next.delete(c.value);
                                else next.add(c.value);
                                onColorFilterChange(next);
                            }}
                        >
                            {active && (
                                <Check className="h-2 w-2"
                                       style={{color: isLightColor(c.value) ? '#000' : '#fff'}}/>
                            )}
                        </button>
                    );
                })}
                {colorFilter.size > 0 && (
                    <Button variant="ghost" size="sm" className="h-5 text-xs px-1.5"
                            onClick={() => onColorFilterChange(new Set())}>
                        Reset
                    </Button>
                )}
            </div>

            <div className="flex items-center gap-1">
                {canWrite ? (
                    <TooltipButton icon={UserRoundPlus} tooltipText="Share" onClick={onAccessDialogOpen}/>
                ) : (
                    <DocumentModeButton canWrite={canWrite}/>
                )}
            </div>
        </div>
    );
}
