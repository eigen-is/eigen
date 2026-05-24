import { useContactSuggestions } from '@workspace/lib/contacts';
import type { RoomMember } from '@workspace/lib/types/chat';
import type { ContactSuggestion } from '@workspace/lib/types/contact';
import { useEffect, useMemo } from 'react';
import { ContactSuggestList } from '../contacts/contact-suggest-list';

type ChatPlayerSuggestProps = {
    query: string;
    roomMembers: RoomMember[];
    onSelect: (email: string) => void;
    visible: boolean;
    selectedIndex: number;
    onItemsChange: (count: number, emails: string[]) => void;
    includeContacts?: boolean;
};

export function ChatPlayerSuggest({
    query,
    roomMembers,
    onSelect,
    visible,
    selectedIndex,
    onItemsChange,
    includeContacts = true,
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
                // Chat room participants — not workspace team members. The discriminator
                // routes downstream consumers (e.g. the palette's contact provider) to the
                // personal-contact landing, not a team-scoped page that wouldn't exist.
                kind: 'personal',
                id: m.email,
                displayName: m.displayName,
                email: m.email,
            }));

        if (!includeContacts) {
            if (q && memberSuggestions.some((s) => s.email.toLowerCase() === q)) return [];
            return memberSuggestions;
        }

        const seen = new Set<string>();
        const merged: ContactSuggestion[] = [];
        for (const s of [...memberSuggestions, ...contactSuggestions]) {
            const key = s.email.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                merged.push(s);
            }
        }
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
