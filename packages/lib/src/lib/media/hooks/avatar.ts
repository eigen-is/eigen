import { useContacts } from '../../contacts/hooks/use-contacts';
import { useQuery } from '@tanstack/react-query';
import { spaceApi } from '@workspace/lib/api';
import { useState, useEffect } from 'react';
import { Contact } from '@apps/api-server/types/contact';

// In-memory cache for avatar URLs
const avatarMap = new Map<string, string | undefined>();

// Query keys for public user data
const publicUserKeys = {
    all: ['publicUser'] as const,
    details: () => [...publicUserKeys.all, 'detail'] as const,
    detail: (id: string) => [...publicUserKeys.details(), id] as const,
};

// Hook to fetch public user data
export function usePublicUser(email: string | undefined, options: { enabled: boolean } = { enabled: true }) {
    return useQuery({
        queryKey: publicUserKeys.detail(email || ''),
        queryFn: async () => {
            if (!email) return null;
            // Check if email is @eigen.is email
            if (!email.endsWith('@eigen.is')) return null;

            const res = await spaceApi.public[email].get();
            return res.data;
        },
        enabled: !!email && options.enabled,
        staleTime: 5 * 60 * 1000, // Consider data fresh for 5 minutes
    });
}

export function useAvatarUrl(email: string, options: { enabled?: boolean } = { enabled: true }) {
  const [needPublicUserData, setNeedPublicUserData] = useState(false && options.enabled);
  const { data: contacts = [], isLoading: contactsLoading } = useContacts();
  
  // Only fetch public user data if we couldn't find an avatar in contacts
  const { data: publicUserData, isLoading: publicUserLoading } = usePublicUser(email, {
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
      avatarMap.set(email, contact.avatar);
    } else {
      // Not found in contacts, need to check public user data
      setNeedPublicUserData(true);
    }
  }, [contacts, email, contactsLoading]);

  /**
   * Get avatar URL for an email address
   * @returns The avatar URL if found, undefined otherwise
   */
  const getAvatarUrl = (): string | undefined => {    
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
      avatarMap.set(email, contact.avatar);
      return contact.avatar;
    }
    
    // Finally check public user data if available
    if (publicUserData?.image) {
      avatarMap.set(email, publicUserData.image);
      return publicUserData.image;
    }
    
    return undefined;
  };

  return {
    getAvatarUrl,
    isLoading: contactsLoading || (needPublicUserData && publicUserLoading)
  };
}
