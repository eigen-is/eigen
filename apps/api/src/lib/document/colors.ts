// The CSS colors the Office writers share, such as the docx and xlsx styles: a stored or stylesheet color as Office's
// RRGGBB, and whether a color shows nothing.

import { isHexColor, parseRgb } from '@workspace/lib/constants/colors';

// A color as Office's RRGGBB. Anything else is undefined, so the caller drops it: a named color or a var() has no
// Office spelling, and a transparent one would be a black fill.
export function cssColorToHex(color: string): string | undefined {
    const value = color.trim();
    if (isHexColor(value, [3, 6])) {
        const hex = value.slice(1);
        return (hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex).toUpperCase();
    }
    const rgb = parseRgb(value);
    return rgb && rgb.alpha > 0 ? rgb.hex.slice(1).toUpperCase() : undefined;
}

// The spellings of a color that shows nothing: the keyword, and rgb(), hsl() or a hex with alpha 0, though
// cssColorToHex has no hex for the hsl() and the alpha hex. An empty string is no color, not a transparent one.
export function isTransparentCssColor(color: string): boolean {
    const value = color.trim();
    if (/^transparent$/i.test(value)) return true;
    if (/^#(?:[0-9a-f]{3}0|[0-9a-f]{6}00)$/i.test(value)) return true;
    return (parseRgb(value)?.alpha ?? Number(value.match(HSL)?.[4] ?? 1)) === 0;
}

const HSL =
    /^hsla?\((\d+(?:\.\d+)?)(?:deg)?[,\s]+(\d+(?:\.\d+)?)%[,\s]+(\d+(?:\.\d+)?)%(?:\s*[,/]\s*([\d.]+)%?)?\s*\)$/i;
