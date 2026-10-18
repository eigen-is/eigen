import { bundledFontOfStack, DOCUMENT_FONT, getFontFamily } from '@workspace/lib/constants/fonts';
import { ITALIC_HEADING_SELECTOR } from '@workspace/lib/docs/eigendoc';

// Pasted HTML before the schema parses it: foreign fonts onto the bundled ones, images and tables no wider than the
// column, no anchor for a comment card this document lacks, and in an italic heading an upright run as the mark.
export function cleanPastedHTML(html: string, maxWidth: number, cardIds: ReadonlySet<string>): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');

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

    for (const el of doc.querySelectorAll<HTMLElement>('[style]')) {
        // The document font needs no mark.
        const font = bundledFontOfStack(el.style.fontFamily);
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
