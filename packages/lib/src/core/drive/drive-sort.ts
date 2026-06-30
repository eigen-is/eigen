import type { DrivePath, DriveSortDir, DriveSortKey } from '@workspace/lib/types/drive';

function byName(a: DrivePath, b: DrivePath): number {
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

export function getDriveComparator(
    sortKey: DriveSortKey,
    sortDir: DriveSortDir,
): (a: DrivePath, b: DrivePath) => number {
    const sign = sortDir === 'desc' ? -1 : 1;
    return (a, b) => {
        if (a.type === 'folder' && b.type !== 'folder') return -1;
        if (a.type !== 'folder' && b.type === 'folder') return 1;
        let field = 0;
        if (sortKey === 'name') field = byName(a, b);
        else if (sortKey === 'modified') field = a.updatedAt.getTime() - b.updatedAt.getTime();
        else field = a.size - b.size;
        if (field !== 0) return field * sign;
        return byName(a, b);
    };
}

export const defaultDriveSort = getDriveComparator('name', 'asc');
