import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
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

// Render Markdown to HTML and collect the h2/h3 headings for the on-this-page TOC.
// `html: true` keeps trusted inline HTML in articles (content is authored in-repo).
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

    return { html: md.render(markdown), toc };
}
