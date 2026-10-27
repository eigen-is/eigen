// A collab document's body text for the search index, cut to the index's byte budget. It runs in the transform
// process, so it reaches neither the Mount nor the transform seam. Each heavy reader loads through a dynamic import, so
// a doc's extract never loads the sheet engine; the React-free chart reader is a static import. Light reads, such as a
// sticky or a chat, stay on the main thread.

import type { JSONContent } from '@tiptap/core';
import { chartSearchText, readChartSpec } from '@workspace/lib/charts';
import { isRecord } from '@workspace/lib/guards';
import type { Sheet } from '@workspace/lib/sheets';
import type { ElementKindRegistry, VectorElement } from '@workspace/lib/vector';
import type { cellDisplay } from '@workspace/sheet/engine';
import type * as Y from 'yjs';
import type { readStoredEquation } from '../document/equation';
import type { ExtractTextJob, TransformWarning } from '../document/transform/protocol';
import { CONTENT_INDEX_MAX_BYTES } from './limits';

// The cap is a UTF-8 byte budget, and a leaf is arbitrarily large: whatever the
// collectors keep is cloned to the main thread and inserted into FTS, so each leaf is
// cut to the budget that is left (the ' ' join separators included) instead of being
// appended whole and measured afterwards.
type CappedText = { parts: string[]; bytes: number };

function appendCapped(out: CappedText, text: string, cap: number): boolean {
    const separator = out.parts.length > 0 ? 1 : 0;
    const remaining = cap - out.bytes - separator;
    if (remaining <= 0) return false;
    const fitting = Buffer.byteLength(text) <= remaining ? text : cutToBytes(text, remaining);
    out.parts.push(fitting);
    out.bytes += separator + Buffer.byteLength(fitting);
    return out.bytes < cap;
}

// Cuts at a code-point boundary — a split surrogate pair would land as U+FFFD in the
// index. UTF-16 units cost at least one byte each, so slicing to maxBytes units first
// bounds the encode of a huge leaf.
function cutToBytes(text: string, maxBytes: number): string {
    let head = text.slice(0, maxBytes);
    const last = head.charCodeAt(head.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) head = head.slice(0, -1);
    const bytes = Buffer.from(head, 'utf-8');
    if (bytes.byteLength <= maxBytes) return head;
    let end = maxBytes;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
    return bytes.toString('utf-8', 0, end);
}

// `attributeText` and `readEquation` ride in from the caller's dynamic import, which keeps the doc schema out of the
// other extracts.
function collectProseMirrorText(
    node: JSONContent,
    attributeText: (n: JSONContent) => string[],
    readEquation: typeof readStoredEquation,
    cap: number,
): string {
    const out: CappedText = { parts: [], bytes: 0 };
    const walk = (n: JSONContent): boolean => {
        if (typeof n.text === 'string' && !appendCapped(out, n.text, cap)) return false;
        for (const text of attributeText(n)) if (!appendCapped(out, text, cap)) return false;
        const equation = n.type === 'equation' && readEquation(n.attrs ?? {}).text;
        if (equation && !appendCapped(out, equation, cap)) return false;
        if (Array.isArray(n.content)) {
            for (const child of n.content) {
                if (!walk(child)) return false;
            }
        }
        return true;
    };
    walk(node);
    return out.parts.join(' ');
}

// A sheet's cells, then its charts' titles and series names. `textOf` rides in from the caller's dynamic import, as
// `kinds` does below. A peer can store anything under a chart's id, so an entry that is no object is no chart.
function collectSheetsText(sheets: Sheet[], textOf: typeof cellDisplay, cap: number): string {
    const out: CappedText = { parts: [], bytes: 0 };
    for (const sheet of sheets) {
        for (const cd of sheet.celldata ?? []) {
            const display = textOf(cd.v);
            if (display == null) continue;
            if (!appendCapped(out, String(display), cap)) return out.parts.join(' ');
        }
        for (const chart of Object.values(sheet.charts ?? {})) {
            if (!isRecord(chart)) continue;
            const text = chartSearchText(readChartSpec(chart).spec);
            if (text !== '' && !appendCapped(out, text, cap)) return out.parts.join(' ');
        }
    }
    return out.parts.join(' ');
}

// A deck and a drawing are the same document, so one collector serves both: every kind's own
// searchText, over the elements the caller already put in sceneReadingOrder. `kinds` and that order
// ride in from the caller's dynamic import, which keeps the vector engine out of an eigendoc extract.
function collectCanvasText(elements: VectorElement[], kinds: ElementKindRegistry, cap: number): string {
    const out: CappedText = { parts: [], bytes: 0 };
    for (const element of elements) {
        const text = kinds[element.type].searchText(element);
        if (text === '') continue;
        if (!appendCapped(out, text, cap)) return out.parts.join('\n');
    }
    return out.parts.join('\n');
}

// Body text for one collab document, capped at about 100 KB. Sheets index their stored values and their charts' text:
// as for the preview, the read never recalculates, so a formula cell with no value adds nothing.
export async function extractCollabText(
    documentType: ExtractTextJob['documentType'],
    doc: Y.Doc,
): Promise<{ text: string; warnings: TransformWarning[] }> {
    switch (documentType) {
        case 'eigendoc': {
            const [{ readEigendocFromDoc }, { readStoredEquation }, { attributeSearchText }] = await Promise.all([
                import('../document/doc'),
                import('../document/equation'),
                import('@workspace/lib/docs/eigendoc'),
            ]);
            const text = collectProseMirrorText(
                readEigendocFromDoc(doc),
                attributeSearchText,
                readStoredEquation,
                CONTENT_INDEX_MAX_BYTES,
            );
            return { text, warnings: [] };
        }
        case 'eigensheets': {
            const [{ readSheetsFromDoc }, engine] = await Promise.all([
                import('../document/sheets'),
                import('@workspace/sheet/engine'),
            ]);
            // No recalc: the index serves stored values — a legacy never-computed
            // workbook must not cost a full recalc inside the 30s extract deadline.
            const { sheets } = readSheetsFromDoc(doc, { recalc: false });
            const text = collectSheetsText(sheets, engine.cellDisplay, CONTENT_INDEX_MAX_BYTES);
            return { text, warnings: [] };
        }
        case 'eigenslides':
        case 'eigenvector': {
            const { ELEMENT_KINDS, readVectorFromDoc, sceneReadingOrder } = await import('@workspace/lib/vector');
            const ordered = sceneReadingOrder(readVectorFromDoc(doc));
            return { text: collectCanvasText(ordered, ELEMENT_KINDS, CONTENT_INDEX_MAX_BYTES), warnings: [] };
        }
    }
}
