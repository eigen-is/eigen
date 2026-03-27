import {useEffect, useMemo} from 'react';
import {useContactSuggestions} from "../contacts/use-contact-suggestions";
import {UserItem} from "../user-item";
import type {ContactSuggestion} from "../contacts/types";
import type {RoomMember} from "@workspace/lib/types/chat";

type ChatPlayerSuggestProps = {
    query: string;
    roomMembers: RoomMember[];
    onSelect: (email: string) => void;
    visible: boolean;
    selectedIndex: number;
    onItemsChange: (count: number, emails: string[]) => void;
    includeContacts?: boolean;
}

export function ChatPlayerSuggest({
                                      query,
                                      roomMembers,
                                      onSelect,
                                      visible,
                                      selectedIndex,
                                      onItemsChange,
                                      includeContacts = true,
                                  }: ChatPlayerSuggestProps) {
    const {suggestions: contactSuggestions} = useContactSuggestions(query, true);

    const items = useMemo(() => {
        if (!visible) return [];

        const q = query.toLowerCase();
        const memberSuggestions: ContactSuggestion[] = roomMembers
            .filter(m => {
                if (!q) return true;
                return m.email.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q);
            })
            .map(m => ({
                id: m.email,
                displayName: m.displayName,
                email: m.email,
                allEmails: [m.email],
            }));

        if (!includeContacts) {
            if (q && memberSuggestions.some(s => s.email.toLowerCase() === q)) return [];
            return memberSuggestions.slice(0, 6);
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
        if (q && merged.some(s => s.email.toLowerCase() === q)) return [];
        return merged.slice(0, 6);
    }, [visible, query, roomMembers, contactSuggestions, includeContacts]);

    const emails = useMemo(() => items.map(i => i.email), [items]);

    useEffect(() => {
        onItemsChange(items.length, emails);
    }, [items.length, emails, onItemsChange]);

    if (items.length === 0) return null;

    return (
        <ul className="absolute bottom-full left-0 right-0 z-10 bg-background border rounded-md shadow-lg overflow-y-auto max-h-48 mb-1">
            {items.map((suggestion, index) => (
                <li
                    key={suggestion.id}
                    className={`px-3 py-2 eigen-list-item ${index === selectedIndex ? 'eigen-list-item-active' : ''}`}
                    onMouseDown={(e) => {
                        e.preventDefault();
                        onSelect(suggestion.email);
                    }}
                >
                    <UserItem
                        name={suggestion.displayName}
                        email={suggestion.email}
                        userId={suggestion.id}
                    />
                </li>
            ))}
        </ul>
    );
}
