// Pasted HTML is fitted to the doc it lands in before the schema parses it. Every docs editor's paste and its docs
// copies run through cleanPastedHTML, with the page map of the doc they land in.

import { bundledFontOfStack, DOCUMENT_FONT_SIZE, getFontFamily } from '@workspace/lib/constants/fonts';
import type { PageSetup } from '@workspace/lib/docs/eigendoc';
import { FOOTNOTE_SELECTOR, ITALIC_HEADING_SELECTOR, unwrapRenderedMath } from '@workspace/lib/docs/eigendoc';

// A figure or a chart in front of or behind the text.
const POSITIONED = '[data-layout="front"], [data-layout="behind"]';

// Pasted HTML before the schema parses it: a drawn equation as its <math> alone, foreign fonts onto the bundled ones,
// no font or size the doc draws already, images, charts and tables no wider than the column, no anchor for a comment
// card this document lacks, in an italic heading an upright run as the mark, and no footnote where none goes. A
// positioned image or chart keeps to the paper instead: its width, its offset from the left, and below the page's top.
// Its paragraph's place isn't known here, so an indented one may overhang by its indent until it is dragged.
// page: the doc's page map in px. normalFont: the doc's Normal font.
export function cleanPastedHTML(
    html: string,
    page: PageSetup,
    cardIds: ReadonlySet<string>,
    normalFont: string,
    footnotes = true,
): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const column = page.width - page.margin.left - page.margin.right;
    const capOf = (el: Element) => (el.closest(POSITIONED) ? page.width : column);
    unwrapRenderedMath(doc.body);

    // A band's schema has no footnote, whose note belongs to the body's text: its paragraphs would land as the band's.
    if (!footnotes) for (const note of doc.querySelectorAll(FOOTNOTE_SELECTOR)) note.remove();

    for (const el of doc.querySelectorAll('[data-comment-id]')) {
        if (!cardIds.has(el.getAttribute('data-comment-id') ?? '')) el.removeAttribute('data-comment-id');
    }

    // A text's look is its nearest font-style; document order visits a parent before its children.
    for (const heading of doc.querySelectorAll<HTMLElement>(ITALIC_HEADING_SELECTOR)) {
        const upright = new Map<Node | null, boolean>();
        const runs: Text[] = [];
        const walker = doc.createTreeWalker(heading, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
        for (let node: Node | null = heading; node; node = walker.nextNode()) {
            const inherited = upright.get(node.parentNode) ?? false;
            if (node instanceof Text) {
                if (inherited) runs.push(node);
            } else if (node instanceof HTMLElement && node.style.fontStyle) {
                upright.set(node, node.style.fontStyle === 'normal');
                node.style.fontStyle = '';
            } else upright.set(node, inherited);
        }
        for (const text of runs) {
            const em = doc.createElement('em');
            text.replaceWith(em);
            em.append(text);
        }
    }

    // data-pm-slice marks a copy from any ProseMirror editor, Eigen's included: such an editor writes the sizes its
    // runs carry, not its body's on every span as Google Docs does, so its sizes are kept.
    const pmCopy = doc.querySelector('[data-pm-slice]') !== null;
    for (const el of doc.querySelectorAll<HTMLElement>('[style]')) {
        // The Normal's font needs no mark; any other, Inter in a Times doc too, keeps one.
        const font = bundledFontOfStack(el.style.fontFamily);
        el.style.fontFamily = font && font !== normalFont ? getFontFamily(font) : '';
        // Google Docs writes a size on every span: its body's, which is the doc's, and in a heading the heading's,
        // which the doc's heading draws as its own.
        if (!pmCopy && (el.style.fontSize === `${DOCUMENT_FONT_SIZE}pt` || el.closest('h1, h2, h3, h4, h5, h6')))
            el.style.fontSize = '';
    }

    for (const el of doc.querySelectorAll<HTMLElement>('img, table')) {
        const styleWidth = el.style.width.endsWith('px') ? Number.parseInt(el.style.width, 10) || 0 : 0;
        const width = Number.parseInt(el.getAttribute('width') ?? '', 10) || styleWidth;
        const maxWidth = capOf(el);
        if (width > maxWidth) {
            el.setAttribute('width', String(Math.round(maxWidth)));
            el.style.width = `${Math.round(maxWidth)}px`;
        }
    }

    // A chart keeps its shape, as it has no aspect ratio of its own to restore it from.
    for (const el of doc.querySelectorAll<HTMLElement>('span.chart')) {
        const width = Number(el.getAttribute('data-width'));
        const height = Number(el.getAttribute('data-height'));
        const maxWidth = capOf(el);
        if (width > maxWidth) {
            el.setAttribute('data-width', String(Math.round(maxWidth)));
            el.setAttribute('data-height', String(Math.round((height * maxWidth) / width)));
        }
    }

    // Offsets count from the paragraph, taken as starting at the column's top left corner.
    for (const el of doc.querySelectorAll<HTMLElement>(POSITIONED)) {
        const x = Number(el.getAttribute('data-offset-x'));
        if (el.hasAttribute('data-offset-x') && Number.isFinite(x)) {
            const width = Number(el.getAttribute('data-width') ?? el.querySelector('img')?.getAttribute('width')) || 0;
            const right = Math.max(-page.margin.left, page.width - page.margin.left - width);
            el.setAttribute('data-offset-x', String(Math.max(-page.margin.left, Math.min(right, x))));
        }
        const y = Number(el.getAttribute('data-offset-y'));
        if (el.hasAttribute('data-offset-y') && Number.isFinite(y))
            el.setAttribute('data-offset-y', String(Math.max(-page.margin.top, y)));
    }

    return doc.body.innerHTML;
}
