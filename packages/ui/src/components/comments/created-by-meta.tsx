import { formatDateTime } from '@workspace/lib/date';
import { UserNameCard } from '../user/user-name-card';

type CreatedByMetaProps = {
    email: string;
    createdAt: Date | number;
};

export function CreatedByMeta({ email, createdAt }: CreatedByMetaProps) {
    return (
        <>
            Created by <UserNameCard email={email} className="font-medium hover:underline" /> on{' '}
            {formatDateTime(createdAt)}
        </>
    );
}
