import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { extractCollabText } from '../../lib/search/extract-render';
import { CONTENT_INDEX_MAX_BYTES } from '../../lib/search/limits';
import {
    buildGoldenDeck,
    buildGoldenDocJson,
    buildGoldenVectorScene,
    GOLDEN_VECTOR_LABEL,
    GOLDEN_VECTOR_TEXT,
    seedEigendoc,
    seedSlidesDoc,
    seedVectorDoc,
} from '../fixtures/golden-documents';
import {
    buildGoldenOps,
    buildGoldenSheets,
    GOLDEN_OPS_EDIT,
    GOLDEN_ROW1_TOTAL,
    seedSheetsDoc,
} from '../fixtures/heavy-sheets';

// The Worker-pure search extractor: per-type body text off a materialized Y.Doc.
// Behavior lives here (no Worker spawns) — search-content.test.ts pins the plumbing.

// Never produced by the fixtures' formulas, so it can only come from the raw value.
const VALUE_ONLY_CELL = 424_242;

describe('extractCollabText', () => {
    test('eigendoc: every text node of the golden document, past the preview cap', async () => {
        const doc = new Y.Doc();
        seedEigendoc(doc, buildGoldenDocJson());

        const { text, warnings } = await extractCollabText('eigendoc', doc);
        expect(text).toContain('Quarterly Report');
        // Table cells, task items and code blocks are indexed like any other text node.
        expect(text).toContain('const total');
        expect(text).toContain('Publish the report');
        // Search indexes the whole document — the preview's 20-block cap does not apply.
        expect(text).toContain('BEYOND-PREVIEW-CAP');
        expect(warnings).toEqual([]);
        doc.destroy();
    });

    test('eigenslides: text objects in slide order, image objects skipped', async () => {
        const doc = new Y.Doc();
        seedSlidesDoc(doc, buildGoldenDeck());

        const { text, warnings } = await extractCollabText('eigenslides', doc);
        expect(text).toContain('Deck <strong>title</strong>');
        expect(text).toContain('Background image');
        expect(text).not.toContain('pixel.png');
        expect(warnings).toEqual([]);
        doc.destroy();
    });

    test('eigensheets: replayed ops and stored values are indexed — formulas stay uncomputed', async () => {
        const doc = new Y.Doc();
        const sheets = buildGoldenSheets();
        // A cell with a raw value and no display string, so the extracted body proves
        // the m ?? v fallback.
        sheets[0].data![1][7] = { v: VALUE_ONLY_CELL };
        seedSheetsDoc(doc, sheets, buildGoldenOps());

        const { text, warnings } = await extractCollabText('eigensheets', doc);
        expect(text).toContain('Region 1');
        expect(text).toContain(String(VALUE_ONLY_CELL));
        // The ops batch is replayed before extraction...
        expect(text).toContain(GOLDEN_OPS_EDIT);
        // ...but the index never recalcs: a valueless formula cell contributes
        // nothing rather than a full-workbook recalc inside the extract deadline.
        expect(text).not.toContain(String(GOLDEN_ROW1_TOTAL));
        // Every sheet is indexed, not just the first one the preview renders.
        expect(text).toContain('SHEET2-ONLY-CONTENT');
        expect(warnings).toEqual([]);
        doc.destroy();
    });

    test('eigenvector: text elements and arrow labels are indexed, media names are not', async () => {
        const doc = new Y.Doc();
        seedVectorDoc(doc, buildGoldenVectorScene());

        const { text, warnings } = await extractCollabText('eigenvector', doc);
        expect(text).toContain(GOLDEN_VECTOR_TEXT);
        expect(text).toContain(GOLDEN_VECTOR_LABEL);
        // The text element sits before the arrow in z-order, joined by a newline.
        expect(text).toBe(`${GOLDEN_VECTOR_TEXT}\n${GOLDEN_VECTOR_LABEL}`);
        // The image element carries no words — its media name is not indexable text.
        expect(text).not.toContain('pixel.png');
        expect(warnings).toEqual([]);
        doc.destroy();
    });

    test('eigenvector: an empty drawing extracts to the empty string', async () => {
        const doc = new Y.Doc();
        seedVectorDoc(doc, { elements: [], meta: { background: 'transparent', gridSize: 20 } });

        const { text, warnings } = await extractCollabText('eigenvector', doc);
        expect(text).toBe('');
        expect(warnings).toEqual([]);
        doc.destroy();
    });

    // The cap is a byte budget: the extracted body is cloned to the main thread and
    // inserted into FTS, so it must hold for one huge leaf and for text where a
    // character is not a byte.
    test('the cap bounds the extracted body', async () => {
        const doc = new Y.Doc();
        const cell = 'z'.repeat(1000);
        const celldata = Array.from({ length: 500 }, (_, i) => ({ r: i, c: 0, v: { m: cell, v: cell } }));
        seedSheetsDoc(doc, [{ id: 'sheet-1', name: 'Sheet1', order: 0, config: {}, celldata }], []);

        const { text } = await extractCollabText('eigensheets', doc);
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(CONTENT_INDEX_MAX_BYTES);
        expect(text.startsWith(`${cell} ${cell}`)).toBe(true);
        doc.destroy();
    });

    test('a single leaf larger than the cap is cut to it', async () => {
        const doc = new Y.Doc();
        const huge = 'z'.repeat(CONTENT_INDEX_MAX_BYTES * 3);
        seedEigendoc(doc, { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: huge }] }] });

        const { text } = await extractCollabText('eigendoc', doc);
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(CONTENT_INDEX_MAX_BYTES);
        doc.destroy();
    });

    test('multi-byte text is capped in bytes without splitting a code point', async () => {
        const doc = new Y.Doc();
        // CJK costs 3 UTF-8 bytes per UTF-16 unit, the clef 4 bytes per surrogate pair —
        // counting units against a byte cap overshoots by 3-4x.
        const leaf = '漢字𝄞'.repeat(5_000);
        const celldata = Array.from({ length: 10 }, (_, i) => ({ r: i, c: 0, v: { m: leaf, v: leaf } }));
        seedSheetsDoc(doc, [{ id: 'sheet-1', name: 'Sheet1', order: 0, config: {}, celldata }], []);

        const { text } = await extractCollabText('eigensheets', doc);
        expect(Buffer.byteLength(text)).toBeLessThanOrEqual(CONTENT_INDEX_MAX_BYTES);
        // A half surrogate pair would encode as U+FFFD and break the round-trip.
        expect(Buffer.from(text, 'utf-8').toString('utf-8')).toBe(text);
        doc.destroy();
    });
});
