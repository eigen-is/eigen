import type { BackgroundFill } from '../types/background';

type BaseObject = {
    id: string;
    slideId: string;
    x: number;
    y: number;
    width: number;
    height: number;
    angle: number;
    borderColor: string;
    borderWidth: number;
    borderRadius: number;
    commentCardIds: string[];
};

export type TextObject = BaseObject & {
    type: 'text';
    text: string;
    fontFamily: string;
    fontSize: number;
    fontWeight: 'normal' | 'bold';
    fontStyle: 'normal' | 'italic';
    textDecoration: 'none' | 'underline' | 'line-through';
    textAlign: 'left' | 'center' | 'right' | 'justify';
    verticalAlign: 'top' | 'center' | 'bottom';
    color: string;
    letterSpacing: number;
    lineHeight: number;
    highlightColor: string;
    background: BackgroundFill | null;
};

export type ImageObject = BaseObject & {
    type: 'image';
    mediaName: string;
    objectFit: 'contain' | 'cover' | 'fill';
};

export type SlideObject = TextObject | ImageObject;

export type SlideItem = {
    id: string;
    objectIds: string[];
    background: BackgroundFill | null;
};

export type DeckData = {
    slides: Record<string, SlideItem>;
    objects: Record<string, SlideObject>;
    slideOrder: string[];
};

export const SLIDE_ASPECT_RATIO = 16 / 9;
export const SLIDE_BASE_WIDTH = 1920;
export const SLIDE_BASE_HEIGHT = 1080;

export function pxToPercent(val: number, axis: 'x' | 'y'): number {
    return (val / (axis === 'x' ? SLIDE_BASE_WIDTH : SLIDE_BASE_HEIGHT)) * 100;
}

export const BORDER_RADIUS_ROUND = 9999;
