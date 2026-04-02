import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { lightenColor } from '@workspace/lib/constants';
import { CommentMarkSchema } from '@workspace/lib/docs/eigendoc';

export type CommentMarkOptions = {
    onCommentClick?: (chatName: string) => void;
    onCommentContextMenu?: (chatName: string, event: MouseEvent) => void;
    onAddComment?: () => void;
    onToggleCommentPanel?: () => void;
    onDeleteComment?: (chatName: string) => void;
};

type CommentMeta = {
    resolvedIds: Set<string>;
    colorMap: Map<string, string>;
};

const metaKey = new PluginKey('commentMeta');

function applyCommentStyles(view: EditorView, meta: CommentMeta) {
    const root = view.dom;
    for (const el of root.querySelectorAll('.comment-highlight')) {
        const chatName = el.getAttribute('data-chat-name');
        if (!chatName) continue;

        const htmlEl = el as HTMLElement;

        if (meta.resolvedIds.has(chatName)) {
            htmlEl.style.backgroundColor = 'transparent';
            htmlEl.style.borderBottom = 'none';
            htmlEl.style.cursor = 'default';
        } else {
            const color = meta.colorMap.get(chatName);
            if (color) {
                const light = lightenColor(color, 0.5);
                htmlEl.style.backgroundColor = light;
                htmlEl.style.borderBottom = `2px solid ${lightenColor(color, 0.2)}`;
            } else {
                htmlEl.style.backgroundColor = '';
                htmlEl.style.borderBottom = '';
            }
            htmlEl.style.cursor = '';
        }
    }
}

export const CommentMark = CommentMarkSchema.extend<CommentMarkOptions>({
    addOptions() {
        return {
            onCommentClick: undefined,
            onCommentContextMenu: undefined,
            onAddComment: undefined,
            onToggleCommentPanel: undefined,
            onDeleteComment: undefined,
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

        // Plugin that applies resolved + color styles directly to DOM elements
        plugins.push(
            new Plugin({
                key: metaKey,
                state: {
                    init: () => 0,
                    apply: (tr, val) => (tr.docChanged || tr.getMeta(metaKey) ? val + 1 : val),
                },
                view: () => ({
                    update: (view) => applyCommentStyles(view, storage),
                }),
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
    const tr = editor.view.state.tr.setMeta(metaKey, true);
    editor.view.dispatch(tr);
}
