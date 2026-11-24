// A block in a color a person picked, such as a card or a calendar event, drawn one way everywhere. In light mode
// it fills with the color's pale tone lightened toward white, with text that reads on it, so an event looks like a
// card of its color; in dark mode it looks like a mail list row, a faint wash of the indicator tone with a 2px stripe
// in it. It hands back classes and the style that sets their variables, so a caller merges its own classes, such as
// an event state, after these with cn.

import { indicatorColor, lightenColor, paleTone, readableTextColor } from '@workspace/lib/constants/colors';
import type { CSSProperties } from 'react';

// How far toward white the light-mode fill moves from the pale tone, from 0 (the tone itself) to 1 (white).
export const COLOR_SURFACE_TINT = 0.25;

type ColorSurfaceStyle = CSSProperties &
    Record<'--surface-bg' | '--surface-fg' | '--surface-indicator' | '--surface-soft', string>;

// An inset shadow, not a border, so the stripe doesn't shift the text. The border color is the indicator too, so a
// caller that adds an edge, such as a dashed outline, draws it in the surface's color.
const COLOR_SURFACE_CLASS =
    'border-(--surface-indicator) bg-(--surface-bg) text-(--surface-fg) dark:bg-(--surface-soft) dark:text-card-foreground dark:shadow-[inset_2px_0_0_0_var(--surface-indicator)]';

export function colorSurface(color: string): { className: string; style: ColorSurfaceStyle } {
    const fill = lightenColor(paleTone(color), COLOR_SURFACE_TINT);
    return {
        className: COLOR_SURFACE_CLASS,
        style: {
            '--surface-bg': fill,
            '--surface-fg': readableTextColor(fill),
            '--surface-indicator': indicatorColor(color),
            '--surface-soft': 'color-mix(in oklab, var(--surface-indicator) 14%, var(--background))',
        },
    };
}
