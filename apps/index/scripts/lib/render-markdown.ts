// Renders the site's Markdown, such as help articles, blog posts and the changelog, to HTML at build time. Each h2
// and h3 gets a slug id and a link icon, and is collected for the page's table of contents. Raw HTML passes through,
// since every source is written in this repo, and each app name in the text is marked to be set in the mono font.

import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import { splitKetNames } from '../../src/components/ket-names';
import type { TocEntry } from './content-types';

// Lucide "link" icon, inlined so each heading gets a hover anchor that copies its link.
const ANCHOR_ICON =
    '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';

// A GitHub-style slugifier so heading ids are stable and human-readable.
function slugify(text: string): string {
    return text
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-');
}

export function renderMarkdown(markdown: string): { html: string; toc: TocEntry[] } {
    const toc: TocEntry[] = [];
    const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
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

    return { html: md.render(markdown), toc };
}
