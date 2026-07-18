import type { ContactSuggestion } from '@workspace/lib/types/contact';
import { cn } from '@workspace/ui/lib/utils';
import { useRef } from 'react';
import { useScrollToIndex } from '../../../hooks/use-scroll-to-index';
import { UserItem } from '../user-item';

type ContactSuggestListProps = {
    items: ContactSuggestion[];
    selectedIndex: number;
    onSelect: (suggestion: ContactSuggestion) => void;
    className?: string;
    // Inline drops the absolute-dropdown chrome (positioning, border, shadow, fixed height) and
    // renders a plain scrollable list — the new-chat wizard's in-dialog picker. Every other caller
    // (share dialog, contact autosuggest) keeps the absolute dropdown, pixel-unchanged.
    inline?: boolean;
};

export function ContactSuggestList({
    items,
    selectedIndex,
    onSelect,
    className = '',
    inline = false,
}: ContactSuggestListProps) {
    const listRef = useRef<HTMLUListElement>(null);
    useScrollToIndex(listRef, selectedIndex);

    if (items.length === 0) return null;

    return (
        <ul
            ref={listRef}
            className={cn(
                inline
                    ? 'overflow-y-auto'
                    : 'absolute z-10 bg-background border rounded-md shadow-lg overflow-y-auto max-h-48',
                className,
            )}
            tabIndex={-1}
        >
            {items.map((suggestion, index) => (
                <li
                    key={suggestion.id}
                    className={cn('px-3 py-2 eigen-list-item', index === selectedIndex && 'eigen-list-item-active')}
                    onMouseDown={(e) => {
                        e.preventDefault();
                        onSelect(suggestion);
                    }}
                >
                    <UserItem name={suggestion.displayName} email={suggestion.email} userId={suggestion.id} />
                </li>
            ))}
        </ul>
    );
}
