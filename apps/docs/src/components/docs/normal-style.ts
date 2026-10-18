import { getAttributes } from '@tiptap/core';
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
// its own; a value the Normal can't hold, a pasted rgb() colour say, reads as Eigen's.
export function updateNormalStyle(doc: Y.Doc, undoManager: Y.UndoManager, editor: Editor, normal: NormalStyle) {
    const { state } = editor;
    const view = editor.isDestroyed ? undefined : editor.view;
    const [size] = selectionFontSizes(state, view, normal);
    const { fontFamily, color } = getAttributes(state, 'textStyle');
    const { spacing, drawn } = selectionParagraphFormat(state, view, normal);
    const style = readNormalStyle({
        font: fontFamily ? getFontName(fontFamily) : normal.font,
        size,
        lineSpacing: drawn.lineSpacing,
        spaceBefore: spacing ? drawn.spaceBefore : normal.spaceBefore,
        spaceAfter: spacing ? drawn.spaceAfter : normal.spaceAfter,
        color: color || normal.color,
    });
    const map = doc.getMap(STYLE_ROOT);
    const stored: Record<string, unknown> = readNormalStyle(map.toJSON());
    undoManager.stopCapturing();
    doc.transact(() => {
        for (const [key, value] of Object.entries(style)) if (stored[key] !== value) map.set(key, value);
    }, NORMAL_STYLE_ORIGIN);
    undoManager.stopCapturing();
}
