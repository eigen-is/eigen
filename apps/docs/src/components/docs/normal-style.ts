// The doc's Normal text style as the editor rewrites it from the selection, through Format's Update 'Normal text' to
// match. The write goes to the doc's style map under NORMAL_STYLE_ORIGIN, which the doc's undo manager tracks, so it
// is one undo step of its own.

import type { Mark } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/react';
import { getFontName } from '@workspace/lib/constants/fonts';
import type { NormalStyle } from '@workspace/lib/docs/eigendoc';
import {
    readNormalStyle,
    STYLE_ROOT,
    selectionFontSizes,
    selectionParagraphFormat,
} from '@workspace/lib/docs/eigendoc';
import type * as Y from 'yjs';

export const NORMAL_STYLE_ORIGIN = Symbol('normal style');

// Format › Paragraph styles › Normal text › Update 'Normal text' to match, as Google Docs has it: what the selection's
// first text and paragraph draw becomes the doc's Normal, its own undo step, sealed on both sides. The content keeps
// its marks and formats. A paragraph in a list, a quote or a cell draws its container's spacing, so the Normal keeps
// its own, and so does a font or a color it can't hold, such as a pasted rgb() color.
export function updateNormalStyle(doc: Y.Doc, undoManager: Y.UndoManager, editor: Editor, normal: NormalStyle) {
    const { state } = editor;
    const view = editor.isDestroyed ? undefined : editor.view;
    const [size] = selectionFontSizes(state, view, normal);
    // A caret's marks are the ones it types with, a range's its first text's own.
    const { selection } = state;
    let marks: readonly Mark[] = state.storedMarks ?? selection.$from.marks();
    let found = selection.empty;
    state.doc.nodesBetween(selection.from, selection.to, (node) => {
        if (found) return false;
        if (node.isText) {
            marks = node.marks;
            found = true;
        }
    });
    const attrs = marks.find((mark) => mark.type.name === 'textStyle')?.attrs;
    const font = typeof attrs?.['fontFamily'] === 'string' ? getFontName(attrs['fontFamily']) : normal.font;
    const color = typeof attrs?.['color'] === 'string' ? attrs['color'].toLowerCase() : normal.color;
    const { spacing, drawn } = selectionParagraphFormat(state, view, normal);
    const style = readNormalStyle({
        font: readNormalStyle({ font }).font === font ? font : normal.font,
        size,
        lineSpacing: drawn.lineSpacing,
        spaceBefore: spacing ? drawn.spaceBefore : normal.spaceBefore,
        spaceAfter: spacing ? drawn.spaceAfter : normal.spaceAfter,
        color: readNormalStyle({ color }).color === color ? color : normal.color,
    });
    const map = doc.getMap(STYLE_ROOT);
    const stored: Record<string, unknown> = readNormalStyle(map.toJSON());
    undoManager.stopCapturing();
    doc.transact(() => {
        for (const [key, value] of Object.entries(style)) if (stored[key] !== value) map.set(key, value);
    }, NORMAL_STYLE_ORIGIN);
    undoManager.stopCapturing();
}
