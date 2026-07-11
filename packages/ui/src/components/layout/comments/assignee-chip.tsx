import { useResolvedUser } from '@workspace/lib/public';
import { MemberAvatar } from './member-avatar';

// Avatar + resolved display name, used as the assignee label/trigger in card dialogs.
export function AssigneeChip({ email }: { email: string }) {
    const { displayName } = useResolvedUser({ email });
    return (
        <>
            <MemberAvatar email={email} />
            <span className="min-w-0 truncate">{displayName || email.split('@')[0]}</span>
        </>
    );
}
