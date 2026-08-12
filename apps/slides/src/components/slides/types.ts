import { EIGEN_FONTS } from '@workspace/lib/constants/fonts';
import type { ImageObject, TextObject } from '@workspace/lib/slides';

export type { DeckData, ImageObject, SlideItem, SlideObject, TextObject } from '@workspace/lib/slides';

export type ApplyTo = 'this' | 'this-and-following' | 'all';
export {
    BORDER_RADIUS_ROUND,
    pxToPercent,
    SLIDE_ASPECT_RATIO,
    SLIDE_BASE_HEIGHT,
    SLIDE_BASE_WIDTH,
} from '@workspace/lib/slides';

const DEFAULT_BORDER = {
    borderColor: '',
    borderWidth: 0,
    borderRadius: 0,
};

export const DEFAULT_TEXT_OBJECT: Omit<TextObject, 'id' | 'slideId'> = {
    type: 'text',
    x: 192,
    y: 108,
    w: 1536,
    h: 162,
    rotation: 0,
    text: '<p>New text</p>',
    fontFamily: EIGEN_FONTS[0].name,
    fontSize: 48,
    fontWeight: 'normal',
    fontStyle: 'normal',
    textDecoration: 'none',
    textAlign: 'center',
    verticalAlign: 'center',
    color: '#000000',
    letterSpacing: 0,
    lineHeight: 1.2,
    highlightColor: '',
    background: null,
    ...DEFAULT_BORDER,
    commentCardIds: [],
};

export const DEFAULT_IMAGE_OBJECT: Omit<ImageObject, 'id' | 'slideId' | 'mediaName'> = {
    type: 'image',
    x: 384,
    y: 162,
    w: 1152,
    h: 756,
    rotation: 0,
    objectFit: 'contain',
    ...DEFAULT_BORDER,
    commentCardIds: [],
};
