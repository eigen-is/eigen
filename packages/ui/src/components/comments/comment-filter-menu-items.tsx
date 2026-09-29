import { COMMENT_STATUS_LABELS, type useCommentFilter } from '@workspace/lib/comments';
import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import type { EffectiveMember } from '@workspace/lib/types/drive';
import { Check, CircleDot, FilterX, Palette, Users } from 'lucide-react';
import { DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from '../dropdown-menu';
import { MemberCommandList, PinnedAssigneeFilterRows } from './member-command-list';

type CommentFilterMenuItemsProps = {
    filter: ReturnType<typeof useCommentFilter>;
    members: EffectiveMember[];
    currentUserEmail: string;
    // Assignee rows are cmdk/buttons that don't trigger Radix's close; hosts pass this to dismiss.
    onClose?: () => void;
};

// The three comment-filter groups (assignee / color / status) as submenus. Mirrors
// CommentFilterButton's popover, restyled as menu rows (see label-assign-sub-menu.tsx for the color swatches).
export function CommentFilterMenuItems({ filter, members, currentUserEmail, onClose }: CommentFilterMenuItemsProps) {
    const { assignee, colors, status } = filter.filter;
    const memberSelected = typeof assignee === 'object' ? assignee.email : null;

    return (
        <>
            <DropdownMenuSub>
                <DropdownMenuSubTrigger className="gap-2">
                    <Users className="h-4 w-4" /> Assigned to
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-64 p-0">
                    <MemberCommandList
                        members={members}
                        selectedEmail={memberSelected}
                        onSelect={(email) => {
                            filter.setAssignee({ email });
                            onClose?.();
                        }}
                        currentUserEmail={currentUserEmail}
                        header={
                            <PinnedAssigneeFilterRows
                                assignee={assignee}
                                onSelect={(a) => {
                                    filter.setAssignee(a);
                                    onClose?.();
                                }}
                                currentUserEmail={currentUserEmail}
                            />
                        }
                    />
                </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSub>
                <DropdownMenuSubTrigger className="gap-2">
                    <Palette className="h-4 w-4" /> Color
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                    {EIGEN_STICKIES_COLORS[0].map((c) => {
                        const active = colors?.has(c.value) ?? false;
                        return (
                            <DropdownMenuItem
                                key={c.value}
                                onClick={(e) => {
                                    e.preventDefault();
                                    filter.toggleColor(c.value);
                                }}
                            >
                                <span
                                    className="h-3 w-3 rounded-full mr-2 shrink-0 border border-border/50"
                                    style={{ backgroundColor: c.value }}
                                />
                                <span className="flex-1">{c.label.replace(/-\d+$/, '')}</span>
                                {active && <Check className="h-4 w-4 ml-2 shrink-0" />}
                            </DropdownMenuItem>
                        );
                    })}
                </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSub>
                <DropdownMenuSubTrigger className="gap-2">
                    <CircleDot className="h-4 w-4" /> Status
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                    {(['open', 'resolved', 'all'] as const).map((s) => (
                        <DropdownMenuItem key={s} onClick={() => filter.setStatus(s)}>
                            <span className="flex-1">{COMMENT_STATUS_LABELS[s]}</span>
                            {status === s && <Check className="h-4 w-4 ml-2 shrink-0" />}
                        </DropdownMenuItem>
                    ))}
                </DropdownMenuSubContent>
            </DropdownMenuSub>

            {filter.isActive && (
                <DropdownMenuItem onClick={() => filter.clear()}>
                    <FilterX className="h-4 w-4 mr-2" /> Clear filters
                </DropdownMenuItem>
            )}
        </>
    );
}
