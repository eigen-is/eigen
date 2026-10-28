// The box a Docs figure draws in inside the editor, such as an image's or a chart's: the node view's wrapper that the
// page's figure rules lay out, its selection ring, its grips and its comment mark. It also holds the plugins for a
// click beside the box, a drag out of its paragraph and the selected figure's Keep aspect ratio. A figure in front of
// or behind the text is that wrapper placed at its offsets, with its grips in a sibling above every layer, where a
// press drags it. Each node view draws inside.

import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Mapping } from '@tiptap/pm/transform';
import type { Decoration as PMDecoration } from '@tiptap/pm/view';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { NodeViewProps } from '@tiptap/react';
import { NodeViewWrapper } from '@tiptap/react';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import type { FigureFrameAttrs, FigureFrameNode, FigureLayout } from '@workspace/lib/docs/eigendoc';
import {
    cmText,
    figureLayoutStyle,
    isPositioned,
    pxToMm,
    readFigureAttrs,
    readFigureFrameAttrs,
    readFrameSide,
} from '@workspace/lib/docs/eigendoc';
import type { Box } from '@workspace/lib/vector';
import { ObjectTransform } from '@workspace/ui';
import { CommentIndicator } from '@workspace/ui/components/comments';
import { cn } from '@workspace/ui/lib/utils';
import type React from 'react';
import type { ReactNode, RefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PaperRoom } from './positioned-figure';
import { roomOnPaper } from './positioned-figure';
import { pageScale, pageWidths, textColumnWidth } from './text-column';

// The resize floor of a figure's width (px). An image's height has none but a pixel, so a thin divider keeps its shape,
// and a chart's has the width's, as an axis and its labels need the room.
const FIGURE_MIN_WIDTH = 100;
const IMAGE_MIN_HEIGHT = 1;
export const CHART_MIN_HEIGHT = 100;

// The widest a resize makes a figure: the text column, half of it for a wrapped figure, and the paper of the page map
// for one in front of or behind the text. A page-less doc's block figure may grow past the reader's column up to the
// paper, and its wrap keeps half the page map's column, so neither depends on the reader's text width.
export function figureMaxWidth(editor: Editor, layout: FigureLayout | null | undefined) {
    const { paper, column, pageless } = pageWidths(editor);
    const wrap = layout === 'wrap-left' || layout === 'wrap-right';
    if (isPositioned(layout) || (pageless && !wrap)) return paper;
    const fullWidth = pageless ? column : (textColumnWidth(editor.view.dom) ?? Infinity);
    return wrap ? fullWidth * 0.5 : fullWidth;
}

// The whole width a resize writes, such as a grip's or Shift and an arrow's.
export function clampFigureWidth(width: number, maxWidth: number) {
    return Math.round(Math.max(FIGURE_MIN_WIDTH, Math.min(maxWidth, width)));
}

// What a size edit writes: a side it leaves out stays as stored.
export type FigureSizeEdit = { width?: number; height?: number };

// A size the panel asks for, fitted to `maxWidth`: the width within the floor and the cap, and a height that comes with
// it scaled alongside, so the figure keeps the shape it was given, above `minHeight`. Unlike a grip's, it stays
// unrounded, as a typed cm gives a fraction of a px.
export function fitFigureSize(
    size: FigureSizeEdit,
    maxWidth: number,
    minHeight: number = IMAGE_MIN_HEIGHT,
): FigureSizeEdit {
    const { width, height } = size;
    if (width === undefined) return height === undefined ? {} : { height: Math.max(minHeight, height) };
    const fitted = Math.max(FIGURE_MIN_WIDTH, Math.min(maxWidth, width));
    if (height === undefined) return { width: fitted };
    return { width: fitted, height: Math.max(minHeight, (height * fitted) / width) };
}

// A dragged box fitted to the column. With a ratio, the width is the one the box allows at that ratio and the height
// follows it, so a box whose top stopped at the paper's caps the width too. Without one, the width keeps to its floor
// and the height to `minHeight`.
export function fitFigureBox(
    next: Box,
    maxWidth: number,
    ratio: number | null,
    minHeight: number = IMAGE_MIN_HEIGHT,
): FigureSize {
    if (ratio === null) {
        return {
            width: clampFigureWidth(next.width, maxWidth),
            height: Math.round(Math.max(minHeight, next.height)),
        };
    }
    const width = clampFigureWidth(Math.min(next.width, next.height * ratio), maxWidth);
    return { width, height: width / ratio };
}

// A layout or an alignment for the selected image or chart, from its panel or Format › Image, which `write` writes. A
// place in front of or behind the text keeps the figure where it is drawn instead. A wrap halves the cap, so a switch
// to one shrinks a wider figure to it in the same write, or nothing wraps beside it, and a chart keeps its shape.
export function setFigureLayout(
    editor: Editor,
    attributes: FigureFrameAttrs,
    { width, height }: { width?: number | null; height?: number | null },
    write: (attributes: FigureFrameAttrs & { width?: number; height?: number }) => boolean,
): boolean {
    const { layout } = attributes;
    if (isPositioned(layout)) return editor.commands.positionFigure(layout);
    const maxWidth = layout ? figureMaxWidth(editor, layout) : Infinity;
    if (!width || width <= maxWidth) return write(attributes);
    const fitted = clampFigureWidth(width, maxWidth);
    return write({ ...attributes, width: fitted, ...(height && { height: Math.round((height * fitted) / width) }) });
}

// The Image panel's and Format › Image's write of a layout or an alignment.
export const setImageLayout = (editor: Editor, attributes: FigureFrameAttrs) =>
    setFigureLayout(editor, attributes, readFigureAttrs(editor.getAttributes('figure')), (written) =>
        editor.commands.updateFigure(written),
    );

// A positioned box's place: its top inline, and its left and width as custom properties, which one prose rule draws.
// A page-less doc's rule draws the box clamped into its text column and the strip beside it from them instead, so the
// stored place, which only the page map clamps, draws again on pages. The export writes the place inline.
const placeStyle = (top: number, left: number, width: number | undefined): Record<string, string | number> => ({
    top,
    '--figure-left': `${left}px`,
    ...(width !== undefined && { '--figure-width': `${width}px` }),
});

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

// The dragged box with its west, east and north edges no further out than `room` from where they were pressed.
function keptOnPaper(next: Box, start: Box, room: PaperRoom | null): Box {
    if (!room) return next;
    const left = Math.max(next.x, start.x - room.west);
    const right = Math.min(next.x + next.width, start.x + start.width + room.east);
    const top = Math.max(next.y, start.y - room.north);
    return { ...next, x: left, y: top, width: right - left, height: next.y + next.height - top };
}

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
    // ObjectTransform has no onStart, so the first onTransform of a gesture, the box as pressed, latches the start, the
    // max width and a positioned figure's room on the paper: a forced layout per move costs too much.
    const gestureStart = useRef<Box | null>(null);
    const gestureMaxWidth = useRef(Number.POSITIVE_INFINITY);
    const gestureRoom = useRef<PaperRoom | null>(null);

    const onTransform = useCallback(
        (next: Box) => {
            if (!gestureStart.current) {
                gestureStart.current = next;
                // A hidden surface reports <=0, which the fit's floor wins over.
                gestureMaxWidth.current = getMaxWidth();
                const pos = getPos();
                gestureRoom.current = pos === undefined ? null : roomOnPaper(editor, pos, next.width);
            }
            const box = keptOnPaper(next, gestureStart.current, gestureRoom.current);
            const size = fit(box, gestureMaxWidth.current);
            setPreview({ size, shift: shiftOf(box, gestureStart.current, size) });
        },
        [editor, getPos, getMaxWidth, fit],
    );

    const onCommit = useCallback(
        (next: Box, start: Box) => {
            const box = keptOnPaper(next, start, gestureRoom.current);
            const size = fit(box, gestureMaxWidth.current);
            const offsets = shiftedOffsets(readFigureFrameAttrs(node.attrs), shiftOf(box, start, size));
            const pos = getPos();
            if (pos !== undefined) editor.commands.resizeFigure(pos, { ...stored(size), ...offsets });
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

// How far, in screen px, a press travels before it is a drag rather than a click.
const CLICK_SLOP = 3;

// A drag of a figure in front of or behind the text previews its travel in page px and writes once, at the release,
// moving the figure by that travel from where it draws then. A press on an unselected figure selects it and drags it in
// the same gesture; a finger on one scrolls the page instead. With `onClick`, a press that travels no further than a
// click's slop moves nothing and is a click.
function useFigureMove({ editor, getPos, selected }: Pick<NodeViewProps, 'editor' | 'getPos' | 'selected'>): {
    travel: FigureShift | null;
    startMove: (e: React.PointerEvent, onClick?: (e: React.PointerEvent) => void) => void;
} {
    const [travel, setTravel] = useState<FigureShift | null>(null);
    // The gesture's document listeners end with it, or with the view.
    const gesture = useRef<AbortController | null>(null);
    useEffect(() => () => gesture.current?.abort(), []);

    const startMove = (e: React.PointerEvent, onClick?: (e: React.PointerEvent) => void) => {
        const pos = getPos();
        if (e.button !== 0 || !editor.isEditable || pos === undefined) return;
        // A finger on an image that isn't selected scrolls the page.
        if (e.pointerType === 'touch' && !selected) return;
        // ProseMirror then sees no mousedown, so it neither selects text nor starts the browser's drag.
        e.preventDefault();
        if (!selected) {
            editor.view.focus();
            editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
        }
        const scale = pageScale(editor.view.dom);
        const { clientX, clientY, pointerId } = e;
        let moved: FigureShift | null = null;
        gesture.current?.abort();
        const controller = new AbortController();
        gesture.current = controller;
        const end = (commit: boolean) => {
            controller.abort();
            setTravel(null);
            const at = getPos();
            if (commit && moved && at !== undefined) editor.commands.moveFigure(at, moved);
            else if (commit && onClick) onClick(e);
        };
        const { signal } = controller;
        document.addEventListener(
            'pointermove',
            (me) => {
                if (me.pointerId !== pointerId) return;
                const still = Math.hypot(me.clientX - clientX, me.clientY - clientY) <= CLICK_SLOP;
                if (onClick && !moved && still) return;
                moved = { dx: (me.clientX - clientX) / scale, dy: (me.clientY - clientY) / scale };
                setTravel(moved);
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

    return { travel, startMove };
}

type FigureFrameProps = Pick<NodeViewProps, 'node' | 'selected' | 'editor' | 'extension' | 'getPos' | 'decorations'> & {
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
    // A text box's: the move, the drag and the selection start on a band along its edge alone, and a press inside it
    // goes to `onInsidePress`, which opens it, or to its open editor when there is none. `text` is the element whose
    // border and padding hold the band.
    dragSurface?: { onInsidePress: ((e: React.PointerEvent) => void) | null; text: RefObject<HTMLElement | null> };
    children: ReactNode;
};

// How close to a box's edge, in screen px, a press moves or drags it instead of reaching its text.
const EDGE_BAND = 6;

// The band never reaches the text: on a side with less border and padding than the band, it is that border and padding.
function inEdgeBand(edge: Element, text: HTMLElement | null, { clientX: x, clientY: y }: React.PointerEvent) {
    const { left, right, top, bottom, width } = edge.getBoundingClientRect();
    const style = text && getComputedStyle(text);
    // The padding is in the page's px, which a page drawn scaled draws smaller.
    const scale = text && text.offsetWidth > 0 ? width / text.offsetWidth : 1;
    const band = (side: 'left' | 'right' | 'top' | 'bottom') => {
        if (!style) return EDGE_BAND;
        const inset = parseFloat(style.getPropertyValue(`padding-${side}`)) || 0;
        const border = parseFloat(style.getPropertyValue(`border-${side}-width`)) || 0;
        return Math.min(EDGE_BAND, (inset + border) * scale);
    };
    return x < left + band('left') || x > right - band('right') || y < top + band('top') || y > bottom - band('bottom');
}

// The figure box the node view draws: the wrapper the page's .figure rules lay out, the selection ring and the
// transform chrome over the content, the comment mark and the caption. A positioned figure's wrapper is its absolute
// box, and while it is selected its chrome is a sibling at the same place above both layers, so text over a behind
// image never covers its grips. A press there, or on a front image, drags it.
export function FigureFrame({
    node,
    selected,
    editor,
    extension,
    getPos,
    decorations,
    box,
    shift,
    resizeMode,
    onTransform,
    onCommit,
    onGestureEnd,
    label,
    keyShortcuts,
    className,
    dragSurface,
    children,
}: FigureFrameProps) {
    const { onContextMenu, onOpenComment }: FigureFrameOptions = extension.options;
    const commentCardId: string | null = node.attrs.commentCardId;
    const commentColor: string | undefined = decorations.find((d) => 'commentColor' in d.spec)?.spec.commentColor;
    const caption = node.attrs.caption || '';
    const isEditable = editor.isEditable;
    const frame = readFigureFrameAttrs(node.attrs);
    // The ring insets over the content, shrink-wrapped by the relative wrapper. A figure's size is in the page's pixels,
    // and it draws smaller than that on a page drawn scaled, or when it is wider than the room it has, so a grip's
    // delta divides by its drawn width over its stored one, measured as it is pressed.
    const boxToStyle = useCallback((): React.CSSProperties => ({ inset: 0 }), []);
    const scale = useRef(1);
    const screenDeltaToScene = useCallback(
        (dx: number, dy: number) => ({ dx: dx / scale.current, dy: dy / scale.current }),
        [],
    );
    const contentRef = useRef<HTMLDivElement | null>(null);
    const measureScale = () => {
        const drawn = contentRef.current?.getBoundingClientRect().width ?? 0;
        scale.current = box && box.width > 0 && drawn > 0 ? drawn / box.width : pageScale(editor.view.dom);
    };

    const { travel, startMove } = useFigureMove({ editor, getPos, selected });
    // Where a positioned box draws; none for a figure in the flow.
    const place = figureLayoutStyle({
        ...frame,
        offsetX: (frame.offsetX ?? 0) + (shift?.dx ?? 0) + (travel?.dx ?? 0),
        offsetY: (frame.offsetY ?? 0) + (shift?.dy ?? 0) + (travel?.dy ?? 0),
        width: box?.width ?? readFrameSide(node.attrs.width),
    });
    const chrome = place && box;

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

    // A press moves a positioned figure. On a text box a press on its edge band does, and one inside it goes to its
    // text. A box with no padding and no outline has no band, so a drag inside a selected one in front of or behind
    // the text moves it too, as in Google Docs, and only a click goes to its text. A box in the flow drags from its edge
    // as ProseMirror drags a node. The comment mark is a button of its own, which neither moves nor opens the box.
    const press =
        (move: ((e: React.PointerEvent, onClick?: (e: React.PointerEvent) => void) => void) | undefined) =>
        (e: React.PointerEvent) => {
            if (e.target instanceof Element && e.target.closest('button')) return;
            const edge = contentRef.current;
            const inside = dragSurface?.onInsidePress;
            if (!dragSurface || !edge || inEdgeBand(edge, dragSurface.text.current, e)) move?.(e);
            else if (e.button === 0 && inside) {
                if (move && selected) move(e, inside);
                else inside(e);
            }
        };

    return (
        <>
            <NodeViewWrapper
                as="span"
                className={cn('figure', className)}
                data-layout={frame.layout ?? 'block'}
                data-alignment={frame.alignment ?? 'center'}
                // A positioned figure moves by the pointer gesture above, never by the browser's drag and drop. A text
                // box is draggable only from its edge, which ProseMirror's own press makes draggable, as WebKit starts
                // the browser's drag from a draggable box even inside its open editor.
                data-drag-handle={place ? undefined : ''}
                draggable={!place && isEditable && !dragSurface}
                style={
                    place
                        ? placeStyle(place.top, place.left, place.width)
                        : { cursor: isEditable && !dragSurface ? 'grab' : undefined }
                }
                onPointerDown={place || dragSurface ? press(place ? startMove : undefined) : undefined}
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
                    ref={contentRef}
                    className={cn('relative', className, selected && !box && 'eigen-selection-ring')}
                    onPointerDownCapture={measureScale}
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
                // Why: the grips sit above the front layer's 1, the Docs figure layer of the z-index scale. The
                // paragraph makes no stacking context, so both stack in the page's. Its height follows the width it
                // draws at, as the figure's does, where a page-less column draws it narrower.
                <span
                    className="absolute z-2 cursor-move touch-none"
                    data-figure-chrome=""
                    style={{
                        ...placeStyle(place.top, place.left, box.width),
                        aspectRatio: `${box.width} / ${box.height}`,
                    }}
                    onPointerDownCapture={measureScale}
                    onPointerDown={press(startMove)}
                >
                    {transform}
                    {comment}
                </span>
            )}
        </>
    );
}

// Keep aspect ratio, which the panel's box and the grips share: on for a picture and off for a chart and a text box, as
// on a slide.
// A choice lasts while its figure stays selected, as a node has no id to remember it by.
const ASPECT_LOCKED_BY_DEFAULT: Record<FigureFrameNode, boolean> = { figure: true, chart: false, textBox: false };
type AspectChoice = { pos: number; locked: boolean };
const ASPECT_LOCK_KEYS: Record<FigureFrameNode, PluginKey<AspectChoice | null>> = {
    figure: new PluginKey('figureAspectLock'),
    chart: new PluginKey('chartAspectLock'),
    textBox: new PluginKey('textBoxAspectLock'),
};

const selectedFigureAt = (state: EditorState, name: FigureFrameNode) =>
    state.selection instanceof NodeSelection && state.selection.node.type.name === name ? state.selection.from : null;

export const isAspectLocked = (state: EditorState, name: FigureFrameNode): boolean =>
    ASPECT_LOCK_KEYS[name].getState(state)?.locked ?? ASPECT_LOCKED_BY_DEFAULT[name];

export const setAspectLocked = (editor: Editor, name: FigureFrameNode, locked: boolean) =>
    editor.view.dispatch(editor.state.tr.setMeta(ASPECT_LOCK_KEYS[name], locked));

// The lock a node view's grips follow, which the selected figure carries as a decoration.
export function aspectLockedIn(decorations: readonly PMDecoration[], name: FigureFrameNode): boolean {
    const lock = decorations.find((d) => 'aspectLocked' in d.spec);
    return lock ? lock.spec.aspectLocked === true : ASPECT_LOCKED_BY_DEFAULT[name];
}

// The choice follows its figure through an edit around it. A peer's change replaces the whole doc, which maps every
// position away, while the selection survives it, so the choice survives it too.
function aspectLockPlugin(name: FigureFrameNode): Plugin<AspectChoice | null> {
    const key = ASPECT_LOCK_KEYS[name];
    return new Plugin<AspectChoice | null>({
        key,
        state: {
            init: () => null,
            apply(tr, choice, _oldState, state) {
                const at = selectedFigureAt(state, name);
                const locked: unknown = tr.getMeta(key);
                if (at === null) return null;
                if (typeof locked === 'boolean') return { pos: at, locked };
                if (!choice || (!tr.getMeta(ySyncPluginKey) && tr.mapping.map(choice.pos) !== at)) return null;
                return { pos: at, locked: choice.locked };
            },
        },
        props: {
            decorations(state) {
                const at = selectedFigureAt(state, name);
                if (at === null) return null;
                const decoration = Decoration.node(at, at + 1, {}, { aspectLocked: isAspectLocked(state, name) });
                return DecorationSet.create(state.doc, [decoration]);
            },
        },
    });
}

// A click beside a block figure's content, a drag out of its paragraph and the lock, for the figure node named `name`.
export function figureFramePlugins(name: FigureFrameNode): Plugin[] {
    return [
        aspectLockPlugin(name),
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
