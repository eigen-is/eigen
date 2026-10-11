import { getAttributes, isActive } from '@tiptap/core';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { type Editor, useEditorState } from '@tiptap/react';
import { DOCUMENT_FONT, getFontName } from '@workspace/lib/constants/fonts';
import { oneOf, TEXT_ALIGNS, type TextAlign } from '@workspace/lib/vector';

type ToolbarState = {
    headingLevel: number | undefined;
    fontName: string;
    color: string;
    highlightColor: string;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    highlight: boolean;
    alignment: TextAlign | undefined;
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

// Format › Table and the table panel enable Merge and Unmerge by these; each dry-runs its command, so only in a table.
export function selectCellCommands(
    editor: Editor,
    inTable: boolean,
): { canMergeCells: boolean; canSplitCell: boolean } {
    return {
        canMergeCells: inTable && editor.can().mergeCells(),
        canSplitCell: inTable && editor.can().splitCell(),
    };
}

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
            // isActive sums the matched nodes' ranges, so a list's own range would outweigh its centred items, and
            // getAttributes reads the last heading. A cell selection has a range per cell, as setTextAlign aligns it.
            const alignments = new Set<TextAlign>();
            const headingLevels = new Set<number | undefined>();
            for (const { $from, $to } of state.selection.ranges) {
                state.doc.nodesBetween($from.pos, $to.pos, (node) => {
                    if (!node.isTextblock) return;
                    alignments.add(oneOf(node.attrs['textAlign'], TEXT_ALIGNS, 'left'));
                    headingLevels.add(node.type.name === 'heading' ? node.attrs['level'] : undefined);
                });
            }
            const table = active('table');
            return {
                // A range of mixed levels, or of headings and other blocks, reads as none.
                headingLevel: headingLevels.size === 1 ? [...headingLevels][0] : undefined,
                // getFontName also collapses the full stack a not-yet-normalized doc still carries.
                fontName: getFontName(getAttributes(state, 'textStyle')['fontFamily'] || '') || DOCUMENT_FONT,
                color: getAttributes(state, 'textStyle')['color'] || '',
                highlightColor: active('highlight') ? getAttributes(state, 'highlight')['color'] || '' : '',
                bold: active('bold'),
                italic: active('italic'),
                underline: active('underline'),
                highlight: active('highlight'),
                // An unaligned paragraph's textAlign is null and reads as left; a range of mixed alignments reads as none.
                alignment: alignments.size === 1 ? [...alignments][0] : undefined,
                bulletList: active('bulletList'),
                orderedList: active('orderedList'),
                taskList: active('taskList'),
                link: active('link'),
                selectionEmpty: selection.empty,
                table,
                figure: active('figure'),
                ...selectCellCommands(e, table),
            };
        },
    });
}
