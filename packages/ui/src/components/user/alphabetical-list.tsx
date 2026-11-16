// Person rows under letter headers, the way PersonList draws contacts and team members. The rows arrive sorted with
// each letter's people together and are drawn in that order, so a row's index is the one the keyboard cursor counts.

import { cn } from '@workspace/ui/lib/utils';
import type { ReactNode } from 'react';
import { Fragment } from 'react';
import { USER_ITEM_AVATAR_SIZE } from './user-item';

// Group initial for person lists: diacritics fold (É → E), anything non-A–Z buckets under '#'.
export function alphaGroupKey(label: string): string {
    const first = label.normalize('NFD').charAt(0).toUpperCase();
    return /[A-Z]/.test(first) ? first : '#';
}

type AlphabeticalListProps<T> = {
    items: readonly T[];
    getKey: (item: T) => string;
    getGroupKey: (item: T) => string;
    renderItem: (item: T, flatIndex: number) => ReactNode;
};

export function AlphabeticalList<T>({ items, getKey, getGroupKey, renderItem }: AlphabeticalListProps<T>) {
    let flatIndex = 0;
    return (
        <>
            {[...Map.groupBy(items, getGroupKey)].map(([letter, group]) => (
                <div key={letter} className="border-b last:border-b-0">
                    <div className="flex items-center app-gutter-x py-2 bg-muted/50">
                        <h2 className={cn(USER_ITEM_AVATAR_SIZE, 'h-auto text-center text-sm font-medium')}>
                            {letter}
                        </h2>
                    </div>
                    <div>
                        {group.map((item) => {
                            const idx = flatIndex++;
                            return <Fragment key={getKey(item)}>{renderItem(item, idx)}</Fragment>;
                        })}
                    </div>
                </div>
            ))}
        </>
    );
}
