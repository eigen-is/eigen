
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
    | 'check-list';

export interface CustomElement {
    type: CustomElementType;
    children: CustomText[];
    checked?: boolean;
}

export interface CustomText {
    text: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strikethrough?: boolean;
    code?: boolean;
    link?: string;
}
