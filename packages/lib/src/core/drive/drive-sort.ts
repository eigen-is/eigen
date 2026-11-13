// The order a Drive listing draws its rows in, such as a folder, Trash or the file picker: by name with
// folders first, by date or by size, ties broken by name. Names compare as users see them, without the
// Eigen extension, so "B Chat" comes before "B Chat Two", and the full name breaks a tie between a doc
// and a sheet that share one.

import type { DrivePath } from '@workspace/lib/types/drive';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import type { DriveSortDir, DriveSortKey } from '@workspace/lib/types/drive-view';

function byName(a: DrivePath, b: DrivePath): number {
    const options = { sensitivity: 'base' } as const;
    return (
        stripEigenExtension(a.name).localeCompare(stripEigenExtension(b.name), undefined, options) ||
        a.name.localeCompare(b.name, undefined, options)
    );
}

export function getDriveComparator(
    sortKey: DriveSortKey,
    sortDir: DriveSortDir,
    // The date the listing shows, such as the time an item was trashed.
    getModified: (p: DrivePath) => Date = (p) => p.updatedAt,
): (a: DrivePath, b: DrivePath) => number {
    const sign = sortDir === 'desc' ? -1 : 1;
    return (a, b) => {
        // Only a name sort groups folders first, so a date or size column reads strictly in order.
        if (sortKey === 'name') {
            if (a.type === 'folder' && b.type !== 'folder') return -1;
            if (a.type !== 'folder' && b.type === 'folder') return 1;
        }
        let field = 0;
        if (sortKey === 'name') field = byName(a, b);
        else if (sortKey === 'modified') field = getModified(a).getTime() - getModified(b).getTime();
        else field = a.size - b.size;
        if (field !== 0) return field * sign;
        return byName(a, b);
    };
}
