// The filter button in a comment panel's header: a popover that narrows the cards by assignee, color and open
// or resolved status. The filter state is the caller's useCommentFilter.

import type { useCommentFilter } from '@workspace/lib/comments';
import { COMMENT_STATUS_FILTERS, COMMENT_STATUS_LABELS } from '@workspace/lib/comments';
import { EIGEN_STICKIES_COLORS, readableTextColor } from '@workspace/lib/constants/colors';
import type { EffectiveMember } from '@workspace/lib/types/drive-access';
import { Button } from '@workspace/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@workspace/ui/components/popover';
import { Tabs, TabsList, TabsTrigger } from '@workspace/ui/components/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@workspace/ui/components/tooltip';
import { cn } from '@workspace/ui/lib/utils';
import { Check, ListFilter } from 'lucide-react';
import { MemberCommandList, PinnedAssigneeFilterRows } from './member-command-list';

type CommentFilterButtonProps = {
    filter: ReturnType<typeof useCommentFilter>;
    members: EffectiveMember[];
    currentUserEmail: string;
};

function GroupLabel({ children }: { children: string }) {
    return (
        <div className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {children}
        </div>
    );
}

export function CommentFilterButton({ filter, members, currentUserEmail }: CommentFilterButtonProps) {
    const { assignee, colors, status } = filter.filter;
    const memberSelected = typeof assignee === 'object' ? assignee.email : null;

    return (
        <Popover>
            <Tooltip>
                <TooltipTrigger asChild>
                    {/* aria-pressed styling, not data-state: TooltipTrigger asChild clobbers data-state */}
                    <PopoverTrigger asChild>
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-pressed={filter.isActive}
                            className="h-8 w-8 aria-pressed:bg-primary/15 aria-pressed:text-primary aria-pressed:hover:bg-primary/20 aria-pressed:hover:text-primary"
                        >
                            <ListFilter className="h-4 w-4" />
                        </Button>
                    </PopoverTrigger>
                </TooltipTrigger>
                <TooltipContent>Filter comments</TooltipContent>
            </Tooltip>
            <PopoverContent className="w-64 p-0" align="end">
                <div className="border-b p-2">
                    <GroupLabel>Assigned to</GroupLabel>
                    <MemberCommandList
                        members={members}
                        selectedEmail={memberSelected}
                        onSelect={(email) => filter.setAssignee({ email })}
                        currentUserEmail={currentUserEmail}
                        header={
                            <PinnedAssigneeFilterRows
                                assignee={assignee}
                                onSelect={filter.setAssignee}
                                currentUserEmail={currentUserEmail}
                            />
                        }
                    />
                </div>

                <div className="border-b p-2">
                    <GroupLabel>Color</GroupLabel>
                    <div className="flex flex-wrap items-center gap-1.5 px-1">
                        {EIGEN_STICKIES_COLORS[0].map((c) => {
                            const active = colors?.has(c.value) ?? false;
                            return (
                                <Tooltip key={c.value}>
                                    <TooltipTrigger asChild>
                                        <button
                                            type="button"
                                            className={cn(
                                                'flex h-4 w-4 items-center justify-center rounded-full border border-border/50 transition-transform hover:scale-125',
                                                active && 'ring-2 ring-ring ring-offset-1',
                                            )}
                                            style={{ backgroundColor: c.value }}
                                            onClick={() => filter.toggleColor(c.value)}
                                        >
                                            {active && (
                                                <Check
                                                    className="h-2 w-2"
                                                    style={{ color: readableTextColor(c.value) }}
                                                />
                                            )}
                                        </button>
                                    </TooltipTrigger>
                                    <TooltipContent>{c.name}</TooltipContent>
                                </Tooltip>
                            );
                        })}
                    </div>
                </div>

                <div className="p-2">
                    <GroupLabel>Status</GroupLabel>
                    <Tabs
                        value={status}
                        onValueChange={(v) => {
                            const next = COMMENT_STATUS_FILTERS.find((s) => s === v);
                            if (next) filter.setStatus(next);
                        }}
                    >
                        <TabsList className="w-full">
                            {COMMENT_STATUS_FILTERS.map((s) => (
                                <TabsTrigger key={s} value={s} className="flex-1 text-xs">
                                    {COMMENT_STATUS_LABELS[s]}
                                </TabsTrigger>
                            ))}
                        </TabsList>
                    </Tabs>
                </div>
            </PopoverContent>
        </Popover>
    );
}
