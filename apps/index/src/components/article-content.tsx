// The rendered body of an article, a post or the changelog, in the site's prose style. The build leaves the HTML
// and a marker for each media grid, so this draws the HTML as it is and each grid as a component. It lets a click
// on a heading with a link icon copy the link and a carousel's buttons page its images, and starts the looping
// videos unless the reader asked for less motion. Every page of the public site that shows Markdown uses it.

import { copyToClipboard } from '@workspace/lib/clipboard';
import { cn } from '@workspace/ui/lib/utils';
import type { MouseEvent } from 'react';
import { useEffect, useMemo, useRef } from 'react';
import type { ArticleBody } from '../content/manifest';
import { MediaGrid } from './media-grid';

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

    // A carousel button pages by the strip's own width, since each image fills it.
    // A heading copies its link only where its icon shows, as touch screens hide it, and never over a selection.
    const onClick = (e: MouseEvent<HTMLDivElement>) => {
        if (!(e.target instanceof Element)) return;
        const step = e.target.closest('.media-carousel-prev, .media-carousel-next');
        if (step) {
            const strip = step.closest('figure')?.querySelector('.media-carousel-strip');
            if (!strip) return;
            const width = step.classList.contains('media-carousel-prev') ? -strip.clientWidth : strip.clientWidth;
            strip.scrollBy({ left: width });
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
        </div>
    );
}
