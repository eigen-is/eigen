import type { Editor } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import type { EditorState } from '@tiptap/pm/state';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { lightenColor } from '@workspace/lib/constants';
import { CommentMarkSchema, equationText } from '@workspace/lib/docs/eigendoc';
import { MARKLESS_ATOMS } from './atom-marks';

export type CommentMarkOptions = {
    onCommentClick?: (cardId: string) => void;
    onCommentContextMenu?: (cardId: string, event: MouseEvent) => void;
    onSelectionContextMenu?: (event: MouseEvent) => void;
    onAddComment?: () => void;
    onToggleCommentPanel?: () => void;
};

type CommentMeta = {
    resolvedIds: Set<string>;
    colorMap: Map<string, string>;
};

const decorationKey = new PluginKey('commentDecorations');

// An image or an equation holds its card as an attribute: the Yjs binding persists a mark only on text.
const anchorsByAttribute = (node: Node): boolean => MARKLESS_ATOMS.has(node.type.name);

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

// A new card anchors by attribute on an image or an equation selected alone, else as the mark on the range's text.
export function addCommentAnchor(editor: Editor, { from, to }: { from: number; to: number }, cardId: string): void {
    const node = editor.state.doc.nodeAt(from);
    if (node && anchorsByAttribute(node) && to === from + node.nodeSize) {
        editor.view.dispatch(editor.state.tr.setNodeAttribute(from, 'commentCardId', cardId));
        return;
    }
    editor.chain().focus().setTextSelection({ from, to }).setComment(cardId).run();
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

// A comment on an image alone has no text to quote, so the image reads as "Image", and an equation with no text as
// "Equation".
export function commentAnchorText(doc: Node, from: number, to: number): string {
    return doc
        .textBetween(from, to, ' ', (leaf) => {
            if (leaf.type.name === 'figure') return 'Image';
            if (leaf.type.name === 'equation') return equationText(leaf) || 'Equation';
            return '';
        })
        .slice(0, 100);
}

function buildDecorations(state: EditorState, meta: CommentMeta): DecorationSet {
    const decorations: Decoration[] = [];
    state.doc.descendants((node, pos) => {
        const cardId = nodeCommentCardId(node);
        if (cardId) {
            const end = pos + node.nodeSize;

            // An image's node view paints the corner mark from this spec, resolved or not, like a
            // commented canvas element.
            if (node.type.name === 'figure') {
                decorations.push(Decoration.node(pos, end, {}, { commentColor: meta.colorMap.get(cardId) }));
            } else if (meta.resolvedIds.has(cardId)) {
                // Resolved comments: no decoration, keep default highlight appearance.
                // Resolved status is visible in the sidebar (checkmark icon + filter).
            } else {
                const color = meta.colorMap.get(cardId);
                if (color) {
                    decorations.push(
                        Decoration.inline(pos, end, {
                            class: 'comment-colored',
                            style: `background-color:${lightenColor(color, 0.25)}`,
                        }),
                    );
                }
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
                const { empty } = this.editor.state.selection;
                if (!empty && this.options.onAddComment) {
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
                              const el = (event.target as HTMLElement).closest('.comment-highlight');
                              const cardId = el?.getAttribute('data-comment-id');
                              if (cardId) {
                                  onCommentClick(cardId);
                                  return true;
                              }
                              return false;
                          }
                        : undefined,
                    handleDOMEvents: {
                        contextmenu: (view, event) => {
                            // Right-click on a comment highlight → comment context menu
                            const el = (event.target as HTMLElement).closest('.comment-highlight');
                            const cardId = el?.getAttribute('data-comment-id');
                            if (cardId && onCommentContextMenu) {
                                event.preventDefault();
                                onCommentContextMenu(cardId, event);
                                return true;
                            }
                            // Right-click with text selected → selection context menu
                            if (!view.state.selection.empty && onSelectionContextMenu) {
                                event.preventDefault();
                                onSelectionContextMenu(event);
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
