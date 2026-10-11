import { getAttributes, isActive } from '@tiptap/core';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { type Editor, useEditorState } from '@tiptap/react';
import { DOCUMENT_FONT, getFontName } from '@workspace/lib/constants/fonts';
import { TEXT_ALIGNS, type TextAlign } from '@workspace/lib/vector';

type ToolbarState = {
    headingLevel: number | undefined;
    fontName: string;
    color: string;
    highlightColor: string;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    highlight: boolean;
    alignment: TextAlign;
    bulletList: boolean;
    orderedList: boolean;
    taskList: boolean;
    link: boolean;
    selectionEmpty: boolean;
    table: boolean;
    figure: boolean;
    canMergeCells: boolean;
    canSplitCell: boolean;
};

// Each check walks every node a range spans, some 20 per transaction, and a collaborator's edit or caret is one too.
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
                headingLevel: [1, 2, 3, 4, 5, 6].find((level) => active('heading', { level })),
                // getFontName also collapses the full stack a not-yet-normalized doc still carries.
                fontName: getFontName(getAttributes(state, 'textStyle')['fontFamily'] || '') || DOCUMENT_FONT,
                color: getAttributes(state, 'textStyle')['color'] || '',
                highlightColor: active('highlight') ? getAttributes(state, 'highlight')['color'] || '' : '',
                bold: active('bold'),
                italic: active('italic'),
                underline: active('underline'),
                highlight: active('highlight'),
                // An unaligned paragraph's textAlign is null, and it and a range of mixed alignments read as left.
                alignment: TEXT_ALIGNS.find((alignment) => active(null, { textAlign: alignment })) ?? 'left',
                bulletList: active('bulletList'),
                orderedList: active('orderedList'),
                taskList: active('taskList'),
                link: active('link'),
                selectionEmpty: selection.empty,
                table: active('table'),
                figure: active('figure'),
                canMergeCells: e.can().mergeCells(),
                canSplitCell: e.can().splitCell(),
            };
        },
    });
}
