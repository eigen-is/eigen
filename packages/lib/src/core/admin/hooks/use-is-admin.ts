import { useAuth } from '../../auth/auth-context';
import { usePublicConfig } from '../../public/hooks/use-public';
import { useMembers } from './use-members';

export function useIsAdmin() {
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
