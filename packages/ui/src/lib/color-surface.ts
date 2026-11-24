// A block in a color a person picked, such as a card or a calendar event, drawn one way everywhere: in light mode the
// color's pale tone lightened toward white, in dark mode a faint wash of the indicator tone with a 2px stripe, as a
// mail list row. A small tile you scan by color takes a stronger tint than a large panel you read in. A caller merges
// its own classes, such as an event state, after these with cn.

import { indicatorColor, lightenColor, paleTone, readableTextColor } from '@workspace/lib/constants/colors';
import type { CSSProperties } from 'react';

type ColorSurfaceTone = 'tile' | 'panel';

// How far toward white the light-mode fill moves from the pale tone, from 0 (the tone itself) to 1 (white).
const TONE_TINT: Record<ColorSurfaceTone, number> = { tile: 0.25, panel: 0.5 };

type ColorSurfaceStyle = CSSProperties & Record<'--surface-bg' | '--surface-fg' | '--surface-indicator', string>;

// An inset shadow, not a border, so the stripe doesn't shift the text. The border color is the indicator too, so a
// caller that adds an edge, such as a dashed outline, draws it in the surface's color.
const COLOR_SURFACE_CLASS =
    'border-(--surface-indicator) bg-(--surface-bg) text-(--surface-fg) dark:bg-[color-mix(in_oklab,var(--surface-indicator)_14%,var(--background))] dark:text-card-foreground dark:shadow-[inset_2px_0_0_0_var(--surface-indicator)]';

export function colorSurface(color: string, tone: ColorSurfaceTone): { className: string; style: ColorSurfaceStyle } {
    const fill = lightenColor(paleTone(color), TONE_TINT[tone]);
    return {
        className: COLOR_SURFACE_CLASS,
        style: {
            '--surface-bg': fill,
            '--surface-fg': readableTextColor(fill),
            '--surface-indicator': indicatorColor(color),
        },
    };
}
