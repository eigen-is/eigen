// Renders the site's Markdown, such as help articles, blog posts and the changelog, to HTML at build time. Each h2
// and h3 gets a slug id and a link icon, and is collected for the page's table of contents. Raw HTML passes through,
// since every source is written in this repo, each app name in the text is marked to be set in the mono font, a
// picture without alt text fails the build, each picture outside a link gets the full-screen button the site's media
// show, and a media block such as a looping video or a carousel leaves a marker, with what it shows in `media`.

import { join } from 'node:path';
import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import { splitKetNames } from '../../src/components/ket-names';
import type { MediaBlock, TocEntry } from './content-types';
import { markdownBlocks } from './markdown-blocks';

const PUBLIC_DIR = join(import.meta.dir, '..', '..', 'public');

// Lucide "link" icon, inlined so each heading gets a hover anchor that copies its link.
const ANCHOR_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

// The markup of the React media's ExpandButton, with Lucide's "maximize" icon inlined.
const EXPAND_BUTTON =
    '<button type="button" class="media-expand" aria-label="Full screen" title="Full screen"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg></button>';

// A GitHub-style slugifier so heading ids are stable and human-readable.
function slugify(text: string): string {
    return text
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-');
}

// `pageBlocks` names the blocks the page draws itself, such as `apps` on the About overview.
export function renderMarkdown(
    markdown: string,
    pageBlocks: ReadonlySet<string> = new Set(),
): { html: string; toc: TocEntry[]; media: MediaBlock[] } {
    const toc: TocEntry[] = [];
    const media: MediaBlock[] = [];
    const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
    md.use(markdownBlocks, { publicDir: PUBLIC_DIR, pageBlocks, media });
    md.use(anchor, {
        slugify,
        level: [2, 3],
        permalink: anchor.permalink.linkInsideHeader({
            symbol: ANCHOR_ICON,
            class: 'heading-anchor',
            placement: 'after',
            ariaHidden: false,
            renderAttrs: () => ({ 'aria-label': 'Copy link to this section', title: 'Copy link to this section' }),
        }),
        callback: (token, { slug, title }) => {
            const level = token.tag === 'h2' ? 2 : 3;
            toc.push({ id: slug, text: title, level });
        },
    });
    // App names in text get the mono class. A bare URL that linkify made a link shows as text, but stays as written.
    md.renderer.rules.text = (tokens, idx) => {
        const { content } = tokens[idx];
        if (tokens[idx - 1]?.markup === 'linkify') return md.utils.escapeHtml(content);
        return splitKetNames(content)
            .map((part, i) => (i % 2 ? `<span class="ket-name">${part}</span>` : md.utils.escapeHtml(part)))
            .join('');
    };
    // A picture needs alt text for a screen reader, and the lightbox shows it as the title. A picture in a link
    // follows the link, so it gets no button, and a button can't sit inside a link anyway.
    const renderImage = md.renderer.rules.image;
    md.renderer.rules.image = (tokens, idx, options, env, self) => {
        if (!tokens[idx].content.trim()) throw new Error(`A picture needs alt text: ${tokens[idx].attrGet('src')}`);
        const image = renderImage
            ? renderImage(tokens, idx, options, env, self)
            : self.renderToken(tokens, idx, options);
        const link = tokens
            .slice(0, idx)
            .findLast((token) => token.type === 'link_open' || token.type === 'link_close');
        if (link?.type === 'link_open') return image;
        return `<span class="media-frame">${image}${EXPAND_BUTTON}</span>`;
    };

    return { html: md.render(markdown), toc, media };
}
