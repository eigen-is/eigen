// The box an image and a chart share in the Docs editor: the node view's wrapper the page's figure rules lay out, its
// selection ring, its grips and comment mark, and the plugins for a click beside it and a drag out of its paragraph. A
// figure in front of or behind the text is that wrapper placed at its offsets, with its chrome in a sibling above every
// layer, where a press drags it. The image and chart node views draw their content inside it.

import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Mapping } from '@tiptap/pm/transform';
import type { NodeViewProps } from '@tiptap/react';
import { NodeViewWrapper } from '@tiptap/react';
import type { FigureFrameAttrs, FigureLayout } from '@workspace/lib/docs/eigendoc';
import {
    cmText,
    figureLayoutStyle,
    isPositioned,
    pxToMm,
    readFigureAttrs,
    readFigureFrameAttrs,
    setFigureAttributes,
} from '@workspace/lib/docs/eigendoc';
import type { Box } from '@workspace/lib/vector';
import { ObjectTransform } from '@workspace/ui';
import { CommentIndicator } from '@workspace/ui/components/comments';
import { cn } from '@workspace/ui/lib/utils';
import type React from 'react';
import type { ReactNode, RefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { textColumnWidth } from './text-column';

// The resize floor of a figure's side (px).
export const FIGURE_MIN_SIZE = 100;

// The widest a resize makes a figure: the text column, half of it for a wrapped figure, and the paper of the page map
// for one in front of or behind the text.
export function figureMaxWidth(editor: Editor, layout: FigureLayout | null | undefined) {
    if (isPositioned(layout)) return editor.storage.positionedFigures.page().width;
    const fullWidth = textColumnWidth(editor.view.dom) ?? Infinity;
    return layout === 'wrap-left' || layout === 'wrap-right' ? fullWidth * 0.5 : fullWidth;
}

// The width a grip, Shift and an arrow, or the panel's Width field writes.
export function clampFigureWidth(width: number, maxWidth: number) {
    return Math.round(Math.max(FIGURE_MIN_SIZE, Math.min(maxWidth, width)));
}

// A wrap halves the cap, so a switch to one shrinks a wider figure to it in the same write, or nothing wraps beside it.
// The width to write with `layout`, none when the figure fits.
export function widthWithinLayout(
    editor: Editor,
    layout: FigureLayout | null | undefined,
    width: number | null | undefined,
): number | undefined {
    if (!layout || !width) return undefined;
    const maxWidth = figureMaxWidth(editor, layout);
    return width > maxWidth ? clampFigureWidth(width, maxWidth) : undefined;
}

// A layout for the selected image, from the Image panel or Format › Image. A place in front of or behind the text
// keeps the image where it is drawn, and a wrap shrinks a wider image to half the column in the same write.
export function setImageLayout(editor: Editor, layout: FigureLayout): boolean {
    if (isPositioned(layout)) return editor.commands.positionFigure(layout);
    const fitted = widthWithinLayout(editor, layout, readFigureAttrs(editor.getAttributes('figure')).width);
    return editor.commands.updateFigure(fitted === undefined ? { layout } : { layout, width: fitted });
}

// A grip's readout, in cm as Docs' fields show a size.
const figureSize = ({ width, height }: Box) => `${cmText(pxToMm(width), 1)} × ${cmText(pxToMm(height), 1)} cm`;

export type FigureFrameOptions = {
    // The host decides whether a menu opens, so a figure with no rows keeps the browser's own.
    onContextMenu: (node: PMNode, pos: number, event: React.MouseEvent) => void;
    onOpenComment: (cardId: string) => void;
};

// How far a grip moved a box's left and top edges, in page px. A west or a north grip moves them, as the opposite edge
// stays put, which a figure in front of or behind the text follows with its offsets.
type FigureShift = { dx: number; dy: number };

type FigureSize = { width: number; height: number };

// The offsets of a positioned figure whose grip moved its edges by `shift`; none for a figure in the flow.
function shiftedOffsets({ layout, offsetX, offsetY }: FigureFrameAttrs, { dx, dy }: FigureShift) {
    if (!isPositioned(layout) || (dx === 0 && dy === 0)) return {};
    return { offsetX: Math.round((offsetX ?? 0) + dx), offsetY: Math.round((offsetY ?? 0) + dy) };
}

// The fitted size keeps the edges opposite the grip where they were.
const shiftOf = (next: Box, start: Box, size: FigureSize): FigureShift => ({
    dx: next.x === start.x ? 0 : start.width - size.width,
    dy: next.y === start.y ? 0 : start.height - size.height,
});

// A resize previews locally and writes once, at the commit. `fit` turns a dragged box into the fitted size, and `stored`
// picks what the node keeps of it, which the commit writes with the offsets a west or a north grip moved.
export function useFigureResize<T extends FigureSize>({
    editor,
    getPos,
    node,
    getMaxWidth,
    fit,
    stored,
}: Pick<NodeViewProps, 'editor' | 'getPos' | 'node'> & {
    getMaxWidth: () => number;
    fit: (box: Box, maxWidth: number) => T;
    stored: (size: T) => Partial<FigureSize>;
}): {
    preview: { size: T; shift: FigureShift } | null;
    onTransform: (next: Box) => void;
    onCommit: (next: Box, start: Box) => void;
    onGestureEnd: () => void;
} {
    const [preview, setPreview] = useState<{ size: T; shift: FigureShift } | null>(null);
    // ObjectTransform has no onStart, so the first onTransform of a gesture, the box as pressed, latches the start and
    // the max width: a forced layout per move costs too much.
    const gestureStart = useRef<Box | null>(null);
    const gestureMaxWidth = useRef(Number.POSITIVE_INFINITY);

    const onTransform = useCallback(
        (next: Box) => {
            if (!gestureStart.current) {
                gestureStart.current = next;
                // A hidden surface reports <=0, which the fit's floor wins over.
                gestureMaxWidth.current = getMaxWidth();
            }
            const size = fit(next, gestureMaxWidth.current);
            setPreview({ size, shift: shiftOf(next, gestureStart.current, size) });
        },
        [getMaxWidth, fit],
    );

    const onCommit = useCallback(
        (next: Box, start: Box) => {
            const size = fit(next, gestureMaxWidth.current);
            const offsets = shiftedOffsets(readFigureFrameAttrs(node.attrs), shiftOf(next, start, size));
            editor.commands.command(({ tr }) => {
                const pos = getPos();
                if (pos === undefined) return false;
                setFigureAttributes(tr, pos, { ...stored(size), ...offsets });
                return true;
            });
        },
        [editor, getPos, node.attrs, fit, stored],
    );

    // Every gesture ends here, an Escape or a click that commits nothing too, and a deselect mid-drag unmounts the
    // transform, which ends it as well.
    const onGestureEnd = useCallback(() => {
        gestureStart.current = null;
        setPreview(null);
    }, []);

    return { preview, onTransform, onCommit, onGestureEnd };
}

type FigureFrameProps = Pick<NodeViewProps, 'node' | 'selected' | 'editor' | 'extension' | 'getPos' | 'decorations'> & {
    containerRef: RefObject<HTMLSpanElement | null>;
    // The box the transform chrome resizes; none shows the plain ring on a selected figure.
    box: Box | null;
    // The edges a grip has moved so far, which a positioned box draws at.
    shift?: FigureShift;
    resizeMode: 'aspect' | 'free';
    onTransform: (next: Box) => void;
    onCommit: (next: Box, start: Box) => void;
    onGestureEnd: () => void;
    label: string;
    keyShortcuts?: string;
    className?: string;
    children: ReactNode;
};

// The figure box the node view draws: the wrapper the page's .figure rules lay out, the selection ring and the
// transform chrome over the content, the comment mark and the caption. A positioned figure's wrapper is its absolute
// box, and while it is selected its chrome is a sibling at the same place above both layers, so text over a behind
// image never covers its grips. A press there, or on a front image, drags it, and the drop writes once.
export function FigureFrame({
    node,
    selected,
    editor,
    extension,
    getPos,
    decorations,
    containerRef,
    box,
    shift,
    resizeMode,
    onTransform,
    onCommit,
    onGestureEnd,
    label,
    keyShortcuts,
    className,
    children,
}: FigureFrameProps) {
    const { onContextMenu, onOpenComment }: FigureFrameOptions = extension.options;
    const commentCardId: string | null = node.attrs.commentCardId;
    const commentColor: string | undefined = decorations.find((d) => 'commentColor' in d.spec)?.spec.commentColor;
    const caption = node.attrs.caption || '';
    const isEditable = editor.isEditable;
    const frame = readFigureFrameAttrs(node.attrs);
    // The ring insets over the content, shrink-wrapped by the relative wrapper. A figure's size is in the page's pixels,
    // and the page draws scaled below its width, so a pointer delta divides by the scale, measured as a grip is pressed.
    const boxToStyle = useCallback((): React.CSSProperties => ({ inset: 0 }), []);
    const pageScale = useRef(1);
    const screenDeltaToScene = useCallback(
        (dx: number, dy: number) => ({ dx: dx / pageScale.current, dy: dy / pageScale.current }),
        [],
    );
    const measurePageScale = () => {
        const figure = containerRef.current;
        if (figure && figure.offsetWidth > 0)
            pageScale.current = figure.getBoundingClientRect().width / figure.offsetWidth;
    };

    // A drag previews its offsets locally; its document listeners end with the gesture, or with the view.
    const [move, setMove] = useState<FigureShift | null>(null);
    const moveGesture = useRef<AbortController | null>(null);
    useEffect(() => () => moveGesture.current?.abort(), []);
    // Where a positioned box draws; none for a figure in the flow.
    const place = figureLayoutStyle({
        ...frame,
        offsetX: (frame.offsetX ?? 0) + (shift?.dx ?? 0) + (move?.dx ?? 0),
        offsetY: (frame.offsetY ?? 0) + (shift?.dy ?? 0) + (move?.dy ?? 0),
        width: box?.width ?? node.attrs.width,
    });
    const chrome = place && box;

    const startMove = (e: React.PointerEvent) => {
        const pos = getPos();
        const figure = containerRef.current;
        if (e.button !== 0 || !isEditable || pos === undefined || !figure) return;
        // A finger on an image that isn't selected scrolls the page, and the comment mark is a button of its own.
        if ((e.pointerType === 'touch' && !selected) || (e.target instanceof Element && e.target.closest('button')))
            return;
        // ProseMirror then sees no mousedown, so it neither selects text nor starts the browser's drag.
        e.preventDefault();
        if (!selected) {
            editor.view.focus();
            editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
        }
        measurePageScale();
        const scale = pageScale.current;
        const start = figure.getBoundingClientRect();
        const { clientX, clientY, pointerId } = e;
        let delta: { x: number; y: number } | null = null;
        moveGesture.current?.abort();
        const gesture = new AbortController();
        moveGesture.current = gesture;
        const end = (commit: boolean) => {
            gesture.abort();
            setMove(null);
            const at = getPos();
            if (commit && delta && at !== undefined)
                editor.commands.moveFigure(at, { left: start.left + delta.x, top: start.top + delta.y });
        };
        const { signal } = gesture;
        document.addEventListener(
            'pointermove',
            (me) => {
                if (me.pointerId !== pointerId) return;
                delta = { x: me.clientX - clientX, y: me.clientY - clientY };
                setMove({ dx: delta.x / scale, dy: delta.y / scale });
            },
            { signal },
        );
        document.addEventListener('pointerup', (pe) => pe.pointerId === pointerId && end(true), { signal });
        document.addEventListener('pointercancel', (pe) => pe.pointerId === pointerId && end(false), { signal });
        // Ahead of the editor's keymap, whose Escape would put the caret beside the figure mid-drag.
        document.addEventListener(
            'keydown',
            (ke) => {
                if (ke.key !== 'Escape') return;
                ke.preventDefault();
                ke.stopPropagation();
                end(false);
            },
            { signal, capture: true },
        );
    };

    const transform = box && (
        <ObjectTransform
            box={box}
            boxToStyle={boxToStyle}
            screenDeltaToScene={screenDeltaToScene}
            showRotate={false}
            resizeMode={resizeMode}
            formatSize={figureSize}
            // Default minSize (1): in aspect mode the component floors BOTH dims, which would inflate
            // wide images (a 100 floor on a 4:1 banner's height forces width 400). The host's fit clamps.
            onTransform={onTransform}
            onCommit={onCommit}
            onGestureEnd={onGestureEnd}
        />
    );
    // After the transform, so its NE grip never covers the mark. A button, so ProseMirror leaves its press alone (no node
    // select); a prevented press keeps focus in the editor and starts no drag.
    const comment = commentCardId && (
        <button
            type="button"
            className="absolute top-0 right-0"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onOpenComment(commentCardId)}
            aria-label="Open comment"
            title="Open comment"
        >
            <CommentIndicator color={commentColor} className="block" />
        </button>
    );

    return (
        <>
            <NodeViewWrapper
                as="span"
                ref={containerRef}
                className={cn('figure', className)}
                data-layout={frame.layout ?? 'block'}
                data-alignment={frame.alignment ?? 'center'}
                // A positioned figure moves by the pointer gesture above, never by the browser's drag and drop.
                data-drag-handle={place ? undefined : ''}
                draggable={!place && isEditable}
                style={place ?? { cursor: isEditable ? 'grab' : undefined }}
                onPointerDown={place ? startMove : undefined}
                // ProseMirror never sees a node view's right-click (stopEvent), so the figure asks here.
                onContextMenu={(e: React.MouseEvent) => {
                    const pos = getPos();
                    if (pos !== undefined) onContextMenu(node, pos, e);
                }}
            >
                {/* Relative wrapper shrink-wraps the content so the inset-0 ObjectTransform ring lands exactly on it.
                    When no transform mounts (placeholder, read-only, pre-load), the same ring shows via the class. It
                    takes no focus: the editor's keymap resizes the selected figure, and a press stays free to start a
                    drag. */}
                <div
                    className={cn('relative', className, selected && !box && 'eigen-selection-ring')}
                    onPointerDownCapture={measurePageScale}
                    role={selected && isEditable ? 'group' : undefined}
                    aria-label={selected && isEditable ? label : undefined}
                    aria-keyshortcuts={selected && isEditable ? keyShortcuts : undefined}
                >
                    {children}
                    {!chrome && transform}
                    {!chrome && comment}
                </div>
                {caption && <span className="figcaption">{caption}</span>}
            </NodeViewWrapper>
            {chrome && (
                // z-index 2: above the front layer's 1, in the page's stacking context, as the paragraph makes none.
                <span
                    className="absolute z-2 cursor-move touch-none"
                    style={{ left: place.left, top: place.top, width: box.width, height: box.height }}
                    onPointerDownCapture={measurePageScale}
                    onPointerDown={startMove}
                >
                    {transform}
                    {comment}
                </span>
            )}
        </>
    );
}

// A click beside a block figure's content and a drag out of its paragraph, for the figure node named `name`.
export function figureFramePlugins(name: string): Plugin[] {
    return [
        new Plugin({
            key: new PluginKey('figureClickBeside'),
            props: {
                // A block figure's box is the column's width, so a click in the empty space beside the content lands
                // on the box: it puts the caret on that side, where ProseMirror would select the node.
                handleClickOn(view, _pos, node, nodePos, event, direct) {
                    const box = view.nodeDOM(nodePos)?.firstChild;
                    if (
                        !direct ||
                        node.type.name !== name ||
                        isPositioned(node.attrs.layout) ||
                        event.target !== box ||
                        !(box instanceof Element)
                    )
                        return false;
                    const content = box.firstElementChild?.getBoundingClientRect();
                    if (!content) return false;
                    const at = event.clientX < content.left + content.width / 2 ? nodePos : nodePos + node.nodeSize;
                    view.focus();
                    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)));
                    return true;
                },
            },
        }),
        new Plugin({
            key: new PluginKey('figureDragOut'),
            // A figure dragged out of a paragraph of its own takes the paragraph with it, where the paragraph's
            // parent can do without it. ProseMirror's drop moves the selected node.
            appendTransaction(transactions, oldState, newState) {
                const dragged = oldState.selection;
                if (
                    !transactions.some((tr) => tr.getMeta('uiEvent') === 'drop') ||
                    !(dragged instanceof NodeSelection) ||
                    dragged.node.type.name !== name
                )
                    return null;
                const mapping = new Mapping();
                for (const tr of transactions) mapping.appendMapping(tr.mapping);
                const $start = newState.doc.resolve(mapping.map(dragged.$from.before(), 1));
                const paragraph = $start.nodeAfter;
                if (
                    !paragraph?.isTextblock ||
                    paragraph.content.size > 0 ||
                    !$start.parent.canReplace($start.index(), $start.index() + 1)
                )
                    return null;
                return newState.tr.delete($start.pos, $start.pos + paragraph.nodeSize);
            },
        }),
    ];
}
