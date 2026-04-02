import { type EditorState, Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { lightenColor } from '@workspace/lib/constants';
import { CommentMarkSchema } from '@workspace/lib/docs/eigendoc';

export type CommentMarkOptions = {
    onCommentClick?: (chatName: string) => void;
    onCommentContextMenu?: (chatName: string, event: MouseEvent) => void;
    onAddComment?: () => void;
    onToggleCommentPanel?: () => void;
};

type CommentMeta = { resolvedIds: Set<string>; colorMap: Map<string, string> };

const decorationPluginKey = new PluginKey('commentDecorations');

function buildDecorations(state: EditorState, meta: CommentMeta): DecorationSet {
    const decorations: Decoration[] = [];
    state.doc.descendants((node, pos) => {
        for (const mark of node.marks) {
            if (mark.type.name !== 'comment' || !mark.attrs.chatName) continue;
            const chatName = mark.attrs.chatName as string;
            const attrs: Record<string, string> = {};
            if (meta.resolvedIds.has(chatName)) attrs['data-resolved'] = 'true';
            const color = meta.colorMap.get(chatName);
            if (color) attrs.style = `--comment-color: ${lightenColor(color, 0.5)}`;
            if (Object.keys(attrs).length > 0) {
                decorations.push(Decoration.inline(pos, pos + node.nodeSize, attrs));
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
        const { onCommentClick, onCommentContextMenu } = this.options;
        const storage = this.storage as CommentMeta;

        const plugins: Plugin[] = [];

        if (onCommentClick || onCommentContextMenu) {
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
                        handleDOMEvents: onCommentContextMenu
                            ? {
                                  contextmenu: (_view, event) => {
                                      const el = (event.target as HTMLElement).closest('.comment-highlight');
                                      const chatName = el?.getAttribute('data-chat-name');
                                      if (chatName) {
                                          event.preventDefault();
                                          onCommentContextMenu(chatName, event);
                                          return true;
                                      }
                                      return false;
                                  },
                              }
                            : undefined,
                    },
                }),
            );
        }

        plugins.push(
            new Plugin({
                key: decorationPluginKey,
                state: {
                    init: (_, state) => buildDecorations(state, storage),
                    apply: (tr, old, _oldState, newState) => {
                        if (tr.docChanged || tr.getMeta(decorationPluginKey)) {
                            return buildDecorations(newState, storage);
                        }
                        return old.map(tr.mapping, tr.doc);
                    },
                },
                props: {
                    decorations: (state) => decorationPluginKey.getState(state),
                },
            }),
        );

        return plugins;
    },
});

export function updateCommentDecorations(
    // biome-ignore lint/suspicious/noExplicitAny: tiptap Editor type is complex, structural typing doesn't match
    editor: any,
    resolvedIds: Set<string>,
    colorMap: Map<string, string>,
) {
    const storage = editor.extensionStorage?.comment as CommentMeta | undefined;
    if (storage) {
        storage.resolvedIds = resolvedIds;
        storage.colorMap = colorMap;
    }
    const tr = editor.view.state.tr.setMeta(decorationPluginKey, true);
    editor.view.dispatch(tr);
}
