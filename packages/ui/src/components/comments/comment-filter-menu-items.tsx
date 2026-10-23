import { COMMENT_STATUS_FILTERS, COMMENT_STATUS_LABELS, type useCommentFilter } from '@workspace/lib/comments';
import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import type { EffectiveMember } from '@workspace/lib/types/drive';
import { CircleDot, FilterX, Palette, Users } from 'lucide-react';
import {
    ChoiceMenuSub,
    DropdownMenuCheckboxItem,
    DropdownMenuItem,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
} from '../dropdown-menu';
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
                <DropdownMenuSubTrigger>
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
                <DropdownMenuSubTrigger>
                    <Palette className="h-4 w-4" /> Color
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                    {EIGEN_STICKIES_COLORS[0].map((c) => (
                        <DropdownMenuCheckboxItem
                            key={c.value}
                            checked={colors?.has(c.value) ?? false}
                            // Stay open: colors are a multi-toggle.
                            onSelect={(e) => e.preventDefault()}
                            onCheckedChange={() => filter.toggleColor(c.value)}
                        >
                            <span
                                className="size-4 rounded-full shrink-0 border border-border/50"
                                style={{ backgroundColor: c.value }}
                            />
                            {c.label.replace(/-\d+$/, '')}
                        </DropdownMenuCheckboxItem>
                    ))}
                </DropdownMenuSubContent>
            </DropdownMenuSub>

            <ChoiceMenuSub
                trigger={
                    <>
                        <CircleDot className="h-4 w-4" /> Status
                    </>
                }
                value={status}
                options={COMMENT_STATUS_FILTERS.map((s) => ({
                    value: s,
                    label: COMMENT_STATUS_LABELS[s],
                }))}
                onChange={filter.setStatus}
            />

            {filter.isActive && (
                <DropdownMenuItem onClick={() => filter.clear()}>
                    <FilterX className="h-4 w-4" /> Clear filters
                </DropdownMenuItem>
            )}
        </>
    );
}
