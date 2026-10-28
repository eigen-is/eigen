// The Docs text box: an inline atom in the figure's frame that holds paragraphs of its own, as Word's text box does. It
// sits in line, wrapped, or in front of or behind the text, with a width, a minimum height, a fill, an outline, an
// inner padding, a vertical alignment and rounded corners. Its paragraphs are edited in one live editor at a time, as a
// note's are. Every surface that draws one takes its box attributes from textBoxHTMLAttributes, so they draw alike.

import { Node } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import { DOMSerializer, Fragment, DOMParser as PMDOMParser } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { MAX_PAPER_PX, mmToPx } from '../page';
import type { FigureFrameAttrs } from './figure-frame';
import { figureFrameAttributes, figureFrameHTML, readFigureFrameAttrs, updateFigureNodes } from './figure-frame';
import { flattenNestedStories, insertStory, newStoryId, readStoryId, STORY_ID_ATTRIBUTE } from './stories';
import type { CellBorder } from './table-cell';
import { cellBorderValue, readCellBackground, readCellBorder } from './table-cell';

const NAME = 'textBox';

// data-type, as a web page's own span.text-box is its text.
export const TEXT_BOX_SELECTOR = 'span[data-type="text-box"]';

// A box's paragraph in HTML: a span, as a <p> inside the body's <p> closes it in every HTML parser.
export const TEXT_BOX_PARAGRAPH = 'text-box-paragraph';

const TEXT_BOX_VERTICAL_ALIGNS = ['top', 'middle', 'bottom'] as const;
export type TextBoxVerticalAlign = (typeof TEXT_BOX_VERTICAL_ALIGNS)[number];

// A new box is 6 cm wide, as Word's is. No side is less than a one-line label needs, and none more than the largest
// paper, so a forged size can't stall the layout.
export const TEXT_BOX_DEFAULT_WIDTH = Math.round(mmToPx(60));
export const TEXT_BOX_MIN_SIDE = 24;

// Word's default insets, 0.1 inch left and right and 0.05 inch above and below, in px. A box with no padding stored
// draws these.
export const TEXT_BOX_INSET = { x: 9.6, y: 4.8 };
export const MAX_TEXT_BOX_PADDING = 96;

// Word's rounded rectangle, drawn at one fixed radius.
export const TEXT_BOX_RADIUS = 8;

// The box as it draws: every attribute read through its reader, so a value a peer or a paste wrote that isn't the
// stored form reads as unset or clamped. A null height is auto: the box is as tall as its text. A number is a minimum,
// and the box grows past it.
export type TextBoxAttrs = FigureFrameAttrs & {
    id: string | null;
    width: number;
    height: number | null;
    fill: string | null;
    outline: CellBorder | null;
    paddingX: number | null;
    paddingY: number | null;
    verticalAlign: TextBoxVerticalAlign | null;
    rounded: boolean;
};

// What the panel and a command write: any attribute may be left out, and null clears it.
export type TextBoxEdit = FigureFrameAttrs & {
    width?: number;
    height?: number | null;
    fill?: string | null;
    outline?: string | null;
    paddingX?: number | null;
    paddingY?: number | null;
    verticalAlign?: TextBoxVerticalAlign | null;
    rounded?: boolean;
};

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        textBox: {
            updateTextBox: (attributes: TextBoxEdit) => ReturnType;
        };
    }
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

export const readTextBoxSide = (value: unknown): number | null =>
    isFiniteNumber(value) ? clamp(value, TEXT_BOX_MIN_SIDE, MAX_PAPER_PX) : null;

const readPadding = (value: unknown): number | null =>
    isFiniteNumber(value) ? clamp(value, 0, MAX_TEXT_BOX_PADDING) : null;

export function readTextBoxAttrs(attrs: Record<string, unknown>): TextBoxAttrs {
    return {
        ...readFigureFrameAttrs(attrs),
        id: readStoryId(attrs['id']),
        width: readTextBoxSide(attrs['width']) ?? TEXT_BOX_DEFAULT_WIDTH,
        height: readTextBoxSide(attrs['height']),
        fill: readCellBackground(attrs['fill']),
        outline: readCellBorder(attrs['outline']),
        paddingX: readPadding(attrs['paddingX']),
        paddingY: readPadding(attrs['paddingY']),
        verticalAlign: TEXT_BOX_VERTICAL_ALIGNS.find((align) => align === attrs['verticalAlign']) ?? null,
        rounded: attrs['rounded'] === true,
    };
}

// The padding a box draws: its own, or Word's inset where it stores none.
export const textBoxPadding = ({ paddingX, paddingY }: Pick<TextBoxAttrs, 'paddingX' | 'paddingY'>) => ({
    x: paddingX ?? TEXT_BOX_INSET.x,
    y: paddingY ?? TEXT_BOX_INSET.y,
});

// The box's own span, inside the frame's: its look as data attributes, which a paste reads back, and as a style, which
// every surface draws. A box with no fill and no outline draws neither. The editor alone shows a guide around it.
export function textBoxHTMLAttributes(attrs: TextBoxAttrs): Record<string, string> {
    const { id, width, height, fill, outline, paddingX, paddingY, verticalAlign, rounded } = attrs;
    const padding = textBoxPadding(attrs);
    const style = [
        `width: ${width}px`,
        height !== null && `min-height: ${height}px`,
        fill && `background-color: ${fill}`,
        outline && outline !== 'none' && `border: ${cellBorderValue(outline)}`,
        `padding: ${padding.y}px ${padding.x}px`,
        rounded && `border-radius: ${TEXT_BOX_RADIUS}px`,
    ];
    return {
        class: 'text-box',
        'data-type': 'text-box',
        ...(id && { [STORY_ID_ATTRIBUTE]: id }),
        'data-width': String(width),
        ...(height !== null && { 'data-height': String(height) }),
        ...(fill && { 'data-fill': fill }),
        ...(outline && { 'data-outline': cellBorderValue(outline) }),
        ...(paddingX !== null && { 'data-padding-x': String(paddingX) }),
        ...(paddingY !== null && { 'data-padding-y': String(paddingY) }),
        ...(verticalAlign && { 'data-vertical-align': verticalAlign }),
        ...(rounded && { 'data-rounded': '' }),
        style: style.filter(Boolean).join('; '),
    };
}

const isElement = (node: globalThis.Node): node is Element => node.nodeType === 1;

// The box span a parse rule matched: the frame's span holds it, or a paste kept the box span alone.
function boxOf(element: Element): Element | undefined {
    if (element.matches(TEXT_BOX_SELECTOR)) return element;
    return [...element.children].find((child) => child.matches(TEXT_BOX_SELECTOR));
}

const boxAttribute = (name: string, read: (value: string) => unknown) => ({
    default: null,
    parseHTML: (element: HTMLElement) => {
        const value = boxOf(element)?.getAttribute(name);
        return value === null || value === undefined ? null : read(value);
    },
});

// Each paragraph span read as the <p> it was rendered from, so it keeps its alignment and format, and a nested story
// flattened into its text.
function boxContent(dom: globalThis.Node, schema: Schema): Fragment {
    const type = schema.nodes[NAME];
    const box = isElement(dom) ? boxOf(dom) : undefined;
    if (!type || !box) return Fragment.empty;
    const holder = box.ownerDocument.createElement('div');
    for (const span of box.children) {
        if (span.getAttribute('data-type') !== TEXT_BOX_PARAGRAPH) continue;
        const paragraph = box.ownerDocument.createElement('p');
        for (const { name, value } of span.attributes) if (name !== 'data-type') paragraph.setAttribute(name, value);
        paragraph.append(...span.cloneNode(true).childNodes);
        holder.append(paragraph);
    }
    const parsed = type.createAndFill(null, PMDOMParser.fromSchema(schema).parseSlice(holder).content);
    return parsed ? schema.nodeFromJSON(flattenNestedStories(parsed.toJSON())).content : Fragment.empty;
}

// A new box's line, Word's black one, which the panel's first line starts from too.
export const TEXT_BOX_DEFAULT_OUTLINE = { width: 1, style: 'solid', color: '#000000' } as const satisfies CellBorder;

// A box after the selection, where insertStory puts a story: in the flow and aligned left, with Word's white fill and
// black line, holding one empty paragraph.
export function insertTextBox(tr: Transaction): number | null {
    const box = tr.doc.type.schema.nodes[NAME]?.createAndFill({
        id: newStoryId(),
        alignment: 'left',
        width: TEXT_BOX_DEFAULT_WIDTH,
        fill: '#ffffff',
        outline: cellBorderValue(TEXT_BOX_DEFAULT_OUTLINE),
    });
    return insertStory(tr, box);
}

export const TextBoxNode = Node.create({
    name: NAME,

    group: 'inline',

    inline: true,

    atom: true,

    content: 'paragraph+',

    isolating: true,

    selectable: true,

    draggable: true,

    addAttributes() {
        return {
            ...figureFrameAttributes(),
            // A box draws no caption; a figure's inside it keeps its own.
            caption: { default: null, parseHTML: () => null },
            id: boxAttribute(STORY_ID_ATTRIBUTE, readStoryId),
            width: {
                ...boxAttribute('data-width', (value) => readTextBoxSide(Number(value)) ?? TEXT_BOX_DEFAULT_WIDTH),
                default: TEXT_BOX_DEFAULT_WIDTH,
            },
            height: boxAttribute('data-height', (value) => readTextBoxSide(Number(value))),
            fill: boxAttribute('data-fill', readCellBackground),
            outline: boxAttribute('data-outline', (value) => {
                const border = readCellBorder(value);
                return border && cellBorderValue(border);
            }),
            paddingX: boxAttribute('data-padding-x', (value) => readPadding(Number(value))),
            paddingY: boxAttribute('data-padding-y', (value) => readPadding(Number(value))),
            verticalAlign: boxAttribute('data-vertical-align', (value) =>
                TEXT_BOX_VERTICAL_ALIGNS.find((align) => align === value),
            ),
            rounded: {
                default: false,
                parseHTML: (element: HTMLElement) => !!boxOf(element)?.hasAttribute('data-rounded'),
            },
        };
    },

    // Above the figure's span.figure, which would take a box's inline picture for its own.
    parseHTML() {
        return [
            {
                tag: 'span.figure',
                priority: 75,
                getAttrs: (element: HTMLElement) => (boxOf(element) ? null : false),
                getContent: boxContent,
            },
            { tag: TEXT_BOX_SELECTOR, priority: 75, getContent: boxContent },
        ];
    },

    // Built, not a spec with a hole, which would render each paragraph as a <p>. A paragraph's span carries the
    // attributes its <p> renders, its alignment and format.
    renderHTML({ node }) {
        const attrs = readTextBoxAttrs(node.attrs);
        const serializer = DOMSerializer.fromSchema(node.type.schema);
        const box = document.createElement('span');
        for (const [name, value] of Object.entries(textBoxHTMLAttributes(attrs))) box.setAttribute(name, value);
        node.forEach((paragraph) => {
            const rendered = serializer.serializeNode(paragraph);
            const span = document.createElement('span');
            if (isElement(rendered)) {
                for (const { name, value } of rendered.attributes) span.setAttribute(name, value);
                span.append(...rendered.childNodes);
            }
            span.setAttribute('data-type', TEXT_BOX_PARAGRAPH);
            box.append(span);
        });
        return figureFrameHTML({ class: 'figure' }, attrs, box);
    },

    // As a note's: a plain-text copy, a comment's quote and an input rule read the body's text without the box's.
    renderText() {
        return '';
    },

    addCommands() {
        return {
            updateTextBox: (attributes) => updateFigureNodes(this.name, attributes),
        };
    },
});
