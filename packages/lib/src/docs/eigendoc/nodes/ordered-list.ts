import { OrderedList } from '@tiptap/extension-list';

// A list's own type, drawn on itself: a selector matches `type` case-blind, so `a` and `A` can't be told apart in CSS,
// and a list set to decimal must beat eigen-prose.css's numbering by depth, which an untyped list takes.
const LIST_STYLE_TYPES = new Map([
    ['1', 'decimal'],
    ['a', 'lower-alpha'],
    ['A', 'upper-alpha'],
    ['i', 'lower-roman'],
    ['I', 'upper-roman'],
]);

const LIST_TYPE_BY_STYLE = new Map([...LIST_STYLE_TYPES].map(([type, style]) => [style, type]));

// The type a list-style-type draws, which an untyped list takes from eigen-prose.css by its depth.
export function listTypeOfStyle(style: string): string | undefined {
    return LIST_TYPE_BY_STYLE.get(style);
}

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
                ...(listStyleType && { type }),
                ...(style && { style }),
            },
            0,
        ];
    },
});
