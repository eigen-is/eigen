import { useAuth } from '../../auth/auth-context';
import { usePublicConfig } from '../../public/hooks/use-public';
import { useMembers } from './use-members';

export function useIsAdmin() {
    const { user } = useAuth();
    const { data: config } = usePublicConfig();
    const { data: members = [] } = useMembers(config?.orgId);
    const member = members.find((m) => m.userId === user?.id);
    return member?.role === 'admin' || member?.role === 'owner';
}
