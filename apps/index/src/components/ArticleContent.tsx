import { useMemo } from 'react';
import type { ArticleBody } from '../content/manifest';
import { MediaGrid } from './MediaGrid';

type ArticleContentProps = { body: ArticleBody; className?: string };

// Splits rendered HTML on the <p>[MEDIAGRID:N]</p> markers left by the build,
// rendering the HTML chunks statically and the grids as hydrated islands.
export function ArticleContent({ body, className }: ArticleContentProps) {
    const parts = useMemo(() => {
        const segments: Array<{ html: string } | { grid: number }> = [];
        const regex = /<p>\[MEDIAGRID:(\d+)\]<\/p>/g;
        let last = 0;
        let match: RegExpExecArray | null;
        match = regex.exec(body.html);
        while (match !== null) {
            segments.push({ html: body.html.slice(last, match.index) });
            segments.push({ grid: Number(match[1]) });
            last = match.index + match[0].length;
            match = regex.exec(body.html);
        }
        segments.push({ html: body.html.slice(last) });
        return segments;
    }, [body.html]);

    return (
        <div className={className}>
            {parts.map((part, i) => {
                if ('grid' in part) {
                    const grid = body.mediaGrids[part.grid];
                    return grid ? <MediaGrid key={i} columns={grid.columns} items={grid.items} /> : null;
                }
                if (!part.html) return null;
                // biome-ignore lint/security/noDangerouslySetInnerHtml: build-time-rendered trusted Markdown
                return <div key={i} dangerouslySetInnerHTML={{ __html: part.html }} />;
            })}
        </div>
    );
}
