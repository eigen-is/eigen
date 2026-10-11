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

    for (const heading of doc.querySelectorAll<HTMLElement>(ITALIC_HEADINGS)) {
        for (const el of [heading, ...heading.querySelectorAll<HTMLElement>('[style]')]) {
            const upright = el.style.fontStyle === 'normal';
            el.style.fontStyle = '';
            if (upright) {
                const em = doc.createElement('em');
                em.append(...el.childNodes);
                el.append(em);
            }
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
