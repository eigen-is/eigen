import { formatDateTime } from '@workspace/lib/date';
import type { ReactNode } from 'react';
import { UserNameCard } from '../user-name-card';

export function useCreatedByMeta(email: string | undefined, createdAt: Date | number): ReactNode {
    return (
        <>
            Created by <UserNameCard email={email} className="font-medium hover:underline" /> on{' '}
            {formatDateTime(createdAt)}
        </>
    );
}
