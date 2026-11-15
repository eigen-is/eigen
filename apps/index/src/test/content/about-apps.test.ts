import { describe, expect, test } from 'bun:test';
import { getSection } from '../../components/support/sections';
import { aboutApps, principles } from '../../content/about-apps';
import { getSupportArticles } from '../../content/manifest';

describe('aboutApps', () => {
    test('are the ten apps without Space, in the registry order, then Admin', () => {
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
            'admin',
        ]);
    });

    test('an app holds up to three of the landing principles, each once, and each names a help article', () => {
        const slugs = new Set(getSupportArticles().map((article) => article.slug));
        for (const app of aboutApps) {
            const named = app.principles.map((entry) => entry.principle);
            expect(named.length).toBeLessThanOrEqual(3);
            expect(new Set(named).size).toBe(named.length);
            expect(named.filter((principle) => !principles.includes(principle))).toEqual([]);
        }
        const articles = aboutApps.flatMap((app) => app.principles.map((entry) => entry.article));
        expect(articles.length).toBe(12);
        expect(articles.filter((article) => !slugs.has(article))).toEqual([]);
    });

    test('chat and stickies hold none', () => {
        const none = aboutApps.filter((app) => app.principles.length === 0).map((app) => app.slug);
        expect(none).toEqual(['stickies', 'chat']);
    });

    test("an app's slug names its help section, which its page links", () => {
        expect(aboutApps.filter((app) => !getSection(app.slug))).toEqual([]);
    });
});
