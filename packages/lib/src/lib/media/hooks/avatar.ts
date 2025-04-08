import { invalidateAllContacts, useContacts } from '../../contacts/hooks/use-contacts';
import { useMemo } from 'react';
import { Contact } from '@apps/api-server/types/contact';
import { usePublicUser } from '../../public';
import { type PublicUser } from '@apps/api-server/types/public';

export function useAvatar(email: string, options: { enabled?: boolean } = { enabled: true }): {data: PublicUser | undefined, isLoading: boolean} {
  const { data: contacts = [], isLoading: contactsLoading } = useContacts();
  
  // Find the contact matching this email
  const matchingContact = useMemo(() => {
    if (!email || !options.enabled) return null;
    
    return contacts.find((contact: Contact) => 
      (contact.email || []).includes(email)
    );
  }, [contacts, email, options.enabled]);
  
  // Only fetch public user data if:
  // 1. No matching contact found OR the contact doesn't have an avatar
  // 2. The email is an eigen.is email
  const shouldFetchPublicUser = useMemo(() => {
    if (!email || !options.enabled) return false;
    if (matchingContact?.avatar) return false; // Already have avatar from contact
    return email.toLowerCase().endsWith('@eigen.is');
  }, [email, matchingContact, options.enabled]);
  
  // Only fetch public data when needed
  const { data: publicUserData, isLoading: publicUserLoading } = usePublicUser(email, {
    enabled: shouldFetchPublicUser
  });
  
  // Return combined data and loading state
  const avatarData = useMemo(() => {
    if (!email || !options.enabled) return undefined;
    
    // Case 1: We found a contact with an avatar
    if (matchingContact?.avatar) {
      return {
        name: `${matchingContact.firstName} ${matchingContact.lastName}`.trim(),
        email,
        avatar: matchingContact.avatar
      };
    }
    
    // Case 2: We found a contact but no avatar, and we have public user data
    if (matchingContact && publicUserData?.avatar) {
      return {
        name: `${matchingContact.firstName} ${matchingContact.lastName}`.trim(),
        email,
        avatar: publicUserData.avatar
      };
    }
    
    // Case 3: No contact, but we have public user data
    if (publicUserData) {
      return publicUserData;
    }
    
    // Case 4: No data found, return basic info
    if (matchingContact) {
      return {
        name: `${matchingContact.firstName} ${matchingContact.lastName}`.trim(),
        email,
        avatar: undefined
      };
    }
    
    return undefined;
  }, [email, matchingContact, publicUserData, options.enabled]);
  
  return {
    data: avatarData,
    isLoading: contactsLoading || (shouldFetchPublicUser && publicUserLoading)
  };
}

export function invalidateAllAvatars() {
    invalidateAllContacts();
}