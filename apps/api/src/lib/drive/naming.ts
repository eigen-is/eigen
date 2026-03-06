export function getUniqueFileName(name: string, usedNames: Set<string>): string {
    const dotIdx = name.lastIndexOf('.');
    const ext = dotIdx !== -1 ? name.slice(dotIdx) : '';
    let base = dotIdx !== -1 ? name.slice(0, dotIdx) : name;

    const hashMatch = base.match(/#(\d+)$/);
    let counter = hashMatch ? parseInt(hashMatch[1], 10) : 0;
    if (hashMatch) {
        base = base.slice(0, -hashMatch[0].length);
    }

    do {
        counter++;
        const candidate = `${base}#${counter}${ext}`;
        if (!usedNames.has(candidate.toLowerCase())) {
            return candidate;
        }
    } while (counter < 10000);

    return `${base}#${Date.now()}${ext}`;
}
