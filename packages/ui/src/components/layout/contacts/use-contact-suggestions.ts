import {useMemo} from 'react';
import {ContactSuggestion} from './types';
import {useContacts} from '@workspace/lib/contacts';
import {usePublicConfig} from '@workspace/lib/public';

export function useContactSuggestions(
    query: string,
    onlyEigenIsMails: boolean = false
) {
    const {data: contacts, isLoading, error} = useContacts();
    const {data: config} = usePublicConfig();
    const domain = config?.domain ?? 'eigen.is';

    const lowerQuery = query.toLowerCase().split(',').pop()?.trim() || '';

    const suggestions = useMemo(() => {
        if (!lowerQuery || !contacts || lowerQuery.length < 2) return [];

        const results: ContactSuggestion[] = [];

        for (const contact of contacts) {

            const fullName = `${contact.firstName} ${contact.lastName}`.toLowerCase();
            const nameMatch = fullName.includes(lowerQuery);
            const emailMatch = contact.email.find(email => email.toLowerCase().includes(lowerQuery));

            if (nameMatch || emailMatch) {
                let bestEmail = emailMatch || contact.email[0] || '';

                const eigenIsMail = contact.email.find(email => email.endsWith(`@${domain}`));

                if (eigenIsMail && !emailMatch) {
                    bestEmail = eigenIsMail;
                }

                if (onlyEigenIsMails && !bestEmail.endsWith(`@${domain}`)) {
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
            }
        }

        return results;
    }, [contacts, lowerQuery, onlyEigenIsMails, query, domain]);

    return {
        suggestions,
        isLoading,
        error
    };
}
