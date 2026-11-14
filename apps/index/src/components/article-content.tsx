// The rendered body of an article, a post or the changelog, in the site's prose style. The build leaves the HTML
// and a marker for each media grid, so this draws the HTML as it is and each grid as a component. It lets a click
// on a heading with a link icon copy the link, a carousel's buttons and dots page its images, and a picture or film
// open bigger in the lightbox. It keeps a carousel's dots in step with its strip as it scrolls, and starts the
// looping videos unless the reader asked for less motion. Every page of the public site that shows Markdown uses it.

import { copyToClipboard } from '@workspace/lib/clipboard';
import { cn } from '@workspace/ui/lib/utils';
import type { MouseEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ArticleBody } from '../content/manifest';
import { MediaGrid } from './media-grid';
import type { LightboxItem } from './media-lightbox';
import { MediaLightbox } from './media-lightbox';

type ArticleContentProps = { body: ArticleBody; className?: string };

export function ArticleContent({ body, className }: ArticleContentProps) {
    const parts = useMemo(() => {
        const segments: Array<{ html: string } | { grid: number }> = [];
        const regex = /<p>\[MEDIAGRID:(\d+)\]<\/p>/g;
        let last = 0;
        let match: RegExpExecArray | null = regex.exec(body.html);
        while (match !== null) {
            segments.push({ html: body.html.slice(last, match.index) });
            segments.push({ grid: Number(match[1]) });
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
            for (const video of ref.current?.querySelectorAll<HTMLVideoElement>('.media-video video') ?? []) {
                video.controls = reduceMotion.matches;
                if (reduceMotion.matches) video.pause();
                else
                    video.play().catch(() => {
                        video.controls = true;
                    });
            }
        };
        startVideos();
        reduceMotion.addEventListener('change', startVideos);
        return () => reduceMotion.removeEventListener('change', startVideos);
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
        const media = e.target.closest('img, .media-video video');
        if (media && !media.closest('a, button')) {
            const group = Array.from(media.closest('.media-carousel-strip')?.querySelectorAll('img') ?? [media]);
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

// The slides of a strip lie one pitch apart, so its scroll offset over the pitch is the slide in view.
function carouselPosition(strip: Element) {
    const [first, second] = strip.querySelectorAll<HTMLElement>('.media-carousel-slide');
    const pitch = second ? second.offsetLeft - first.offsetLeft : strip.clientWidth;
    return { pitch, current: Math.round(strip.scrollLeft / pitch) };
}

// A picture keeps its alt text as its caption; a looping video takes its block's caption, and plays the file the
// browser picked from its sources.
function lightboxItem(media: Element): LightboxItem {
    if (media instanceof HTMLVideoElement) {
        const caption = media.closest('figure')?.querySelector('figcaption')?.textContent ?? undefined;
        return { type: 'video', src: media.currentSrc, poster: media.poster, caption, loop: true };
    }
    return { type: 'image', src: media.getAttribute('src') ?? '', caption: media.getAttribute('alt') ?? undefined };
}
