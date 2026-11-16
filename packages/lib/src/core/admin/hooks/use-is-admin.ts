// Whether the signed-in user may run the server. useIsAdmin reads the account's role, and useIsOrgOwner whether
// the user owns the organization, a role only the member setup gives. Settings and admin pages use them to show
// or hide what the server would refuse anyway.

import { useAuth } from '../../auth/auth-context';
import { usePublicConfig } from '../../public/hooks/use-public';
import { useMembers } from './use-members';

export function useIsAdmin(): boolean {
    const { user } = useAuth();
    return user?.role === 'admin';
}

// The role in the organization lives on the member, not on user.role.
export function useIsOrgOwner(): boolean {
    const { user } = useAuth();
    const { data: config } = usePublicConfig();
    const { data: members } = useMembers(config?.orgId);
    return members?.find((m) => m.userId === user?.id)?.role === 'owner';
}
