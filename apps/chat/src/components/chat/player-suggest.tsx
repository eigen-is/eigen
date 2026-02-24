import {useContactSuggestions} from "@workspace/ui/components/layout/contacts/use-contact-suggestions";
import {UserItem} from "@workspace/ui/components/layout/user-item";
import type {ContactSuggestion} from "@workspace/ui/components/layout/contacts/types";

export type RoomMember = {
    email: string;
    displayName: string;
}

type PlayerSuggestProps = {
    query: string;
    roomMembers: RoomMember[];
    onSelect: (email: string) => void;
    visible: boolean;
}

export function PlayerSuggest({query, roomMembers, onSelect, visible}: PlayerSuggestProps) {
    const {suggestions: contactSuggestions} = useContactSuggestions(query, true);

    if (!visible || !query) return null;

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

    if (merged.length === 0) return null;

    return (
        <ul className="absolute bottom-full left-0 right-0 z-10 bg-background border rounded-md shadow-lg overflow-y-auto max-h-48 mb-1">
            {merged.slice(0, 6).map((suggestion, index) => (
                <li
                    key={suggestion.id}
                    className="px-3 py-2 eigen-list-item cursor-pointer hover:bg-accent"
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
