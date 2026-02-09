// Define types for the editor
export type CustomElementType =
    | 'paragraph'
    | 'heading-one'
    | 'heading-two'
    | 'heading-three'
    | 'block-quote'
    | 'bulleted-list'
    | 'numbered-list'
    | 'list-item'
    | 'check-list'
    | 'image';

export type TextAlignment = 'left' | 'center' | 'right';

export type ImageElement = {
    type: 'image';
    pathId: string;
    width?: number;
    height?: number;
    children: CustomText[];
    align?: TextAlignment;
}

export type CustomElement = {
    type: CustomElementType;
    children: CustomText[];
    checked?: boolean;
    align?: TextAlignment;
    pathId?: string;
    width?: number;
    height?: number;
}

export type CustomText = {
    text: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    code?: boolean;
    link?: string;
}