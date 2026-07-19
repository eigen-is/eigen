import { useMyTeams } from '@workspace/lib/home';
import { usePublicConfig } from '@workspace/lib/public';
import type { ContactSuggestion } from '@workspace/lib/types/contact';
import { useMemo } from 'react';
import { useContacts } from './use-contacts';

type TeamMember = { email: string; name: string; teamId: string };

// Single source for "match a typed string against personal contacts + team members
// the user can reach." Consumed by ContactAutosuggest (mail/calendar/drive-share),
// ChatPlayerSuggest, and the command palette providers. Team members are merged in
// first (higher priority), personal contacts second; dedup is by lowercased email.
export function useContactSuggestions(
    query: string,
    onlyInternalMails: boolean = false,
    excludeEmails: string[] = [],
): { suggestions: ContactSuggestion[]; isLoading: boolean } {
    const { data: contacts, isLoading: contactsLoading } = useContacts();
    const { data: myTeams } = useMyTeams();
    const { data: config } = usePublicConfig();
    // 'Internal' suggestions are scoped by the mail domain — same suffix the user's address has.
    const domain = config?.mailDomain;

    // Walk every team-member exactly once, deduped by lowercased email. The first
    // team a member is found in wins their teamId — sufficient for palette nav, which
    // just needs one valid team/<teamId>?contactId=<email> URL.
    const teamMembers = useMemo(() => {
        if (!myTeams) return new Map<string, TeamMember>();
        const members = new Map<string, TeamMember>();
        for (const team of myTeams) {
            for (const member of team.members) {
                const key = member.email.toLowerCase();
                if (members.has(key)) continue;
                members.set(key, { email: member.email, name: member.name, teamId: team.id });
            }
        }
        return members;
    }, [myTeams]);

    const lowerQuery = query.toLowerCase().split(',').pop()?.trim() || '';
    const excludeSet = useMemo(() => new Set(excludeEmails.map((e) => e.toLowerCase())), [excludeEmails]);

    const suggestions = useMemo(() => {
        if (!lowerQuery || lowerQuery.length < 2) return [];

        const results: ContactSuggestion[] = [];
        const seenEmails = new Set<string>();

        // Team members first (higher priority) — filter by name or email
        for (const [emailKey, member] of teamMembers) {
            if (excludeSet.has(emailKey)) continue;
            const name = (member.name || '').toLowerCase();
            if (!name.includes(lowerQuery) && !emailKey.includes(lowerQuery)) continue;
            if (onlyInternalMails && !emailKey.endsWith(`@${domain}`)) continue;
            if (query.includes(member.email)) continue;

            seenEmails.add(emailKey);
            results.push({
                kind: 'team',
                id: member.email,
                displayName: member.name || member.email,
                email: member.email,
                teamId: member.teamId,
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
                if (onlyInternalMails && !bestEmail.endsWith(`@${domain}`)) continue;
                if (excludeSet.has(bestEmail.toLowerCase())) continue;
                if (query.includes(bestEmail)) continue;
                if (seenEmails.has(bestEmail.toLowerCase())) continue;

                seenEmails.add(bestEmail.toLowerCase());
                results.push({
                    kind: 'personal',
                    id: contact.id,
                    displayName: `${contact.firstName} ${contact.lastName}`,
                    email: bestEmail,
                });
            }
        }

        return results;
    }, [contacts, teamMembers, lowerQuery, onlyInternalMails, excludeSet, query, domain]);

    return {
        suggestions,
        isLoading: contactsLoading,
    };
}
