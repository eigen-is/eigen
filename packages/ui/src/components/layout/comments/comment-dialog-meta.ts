import { formatDateTime } from '@workspace/lib/date';
import { useResolvedUser } from '@workspace/lib/public';

export function useCreatedByMeta(email: string | undefined, createdAt: Date | number) {
    const { displayName } = useResolvedUser({ email });
    const name = displayName || email?.split('@')[0] || 'unknown';
    return `Created by ${name} on ${formatDateTime(createdAt)}`;
}
