import { type CommandProps, Node } from '@tiptap/core';
import type { Transaction } from '@tiptap/pm/state';

export type FigureLayout = 'block' | 'wrap-left' | 'wrap-right';
export type FigureAlignment = 'left' | 'center' | 'right';

// The node's attribute set, as it comes back off a stored document (every attr defaults to null).
export type FigureAttrs = {
    mediaName?: string | null;
    src?: string | null;
    alt?: string | null;
    caption?: string | null;
    width?: number | null;
    alignment?: FigureAlignment | null;
    layout?: FigureLayout | null;
    commentCardId?: string | null;
};

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        figure: {
            setFigure: (options: FigureAttrs & { mediaName: string }) => ReturnType;
            updateFigure: (attributes: FigureAttrs) => ReturnType;
        };
    }
}

// An AttrStep maps no position, so a node selection on the figure survives, and with it the editor's Image panel.
// TipTap's updateAttributes writes with setNodeMarkup, which replaces the leaf and maps that selection to a text one.
export function setFigureAttributes(tr: Transaction, pos: number, attributes: FigureAttrs) {
    for (const [key, value] of Object.entries(attributes)) tr.setNodeAttribute(pos, key, value);
}

// Attributes of a `<figure>` or a `span.figure`; no img, no figure. Layout, alignment and width parse on their own.
function figureAttrsOf(dom: HTMLElement): FigureAttrs | false {
    const img = dom.querySelector('img');
    if (!img) return false;
    return {
        src: img.getAttribute('src'),
        alt: img.getAttribute('alt'),
        mediaName: img.getAttribute('data-media-name'),
        caption: dom.querySelector('figcaption, .figcaption')?.textContent || null,
        commentCardId: dom.getAttribute('data-comment-id'),
    };
}

export const FigureNode = Node.create({
    name: 'figure',

    group: 'inline',

    inline: true,

    atom: true,

    draggable: true,

    addAttributes() {
        return {
            mediaName: { default: null },
            src: { default: null },
            alt: { default: null },
            caption: { default: null },
            // The image's comment card. An attribute, not the comment mark text carries: the Yjs
            // binding persists a mark only on text.
            commentCardId: { default: null },
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
            alignment: {
                default: 'center',
                parseHTML: (element: HTMLElement) => element.getAttribute('data-alignment'),
            },
            layout: {
                default: 'block' as FigureLayout,
                parseHTML: (element: HTMLElement) => {
                    const attr = element.getAttribute('data-layout');
                    if (attr) return attr;
                    const float = element.style?.float;
                    if (float === 'left') return 'wrap-left';
                    if (float === 'right') return 'wrap-right';
                    return 'block';
                },
            },
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

    // Spans, as the export writes it: a <figure> in a <p> closes it in every HTML parser, so a pasted copy
    // would split its paragraph around the image.
    renderHTML({ HTMLAttributes }) {
        const figureAttrs: Record<string, unknown> = { class: 'figure' };
        if (HTMLAttributes['alignment'] && HTMLAttributes['alignment'] !== 'center') {
            figureAttrs['data-alignment'] = HTMLAttributes['alignment'];
        }
        if (HTMLAttributes['layout'] && HTMLAttributes['layout'] !== 'block') {
            figureAttrs['data-layout'] = HTMLAttributes['layout'];
        }
        // Spelled like the comment mark's, so a cut image keeps its card the way cut text does.
        if (HTMLAttributes['commentCardId']) {
            figureAttrs['data-comment-id'] = HTMLAttributes['commentCardId'];
        }
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

        if (HTMLAttributes['caption']) {
            return [
                'span',
                figureAttrs,
                ['img', imgAttrs],
                ['span', { class: 'figcaption' }, HTMLAttributes['caption']],
            ];
        }
        return ['span', figureAttrs, ['img', imgAttrs]];
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
            // Every figure the selection holds, or the one it selects.
            updateFigure:
                (attributes) =>
                ({ tr, dispatch }: CommandProps) => {
                    const { from, to } = tr.selection;
                    const positions: number[] = [];
                    tr.doc.nodesBetween(from, to, (node, pos) => {
                        if (node.type.name === this.name && pos >= from) positions.push(pos);
                    });
                    if (dispatch) for (const pos of positions) setFigureAttributes(tr, pos, attributes);
                    return positions.length > 0;
                },
        };
    },
});
