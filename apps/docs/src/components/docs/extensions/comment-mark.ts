import { type EditorState, Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { CommentMarkSchema } from '@workspace/lib/docs/eigendoc';

export type CommentMarkOptions = {
    onCommentClick?: (chatName: string) => void;
    onAddComment?: () => void;
    onToggleCommentPanel?: () => void;
};

const resolvedPluginKey = new PluginKey('commentResolved');

function buildResolvedDecorations(state: EditorState, resolvedIds: Set<string>): DecorationSet {
    if (resolvedIds.size === 0) return DecorationSet.empty;

    const decorations: Decoration[] = [];
    state.doc.descendants((node, pos) => {
        for (const mark of node.marks) {
            if (mark.type.name === 'comment' && mark.attrs.chatName && resolvedIds.has(mark.attrs.chatName as string)) {
                decorations.push(Decoration.inline(pos, pos + node.nodeSize, { 'data-resolved': 'true' }));
            }
        }
    });
    return DecorationSet.create(state.doc, decorations);
}

export const CommentMark = CommentMarkSchema.extend<CommentMarkOptions>({
    addOptions() {
        return { onCommentClick: undefined, onAddComment: undefined, onToggleCommentPanel: undefined };
    },

    addStorage() {
        return { resolvedIds: new Set<string>() };
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
        const onCommentClick = this.options.onCommentClick;
        const storage = this.storage as { resolvedIds: Set<string> };

        const plugins: Plugin[] = [];

        if (onCommentClick) {
            plugins.push(
                new Plugin({
                    key: new PluginKey('commentClick'),
                    props: {
                        handleClick: (_view, _pos, event) => {
                            const target = event.target as HTMLElement;
                            const commentEl = target.closest('.comment-highlight');
                            if (commentEl) {
                                const chatName = commentEl.getAttribute('data-chat-name');
                                if (chatName) {
                                    onCommentClick(chatName);
                                    return true;
                                }
                            }
                            return false;
                        },
                    },
                }),
            );
        }

        plugins.push(
            new Plugin({
                key: resolvedPluginKey,
                state: {
                    init: (_, state) => buildResolvedDecorations(state, storage.resolvedIds),
                    apply: (tr, old, _oldState, newState) => {
                        if (tr.docChanged || tr.getMeta(resolvedPluginKey)) {
                            return buildResolvedDecorations(newState, storage.resolvedIds);
                        }
                        return old.map(tr.mapping, tr.doc);
                    },
                },
                props: {
                    decorations: (state) => resolvedPluginKey.getState(state),
                },
            }),
        );

        return plugins;
    },
});

export function updateResolvedComments(
    // biome-ignore lint/suspicious/noExplicitAny: tiptap Editor type is complex, structural typing doesn't match
    editor: any,
    resolvedIds: Set<string>,
) {
    const storage = editor.extensionStorage?.comment as { resolvedIds: Set<string> } | undefined;
    if (storage) {
        storage.resolvedIds = resolvedIds;
    }
    const tr = editor.view.state.tr.setMeta(resolvedPluginKey, true);
    editor.view.dispatch(tr);
}
