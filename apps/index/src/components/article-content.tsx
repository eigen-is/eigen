// The rendered body of an article, a post or the changelog, in the site's prose style, on every page that shows
// Markdown. The build leaves the HTML with a marker for each media grid and each block the page draws itself, such as
// the About overview's app rows, so this draws the HTML as it is and each marker as a component. It wires the heading
// links, the carousels (buttons, dots, autoplay) and the lightbox, and plays the looping videos in view unless the
// reader asked for less motion.

import { copyToClipboard } from '@workspace/lib/clipboard';
import { cn } from '@workspace/ui/lib/utils';
import type { MouseEvent, ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ArticleBody } from '../content/manifest';
import { MediaGrid } from './media-grid';
import type { LightboxItem } from './media-lightbox';
import { MediaLightbox } from './media-lightbox';

// `blocks` holds what each of the page's own blocks shows, by name, such as `apps` for `::: apps`.
type ArticleContentProps = { body: ArticleBody; blocks?: Readonly<Record<string, ReactNode>>; className?: string };

export function ArticleContent({ body, blocks, className }: ArticleContentProps) {
    const parts = useMemo(() => {
        const segments: Array<{ html: string } | { grid: number } | { block: string }> = [];
        const regex = /<p>\[(?:MEDIAGRID:(\d+)|BLOCK:([\w-]+))\]<\/p>/g;
        let last = 0;
        let match: RegExpExecArray | null = regex.exec(body.html);
        while (match !== null) {
            segments.push({ html: body.html.slice(last, match.index) });
            segments.push(match[2] ? { block: match[2] } : { grid: Number(match[1]) });
            last = match.index + match[0].length;
            match = regex.exec(body.html);
        }
        segments.push({ html: body.html.slice(last) });
        return segments;
    }, [body.html]);

    const ref = useRef<HTMLDivElement>(null);
    const [lightbox, setLightbox] = useState<{ items: LightboxItem[]; index: number; open: boolean }>({
        items: [],
        index: 0,
        open: false,
    });

    // The build writes no autoplay, so a loop never moves before hydration for a reader who asked for less motion.
    useEffect(() => {
        const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
        const startVideos = () => {
            if (ref.current) playVideosInView(ref.current);
        };
        startVideos();
        reduceMotion.addEventListener('change', startVideos);
        return () => reduceMotion.removeEventListener('change', startVideos);
    }, [body.html]);

    // An autoplay carousel waits while the reader points at it or is inside it, or the tab is hidden, and stops for
    // good once they use it: a click, a key, or a sideways wheel or swipe. An upright one only scrolls the page past.
    useEffect(() => {
        const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
        const done = new AbortController();
        const timers: ReturnType<typeof setInterval>[] = [];
        for (const carousel of ref.current?.querySelectorAll<HTMLElement>('.media-carousel[data-autoplay]') ?? []) {
            const strip = carousel.querySelector('.media-carousel-strip');
            if (!strip) continue;
            let pointedAt = false;
            const timer = setInterval(() => {
                if (reduceMotion.matches || document.hidden || pointedAt || carousel.contains(document.activeElement)) {
                    return;
                }
                const { pitch, current } = carouselPosition(strip);
                strip.scrollTo({ left: ((current + 1) % strip.children.length) * pitch });
            }, AUTOPLAY_MS);
            timers.push(timer);
            const { signal } = done;
            carousel.addEventListener('mouseenter', () => (pointedAt = true), { signal });
            carousel.addEventListener('mouseleave', () => (pointedAt = false), { signal });
            const stop = () => clearInterval(timer);
            carousel.addEventListener('click', stop, { signal });
            carousel.addEventListener('keydown', stop, { signal });
            const sideways = (x: number, y: number) => Math.abs(x) > Math.abs(y);
            carousel.addEventListener('wheel', (e) => sideways(e.deltaX, e.deltaY) && stop(), { signal });
            let touchStart = { clientX: 0, clientY: 0 };
            carousel.addEventListener('touchstart', (e) => (touchStart = e.touches[0]), { signal });
            carousel.addEventListener(
                'touchmove',
                (e) =>
                    sideways(e.touches[0].clientX - touchStart.clientX, e.touches[0].clientY - touchStart.clientY) &&
                    stop(),
                { signal },
            );
        }
        return () => {
            done.abort();
            for (const timer of timers) clearInterval(timer);
        };
    }, [body.html]);

    // Scroll does not bubble, so the root hears each carousel strip's in the capture phase.
    useEffect(() => {
        const root = ref.current;
        const onScroll = (e: Event) => {
            const strip = e.target;
            if (!(strip instanceof Element) || !strip.matches('.media-carousel-strip')) return;
            const carousel = strip.closest('.media-carousel');
            if (!carousel) return;
            const { current } = carouselPosition(strip);
            const dots = carousel.querySelectorAll('.media-carousel-dot');
            for (const [i, dot] of dots.entries()) {
                if (i === current) dot.setAttribute('aria-current', 'true');
                else dot.removeAttribute('aria-current');
            }
            for (const button of carousel.querySelectorAll<HTMLButtonElement>('.media-carousel-steps button')) {
                button.disabled = button.matches('.media-carousel-prev') ? current <= 0 : current >= dots.length - 1;
            }
            playVideosInView(carousel);
        };
        root?.addEventListener('scroll', onScroll, true);
        return () => root?.removeEventListener('scroll', onScroll, true);
    }, []);

    // React passes up clicks from a portaled dialog, such as the lightbox, so only the page's own count. A heading
    // copies its link only where its icon shows, as touch screens hide it, and never over a selection.
    const onClick = (e: MouseEvent<HTMLDivElement>) => {
        if (!(e.target instanceof Element) || !e.currentTarget.contains(e.target)) return;
        const control = e.target.closest('.media-carousel-nav button');
        const carousel = control?.closest('.media-carousel');
        const strip = carousel?.querySelector('.media-carousel-strip');
        if (control && carousel && strip) {
            const { pitch, current } = carouselPosition(strip);
            let slide = Array.from(carousel.querySelectorAll('.media-carousel-dot')).indexOf(control);
            if (control.matches('.media-carousel-prev')) slide = current - 1;
            if (control.matches('.media-carousel-next')) slide = current + 1;
            strip.scrollTo({ left: slide * pitch });
            return;
        }
        const media = e.target.closest('img, figure video');
        if (media && !media.closest('a, button, .not-prose')) {
            const group = Array.from(media.closest('.media-carousel-strip')?.querySelectorAll('img, video') ?? [media]);
            setLightbox({ items: group.map(lightboxItem), index: group.indexOf(media), open: true });
            return;
        }
        if (!window.getSelection()?.isCollapsed) return;
        const link = e.target.closest('a');
        if (link && !link.classList.contains('heading-anchor')) return;
        const anchor = e.target.closest('h2, h3')?.querySelector('a.heading-anchor');
        if (!anchor || getComputedStyle(anchor).display === 'none') return;
        e.preventDefault();
        const id = anchor.getAttribute('href')?.slice(1) ?? '';
        copyToClipboard(`${location.origin}${location.pathname}#${id}`, 'Link copied to clipboard');
    };

    return (
        <div ref={ref} className={cn('eigen-prose site-prose', className)} onClick={onClick}>
            {parts.map((part, i) => {
                if ('block' in part) return <div key={i}>{blocks?.[part.block]}</div>;
                if ('grid' in part) {
                    const grid = body.mediaGrids[part.grid];
                    return grid ? <MediaGrid key={i} columns={grid.columns} items={grid.items} /> : null;
                }
                if (!part.html) return null;
                // Safe: build-time-rendered HTML from trusted, in-repo Markdown.
                return <div key={i} dangerouslySetInnerHTML={{ __html: part.html }} />;
            })}
            <MediaLightbox
                {...lightbox}
                onIndexChange={(index) => setLightbox((current) => ({ ...current, index }))}
                onOpenChange={(open) => setLightbox((current) => ({ ...current, open }))}
            />
        </div>
    );
}

const AUTOPLAY_MS = 7000;

// The slides of a strip lie one pitch apart, so its scroll offset over the pitch is the slide in view.
function carouselPosition(strip: Element) {
    const [first, second] = strip.querySelectorAll<HTMLElement>('.media-carousel-slide');
    const pitch = second ? second.offsetLeft - first.offsetLeft : strip.clientWidth;
    return { pitch, current: Math.round(strip.scrollLeft / pitch) };
}

// A looping video plays while it is in view, which in a carousel means on the slide its dots mark, and holds still
// with controls for a reader who asked for less motion.
function playVideosInView(scope: Element) {
    const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const video of scope.querySelectorAll<HTMLVideoElement>('figure video')) {
        const carousel = video.closest('.media-carousel');
        const dots = Array.from(carousel?.querySelectorAll('.media-carousel-dot') ?? []);
        const current = dots.findIndex((dot) => dot.hasAttribute('aria-current'));
        const inView = !carousel || carousel.querySelectorAll('.media-carousel-slide')[current]?.contains(video);
        video.controls = reduceMotion;
        if (reduceMotion || !inView) video.pause();
        else
            video.play().catch(() => {
                video.controls = true;
            });
    }
}

// A picture keeps its alt text as its caption; a looping video takes its block's or its slide's caption, and plays
// the file the browser picked from its sources.
function lightboxItem(media: Element): LightboxItem {
    if (media instanceof HTMLVideoElement) {
        const caption = media.closest('figure')?.querySelector('figcaption')?.textContent ?? undefined;
        return { type: 'video', src: media.currentSrc, poster: media.poster, caption, loop: true };
    }
    return { type: 'image', src: media.getAttribute('src') ?? '', caption: media.getAttribute('alt') ?? undefined };
}
