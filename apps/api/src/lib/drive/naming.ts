// Picks a free name beside existing ones by adding a number, such as `photo (2).jpg`, for a create that
// would collide with a sibling, such as an upload, a copy or a restore. Creates into one folder run at
// once, so the name a running create picked counts as taken until that create ends. The API is one
// process, which holds the data dir's instance lock, so this one map sees every create.

import type { Mount } from '../mount';
import { foldName, MAX_NAME_BYTES } from '../mount/names';

// The folder a create puts its item in, and how to read the names already in it. Both reads are
// synchronous, so no other create can land between a read and the reservation that follows it.
export type NameFolder = {
    ownerId: string;
    mountId: string;
    parentId: string;
    // Whether a live child has this name. It reads one row, so a create into a big folder stays quick.
    isTaken: (name: string) => boolean;
    // The name of every live child, read only when the wanted name is taken.
    childNames: () => readonly string[];
};

// A folder of a mount, read through the mount's synchronous lookups.
export function folderIn(mount: Mount, parentId: string): NameFolder {
    return {
        ownerId: mount.history.ownerId,
        mountId: mount.id,
        parentId,
        isTaken: (name) => mount.hasLiveChild(parentId, name),
        childNames: () => mount.liveChildNames(parentId),
    };
}

// The folded names of the creates still running, by folder. A finished create's row is in the folder,
// so its name no longer needs an entry here.
const namesInFlight = new Map<string, Set<string>>();

// Calls create with a name no sibling has and no other running create picked. Nothing waits: two creates
// of one name at once each get their own name, however many there are.
export async function withFreeName<T>(
    folder: NameFolder,
    desired: string,
    create: (name: string) => Promise<T>,
): Promise<T> {
    const key = `${folder.ownerId}/${folder.mountId}/${folder.parentId}`;
    const inFlight = namesInFlight.get(key) ?? new Set<string>();
    namesInFlight.set(key, inFlight);

    // No await from here to the add, so the pick and the reservation are one step.
    let name = desired;
    if (folder.isTaken(desired) || inFlight.has(foldName(desired))) {
        const used = new Set([...folder.childNames().map(foldName), ...inFlight]);
        name = getUniqueFileName(desired, used);
    }
    const folded = foldName(name);
    inFlight.add(folded);

    try {
        return await create(name);
    } finally {
        // Whatever the create left in the folder has its row there by now, so the folder read covers it.
        inFlight.delete(folded);
        if (inFlight.size === 0) namesInFlight.delete(key);
    }
}

// The used names come folded with foldName, the fold of a case-insensitive disk. So the name picked here
// is one the mount takes.
export function getUniqueFileName(name: string, usedNames: ReadonlySet<string>): string {
    // A leading dot starts a dotfile, not an extension, the same as in buildStorageKey.
    const dotIndex = name.lastIndexOf('.');
    const ext = dotIndex > 0 ? name.slice(dotIndex) : '';
    let base = dotIndex > 0 ? name.slice(0, dotIndex) : name;

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
