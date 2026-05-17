import { Mark, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        commentMark: {
            setComment: (cardId: string) => ReturnType;
            unsetComment: () => ReturnType;
        };
    }
}

export const CommentMarkSchema = Mark.create({
    name: 'comment',

    addAttributes() {
        return {
            cardId: {
                default: null,
                parseHTML: (element: HTMLElement) => element.getAttribute('data-comment-id'),
                renderHTML: (attributes: Record<string, unknown>) => {
                    if (!attributes['cardId']) return {};
                    return { 'data-comment-id': attributes['cardId'] };
                },
            },
        };
    },

    parseHTML() {
        return [{ tag: 'span[data-comment-id]' }];
    },

    renderHTML({ HTMLAttributes }) {
        return ['span', mergeAttributes(HTMLAttributes, { class: 'comment-highlight' }), 0];
    },

    addCommands() {
        return {
            setComment:
                (cardId: string) =>
                ({ commands }) => {
                    return commands.setMark(this.name, { cardId });
                },
            unsetComment:
                () =>
                ({ commands }) => {
                    return commands.unsetMark(this.name);
                },
        };
    },
});
