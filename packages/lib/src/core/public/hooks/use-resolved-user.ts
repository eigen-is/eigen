// The name, email line and avatar to show for a user or team, such as on an avatar, a comment or a share
// entry. The user's own contact card wins, then the server's public profile, then what the caller passed.

import { API_HOST, getPublicAvatarUrl } from '@workspace/lib/api';
import { useContacts } from '@workspace/lib/contacts';
import { contactFullName, findContactByEmail } from '@workspace/lib/types/contact';
import { parseOwnerId, UNRESOLVED_TEAM_LABEL } from '@workspace/lib/types/owner';
import { usePublicUser } from './use-public';

type UseResolvedUserParams = {
    userId?: string;
    email?: string;
    name?: string;
    imageUrl?: string;
};

type ResolvedUser = { displayName: string; resolvedEmail: string; avatarSrc: string; isLoading: boolean };

export function useResolvedUser({ userId, email, name, imageUrl }: UseResolvedUserParams): ResolvedUser {
    const { data: dataContacts, isLoading: isLoadingContacts } = useContacts();

    const parsed = parseOwnerId(userId || email || '');
    const isTeam = parsed.type === 'team';
    // The public endpoint resolves teams too, so a non-member still gets a name.
    const { data: dataPublic, isLoading: isLoadingPublic } = usePublicUser(userId || email || '');

    const contact = !isLoadingContacts && email && dataContacts ? findContactByEmail(dataContacts, email) : null;
    const publicUser = !isLoadingPublic ? dataPublic : null;

    const url = imageUrl !== undefined ? imageUrl || null : contact?.avatar || publicUser?.avatar || null;
    const displayName =
        (contact && contactFullName(contact)) ||
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
