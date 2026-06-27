import { describe, expect, test } from 'bun:test';
import {
    CONTENT_INDEX_MAX_BYTES,
    collectProseMirrorText,
    collectSheetsText,
    collectSlidesText,
    collectStickiesText,
} from './extract-text';

describe('content collectors', () => {
    test('collectProseMirrorText pulls all text nodes', () => {
        const json = {
            type: 'doc',
            content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'hello' }] },
                { type: 'paragraph', content: [{ type: 'text', text: 'world' }] },
            ],
        };
        expect(collectProseMirrorText(json, CONTENT_INDEX_MAX_BYTES)).toContain('hello');
        expect(collectProseMirrorText(json, CONTENT_INDEX_MAX_BYTES)).toContain('world');
    });

    test('collectProseMirrorText honours the cap', () => {
        const json = {
            type: 'doc',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(50) }] }],
        };
        expect(collectProseMirrorText(json, 10).length).toBeLessThanOrEqual(50);
    });

    test('collectSheetsText uses display value (m ?? v) of sparse celldata', () => {
        const sheets = [
            {
                id: 's1',
                name: 'Sheet1',
                order: 0,
                config: {},
                celldata: [
                    { r: 0, c: 0, v: { m: 'Revenue', v: 'Revenue' } },
                    { r: 5, c: 2, v: { v: 42 } },
                ],
            },
        ];
        const text = collectSheetsText(sheets as never, CONTENT_INDEX_MAX_BYTES);
        expect(text).toContain('Revenue');
        expect(text).toContain('42');
    });

    test('collectSlidesText concatenates text objects across slides in order', () => {
        const deck = {
            slideOrder: ['s1'],
            slides: { s1: { id: 's1', objectIds: ['o1', 'o2'], background: null } },
            objects: {
                o1: { id: 'o1', type: 'text', text: 'Title slide' },
                o2: { id: 'o2', type: 'image' },
            },
        };
        const text = collectSlidesText(deck as never, CONTENT_INDEX_MAX_BYTES);
        expect(text).toContain('Title slide');
    });

    test('collectStickiesText pulls card titles + descriptions + column titles', () => {
        const content = {
            tasks: [{ title: 'Fix bug', description: 'in the parser' }],
            columns: [{ title: 'In Progress' }],
        };
        const text = collectStickiesText(content, CONTENT_INDEX_MAX_BYTES);
        expect(text).toContain('Fix bug');
        expect(text).toContain('in the parser');
        expect(text).toContain('In Progress');
    });
});
