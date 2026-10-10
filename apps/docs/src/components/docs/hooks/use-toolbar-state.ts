import { getAttributes, isActive } from '@tiptap/core';
import { EditorState, TextSelection } from '@tiptap/pm/state';
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

// Each check walks every node a range spans, some 25 per transaction, and a collaborator's edit or caret is one too.
const MAX_READ_RANGE = 10_000;

// useEditor re-renders on no transaction, so the toolbar subscribes to what it draws, and a caret move updates it.
export function useToolbarState(editor: Editor): ToolbarState {
    return useEditorState({
        editor,
        selector: ({ editor: e }) => {
            const { doc, selection } = e.state;
            // A longer range reads its first MAX_READ_RANGE positions, as a caret would take the marks before it; a state without the editor's plugins costs nothing to make.
            const state =
                selection.to - selection.from > MAX_READ_RANGE
                    ? EditorState.create({
                          doc,
                          selection: TextSelection.between(
                              selection.$from,
                              doc.resolve(selection.from + MAX_READ_RANGE),
                          ),
                      })
                    : e.state;
            const active = (name: string | null, attributes?: Record<string, unknown>) =>
                isActive(state, name, attributes);
            return {
                headingLevel: [1, 2, 3, 4].find((level) => active('heading', { level })),
                // getFontName also collapses the full stack a not-yet-normalized doc still carries.
                fontName: getFontName(getAttributes(state, 'textStyle')['fontFamily'] || '') || DOCUMENT_FONT,
                color: getAttributes(state, 'textStyle')['color'] || '',
                highlightColor: active('highlight') ? getAttributes(state, 'highlight')['color'] || '' : '',
                bold: active('bold'),
                italic: active('italic'),
                underline: active('underline'),
                strike: active('strike'),
                code: active('code'),
                superscript: active('superscript'),
                subscript: active('subscript'),
                small: active('small'),
                allCaps: active('textStyle', { caps: 'all' }),
                smallCaps: active('textStyle', { caps: 'small' }),
                highlight: active('highlight'),
                alignLeft: active(null, { textAlign: 'left' }),
                alignCenter: active(null, { textAlign: 'center' }),
                alignRight: active(null, { textAlign: 'right' }),
                bulletList: active('bulletList'),
                orderedList: active('orderedList'),
                taskList: active('taskList'),
                blockquote: active('blockquote'),
                codeBlock: active('codeBlock'),
                link: active('link'),
                selectionEmpty: selection.empty,
            };
        },
    });
}
