import { bundledFont, DOCUMENT_FONT, getFontFamily } from '@workspace/lib/constants/fonts';

// Pasted HTML before the schema parses it: foreign fonts onto the bundled ones, images and tables no wider than the column.
export function cleanPastedHTML(html: string, maxWidth: number): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');

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
