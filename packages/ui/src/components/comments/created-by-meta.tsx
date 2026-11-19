// Who created a comment card and when, with their avatar, as the card's dialog shows it under the card.

import { formatDateTime } from '@workspace/lib/date';
import { UserNameCard } from '../user/user-name-card';
import { MemberAvatar } from './member-avatar';

type CreatedByMetaProps = {
    email: string;
    createdAt: Date | number;
};

export function CreatedByMeta({ email, createdAt }: CreatedByMetaProps) {
    return (
        <span className="flex min-w-0 items-center gap-1.5">
            <MemberAvatar email={email} className="h-5 w-5 shrink-0" />
            <span className="min-w-0 truncate">
                Created by <UserNameCard email={email} className="font-medium hover:underline" /> on{' '}
                {formatDateTime(createdAt)}
            </span>
        </span>
    );
}
