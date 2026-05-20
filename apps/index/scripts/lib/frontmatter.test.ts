import { describe, expect, test } from 'bun:test';
import { supportFrontmatterSchema } from './content-types';
import { parseContentFile } from './frontmatter';

describe('parseContentFile', () => {
    test('parses valid frontmatter and returns the body', () => {
        const raw = [
            '---',
            'title: Share a file',
            'description: How to share.',
            'type: how-to',
            'tags: [sharing]',
            '---',
            '',
            '# Body',
        ].join('\n');
        const result = parseContentFile(raw, supportFrontmatterSchema);
        expect(result.data.title).toBe('Share a file');
        expect(result.data.type).toBe('how-to');
        expect(result.data.tags).toEqual(['sharing']);
        expect(result.body.trim()).toBe('# Body');
    });

    test('applies schema defaults', () => {
        const raw = ['---', 'title: T', 'description: D', 'type: faq', '---', 'body'].join('\n');
        const result = parseContentFile(raw, supportFrontmatterSchema);
        expect(result.data.draft).toBe(false);
        expect(result.data.order).toBe(100);
        expect(result.data.tags).toEqual([]);
    });

    test('throws a readable error on a missing required field', () => {
        const raw = ['---', 'description: D', 'type: faq', '---', 'body'].join('\n');
        expect(() => parseContentFile(raw, supportFrontmatterSchema)).toThrow(/title/);
    });
});
