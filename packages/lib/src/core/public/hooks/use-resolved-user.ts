import { API_HOST, getPublicAvatarUrl } from '@workspace/lib/api';
import { useContacts } from '@workspace/lib/contacts';
import { usePeopleTeams } from '@workspace/lib/people';
import { parseOwnerId } from '@workspace/lib/types';
import { usePublicConfig, usePublicUser } from './use-public';

type UseResolvedUserParams = {
    userId?: string;
    email?: string;
    name?: string;
    imageUrl?: string;
};

export function useResolvedUser({ userId, email, name, imageUrl }: UseResolvedUserParams) {
    const { data: dataContacts, isLoading: isLoadingContacts } = useContacts();
    const { data: dataPublic, isLoading: isLoadingPublic } = usePublicUser(userId || email || '');
    const { data: org } = usePublicConfig();
    const { data: teams } = usePeopleTeams(org?.orgId);

    const parsed = parseOwnerId(userId || email || '');

    const contact =
        !isLoadingContacts && email && dataContacts ? dataContacts.find((c) => c.email.includes(email)) : null;
    const publicUser = !isLoadingPublic ? dataPublic : null;

    const url = imageUrl !== undefined ? imageUrl || null : contact?.avatar || publicUser?.avatar || null;
    const displayName =
        (parsed.type === 'team' ? teams?.find((t) => t.id === parsed.id)?.name : '') ||
        (contact && `${contact.firstName} ${contact.lastName}`.trim()) ||
        publicUser?.name?.trim() ||
        name ||
        email ||
        '';
    const resolvedEmail = (parsed.type === 'team' ? 'Team' : '') || publicUser?.email || email || '';
    const avatarSrc = url ? `${API_HOST}/${url}` : getPublicAvatarUrl(userId || email || '');

    return {
        displayName,
        resolvedEmail,
        avatarSrc,
        isLoading: isLoadingContacts || isLoadingPublic,
    };
}
