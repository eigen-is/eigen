import type { SlideSize } from '@workspace/lib/vector';

// PowerPoint's vocabulary, which the pptx writer writes and the pptx reader recognises, one source both ways. The OOXML
// every format shares is core/ooxml.ts.

// The prefix of PresentationML's content types.
export const PML = 'application/vnd.openxmlformats-officedocument.presentationml';
export const PRESENTATION_TYPE = `${PML}.presentation.main+xml`;
export const THEME_TYPE = 'application/vnd.openxmlformats-officedocument.theme+xml';

// The on-screen show sizes ST_SlideSizeType names, both 10 in (720 pt) wide; a deck of another width is custom, the
// attribute's default, which the writer leaves out.
export const SCREEN_SLIDE_WIDTH = 720;
export const SCREEN_SLIDE_TYPES: Record<SlideSize, string> = { '16:9': 'screen16x9', '4:3': 'screen4x3' };
