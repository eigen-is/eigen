// The Docs comment anchor: the mark a card holds on a run of text, and the attribute it holds on a node the Yjs binding
// keeps no mark on, such as an image or a text box. It adds, finds, selects and removes a card's anchors, quotes the
// anchored text for the card, tells the hover card which anchor the pointer is on, and paints each card's color from
// the comment panel's state as decorations, which the editor component updates and a figure's node view draws as its
// corner mark.

import type { Editor } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { lightenColor } from '@workspace/lib/constants';
import type { FigureFrameNode } from '@workspace/lib/docs/eigendoc';
import {
    COMMENT_CARD_ATTRIBUTE,
    COMMENT_MARK_CARD_ATTRIBUTE,
    CommentMarkSchema,
    isFigureFrameNode,
    isStoryNode,
    PAGE_NUMBER_TEXT,
    readEquation,
} from '@workspace/lib/docs/eigendoc';
import type { CommentHover } from '@workspace/lib/types/comments';
import type React from 'react';
import { textOutsideStories } from './story';

type CommentMarkOptions = {
    onCommentClick?: (cardId: string) => void;
    onCommentContextMenu?: (cardId: string, event: MouseEvent) => void;
    // True when it opened a menu; false leaves the browser's own.
    onSelectionContextMenu?: (event: MouseEvent) => boolean;
    onAddComment?: () => void;
    onToggleCommentPanel?: () => void;
};

type CommentPanelState = {
    resolvedIds: ReadonlySet<string>;
    colorMap: ReadonlyMap<string, string>;
};

declare module '@tiptap/core' {
    interface Storage {
        comment: CommentPanelState;
    }
}

const decorationKey = new PluginKey('commentDecorations');

// A node whose schema gives it the card attribute, such as an image, a text box or an equation, holds its card there:
// the Yjs binding persists a mark only on text.
const anchorsByAttribute = (node: Node): boolean => node.type.spec.attrs?.[COMMENT_CARD_ATTRIBUTE] !== undefined;

export function nodeCommentCardId(node: Node): string | null {
    if (anchorsByAttribute(node)) return node.attrs[COMMENT_CARD_ATTRIBUTE];
    return node.marks.find((m) => m.type.name === CommentMarkSchema.name)?.attrs[COMMENT_MARK_CARD_ATTRIBUTE] ?? null;
}

function findCommentAnchors(doc: Node, cardId: string): { node: Node; pos: number; end: number }[] {
    const anchors: { node: Node; pos: number; end: number }[] = [];
    doc.descendants((node, pos) => {
        if (nodeCommentCardId(node) === cardId) anchors.push({ node, pos, end: pos + node.nodeSize });
    });
    return anchors;
}

// The card of the comment highlight an event lands on, as text draws it.
export function commentCardIdAt(target: EventTarget | null): string | null {
    if (!(target instanceof Element)) return null;
    return target.closest('.comment-highlight')?.getAttribute('data-comment-id') || null;
}

// From a React handler, as node views stop ProseMirror's events: unlike commentCardIdAt it also finds a corner mark.
export function reportCommentHover(editor: Editor, { show, hide }: CommentHover, event: React.MouseEvent): void {
    const anchor = event.target instanceof Element ? event.target.closest('[data-comment-id]') : null;
    const cardId = anchor?.getAttribute('data-comment-id');
    if (!anchor || !cardId || event.buttons !== 0) {
        hide();
        return;
    }
    const highlightGone =
        anchor.classList.contains('comment-highlight') && editor.storage.comment.resolvedIds.has(cardId);
    if (highlightGone) hide();
    else show(cardId, lineUnderPointer(anchor, event));
}

// One rect per line of a wrapped span, so the card opens by the line the pointer is on.
function lineUnderPointer(anchor: Element, { clientX, clientY }: React.MouseEvent): DOMRect {
    const line = [...anchor.getClientRects()].find(
        ({ left, right, top, bottom }) => left <= clientX && clientX <= right && top <= clientY && clientY <= bottom,
    );
    return line ?? anchor.getBoundingClientRect();
}

// A node that holds a card attribute and is selected alone takes the new card there. Any other range takes it as the
// comment mark on its text.
export function addCommentAnchor(editor: Editor, { from, to }: { from: number; to: number }, cardId: string): void {
    const node = editor.state.doc.nodeAt(from);
    if (node && anchorsByAttribute(node) && to === from + node.nodeSize) {
        editor.view.dispatch(editor.state.tr.setNodeAttribute(from, COMMENT_CARD_ATTRIBUTE, cardId));
        return;
    }
    editor.chain().focus().setTextSelection({ from, to }).setComment(cardId).run();
}

// Whether addCommentAnchor would anchor a card on the selection. AtomMarks strips the mark from any other atom, and a
// story keeps the body's marks off its text, so a page number or a note's reference alone takes no comment.
export function canAnchorComment({ doc, selection: { from, to, empty } }: EditorState): boolean {
    if (empty) return false;
    const node = doc.nodeAt(from);
    if (node && anchorsByAttribute(node) && to === from + node.nodeSize) return true;
    let text = false;
    doc.nodesBetween(from, to, (child) => {
        text ||= child.isText;
        return !text && !isStoryNode(child.type.name);
    });
    return text;
}

export function removeCommentAnchors(editor: Editor, cardId: string): void {
    const { tr } = editor.state;
    const commentType = editor.state.schema.marks[CommentMarkSchema.name];
    for (const { node, pos, end } of findCommentAnchors(editor.state.doc, cardId)) {
        if (anchorsByAttribute(node)) tr.setNodeAttribute(pos, COMMENT_CARD_ATTRIBUTE, null);
        else tr.removeMark(pos, end, commentType);
    }
    editor.view.dispatch(tr);
}

export function selectCommentAnchor(editor: Editor, cardId: string): void {
    const anchors = findCommentAnchors(editor.state.doc, cardId);
    if (anchors.length === 0) return;
    const { node, pos } = anchors[0];
    const chain = editor.chain().focus();
    const selected = anchorsByAttribute(node) ? chain.setNodeSelection(pos) : chain.setTextSelection(pos);
    selected.scrollIntoView().run();
}

const QUOTE_WORDS: Record<FigureFrameNode, string> = { figure: 'Image', chart: 'Chart', textBox: 'Text box' };

// A comment on an image, a chart or a text box alone has no text to quote, so it reads as the word for that node, such
// as "Image". A story's text stays out of the quote, because a story takes no comment.
export function commentAnchorText(doc: Node, from: number, to: number): string {
    return textOutsideStories(
        doc,
        from,
        to,
        ' ',
        () => '',
        (leaf) => {
            if (isFigureFrameNode(leaf.type.name)) return QUOTE_WORDS[leaf.type.name];
            if (leaf.type.name === 'equation') return readEquation(leaf.attrs).text || 'Equation';
            return leaf.type.name === 'pageNumber' ? PAGE_NUMBER_TEXT : '';
        },
    ).slice(0, 100);
}

function buildDecorations(state: EditorState, panel: CommentPanelState): DecorationSet {
    const decorations: Decoration[] = [];
    state.doc.descendants((node, pos) => {
        const cardId = nodeCommentCardId(node);
        if (cardId) {
            const end = pos + node.nodeSize;
            const color = panel.colorMap.get(cardId);
            // The node view of a node that holds its card, such as an image's or a text box's, paints the corner mark
            // from this spec, resolved or not, like a commented canvas element.
            if (anchorsByAttribute(node)) decorations.push(Decoration.node(pos, end, {}, { commentColor: color }));
            // Text, and an equation among it, is highlighted until resolved; the sidebar shows a resolved one.
            if (!isFigureFrameNode(node.type.name) && !panel.resolvedIds.has(cardId) && color) {
                decorations.push(
                    Decoration.inline(pos, end, {
                        class: 'comment-colored',
                        style: `background-color:${lightenColor(color, 0.25)}`,
                    }),
                );
            }
        }
    });
    return DecorationSet.create(state.doc, decorations);
}

export const CommentMark = CommentMarkSchema.extend<CommentMarkOptions, CommentPanelState>({
    addOptions() {
        return {};
    },

    addStorage() {
        return { resolvedIds: new Set<string>(), colorMap: new Map<string, string>() };
    },

    addKeyboardShortcuts() {
        return {
            'Mod-Alt-m': () => {
                if (canAnchorComment(this.editor.state) && this.options.onAddComment) {
                    this.options.onAddComment();
                    return true;
                }
                if (this.options.onToggleCommentPanel) {
                    this.options.onToggleCommentPanel();
                    return true;
                }
                return false;
            },
        };
    },

    addProseMirrorPlugins() {
        const { onCommentClick, onCommentContextMenu, onSelectionContextMenu } = this.options;
        const { storage } = this;

        return [
            new Plugin({
                key: new PluginKey('commentInteraction'),
                props: {
                    handleClick: onCommentClick
                        ? (_view, _pos, event) => {
                              const cardId = commentCardIdAt(event.target);
                              if (cardId) {
                                  onCommentClick(cardId);
                                  return true;
                              }
                              return false;
                          }
                        : undefined,
                    handleDOMEvents: {
                        contextmenu: (view, event) => {
                            const cardId = commentCardIdAt(event.target);
                            if (cardId && onCommentContextMenu) {
                                event.preventDefault();
                                onCommentContextMenu(cardId, event);
                                return true;
                            }
                            if (canAnchorComment(view.state) && onSelectionContextMenu?.(event)) {
                                event.preventDefault();
                                return true;
                            }
                            return false;
                        },
                    },
                },
            }),
            new Plugin({
                key: decorationKey,
                state: {
                    init: (_, state) => buildDecorations(state, storage),
                    apply: (tr, old, _oldState, newState) => {
                        if (tr.docChanged || tr.getMeta(decorationKey)) {
                            return buildDecorations(newState, storage);
                        }
                        return old.map(tr.mapping, tr.doc);
                    },
                },
                props: {
                    decorations: (state) => decorationKey.getState(state),
                },
            }),
        ];
    },
});

export function updateCommentDecorations(
    editor: Editor,
    resolvedIds: ReadonlySet<string>,
    colorMap: ReadonlyMap<string, string>,
): void {
    // A destroyed editor has empty storage, and the cards may still change as the page unmounts.
    if (editor.isDestroyed) return;
    // The decoration plugin holds this storage object, so the fields change in place.
    const storage = editor.storage.comment;
    storage.resolvedIds = resolvedIds;
    storage.colorMap = colorMap;
    editor.view.dispatch(editor.view.state.tr.setMeta(decorationKey, true));
}
