import { describe, expect, test } from 'bun:test';
import type { ArticleMeta } from '../../../../scripts/lib/content-types';
import { resolveRelated } from '../../../../scripts/lib/related';

function meta(slug: string, section: string, tags: string[], related: string[] = []): ArticleMeta {
    return { slug, section, title: slug, description: '', tags, order: 100, toc: [], related, crossSections: [] };
}

describe('resolveRelated', () => {
    test('keeps explicit related slugs that exist', () => {
        const a = meta('drive/share', 'drive', [], ['drive/stop-sharing']);
        const all = [a, meta('drive/stop-sharing', 'drive', [])];
        expect(resolveRelated(a, all)).toEqual(['drive/stop-sharing']);
    });

    test('drops explicit related slugs that do not exist', () => {
        const a = meta('drive/share', 'drive', [], ['drive/ghost']);
        expect(resolveRelated(a, [a])).toEqual([]);
    });

    test('falls back to shared tags within the same section, ranked by overlap', () => {
        const a = meta('drive/share', 'drive', ['sharing', 'links']);
        const b = meta('drive/links', 'drive', ['sharing', 'links']);
        const c = meta('drive/upload', 'drive', ['sharing']);
        const d = meta('mail/share', 'mail', ['sharing', 'links']);
        const result = resolveRelated(a, [a, b, c, d]);
        expect(result).toEqual(['drive/links', 'drive/upload']);
    });

    test('returns at most 4 related articles', () => {
        const a = meta('drive/a', 'drive', ['t']);
        const others = ['b', 'c', 'd', 'e', 'f'].map((s) => meta(`drive/${s}`, 'drive', ['t']));
        expect(resolveRelated(a, [a, ...others]).length).toBe(4);
    });
});
