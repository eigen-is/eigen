import { bundledFont, DOCUMENT_FONT, getFontFamily } from '@workspace/lib/constants/fonts';

// Pasted HTML before the schema parses it: foreign fonts onto the bundled ones, images and tables no wider than the column.
export function cleanPastedHTML(html: string, maxWidth: number): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    doc.querySelectorAll<HTMLElement>('[style]').forEach((el) => {
        const font = bundledFont(el.style.fontFamily.replace(/['"]/g, ''));
        // The document font needs no mark.
        el.style.fontFamily = font && font !== DOCUMENT_FONT ? getFontFamily(font) : '';
    });

    doc.querySelectorAll<HTMLElement>('img, table').forEach((el) => {
        const attrWidth = el.getAttribute('width');
        const styleWidth = el.style.width;
        let w = 0;
        if (attrWidth) w = parseInt(attrWidth, 10) || 0;
        if (!w && styleWidth?.endsWith('px')) w = parseInt(styleWidth, 10) || 0;

        if (w > maxWidth) {
            el.setAttribute('width', String(Math.round(maxWidth)));
            el.style.width = `${Math.round(maxWidth)}px`;
        }
    });

    return doc.body.innerHTML;
}
