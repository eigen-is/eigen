// Whether the signed-in user may run the server: useIsAdmin reads the account's role, and useIsOrgOwner the
// org role that only the member setup made owner holds. Settings and admin pages use them to show or hide
// what the server would refuse anyway.

import { useAuth } from '../../auth/auth-context';
import { usePublicConfig } from '../../public/hooks/use-public';
import { useMembers } from './use-members';

export function useIsAdmin(): boolean {
    const { user } = useAuth();
    return user?.role === 'admin';
}

// The org role, which user.role is not: only the member setup made owner holds the server's settings.
export function useIsOrgOwner(): boolean {
    const { user } = useAuth();
    const { data: config } = usePublicConfig();
    const { data: members } = useMembers(config?.orgId);
    return members?.find((m) => m.userId === user?.id)?.role === 'owner';
}
