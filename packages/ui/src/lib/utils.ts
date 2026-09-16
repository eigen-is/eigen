import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

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

export function ucfirst(str: string): string {
    if (!str || str.length === 0) return str;
    return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
}
