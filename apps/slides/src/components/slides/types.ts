import type {DrivePath} from '@workspace/lib/types/drive';

type BaseObject = {
    id: string;
    slideId: string;
    x: number;
    y: number;
    w: number;
    h: number;
    rotation: number;
    shadowColor: string;
    shadowBlur: number;
    shadowOffsetX: number;
    shadowOffsetY: number;
}

export type TextObject = BaseObject & {
    type: 'text';
    text: string;
    fontSize: number;
    fontWeight: 'normal' | 'bold';
    fontStyle: 'normal' | 'italic';
    textDecoration: 'none' | 'underline' | 'line-through';
    textAlign: 'left' | 'center' | 'right';
    color: string;
    letterSpacing: number;
    lineHeight: number;
    highlightColor: string;
    backgroundColor: string;
}

export type ImageObject = BaseObject & {
    type: 'image';
    src: string;
    objectFit: 'contain' | 'cover' | 'fill';
    sourcePath?: DrivePath;
}

export type SlideObject = TextObject | ImageObject;

export type SlideItem = {
    id: string;
    objectIds: string[];
    backgroundColor: string;
}

export type DeckData = {
    slides: Record<string, SlideItem>;
    objects: Record<string, SlideObject>;
    slideOrder: string[];
}

export const SLIDE_ASPECT_RATIO = 16 / 9;
export const SLIDE_BASE_WIDTH = 1920;
export const SLIDE_BASE_HEIGHT = 1080;

const DEFAULT_SHADOW = {
    shadowColor: 'rgba(0,0,0,0)',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
};

export const DEFAULT_TEXT_OBJECT: Omit<TextObject, 'id' | 'slideId'> = {
    type: 'text',
    x: 10,
    y: 10,
    w: 80,
    h: 15,
    rotation: 0,
    text: 'New text',
    fontSize: 48,
    fontWeight: 'normal',
    fontStyle: 'normal',
    textDecoration: 'none',
    textAlign: 'center',
    color: '#000000',
    letterSpacing: 0,
    lineHeight: 1.2,
    highlightColor: '',
    backgroundColor: '',
    ...DEFAULT_SHADOW,
};

export const DEFAULT_IMAGE_OBJECT: Omit<ImageObject, 'id' | 'slideId' | 'src'> = {
    type: 'image',
    x: 20,
    y: 15,
    w: 60,
    h: 70,
    rotation: 0,
    objectFit: 'contain',
    ...DEFAULT_SHADOW,
};

export const SLIDE_BACKGROUNDS = [
    {label: 'White', value: '#ffffff'},
    {label: 'Light gray', value: '#f3f4f6'},
    {label: 'Dark', value: '#1e293b'},
    {label: 'Black', value: '#000000'},
    {label: 'Blue', value: '#1e3a5f'},
    {label: 'Red', value: '#7f1d1d'},
] as const;
