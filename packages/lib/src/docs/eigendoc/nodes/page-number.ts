import { mergeAttributes, Node } from '@tiptap/core';

const NAME = 'pageNumber';
export const PAGE_NUMBER_KINDS = ['page', 'pages'] as const;
// page: the number of the page it prints on; pages: how many pages the doc has.
export type PageNumberKind = (typeof PAGE_NUMBER_KINDS)[number];

// Any peer writes the attribute, and the PDF and docx need a field they know, so anything else is a page number.
export function readPageNumberKind(value: unknown): PageNumberKind {
    return PAGE_NUMBER_KINDS.find((kind) => kind === value) ?? 'page';
}

// What a field shows wherever no page is drawn: the editor's chip, quick look, the HTML download, its text.
export const PAGE_NUMBER_TEXT = '#';

// Google's page number and page count fields: inline, so a page count goes anywhere text goes.
export const PageNumberNode = Node.create({
    name: NAME,

    group: 'inline',

    inline: true,

    atom: true,

    addAttributes() {
        return {
            kind: {
                default: 'page',
                parseHTML: (element: HTMLElement) => readPageNumberKind(element.getAttribute('data-kind')),
                renderHTML: (attributes: Record<string, unknown>) => ({
                    'data-kind': readPageNumberKind(attributes['kind']),
                }),
            },
        };
    },

    parseHTML() {
        return [{ tag: 'span[data-type="page-number"]' }];
    },

    renderHTML({ HTMLAttributes }) {
        return ['span', mergeAttributes({ 'data-type': 'page-number' }, HTMLAttributes), PAGE_NUMBER_TEXT];
    },

    // Never the node's leafText: Tiptap's input rules read the text before the caret through it, so a field opening a
    // paragraph would read as a heading's # to a space typed after it, and the heading would drop the field.
    renderText() {
        return PAGE_NUMBER_TEXT;
    },
});
