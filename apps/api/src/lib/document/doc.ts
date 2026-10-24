import type { JSONContent } from '@tiptap/core';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import type { BandRoot, NormalStyle, PageSetup } from '@workspace/lib/docs/eigendoc';
import {
    BAND_EXCLUDED_NODES,
    BAND_ROOTS,
    bandHasContent,
    FIRST_PAGE_BAND,
    PAGE_ROOT,
    pageRecord,
    readNormalStyle,
    readPageSetup,
    STYLE_ROOT,
} from '@workspace/lib/docs/eigendoc';
import * as Y from 'yjs';
import { docSchema } from './doc-schema';
import { readStoredEquation } from './equation';

// Materialized Yjs doc → ProseMirror JSON. Media-free, so it runs identically on the
// main thread and inside the document-transform process (which has no Mount). Every
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

// The bands that print, each as the body's JSON: one with content only, a first-page one only when page 1 differs.
export type EigendocBands = Partial<Record<BandRoot, JSONContent>>;

// A band's schema holds none of BAND_EXCLUDED_NODES, so only a forged peer writes one, and no render or writer sees it.
export function readEigendocBands(doc: Y.Doc): EigendocBands {
    const firstPage: readonly BandRoot[] = readEigendocPage(doc).differentFirstPage
        ? []
        : Object.values(FIRST_PAGE_BAND);
    const without = (node: JSONContent): JSONContent =>
        node.content
            ? {
                  ...node,
                  content: node.content.filter((child) => !BAND_EXCLUDED_NODES.has(child.type ?? '')).map(without),
              }
            : node;
    const bands: EigendocBands = {};
    for (const root of BAND_ROOTS) {
        if (firstPage.includes(root)) continue;
        const json = without(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(root)));
        if (bandHasContent(docSchema().nodeFromJSON(json), readStoredEquation)) bands[root] = json;
    }
    return bands;
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
