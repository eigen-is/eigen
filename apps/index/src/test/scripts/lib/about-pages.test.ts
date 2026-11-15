import { describe, expect, test } from 'bun:test';
import { aboutPageSlug, checkAboutRows, checkPrincipleArticles } from '../../../../scripts/lib/about-pages';
import { aboutApps } from '../../../content/about-apps';

const allRows = Object.fromEntries(aboutApps.map((app) => [app.slug, `About ${app.name}`]));

describe('aboutPageSlug', () => {
    test('an app page takes its app from the file name', () => {
        expect(aboutPageSlug('sheets.md')).toBe('sheets');
        expect(aboutPageSlug('admin.md')).toBe('admin');
    });

    test('index.md is the overview', () => {
        expect(aboutPageSlug('index.md')).toBe('index');
    });

    test('a file named after no app fails the build', () => {
        expect(() => aboutPageSlug('space.md')).toThrow();
        expect(() => aboutPageSlug('Sheets.md')).toThrow();
    });
});

describe('checkAboutRows', () => {
    test('passes a line for every app', () => {
        expect(checkAboutRows(allRows)).toEqual(allRows);
    });

    test('fails without rows, with an app missing or with one too many', () => {
        expect(() => checkAboutRows(undefined)).toThrow();
        const { sheets: _, ...missing } = allRows;
        expect(() => checkAboutRows(missing)).toThrow();
        expect(() => checkAboutRows({ ...allRows, space: 'Your workspace home' })).toThrow();
    });
});

describe('checkPrincipleArticles', () => {
    const articles = new Set(aboutApps.flatMap((app) => app.principles.map((entry) => entry.article)));

    test('passes when every principle of an app links a help article', () => {
        expect(() => checkPrincipleArticles(articles)).not.toThrow();
    });

    test('fails naming a link to no help article', () => {
        const fewer = new Set(articles);
        fewer.delete('mail/download-an-email');
        expect(() => checkPrincipleArticles(fewer)).toThrow('mail/download-an-email');
    });
});
