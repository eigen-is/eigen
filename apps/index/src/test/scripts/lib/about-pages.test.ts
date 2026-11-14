import { describe, expect, test } from 'bun:test';
import { aboutPageSlug, checkAboutRows, checkFormatArticles } from '../../../../scripts/lib/about-pages';
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

describe('checkFormatArticles', () => {
    const articles = new Set(aboutApps.flatMap((app) => (app.formats ? [app.formats.article] : [])));

    test('passes when every formats panel links a help article', () => {
        expect(() => checkFormatArticles(articles)).not.toThrow();
    });

    test('fails naming a link to no help article', () => {
        const fewer = new Set(articles);
        fewer.delete('sheets/import-excel');
        expect(() => checkFormatArticles(fewer)).toThrow('sheets/import-excel');
    });
});
