import { useYjsUndoState } from '@workspace/lib/collab';
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
import { DocumentShareCluster } from '@workspace/ui/components/layout/toolbar/document-share-cluster';
import { FileMenu } from '@workspace/ui/components/layout/toolbar/file-menu';
import { Toolbar as ToolbarWrapper } from '@workspace/ui/components/layout/toolbar/toolbar';
import { UndoRedoButtons } from '@workspace/ui/components/layout/toolbar/undo-redo-buttons';
import { Separator } from '@workspace/ui/components/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components/tooltip';
import { cn } from '@workspace/ui/lib/utils';
import { Check, Plus, Redo, SquareKanban, Undo } from 'lucide-react';
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
    const { canUndo, canRedo, undo, redo } = useYjsUndoState(undoManager, canWrite);
    const isMobile = useMediaQuery('(max-width: 1200px)');

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
                            <DropdownMenuItem onClick={undo} disabled={!canUndo}>
                                <Undo className="h-4 w-4 mr-2" /> Undo
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={redo} disabled={!canRedo}>
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
                        <UndoRedoButtons canUndo={canUndo} canRedo={canRedo} onUndo={undo} onRedo={redo} />
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
                                    className={cn(
                                        'h-4 w-4 rounded-full border border-border/50 transition-transform hover:scale-125 flex items-center justify-center',
                                        active && 'ring-2 ring-ring ring-offset-1',
                                    )}
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
                <DocumentShareCluster canWrite={canWrite} onAccessDialogOpen={onAccessDialogOpen} />
            </div>
        </ToolbarWrapper>
    );
}
