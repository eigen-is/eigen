// Reapply the matched text's case pattern to the replacement:
// all-lower → lower, ALL-UPPER → UPPER, Capitalised → Capitalised, else as-typed.
export function applyPreserveCase(matched: string, replacement: string): string {
    if (matched === matched.toLowerCase()) return replacement.toLowerCase();
    if (matched === matched.toUpperCase()) return replacement.toUpperCase();
    if (matched[0] === matched[0]?.toUpperCase() && matched.slice(1) === matched.slice(1).toLowerCase()) {
        return replacement.charAt(0).toUpperCase() + replacement.slice(1).toLowerCase();
    }
    return replacement;
}
