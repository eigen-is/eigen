// PowerPoint's vocabulary, one source for the pptx writer that writes it and the pptx reader that recognises it: the
// content types of PresentationML's parts, the range a slide size may take, and the sizes an on-screen show names.
// The OOXML every format shares sits in its own module.

import type { SlideSize } from '@workspace/lib/vector';
import { UNSTORED_SLIDE_WIDTH } from '@workspace/lib/vector';

// The prefix of PresentationML's content types.
export const PML = 'application/vnd.openxmlformats-officedocument.presentationml';
export const PRESENTATION_TYPE = `${PML}.presentation.main+xml`;
export const SLIDE_TYPE = `${PML}.slide+xml`;
export const SLIDE_LAYOUT_TYPE = `${PML}.slideLayout+xml`;
export const SLIDE_MASTER_TYPE = `${PML}.slideMaster+xml`;

// ST_SlideSizeCoordinate's range in EMU, 1 to 56 inches. ST_TextMargin stops at the same 56 inches.
export const MIN_SLIDE_EMU = 914_400;
export const MAX_SLIDE_EMU = 51_206_400;

// The on-screen show sizes ST_SlideSizeType names. Both are 10 in wide, as a deck that stores no width is. A deck of
// any other width, such as a new deck's 13.33 in, is custom, the attribute's default, which the writer leaves out.
export const SCREEN_SLIDE_WIDTH = UNSTORED_SLIDE_WIDTH;
export const SCREEN_SLIDE_TYPES: Record<SlideSize, string> = { '16:9': 'screen16x9', '4:3': 'screen4x3' };
