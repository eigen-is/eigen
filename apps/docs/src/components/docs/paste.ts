import { bundledFont, DOCUMENT_FONT, getFontFamily } from '@workspace/lib/constants/fonts';
import { ITALIC_HEADING_LEVELS } from '@workspace/lib/docs/eigendoc';

export const ITALIC_HEADINGS = [...ITALIC_HEADING_LEVELS].map((level) => `h${level}`).join(', ');

// Pasted HTML before the schema parses it: foreign fonts onto the bundled ones, images and tables no wider than the
// column, no comment anchor for a card this document's map lacks, as one copied from another document, and in a
// heading that draws italic, which draws an italic mark upright, a run spelled upright as the mark and none italic.
export function cleanPastedHTML(html: string, maxWidth: number, cardIds: ReadonlySet<string>): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    for (const el of doc.querySelectorAll('[data-comment-id]')) {
        if (!cardIds.has(el.getAttribute('data-comment-id') ?? '')) el.removeAttribute('data-comment-id');
    }

    // A text's look is its nearest font-style; document order visits a parent before its children.
    for (const heading of ITALIC_HEADINGS ? doc.querySelectorAll<HTMLElement>(ITALIC_HEADINGS) : []) {
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

    for (const el of doc.querySelectorAll<HTMLElement>('[style]')) {
        const font = bundledFont(el.style.fontFamily.replace(/['"]/g, ''));
        // The document font needs no mark.
        el.style.fontFamily = font && font !== DOCUMENT_FONT ? getFontFamily(font) : '';
    }

    for (const el of doc.querySelectorAll<HTMLElement>('img, table')) {
        const styleWidth = el.style.width.endsWith('px') ? Number.parseInt(el.style.width, 10) || 0 : 0;
        const width = Number.parseInt(el.getAttribute('width') ?? '', 10) || styleWidth;
        if (width > maxWidth) {
            el.setAttribute('width', String(Math.round(maxWidth)));
            el.style.width = `${Math.round(maxWidth)}px`;
        }
    }

    return doc.body.innerHTML;
}
