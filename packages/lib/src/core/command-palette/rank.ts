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

export function actionBoosts(
    query: string,
    action: { title: string; keywords?: string[]; currentAppMatch?: boolean },
): number {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return 0;

    const title = action.title.toLowerCase();
    let boost = 0;

    if (title.startsWith(q)) boost += 100;
    else if (title.includes(q)) boost += 40;
    else if (action.keywords?.some((kw) => kw.toLowerCase().includes(q))) boost += 15;

    if (action.currentAppMatch) boost += 10;

    return boost;
}
