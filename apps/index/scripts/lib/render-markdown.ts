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
    md.use(anchor, { slugify, level: [2, 3] });

    const tokens = md.parse(markdown, {});
    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.type !== 'heading_open') continue;
        const level = token.tag === 'h2' ? 2 : token.tag === 'h3' ? 3 : 0;
        if (level === 0) continue;
        const inline = tokens[i + 1];
        const text = inline?.content ?? '';
        toc.push({ id: slugify(text), text, level });
    }

    return { html: md.render(markdown), toc };
}
