import {useMemo} from 'react';
import {ContactSuggestion} from './types';
import {useContacts} from '@workspace/lib/contacts';

/**
 * Hook to get contact suggestions based on input query
 */
export function useContactSuggestions(
    query: string,
    onlyEigenIsMails: boolean = false
) {
    const {data: contacts, isLoading, error} = useContacts();

    const lowerQuery = query.toLowerCase().split(',').pop()?.trim() || '';

    const suggestions = useMemo(() => {
        if (!lowerQuery || !contacts || lowerQuery.length < 2) return [];

        const results: ContactSuggestion[] = [];
        // const addedIds = new Set<string>();

        for(const contact of contacts) {
            // if (addedIds.has(contact.id)) return;

            const fullName = `${contact.firstName} ${contact.lastName}`.toLowerCase();
            const nameMatch = fullName.includes(lowerQuery);
            const emailMatch = contact.email.find(email => email.toLowerCase().includes(lowerQuery));

            if (nameMatch || emailMatch) {
                let bestEmail = emailMatch || contact.email[0] || '';

                const eigenIsMail = contact.email.find(email => email.endsWith('@eigen.is'));

                if (eigenIsMail && !emailMatch) {
                    bestEmail = eigenIsMail;
                }

                if (onlyEigenIsMails && !bestEmail.endsWith('@eigen.is')) {
                    continue;
                }

                if (query.includes(bestEmail)) {
                    continue;
                }

                results.push({
                    id: contact.id,
                    displayName: `${contact.firstName} ${contact.lastName}`,
                    email: bestEmail,
                    allEmails: contact.email
                });

                // addedIds.add(contact.id);
            }
        }

        return results;
    }, [contacts, lowerQuery, onlyEigenIsMails, query]);

    return {
        suggestions,
        isLoading,
        error
    };
}
