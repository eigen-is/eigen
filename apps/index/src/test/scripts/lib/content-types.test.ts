import { describe, expect, test } from 'bun:test';
import { aboutFrontmatterSchema, blogFrontmatterSchema } from '../../../../scripts/lib/content-types';

describe('blogFrontmatterSchema', () => {
    const post = { id: 'eigen-vector', title: 'Eigen: Vector', description: 'A new app.' };

    test('a cover is optional', () => {
        expect(blogFrontmatterSchema.parse(post).cover).toBeUndefined();
    });

    test('a cover is a path under public/', () => {
        const cover = '/data/blog/media/2026-08-14-eigen-demo/vector.webp';
        expect(blogFrontmatterSchema.parse({ ...post, cover }).cover).toBe(cover);
    });

    test('a post is published unless it says draft', () => {
        expect(blogFrontmatterSchema.parse(post).draft).toBe(false);
        expect(blogFrontmatterSchema.parse({ ...post, draft: true }).draft).toBe(true);
    });

    test('a cover that is not a path fails the build', () => {
        expect(() => blogFrontmatterSchema.parse({ ...post, cover: 'vector.webp' })).toThrow();
    });
});

describe('aboutFrontmatterSchema', () => {
    const page = { title: 'Sheets', description: 'Spreadsheets and formulas.' };

    test('a page needs only a title and a description', () => {
        expect(aboutFrontmatterSchema.parse(page)).toEqual(page);
    });

    test('the overview lists a line per app in rows', () => {
        expect(aboutFrontmatterSchema.parse({ ...page, rows: { sheets: 'x' } }).rows).toEqual({ sheets: 'x' });
    });

    test('a field the About pages do not read fails the build', () => {
        expect(() => aboutFrontmatterSchema.parse({ ...page, draft: true })).toThrow();
        expect(() => aboutFrontmatterSchema.parse({ ...page, order: 1 })).toThrow();
    });
});
