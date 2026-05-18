import { Fragment, type ReactNode, useMemo } from 'react';

type AlphabeticalListProps<T> = {
    items: T[];
    getKey: (item: T) => string;
    getGroupKey: (item: T) => string;
    renderItem: (item: T, flatIndex: number) => ReactNode;
};

export function AlphabeticalList<T>({ items, getKey, getGroupKey, renderItem }: AlphabeticalListProps<T>) {
    const groups = useMemo(() => {
        const dict: Record<string, T[]> = {};
        for (const item of items) {
            const k = getGroupKey(item);
            if (!dict[k]) dict[k] = [];
            dict[k].push(item);
        }
        return Object.entries(dict).sort((a, b) => a[0].localeCompare(b[0]));
    }, [items, getGroupKey]);

    let flatIndex = 0;
    return (
        <>
            {groups.map(([letter, group]) => (
                <div key={letter} className="border-b last:border-b-0">
                    <div className="flex items-center px-6 py-2 bg-muted/50">
                        <h2 className="text-sm font-semibold">{letter}</h2>
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
