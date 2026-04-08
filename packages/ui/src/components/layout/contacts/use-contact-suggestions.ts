import { useContacts } from '@workspace/lib/contacts';
import { useMyTeams } from '@workspace/lib/home';
import { fetchPublicUser, usePublicConfig } from '@workspace/lib/public';
import type { PublicUser } from '@workspace/lib/types/public';
import { useEffect, useMemo, useState } from 'react';
import type { ContactSuggestion } from './types';

export function useContactSuggestions(query: string, onlyEigenIsMails: boolean = false) {
    const { data: contacts, isLoading: contactsLoading } = useContacts();
    const { data: myTeams } = useMyTeams();
    const { data: config } = usePublicConfig();
    const domain = config?.domain ?? 'eigen.is';

    // Collect all unique member IDs across teams
    const memberIds = useMemo(() => {
        if (!myTeams) return [];
        const ids = new Set<string>();
        for (const team of myTeams) {
            for (const id of team.members) {
                ids.add(id);
            }
        }
        return [...ids];
    }, [myTeams]);

    // Batch-resolve member IDs to PublicUser via the auto-batching fetcher
    const [resolvedMembers, setResolvedMembers] = useState<Map<string, PublicUser>>(new Map());

    useEffect(() => {
        if (memberIds.length === 0) return;

        let cancelled = false;
        Promise.all(memberIds.map(async (id) => [id, await fetchPublicUser(id)] as const)).then((results) => {
            if (cancelled) return;
            const map = new Map<string, PublicUser>();
            for (const [id, user] of results) {
                if (user) map.set(id, user);
            }
            setResolvedMembers(map);
        });
        return () => {
            cancelled = true;
        };
    }, [memberIds]);

    const lowerQuery = query.toLowerCase().split(',').pop()?.trim() || '';

    const suggestions = useMemo(() => {
        if (!lowerQuery || lowerQuery.length < 2) return [];

        const results: ContactSuggestion[] = [];
        const seenEmails = new Set<string>();

        // Team members first (higher priority)
        for (const [id, user] of resolvedMembers) {
            if (!user.email) continue;
            const email = user.email.toLowerCase();
            const name = (user.name || '').toLowerCase();

            if (!name.includes(lowerQuery) && !email.includes(lowerQuery)) continue;
            if (onlyEigenIsMails && !email.endsWith(`@${domain}`)) continue;
            if (query.includes(user.email)) continue;

            seenEmails.add(email);
            results.push({
                id,
                displayName: user.name || user.email,
                email: user.email,
                allEmails: [user.email],
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
    }, [contacts, resolvedMembers, lowerQuery, onlyEigenIsMails, query, domain]);

    return {
        suggestions,
        isLoading: contactsLoading,
    };
}
