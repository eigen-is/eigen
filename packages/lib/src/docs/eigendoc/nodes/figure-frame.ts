import type { CommandProps } from '@tiptap/core';
import type { DOMOutputSpec } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';

// The nodes drawn in the figure's frame: an image and a chart.
export const FIGURE_FRAME_NODES = ['figure', 'chart'] as const;
export type FigureFrameNode = (typeof FIGURE_FRAME_NODES)[number];

export const isFigureFrameNode = (name: string | undefined): name is FigureFrameNode =>
    FIGURE_FRAME_NODES.some((node) => node === name);

const FIGURE_LAYOUTS = ['block', 'wrap-left', 'wrap-right'] as const;
export type FigureLayout = (typeof FIGURE_LAYOUTS)[number];
const FIGURE_ALIGNMENTS = ['left', 'center', 'right'] as const;
export type FigureAlignment = (typeof FIGURE_ALIGNMENTS)[number];

// The box a figure sits in: its place on the page, its caption and its comment card. Every attr defaults to null.
export type FigureFrameAttrs = {
    caption?: string | null;
    alignment?: FigureAlignment | null;
    layout?: FigureLayout | null;
    commentCardId?: string | null;
};

export function readFigureFrameAttrs(attrs: Record<string, unknown>): FigureFrameAttrs {
    const { caption, commentCardId } = attrs;
    return {
        caption: typeof caption === 'string' ? caption : null,
        alignment: FIGURE_ALIGNMENTS.find((a) => a === attrs['alignment']) ?? null,
        layout: FIGURE_LAYOUTS.find((l) => l === attrs['layout']) ?? null,
        commentCardId: typeof commentCardId === 'string' ? commentCardId : null,
    };
}

export function figureFrameAttributes() {
    return {
        caption: {
            default: null,
            parseHTML: (element: HTMLElement) => element.querySelector('figcaption, .figcaption')?.textContent || null,
        },
        // The comment card. An attribute, not the comment mark text carries: the Yjs binding persists a mark only on text.
        commentCardId: {
            default: null,
            parseHTML: (element: HTMLElement) => element.getAttribute('data-comment-id'),
        },
        // A paste or a peer's HTML carries any string: an unknown one parses as the default.
        alignment: {
            default: 'center',
            parseHTML: (element: HTMLElement) =>
                FIGURE_ALIGNMENTS.find((a) => a === element.getAttribute('data-alignment')) ?? 'center',
        },
        layout: {
            default: 'block',
            parseHTML: (element: HTMLElement): FigureLayout => {
                const attr = FIGURE_LAYOUTS.find((l) => l === element.getAttribute('data-layout'));
                if (attr) return attr;
                const float = element.style?.float;
                if (float === 'left') return 'wrap-left';
                if (float === 'right') return 'wrap-right';
                return 'block';
            },
        },
    };
}

// Spans, as the export writes it: a <figure> in a <p> closes it in every HTML parser, so a pasted copy would split
// its paragraph around the content.
export function figureFrameHTML(
    frame: Record<string, unknown>,
    { alignment, layout, commentCardId, caption }: FigureFrameAttrs,
    content: DOMOutputSpec,
): DOMOutputSpec {
    const attrs = { ...frame };
    if (alignment && alignment !== 'center') attrs['data-alignment'] = alignment;
    if (layout && layout !== 'block') attrs['data-layout'] = layout;
    // Spelled like the comment mark's, so a cut figure keeps its card the way cut text does.
    if (commentCardId) attrs['data-comment-id'] = commentCardId;
    if (caption) return ['span', attrs, content, ['span', { class: 'figcaption' }, caption]];
    return ['span', attrs, content];
}

// An AttrStep maps no position, so a node selection on the node survives, and with it the editor's panel.
// TipTap's updateAttributes writes with setNodeMarkup, which replaces the leaf and maps that selection to a text one.
export function setFigureAttributes<T extends object>(tr: Transaction, pos: number, attributes: T) {
    for (const [key, value] of Object.entries(attributes)) tr.setNodeAttribute(pos, key, value);
}

// Every node named `name` the selection holds, or the one it selects.
export function updateFigureNodes<T extends object>(name: string, attributes: T) {
    return ({ tr, dispatch }: CommandProps) => {
        const { from, to } = tr.selection;
        const positions: number[] = [];
        tr.doc.nodesBetween(from, to, (node, pos) => {
            if (node.type.name === name && pos >= from) positions.push(pos);
        });
        if (dispatch) for (const pos of positions) setFigureAttributes(tr, pos, attributes);
        return positions.length > 0;
    };
}
