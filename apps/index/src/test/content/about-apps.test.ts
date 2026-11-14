import { describe, expect, test } from 'bun:test';
import { aboutApps } from '../../content/about-apps';
import { getSupportArticles } from '../../content/manifest';

describe('aboutApps', () => {
    test('are the ten apps without Space, in the registry order', () => {
        expect(aboutApps.map((app) => app.slug)).toEqual([
            'mail',
            'drive',
            'calendar',
            'docs',
            'sheets',
            'slides',
            'vector',
            'stickies',
            'chat',
            'contacts',
        ]);
    });

    test('every app with open formats names a help article that exists', () => {
        const slugs = new Set(getSupportArticles().map((article) => article.slug));
        const articles = aboutApps.flatMap((app) => (app.formats ? [app.formats.article] : []));
        expect(articles.length).toBe(8);
        expect(articles.filter((article) => !slugs.has(article))).toEqual([]);
    });
});
