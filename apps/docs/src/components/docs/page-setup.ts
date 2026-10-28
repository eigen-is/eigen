// The doc's page as the editor writes it, and the reader's text width on a page-less doc. A page setup change, such as
// one from the Page setup dialog or a band's bar, is one write to the page map and one undo step beside the typing.
// The text width is no part of the doc: each reader keeps their own.

import { defaultDeleteFilter, defaultProtectedNodes, ySyncPluginKey } from '@tiptap/y-tiptap';
import type { PageSetup } from '@workspace/lib/docs/eigendoc';
import { PAGE_ROOT, pageRecord, readPageSetup, STYLE_ROOT } from '@workspace/lib/docs/eigendoc';
import type { DocsTextWidth } from '@workspace/lib/types/settings';
import * as Y from 'yjs';
import { NORMAL_STYLE_ORIGIN } from './normal-style';

const PAGE_SETUP_ORIGIN = Symbol('page setup');

// Google Docs' text widths, measured on its page-less doc and rounded to the quarter inch: the column a page-less doc
// draws its text in, whatever its paper. Full is the editor's width less a gutter on each side.
export const TEXT_WIDTHS: Record<DocsTextWidth, { label: string; px: number | null }> = {
    narrow: { label: 'Narrow', px: 696 },
    medium: { label: 'Medium', px: 888 },
    wide: { label: 'Wide', px: 1056 },
    full: { label: 'Full', px: null },
};

// y-tiptap's own undo manager over the page and style maps too, so ⌘Z takes back a page setup change and an update of
// Normal text. yUndoPlugin applies these defaults only to a manager it builds, so they are copied here; its plugin view
// destroys either kind.
export function createDocUndoManager(doc: Y.Doc): Y.UndoManager {
    return new Y.UndoManager([doc.getXmlFragment('default'), doc.getMap(PAGE_ROOT), doc.getMap(STYLE_ROOT)], {
        trackedOrigins: new Set([ySyncPluginKey, PAGE_SETUP_ORIGIN, NORMAL_STYLE_ORIGIN]),
        deleteFilter: (item) => defaultDeleteFilter(item, defaultProtectedNodes),
        captureTransaction: (tr) => tr.meta.get('addToHistory') !== false,
    });
}

// The dialog's OK, `from` being the page it opened on: its own undo step, sealed on both sides so it never merges
// with the typing around it. A key the user left alone is not set, so a collaborator's change to it survives,
// unless its stored value reads as another: the dialog showed the read, so that is what OK keeps.
export function writePageSetup(doc: Y.Doc, undoManager: Y.UndoManager, from: PageSetup, to: PageSetup) {
    const page = doc.getMap(PAGE_ROOT);
    const opened: Record<string, unknown> = pageRecord(from);
    const read: Record<string, unknown> = pageRecord(readPageSetup(page.toJSON()));
    undoManager.stopCapturing();
    doc.transact(() => {
        for (const [key, value] of Object.entries(pageRecord(to))) {
            const stored = page.get(key);
            const untouched = value === opened[key] && (stored === undefined || stored === read[key]);
            if (!untouched && stored !== value) page.set(key, value);
        }
    }, PAGE_SETUP_ORIGIN);
    undoManager.stopCapturing();
}
