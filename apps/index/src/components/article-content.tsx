// The rendered body of an article, a post or the changelog, on every page that shows Markdown. The build leaves the
// HTML with a marker for each block a component draws: a media block, such as a carousel or a media grid, and a block
// of the page's own, such as the About overview's app rows. This draws the HTML and the media in the site's prose
// style and the page's blocks outside it, copies a heading's link on a click, and holds the page's one lightbox,
// which every picture and film opens bigger in.

import { copyToClipboard } from '@workspace/lib/clipboard';
import type { MouseEvent, ReactNode } from 'react';
import { Fragment, useState } from 'react';
import type { ArticleBody } from '../content/manifest';
import { MediaCarousel } from './media-carousel';
import { MediaGrid } from './media-grid';
import type { LightboxItem, OpenLightbox } from './media-lightbox';
import { MediaLightbox } from './media-lightbox';
import { MediaVideo } from './media-video';

// `blocks` holds what each of the page's own blocks shows, by name, such as `apps` for `::: apps`.
type ArticleContentProps = { body: ArticleBody; blocks?: Readonly<Record<string, ReactNode>>; className?: string };

export function ArticleContent({ body, blocks, className }: ArticleContentProps) {
    const [lightbox, setLightbox] = useState<{ items: readonly LightboxItem[]; index: number } | null>(null);
    const openLightbox: OpenLightbox = (items, index) => setLightbox({ items, index });

    // A picture, or its full-screen button, opens it bigger unless a link or a button holds it. A heading copies its link only where its icon
    // shows, as touch screens hide it, and never over a selection.
    const onMarkdownClick = (e: MouseEvent) => {
        if (!(e.target instanceof Element)) return;
        const image = e.target.closest('.media-frame')?.querySelector('img') ?? e.target.closest('img');
        if (image && !image.closest('a, button')) {
            openLightbox([{ type: 'image', src: image.getAttribute('src') ?? '', caption: image.alt }], 0);
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

    // One section per block of the page's own: the block, then the Markdown and the media up to the next one.
    const sections: { block?: string; prose: ReactNode[] }[] = [{ prose: [] }];
    for (const [i, piece] of body.html.split(BLOCK_MARKER).entries()) {
        const { prose } = sections[sections.length - 1];
        if (i % 2 === 0) {
            // Safe: build-time-rendered HTML from trusted, in-repo Markdown.
            if (piece)
                prose.push(<div key={i} onClick={onMarkdownClick} dangerouslySetInnerHTML={{ __html: piece }} />);
        } else if (/^\d+$/.test(piece)) {
            const media = body.media[Number(piece)];
            if (media.kind === 'grid') prose.push(<MediaGrid key={i} {...media} onOpen={openLightbox} />);
            if (media.kind === 'video') prose.push(<MediaVideo key={i} {...media} onOpen={openLightbox} />);
            if (media.kind === 'carousel') prose.push(<MediaCarousel key={i} {...media} onOpen={openLightbox} />);
        } else {
            sections.push({ block: piece, prose: [] });
        }
    }

    return (
        <>
            <div className={className}>
                {sections.map(({ block, prose }, i) => (
                    <Fragment key={i}>
                        {block && blocks?.[block]}
                        {prose.length > 0 && <div className="eigen-prose site-prose">{prose}</div>}
                    </Fragment>
                ))}
            </div>
            {lightbox && (
                <MediaLightbox
                    {...lightbox}
                    onIndexChange={(index) => setLightbox({ ...lightbox, index })}
                    onClose={() => setLightbox(null)}
                />
            )}
        </>
    );
}

// The build's marker for a block: the name of one the page draws, such as `apps`, or the number of a media block.
// Split on it, the pieces at odd places are the captured names and numbers.
const BLOCK_MARKER = /<p>\[BLOCK:([\w-]+)\]<\/p>/;
