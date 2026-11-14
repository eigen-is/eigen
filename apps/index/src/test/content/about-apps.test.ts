import { describe, expect, test } from 'bun:test';
import { aboutApps, aboutPageSlug, checkAboutRows } from '../../content/about-apps';

const allRows = Object.fromEntries(aboutApps.map((app) => [app.slug, `About ${app.name}`]));

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
});

describe('aboutPageSlug', () => {
    test('an app page takes its app from the file name', () => {
        expect(aboutPageSlug('sheets.md')).toBe('sheets');
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
