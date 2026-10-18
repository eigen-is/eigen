import { getAttributes, isActive } from '@tiptap/core';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import { type Editor, useEditorState } from '@tiptap/react';
import { getFontName } from '@workspace/lib/constants/fonts';
import type { NormalStyle } from '@workspace/lib/docs/eigendoc';
import { readCellBackground, selectionFontSizes, selectionParagraphFormat } from '@workspace/lib/docs/eigendoc';
import { oneOf, TEXT_ALIGNS, type TextAlign } from '@workspace/lib/vector';
import { canAnchorComment } from '../extensions/comment-mark';
import { numberedListType, orderedListDepth } from '../list-numbering';
import { paragraphStyleOf } from '../paragraph-styles';

export type ToolbarState = {
    // The paragraph style's name, none for Normal text.
    paragraphStyle: string | undefined;
    mixedStyles: boolean;
    // Whether the selection starts in a plain paragraph, the one block Update 'Normal text' to match reads.
    inParagraph: boolean;
    fontName: string;
    // In pt, none for a range of mixed sizes.
    fontSize: number | undefined;
    color: string;
    highlightColor: string;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    highlight: boolean;
    alignment: TextAlign | undefined;
    // The line spacing every selected paragraph stores or takes from the Normal, none for a mix or an unset heading.
    lineSpacing: number | undefined;
    // Whether a selected paragraph takes a space before or after: a list, a quote or a cell owns its own.
    paragraphSpacing: boolean;
    // Whether the selection's first paragraph draws space there, which Add or Remove space toggles.
    spaceBefore: boolean;
    spaceAfter: boolean;
    bulletList: boolean;
    orderedList: boolean;
    // The type of the numbered list the caret is in, decimal as '1', an untyped one's as it draws at its depth.
    orderedListType: string | undefined;
    taskList: boolean;
    link: boolean;
    selectionEmpty: boolean;
    canComment: boolean;
    table: boolean;
    figure: boolean;
    canMergeCells: boolean;
    canSplitCell: boolean;
    // The fill of the cell the selection starts in, '' for none.
    cellBackground: string;
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

// Format › Table and the table panel show the fill of the cell the selection starts in, a cell selection's first.
export function cellBackground(state: EditorState): string {
    const { $from } = state.selection;
    for (let depth = $from.depth; depth > 0; depth--) {
        const node = $from.node(depth);
        if (node.type.spec['tableRole'] === 'cell' || node.type.spec['tableRole'] === 'header_cell')
            return readCellBackground(node.attrs['backgroundColor']) ?? '';
    }
    return '';
}

// Each check walks every node a range spans, some 20 per transaction, and a collaborator's edit or caret is one too.
const MAX_READ_RANGE = 10_000;

// useEditor re-renders on no transaction, so the toolbar subscribes to what it draws, and a caret move updates it. The
// selector reads the editor passed in, not the snapshot's: the toolbar follows a band's editor while it is edited, and
// the snapshot keeps the last editor until the new one's first transaction. Unformatted text reads as the doc's Normal.
export function useToolbarState(editor: Editor, normal: NormalStyle): ToolbarState {
    return useEditorState({
        editor,
        selector: () => {
            const { doc, selection } = editor.state;
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
                    : editor.state;
            const active = (name: string | null, attributes?: Record<string, unknown>) =>
                isActive(state, name, attributes);
            // isActive sums the matched nodes' ranges, so a list's own range would outweigh its centred items, and
            // getAttributes reads the last heading. A cell selection has a range per cell, as setTextAlign aligns it.
            const alignments = new Set<TextAlign>();
            const styles = new Set<string | undefined>();
            for (const { $from, $to } of state.selection.ranges) {
                state.doc.nodesBetween($from.pos, $to.pos, (node) => {
                    if (!node.isTextblock) return;
                    alignments.add(oneOf(node.attrs['textAlign'], TEXT_ALIGNS, 'left'));
                    styles.add(paragraphStyleOf(node)?.name);
                });
            }
            const table = active('table');
            // A heading's own size and spacing are read off the page, which an editor not yet mounted has none of.
            const view = editor.isDestroyed ? undefined : editor.view;
            const fontSizes = selectionFontSizes(state, view, normal);
            const format = selectionParagraphFormat(state, view, normal);
            const listDepth = orderedListDepth(selection.$from);
            return {
                // A range of mixed styles, or of styled and Normal text, reads as none.
                paragraphStyle: styles.size === 1 ? [...styles][0] : undefined,
                mixedStyles: styles.size > 1,
                inParagraph: selection.$from.parent.type.name === 'paragraph',
                // getFontName also collapses the full stack a not-yet-normalized doc still carries.
                fontName: getFontName(getAttributes(state, 'textStyle')['fontFamily'] || '') || normal.font,
                fontSize: fontSizes.size === 1 ? [...fontSizes][0] : undefined,
                color: getAttributes(state, 'textStyle')['color'] || '',
                highlightColor: active('highlight') ? getAttributes(state, 'highlight')['color'] || '' : '',
                bold: active('bold'),
                italic: active('italic'),
                underline: active('underline'),
                highlight: active('highlight'),
                // An unaligned paragraph's textAlign is null and reads as left; a range of mixed alignments reads as none.
                alignment: alignments.size === 1 ? [...alignments][0] : undefined,
                lineSpacing: format.lineSpacing,
                paragraphSpacing: format.spacing,
                spaceBefore: format.drawn.spaceBefore > 0,
                spaceAfter: format.drawn.spaceAfter > 0,
                bulletList: active('bulletList'),
                orderedList: active('orderedList'),
                orderedListType:
                    listDepth === undefined
                        ? undefined
                        : numberedListType(
                              selection.$from.node(listDepth),
                              view?.nodeDOM(selection.$from.before(listDepth)),
                          ),
                taskList: active('taskList'),
                link: active('link'),
                selectionEmpty: selection.empty,
                canComment: canAnchorComment(editor.state),
                table,
                figure: active('figure'),
                ...selectCellCommands(editor, table),
                cellBackground: table ? cellBackground(state) : '',
            };
        },
    });
}
