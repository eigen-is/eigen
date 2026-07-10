import type { EffectiveMember } from '@workspace/lib/types/drive';
import { UserPlus } from 'lucide-react';
import type { CommentMenuPrimitives } from './comment-menu-items';
import { MemberCommandList, PinnedAssigneeRows } from './member-command-list';

type AssigneeMenuItemsProps = {
    primitives: Pick<CommentMenuPrimitives, 'Sub' | 'SubTrigger' | 'SubContent'>;
    members: EffectiveMember[];
    currentUserEmail: string;
    assignee: string | null;
    onAssign: (email: string | null) => void;
};

export function AssigneeMenuItems({
    primitives: { Sub, SubTrigger, SubContent },
    members,
    currentUserEmail,
    assignee,
    onAssign,
}: AssigneeMenuItemsProps) {
    return (
        <Sub>
            <SubTrigger className="gap-2">
                <UserPlus className="h-4 w-4" /> Assign to
            </SubTrigger>
            <SubContent className="w-64 p-0">
                <MemberCommandList
                    members={members}
                    selectedEmail={assignee}
                    onSelect={onAssign}
                    header={
                        <PinnedAssigneeRows
                            currentUserEmail={currentUserEmail}
                            selected={assignee}
                            onSelect={onAssign}
                            meLabel="Me"
                        />
                    }
                />
            </SubContent>
        </Sub>
    );
}
