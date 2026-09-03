import type { JSONContent } from '@tiptap/core';
import type { Sheet } from '@workspace/lib/sheets';
import type { DeckData } from '@workspace/lib/slides';
import type { ElementKindRegistry, VectorScene } from '@workspace/lib/vector';
import type * as Y from 'yjs';
import type { ExtractTextJob, TransformWarning } from '../document/transform/protocol';
import { CONTENT_INDEX_MAX_BYTES } from './limits';

// Materialized doc → indexable body text. Runs inside the transform Worker
// (worker.ts owns execution; the main-thread dispatch lives in extract-text.ts).
// This module must not reach the Mount or the transform seam. Each reader loads
// through a dynamic import, the same shape as worker.ts's renderPreview, so an
// eigendoc extract never evaluates the sheet engine. Stickies, chat and plain-text
// bodies are light reads and stay on the main thread.

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

function collectProseMirrorText(node: JSONContent, cap: number): string {
    const out: CappedText = { parts: [], bytes: 0 };
    const walk = (n: JSONContent): boolean => {
        if (typeof n.text === 'string' && !appendCapped(out, n.text, cap)) return false;
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

function collectSlidesText(deck: DeckData, cap: number): string {
    const out: CappedText = { parts: [], bytes: 0 };
    for (const slideId of deck.slideOrder) {
        const slide = deck.slides[slideId];
        if (!slide) continue;
        for (const objId of slide.objectIds) {
            const obj = deck.objects[objId];
            if (obj?.type === 'text' && typeof obj.text === 'string' && !appendCapped(out, obj.text, cap)) {
                return out.parts.join(' ');
            }
        }
    }
    return out.parts.join(' ');
}

function collectSheetsText(sheets: Sheet[], cap: number): string {
    const out: CappedText = { parts: [], bytes: 0 };
    for (const sheet of sheets) {
        for (const cd of sheet.celldata ?? []) {
            const cell = cd.v;
            if (!cell) continue;
            const display = cell.m ?? cell.v;
            if (display == null) continue;
            if (!appendCapped(out, String(display), cap)) return out.parts.join(' ');
        }
    }
    return out.parts.join(' ');
}

// `kinds` rides in from the caller's dynamic import, which is what keeps the vector engine out of an
// eigendoc extract.
function collectVectorText(scene: VectorScene, kinds: ElementKindRegistry, cap: number): string {
    const out: CappedText = { parts: [], bytes: 0 };
    for (const element of scene.elements) {
        const text = kinds[element.type].searchText(element);
        if (text === '') continue;
        if (!appendCapped(out, text, cap)) return out.parts.join('\n');
    }
    return out.parts.join('\n');
}

// Body text for one collab document, capped at ~100 KB. Sheets index stored values
// only — like the preview renderer, the read never recalcs (SHEETS.md § Server-side
// recalc), so a valueless formula cell contributes nothing.
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
            // No recalc: the index serves stored values — a legacy never-computed
            // workbook must not cost a full recalc inside the 30s extract deadline.
            const { sheets } = readSheetsFromDoc(doc, { recalc: false });
            return { text: collectSheetsText(sheets, CONTENT_INDEX_MAX_BYTES), warnings: [] };
        }
        case 'eigenvector': {
            const { ELEMENT_KINDS, readVectorFromDoc } = await import('@workspace/lib/vector');
            const scene = readVectorFromDoc(doc);
            return { text: collectVectorText(scene, ELEMENT_KINDS, CONTENT_INDEX_MAX_BYTES), warnings: [] };
        }
    }
}
