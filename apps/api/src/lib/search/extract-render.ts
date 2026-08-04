import type { JSONContent } from '@tiptap/core';
import type { Sheet } from '@workspace/lib/sheets';
import type { DeckData } from '@workspace/lib/slides';
import type * as Y from 'yjs';
import type { ExtractTextJob, TransformWarning } from '../document/transform/protocol';
import { CONTENT_INDEX_MAX_BYTES } from './limits';

// Materialized doc → indexable body text. Runs inside the transform Worker
// (worker.ts owns execution; the main-thread dispatch lives in extract-text.ts).
// This module must not reach the Mount or the transform seam. Each reader loads
// through a dynamic import, the same shape as worker.ts's renderPreview, so an
// eigendoc extract never evaluates the sheet engine. Stickies, chat and plain-text
// bodies are light reads and stay on the main thread.

function collectProseMirrorText(node: JSONContent, cap: number): string {
    const parts: string[] = [];
    let total = 0;
    const walk = (n: JSONContent): boolean => {
        if (total >= cap) return false;
        if (typeof n.text === 'string') {
            parts.push(n.text);
            total += n.text.length;
            if (total >= cap) return false;
        }
        if (Array.isArray(n.content)) {
            for (const child of n.content) {
                if (!walk(child)) return false;
            }
        }
        return true;
    };
    walk(node);
    return parts.join(' ');
}

function collectSlidesText(deck: DeckData, cap: number): string {
    const parts: string[] = [];
    let total = 0;
    for (const slideId of deck.slideOrder) {
        const slide = deck.slides[slideId];
        if (!slide) continue;
        for (const objId of slide.objectIds) {
            const obj = deck.objects[objId];
            if (obj?.type === 'text' && typeof obj.text === 'string') {
                parts.push(obj.text);
                total += obj.text.length;
                if (total >= cap) return parts.join(' ');
            }
        }
    }
    return parts.join(' ');
}

function collectSheetsText(sheets: Sheet[], cap: number): string {
    const parts: string[] = [];
    let total = 0;
    for (const sheet of sheets) {
        for (const cd of sheet.celldata ?? []) {
            const cell = cd.v;
            if (!cell) continue;
            const display = cell.m ?? cell.v;
            if (display == null) continue;
            const s = String(display);
            parts.push(s);
            total += s.length;
            if (total >= cap) return parts.join(' ');
        }
    }
    return parts.join(' ');
}

// Body text for one collab document, capped at ~100 KB. Recalc failure indexes the
// replayed values with a warning, mirroring the preview renderer — a stale body beats
// no body at all.
export async function extractCollabText(
    documentType: ExtractTextJob['documentType'],
    doc: Y.Doc,
): Promise<{ text: string; warnings: TransformWarning[] }> {
    switch (documentType) {
        case 'eigendoc': {
            const { readEigendocFromDoc } = await import('../document/doc');
            return { text: collectProseMirrorText(readEigendocFromDoc(doc), CONTENT_INDEX_MAX_BYTES), warnings: [] };
        }
        case 'eigenslides': {
            const { readDeckFromDoc } = await import('../document/slides');
            return { text: collectSlidesText(readDeckFromDoc(doc), CONTENT_INDEX_MAX_BYTES), warnings: [] };
        }
        case 'eigensheets': {
            const { readSheetsFromDoc } = await import('../document/sheets');
            const { sheets, recalcError } = readSheetsFromDoc(doc);
            const warnings: TransformWarning[] = recalcError ? [{ code: 'recalc-failed', message: recalcError }] : [];
            return { text: collectSheetsText(sheets, CONTENT_INDEX_MAX_BYTES), warnings };
        }
    }
}
