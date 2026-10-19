import type { SlideSize } from '@workspace/lib/vector';

// PowerPoint's vocabulary, which the pptx writer writes and the pptx reader recognises, one source both ways. The OOXML
// every format shares is core/ooxml.ts.

// The prefix of PresentationML's content types.
export const PML = 'application/vnd.openxmlformats-officedocument.presentationml';
export const PRESENTATION_TYPE = `${PML}.presentation.main+xml`;
export const THEME_TYPE = 'application/vnd.openxmlformats-officedocument.theme+xml';

// The EMU size PowerPoint gives each of a deck's slide sizes; a frame's width sets EMU per px.
export const PPTX_SLIDE_SIZES: Record<SlideSize, { cx: number; cy: number; type?: string }> = {
    '16:9': { cx: 12_192_000, cy: 6_858_000 },
    '4:3': { cx: 9_144_000, cy: 6_858_000, type: 'screen4x3' },
};
