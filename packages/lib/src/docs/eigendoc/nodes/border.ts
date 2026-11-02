// The one stored form of a doc's border, such as a table cell's side or a text box's outline: a string
// "<px>px <style> <#rrggbb>" or "none". A peer or a paste can write any value, and the value lands in an inline style
// and a docx, so every reader goes through readBorder, which keeps only that form. borderValue writes it back, and
// fitBorderPx fits a width from Word or a paste into the range a border draws at and rounds it.

export const BORDER_STYLES = ['solid', 'dashed', 'dotted', 'double'] as const;
export type BorderStyle = (typeof BORDER_STYLES)[number];

// Null means Eigen's own look, so a border a node sets is either drawn or none.
export type Border = 'none' | { width: number; style: BorderStyle; color: string };

// In px: Word's thinnest and thickest borders, a quarter point and twelve, clamped to what still draws on screen.
export const MIN_BORDER_PX = 0.5;
export const MAX_BORDER_PX = 8;

// A line's width in px as a border stores it, such as a Word border's or a pasted one: within the widths a border draws
// at, and rounded to the hundredth readBorder reads.
export function fitBorderPx(px: number): number {
    return Number(Math.min(Math.max(px, MIN_BORDER_PX), MAX_BORDER_PX).toFixed(2));
}

const BORDER = /^(\d{1,3}(?:\.\d{1,2})?)px ([a-z]+) (#[0-9a-f]{6})$/;

export function readBorder(value: unknown): Border | null {
    const text = typeof value === 'string' ? value.toLowerCase() : '';
    if (text === 'none') return 'none';
    const [, width, written, color] = BORDER.exec(text) ?? [];
    const style = BORDER_STYLES.find((known) => known === written);
    const px = Number(width);
    if (!style || !color || px < MIN_BORDER_PX || px > MAX_BORDER_PX) return null;
    return { width: px, style, color };
}

export function borderValue(border: Border): string {
    return border === 'none' ? 'none' : `${Number(border.width.toFixed(2))}px ${border.style} ${border.color}`;
}
