import type { BackgroundFill } from '../types/background';
import { cssGradientStops } from './gradient';

export const DEFAULT_FILL_COLOR = '#e60076';

type Style = {
    backgroundColor?: string;
    backgroundImage?: string;
    backgroundSize?: string;
    backgroundPosition?: string;
    backgroundRepeat?: string;
};

export function getBackgroundStyle(
    fill: BackgroundFill | null | undefined,
    resolveMediaUrl?: (mediaName: string) => string | null,
): Style {
    if (!fill) return {};
    switch (fill.type) {
        case 'solid':
            return { backgroundColor: fill.color };
        case 'gradient':
            return {
                backgroundImage: `linear-gradient(${fill.angle}deg, ${cssGradientStops(fill.from, fill.to)})`,
            };
        case 'image': {
            if (!fill.mediaName) return {};
            const url = resolveMediaUrl?.(fill.mediaName);
            if (!url) return {};
            return {
                backgroundImage: `url(${url})`,
                backgroundSize: fill.fit,
                backgroundPosition: 'center',
                backgroundRepeat: 'no-repeat',
            };
        }
    }
}

// The same fill as CSS declarations, for the serializers that build a style STRING (the rich-text layer
// body, shared verbatim by the live canvas, the SVG foreignObject and the print compositor). Derived
// from getBackgroundStyle so the gradient/colour syntax has one owner.
export function backgroundCss(
    fill: BackgroundFill | null | undefined,
    resolveMediaUrl?: (mediaName: string) => string | null,
): string[] {
    const declarations: string[] = [];
    for (const [key, value] of Object.entries(getBackgroundStyle(fill, resolveMediaUrl))) {
        if (typeof value === 'string')
            declarations.push(`${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}:${value}`);
    }
    return declarations;
}
