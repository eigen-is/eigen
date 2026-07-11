import { COMMENT_STATUS_LABELS, type useCommentFilter } from '@workspace/lib/comments';
import { EIGEN_STICKIES_COLORS } from '@workspace/lib/constants';
import type { EffectiveMember } from '@workspace/lib/types/drive';
import { Check, CircleDot, FilterX, Palette, Users } from 'lucide-react';
import type { CommentMenuPrimitives } from './comment-menu-items';
import { MemberCommandList, PinnedAssigneeFilterRows } from './member-command-list';

type CommentFilterMenuItemsProps = {
    primitives: CommentMenuPrimitives;
    filter: ReturnType<typeof useCommentFilter>;
    members: EffectiveMember[];
    currentUserEmail: string;
    // Assignee rows are cmdk/buttons that don't trigger Radix's close; hosts pass this to dismiss.
    onClose?: () => void;
};

// The three comment-filter groups (assignee / color / status) as submenus, rendered through the
// primitives slot so the same body serves any Radix menu family. Mirrors CommentFilterButton's
// popover, restyled as menu rows (see label-assign-sub-menu.tsx for the color swatches).
export function CommentFilterMenuItems({
    primitives: { Item, Sub, SubTrigger, SubContent },
    filter,
    members,
    currentUserEmail,
    onClose,
}: CommentFilterMenuItemsProps) {
    const { assignee, colors, status } = filter.filter;
    const memberSelected = typeof assignee === 'object' ? assignee.email : null;

    return (
        <>
            <Sub>
                <SubTrigger className="gap-2">
                    <Users className="h-4 w-4" /> Assigned to
                </SubTrigger>
                <SubContent className="w-64 p-0">
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
                </SubContent>
            </Sub>

            <Sub>
                <SubTrigger className="gap-2">
                    <Palette className="h-4 w-4" /> Color
                </SubTrigger>
                <SubContent>
                    {EIGEN_STICKIES_COLORS[0].map((c) => {
                        const active = colors?.has(c.value) ?? false;
                        return (
                            <Item
                                key={c.value}
                                onClick={(e: Event) => {
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
                            </Item>
                        );
                    })}
                </SubContent>
            </Sub>

            <Sub>
                <SubTrigger className="gap-2">
                    <CircleDot className="h-4 w-4" /> Status
                </SubTrigger>
                <SubContent>
                    {(['open', 'resolved', 'all'] as const).map((s) => (
                        <Item key={s} onClick={() => filter.setStatus(s)}>
                            <span className="flex-1">{COMMENT_STATUS_LABELS[s]}</span>
                            {status === s && <Check className="h-4 w-4 ml-2 shrink-0" />}
                        </Item>
                    ))}
                </SubContent>
            </Sub>

            {filter.isActive && (
                <Item onClick={() => filter.clear()}>
                    <FilterX className="h-4 w-4 mr-2" /> Clear filters
                </Item>
            )}
        </>
    );
}
