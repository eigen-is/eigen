import {useEffect, useMemo} from 'react';
import {useContactSuggestions} from "../contacts/use-contact-suggestions";
import {UserItem} from "../user-item";
import type {ContactSuggestion} from "../contacts/types";
import type {RoomMember} from "./chat-utils";

type ChatPlayerSuggestProps = {
    query: string;
    roomMembers: RoomMember[];
    onSelect: (email: string) => void;
    visible: boolean;
    selectedIndex: number;
    onItemsChange: (count: number, emails: string[]) => void;
}

export function ChatPlayerSuggest({
                                      query,
                                      roomMembers,
                                      onSelect,
                                      visible,
                                      selectedIndex,
                                      onItemsChange
                                  }: ChatPlayerSuggestProps) {
    const {suggestions: contactSuggestions} = useContactSuggestions(query, true);

    const items = useMemo(() => {
        if (!visible || !query) return [];

        const memberSuggestions: ContactSuggestion[] = roomMembers
            .filter(m => {
                const q = query.toLowerCase();
                return m.email.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q);
            })
            .map(m => ({
                id: m.email,
                displayName: m.displayName,
                email: m.email,
                allEmails: [m.email],
            }));

        const seen = new Set<string>();
        const merged: ContactSuggestion[] = [];
        for (const s of [...memberSuggestions, ...contactSuggestions]) {
            const key = s.email.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                merged.push(s);
            }
        }
        return merged.slice(0, 6);
    }, [visible, query, roomMembers, contactSuggestions]);

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
                    className={`px-3 py-2 eigen-list-item cursor-pointer ${index === selectedIndex ? 'eigen-list-item-active bg-accent' : 'hover:bg-accent'}`}
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
