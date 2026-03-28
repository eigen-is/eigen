import { Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

export type CommentMarkOptions = {
    HTMLAttributes: Record<string, unknown>;
    onCommentClick?: (chatName: string) => void;
};

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        commentMark: {
            setComment: (chatName: string) => ReturnType;
            unsetComment: () => ReturnType;
        };
    }
}

export const CommentMark = Mark.create<CommentMarkOptions>({
    name: 'comment',

    addOptions() {
        return {
            HTMLAttributes: {},
            onCommentClick: undefined,
        };
    },

    addAttributes() {
        return {
            chatName: {
                default: null,
                parseHTML: (element: HTMLElement) => element.getAttribute('data-chat-name'),
                renderHTML: (attributes: Record<string, unknown>) => {
                    if (!attributes.chatName) return {};
                    return { 'data-chat-name': attributes.chatName };
                },
            },
        };
    },

    parseHTML() {
        return [{ tag: 'span[data-chat-name]' }];
    },

    renderHTML({ HTMLAttributes }) {
        return [
            'span',
            mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
                class: 'comment-highlight',
            }),
            0,
        ];
    },

    addCommands() {
        return {
            setComment:
                (chatName: string) =>
                ({ commands }) => {
                    return commands.setMark(this.name, { chatName });
                },
            unsetComment:
                () =>
                ({ commands }) => {
                    return commands.unsetMark(this.name);
                },
        };
    },

    addProseMirrorPlugins() {
        const onCommentClick = this.options.onCommentClick;
        if (!onCommentClick) return [];

        return [
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
        ];
    },
});
