export function getTaskStats(html: string): { total: number; checked: number } {
    if (!html) return { total: 0, checked: 0 };
    const total = (html.match(/<li[^>]*\bdata-checked=/g) ?? []).length;
    const checked = (html.match(/<li[^>]*\bdata-checked="true"/g) ?? []).length;
    return { total, checked };
}
