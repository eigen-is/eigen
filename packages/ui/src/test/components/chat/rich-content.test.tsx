import { describe, expect, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

// RichContent reaches UserNameCard and the query stack behind it, so it is imported dynamically like
// every other component test here: a static import (JSX included, via its runtime) hoists above
// installHappyDom and leaves the rest of this bun process with a DOM-less React. See happy-dom.ts.
const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { API_HOST } = await import('@workspace/lib/api');
const { RichContent } = await import('../../../components/chat/rich-content');

// A link inside a message is an aside while the reader is mid-conversation, so it opens in a new tab
// whatever it points at — including back into this instance, hence the API_HOST case.
describe('RichContent links', () => {
    test('a linkified URL opens in a new tab with the opener sealed', () => {
        const html = renderToStaticMarkup(createElement(RichContent, { text: 'see https://example.com/report' }));
        expect(html).toContain('target="_blank"');
        expect(html).toContain('rel="noopener noreferrer"');
    });

    test('a link back into this instance opens in a new tab too', () => {
        const origin = new URL(API_HOST).origin;
        const html = renderToStaticMarkup(createElement(RichContent, { text: `see ${origin}/docs/doc/owner-1/m1/p1` }));
        expect(html).toContain(`href="${origin}/docs/doc/owner-1/m1/p1"`);
        expect(html).toContain('target="_blank"');
        expect(html).toContain('rel="noopener noreferrer"');
    });
});
