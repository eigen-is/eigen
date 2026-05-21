import { useEffect, useState } from 'react';
import { type ArticleBody, type ArticleCollection, fetchArticleBody, getInlinedBody } from './manifest';

// Resolve an article body for a route component. The body of the page the visitor
// landed on is inlined by the prerender and resolves synchronously, so the server
// render and the first client render agree. Navigating to a different article
// lazy-loads its chunk; the hook returns undefined while that chunk is in flight.
export function useArticleBody(collection: ArticleCollection, slug: string): ArticleBody | undefined {
    const inlined = getInlinedBody(collection, slug);
    const [fetched, setFetched] = useState<{ key: string; body: ArticleBody | undefined }>();

    useEffect(() => {
        if (getInlinedBody(collection, slug)) return;
        const key = `${collection}/${slug}`;
        let active = true;
        fetchArticleBody(collection, slug)?.then((body) => {
            if (active) setFetched({ key, body });
        });
        return () => {
            active = false;
        };
    }, [collection, slug]);

    if (inlined) return inlined;
    return fetched?.key === `${collection}/${slug}` ? fetched.body : undefined;
}
