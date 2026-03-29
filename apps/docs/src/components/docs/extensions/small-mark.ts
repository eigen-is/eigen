import { Mark, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
    interface Commands<ReturnType> {
        small: {
            toggleSmall: () => ReturnType;
        };
    }
}

export const SmallMark = Mark.create({
    name: 'small',

    parseHTML() {
        return [{ tag: 'small' }];
    },

    renderHTML({ HTMLAttributes }) {
        return ['small', mergeAttributes(HTMLAttributes), 0];
    },

    addCommands() {
        return {
            toggleSmall:
                () =>
                ({ commands }) => {
                    return commands.toggleMark(this.name);
                },
        };
    },
});
