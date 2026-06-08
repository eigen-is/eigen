import { copyToClipboard } from '@workspace/lib/clipboard';
import { useEffect, useMemo, useRef } from 'react';
import type { ArticleBody } from '../content/manifest';
import { MediaGrid } from './media-grid';

type ArticleContentProps = { body: ArticleBody; className?: string };

// Splits rendered HTML on the <p>[MEDIAGRID:N]</p> markers left by the build,
// rendering the HTML chunks statically and the grids as hydrated islands.
export function ArticleContent({ body, className }: ArticleContentProps) {
    const ref = useRef<HTMLDivElement>(null);

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

    // Clicking a heading's hover anchor copies a link to that section rather than
    // jumping to it. Delegated so it covers every rendered HTML chunk.
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const onClick = (e: MouseEvent) => {
            const anchor = (e.target as HTMLElement).closest('a.heading-anchor');
            if (!anchor) return;
            e.preventDefault();
            const id = anchor.getAttribute('href')?.slice(1) ?? '';
            copyToClipboard(`${location.origin}${location.pathname}#${id}`, 'Link copied to clipboard');
        };
        el.addEventListener('click', onClick);
        return () => el.removeEventListener('click', onClick);
    }, []);

    return (
        <div ref={ref} className={className}>
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
