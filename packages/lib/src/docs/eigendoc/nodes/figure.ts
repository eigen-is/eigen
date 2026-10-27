// The Docs image node: an inline atom that names its image by media name, in the frame it shares with the chart. It
// stores a width, and a height only when the picture is stretched off its own ratio. It reads an image back from
// Eigen's own span, a <figure> or a bare <img>, so a copy, an export and another app's HTML paste as one.

import type { CommandProps } from '@tiptap/core';
import { Node } from '@tiptap/core';
import type { FigureFrameAttrs } from './figure-frame';
import {
    figureFrameAttributes,
    figureFrameHTML,
    isOwnSpan,
    readFigureFrameAttrs,
    readFrameSide,
    updateFigureNodes,
} from './figure-frame';

// The node's attribute set, as it comes back off a stored document (every attr defaults to null). With no height, the
// picture's height follows its own ratio.
export type FigureAttrs = FigureFrameAttrs & {
    mediaName?: string | null;
    src?: string | null;
    alt?: string | null;
    width?: number | null;
    height?: number | null;
};

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        figure: {
            setFigure: (options: FigureAttrs & { mediaName: string }) => ReturnType;
            updateFigure: (attributes: FigureAttrs) => ReturnType;
        };
    }
}

// A figure's attributes off untyped ones (TipTap's getAttributes): a value of the wrong type reads as unset, and the
// width and the height read as the frame reads every stored side.
export function readFigureAttrs(attrs: Record<string, unknown>): FigureAttrs {
    const text = (key: keyof FigureAttrs) => {
        const value = attrs[key];
        return typeof value === 'string' ? value : null;
    };
    return {
        mediaName: text('mediaName'),
        src: text('src'),
        alt: text('alt'),
        width: readFrameSide(attrs['width']),
        height: readFrameSide(attrs['height']),
        ...readFigureFrameAttrs(attrs),
    };
}

// Attributes of a `<figure>` or a `span.figure`; no img, no figure. The frame's attributes and width parse on their own.
function figureAttrsOf(dom: HTMLElement): FigureAttrs | false {
    const img = dom.querySelector('img');
    if (!img) return false;
    return {
        src: img.getAttribute('src'),
        alt: img.getAttribute('alt'),
        mediaName: img.getAttribute('data-media-name'),
    };
}

export const FigureNode = Node.create({
    name: 'figure',

    group: 'inline',

    inline: true,

    atom: true,

    draggable: true,

    addAttributes() {
        const { caption, commentCardId, alignment, layout, offsetX, offsetY } = figureFrameAttributes();
        return {
            mediaName: { default: null },
            src: { default: null },
            alt: { default: null },
            caption,
            commentCardId,
            width: {
                default: null,
                parseHTML: (element: HTMLElement) => {
                    const img = element.querySelector<HTMLElement>('img') ?? element;
                    const attr = img.getAttribute('width');
                    if (attr) return Number.parseFloat(attr) || null;
                    const styleWidth = img.style?.width;
                    if (styleWidth?.endsWith('px')) return Number.parseFloat(styleWidth) || null;
                    return null;
                },
            },
            // Only Eigen's own span: a web page's <img width height> often carries a size its CSS overrides, and would
            // paste stretched.
            height: {
                default: null,
                parseHTML: (element: HTMLElement) =>
                    isOwnSpan(element)
                        ? readFrameSide(Number.parseFloat(element.querySelector('img')?.getAttribute('height') ?? ''))
                        : null,
            },
            alignment,
            layout,
            offsetX,
            offsetY,
        };
    },

    parseHTML() {
        return [
            { tag: 'figure', getAttrs: figureAttrsOf, priority: 60 },
            // The figure as the schema and the export write it: spans, which a paragraph can hold.
            { tag: 'span.figure', getAttrs: figureAttrsOf, priority: 60 },
            {
                tag: 'img[data-media-name]',
                priority: 51,
                getAttrs(dom) {
                    const el = dom as HTMLElement;
                    return {
                        mediaName: el.getAttribute('data-media-name'),
                        src: el.getAttribute('src'),
                        alt: el.getAttribute('alt'),
                    };
                },
            },
            {
                tag: 'img[src]',
                priority: 50,
                getAttrs(dom) {
                    const el = dom as HTMLElement;
                    return {
                        src: el.getAttribute('src'),
                        alt: el.getAttribute('alt'),
                    };
                },
            },
        ];
    },

    renderHTML({ node, HTMLAttributes }) {
        const imgAttrs: Record<string, unknown> = {
            src: HTMLAttributes['src'],
            alt: HTMLAttributes['alt'],
        };
        if (HTMLAttributes['data-media-name'] || HTMLAttributes['mediaName']) {
            imgAttrs['data-media-name'] = HTMLAttributes['data-media-name'] || HTMLAttributes['mediaName'];
        }
        if (HTMLAttributes['width']) {
            imgAttrs['width'] = HTMLAttributes['width'];
        }
        if (HTMLAttributes['height']) {
            imgAttrs['height'] = HTMLAttributes['height'];
        }
        return figureFrameHTML({ class: 'figure' }, readFigureFrameAttrs(node.attrs), ['img', imgAttrs]);
    },

    addCommands() {
        return {
            setFigure:
                (options) =>
                ({ commands }: CommandProps) => {
                    return commands.insertContent({
                        type: this.name,
                        attrs: options,
                    });
                },
            updateFigure: (attributes) => updateFigureNodes(this.name, attributes),
        };
    },
});
