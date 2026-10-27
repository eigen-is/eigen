// A figure in front of or behind the text draws at an offset from its paragraph and takes no room on its line, so this
// extension keeps the keyboard off it. Such figures always lead their paragraph and the caret rests after them, while
// ArrowLeft, Backspace, Delete and Enter there act as at a plain paragraph's start. It also places them: a drop
// re-anchors one on the paragraph under it, a switch to front or behind keeps it where it is drawn, a press where text
// doesn't cover a behind one selects it, and the body grows under the lowest. A band's and a note's editor draw every
// figure in line, as a table cell and a note in the body do. Every docs editor registers it.

import type { Editor } from '@tiptap/core';
import { Extension } from '@tiptap/core';
import { joinBackward, joinForward, selectNodeBackward, selectNodeForward } from '@tiptap/pm/commands';
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
    isFigureFrameNode,
    isPositioned,
    pagePx,
    setFigureAttributes,
} from '@workspace/lib/docs/eigendoc';

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        positionedFigures: {
            // The selected figure or chart in front of or behind the text, where it is drawn now.
            positionFigure: (layout: PositionedLayout) => ReturnType;
            // The positioned figure at `pos` with its box's top left at `at`, in screen px: on the paragraph under it.
            moveFigure: (pos: number, at: { left: number; top: number }) => ReturnType;
        };
    }

    interface Storage {
        positionedFigures: PositionedFiguresOptions;
    }
}

type PositionedFiguresOptions = {
    // The page map in px: the paper a positioned figure stays on, never the column a screen lays out.
    page: () => PageSetup;
    // A band's or a note's editor, where every figure draws in line.
    blockOnly: boolean;
};

const positionedFiguresKey = new PluginKey<number>('positionedFigures');

// A selection the keymap moves to a paragraph's start on purpose, which the caret rest leaves there.
const REWIND = 'rewind';

const POSITIONED_BOXES = '.figure[data-layout="front"], .figure[data-layout="behind"]';

const isPositionedFigure = (node: PMNode | null | undefined): boolean =>
    !!node && isFigureFrameNode(node.type.name) && isPositioned(node.attrs.layout);

// How many positioned figures a textblock starts with. Each is one position long.
function leadingRun(textblock: PMNode): number {
    let run = 0;
    while (run < textblock.childCount && isPositionedFigure(textblock.child(run))) run++;
    return run;
}

// The empty caret at the visual start of a textblock that leads with positioned figures: right after them.
function caretAfterRun(state: EditorState): ResolvedPos | null {
    const { selection } = state;
    if (!(selection instanceof TextSelection) || !selection.$cursor) return null;
    const run = leadingRun(selection.$cursor.parent);
    return run > 0 && selection.$cursor.parentOffset === run ? selection.$cursor : null;
}

// The page draws scaled below its width, and a page px is a screen px divided by that scale.
function pageScale(view: EditorView): number {
    const { offsetWidth } = view.dom;
    return offsetWidth > 0 ? view.dom.getBoundingClientRect().width / offsetWidth : 1;
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

// A box's offsets from its anchor paragraph's drawn rect, kept on the paper of the page map: between its edges, and
// below the page's top. The paragraph's place on the paper is the page map's margin plus its distance from the text
// column, so a narrow screen's column clamps nothing it wouldn't on a desktop.
function offsetsOnPaper(
    view: EditorView,
    page: PageSetup,
    box: { left: number; top: number; width: number },
    anchor: DOMRect,
): { offsetX: number; offsetY: number } {
    const scale = pageScale(view);
    const column = view.dom.getBoundingClientRect();
    const left = page.margin.left + (anchor.left - column.left) / scale;
    const top = page.margin.top + (anchor.top - column.top) / scale;
    const x = (box.left - anchor.left) / scale;
    const y = (box.top - anchor.top) / scale;
    return {
        offsetX: Math.round(Math.max(-left, Math.min(page.width - box.width - left, x))),
        offsetY: Math.round(Math.max(-top, y)),
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
    const textblock = tr.doc.nodeAt(pos);
    if (!textblock) return;
    const run = leadingRun(textblock);
    const strays: { node: PMNode; at: number }[] = [];
    textblock.forEach((child, offset, index) => {
        if (index > run && isPositionedFigure(child)) strays.push({ node: child, at: pos + 1 + offset });
    });
    if (strays.length === 0) return;
    for (const { at } of strays.toReversed()) tr.delete(at, at + 1);
    tr.insert(
        pos + 1 + run,
        strays.map(({ node }) => node),
    );
}

// The textblocks the transactions changed, as positions in the last one's doc. An attribute step counts its node.
function changedTextblocks(transactions: readonly Transaction[], doc: PMNode): Set<number> {
    let ranges: [number, number][] = [];
    for (const tr of transactions) {
        tr.steps.forEach((step, index) => {
            const map = tr.mapping.maps[index];
            ranges = ranges.map(([from, to]) => [map.map(from, -1), map.map(to, 1)]);
            if (step instanceof AttrStep) ranges.push([step.pos, step.pos + 1]);
            else
                map.forEach((_oldFrom, _oldTo, from, to) => {
                    ranges.push([from, to]);
                });
        });
    }
    const textblocks = new Set<number>();
    for (const [from, to] of ranges) {
        // A note's paragraphs are inside its reference, an inline node of a textblock.
        doc.nodesBetween(Math.max(0, from - 1), Math.min(doc.content.size, to + 1), (node, pos) => {
            if (node.isTextblock) textblocks.add(pos);
        });
    }
    return textblocks;
}

const positionedIn = (doc: PMNode, from: number, to: number) => {
    let count = 0;
    doc.nodesBetween(from, to, (node) => {
        if (isPositionedFigure(node)) count++;
    });
    return count;
};

// Joins the way `join` does at a plain textblock's edge, with the caret at `caret`, and keeps each figure of `figures`
// that the join carries into the textblock at `into` where it is drawn: its offsets are measured against that
// textblock before the dispatch, and it leads it. With nothing to join, at the doc's start, the figures stay too.
function joinKeepingPlace(view: EditorView, caret: number, figures: number[], into: number, join: Command): boolean {
    const scale = pageScale(view);
    const target = rectAt(view, into);
    const boxes = figures.map((pos) => figureBoxAt(view, pos));
    const state = view.state.apply(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, caret)).setMeta(positionedFiguresKey, REWIND),
    );
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

// Escape or a plain arrow on a selected positioned figure: the caret at the visual start of its paragraph.
function caretFromFigure(editor: Editor): boolean {
    const { selection } = editor.state;
    if (!(selection instanceof NodeSelection) || !isPositionedFigure(selection.node)) return false;
    const { $from } = selection;
    return editor.commands.setTextSelection($from.start() + leadingRun($from.parent));
}

// The behind figure a press at (x, y) selects: the topmost under the pointer, when no line of text is there or Alt is
// held. The paragraph's box lies over the figure, so the hit test is geometry: every element under the point, and the
// rects of the text lines of the textblock on top.
function behindFigureAt(view: EditorView, x: number, y: number, alt: boolean): number | null {
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
    const pos = view.posAtDOM(box, 0);
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

// The body's min-height reaches the lowest positioned box, so the notes and the footer band draw below it.
function growBody(view: EditorView) {
    const boxes = view.dom.querySelectorAll(POSITIONED_BOXES);
    if (boxes.length === 0) {
        view.dom.style.minHeight = '';
        return;
    }
    const top = view.dom.getBoundingClientRect().top;
    let bottom = top;
    for (const box of boxes) bottom = Math.max(bottom, box.getBoundingClientRect().bottom);
    view.dom.style.minHeight = `${Math.ceil((bottom - top) / pageScale(view))}px`;
}

export const PositionedFigures = Extension.create<PositionedFiguresOptions, PositionedFiguresOptions>({
    name: 'positionedFigures',

    // Ahead of the core keymap and the lists', whose Backspace and Enter would act at the caret after the run.
    priority: 1000,

    addOptions() {
        return { page: () => pagePx(DEFAULT_PAGE_SETUP), blockOnly: false };
    },

    addStorage() {
        return { page: this.options.page, blockOnly: this.options.blockOnly };
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
                    const width = Math.min(paper.width, node.attrs.width ?? (box?.width ?? 0) / pageScale(view));
                    setFigureAttributes(tr, pos, {
                        layout,
                        ...(box && anchor
                            ? offsetsOnPaper(view, paper, { left: box.left, top: box.top, width }, anchor)
                            : { offsetX: 0, offsetY: 0 }),
                        ...(node.attrs.width > paper.width && { width: paper.width }),
                    });
                    const run = leadingRun($from.parent);
                    if ($from.index() > run) {
                        leadFigures(tr, $from.before());
                        tr.setSelection(NodeSelection.create(tr.doc, $from.start() + run));
                    }
                    return true;
                },
            moveFigure:
                (pos, at) =>
                ({ tr, view, dispatch }) => {
                    const node = tr.doc.nodeAt(pos);
                    if (!node || !isPositionedFigure(node)) return false;
                    const $pos = tr.doc.resolve(pos);
                    const anchor = anchorUnder(view, at.top, node.type) ?? $pos.before();
                    const rect = rectAt(view, anchor);
                    const box = figureBoxAt(view, pos);
                    if (!rect || !box) return false;
                    if (!dispatch) return true;
                    const width = node.attrs.width ?? box.width / pageScale(view);
                    const offsets = offsetsOnPaper(view, page(), { ...at, width }, rect);
                    if (anchor === $pos.before()) {
                        setFigureAttributes(tr, pos, offsets);
                        return true;
                    }
                    // A delete and an insert, so the figure is in one place; the selection follows it, or the panel closes.
                    tr.delete(pos, pos + 1);
                    const $anchor = tr.doc.resolve(tr.mapping.map(anchor) + 1);
                    const to = $anchor.start() + leadingRun($anchor.parent);
                    tr.insert(to, node.type.create({ ...node.attrs, ...offsets }, null, node.marks));
                    tr.setSelection(NodeSelection.create(tr.doc, to));
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
            Backspace: () => {
                const $caret = caretAfterRun(editor.state);
                const before = $caret && Selection.findFrom(editor.state.doc.resolve($caret.before()), -1, true);
                if (!$caret) return false;
                const figures = Array.from({ length: $caret.parentOffset }, (_, i) => $caret.start() + i);
                const into = before ? before.$from.before() : $caret.before();
                return joinKeepingPlace(
                    editor.view,
                    $caret.start(),
                    figures,
                    into,
                    (state, dispatch) => joinBackward(state, dispatch) || selectNodeBackward(state, dispatch),
                );
            },
            Delete: () => {
                const { selection } = editor.state;
                const $cursor = selection instanceof TextSelection ? selection.$cursor : null;
                if (!$cursor || $cursor.parentOffset < $cursor.parent.content.size) return false;
                const after = Selection.findFrom(editor.state.doc.resolve($cursor.after()), 1, true);
                const run = after ? leadingRun(after.$from.parent) : 0;
                if (!after || run === 0) return false;
                const figures = Array.from({ length: run }, (_, i) => after.$from.start() + i);
                return joinKeepingPlace(
                    editor.view,
                    $cursor.pos,
                    figures,
                    $cursor.before(),
                    (state, dispatch) => joinForward(state, dispatch) || selectNodeForward(state, dispatch),
                );
            },
            // The split goes before the run, as at a plain paragraph's start: the figures go down with their text.
            Enter: () => {
                const $caret = caretAfterRun(editor.state);
                if ($caret) {
                    const rewound = editor.state.tr.setSelection(
                        TextSelection.create(editor.state.doc, $caret.start()),
                    );
                    editor.view.dispatch(rewound.setMeta(positionedFiguresKey, REWIND));
                }
                return false;
            },
        };
    },

    addProseMirrorPlugins() {
        const editor = this.editor;
        const { blockOnly } = this.options;
        return [
            new Plugin<number>({
                key: positionedFiguresKey,
                // How many positioned figures the doc holds: page growth measures only while there is one.
                state: {
                    init: (_config, state) => positionedIn(state.doc, 0, state.doc.content.size),
                    apply(tr, count) {
                        if (!tr.docChanged) return count;
                        tr.steps.forEach((step, index) => {
                            const before = tr.docs[index];
                            const after = tr.docs[index + 1] ?? tr.doc;
                            if (step instanceof AttrStep) {
                                count +=
                                    Number(isPositionedFigure(after.nodeAt(step.pos))) -
                                    Number(isPositionedFigure(before.nodeAt(step.pos)));
                            } else {
                                step.getMap().forEach((oldFrom, oldTo, from, to) => {
                                    count += positionedIn(after, from, to) - positionedIn(before, oldFrom, oldTo);
                                });
                            }
                        });
                        return count;
                    },
                },
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
                            const inLine =
                                blockOnly ||
                                Array.from({ length: $inside.depth }, (_, d) => $inside.node(d).type.name).some(
                                    (name) => BLOCK_ONLY_FIGURE_PARENTS.includes(name),
                                );
                            if (!inLine) leadFigures(tr, pos);
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
                        const { selection } = tr;
                        const run =
                            selection instanceof TextSelection && selection.$cursor
                                ? leadingRun(selection.$cursor.parent)
                                : 0;
                        if (selection.$from.parentOffset < run)
                            tr.setSelection(TextSelection.create(tr.doc, selection.$from.start() + run));
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
                    // An image's height is known once it loads, which changes no doc.
                    const onLoad = () => {
                        if (positionedFiguresKey.getState(view.state)) growBody(view);
                    };
                    view.dom.addEventListener('load', onLoad, true);
                    return {
                        update(updated, previous) {
                            if (updated.state.doc === previous.doc) return;
                            if (positionedFiguresKey.getState(updated.state) || updated.dom.style.minHeight)
                                growBody(updated);
                        },
                        destroy: () => view.dom.removeEventListener('load', onLoad, true),
                    };
                },
            }),
        ];
    },
});
