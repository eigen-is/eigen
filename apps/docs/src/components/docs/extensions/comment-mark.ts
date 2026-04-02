import type { EditorState } from '@tiptap/pm/state';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { lightenColor } from '@workspace/lib/constants';
import { CommentMarkSchema } from '@workspace/lib/docs/eigendoc';

export type CommentMarkOptions = {
    onCommentClick?: (chatName: string) => void;
    onCommentContextMenu?: (chatName: string, event: MouseEvent) => void;
    onSelectionContextMenu?: (event: MouseEvent) => void;
    onAddComment?: () => void;
    onToggleCommentPanel?: () => void;
};

type CommentMeta = {
    resolvedIds: Set<string>;
    colorMap: Map<string, string>;
};

const decorationKey = new PluginKey('commentDecorations');

function buildDecorations(state: EditorState, meta: CommentMeta): DecorationSet {
    const decorations: Decoration[] = [];
    state.doc.descendants((node, pos) => {
        for (const mark of node.marks) {
            if (mark.type.name !== 'comment' || !mark.attrs.chatName) continue;
            const chatName = mark.attrs.chatName as string;
            const end = pos + node.nodeSize;

            if (meta.resolvedIds.has(chatName)) {
                // Resolved comments: no decoration, keep default highlight appearance.
                // Resolved status is visible in the sidebar (checkmark icon + filter).
            } else {
                const color = meta.colorMap.get(chatName);
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
                              const chatName = el?.getAttribute('data-chat-name');
                              if (chatName) {
                                  onCommentClick(chatName);
                                  return true;
                              }
                              return false;
                          }
                        : undefined,
                    handleDOMEvents: {
                        contextmenu: (view, event) => {
                            // Right-click on a comment highlight → comment context menu
                            const el = (event.target as HTMLElement).closest('.comment-highlight');
                            const chatName = el?.getAttribute('data-chat-name');
                            if (chatName && onCommentContextMenu) {
                                event.preventDefault();
                                onCommentContextMenu(chatName, event);
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

export function updateCommentDecorations(
    // biome-ignore lint/suspicious/noExplicitAny: tiptap Editor type is complex
    editor: any,
    resolvedIds: Set<string>,
    colorMap: Map<string, string>,
) {
    const storage = editor.extensionStorage?.comment as CommentMeta | undefined;
    if (storage) {
        storage.resolvedIds = resolvedIds;
        storage.colorMap = colorMap;
    }
    const tr = editor.view.state.tr.setMeta(decorationKey, true);
    editor.view.dispatch(tr);
}
