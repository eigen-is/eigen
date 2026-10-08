// The one CSS color normalizer the Office writers share: a stored or stylesheet color as Office's RRGGBB. Anything
// else is undefined, so the caller drops it: a named color or a var() has no Office spelling, and a transparent one
// would be a black fill.
export function cssColorToHex(color: string): string | undefined {
    const value = color.trim();
    const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
    if (hex) return (hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex).toUpperCase();
    const rgb = value.match(RGB);
    if (!rgb || Number(rgb[4] ?? 1) === 0) return undefined;
    const channels = rgb.slice(1, 4).map(Number);
    if (channels.some((channel) => channel > 255)) return undefined;
    return channels.map((channel) => channel.toString(16).padStart(2, '0').toUpperCase()).join('');
}

// The spellings of a color that shows nothing: the keyword, and rgb(), hsl() or a hex with alpha 0, though
// cssColorToHex has no hex for the hsl() and the alpha hex. An empty string is no color, not a transparent one.
export function isTransparentCssColor(color: string): boolean {
    const value = color.trim();
    if (/^transparent$/i.test(value)) return true;
    if (/^#(?:[0-9a-f]{3}0|[0-9a-f]{6}00)$/i.test(value)) return true;
    return Number((value.match(RGB) ?? value.match(HSL))?.[4] ?? 1) === 0;
}

const RGB = /^rgba?\((\d{1,3})[,\s]+(\d{1,3})[,\s]+(\d{1,3})(?:\s*[,/]\s*([\d.]+)%?)?\s*\)$/i;
const HSL =
    /^hsla?\((\d+(?:\.\d+)?)(?:deg)?[,\s]+(\d+(?:\.\d+)?)%[,\s]+(\d+(?:\.\d+)?)%(?:\s*[,/]\s*([\d.]+)%?)?\s*\)$/i;
