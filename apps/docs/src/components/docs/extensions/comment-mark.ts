import {Mark, mergeAttributes} from '@tiptap/core';
import {Plugin, PluginKey} from '@tiptap/pm/state';

export type CommentMarkOptions = {
    HTMLAttributes: Record<string, unknown>;
    onCommentClick?: (chatId: string) => void;
};

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        commentMark: {
            setComment: (chatId: string) => ReturnType;
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
            chatId: {
                default: null,
                parseHTML: (element: HTMLElement) => element.getAttribute('data-chat-id'),
                renderHTML: (attributes: Record<string, unknown>) => {
                    if (!attributes.chatId) return {};
                    return {'data-chat-id': attributes.chatId};
                },
            },
        };
    },

    parseHTML() {
        return [{tag: 'span[data-chat-id]'}];
    },

    renderHTML({HTMLAttributes}) {
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
            setComment: (chatId: string) => ({commands}) => {
                return commands.setMark(this.name, {chatId});
            },
            unsetComment: () => ({commands}) => {
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
                            const chatId = commentEl.getAttribute('data-chat-id');
                            if (chatId) {
                                onCommentClick(chatId);
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
