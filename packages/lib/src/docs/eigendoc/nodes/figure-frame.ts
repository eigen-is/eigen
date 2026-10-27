// The frame a Docs figure sits in, such as an image or a chart: where its box sits (in line, wrapped, or in front of or
// behind the text at an offset from its paragraph), its caption and its comment card. Each figure node takes its
// attributes and HTML from here. Every surface that draws one, such as the editor or the export, takes its box style,
// so they all draw the same box.

import type { CommandProps } from '@tiptap/core';
import type { DOMOutputSpec } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { MAX_PAPER_MM, mmToPx } from '../page';

// The nodes drawn in the figure's frame: an image and a chart.
export const FIGURE_FRAME_NODES = ['figure', 'chart'] as const;
export type FigureFrameNode = (typeof FIGURE_FRAME_NODES)[number];

export const isFigureFrameNode = (name: string | undefined): name is FigureFrameNode =>
    FIGURE_FRAME_NODES.some((node) => node === name);

// In front of and behind the text are out of the flow: the box sits at its offsets from its anchor paragraph. The
// prose stylesheet spells the two out again, as CSS can't import this list.
const POSITIONED_LAYOUTS = ['front', 'behind'] as const;
export type PositionedLayout = (typeof POSITIONED_LAYOUTS)[number];

// A positioned figure's or chart's box, in the editor or in pasted HTML.
export const POSITIONED_SELECTOR = POSITIONED_LAYOUTS.map((layout) => `[data-layout="${layout}"]`).join(', ');
const FIGURE_LAYOUTS = ['block', 'wrap-left', 'wrap-right', ...POSITIONED_LAYOUTS] as const;
export type FigureLayout = (typeof FIGURE_LAYOUTS)[number];
const FIGURE_ALIGNMENTS = ['left', 'center', 'right'] as const;
export type FigureAlignment = (typeof FIGURE_ALIGNMENTS)[number];

export const isPositioned = (layout: FigureLayout | null | undefined): layout is PositionedLayout =>
    POSITIONED_LAYOUTS.some((positioned) => positioned === layout);

// A positioned figure anchors on a body paragraph. Inside these nodes it draws in line, as a block.
export const BLOCK_ONLY_FIGURE_PARENTS = ['tableCell', 'tableHeader', 'footnote'];

// No paper is larger, so a forged offset or width can't stall the layout.
const MAX_POSITION_PX = mmToPx(MAX_PAPER_MM);

// The box a figure sits in: its place on the page, its caption and its comment card. Every attr defaults to null.
// The offsets are page px from the anchor paragraph's padding box, kept while the figure is in the flow, so a switch
// back to in front or behind restores its place.
export type FigureFrameAttrs = {
    caption?: string | null;
    alignment?: FigureAlignment | null;
    layout?: FigureLayout | null;
    offsetX?: number | null;
    offsetY?: number | null;
    commentCardId?: string | null;
};

// A figure's or a chart's stored width or height, which a collaborator can write as anything. One that isn't a positive
// number reads as unset, and one past the largest paper as that paper.
export const readFrameSide = (value: unknown): number | null =>
    typeof value === 'number' && value > 0 ? Math.min(MAX_POSITION_PX, value) : null;

const readOffset = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value)
        ? Math.min(MAX_POSITION_PX, Math.max(-MAX_POSITION_PX, value))
        : null;

// Only Eigen's own span places a figure: another app's <figure> or absolute <img> has no anchor paragraph to count from.
export const isOwnSpan = (element: HTMLElement) => element.tagName === 'SPAN';

const parseOffset = (element: HTMLElement, name: string) => {
    const attr = element.getAttribute(name);
    return attr && isOwnSpan(element) ? readOffset(Number(attr)) : null;
};

export function readFigureFrameAttrs(attrs: Record<string, unknown>): FigureFrameAttrs {
    const { caption, commentCardId } = attrs;
    return {
        caption: typeof caption === 'string' ? caption : null,
        alignment: FIGURE_ALIGNMENTS.find((a) => a === attrs['alignment']) ?? null,
        layout: FIGURE_LAYOUTS.find((l) => l === attrs['layout']) ?? null,
        offsetX: readOffset(attrs['offsetX']),
        offsetY: readOffset(attrs['offsetY']),
        commentCardId: typeof commentCardId === 'string' ? commentCardId : null,
    };
}

// A positioned box's place and width, which the stylesheet's rules can't know; nothing for a figure in the flow. The
// width goes on the box, because an image's max-width of 100% inside a shrink-to-fit box is cyclic.
export function figureLayoutStyle({
    layout,
    offsetX,
    offsetY,
    width,
}: FigureFrameAttrs & { width?: number | null }): { left: number; top: number; width?: number } | undefined {
    if (!isPositioned(layout)) return undefined;
    const place = { left: offsetX ?? 0, top: offsetY ?? 0 };
    return width ? { ...place, width: Math.min(MAX_POSITION_PX, width) } : place;
}

// A positioned box's offsets from its paragraph, kept on the paper: between the paper's left and right edges, and below
// its top. `anchor` is where the paragraph starts on the paper, and every length is in page px.
export function keepOnPaper(
    box: { x: number; y: number; width: number },
    anchor: { left: number; top: number },
    paperWidth: number,
): { offsetX: number; offsetY: number } {
    return {
        offsetX: Math.round(Math.max(-anchor.left, Math.min(paperWidth - box.width - anchor.left, box.x))),
        offsetY: Math.round(Math.max(-anchor.top, box.y)),
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
                if (attr && (!isPositioned(attr) || isOwnSpan(element))) return attr;
                const float = element.style?.float;
                if (float === 'left') return 'wrap-left';
                if (float === 'right') return 'wrap-right';
                return 'block';
            },
        },
        offsetX: {
            default: null,
            parseHTML: (element: HTMLElement) => parseOffset(element, 'data-offset-x'),
        },
        offsetY: {
            default: null,
            parseHTML: (element: HTMLElement) => parseOffset(element, 'data-offset-y'),
        },
    };
}

// Spans, as the export writes it: a <figure> in a <p> closes it in every HTML parser, so a pasted copy would split
// its paragraph around the content.
export function figureFrameHTML(
    frame: Record<string, unknown>,
    { alignment, layout, offsetX, offsetY, commentCardId, caption }: FigureFrameAttrs,
    content: DOMOutputSpec,
): DOMOutputSpec {
    const attrs = { ...frame };
    if (alignment && alignment !== 'center') attrs['data-alignment'] = alignment;
    // Every layout, block too: the prose stylesheet gives a figure its own line by it.
    attrs['data-layout'] = layout ?? 'block';
    if (offsetX != null) attrs['data-offset-x'] = offsetX;
    if (offsetY != null) attrs['data-offset-y'] = offsetY;
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
