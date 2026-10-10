import { OrderedList } from '@tiptap/extension-list';

// A selector matches `type` case-blind, so `a` and `A` can't be told apart in CSS: the list writes its own marker style.
const LIST_STYLE_TYPES = new Map([
    ['a', 'lower-alpha'],
    ['A', 'upper-alpha'],
    ['i', 'lower-roman'],
    ['I', 'upper-roman'],
]);

// WeasyPrint reads `start` only as a presentational hint, which the PDF render takes none of: the counter-reset sets it.
export const EigenOrderedList = OrderedList.extend({
    renderHTML({ HTMLAttributes }) {
        const { start, type, ...rest } = HTMLAttributes;
        const listStyleType = LIST_STYLE_TYPES.get(type);
        const style = [
            Number.isInteger(start) && start !== 1 && `counter-reset: list-item ${start - 1}`,
            listStyleType && `list-style-type: ${listStyleType}`,
        ]
            .filter(Boolean)
            .join('; ');
        return [
            'ol',
            {
                ...this.options.HTMLAttributes,
                ...rest,
                ...(start !== 1 && { start }),
                ...(type && type !== '1' && { type }),
                ...(style && { style }),
            },
            0,
        ];
    },
});
