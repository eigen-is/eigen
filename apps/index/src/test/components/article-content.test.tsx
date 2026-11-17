import { afterEach, describe, expect, jest, spyOn, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act } = await import('react');
const { hydrateRoot } = await import('react-dom/client');
const { renderToString } = await import('react-dom/server');
const { ArticleContent } = await import('../../components/article-content');
const { renderMarkdown } = await import('../../../scripts/lib/render-markdown');

const RealMatchMedia = window.matchMedia;
afterEach(() => {
    window.matchMedia = RealMatchMedia;
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
    Object.assign(window, { matchMedia: () => query });
    return (next: boolean) =>
        act(async () => {
            query.matches = next;
            for (const listener of listeners) listener();
        });
}

async function renderVideo() {
    const body = renderMarkdown('::: video src="/data/about/media/sheets-chart"\n:::');
    const { container } = await renderInDocument(<ArticleContent body={body} />);
    const video = container.querySelector('video');
    if (!video) throw new Error('No video rendered');
    return video;
}

// A carousel from the real build, three images unless the test writes its own. happy-dom lays nothing out, so each
// slide gets its place 600px apart.
async function renderCarousel(markdown = '::: carousel\n![a](/a.webp)\n![b](/b.webp)\n![c](/c.webp)\n:::') {
    const { container } = await renderInDocument(<ArticleContent body={renderMarkdown(markdown)} />);
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
    test('each slide has a dot that says which of how many it is, the first marked, and the previous button off', async () => {
        const { prev, next, dots, current } = await renderCarousel();
        expect(dots.map((dot) => dot.getAttribute('aria-label'))).toEqual([
            'Slide 1 of 3',
            'Slide 2 of 3',
            'Slide 3 of 3',
        ]);
        expect(current()).toBe(0);
        expect([prev.disabled, next.disabled]).toEqual([true, false]);
        expect([prev.getAttribute('aria-label'), next.getAttribute('aria-label')]).toEqual([
            'Previous slide',
            'Next slide',
        ]);
    });

    test('the previous button moves the strip one slide back', async () => {
        const { strip, prev, scrollTo } = await renderCarousel();
        await scrollTo(1200);
        await act(async () => prev.click());
        expect(strip.scrollLeft).toBe(600);
    });

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

    test('a mouse drag moves the strip to the next slide that way, and its click opens nothing', async () => {
        stubReducedMotion(true);
        const { strip, current } = await renderCarousel();
        const pointer = (type: string, clientX: number) =>
            act(async () => {
                strip.dispatchEvent(
                    new PointerEvent(type, { pointerType: 'mouse', button: 0, clientX, bubbles: true }),
                );
            });
        await pointer('pointerdown', 500);
        await pointer('pointermove', 400);
        expect(strip.hasAttribute('data-dragging')).toBe(true);
        expect(strip.scrollLeft).toBe(100);
        await pointer('pointerup', 400);
        await act(() => new Promise((resolve) => requestAnimationFrame(resolve)));
        strip.dispatchEvent(new Event('scroll'));
        await act(async () => strip.querySelector<HTMLElement>('img')?.click());
        expect(strip.scrollLeft).toBe(600);
        expect(strip.hasAttribute('data-dragging')).toBe(false);
        expect(current()).toBe(1);
        expect(lightbox()).toBeNull();
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
        const body = renderMarkdown(
            'Before\n\n::: apps\n:::\n\nBetween\n\n::: principles\n:::\n\nAfter',
            new Set(['apps', 'principles']),
        );
        const { container } = await renderInDocument(
            <ArticleContent body={body} blocks={{ apps: 'Rows', principles: 'Panels' }} />,
        );
        expect(container.textContent?.replace(/\s+/g, ' ').trim()).toBe('Before Rows Between Panels After');
    });

    test('draw outside the prose, which holds the Markdown around them', async () => {
        const body = renderMarkdown('Before\n\n::: apps\n:::\n\nAfter', new Set(['apps']));
        const { container } = await renderInDocument(
            <ArticleContent body={body} blocks={{ apps: <p className="rows">Rows</p> }} />,
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
        HTMLMediaElement.prototype.play = () => Promise.reject(new DOMException('Refused', 'NotAllowedError'));
        try {
            const video = await renderVideo();
            await act(async () => {});
            expect(video.controls).toBe(true);
        } finally {
            HTMLMediaElement.prototype.play = play;
        }
    });

    test('keeps a video without controls when a pause cuts its start short', async () => {
        stubReducedMotion(false);
        const { play } = HTMLMediaElement.prototype;
        HTMLMediaElement.prototype.play = () => Promise.reject(new DOMException('Paused', 'AbortError'));
        try {
            const video = await renderVideo();
            await act(async () => {});
            expect(video.controls).toBe(false);
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

// The open lightbox: what it shows, its caption as the title, and its previous and next buttons, if any.
function lightbox() {
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) return null;
    const media = dialog.querySelector('img, video');
    return {
        count: document.querySelectorAll('[role="dialog"]').length,
        src: media?.getAttribute('src'),
        caption: dialog.querySelector('h2')?.textContent,
        prev: dialog.querySelector<HTMLButtonElement>('button[aria-label="Previous (←)"]'),
        next: dialog.querySelector<HTMLButtonElement>('button[aria-label="Next (→)"]'),
        footer: dialog.querySelector('a, button:not([aria-label])'),
    };
}

async function clickOn(container: HTMLElement, selector: string) {
    const target = container.querySelector<HTMLElement>(selector);
    if (!target) throw new Error(`Nothing matches ${selector}`);
    await act(async () => target.click());
}

// A grid's files must exist under the public folder, so its tests show real ones.
const MEDIA = '/data/about/media/';
const STILL = `${MEDIA}sheets-still-budget.webp`;
const THUMBNAIL = `${MEDIA}row-sheets.webp`;

describe('lightbox', () => {
    test('a lone image opens bigger, alone, with its alt text as the caption', async () => {
        const html = '<p><img src="/a.webp" alt="A budget"></p>';
        const { container } = await renderInDocument(<ArticleContent body={{ html, media: [] }} />);
        await clickOn(container, 'img');
        expect(lightbox()).toMatchObject({
            count: 1,
            src: '/a.webp',
            caption: 'A budget',
            prev: null,
            next: null,
            footer: null,
        });
    });

    test('a picture in the Markdown opens from its full-screen button, and one in a link has none', async () => {
        const body = renderMarkdown('![A budget](/a.webp)\n\n[![b](/b.webp)](#elsewhere)');
        const { container } = await renderInDocument(<ArticleContent body={body} />);
        expect(container.querySelectorAll('.media-expand').length).toBe(1);
        expect(container.querySelector('a .media-expand')).toBeNull();
        await clickOn(container, '.media-expand');
        expect(lightbox()).toMatchObject({ count: 1, src: '/a.webp', caption: 'A budget' });
    });

    test('a slide’s full-screen button opens that slide, in its group', async () => {
        const body = renderMarkdown('::: carousel\n![a](/a.webp)\n![b](/b.webp)\n:::');
        const { container } = await renderInDocument(<ArticleContent body={body} />);
        await clickOn(container, '.media-carousel-slide:nth-child(2) .media-expand');
        expect(lightbox()).toMatchObject({ count: 1, src: '/b.webp' });
        expect(lightbox()?.prev).not.toBeNull();
    });

    test('a looping video opens from its full-screen button, also while it shows its controls', async () => {
        stubReducedMotion(true);
        await renderVideo();
        await clickOn(document.body, '.media-video .media-expand');
        expect(lightbox()?.src).toBe('/data/about/media/sheets-chart.h264.mp4');
    });

    test('a carousel image opens with the carousel as its group, at the image clicked', async () => {
        const body = renderMarkdown('::: carousel\n![a](/a.webp)\n![b](/b.webp)\n![c](/c.webp)\n:::');
        const { container } = await renderInDocument(<ArticleContent body={body} />);
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

    test('an arrow key on a film seeks it, and one on the lightbox pages', async () => {
        const body = renderMarkdown('::: carousel\n![a](/data/about/media/sheets-hero)\n![b](/b.webp)\n:::');
        const { container } = await renderInDocument(<ArticleContent body={body} />);
        await clickOn(container, '.media-carousel-slide video');
        const press = (target: Element | null | undefined) =>
            act(async () => {
                target?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
            });
        await press(document.querySelector('[role="dialog"] video'));
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
        const body = renderMarkdown('::: carousel\n![a](/a.webp)\n![b](/b.webp)\n:::');
        const { container } = await renderInDocument(<ArticleContent body={body} />);
        await clickOn(container, '.media-carousel-slide img');
        await act(async () => document.querySelector<HTMLElement>('[role="dialog"] img')?.click());
        expect(lightbox()).toMatchObject({ count: 1, src: '/a.webp' });
        expect(lightbox()?.next).not.toBeNull();
    });

    test('a looping video opens alone, as a loop with its caption as text', async () => {
        const body = renderMarkdown('::: video src="/data/about/media/sheets-chart" caption="A *bar* grows"\n:::');
        const { container } = await renderInDocument(<ArticleContent body={body} />);
        await clickOn(container, '.media-video video');
        expect(lightbox()).toMatchObject({
            count: 1,
            src: '/data/about/media/sheets-chart.h264.mp4',
            caption: 'A bar grows',
            prev: null,
            next: null,
        });
        expect(document.querySelector<HTMLVideoElement>('[role="dialog"] video')?.loop).toBe(true);
    });

    test('a looping video with controls keeps its clicks for them', async () => {
        stubReducedMotion(true);
        const video = await renderVideo();
        await act(async () => video.click());
        expect(lightbox()).toBeNull();
    });

    test('a video slide with controls keeps its clicks for them', async () => {
        stubReducedMotion(true);
        const body = renderMarkdown('::: carousel\n![a](/data/about/media/sheets-hero)\n:::');
        const { container } = await renderInDocument(<ArticleContent body={body} />);
        await clickOn(container, '.media-carousel-slide video');
        expect(lightbox()).toBeNull();
    });

    test('an image inside a link follows the link instead', async () => {
        const html = '<p><a href="#elsewhere"><img src="/a.webp" alt="a"></a></p>';
        const { container } = await renderInDocument(<ArticleContent body={{ html, media: [] }} />);
        await clickOn(container, 'img');
        expect(lightbox()).toBeNull();
    });

    test('a media grid opens one lightbox with the grid as its group', async () => {
        const body = renderMarkdown(`::: grid columns="2"\n![One](${STILL} "${THUMBNAIL}")\n![Two](${THUMBNAIL})\n:::`);
        const { container } = await renderInDocument(<ArticleContent body={body} />);
        expect(container.querySelector('button img')?.getAttribute('src')).toBe(THUMBNAIL);
        await clickOn(container, 'button:nth-child(2) img');
        expect(lightbox()).toMatchObject({ count: 1, src: THUMBNAIL, caption: 'Two' });
        await act(async () => lightbox()?.prev?.click());
        expect(lightbox()).toMatchObject({ count: 1, src: STILL, caption: 'One' });
    });
});

describe('media blocks', () => {
    test('each draws in the prose where the Markdown put it, between the text around it', async () => {
        const body = renderMarkdown(
            [
                'Before',
                `::: grid columns="3"\n![One](${STILL})\n:::`,
                'Between',
                '::: apps\n:::',
                `::: grid columns="1"\n![Film](${MEDIA}sheets-chart.h264.mp4 "${MEDIA}sheets-chart.webp")\n:::`,
                'After',
            ].join('\n\n'),
            new Set(['apps']),
        );
        const { container } = await renderInDocument(<ArticleContent body={body} blocks={{ apps: 'Rows' }} />);
        expect(container.innerHTML).not.toContain('[BLOCK');
        const prose = Array.from(container.querySelectorAll('.eigen-prose.site-prose'), (div) =>
            Array.from(div.children, (child) => child.textContent?.trim() || child.querySelector('img')?.alt).filter(
                Boolean,
            ),
        );
        expect(prose).toEqual([
            ['Before', 'One', 'Between'],
            ['Film', 'After'],
        ]);
        expect(container.textContent).toContain('Rows');
        expect(container.querySelector(`.lg\\:grid-cols-3 img[src="${STILL}"]`)).not.toBeNull();
        expect(container.querySelector(`.grid-cols-1 img[src="${MEDIA}sheets-chart.webp"]`)).not.toBeNull();
    });
});

const PAGE = [
    'Intro',
    '::: carousel caption="The *budget*"\n![A table](/a.webp)\n![A film](/data/about/media/sheets-hero)\n:::',
    '::: video src="/data/about/media/sheets-chart" caption="A bar grows"\n:::',
    'Outro',
].join('\n\n');

describe('prerender', () => {
    test('the server markup holds every slide with its alt text and captions, and no film that starts itself', () => {
        const page = document.createElement('div');
        page.innerHTML = renderToString(<ArticleContent body={renderMarkdown(PAGE)} />);
        expect(page.querySelector('.media-carousel-slide img[src="/a.webp"][alt="A table"]')).not.toBeNull();
        const captions = Array.from(page.querySelectorAll('figcaption'), (caption) => caption.innerHTML);
        expect(captions).toEqual(['A table', 'A film', 'The <em>budget</em>', 'A bar grows']);
        expect(page.querySelector('.media-carousel-strip')?.getAttribute('aria-label')).toBe('The budget');
        expect(page.querySelectorAll('.media-carousel-dot[aria-label="Slide 2 of 2"]').length).toBe(1);
        expect(page.querySelector('.media-carousel-prev')?.hasAttribute('disabled')).toBe(true);
        const videos = Array.from(page.querySelectorAll('video'));
        expect(videos.map((video) => video.getAttribute('poster'))).toEqual([
            '/data/about/media/sheets-hero.webp',
            '/data/about/media/sheets-chart.webp',
        ]);
        for (const video of videos) {
            expect(['muted', 'loop', 'playsinline'].every((name) => video.hasAttribute(name))).toBe(true);
            expect(['autoplay', 'controls'].some((name) => video.hasAttribute(name))).toBe(false);
            expect(Array.from(video.querySelectorAll('source'), (source) => source.getAttribute('type'))).toEqual([
                'video/mp4; codecs="av01.0.08M.08"',
                'video/mp4',
            ]);
        }
        expect(page.querySelector('.media-video source')?.getAttribute('src')).toBe(
            '/data/about/media/sheets-chart.av1.mp4',
        );
    });

    test('the first client render is the server markup, also for a reader who asked for less motion', async () => {
        const element = <ArticleContent body={renderMarkdown(PAGE)} />;
        const page = document.createElement('div');
        page.innerHTML = renderToString(element);
        stubReducedMotion(true);
        document.body.append(page);
        const complaints = spyOn(console, 'error');
        const mismatches: unknown[] = [];
        const root = await act(async () =>
            hydrateRoot(page, element, { onRecoverableError: (error) => mismatches.push(error) }),
        );
        try {
            expect(mismatches).toEqual([]);
            expect(complaints).not.toHaveBeenCalled();
            expect(page.querySelector('video')?.controls).toBe(true);
        } finally {
            complaints.mockRestore();
            await act(async () => root.unmount());
            page.remove();
        }
    });
});
