import { defaultDeleteFilter, defaultProtectedNodes, ySyncPluginKey } from '@tiptap/y-tiptap';
import type { PageSetup } from '@workspace/lib/docs/eigendoc';
import { PAGE_ROOT, pageRecord, readPageSetup, STYLE_ROOT } from '@workspace/lib/docs/eigendoc';
import * as Y from 'yjs';
import { NORMAL_STYLE_ORIGIN } from './normal-style';

const PAGE_SETUP_ORIGIN = Symbol('page setup');

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
