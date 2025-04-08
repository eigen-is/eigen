import {useContacts} from '../../contacts/hooks/use-contacts';
import {useEffect, useState} from 'react';
import {Contact} from '@apps/api-server/types/contact';
import { usePublicUser } from '../../public';
import { type PublicUser} from '@apps/api-server/types/public';

// In-memory cache for avatar URLs
const avatarMap = new Map<string, PublicUser | undefined>();

export function useAvatar(email: string, options: { enabled?: boolean } = {enabled: true}) {
    const [needPublicUserData, setNeedPublicUserData] = useState(false && options.enabled);
    const {data: contacts = [], isLoading: contactsLoading} = useContacts();

    // Only fetch public user data if we couldn't find an avatar in contacts
    const {data: publicUserData, isLoading: publicUserLoading} = usePublicUser(email, {
        enabled: needPublicUserData
    });

    // Check contacts for avatar when contacts data changes
    useEffect(() => {
        if (contactsLoading || !email) return;

        // If we already have the avatar in cache, no need to check
        if (avatarMap.has(email)) return;

        // Check if there's a contact with this email and an avatar
        const contact = contacts.find((contact: Contact) =>
            contact.avatar &&
            (contact.email || []).includes(email)
        );

        if (contact?.avatar) {
            // Found in contacts, store in cache
            avatarMap.set(email, {
                name: contact.firstName + ' ' + contact.lastName,
                email: email,
                avatar: contact.avatar
            });
        } else {
            // Not found in contacts, need to check public user data
            setNeedPublicUserData(true);
        }
    }, [contacts, email, contactsLoading]);

    /**
     * Get avatar URL for an email address
     * @returns The avatar URL if found, undefined otherwise
     */
    const getAvatar = (): PublicUser | undefined => {
        if (!(email || '').trim()) return undefined;

        // First check the cache
        if (avatarMap.has(email)) {
            return avatarMap.get(email);
        }

        // Then check contacts directly (as a fallback)
        const contact = contacts.find((contact: Contact) =>
            contact.avatar &&
            (contact.email || []).includes(email)
        );

        if (contact?.avatar) {
            avatarMap.set(email, {
                name: contact.firstName + ' ' + contact.lastName,
                email: email,
                avatar: contact.avatar
            });
            return {
                name: contact.firstName + ' ' + contact.lastName,
                email: email,
                avatar: contact.avatar
            }
        }

        // Finally check public user data if available
        if (publicUserData?.avatar) {
            avatarMap.set(email, publicUserData);
            return publicUserData;
        }

        return undefined;
    };

    return {
        getAvatar,
        isLoading: contactsLoading || (needPublicUserData && publicUserLoading)
    };
}

export function invalidateAvatar(email: string) {
    avatarMap.delete(email);
}

export function invalidateAllAvatars() {
    avatarMap.clear();
}