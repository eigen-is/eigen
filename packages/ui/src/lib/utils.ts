// Small helpers every component in the UI package and the apps reaches for: cn, which joins class names so a later
// Tailwind class wins over an earlier one, and the class and style constants several components draw with, such as
// the checkerboard behind a transparent image.

import type { ClassValue } from 'clsx';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

// A control in a `group` row that a mouse user sees only while the pointer is over the row, such as a row's remove
// button. It stays in the tab order and the accessibility tree, and shows when Tab reaches it or another control in
// the row. A mouse click leaves no focus ring behind that would keep it shown. Until it shows it takes no click,
// as a hidden control takes none. A touch screen has no hover, so there it always shows.
export const HOVER_REVEAL_CLASS =
    'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-has-focus-visible:pointer-events-auto group-has-focus-visible:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100';

// Transparency checkerboard in the border token: a transparent swatch or image area reads as
// transparent rather than as white or as the backdrop.
export const CHECKERBOARD_STYLE = {
    backgroundImage: 'repeating-conic-gradient(var(--border) 0 25%, transparent 0 50%)',
    backgroundSize: '8px 8px',
} as const;

// Behind a displayed image: muted under border keeps the two tones close, so transparent regions
// read as transparent without competing with the picture; opaque images cover it entirely.
export const IMAGE_CHECKERBOARD_STYLE = {
    ...CHECKERBOARD_STYLE,
    backgroundColor: 'var(--muted)',
    backgroundSize: '16px 16px',
} as const;
