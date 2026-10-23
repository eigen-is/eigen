import { usePublicUsers } from '@workspace/lib/public';
import type { EffectiveMember } from '@workspace/lib/types/drive';
import { CircleSlash, UserPlus } from 'lucide-react';
import { ChoiceMenuSub } from '../dropdown-menu';
import { MemberAvatar } from './member-avatar';

type AssigneeMenuItemsProps = {
    members: EffectiveMember[];
    currentUserEmail: string;
    assignee: string | null;
    onAssign: (email: string | null) => void;
};

// Members render as real menu items (not a cmdk list) so arrow-key roving reaches them and the
// mobile drill-in page stays navigable; Radix menu typeahead covers the search the list used to have.
export function AssigneeMenuItems({ members, currentUserEmail, assignee, onAssign }: AssigneeMenuItemsProps) {
    // The current user is pinned as a "Me" row, so drop their named row below.
    const me = currentUserEmail.toLowerCase();
    const listed = members.filter((m) => m.email !== me);
    const users = usePublicUsers(listed.map((m) => m.email));
    return (
        <ChoiceMenuSub<string | null>
            trigger={
                <>
                    <UserPlus className="h-4 w-4" /> Assign to
                </>
            }
            contentClassName="max-w-64"
            value={assignee}
            options={[
                {
                    value: currentUserEmail,
                    label: (
                        <>
                            <MemberAvatar email={currentUserEmail} />
                            <span className="truncate">Me</span>
                        </>
                    ),
                },
                {
                    value: null,
                    label: (
                        <>
                            <CircleSlash className="h-4 w-4 text-muted-foreground" />
                            <span className="truncate">Unassigned</span>
                        </>
                    ),
                },
                ...listed.map((m) => ({
                    value: m.email,
                    label: (
                        <>
                            <MemberAvatar email={m.email} />
                            <span className="truncate">{users[m.email]?.name || m.email.split('@')[0]}</span>
                        </>
                    ),
                })),
            ]}
            onChange={onAssign}
        />
    );
}
