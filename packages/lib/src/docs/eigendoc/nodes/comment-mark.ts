// The comment mark: the schema half of a Docs comment anchor, which holds a card's id on a run of text. A node the Yjs
// binding keeps no mark on, such as an image or an equation, holds the id in an attribute instead. The code that finds
// anchors, in the editor and in a reader without one such as the server's, takes both attribute names from here.

import { Mark, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        commentMark: {
            setComment: (cardId: string) => ReturnType;
            unsetComment: () => ReturnType;
        };
    }
}

// The attribute the comment mark keeps its card in.
export const COMMENT_MARK_CARD_ATTRIBUTE = 'cardId';
// The attribute a node that takes no mark keeps its card in.
export const COMMENT_CARD_ATTRIBUTE = 'commentCardId';

export const CommentMarkSchema = Mark.create({
    name: 'comment',
    // A card's anchor, not formatting: Clear formatting (`unsetAllMarks`) keeps it.
    clearable: false,

    addAttributes() {
        return {
            [COMMENT_MARK_CARD_ATTRIBUTE]: {
                default: null,
                parseHTML: (element: HTMLElement) => element.getAttribute('data-comment-id'),
                renderHTML: (attributes: Record<string, unknown>) => {
                    const cardId = attributes[COMMENT_MARK_CARD_ATTRIBUTE];
                    return cardId ? { 'data-comment-id': cardId } : {};
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
                ({ commands }) =>
                    commands.setMark(this.name, { [COMMENT_MARK_CARD_ATTRIBUTE]: cardId }),
            unsetComment:
                () =>
                ({ commands }) =>
                    commands.unsetMark(this.name),
        };
    },
});
