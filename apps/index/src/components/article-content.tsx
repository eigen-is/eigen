// The rendered body of an article, a post or the changelog, in the site's prose style. The build leaves the HTML
// and a marker for each media grid, so this draws the HTML as it is and each grid as a component, and lets a
// click on a heading with a link icon copy the link. Every page of the public site that shows Markdown uses it.

import { copyToClipboard } from '@workspace/lib/clipboard';
import { cn } from '@workspace/ui/lib/utils';
import type { MouseEvent } from 'react';
import { useMemo } from 'react';
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

    // A click on a heading that shows its link icon copies a link to that section instead of jumping to it. A drag that
    // selects text, a link in the heading's text and a touch screen, where the icon is hidden, are left alone.
    const copyHeadingLink = (e: MouseEvent<HTMLDivElement>) => {
        if (!(e.target instanceof Element) || !window.getSelection()?.isCollapsed) return;
        const link = e.target.closest('a');
        if (link && !link.classList.contains('heading-anchor')) return;
        const anchor = e.target.closest('h2, h3')?.querySelector('a.heading-anchor');
        if (!anchor || getComputedStyle(anchor).display === 'none') return;
        e.preventDefault();
        const id = anchor.getAttribute('href')?.slice(1) ?? '';
        copyToClipboard(`${location.origin}${location.pathname}#${id}`, 'Link copied to clipboard');
    };

    return (
        <div className={cn('eigen-prose site-prose', className)} onClick={copyHeadingLink}>
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
