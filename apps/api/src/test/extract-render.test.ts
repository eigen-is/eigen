import { describe, expect, mock, test } from 'bun:test';
import * as engine from '@workspace/sheet/engine';
import * as Y from 'yjs';
import { extractCollabText } from '../lib/search/extract-render';
import { CONTENT_INDEX_MAX_BYTES } from '../lib/search/limits';
import { buildGoldenDeck, buildGoldenDocJson, seedEigendoc, seedSlidesDoc } from './fixtures/golden-documents';
import {
    buildGoldenOps,
    buildGoldenSheets,
    GOLDEN_OPS_EDIT,
    GOLDEN_ROW1_TOTAL,
    seedSheetsDoc,
} from './fixtures/heavy-sheets';

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

    test('eigensheets: replayed ops and recalculated formulas are indexed', async () => {
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
        // ...and formula cells carry their recalculated display value.
        expect(text).toContain(String(GOLDEN_ROW1_TOTAL));
        // Every sheet is indexed, not just the first one the preview renders.
        expect(text).toContain('SHEET2-ONLY-CONTENT');
        expect(warnings).toEqual([]);
        doc.destroy();
    });

    test('eigensheets: a recalc failure indexes the replayed values with a warning', async () => {
        const original = { ...engine };
        mock.module('@workspace/sheet/engine', () => ({
            ...original,
            recalcSheets: () => {
                throw new Error('forced recalc failure');
            },
        }));
        try {
            const doc = new Y.Doc();
            seedSheetsDoc(doc, buildGoldenSheets(), []);

            const { text, warnings } = await extractCollabText('eigensheets', doc);
            expect(warnings).toEqual([{ code: 'recalc-failed', message: 'forced recalc failure' }]);
            // Stale but valid: the literal cells are still indexed, the uncomputed formula is not.
            expect(text).toContain('Region 1');
            expect(text).not.toContain(String(GOLDEN_ROW1_TOTAL));
            doc.destroy();
        } finally {
            mock.module('@workspace/sheet/engine', () => original);
        }
    });

    test('the cap bounds the extracted body', async () => {
        const doc = new Y.Doc();
        const cell = 'z'.repeat(1000);
        const celldata = Array.from({ length: 500 }, (_, i) => ({ r: i, c: 0, v: { m: cell, v: cell } }));
        seedSheetsDoc(doc, [{ id: 'sheet-1', name: 'Sheet1', order: 0, config: {}, celldata }], []);

        const { text } = await extractCollabText('eigensheets', doc);
        expect(text.length).toBeGreaterThan(CONTENT_INDEX_MAX_BYTES);
        // The collectors stop at the first cell that crosses the cap, so the overshoot is
        // bounded by one cell rather than by the document size.
        expect(text.length).toBeLessThan(CONTENT_INDEX_MAX_BYTES + cell.length + 1);
        doc.destroy();
    });
});
