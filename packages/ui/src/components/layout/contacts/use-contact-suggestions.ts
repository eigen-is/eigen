import { useContacts } from '@workspace/lib/contacts';
import { useMyTeams } from '@workspace/lib/home';
import { usePublicConfig } from '@workspace/lib/public';
import { useMemo } from 'react';
import type { ContactSuggestion } from './types';

export function useContactSuggestions(query: string, onlyEigenIsMails: boolean = false) {
    const { data: contacts, isLoading: contactsLoading } = useContacts();
    const { data: myTeams } = useMyTeams();
    const { data: config } = usePublicConfig();
    const domain = config?.domain ?? 'eigen.is';

    // Collect all unique team members across teams, deduped by email
    const teamMembers = useMemo(() => {
        if (!myTeams) return new Map<string, { email: string; name: string }>();
        const members = new Map<string, { email: string; name: string }>();
        for (const team of myTeams) {
            for (const member of team.members) {
                members.set(member.email.toLowerCase(), member);
            }
        }
        return members;
    }, [myTeams]);

    const lowerQuery = query.toLowerCase().split(',').pop()?.trim() || '';

    const suggestions = useMemo(() => {
        if (!lowerQuery || lowerQuery.length < 2) return [];

        const results: ContactSuggestion[] = [];
        const seenEmails = new Set<string>();

        // Team members first (higher priority) — filter by name or email
        for (const [emailKey, member] of teamMembers) {
            const name = (member.name || '').toLowerCase();
            if (!name.includes(lowerQuery) && !emailKey.includes(lowerQuery)) continue;
            if (onlyEigenIsMails && !emailKey.endsWith(`@${domain}`)) continue;
            if (query.includes(member.email)) continue;

            seenEmails.add(emailKey);
            results.push({
                id: member.email,
                displayName: member.name || member.email,
                email: member.email,
                allEmails: [member.email],
            });
        }

        // Personal contacts (skip duplicates by email)
        if (contacts) {
            for (const contact of contacts) {
                const fullName = `${contact.firstName} ${contact.lastName}`.toLowerCase();
                const nameMatch = fullName.includes(lowerQuery);
                const emailMatch = contact.email.find((e) => e.toLowerCase().includes(lowerQuery));

                if (!nameMatch && !emailMatch) continue;

                let bestEmail = emailMatch || contact.email[0] || '';
                const eigenIsMail = contact.email.find((e) => e.endsWith(`@${domain}`));
                if (eigenIsMail && !emailMatch) bestEmail = eigenIsMail;
                if (onlyEigenIsMails && !bestEmail.endsWith(`@${domain}`)) continue;
                if (query.includes(bestEmail)) continue;
                if (seenEmails.has(bestEmail.toLowerCase())) continue;

                seenEmails.add(bestEmail.toLowerCase());
                results.push({
                    id: contact.id,
                    displayName: `${contact.firstName} ${contact.lastName}`,
                    email: bestEmail,
                    allEmails: contact.email,
                });
            }
        }

        return results;
    }, [contacts, teamMembers, lowerQuery, onlyEigenIsMails, query, domain]);

    return {
        suggestions,
        isLoading: contactsLoading,
    };
}
