import { type CommandProps, Node } from '@tiptap/core';
import {
    type FigureFrameAttrs,
    figureFrameAttributes,
    figureFrameHTML,
    readFigureFrameAttrs,
    updateFigureNodes,
} from './figure-frame';

// The node's attribute set, as it comes back off a stored document (every attr defaults to null).
export type FigureAttrs = FigureFrameAttrs & {
    mediaName?: string | null;
    src?: string | null;
    alt?: string | null;
    width?: number | null;
};

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        figure: {
            setFigure: (options: FigureAttrs & { mediaName: string }) => ReturnType;
            updateFigure: (attributes: FigureAttrs) => ReturnType;
        };
    }
}

// A figure's attributes off untyped ones (TipTap's getAttributes): a value of the wrong type reads as unset.
export function readFigureAttrs(attrs: Record<string, unknown>): FigureAttrs {
    const text = (key: keyof FigureAttrs) => {
        const value = attrs[key];
        return typeof value === 'string' ? value : null;
    };
    const width = attrs['width'];
    return {
        mediaName: text('mediaName'),
        src: text('src'),
        alt: text('alt'),
        width: typeof width === 'number' ? width : null,
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
        const { caption, commentCardId, alignment, layout } = figureFrameAttributes();
        return {
            mediaName: { default: null },
            src: { default: null },
            alt: { default: null },
            caption,
            commentCardId,
            width: {
                default: null,
                parseHTML: (element: HTMLElement) => {
                    const img = element.querySelector('img') || element;
                    const attr = img.getAttribute('width');
                    if (attr) return parseInt(attr, 10) || null;
                    const styleWidth = (img as HTMLElement).style?.width;
                    if (styleWidth?.endsWith('px')) return parseInt(styleWidth, 10) || null;
                    return null;
                },
            },
            alignment,
            layout,
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
