import { afterEach, describe, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { renderInDocument } from '@workspace/ui/test/render-in-document';

installHappyDom();

const { act } = await import('react');
const { ArticleContent } = await import('../../components/article-content');
const { renderMarkdown } = await import('../../../scripts/lib/render-markdown');

const RealMatchMedia = globalThis.matchMedia;
afterEach(() => {
    globalThis.matchMedia = RealMatchMedia;
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

// A three-image carousel from the real build. happy-dom lays nothing out, so each slide gets its place 600px apart.
async function renderCarousel() {
    const { html } = renderMarkdown('::: carousel\n![a](/a.webp)\n![b](/b.webp)\n![c](/c.webp)\n:::');
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
    return { strip, prev, next, dots, scrollTo, current };
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
