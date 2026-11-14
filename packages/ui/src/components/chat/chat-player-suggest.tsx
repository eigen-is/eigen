// The people list under a chat composer: the room's members that match what follows an @, or the target a slash
// command such as /invite asks for, which may also come from the user's contacts. The composer shows it and moves
// its selection, and the list reports what it shows so a key press can pick an entry.

import { useContactSuggestions } from '@workspace/lib/contacts';
import type { RoomMember } from '@workspace/lib/types/chat';
import type { ContactSuggestion } from '@workspace/lib/types/contact';
import { useEffect, useMemo } from 'react';
import { ContactSuggestList } from '../contacts/contact-suggest-list';

type ChatPlayerSuggestProps = {
    query: string;
    roomMembers: readonly RoomMember[];
    onSelect: (email: string) => void;
    visible: boolean;
    selectedIndex: number;
    onItemsChange: (count: number, emails: string[]) => void;
    includeContacts: boolean;
};

export function ChatPlayerSuggest({
    query,
    roomMembers,
    onSelect,
    visible,
    selectedIndex,
    onItemsChange,
    includeContacts,
}: ChatPlayerSuggestProps) {
    const { suggestions: contactSuggestions } = useContactSuggestions(query, true);

    const items = useMemo(() => {
        if (!visible) return [];

        const q = query.toLowerCase();
        const memberSuggestions: ContactSuggestion[] = roomMembers
            .filter((m) => {
                if (!q) return true;
                return m.email.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q);
            })
            .map((m) => ({
                // A room member is no team member, so it opens as a personal contact, not on a team's page.
                kind: 'personal',
                id: m.email,
                displayName: m.displayName,
                email: m.email,
            }));

        const seen = new Set<string>();
        const merged: ContactSuggestion[] = [];
        for (const s of includeContacts ? [...memberSuggestions, ...contactSuggestions] : memberSuggestions) {
            const key = s.email.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                merged.push(s);
            }
        }
        // A query that is already a whole address needs no list.
        if (q && merged.some((s) => s.email.toLowerCase() === q)) return [];
        return merged;
    }, [visible, query, roomMembers, contactSuggestions, includeContacts]);

    const emails = useMemo(() => items.map((i) => i.email), [items]);

    useEffect(() => {
        onItemsChange(items.length, emails);
    }, [items.length, emails, onItemsChange]);

    return (
        <ContactSuggestList
            items={items}
            selectedIndex={selectedIndex}
            onSelect={(suggestion) => onSelect(suggestion.email)}
            className="bottom-full left-0 right-0 mb-1"
        />
    );
}
