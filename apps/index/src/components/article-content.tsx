// The rendered body of an article, a post or the changelog, on every page that shows Markdown. The build leaves the
// HTML with a marker for each media grid and each block the page draws itself, such as the About overview's app rows,
// so this draws the HTML in the site's prose style and each marker as a component, the page's own blocks outside the
// prose. It wires the heading links, the carousels (buttons, dots, autoplay) and the lightbox, and plays the looping
// videos in view unless the reader asked for less motion.

import { copyToClipboard } from '@workspace/lib/clipboard';
import type { MouseEvent, ReactNode } from 'react';
import { Fragment, useEffect, useRef, useState } from 'react';
import type { ArticleBody } from '../content/manifest';
import { MediaGrid } from './media-grid';
import type { LightboxItem } from './media-lightbox';
import { MediaLightbox } from './media-lightbox';

// `blocks` holds what each of the page's own blocks shows, by name, such as `apps` for `::: apps`.
type ArticleContentProps = { body: ArticleBody; blocks?: Readonly<Record<string, ReactNode>>; className?: string };

export function ArticleContent({ body, blocks, className }: ArticleContentProps) {
    const ref = useRef<HTMLDivElement>(null);
    const [lightbox, setLightbox] = useState<{ items: LightboxItem[]; index: number; open: boolean }>({
        items: [],
        index: 0,
        open: false,
    });

    // The build writes no autoplay, so a loop never moves before hydration for a reader who asked for less motion.
    // Scroll does not bubble, so the root hears each carousel strip's in the capture phase.
    useEffect(() => {
        const root = ref.current;
        if (!root) return;
        const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
        const playVideos = () => playVideosInView(root, reduceMotion.matches);
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
            playVideosInView(carousel, reduceMotion.matches);
        };
        // An autoplay carousel waits while the reader points at it or is inside it. It remembers the slide it scrolled
        // to, so a strip on any other slide is the reader's doing, and it stops for good.
        const timers: ReturnType<typeof setInterval>[] = [];
        for (const carousel of root.querySelectorAll('.media-carousel[data-autoplay]')) {
            const strip = carousel.querySelector('.media-carousel-strip');
            if (!strip) continue;
            let shown = 0;
            const timer = setInterval(() => {
                if (reduceMotion.matches || document.hidden || carousel.matches(':hover, :focus-within')) return;
                const { pitch, current } = carouselPosition(strip);
                if (current !== shown) return clearInterval(timer);
                shown = (current + 1) % strip.children.length;
                strip.scrollTo({ left: shown * pitch });
            }, AUTOPLAY_MS);
            timers.push(timer);
        }
        playVideos();
        reduceMotion.addEventListener('change', playVideos);
        root.addEventListener('scroll', onScroll, true);
        return () => {
            reduceMotion.removeEventListener('change', playVideos);
            root.removeEventListener('scroll', onScroll, true);
            for (const timer of timers) clearInterval(timer);
        };
    }, [body.html]);

    // A heading copies its link only where its icon shows, as touch screens hide it, and never over a selection.
    const onClick = (e: MouseEvent) => {
        if (!(e.target instanceof Element)) return;
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
        const grid = e.target.closest<HTMLElement>('[data-grid]');
        const thumbnail = e.target.closest('button');
        if (grid && thumbnail) {
            const { items } = body.mediaGrids[Number(grid.dataset.grid)];
            setLightbox({ items, index: Array.from(grid.querySelectorAll('button')).indexOf(thumbnail), open: true });
            return;
        }
        const media = e.target.closest('.site-prose :is(img, figure video)');
        if (media && !media.closest('a, button')) {
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

    // The lightbox sits outside the root, so React passes no click in its portaled dialog up to onClick.
    return (
        <>
            <div ref={ref} className={className} onClick={onClick}>
                {body.html.split(BLOCK_MARKER).map((section, i) => {
                    if (i % 2) return <Fragment key={i}>{blocks?.[section]}</Fragment>;
                    if (!section) return null;
                    return (
                        <div key={i} className="eigen-prose site-prose">
                            {section.split(GRID_MARKER).map((part, j) => {
                                if (j % 2) {
                                    return (
                                        <div key={j} data-grid={part}>
                                            <MediaGrid {...body.mediaGrids[Number(part)]} />
                                        </div>
                                    );
                                }
                                if (!part) return null;
                                // Safe: build-time-rendered HTML from trusted, in-repo Markdown.
                                return <div key={j} dangerouslySetInnerHTML={{ __html: part }} />;
                            })}
                        </div>
                    );
                })}
            </div>
            <MediaLightbox
                {...lightbox}
                onIndexChange={(index) => setLightbox((current) => ({ ...current, index }))}
                onOpenChange={(open) => setLightbox((current) => ({ ...current, open }))}
            />
        </>
    );
}

// The build's markers for a block the page draws, such as `apps`, and for a media grid, by its number. Split on
// them, the pieces at odd places are the captured names and numbers.
const BLOCK_MARKER = /<p>\[BLOCK:([\w-]+)\]<\/p>/;
const GRID_MARKER = /<p>\[MEDIAGRID:(\d+)\]<\/p>/;

const AUTOPLAY_MS = 7000;

// The slides of a strip lie one pitch apart, so its scroll offset over the pitch is the slide in view.
function carouselPosition(strip: Element) {
    const [first, second] = strip.querySelectorAll<HTMLElement>('.media-carousel-slide');
    const pitch = second ? second.offsetLeft - first.offsetLeft : strip.clientWidth;
    return { pitch, current: Math.round(strip.scrollLeft / pitch) };
}

// A looping video plays while it is in view, which in a carousel means on the slide its dots mark, and holds still
// with controls for a reader who asked for less motion.
function playVideosInView(scope: Element, reduceMotion: boolean) {
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
