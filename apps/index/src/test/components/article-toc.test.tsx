// The table of contents lists the h2 headings of a page under a label, with an optional detail on the right of an
// entry, and draws nothing when there are fewer than two entries to jump between. In a browser it marks the last
// heading above the top third of the screen each time a heading crosses that line.
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
        const RealObserver = globalThis.IntersectionObserver;
        let report = () => {};

        // happy-dom never reports intersections, so the fake hands the test the observer's callback to call by hand.
        class FakeObserver {
            public constructor(callback: () => void) {
                report = callback;
            }
            public observe() {}
            public disconnect() {}
        }

        afterEach(() => {
            document.querySelector('[data-page]')?.remove();
            globalThis.IntersectionObserver = RealObserver;
        });

        // Three headings at the given tops; the stubbed rects are all happy-dom lacks.
        async function setup(tops: number[]) {
            Object.assign(globalThis, { IntersectionObserver: FakeObserver });
            const page = document.createElement('div');
            page.dataset.page = '';
            const ids = tops.map((_, i) => `h${i}`);
            tops.forEach((top, i) => {
                const heading = document.createElement('h2');
                heading.id = ids[i];
                heading.getBoundingClientRect = () => new DOMRect(0, top, 100, 20);
                page.append(heading);
            });
            document.body.append(page);
            window.innerHeight = VIEWPORT;
            const { container } = await renderInDocument(<ArticleToc toc={ids.map((id) => entry(id))} />);
            const crossed = () => act(async () => report());
            const active = () => container.querySelector('a.font-medium')?.getAttribute('href');
            return { crossed, active };
        }

        test('marks the last heading above the top third when one crosses the line', async () => {
            const { crossed, active } = await setup([-500, 250, 400]);
            await crossed();
            expect(active()).toBe('#h1');
        });

        test('marks nothing while every heading is below the top third', async () => {
            const { crossed, active } = await setup([1000, 2000, 3000]);
            await crossed();
            expect(active()).toBeUndefined();
        });
    });
});
