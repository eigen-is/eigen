import { useYjsUndoState } from '@workspace/lib/collab';
import { EIGEN_STICKIES_COLORS, isLightColor } from '@workspace/lib/constants';
import { useMediaQuery } from '@workspace/lib/media';
import type { DrivePath } from '@workspace/lib/types/drive';
import { CenteredToolbar } from '@workspace/ui';
import { Button } from '@workspace/ui/components/button';
import {
    DropdownMenu,
    DropdownMenuCheckboxItem,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { DocumentShareCluster } from '@workspace/ui/components/layout/toolbar/document-share-cluster';
import { EditMenu } from '@workspace/ui/components/layout/toolbar/edit-menu';
import { FileMenu } from '@workspace/ui/components/layout/toolbar/file-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components/tooltip';
import { cn } from '@workspace/ui/lib/utils';
import { Check, Plus, SquareKanban } from 'lucide-react';
import type * as Y from 'yjs';

type ToolbarProps = {
    canWrite: boolean;
    undoManager: Y.UndoManager | null;
    onAccessDialogOpen: () => void;
    onAddColumn: () => void;
    path: DrivePath;
    colorFilter: Set<string>;
    onColorFilterChange: (filter: Set<string>) => void;
    onToggleActivityPanel?: () => void;
    activityPanelOpen?: boolean;
};

export function Toolbar({
    canWrite,
    undoManager,
    onAccessDialogOpen,
    onAddColumn,
    path,
    colorFilter,
    onColorFilterChange,
    onToggleActivityPanel,
    activityPanelOpen,
}: ToolbarProps) {
    const { canUndo, canRedo, undo, redo } = useYjsUndoState(undoManager, canWrite);
    // ≤1200px the center dot row doesn't fit — the Filter menu replaces it (same state, two entry points).
    const isMobile = useMediaQuery('(max-width: 1200px)');

    return (
        <CenteredToolbar
            left={
                <div className="flex items-center">
                    <FileMenu
                        path={path}
                        canWrite={canWrite}
                        onAccessDialogOpen={onAccessDialogOpen}
                        createLabel="New stickies"
                        createIcon={SquareKanban}
                        createType="stickies"
                    />
                    <EditMenu canEdit={canWrite} canUndo={canUndo} canRedo={canRedo} onUndo={undo} onRedo={redo} />
                    {canWrite && (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost">Insert</Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                                <DropdownMenuItem onClick={onAddColumn}>
                                    <Plus className="h-4 w-4 mr-2" /> Column
                                </DropdownMenuItem>
                            </DropdownMenuContent>
                        </DropdownMenu>
                    )}
                    {isMobile && (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <Button variant="ghost">Filter</Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                                {EIGEN_STICKIES_COLORS[0].map((c) => (
                                    <DropdownMenuCheckboxItem
                                        key={c.value}
                                        checked={colorFilter.has(c.value)}
                                        onSelect={(e) => e.preventDefault()}
                                        onCheckedChange={(checked) => {
                                            const next = new Set(colorFilter);
                                            if (checked) next.add(c.value);
                                            else next.delete(c.value);
                                            onColorFilterChange(next);
                                        }}
                                    >
                                        <span
                                            className="h-3 w-3 rounded-full border border-border/50"
                                            style={{ backgroundColor: c.value }}
                                        />
                                        {c.label.replace(/-\d+$/, '')}
                                    </DropdownMenuCheckboxItem>
                                ))}
                                {colorFilter.size > 0 && (
                                    <>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem onClick={() => onColorFilterChange(new Set())}>
                                            Show all
                                        </DropdownMenuItem>
                                    </>
                                )}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    )}
                </div>
            }
            center={
                isMobile ? null : (
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
                )
            }
            right={
                <div className="flex items-center gap-1">
                    <DocumentShareCluster
                        canWrite={canWrite}
                        onAccessDialogOpen={onAccessDialogOpen}
                        onToggleActivityPanel={onToggleActivityPanel}
                        activityPanelOpen={activityPanelOpen}
                        watchTarget={{ ownerId: path.ownerId, mountId: path.mountId, pathId: path.id }}
                    />
                </div>
            }
        />
    );
}
