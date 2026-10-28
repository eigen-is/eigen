// The Docs comment anchor: the mark a card holds on a run of text, and the attribute it holds on a node the Yjs binding
// keeps no mark on, such as an image or a text box. It adds, finds, selects and removes a card's anchors, quotes the
// anchored text for the card, and paints each card's color from the comment panel's state as decorations, which the
// editor component updates and a figure's node view draws as its corner mark.

import type { Editor } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { lightenColor } from '@workspace/lib/constants';
import type { FigureFrameNode } from '@workspace/lib/docs/eigendoc';
import {
    CommentMarkSchema,
    isFigureFrameNode,
    isStoryNode,
    PAGE_NUMBER_TEXT,
    readEquation,
} from '@workspace/lib/docs/eigendoc';
import { textOutsideStories } from './story';

export type CommentMarkOptions = {
    onCommentClick?: (cardId: string) => void;
    onCommentContextMenu?: (cardId: string, event: MouseEvent) => void;
    // True when it opened a menu; false leaves the browser's own.
    onSelectionContextMenu?: (event: MouseEvent) => boolean;
    onAddComment?: () => void;
    onToggleCommentPanel?: () => void;
};

type CommentMeta = {
    resolvedIds: Set<string>;
    colorMap: Map<string, string>;
};

const decorationKey = new PluginKey('commentDecorations');

// A node whose schema gives it a commentCardId, such as an image, a text box or an equation, holds its card there: the
// Yjs binding persists a mark only on text.
const anchorsByAttribute = (node: Node): boolean => node.type.spec.attrs?.['commentCardId'] !== undefined;

// The card a node anchors: by attribute, or on text as the comment mark.
export function nodeCommentCardId(node: Node): string | null {
    if (anchorsByAttribute(node)) return node.attrs.commentCardId;
    return node.marks.find((m) => m.type.name === 'comment')?.attrs.cardId ?? null;
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

// A new card anchors by attribute on a node that holds one, selected alone, else as the mark on the range's text.
export function addCommentAnchor(editor: Editor, { from, to }: { from: number; to: number }, cardId: string): void {
    const node = editor.state.doc.nodeAt(from);
    if (node && anchorsByAttribute(node) && to === from + node.nodeSize) {
        editor.view.dispatch(editor.state.tr.setNodeAttribute(from, 'commentCardId', cardId));
        return;
    }
    editor.chain().focus().setTextSelection({ from, to }).setComment(cardId).run();
}

// Whether addCommentAnchor would anchor a card on the selection: a node holding a card attribute selected alone, or
// text. AtomMarks strips the mark from any other atom, so a page number alone takes no comment. A story keeps the
// body's marks off its text, so a note's reference alone takes none either. A text box takes its card as a figure does.
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

// A deleted card leaves no anchor behind.
export function removeCommentAnchors(editor: Editor, cardId: string): void {
    const { tr } = editor.state;
    const commentType = editor.state.schema.marks.comment;
    for (const { node, pos, end } of findCommentAnchors(editor.state.doc, cardId)) {
        if (anchorsByAttribute(node)) tr.setNodeAttribute(pos, 'commentCardId', null);
        else tr.removeMark(pos, end, commentType);
    }
    editor.view.dispatch(tr);
}

// Scrolls to a card's first anchor and selects it: a node whole, text at its start.
export function selectCommentAnchor(editor: Editor, cardId: string): void {
    const anchors = findCommentAnchors(editor.state.doc, cardId);
    if (anchors.length === 0) return;
    const { node, pos } = anchors[0];
    const chain = editor.chain().focus();
    const selected = anchorsByAttribute(node) ? chain.setNodeSelection(pos) : chain.setTextSelection(pos);
    selected.scrollIntoView().run();
}

const QUOTE_WORDS: Record<FigureFrameNode, string> = { figure: 'Image', chart: 'Chart', textBox: 'Text box' };

// A comment on an image or a chart alone has no text to quote, so it reads as "Image" or "Chart", and an equation with
// no text as "Equation", and a page number as its #. A story's text is no part of the quote, as its node takes no
// comment.
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

function buildDecorations(state: EditorState, meta: CommentMeta): DecorationSet {
    const decorations: Decoration[] = [];
    state.doc.descendants((node, pos) => {
        const cardId = nodeCommentCardId(node);
        if (cardId) {
            const end = pos + node.nodeSize;
            const color = meta.colorMap.get(cardId);
            // The node view of a node that holds its card, such as an image's or a text box's, paints the corner mark
            // from this spec, resolved or not, like a commented canvas element.
            if (anchorsByAttribute(node)) decorations.push(Decoration.node(pos, end, {}, { commentColor: color }));
            // Text, and an equation among it, is highlighted until resolved; the sidebar shows a resolved one.
            if (!isFigureFrameNode(node.type.name) && !meta.resolvedIds.has(cardId) && color) {
                decorations.push(
                    Decoration.inline(pos, end, {
                        class: 'comment-colored',
                        style: `background-color:${lightenColor(color, 0.25)}`,
                    }),
                );
            }
        }
    });
    return decorations.length > 0 ? DecorationSet.create(state.doc, decorations) : DecorationSet.empty;
}

export const CommentMark = CommentMarkSchema.extend<CommentMarkOptions>({
    addOptions() {
        return {
            onCommentClick: undefined,
            onCommentContextMenu: undefined,
            onSelectionContextMenu: undefined,
            onAddComment: undefined,
            onToggleCommentPanel: undefined,
        };
    },

    addStorage() {
        return { resolvedIds: new Set<string>(), colorMap: new Map<string, string>() } satisfies CommentMeta;
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
        const storage = this.storage as CommentMeta;

        const plugins: Plugin[] = [];

        plugins.push(
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
        );

        plugins.push(
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
        );

        return plugins;
    },
});

export function updateCommentDecorations(editor: Editor, resolvedIds: Set<string>, colorMap: Map<string, string>) {
    const storage = (editor.extensionStorage as unknown as Record<string, CommentMeta>)?.comment;
    if (storage) {
        storage.resolvedIds = resolvedIds;
        storage.colorMap = colorMap;
    }
    const tr = editor.view.state.tr.setMeta(decorationKey, true);
    editor.view.dispatch(tr);
}
