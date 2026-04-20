import { formatForDisplay } from '@tanstack/react-hotkeys';
import { EIGEN_STICKIES_COLORS, isLightColor } from '@workspace/lib/constants';
import { useMediaQuery } from '@workspace/lib/media';
import type { DrivePath } from '@workspace/lib/types/drive';
import { TooltipButton } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';

import { DocumentModeButton } from '@workspace/ui/components/layout/toolbar/document-mode-button';
import { FileMenu } from '@workspace/ui/components/layout/toolbar/file-menu';
import { Toolbar as ToolbarWrapper } from '@workspace/ui/components/layout/toolbar/toolbar';
import { Separator } from '@workspace/ui/components/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components/tooltip';
import { Check, Plus, Redo, SquareKanban, Undo, UserRoundPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import type * as Y from 'yjs';

type ToolbarProps = {
    canWrite: boolean;
    undoManager: Y.UndoManager | null;
    onAccessDialogOpen: () => void;
    onRestore: (state: Uint8Array) => void;
    onAddColumn: () => void;
    path: DrivePath;
    colorFilter: Set<string>;
    onColorFilterChange: (filter: Set<string>) => void;
};

export function Toolbar({
    canWrite,
    undoManager,
    onAccessDialogOpen,
    onRestore,
    onAddColumn,
    path,
    colorFilter,
    onColorFilterChange,
}: ToolbarProps) {
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
        <ToolbarWrapper>
            <div className="flex items-center gap-1">
                <FileMenu
                    path={path}
                    canWrite={canWrite}
                    onAccessDialogOpen={onAccessDialogOpen}
                    onRestore={onRestore}
                    createLabel="New stickies"
                    createIcon={SquareKanban}
                    createType="stickies"
                />
                {canWrite && isMobile && (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button variant="ghost">Edit</Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                            <DropdownMenuItem onClick={() => undoManager?.undo?.()} disabled={!canUndo}>
                                <Undo className="h-4 w-4 mr-2" /> Undo
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => undoManager?.redo?.()} disabled={!canRedo}>
                                <Redo className="h-4 w-4 mr-2" /> Redo
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={onAddColumn}>
                                <Plus className="h-4 w-4 mr-2" /> Add column
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}
                {canWrite && !isMobile && (
                    <>
                        <Separator orientation="vertical" className="h-4" />
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
                        <Separator orientation="vertical" className="h-4" />
                        <TooltipButton icon={Plus} tooltipText="Add column" onClick={onAddColumn} />
                    </>
                )}
            </div>

            <div className="flex items-center gap-1.5">
                {EIGEN_STICKIES_COLORS[0].map((c) => {
                    const active = colorFilter.has(c.value);
                    return (
                        <Tooltip key={c.value}>
                            <TooltipTrigger asChild>
                                <button
                                    className={`h-4 w-4 rounded-full border border-border/50 transition-transform hover:scale-125 flex items-center justify-center ${active ? 'ring-2 ring-ring ring-offset-1' : ''}`}
                                    style={{ backgroundColor: c.value }}
                                    onClick={() => {
                                        const next = new Set(colorFilter);
                                        if (active) next.delete(c.value);
                                        else next.add(c.value);
                                        onColorFilterChange(next);
                                    }}
                                >
                                    {active && (
                                        <Check
                                            className="h-2 w-2"
                                            style={{ color: isLightColor(c.value) ? '#000' : '#fff' }}
                                        />
                                    )}
                                </button>
                            </TooltipTrigger>
                            <TooltipContent>Filter by {c.label.replace(/-\d+$/, '')}</TooltipContent>
                        </Tooltip>
                    );
                })}
                {colorFilter.size > 0 && (
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-5 text-xs px-1.5"
                        onClick={() => onColorFilterChange(new Set())}
                    >
                        Reset
                    </Button>
                )}
            </div>

            <div className="flex items-center gap-1">
                {canWrite ? (
                    <TooltipButton icon={UserRoundPlus} tooltipText="Share" onClick={onAccessDialogOpen} />
                ) : (
                    <DocumentModeButton canWrite={canWrite} />
                )}
            </div>
        </ToolbarWrapper>
    );
}
