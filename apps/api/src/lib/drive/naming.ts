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
        const candidate = `${base} (${counter})${ext}`;
        if (!usedNames.has(candidate.toLowerCase())) {
            return candidate;
        }
    } while (counter < 10000);

    return `${base} (${Date.now()})${ext}`;
}
