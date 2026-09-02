import { useYjsUndoState } from '@workspace/lib/collab';
import type { useCommentFilter } from '@workspace/lib/comments';
import { EIGEN_STICKIES_COLORS, isLightColor } from '@workspace/lib/constants';
import { useIsCompactToolbar } from '@workspace/lib/media';
import type { DrivePath, EffectiveMember } from '@workspace/lib/types/drive';
import { CenteredToolbar, DocumentShareCluster, EditMenu, FileMenu, ToolbarMenu } from '@workspace/ui';
import { CommentFilterMenuItems, FilterSummary } from '@workspace/ui/components/comments';
import {
    DropdownMenuItem,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '@workspace/ui/components/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components/tooltip';
import { cn } from '@workspace/ui/lib/utils';
import { Check, Plus, SquareKanban } from 'lucide-react';
import { useState } from 'react';
import type * as Y from 'yjs';

type ToolbarProps = {
    canWrite: boolean;
    offline: boolean;
    undoManager: Y.UndoManager | null;
    onAccessDialogOpen: () => void;
    onAddColumn: () => void;
    path: DrivePath;
    filter: ReturnType<typeof useCommentFilter>;
    members: EffectiveMember[];
    currentUserEmail: string;
    onToggleActivityPanel?: () => void;
    activityPanelOpen?: boolean;
};

export function Toolbar({
    canWrite,
    offline,
    undoManager,
    onAccessDialogOpen,
    onAddColumn,
    path,
    filter,
    members,
    currentUserEmail,
    onToggleActivityPanel,
    activityPanelOpen,
}: ToolbarProps) {
    const { canUndo, canRedo, undo, redo } = useYjsUndoState(undoManager, canWrite);
    const isCompact = useIsCompactToolbar();
    // Controlled so assignee/status/clear picks can dismiss the menu; color toggles keep it open.
    const [filterOpen, setFilterOpen] = useState(false);

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
                        <ToolbarMenu label="Insert">
                            <DropdownMenuItem onClick={onAddColumn}>
                                <Plus className="h-4 w-4 mr-2" /> Column
                            </DropdownMenuItem>
                        </ToolbarMenu>
                    )}
                    <ToolbarMenu label="Filter" open={filterOpen} onOpenChange={setFilterOpen}>
                        <CommentFilterMenuItems
                            primitives={{
                                Item: DropdownMenuItem,
                                Sub: DropdownMenuSub,
                                SubTrigger: DropdownMenuSubTrigger,
                                SubContent: DropdownMenuSubContent,
                            }}
                            filter={filter}
                            members={members}
                            currentUserEmail={currentUserEmail}
                            onClose={() => setFilterOpen(false)}
                        />
                    </ToolbarMenu>
                </div>
            }
            center={
                isCompact ? null : (
                    <div className="flex items-center gap-1.5">
                        {EIGEN_STICKIES_COLORS[0].map((c) => {
                            const active = filter.filter.colors?.has(c.value) ?? false;
                            return (
                                <Tooltip key={c.value}>
                                    <TooltipTrigger asChild>
                                        <button
                                            className={cn(
                                                'h-4 w-4 rounded-full border border-border/50 transition-transform hover:scale-125 flex items-center justify-center',
                                                active && 'ring-2 ring-ring ring-offset-1',
                                            )}
                                            style={{ backgroundColor: c.value }}
                                            onClick={() => filter.toggleColor(c.value)}
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
                        {filter.isActive && <FilterSummary filter={filter} onClear={() => filter.clear()} inline />}
                    </div>
                )
            }
            right={
                <div className="flex items-center gap-1">
                    <DocumentShareCluster
                        canWrite={canWrite}
                        offline={offline}
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
