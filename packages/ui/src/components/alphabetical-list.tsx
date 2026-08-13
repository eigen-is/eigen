import { Fragment, type ReactNode } from 'react';

// Group initial for person lists: diacritics fold (É → E), anything non-A–Z buckets under '#'.
export function alphaGroupKey(label: string): string {
    const first = label.normalize('NFD').charAt(0).toUpperCase();
    return /[A-Z]/.test(first) ? first : '#';
}

type AlphabeticalListProps<T> = {
    items: T[];
    getKey: (item: T) => string;
    getGroupKey: (item: T) => string;
    renderItem: (item: T, flatIndex: number) => ReactNode;
};

export function AlphabeticalList<T>({ items, getKey, getGroupKey, renderItem }: AlphabeticalListProps<T>) {
    const groups: Record<string, T[]> = {};
    for (const item of items) {
        const k = getGroupKey(item);
        if (!groups[k]) groups[k] = [];
        groups[k].push(item);
    }
    const sortedGroups = Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0]));

    let flatIndex = 0;
    return (
        <>
            {sortedGroups.map(([letter, group]) => (
                <div key={letter} className="border-b last:border-b-0">
                    <div className="flex items-center px-6 py-2 bg-muted/50">
                        <h2 className="text-sm font-medium">{letter}</h2>
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
