import { type SlideSize, UNSTORED_SLIDE_WIDTH } from '@workspace/lib/vector';

// PowerPoint's vocabulary, which the pptx writer writes and the pptx reader recognises, one source both ways. The OOXML
// every format shares is core/ooxml.ts.

// The prefix of PresentationML's content types.
export const PML = 'application/vnd.openxmlformats-officedocument.presentationml';
export const PRESENTATION_TYPE = `${PML}.presentation.main+xml`;
export const THEME_TYPE = 'application/vnd.openxmlformats-officedocument.theme+xml';

// The on-screen show sizes ST_SlideSizeType names, both 10 in wide, as a deck that stores no width is; a deck of
// another width, a new one's 13.33 in among them, is custom, the attribute's default, which the writer leaves out.
export const SCREEN_SLIDE_WIDTH = UNSTORED_SLIDE_WIDTH;
export const SCREEN_SLIDE_TYPES: Record<SlideSize, string> = { '16:9': 'screen16x9', '4:3': 'screen4x3' };
