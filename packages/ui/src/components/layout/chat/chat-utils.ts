export function getAtSuggestQuery(text: string): string | null {
    const atIdx = text.lastIndexOf('@');
    if (atIdx === -1) return null;
    if (atIdx > 0) {
        const charBefore = text[atIdx - 1];
        if (!/[\s,.]/.test(charBefore)) return null;
    }
    const after = text.slice(atIdx + 1);
    if (after.includes(' ')) return null;
    return after;
}
