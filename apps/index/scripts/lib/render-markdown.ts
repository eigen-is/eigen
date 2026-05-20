import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import type { TocEntry } from './content-types';

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
        callback: (token, { slug, title }) => {
            const level = token.tag === 'h2' ? 2 : 3;
            toc.push({ id: slug, text: title, level });
        },
    });

    return { html: md.render(markdown), toc };
}
