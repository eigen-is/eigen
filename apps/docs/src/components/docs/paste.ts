import { getFontFamily } from '@workspace/lib/constants/fonts';

// Pasted HTML before the schema parses it: foreign fonts onto the bundled ones, images and tables no wider than the column.
export function cleanPastedHTML(html: string, maxWidth: number): string {
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const fontMap: Record<string, string> = {
        'Times New Roman': getFontFamily('Source Serif 4'),
        Georgia: getFontFamily('Source Serif 4'),
        Palatino: getFontFamily('Source Serif 4'),
        'Palatino Linotype': getFontFamily('Source Serif 4'),
        'Courier New': getFontFamily('JetBrains Mono'),
        Consolas: getFontFamily('JetBrains Mono'),
        'Comic Sans MS': getFontFamily('Excalifont'),
    };
    doc.querySelectorAll<HTMLElement>('[style]').forEach((el) => {
        const ff = el.style.fontFamily.replace(/['"]/g, '').trim();
        el.style.fontFamily = fontMap[ff] ?? '';
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
