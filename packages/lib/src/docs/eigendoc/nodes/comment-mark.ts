import { Mark, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        commentMark: {
            setComment: (chatName: string) => ReturnType;
            unsetComment: () => ReturnType;
        };
    }
}

export const CommentMarkSchema = Mark.create({
    name: 'comment',

    addAttributes() {
        return {
            chatName: {
                default: null,
                parseHTML: (element: HTMLElement) => element.getAttribute('data-chat-name'),
                renderHTML: (attributes: Record<string, unknown>) => {
                    if (!attributes['chatName']) return {};
                    return { 'data-chat-name': attributes['chatName'] };
                },
            },
        };
    },

    parseHTML() {
        return [{ tag: 'span[data-chat-name]' }];
    },

    renderHTML({ HTMLAttributes }) {
        return ['span', mergeAttributes(HTMLAttributes, { class: 'comment-highlight' }), 0];
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
});
