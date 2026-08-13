import { useResolvedUser } from '@workspace/lib/public';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../hover-card';
import { UserItem } from './user-item';

export type UserNameCardProps = {
    name?: string;
    email?: string;
    userId?: string;
    className?: string;
    mailLink?: boolean;
};

// Display name + UserItem hover card; shows the email local part until the batched fetch resolves.
export function UserNameCard({ name, email, userId, className, mailLink = false }: UserNameCardProps) {
    const { displayName, resolvedEmail } = useResolvedUser({ userId, email, name });

    const localPart = (email || resolvedEmail || '').split('@')[0];
    const label = displayName && displayName !== resolvedEmail ? displayName : localPart || displayName;

    return (
        <HoverCard>
            <HoverCardTrigger asChild>
                <span className={className}>{label}</span>
            </HoverCardTrigger>
            <HoverCardContent className="w-auto p-3">
                <UserItem userId={userId} email={email} name={name} mailLink={mailLink} />
            </HoverCardContent>
        </HoverCard>
    );
}
