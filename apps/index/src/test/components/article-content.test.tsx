import { afterEach, describe, expect, jest, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act } = await import('react');
const { ArticleContent } = await import('../../components/article-content');
const { renderMarkdown } = await import('../../../scripts/lib/render-markdown');

const RealMatchMedia = globalThis.matchMedia;
afterEach(() => {
    globalThis.matchMedia = RealMatchMedia;
    jest.useRealTimers();
});

// A reduced-motion setting the test can flip, telling the page's listener as a browser would.
function stubReducedMotion(reduce: boolean) {
    const listeners = new Set<() => void>();
    const query = {
        matches: reduce,
        addEventListener: (_: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    };
    Object.assign(globalThis, { matchMedia: () => query });
    return (next: boolean) =>
        act(async () => {
            query.matches = next;
            for (const listener of listeners) listener();
        });
}

async function renderVideo() {
    const html = '<figure class="media-video"><video muted loop playsinline></video></figure>';
    const { container } = await renderInDocument(<ArticleContent body={{ html, mediaGrids: [] }} />);
    const video = container.querySelector('video');
    if (!video) throw new Error('No video rendered');
    return video;
}

// A carousel from the real build, three images unless the test writes its own. happy-dom lays nothing out, so each
// slide gets its place 600px apart.
async function renderCarousel(markdown = '::: carousel\n![a](/a.webp)\n![b](/b.webp)\n![c](/c.webp)\n:::') {
    const { html } = renderMarkdown(markdown);
    const { container } = await renderInDocument(<ArticleContent body={{ html, mediaGrids: [] }} />);
    for (const [i, slide] of container.querySelectorAll('.media-carousel-slide').entries()) {
        Object.defineProperty(slide, 'offsetLeft', { value: i * 600 });
    }
    const strip = container.querySelector('.media-carousel-strip');
    const prev = container.querySelector<HTMLButtonElement>('.media-carousel-prev');
    const next = container.querySelector<HTMLButtonElement>('.media-carousel-next');
    if (!strip || !prev || !next) throw new Error('No carousel rendered');
    const dots = Array.from(container.querySelectorAll<HTMLButtonElement>('.media-carousel-dot'));
    const scrollTo = (left: number) =>
        act(async () => {
            strip.scrollLeft = left;
            strip.dispatchEvent(new Event('scroll'));
        });
    const current = () => dots.findIndex((dot) => dot.getAttribute('aria-current') === 'true');
    return { container, strip, prev, next, dots, scrollTo, current };
}

const AUTOPLAY = '::: carousel autoplay\n![a](/a.webp)\n![b](/b.webp)\n![c](/c.webp)\n:::';

// Renders the autoplay carousel on a clock the test moves.
async function renderAutoplay() {
    jest.useFakeTimers();
    const carousel = await renderCarousel(AUTOPLAY);
    const wait = (ms: number) => act(async () => jest.advanceTimersByTime(ms));
    return { ...carousel, wait };
}

describe('carousel', () => {
    test('the next button moves the strip one slide on', async () => {
        const { strip, next } = await renderCarousel();
        await act(async () => next.click());
        expect(strip.scrollLeft).toBe(600);
    });

    test('a scroll marks the dot of the slide in view and turns a button off at its end', async () => {
        const { prev, next, dots, scrollTo, current } = await renderCarousel();
        expect(prev.disabled).toBe(true);
        await scrollTo(610);
        expect(current()).toBe(1);
        expect(dots[0]?.hasAttribute('aria-current')).toBe(false);
        expect(prev.disabled).toBe(false);
        expect(next.disabled).toBe(false);
        await scrollTo(1200);
        expect(current()).toBe(2);
        expect(next.disabled).toBe(true);
        await scrollTo(0);
        expect(current()).toBe(0);
        expect(prev.disabled).toBe(true);
    });

    test('a dot scrolls to its slide', async () => {
        const { strip, dots } = await renderCarousel();
        await act(async () => dots[2]?.click());
        expect(strip.scrollLeft).toBe(1200);
    });

    test('only the video on the slide in view plays', async () => {
        stubReducedMotion(false);
        const { container, scrollTo } = await renderCarousel(
            '::: carousel\n![a](/data/about/media/sheets-hero)\n![b](/data/about/media/sheets-chart)\n:::',
        );
        const [first, second] = container.querySelectorAll('video');
        expect([first?.paused, second?.paused]).toEqual([false, true]);
        await scrollTo(600);
        expect([first?.paused, second?.paused]).toEqual([true, false]);
    });
});

describe('autoplay carousel', () => {
    test('steps on every few seconds, from the last slide back to the first', async () => {
        stubReducedMotion(false);
        const { strip, wait } = await renderAutoplay();
        await wait(6000);
        expect(strip.scrollLeft).toBe(0);
        await wait(1500);
        expect(strip.scrollLeft).toBe(600);
        await wait(7500);
        expect(strip.scrollLeft).toBe(1200);
        await wait(7500);
        expect(strip.scrollLeft).toBe(0);
    });

    test('waits while the pointer is over it or focus is inside it', async () => {
        stubReducedMotion(false);
        const { container, strip, wait } = await renderAutoplay();
        const carousel = container.querySelector('.media-carousel');
        // happy-dom matches neither :hover nor :focus-within, so the test says when the reader is there.
        let readerThere = true;
        Object.defineProperty(carousel, 'matches', {
            value: (selector: string) => selector === ':hover, :focus-within' && readerThere,
        });
        await wait(15000);
        expect(strip.scrollLeft).toBe(0);
        readerThere = false;
        await wait(7500);
        expect(strip.scrollLeft).toBe(600);
    });

    test('stops for good once the reader moved it', async () => {
        stubReducedMotion(false);
        const { strip, next, wait } = await renderAutoplay();
        await act(async () => next.click());
        await wait(30000);
        expect(strip.scrollLeft).toBe(600);
    });

    test('stops for good after a swipe to another slide', async () => {
        stubReducedMotion(false);
        const { strip, scrollTo, wait } = await renderAutoplay();
        await wait(7500);
        await scrollTo(1200);
        await wait(30000);
        expect(strip.scrollLeft).toBe(1200);
    });

    test('never moves for a reader who asked for less motion', async () => {
        stubReducedMotion(true);
        const { strip, wait } = await renderAutoplay();
        await wait(30000);
        expect(strip.scrollLeft).toBe(0);
    });
});

describe('page blocks', () => {
    test('each draws what the page gives for it where the Markdown put it', async () => {
        const { html } = renderMarkdown(
            'Before\n\n::: apps\n:::\n\nBetween\n\n::: principles\n:::\n\nAfter',
            new Set(['apps', 'principles']),
        );
        const { container } = await renderInDocument(
            <ArticleContent body={{ html, mediaGrids: [] }} blocks={{ apps: 'Rows', principles: 'Panels' }} />,
        );
        expect(container.textContent?.replace(/\s+/g, ' ').trim()).toBe('Before Rows Between Panels After');
    });

    test('draw outside the prose, which holds the Markdown around them', async () => {
        const { html } = renderMarkdown('Before\n\n::: apps\n:::\n\nAfter', new Set(['apps']));
        const { container } = await renderInDocument(
            <ArticleContent body={{ html, mediaGrids: [] }} blocks={{ apps: <p className="rows">Rows</p> }} />,
        );
        const prose = Array.from(container.querySelectorAll('.eigen-prose.site-prose'), (div) => div.textContent);
        expect(prose).toEqual(['Before\n', '\nAfter\n']);
        expect(container.querySelector('.rows')?.closest('.eigen-prose')).toBeNull();
    });
});

describe('ArticleContent', () => {
    test('plays a looping video without controls', async () => {
        stubReducedMotion(false);
        const video = await renderVideo();
        expect(video.paused).toBe(false);
        expect(video.controls).toBe(false);
    });

    test('shows controls when the browser refuses to start a video', async () => {
        stubReducedMotion(false);
        const { play } = HTMLMediaElement.prototype;
        HTMLMediaElement.prototype.play = () => Promise.reject(new Error('NotAllowedError'));
        try {
            const video = await renderVideo();
            await act(async () => {});
            expect(video.controls).toBe(true);
        } finally {
            HTMLMediaElement.prototype.play = play;
        }
    });

    test('holds a looping video still with controls for a reader who asked for less motion', async () => {
        stubReducedMotion(true);
        const video = await renderVideo();
        expect(video.paused).toBe(true);
        expect(video.controls).toBe(true);
    });

    test('follows the setting when it changes', async () => {
        const setReducedMotion = stubReducedMotion(false);
        const video = await renderVideo();
        await setReducedMotion(true);
        expect(video.paused).toBe(true);
        expect(video.controls).toBe(true);
        await setReducedMotion(false);
        expect(video.paused).toBe(false);
        expect(video.controls).toBe(false);
    });
});

// The open lightbox: what it shows, its caption, and its previous and next buttons, if any.
function lightbox() {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return null;
    const media = dialog.querySelector('img, video');
    return {
        count: document.querySelectorAll('[role="dialog"]').length,
        src: media?.getAttribute('src'),
        caption: dialog.querySelector('p')?.textContent,
        prev: dialog.querySelector<HTMLButtonElement>('button[aria-label="Previous"]'),
        next: dialog.querySelector<HTMLButtonElement>('button[aria-label="Next"]'),
    };
}

async function clickOn(container: HTMLElement, selector: string) {
    const target = container.querySelector<HTMLElement>(selector);
    if (!target) throw new Error(`Nothing matches ${selector}`);
    await act(async () => target.click());
}

describe('lightbox', () => {
    test('a lone image opens bigger, alone, with its alt text as the caption', async () => {
        const html = '<p><img src="/a.webp" alt="A budget"></p>';
        const { container } = await renderInDocument(<ArticleContent body={{ html, mediaGrids: [] }} />);
        await clickOn(container, 'img');
        expect(lightbox()).toMatchObject({ count: 1, src: '/a.webp', caption: 'A budget', prev: null, next: null });
    });

    test('a carousel image opens with the carousel as its group, at the image clicked', async () => {
        const { html } = renderMarkdown('::: carousel\n![a](/a.webp)\n![b](/b.webp)\n![c](/c.webp)\n:::');
        const { container } = await renderInDocument(<ArticleContent body={{ html, mediaGrids: [] }} />);
        await clickOn(container, '.media-carousel-slide:nth-child(2) img');
        expect(lightbox()).toMatchObject({ src: '/b.webp', caption: 'b' });
        await act(async () => lightbox()?.next?.click());
        expect(lightbox()?.src).toBe('/c.webp');
        expect(lightbox()?.next?.disabled).toBe(true);
        await act(async () => {
            document
                .querySelector('[role="dialog"]')
                ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
        });
        expect(lightbox()?.src).toBe('/b.webp');
    });

    test('an arrow key on a film seeks it, and one something else handled does not page either', async () => {
        const { html } = renderMarkdown('::: carousel\n![a](/data/about/media/sheets-hero)\n![b](/b.webp)\n:::');
        const { container } = await renderInDocument(<ArticleContent body={{ html, mediaGrids: [] }} />);
        await clickOn(container, '.media-carousel-slide video');
        const press = (target: Element | null | undefined, handled = false) =>
            act(async () => {
                const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
                if (handled) event.preventDefault();
                target?.dispatchEvent(event);
            });
        await press(document.querySelector('[role="dialog"] video'));
        expect(document.querySelector('[role="dialog"] video')).not.toBeNull();
        await press(document.querySelector('[role="dialog"]'), true);
        expect(document.querySelector('[role="dialog"] video')).not.toBeNull();
        await press(document.querySelector('[role="dialog"]'));
        expect(lightbox()?.src).toBe('/b.webp');
    });

    test.each(['Enter', ' '])('%p on the focused strip opens the slide in view, in its group', async (key) => {
        const { strip, scrollTo } = await renderCarousel();
        await scrollTo(600);
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        await act(async () => strip.dispatchEvent(event));
        expect(event.defaultPrevented).toBe(true);
        expect(lightbox()).toMatchObject({ count: 1, src: '/b.webp' });
        expect(lightbox()?.next).not.toBeNull();
    });

    test('a click on the open picture leaves the group as it is', async () => {
        const { html } = renderMarkdown('::: carousel\n![a](/a.webp)\n![b](/b.webp)\n:::');
        const { container } = await renderInDocument(<ArticleContent body={{ html, mediaGrids: [] }} />);
        await clickOn(container, '.media-carousel-slide img');
        await act(async () => document.querySelector<HTMLElement>('[role="dialog"] img')?.click());
        expect(lightbox()).toMatchObject({ count: 1, src: '/a.webp' });
        expect(lightbox()?.next).not.toBeNull();
    });

    test('an image inside a link follows the link instead', async () => {
        const html = '<p><a href="#elsewhere"><img src="/a.webp" alt="a"></a></p>';
        const { container } = await renderInDocument(<ArticleContent body={{ html, mediaGrids: [] }} />);
        await clickOn(container, 'img');
        expect(lightbox()).toBeNull();
    });

    test('a media grid opens one lightbox with the grid as its group', async () => {
        const items = [
            { src: '/g1.png', type: 'image' as const, caption: 'One' },
            { src: '/g2.png', type: 'image' as const, caption: 'Two' },
        ];
        const body = { html: '<p>[MEDIAGRID:0]</p>', mediaGrids: [{ columns: '2', items }] };
        const { container } = await renderInDocument(<ArticleContent body={body} />);
        await clickOn(container, 'button img');
        expect(lightbox()).toMatchObject({ count: 1, src: '/g1.png', caption: 'One' });
        await act(async () => lightbox()?.next?.click());
        expect(lightbox()).toMatchObject({ count: 1, src: '/g2.png', caption: 'Two' });
    });
});
