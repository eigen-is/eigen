// Pasted HTML is fitted to the doc it lands in before the schema parses it. Every docs editor's paste and its docs
// copies run through cleanPastedHTML, with the page map of the doc they land in. The body's parsed paste then runs
// through withFreshStoryIds, so a copy of a note or a text box never shares its source's id.

import type { JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Slice } from '@tiptap/pm/model';
import { bundledFontOfStack, DOCUMENT_FONT_SIZE, getFontFamily } from '@workspace/lib/constants/fonts';
import type { PageSetup } from '@workspace/lib/docs/eigendoc';
import {
    FOOTNOTE_SELECTOR,
    heightAtWidth,
    ITALIC_HEADING_SELECTOR,
    isStoryNode,
    keepOnPaper,
    newStoryId,
    POSITIONED_SELECTOR,
    pageColumnWidth,
    unwrapRenderedMath,
} from '@workspace/lib/docs/eigendoc';

// Fits pasted HTML to the doc it lands in, before the schema parses it. A drawn equation keeps only its <math>. Fonts
// map onto the bundled ones, and a font or size the doc already draws goes. Images, charts and tables get no wider than
// the column, keeping their shape. A comment anchor goes when this doc lacks its card, and a footnote goes where none
// can sit. A positioned image or chart keeps to the paper instead of the column. Its paragraph's place isn't known
// here, so an indented one may overhang by its indent until it is dragged.
export function cleanPastedHTML(
    html: string,
    page: PageSetup,
    cardIds: ReadonlySet<string>,
    normalFont: string,
    footnotes = true,
): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const column = pageColumnWidth(page);
    const capOf = (el: Element) => (el.closest(POSITIONED_SELECTOR) ? page.width : column);
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
            // A stretched picture keeps its shape.
            const height = Number.parseInt(el.getAttribute('height') ?? '', 10);
            if (height > 0) el.setAttribute('height', String(Math.round(heightAtWidth({ width, height }, maxWidth))));
        }
    }

    // A chart keeps its shape, as it has no aspect ratio of its own to restore it from.
    for (const el of doc.querySelectorAll<HTMLElement>('span.chart')) {
        const width = Number(el.getAttribute('data-width'));
        const height = Number(el.getAttribute('data-height'));
        const maxWidth = capOf(el);
        if (width > maxWidth) {
            el.setAttribute('data-width', String(Math.round(maxWidth)));
            el.setAttribute('data-height', String(Math.round(heightAtWidth({ width, height }, maxWidth))));
        }
    }

    // Offsets count from the paragraph, taken as starting at the column's top left corner.
    const corner = { left: page.margin.left, top: page.margin.top };
    for (const el of doc.querySelectorAll<HTMLElement>(POSITIONED_SELECTOR)) {
        const x = Number(el.getAttribute('data-offset-x'));
        const y = Number(el.getAttribute('data-offset-y'));
        const width = Number(el.getAttribute('data-width') ?? el.querySelector('img')?.getAttribute('width')) || 0;
        const { offsetX, offsetY } = keepOnPaper({ x, y, width }, corner, page.width);
        if (el.hasAttribute('data-offset-x') && Number.isFinite(x)) el.setAttribute('data-offset-x', String(offsetX));
        if (el.hasAttribute('data-offset-y') && Number.isFinite(y)) el.setAttribute('data-offset-y', String(offsetY));
    }

    return doc.body.innerHTML;
}

// A pasted note or text box whose id the doc already holds is a copy, and takes a fresh id, as does a second one with
// the same id in the paste. One the doc doesn't hold, a cut's, keeps its id, as it is the same story moved.
export function withFreshStoryIds(slice: Slice, doc: PMNode): Slice {
    const taken = new Set<unknown>();
    doc.descendants((node) => {
        if (isStoryNode(node.type.name)) taken.add(node.attrs['id']);
    });
    let renamed = false;
    const fresh = (node: JSONContent): JSONContent => {
        const content = node.content?.map(fresh);
        if (!isStoryNode(node.type)) return content ? { ...node, content } : node;
        const id = node.attrs?.['id'];
        const copy = typeof id === 'string' && taken.has(id);
        taken.add(id);
        renamed ||= copy;
        return { ...node, attrs: { ...node.attrs, ...(copy && { id: newStoryId() }) }, content };
    };
    const json = slice.toJSON();
    const content: JSONContent[] = json?.content?.map(fresh) ?? [];
    return renamed ? Slice.fromJSON(doc.type.schema, { ...json, content }) : slice;
}
