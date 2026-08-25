import { describe, expect, test } from 'bun:test';
import { renderMarkdown } from '../../../../scripts/lib/render-markdown';

describe('renderMarkdown', () => {
    test('renders Markdown to HTML', () => {
        const { html } = renderMarkdown('# Hi\n\nA **paragraph**.');
        expect(html).toContain('<h1');
        expect(html).toContain('<strong>paragraph</strong>');
    });

    test('extracts h2/h3 headings into the TOC with slug ids', () => {
        const { toc } = renderMarkdown('## Permission levels\n\ntext\n\n### Shared links');
        expect(toc).toEqual([
            { id: 'permission-levels', text: 'Permission levels', level: 2 },
            { id: 'shared-links', text: 'Shared links', level: 3 },
        ]);
    });

    test('headings in the HTML carry the matching id', () => {
        const { html } = renderMarkdown('## Permission levels');
        expect(html).toContain('id="permission-levels"');
    });

    test('h1 is not included in the TOC', () => {
        const { toc } = renderMarkdown('# Title\n\n## Section');
        expect(toc.map((t) => t.level)).toEqual([2]);
    });
});
