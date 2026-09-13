import { API_HOST, getPublicAvatarUrl } from '@workspace/lib/api';
import { useContacts } from '@workspace/lib/contacts';
import { useMyTeams } from '@workspace/lib/home';
import { parseOwnerId } from '@workspace/lib/types';
import { usePublicUser } from './use-public';

type UseResolvedUserParams = {
    userId?: string;
    email?: string;
    name?: string;
    imageUrl?: string;
};

export function useResolvedUser({ userId, email, name, imageUrl }: UseResolvedUserParams) {
    const { data: dataContacts, isLoading: isLoadingContacts } = useContacts();
    const { data: teams } = useMyTeams();

    const parsed = parseOwnerId(userId || email || '');
    const isTeam = parsed.type === 'team';
    const { data: dataPublic, isLoading: isLoadingPublic } = usePublicUser(isTeam ? undefined : userId || email || '');

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
    // Only a relative cache path is the API's to serve. An absolute URL, or the inline `data:` photo a
    // vCard preview builds from a card's PHOTO, is already the image and must not be prefixed.
    const avatarSrc = !url
        ? getPublicAvatarUrl(userId || email || '')
        : /^(https?|data):/i.test(url)
          ? url
          : `${API_HOST}/${url}`;

    return {
        displayName,
        resolvedEmail,
        avatarSrc,
        isLoading: isLoadingContacts || isLoadingPublic,
    };
}
