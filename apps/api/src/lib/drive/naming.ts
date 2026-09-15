import { MAX_NAME_BYTES } from '../mount/helpers';

export function getUniqueFileName(name: string, usedNames: Set<string>): string {
    // A leading dot is a dotfile, not an extension (matches buildStorageKey / the v7 dedup split).
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
        if (!usedNames.has(candidate.toLowerCase())) {
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
