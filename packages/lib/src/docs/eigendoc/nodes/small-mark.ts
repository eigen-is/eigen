import { Mark, mergeAttributes } from '@tiptap/core';

// Off the menus since font sizes, and kept: the Yjs binding deletes the text of a mark the schema lacks.
export const SmallMark = Mark.create({
    name: 'small',

    parseHTML() {
        return [{ tag: 'small' }];
    },

    renderHTML({ HTMLAttributes }) {
        return ['small', mergeAttributes(HTMLAttributes), 0];
    },
});
