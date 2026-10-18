import type { JSONContent } from '@tiptap/core';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import {
    BAND_ROOTS,
    type NormalStyle,
    PAGE_ROOT,
    type PageSetup,
    pageRecord,
    readNormalStyle,
    readPageSetup,
    STYLE_ROOT,
} from '@workspace/lib/docs/eigendoc';
import * as Y from 'yjs';

// Materialized Yjs doc → ProseMirror JSON. Media-free, so it runs identically on the
// main thread and inside the document-transform Worker (which has no Mount). Every
// consumer of a persisted eigendoc reads it in the Worker, so the Mount-side loader is
// gone: capture (collab-source.ts) + materialize (yjs-loader.ts) is the only path in.
export function readEigendocFromDoc(doc: Y.Doc): JSONContent {
    return yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('default'));
}

export function readEigendocPage(doc: Y.Doc): PageSetup {
    return readPageSetup(doc.getMap(PAGE_ROOT).toJSON());
}

export function readEigendocStyle(doc: Y.Doc): NormalStyle {
    return readNormalStyle(doc.getMap(STYLE_ROOT).toJSON());
}

// The import commit: a Yjs update prepared elsewhere (the transform process) replaces the body and the bands, and the
// file's page and Normal replace the doc's, in one transaction. Clearing first is what makes an import a replacement:
// an applied update alone appends. The page and style keys are set here, on the live doc: set in the update, each would
// be concurrent with the live key, and Yjs keeps whichever client id orders last.
export function commitEigendocImport(
    doc: Y.Doc,
    { update, page, style }: { update: Uint8Array; page: PageSetup; style: NormalStyle },
): void {
    doc.transact(() => {
        for (const root of ['default', ...BAND_ROOTS]) {
            const fragment = doc.getXmlFragment(root);
            if (fragment.length > 0) fragment.delete(0, fragment.length);
        }
        Y.applyUpdate(doc, update);
        const map = doc.getMap(PAGE_ROOT);
        for (const [key, value] of Object.entries(pageRecord(page))) map.set(key, value);
        const normal = doc.getMap(STYLE_ROOT);
        for (const [key, value] of Object.entries(style)) normal.set(key, value);
    });
}
