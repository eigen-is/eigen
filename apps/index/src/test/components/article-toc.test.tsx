// The table of contents lists the h2 headings of a page under a label, with an optional detail on the right of an
// entry, and draws nothing when there are fewer than two entries to jump between.
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArticleToc } from '../../components/article-toc';

const entry = (id: string, level: 2 | 3 = 2) => ({ id, text: `Heading ${id}`, level });

describe('ArticleToc', () => {
    test('lists the h2 headings under On this page and skips the h3', () => {
        const html = renderToStaticMarkup(<ArticleToc toc={[entry('a'), entry('b'), entry('c', 3)]} />);
        expect(html).toContain('On this page');
        expect(html).toContain('href="#a"');
        expect(html).toContain('href="#b"');
        expect(html).not.toContain('href="#c"');
    });

    test('takes the label and the details of the changelog', () => {
        const toc = [
            { id: 'v2', text: '0.4.2', detail: '3 Nov' },
            { id: 'v1', text: '0.4.1', detail: '28 Oct' },
        ];
        const html = renderToStaticMarkup(<ArticleToc toc={toc} label="Versions" />);
        expect(html).toContain('Versions');
        expect(html).toContain('3 Nov');
        expect(html).toContain('0.4.1');
    });

    test('draws nothing for fewer than two entries', () => {
        expect(renderToStaticMarkup(<ArticleToc toc={[entry('a'), entry('b', 3)]} />)).toBe('');
    });
});
