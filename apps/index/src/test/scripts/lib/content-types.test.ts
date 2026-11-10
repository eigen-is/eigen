import { describe, expect, test } from 'bun:test';
import { blogFrontmatterSchema } from '../../../../scripts/lib/content-types';

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
