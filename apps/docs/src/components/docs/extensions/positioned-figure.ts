// A figure in front of or behind the text, such as an image or a text box, draws at an offset from its paragraph and
// takes no room on its line. This extension keeps the caret and the keys off such a figure, which always leads its
// paragraph. Its commands place the figure on the paper when it is switched, dragged or resized, and the body grows
// under the lowest one. A band's or a story's editor draws every figure in line. Every docs editor registers it.

import type { Editor } from '@tiptap/core';
import { Extension } from '@tiptap/core';
import { deleteSelection, joinBackward, joinForward, selectNodeBackward, selectNodeForward } from '@tiptap/pm/commands';
import type { NodeType, Node as PMNode, ResolvedPos } from '@tiptap/pm/model';
import type { Command, EditorState, Transaction } from '@tiptap/pm/state';
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state';
import { AttrStep } from '@tiptap/pm/transform';
import type { EditorView } from '@tiptap/pm/view';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import type { PageSetup, PositionedLayout } from '@workspace/lib/docs/eigendoc';
import {
    BLOCK_ONLY_FIGURE_PARENTS,
    DEFAULT_PAGE_SETUP,
    heightAtWidth,
    isFigureFrameNode,
    isPositioned,
    keepOnPaper,
    POSITIONED_SELECTOR,
    pagePx,
    readFigureFrameAttrs,
    readFrameSide,
    setFigureAttributes,
} from '@workspace/lib/docs/eigendoc';
import { pageScale } from './text-column';

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        positionedFigures: {
            // The selected figure or chart in front of or behind the text, where it is drawn now.
            positionFigure: (layout: PositionedLayout) => ReturnType;
            // The positioned figure at `pos` moved by `dx` and `dy` page px from where it draws now, on the paragraph
            // under it.
            moveFigure: (pos: number, travel: { dx: number; dy: number }) => ReturnType;
            // The figure or chart at `pos` resized, with the offsets a west or north grip moved. One in front of or
            // behind the text that grows past the paper's edge moves back onto it, as a drag keeps it there.
            resizeFigure: (pos: number, attributes: FigureResize) => ReturnType;
        };
    }

    interface Storage {
        positionedFigures: PositionedFiguresOptions;
    }
}

type FigureResize = { width?: number; height?: number; offsetX?: number; offsetY?: number };

// How far a positioned figure's west, east and north edges are from the paper's, in page px.
export type PaperRoom = { west: number; east: number; north: number };

type PositionedFiguresOptions = {
    // The page map in px: the paper a positioned figure stays on, never the column a screen lays out.
    page: () => PageSetup;
    // A band's editor and a note's draw every figure in line.
    band: boolean;
    note: boolean;
};

const positionedFiguresKey = new PluginKey('positionedFigures');

// A selection the keymap moves to a paragraph's start on purpose, which the caret rest leaves there.
const REWIND = 'rewind';

const LIST_ITEMS = ['listItem', 'taskItem'];

const isPositionedFigure = (node: PMNode | null): node is PMNode =>
    node !== null && isFigureFrameNode(node.type.name) && isPositioned(node.attrs.layout);

// A figure at `$pos` draws in line whatever its layout in a band's or a note's editor, and in a table cell or a note.
function drawsInLine($pos: ResolvedPos, { band, note }: PositionedFiguresOptions): boolean {
    return (
        band ||
        note ||
        Array.from({ length: $pos.depth + 1 }, (_, depth) => $pos.node(depth).type.name).some((name) =>
            BLOCK_ONLY_FIGURE_PARENTS.includes(name),
        )
    );
}

// Where the selected figure draws in line, its panel and Format › Image offer no place in front of or behind the text.
export const selectionDrawsInLine = (editor: Editor): boolean =>
    drawsInLine(editor.state.selection.$from, editor.storage.positionedFigures);

// A band holds no float, as a docx import reads a header's anchored picture as one in its own line. So a figure in a
// band's editor offers its alignment alone, in its panel and in Format › Image.
export const inBand = (editor: Editor): boolean => editor.storage.positionedFigures.band;

// The positioned figures a textblock starts with: how many, and how many positions they take, as a text box holds its
// paragraphs and is longer than one.
function leadingRun(textblock: PMNode): { count: number; size: number } {
    let count = 0;
    let size = 0;
    for (; count < textblock.childCount; count++) {
        const child = textblock.child(count);
        if (!isPositionedFigure(child)) break;
        size += child.nodeSize;
    }
    return { count, size };
}

// Where each figure of the leading run of the textblock whose content starts at `start` is.
function runPositions(textblock: PMNode, start: number): number[] {
    const positions: number[] = [];
    const { count } = leadingRun(textblock);
    let pos = start;
    for (let index = 0; index < count; index++) {
        positions.push(pos);
        pos += textblock.child(index).nodeSize;
    }
    return positions;
}

// The empty caret at the visual start of a textblock that leads with positioned figures: right after them.
function caretAfterRun(state: EditorState): ResolvedPos | null {
    const { selection } = state;
    if (!(selection instanceof TextSelection) || !selection.$cursor) return null;
    const { count, size } = leadingRun(selection.$cursor.parent);
    return count > 0 && selection.$cursor.parentOffset === size ? selection.$cursor : null;
}

// Shift+Home, Shift+Up or a pointer can make a text selection that holds part of a leading run. This returns the same
// selection without the run, or null when it holds none. An end inside a run moves to just after it. A selection that
// reaches into a later textblock no further than its run ends before that textblock instead, so Backspace never
// deletes an image that is drawn elsewhere. Both ends are fixed at once, because ProseMirror never hands a plugin's own
// appended transaction back to it.
function selectionOutsideRuns(selection: Selection): TextSelection | null {
    if (!(selection instanceof TextSelection)) return null;
    const { $from, $to } = selection;
    const past = $from.start() + leadingRun($from.parent).size;
    const from = Math.max($from.pos, past);
    const to = $from.sameParent($to)
        ? Math.max($to.pos, past)
        : $to.parentOffset <= leadingRun($to.parent).size
          ? $to.start()
          : $to.pos;
    if (from === $from.pos && to === $to.pos) return null;
    const forward = selection.anchor <= selection.head;
    return TextSelection.create(selection.$anchor.doc, forward ? from : to, forward ? to : from);
}

function rectAt(view: EditorView, pos: number): DOMRect | null {
    const dom = view.nodeDOM(pos);
    return dom instanceof Element ? dom.getBoundingClientRect() : null;
}

// The drawn box of the figure at `pos`: the frame's content, inside the node view's wrapper.
function figureBoxAt(view: EditorView, pos: number): DOMRect | null {
    const dom = view.nodeDOM(pos);
    const box = dom instanceof Element ? dom.firstElementChild?.firstElementChild : null;
    return box ? box.getBoundingClientRect() : null;
}

// Where the paragraph drawn at `anchor` starts on the paper of the page map: the page map's margin plus its distance
// from the text column, so a narrow screen's column clamps nothing it wouldn't on a desktop.
function anchorOnPaper(view: EditorView, page: PageSetup, anchor: DOMRect): { left: number; top: number } {
    const scale = pageScale(view.dom);
    const column = view.dom.getBoundingClientRect();
    return {
        left: page.margin.left + (anchor.left - column.left) / scale,
        top: page.margin.top + (anchor.top - column.top) / scale,
    };
}

// A box's offsets from its anchor paragraph's drawn rect, kept on the paper of the page map.
function offsetsOnPaper(
    view: EditorView,
    page: PageSetup,
    box: { left: number; top: number; width: number },
    anchor: DOMRect,
): { offsetX: number; offsetY: number } {
    const scale = pageScale(view.dom);
    const x = (box.left - anchor.left) / scale;
    const y = (box.top - anchor.top) / scale;
    return keepOnPaper({ x, y, width: box.width }, anchorOnPaper(view, page, anchor), page.width);
}

// The room on the paper around the positioned figure at `pos`, drawn `width` page px wide, which a grip grows it into
// and no further, so resizeFigure never moves it back and its opposite edge stays put. Null for a figure in the flow.
export function roomOnPaper(editor: Editor, pos: number, width: number): PaperRoom | null {
    const { view } = editor;
    const node = view.state.doc.nodeAt(pos);
    if (!isPositionedFigure(node)) return null;
    const anchor = rectAt(view, view.state.doc.resolve(pos).before());
    if (!anchor) return null;
    const page = editor.storage.positionedFigures.page();
    const { left, top } = anchorOnPaper(view, page, anchor);
    const { offsetX, offsetY } = readFigureFrameAttrs(node.attrs);
    const x = left + (offsetX ?? 0);
    return {
        west: Math.max(0, x),
        east: Math.max(0, page.width - x - width),
        north: Math.max(0, top + (offsetY ?? 0)),
    };
}

// The body textblock a dropped box's top edge lies over: the last one whose top is above it. One in a table, or one
// that can't hold the figure, such as a code block, keeps the figure where it is anchored: null.
function anchorUnder(view: EditorView, top: number, type: NodeType): number | null {
    const blocks: { pos: number; holds: boolean }[] = [];
    view.state.doc.descendants((node, pos) => {
        if (node.type.name === 'table') blocks.push({ pos, holds: false });
        else if (node.isTextblock) blocks.push({ pos, holds: node.contentMatchAt(0).matchType(type) !== null });
        else return true;
        return false;
    });
    // Document order is top to bottom, so a binary search reads a few rects of a long doc.
    let low = 0;
    let high = blocks.length - 1;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if ((rectAt(view, blocks[middle].pos)?.top ?? 0) <= top) low = middle;
        else high = middle - 1;
    }
    const block = blocks[low];
    return block?.holds ? block.pos : null;
}

// Moves every positioned figure of the textblock at `pos` that sits after its text to the end of its leading run, in
// order. The textblock keeps its size.
function leadFigures(tr: Transaction, pos: number) {
    const textblock = tr.doc.resolve(pos + 1).parent;
    const run = leadingRun(textblock);
    const strays: { node: PMNode; at: number }[] = [];
    textblock.forEach((child, offset, index) => {
        if (index > run.count && isPositionedFigure(child)) strays.push({ node: child, at: pos + 1 + offset });
    });
    if (strays.length === 0) return;
    for (const { node, at } of strays.toReversed()) tr.delete(at, at + node.nodeSize);
    tr.insert(
        pos + 1 + run.size,
        strays.map(({ node }) => node),
    );
}

// The textblocks the transactions changed, as positions in the last one's doc. One span covers every step, so a
// transaction of thousands of steps, such as a replace-all, maps two positions per step. A textblock inside the span
// that no step changed has nothing to fix. An attribute step counts its node.
function changedTextblocks(transactions: readonly Transaction[], doc: PMNode): number[] {
    let from = Number.POSITIVE_INFINITY;
    let to = Number.NEGATIVE_INFINITY;
    for (const tr of transactions) {
        for (const [index, step] of tr.steps.entries()) {
            const map = tr.mapping.maps[index];
            if (from <= to) {
                from = map.map(from, -1);
                to = map.map(to, 1);
            }
            if (step instanceof AttrStep) {
                from = Math.min(from, step.pos);
                to = Math.max(to, step.pos + 1);
            } else
                map.forEach((_oldFrom, _oldTo, start, end) => {
                    from = Math.min(from, start);
                    to = Math.max(to, end);
                });
        }
    }
    const textblocks: number[] = [];
    if (from > to) return textblocks;
    // A note's paragraphs are inside its reference, an inline node of a textblock.
    doc.nodesBetween(Math.max(0, from - 1), Math.min(doc.content.size, to + 1), (node, pos) => {
        if (node.isTextblock) textblocks.push(pos);
    });
    return textblocks;
}

// Runs `join` from `selection`, as at a plain textblock's edge. Each figure of `figures` that the join carries into the
// textblock at `into` keeps the place where it is drawn. Its offsets are measured against that textblock before the
// dispatch, and it leads the joined textblock. At the doc's start there is nothing to join, and the figures stay put.
function joinKeepingPlace(
    view: EditorView,
    selection: Selection,
    figures: number[],
    into: number,
    join: Command,
): boolean {
    const scale = pageScale(view.dom);
    const target = rectAt(view, into);
    const boxes = figures.map((pos) => figureBoxAt(view, pos));
    const state = view.state.apply(view.state.tr.setSelection(selection).setMeta(positionedFiguresKey, REWIND));
    const joins: Transaction[] = [];
    if (!join(state, (tr) => joins.push(tr))) return true;
    const [tr] = joins;
    const joined = tr.mapping.map(into);
    for (const [index, figure] of figures.entries()) {
        const pos = tr.mapping.map(figure);
        const box = boxes[index];
        if (tr.doc.resolve(pos).before() !== joined || !box || !target) continue;
        setFigureAttributes(tr, pos, {
            offsetX: Math.round((box.left - target.left) / scale),
            offsetY: Math.round((box.top - target.top) / scale),
        });
    }
    leadFigures(tr, joined);
    view.dispatch(tr.scrollIntoView());
    return true;
}

// A selection that ends before a run in a later textblock, as Shift+ArrowLeft at the visual start makes it: Backspace
// or Delete joins the two textblocks, which keeps the run where it is drawn.
function deleteKeepingPlace(view: EditorView): boolean {
    const { selection } = view.state;
    const { $from, $to } = selection;
    const figures = runPositions($to.parent, $to.start());
    if (!(selection instanceof TextSelection) || selection.empty || $to.parentOffset !== 0 || figures.length === 0)
        return false;
    return joinKeepingPlace(view, selection, figures, $from.before(), deleteSelection);
}

// The caret at the very start of its textblock, before the run, where the next keymap acts as at a plain textblock's
// start, as Enter splits there and a list item lifts.
function rewind(view: EditorView, $caret: ResolvedPos) {
    const { tr, doc } = view.state;
    view.dispatch(tr.setSelection(TextSelection.create(doc, $caret.start())).setMeta(positionedFiguresKey, REWIND));
}

// Escape or a plain arrow on a selected positioned figure: the caret at the visual start of its paragraph.
function caretFromFigure(editor: Editor): boolean {
    const { selection } = editor.state;
    if (!(selection instanceof NodeSelection) || !isPositionedFigure(selection.node)) return false;
    const { $from } = selection;
    return editor.commands.setTextSelection($from.start() + leadingRun($from.parent).size);
}

// The behind figure a press at (x, y) selects: the topmost under the pointer, when no line of text is there or Alt is
// held. The paragraph's box lies over the figure, so the hit test is geometry: every element under the point, and the
// rects of the text lines of the textblock on top.
export function behindFigureAt(view: EditorView, x: number, y: number, alt: boolean): number | null {
    const hits = view.dom.ownerDocument.elementsFromPoint(x, y);
    const box = hits.map((hit) => hit.closest('.figure[data-layout="behind"]')).find((hit) => !!hit);
    if (!box || !view.dom.contains(box)) return null;
    const [top] = hits;
    if (!alt && top && view.dom.contains(top) && !box.contains(top)) {
        if (top.closest('.figure')) return null;
        const $top = view.state.doc.resolve(view.posAtDOM(top, 0));
        const textblock = $top.parent.isTextblock ? view.nodeDOM($top.before()) : null;
        if (textblock instanceof Element && overText(textblock, x, y)) return null;
    }
    // Before an image, as it is an atom, and at the start of a text box's own paragraphs, which it holds.
    const at = view.posAtDOM(box, 0);
    const $at = view.state.doc.resolve(at);
    const pos = isPositionedFigure(view.state.doc.nodeAt(at)) || $at.depth === 0 ? at : $at.before();
    return isPositionedFigure(view.state.doc.nodeAt(pos)) ? pos : null;
}

function overText(textblock: Element, x: number, y: number): boolean {
    const walker = textblock.ownerDocument.createTreeWalker(textblock, NodeFilter.SHOW_TEXT);
    const range = textblock.ownerDocument.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement?.closest('.figure')) continue;
        range.selectNodeContents(node);
        for (const rect of range.getClientRects())
            if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
    }
    return false;
}

// The body's min-height reaches the lowest positioned box, so the notes and the footer band draw below it. A doc with
// none reads no layout. It runs at most once a frame, as each run lays out the page.
function growBody(view: EditorView) {
    const boxes = view.dom.querySelectorAll(POSITIONED_SELECTOR);
    if (boxes.length === 0) {
        view.dom.style.minHeight = '';
        return;
    }
    const top = view.dom.getBoundingClientRect().top;
    let bottom = top;
    for (const box of boxes) bottom = Math.max(bottom, box.getBoundingClientRect().bottom);
    view.dom.style.minHeight = `${Math.ceil((bottom - top) / pageScale(view.dom))}px`;
}

export const PositionedFigures = Extension.create<PositionedFiguresOptions, PositionedFiguresOptions>({
    name: 'positionedFigures',

    // Ahead of the core keymap and the lists', whose Backspace and Enter would act at the caret after the run.
    priority: 1000,

    addOptions() {
        return { page: () => pagePx(DEFAULT_PAGE_SETUP), band: false, note: false };
    },

    addStorage() {
        return { ...this.options };
    },

    addCommands() {
        const { page } = this.options;
        return {
            positionFigure:
                (layout) =>
                ({ tr, view, dispatch }) => {
                    const { selection } = tr;
                    if (!(selection instanceof NodeSelection) || !isFigureFrameNode(selection.node.type.name))
                        return false;
                    if (!dispatch) return true;
                    const { node, from: pos, $from } = selection;
                    if (isPositioned(node.attrs.layout)) {
                        setFigureAttributes(tr, pos, { layout });
                        return true;
                    }
                    const paper = page();
                    const box = figureBoxAt(view, pos);
                    const anchor = rectAt(view, $from.before());
                    const stored = readFrameSide(node.attrs.width);
                    const height = readFrameSide(node.attrs.height);
                    const width = Math.min(paper.width, stored ?? (box?.width ?? 0) / pageScale(view.dom));
                    // A figure wider than the paper is capped at it, its height scaled alongside so it keeps its shape.
                    const capped = stored !== null && stored > paper.width;
                    const cappedHeight =
                        capped && height && Math.round(heightAtWidth({ width: stored, height }, paper.width));
                    setFigureAttributes(tr, pos, {
                        layout,
                        ...(box && anchor
                            ? offsetsOnPaper(view, paper, { left: box.left, top: box.top, width }, anchor)
                            : { offsetX: 0, offsetY: 0 }),
                        ...(capped && { width: paper.width }),
                        ...(cappedHeight && { height: cappedHeight }),
                    });
                    const run = leadingRun($from.parent);
                    if ($from.index() > run.count) {
                        leadFigures(tr, $from.before());
                        tr.setSelection(NodeSelection.create(tr.doc, $from.start() + run.size));
                    }
                    return true;
                },
            moveFigure:
                (pos, { dx, dy }) =>
                ({ tr, view, dispatch }) => {
                    const node = tr.doc.nodeAt(pos);
                    if (!isPositionedFigure(node)) return false;
                    const $pos = tr.doc.resolve(pos);
                    const own = rectAt(view, $pos.before());
                    const box = figureBoxAt(view, pos);
                    if (!own || !box) return false;
                    // Its paragraph's place now, so a scroll or a peer's typing above it since the drag began moves
                    // nothing the drag didn't.
                    const scale = pageScale(view.dom);
                    const { offsetX, offsetY } = readFigureFrameAttrs(node.attrs);
                    const at = {
                        left: own.left + ((offsetX ?? 0) + dx) * scale,
                        top: own.top + ((offsetY ?? 0) + dy) * scale,
                    };
                    const anchor = anchorUnder(view, at.top, node.type) ?? $pos.before();
                    const rect = rectAt(view, anchor);
                    if (!rect) return false;
                    if (!dispatch) return true;
                    const width = readFrameSide(node.attrs.width) ?? box.width / scale;
                    const offsets = offsetsOnPaper(view, page(), { ...at, width }, rect);
                    if (anchor === $pos.before()) {
                        setFigureAttributes(tr, pos, offsets);
                        return true;
                    }
                    // A delete and an insert, so the figure is in one place; the selection follows it, or the panel closes.
                    // A text box goes with its paragraphs.
                    tr.delete(pos, pos + node.nodeSize);
                    const $anchor = tr.doc.resolve(tr.mapping.map(anchor) + 1);
                    const to = $anchor.start() + leadingRun($anchor.parent).size;
                    tr.insert(to, node.type.create({ ...node.attrs, ...offsets }, node.content, node.marks));
                    tr.setSelection(NodeSelection.create(tr.doc, to));
                    return true;
                },
            resizeFigure:
                (pos, attributes) =>
                ({ tr, view, dispatch }) => {
                    const node = tr.doc.nodeAt(pos);
                    if (!node || !isFigureFrameNode(node.type.name)) return false;
                    if (!dispatch) return true;
                    const anchor = rectAt(view, tr.doc.resolve(pos).before());
                    if (!isPositionedFigure(node) || !anchor) {
                        setFigureAttributes(tr, pos, attributes);
                        return true;
                    }
                    const scale = pageScale(view.dom);
                    const { offsetX, offsetY } = { ...readFigureFrameAttrs(node.attrs), ...attributes };
                    const box = {
                        left: anchor.left + (offsetX ?? 0) * scale,
                        top: anchor.top + (offsetY ?? 0) * scale,
                        width: attributes.width ?? readFrameSide(node.attrs.width) ?? 0,
                    };
                    setFigureAttributes(tr, pos, { ...attributes, ...offsetsOnPaper(view, page(), box, anchor) });
                    return true;
                },
        };
    },

    addKeyboardShortcuts() {
        const editor = this.editor;
        const arrow = () => caretFromFigure(editor);
        return {
            Escape: arrow,
            ArrowUp: arrow,
            ArrowDown: arrow,
            ArrowRight: arrow,
            ArrowLeft: () => {
                const $caret = caretAfterRun(editor.state);
                if (!$caret) return caretFromFigure(editor);
                const before = Selection.findFrom(editor.state.doc.resolve($caret.before()), -1);
                if (before) editor.view.dispatch(editor.state.tr.setSelection(before).scrollIntoView());
                return true;
            },
            // From the visual start, the selection reaches back to the paragraph above, from before the run.
            'Shift-ArrowLeft': () => {
                const { selection, doc } = editor.state;
                const { $head } = selection;
                const run = leadingRun($head.parent);
                if (!(selection instanceof TextSelection) || run.count === 0 || $head.parentOffset !== run.size)
                    return false;
                const before = Selection.findFrom(doc.resolve($head.before()), -1, true);
                const anchor = selection.empty ? $head.start() : selection.anchor;
                if (before)
                    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(doc, anchor, before.head)));
                return true;
            },
            // A selection that ends before a run steps over it to the first character after it.
            'Shift-ArrowRight': () => {
                const { selection, doc } = editor.state;
                const { $head } = selection;
                const run = leadingRun($head.parent);
                if (!(selection instanceof TextSelection) || run.count === 0 || $head.parentOffset !== 0) return false;
                const next = $head.parent.maybeChild(run.count);
                const head = next
                    ? $head.start() + run.size + (next.isText ? 1 : next.nodeSize)
                    : Selection.findFrom(doc.resolve($head.after()), 1, true)?.head;
                if (head !== undefined)
                    editor.view.dispatch(
                        editor.state.tr.setSelection(TextSelection.create(doc, selection.anchor, head)),
                    );
                return true;
            },
            Backspace: () => {
                if (deleteKeepingPlace(editor.view)) return true;
                const $caret = caretAfterRun(editor.state);
                if (!$caret) return false;
                // At an item's first paragraph, a list's own Backspace lifts the item out of the list, the figures with
                // their paragraph. A later paragraph joins the one above.
                if (LIST_ITEMS.includes($caret.node(-1).type.name) && $caret.index(-1) === 0) {
                    rewind(editor.view, $caret);
                    return false;
                }
                const before = Selection.findFrom(editor.state.doc.resolve($caret.before()), -1, true);
                const figures = runPositions($caret.parent, $caret.start());
                const into = before ? before.$from.before() : $caret.before();
                return joinKeepingPlace(
                    editor.view,
                    TextSelection.create(editor.state.doc, $caret.start()),
                    figures,
                    into,
                    (state, dispatch) => joinBackward(state, dispatch) || selectNodeBackward(state, dispatch),
                );
            },
            Delete: () => {
                if (deleteKeepingPlace(editor.view)) return true;
                const { selection } = editor.state;
                const $cursor = selection instanceof TextSelection ? selection.$cursor : null;
                if (!$cursor || $cursor.parentOffset < $cursor.parent.content.size) return false;
                const after = Selection.findFrom(editor.state.doc.resolve($cursor.after()), 1, true);
                const figures = after ? runPositions(after.$from.parent, after.$from.start()) : [];
                if (!after || figures.length === 0) return false;
                return joinKeepingPlace(
                    editor.view,
                    selection,
                    figures,
                    $cursor.before(),
                    (state, dispatch) => joinForward(state, dispatch) || selectNodeForward(state, dispatch),
                );
            },
            // The split goes before the run, as at a plain paragraph's start: the figures go down with their text.
            Enter: () => {
                const $caret = caretAfterRun(editor.state);
                if ($caret) rewind(editor.view, $caret);
                return false;
            },
        };
    },

    addProseMirrorPlugins() {
        const editor = this.editor;
        const { options } = this;
        return [
            new Plugin({
                key: positionedFiguresKey,
                appendTransaction(transactions, _oldState, newState) {
                    const tr = newState.tr;
                    // A peer's change is the peer's to fix, and the server drops a viewer's, so neither tab moves one.
                    const fixes =
                        editor.isEditable &&
                        transactions.some((t) => t.docChanged) &&
                        !transactions.some((t) => t.getMeta(ySyncPluginKey));
                    if (fixes) {
                        for (const pos of changedTextblocks(transactions, newState.doc)) {
                            const $inside = tr.doc.resolve(pos + 1);
                            if (!drawsInLine($inside, options)) leadFigures(tr, pos);
                            else
                                $inside.parent.forEach((child, offset) => {
                                    if (isPositionedFigure(child))
                                        tr.setNodeAttribute(pos + 1 + offset, 'layout', 'block');
                                });
                        }
                    }
                    // A command dispatches even when it changes nothing, so only a moved caret or a change rests it.
                    if (
                        transactions.some((t) => t.selectionSet || t.docChanged) &&
                        !transactions.some((t) => t.getMeta(positionedFiguresKey) === REWIND)
                    ) {
                        const outside = selectionOutsideRuns(tr.selection);
                        if (outside) tr.setSelection(outside);
                    }
                    return tr.docChanged || tr.selectionSet ? tr : null;
                },
                props: {
                    handleDOMEvents: {
                        mousedown(view, event) {
                            if (event.button !== 0) return false;
                            const pos = behindFigureAt(view, event.clientX, event.clientY, event.altKey);
                            if (pos === null) return false;
                            event.preventDefault();
                            view.focus();
                            view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos)));
                            return true;
                        },
                    },
                },
                view(view) {
                    let frame = 0;
                    const grow = () => {
                        frame ||= requestAnimationFrame(() => {
                            frame = 0;
                            growBody(view);
                        });
                    };
                    // An image's height is known once it loads, which changes no doc.
                    view.dom.addEventListener('load', grow, true);
                    return {
                        update(updated, previous) {
                            if (updated.state.doc !== previous.doc) grow();
                        },
                        destroy() {
                            cancelAnimationFrame(frame);
                            view.dom.removeEventListener('load', grow, true);
                        },
                    };
                },
            }),
        ];
    },
});
