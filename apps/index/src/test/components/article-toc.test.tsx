// The table of contents lists the h2 headings of a page under a label, with an optional detail on the right of an
// entry, and draws nothing when there are fewer than two entries to jump between. In a browser it marks the last
// heading above the top third of the screen as scrolling goes, and the last entry once the scroller hits bottom.
import { afterEach, describe, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { ArticleToc } = await import('../../components/article-toc');

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

    describe('while scrolling', () => {
        const VIEWPORT = 900;

        afterEach(() => document.querySelector('[data-scroller]')?.remove());

        // A scroller holding three headings at the given tops; the stubbed rects are all happy-dom lacks.
        async function setup(tops: number[], scroll: { scrollTop: number; scrollHeight: number }) {
            const scroller = document.createElement('div');
            scroller.dataset.scroller = '';
            const ids = tops.map((_, i) => `h${i}`);
            tops.forEach((top, i) => {
                const heading = document.createElement('h2');
                heading.id = ids[i];
                heading.getBoundingClientRect = () => new DOMRect(0, top, 100, 20);
                scroller.append(heading);
            });
            document.body.append(scroller);
            window.innerHeight = VIEWPORT;
            Object.defineProperty(scroller, 'clientHeight', { value: VIEWPORT, configurable: true });
            Object.defineProperty(scroller, 'scrollHeight', { value: scroll.scrollHeight, configurable: true });
            scroller.scrollTop = scroll.scrollTop;
            const { container } = await renderInDocument(<ArticleToc toc={ids.map((id) => entry(id))} />);
            const scrolled = () => act(async () => void scroller.dispatchEvent(new Event('scroll')));
            const active = () => container.querySelector('a.font-medium')?.getAttribute('href');
            return { scrolled, active };
        }

        test('starts with nothing active', async () => {
            const { active } = await setup([100, 2000, 3000], { scrollTop: 0, scrollHeight: 4000 });
            expect(active()).toBeUndefined();
        });

        test('marks the last heading above the top third', async () => {
            const { scrolled, active } = await setup([-500, 250, 400], { scrollTop: 500, scrollHeight: 4000 });
            await scrolled();
            expect(active()).toBe('#h1');
        });

        test('marks the last entry at the bottom of a short page', async () => {
            const { scrolled, active } = await setup([-500, 400, 700], { scrollTop: 3100, scrollHeight: 4000 });
            await scrolled();
            expect(active()).toBe('#h2');
        });
    });
});
