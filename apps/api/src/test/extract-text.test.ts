import { describe, expect, test } from 'bun:test';
import { collectStickiesText } from '../lib/search/extract-text';
import { CONTENT_INDEX_MAX_BYTES } from '../lib/search/limits';

// The main-thread half of search extraction — stickies, chat and plain files are light
// reads. The three collab types extract in the Worker (extract-render.test.ts).

describe('content collectors', () => {
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
