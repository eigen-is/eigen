// The one CSS color normalizer the Office writers share: a stored or stylesheet color as Office's RRGGBB. Anything
// else is undefined, so the caller drops it: a named color or a var() has no Office spelling.
export function cssColorToHex(color: string): string | undefined {
    const value = color.trim();
    const hex = value.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];
    if (hex) return (hex.length === 3 ? [...hex].map((digit) => digit + digit).join('') : hex).toUpperCase();
    const rgb = value.match(/^rgba?\((\d{1,3})[,\s]+(\d{1,3})[,\s]+(\d{1,3})\b/i);
    if (!rgb) return undefined;
    const channels = rgb.slice(1).map(Number);
    if (channels.some((channel) => channel > 255)) return undefined;
    return channels.map((channel) => channel.toString(16).padStart(2, '0').toUpperCase()).join('');
}
