import { API_HOST, getPublicAvatarUrl } from '@workspace/lib/api';
import { useContacts } from '@workspace/lib/contacts';
import { parseOwnerId, UNRESOLVED_TEAM_LABEL } from '@workspace/lib/types';
import { usePublicUser } from './use-public';

type UseResolvedUserParams = {
    userId?: string;
    email?: string;
    name?: string;
    imageUrl?: string;
};

export function useResolvedUser({ userId, email, name, imageUrl }: UseResolvedUserParams) {
    const { data: dataContacts, isLoading: isLoadingContacts } = useContacts();

    const parsed = parseOwnerId(userId || email || '');
    const isTeam = parsed.type === 'team';
    // The public endpoint resolves teams too, so a non-member still gets a name.
    const { data: dataPublic, isLoading: isLoadingPublic } = usePublicUser(userId || email || '');

    const contact =
        !isLoadingContacts && email && dataContacts ? dataContacts.find((c) => c.email.includes(email)) : null;
    const publicUser = !isLoadingPublic ? dataPublic : null;

    const url = imageUrl !== undefined ? imageUrl || null : contact?.avatar || publicUser?.avatar || null;
    const displayName =
        (contact && `${contact.firstName} ${contact.lastName}`.trim()) ||
        publicUser?.name?.trim() ||
        name ||
        // An email reads fine as a last resort; a `team_<id>` doesn't, so teams stop here.
        (isTeam ? UNRESOLVED_TEAM_LABEL : email) ||
        '';
    // The type label every team shows where a user shows an email, not the fallback above.
    const resolvedEmail = isTeam ? 'Team' : publicUser?.email || email || '';
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
