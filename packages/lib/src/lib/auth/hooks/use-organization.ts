import {useQuery} from '@tanstack/react-query';
import {authClient} from './use-auth-client';

/** Returns the user's first (and only, in single-org Eigen) organization */
export function useOrganization() {
    return useQuery({
        queryKey: ['organization'],
        queryFn: async () => {
            const {data} = await authClient.organization.list();
            if (data && data.length > 0) return data[0];
            return null;
        },
        staleTime: 1000 * 60 * 10,
    });
}

export function useTeams(organizationId?: string) {
    return useQuery({
        queryKey: ['organization', 'teams', organizationId],
        queryFn: async () => {
            const {data} = await authClient.organization.listTeams({
                query: {organizationId: organizationId!},
            });
            return data ?? [];
        },
        staleTime: 1000 * 60 * 5,
        enabled: !!organizationId,
    });
}

export function useMembers(organizationId?: string) {
    return useQuery({
        queryKey: ['organization', 'members', organizationId],
        queryFn: async () => {
            const {data} = await authClient.organization.listMembers({
                query: {organizationId: organizationId!},
            });
            return data ?? [];
        },
        staleTime: 1000 * 60 * 5,
        enabled: !!organizationId,
    });
}
