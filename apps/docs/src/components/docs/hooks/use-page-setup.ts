import { defaultDeleteFilter, defaultProtectedNodes, ySyncPluginKey } from '@tiptap/y-tiptap';
import type { PageSetup } from '@workspace/lib/docs/eigendoc';
import { PAGE_ROOT, pageRecord, readPageSetup } from '@workspace/lib/docs/eigendoc';
import { useEffect, useState } from 'react';
import * as Y from 'yjs';

const PAGE_SETUP_ORIGIN = Symbol('page setup');

// y-tiptap's own undo manager over the page map too, so ⌘Z takes back a page setup change. yUndoPlugin applies
// these defaults only to a manager it builds, so they are copied here; its plugin view destroys either kind.
export function createDocUndoManager(doc: Y.Doc): Y.UndoManager {
    return new Y.UndoManager([doc.getXmlFragment('default'), doc.getMap(PAGE_ROOT)], {
        trackedOrigins: new Set([ySyncPluginKey, PAGE_SETUP_ORIGIN]),
        deleteFilter: (item) => defaultDeleteFilter(item, defaultProtectedNodes),
        captureTransaction: (tr) => tr.meta.get('addToHistory') !== false,
    });
}

export function usePageSetup(doc: Y.Doc): PageSetup {
    const page = doc.getMap(PAGE_ROOT);
    const [setup, setSetup] = useState(() => readPageSetup(page.toJSON()));
    useEffect(() => {
        const read = () => setSetup(readPageSetup(page.toJSON()));
        page.observe(read);
        return () => page.unobserve(read);
    }, [page]);
    return setup;
}

// Its own undo step, sealed on both sides so it never merges with the typing around it. Only the keys whose value
// changes are set, so a collaborator's change to another key survives and an unchanged page writes nothing.
export function writePageSetup(doc: Y.Doc, undoManager: Y.UndoManager, setup: PageSetup) {
    const page = doc.getMap(PAGE_ROOT);
    const current: Record<string, number> = pageRecord(readPageSetup(page.toJSON()));
    undoManager.stopCapturing();
    doc.transact(() => {
        for (const [key, value] of Object.entries(pageRecord(setup))) {
            if (current[key] !== value) page.set(key, value);
        }
    }, PAGE_SETUP_ORIGIN);
    undoManager.stopCapturing();
}
