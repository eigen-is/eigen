export type MatchQuality = 'exact' | 'title-prefix' | 'all-tokens-in-title';

export function structuralMatchQuality(query: string, title: string): MatchQuality | null {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return null;
    const t = title.toLowerCase();

    if (q === t) return 'exact';
    if (t.startsWith(q)) return 'title-prefix';

    const tokens = q.split(/\s+/).filter((tok) => tok.length > 0);
    if (tokens.length > 0 && tokens.every((tok) => t.includes(tok))) {
        return 'all-tokens-in-title';
    }
    return null;
}

export function actionBoosts(query: string, action: { title: string; keywords?: string[] }): number {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return 0;

    const title = action.title.toLowerCase();
    if (title.startsWith(q)) return 100;
    if (title.includes(q)) return 40;
    if (action.keywords?.some((kw) => kw.toLowerCase().includes(q))) return 15;
    return 0;
}
