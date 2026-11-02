// Picks a free name beside existing ones by adding a number, such as `photo (2).jpg`, for an upload, a
// copy or a restore that would collide with a sibling. Creates into one folder run at once, so a name that
// a running create picked counts as taken until that create ends. The API is one process, which holds the
// data dir's instance lock, so this one map sees every create.

import { foldName, MAX_NAME_BYTES } from '../mount/names';

// The folder a create puts its item in, and how to read the names already in it.
export type NameFolder = {
    ownerId: string;
    mountId: string;
    parentId: string;
    // Whether a live child has this name. It reads one row, so a create into a big folder stays quick.
    isTaken: (name: string) => Promise<boolean>;
    // The name of every live child, read only when the wanted name is taken.
    childNames: () => Promise<readonly string[]>;
};

// The folded names that creates picked, by folder. An entry lives while any create in its folder runs, and
// a name a create took stays in it after that create ends. Another create may have read the folder before
// that name's row landed, and it still has to see the name.
const busyFolders = new Map<string, { creates: number; names: Set<string> }>();

// Calls create with a name no sibling has and no other running create picked. Nothing waits: two creates
// of one name at once each get their own name, however many there are.
export async function withFreeName<T>(
    folder: NameFolder,
    desired: string,
    create: (name: string) => Promise<T>,
): Promise<T> {
    const key = `${folder.ownerId}/${folder.mountId}/${folder.parentId}`;
    const busy = busyFolders.get(key) ?? { creates: 0, names: new Set<string>() };
    busyFolders.set(key, busy);
    busy.creates++;
    try {
        // The picked names are checked after the folder is read. No await sits between that check and
        // the add below, so no other create can pick the same name in between.
        let name = desired;
        if ((await folder.isTaken(desired)) || busy.names.has(foldName(desired))) {
            const used = new Set((await folder.childNames()).map(foldName));
            for (const picked of busy.names) used.add(picked);
            name = getUniqueFileName(desired, used);
        }
        const folded = foldName(name);
        busy.names.add(folded);
        try {
            return await create(name);
        } catch (e) {
            // A failed create leaves no live item behind, so its name is free again.
            busy.names.delete(folded);
            throw e;
        }
    } finally {
        busy.creates--;
        if (busy.creates === 0) busyFolders.delete(key);
    }
}

// The used names come folded with foldName, the fold of a case-insensitive disk. So the name picked here
// is one the mount takes.
export function getUniqueFileName(name: string, usedNames: ReadonlySet<string>): string {
    // A leading dot starts a dotfile, not an extension, the same as in buildStorageKey.
    const dotIdx = name.lastIndexOf('.');
    const ext = dotIdx > 0 ? name.slice(dotIdx) : '';
    let base = dotIdx > 0 ? name.slice(0, dotIdx) : name;

    const suffixMatch = base.match(/ \((\d+)\)$/);
    let counter = suffixMatch ? parseInt(suffixMatch[1], 10) : 1;
    if (suffixMatch) {
        base = base.slice(0, -suffixMatch[0].length);
    }

    do {
        counter++;
        const candidate = fitName(base, ` (${counter})${ext}`);
        if (!usedNames.has(foldName(candidate))) {
            return candidate;
        }
    } while (counter < 10000);

    return fitName(base, ` (${Date.now()})${ext}`);
}

// Trims the stem so the suffixed name still passes validateName: a name already at the byte limit
// would otherwise dedup to one the mount refuses. Whole code points, so a trim never splits a pair.
function fitName(base: string, suffix: string): string {
    const stem = Array.from(base);
    while (stem.length > 0 && Buffer.byteLength(stem.join('') + suffix, 'utf8') > MAX_NAME_BYTES) stem.pop();
    return `${stem.join('')}${suffix}`;
}
