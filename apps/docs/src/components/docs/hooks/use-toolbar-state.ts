import { type Editor, useEditorState } from '@tiptap/react';
import { DOCUMENT_FONT, getFontName } from '@workspace/lib/constants/fonts';

type ToolbarState = {
    headingLevel: number | undefined;
    fontName: string;
    color: string;
    highlightColor: string;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    strike: boolean;
    code: boolean;
    superscript: boolean;
    subscript: boolean;
    small: boolean;
    allCaps: boolean;
    smallCaps: boolean;
    highlight: boolean;
    alignLeft: boolean;
    alignCenter: boolean;
    alignRight: boolean;
    bulletList: boolean;
    orderedList: boolean;
    taskList: boolean;
    blockquote: boolean;
    codeBlock: boolean;
    link: boolean;
    selectionEmpty: boolean;
};

// useEditor re-renders on no transaction, so the toolbar subscribes to what it draws, and a caret move updates it.
export function useToolbarState(editor: Editor): ToolbarState {
    return useEditorState({
        editor,
        selector: ({ editor: e }) => ({
            headingLevel: [1, 2, 3, 4].find((level) => e.isActive('heading', { level })),
            // getFontName also collapses the full stack a not-yet-normalized doc still carries.
            fontName: getFontName(e.getAttributes('textStyle').fontFamily || '') || DOCUMENT_FONT,
            color: e.getAttributes('textStyle').color || '',
            highlightColor: e.isActive('highlight') ? e.getAttributes('highlight').color || '' : '',
            bold: e.isActive('bold'),
            italic: e.isActive('italic'),
            underline: e.isActive('underline'),
            strike: e.isActive('strike'),
            code: e.isActive('code'),
            superscript: e.isActive('superscript'),
            subscript: e.isActive('subscript'),
            small: e.isActive('small'),
            allCaps: e.isActive('textStyle', { caps: 'all' }),
            smallCaps: e.isActive('textStyle', { caps: 'small' }),
            highlight: e.isActive('highlight'),
            alignLeft: e.isActive({ textAlign: 'left' }),
            alignCenter: e.isActive({ textAlign: 'center' }),
            alignRight: e.isActive({ textAlign: 'right' }),
            bulletList: e.isActive('bulletList'),
            orderedList: e.isActive('orderedList'),
            taskList: e.isActive('taskList'),
            blockquote: e.isActive('blockquote'),
            codeBlock: e.isActive('codeBlock'),
            link: e.isActive('link'),
            selectionEmpty: e.state.selection.empty,
        }),
    });
}
