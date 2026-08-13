import { usePublicUsers } from '@workspace/lib/public';
import type { EffectiveMember } from '@workspace/lib/types/drive';
import { Check, CircleSlash, UserPlus } from 'lucide-react';
import type { CommentMenuPrimitives } from './comment-menu-items';
import { MemberAvatar } from './member-avatar';

type AssigneeMenuItemsProps = {
    primitives: Pick<CommentMenuPrimitives, 'Item' | 'Sub' | 'SubTrigger' | 'SubContent'>;
    members: EffectiveMember[];
    currentUserEmail: string;
    assignee: string | null;
    onAssign: (email: string | null) => void;
};

// Members render as real menu items (not a cmdk list) so arrow-key roving reaches them and the
// mobile drill-in page stays navigable; Radix menu typeahead covers the search the list used to have.
export function AssigneeMenuItems({
    primitives: { Item, Sub, SubTrigger, SubContent },
    members,
    currentUserEmail,
    assignee,
    onAssign,
}: AssigneeMenuItemsProps) {
    // The current user is pinned as a "Me" row, so drop their named row below.
    const me = currentUserEmail.toLowerCase();
    const listed = members.filter((m) => m.email !== me);
    const users = usePublicUsers(listed.map((m) => m.email));
    return (
        <Sub>
            <SubTrigger className="gap-2">
                <UserPlus className="h-4 w-4" /> Assign to
            </SubTrigger>
            <SubContent className="max-w-64">
                <Item onClick={() => onAssign(currentUserEmail)}>
                    <MemberAvatar email={currentUserEmail} />
                    <span className="flex-1 truncate">Me</span>
                    {assignee === currentUserEmail && <Check className="h-4 w-4 shrink-0" />}
                </Item>
                <Item onClick={() => onAssign(null)}>
                    <CircleSlash className="h-4 w-4 text-muted-foreground" />
                    <span className="flex-1 truncate">Unassigned</span>
                    {assignee === null && <Check className="h-4 w-4 shrink-0" />}
                </Item>
                {listed.map((m) => {
                    const displayName = users[m.email]?.name || m.email.split('@')[0];
                    return (
                        <Item key={m.email} onClick={() => onAssign(m.email)}>
                            <MemberAvatar email={m.email} />
                            <span className="flex-1 truncate">{displayName}</span>
                            {assignee === m.email && <Check className="h-4 w-4 shrink-0" />}
                        </Item>
                    );
                })}
            </SubContent>
        </Sub>
    );
}
