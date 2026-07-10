import type { EffectiveMember } from '@workspace/lib/types/drive';
import { Check, CircleSlash, UserPlus } from 'lucide-react';
import type { CommentMenuPrimitives } from './comment-menu-items';
import { MemberAvatar } from './member-avatar';
import { MemberCommandList, memberRowClassName } from './member-command-list';

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
                    currentUserEmail={currentUserEmail}
                    selectedEmail={assignee}
                    onSelect={onAssign}
                    header={
                        <div className="p-1">
                            <button
                                type="button"
                                className={memberRowClassName}
                                onClick={() => onAssign(currentUserEmail)}
                            >
                                <MemberAvatar email={currentUserEmail} />
                                <span className="flex-1 truncate text-left">Me</span>
                                {assignee === currentUserEmail && <Check className="h-4 w-4 shrink-0" />}
                            </button>
                            <button type="button" className={memberRowClassName} onClick={() => onAssign(null)}>
                                <CircleSlash className="h-4 w-4 text-muted-foreground" />
                                <span className="flex-1 truncate text-left">Unassigned</span>
                                {assignee === null && <Check className="h-4 w-4 shrink-0" />}
                            </button>
                        </div>
                    }
                />
            </SubContent>
        </Sub>
    );
}
