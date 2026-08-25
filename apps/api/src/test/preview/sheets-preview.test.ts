import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { Sheet } from '@workspace/lib/sheets';
import type { DrivePath } from '@workspace/lib/types/drive';
import { FormulaEngine } from '@workspace/sheet/engine';
import * as Y from 'yjs';
import { PREVIEW_SHEET_BUDGET, renderSheetsPreviewHtml } from '../../lib/export/sheets/render';
import { getHome } from '../../lib/home/get-home';
import { renderEigensheetsPreviewBody } from '../../lib/preview/eigensheets-render';
import {
    buildGoldenOps,
    buildGoldenSheets,
    buildHeavyOps,
    buildHeavySheets,
    GOLDEN_OPS_EDIT,
    GOLDEN_OPS_PARTIAL_EDIT,
    GOLDEN_ROW1_TOTAL,
    GOLDEN_SHEET2_MARKER,
    HEAVY_FAR_CORNER,
    seedSheetsDoc,
} from '../fixtures/heavy-sheets';
import { authedRequest, driveGet, drivePost, getTestContext } from '../setup';

// Golden output assertions for the eigensheets preview pipeline (proposal Phase 0:
// pin the rendered contract BEFORE the Yjs loader / renderer refactor). The hash at
// the bottom pins the exact sanitized body for the deterministic golden fixture —
// it may only change for an intentional renderer/budget change, never as refactor
// fallout.

type TextPreview = { body: string; mode: string };

describe('eigensheets preview (golden)', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;
    let mountId: string;
    let rootId: string;
    let body: string;

    beforeAll(async () => {
        ctx = await getTestContext();
        mountId = 'default';
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
        rootId = root.id;

        const sheetsPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            mountId,
            `folder/${rootId}/create/sheets`,
            { fileName: 'golden-preview' },
        );
        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument(mountId, sheetsPath.id);
        seedSheetsDoc(collab.doc, buildGoldenSheets(), buildGoldenOps());

        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/${mountId}/file/${sheetsPath.id}/text-preview`,
        );
        expect(res.status).toBe(200);
        const preview = (await res.json()) as TextPreview;
        expect(preview.mode).toBe('eigensheets');
        body = preview.body;
    });

    test('renders first-sheet content from stored values — formulas stay uncomputed', () => {
        expect(body).toContain('Region 1');
        // The preview read never recalcs (a legacy never-computed workbook costs
        // ~39s, past the 30s deadline), so the fixture's valueless `=SUM(B2:E2)`
        // and `=IF(F2>1500,…)` cells render empty instead of computed.
        expect(body).not.toContain(`>${GOLDEN_ROW1_TOTAL}</td>`);
        expect(body).not.toContain('>low</td>');
        // Edits from the pending-ops array are replayed on top of the snapshot.
        expect(body).toContain(GOLDEN_OPS_EDIT);
        expect(body).toContain(GOLDEN_OPS_PARTIAL_EDIT);
    });

    test('renders conditional formatting, data bars, merges, borders, rotation', () => {
        expect(body).toContain('background:#ffe08a'); // greaterThan rule fired
        expect(body).toContain('color:#7a1f1f');
        expect(body).toContain('background:#638ec6'); // dataBar fill
        expect(body).toContain('background:#d1f0d1'); // cross-sheet formula rule (=Data!A1>10)
        expect(body).toContain('colspan="2"');
        expect(body).toContain('border-left:2px solid #1a5fb4');
        expect(body).toContain('rotate(-45deg)');
    });

    test('renders only the first sheet and appends the truncated marker', () => {
        expect(body).not.toContain(GOLDEN_SHEET2_MARKER);
        expect(body).toContain('Preview truncated');
    });

    test('sanitizes hostile content and blocks non-web link schemes', () => {
        expect(body).not.toMatch(/<script/i);
        expect(body).not.toContain('javascript:alert');
        expect(body).toContain('href="https://example.com/report"');
    });

    test('body matches the pinned golden hash', () => {
        const hash = new Bun.CryptoHasher('sha256').update(body).digest('hex');
        expect(hash).toBe(GOLDEN_BODY_SHA256);
    });
});

describe('eigensheets preview (read policy)', () => {
    test('formula cells without stored values render empty — the preview never recalcs', () => {
        const doc = new Y.Doc();
        seedSheetsDoc(doc, buildGoldenSheets(), []);

        const { body: rendered, warnings } = renderEigensheetsPreviewBody(doc);
        expect(rendered).toContain('Region 1');
        expect(rendered).not.toContain(`>${GOLDEN_ROW1_TOTAL}</td>`);
        expect(warnings).toEqual([]);
        doc.destroy();
    });
});

describe('eigensheets preview (heavy fixture)', () => {
    let ctx: Awaited<ReturnType<typeof getTestContext>>;

    beforeAll(async () => {
        ctx = await getTestContext();
    });

    test('bounds the first-sheet render to the preview budget with a truncated marker', async () => {
        const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, 'default', 'root');
        const sheetsPath = await drivePost<DrivePath>(
            ctx.alice.user.sessionToken,
            ctx.alice.user.id,
            'default',
            `folder/${root.id}/create/sheets`,
            { fileName: 'heavy-preview' },
        );
        const home = await getHome(ctx.alice.user.id);
        const collab = await home.drive.getCollabDocument('default', sheetsPath.id);
        seedSheetsDoc(collab.doc, buildHeavySheets(), buildHeavyOps());

        const res = await authedRequest(
            ctx.alice.user.sessionToken,
            `/drive/${ctx.alice.user.id}/default/file/${sheetsPath.id}/text-preview`,
        );
        expect(res.status).toBe(200);
        const preview = (await res.json()) as TextPreview;
        expect(preview.mode).toBe('eigensheets');

        // Phase 1 budget contract (intentional change from the Phase 0 baseline,
        // which rendered the whole 600×45 grid): at most 200 rows × 50 columns /
        // 10k cells from the top-left, valid HTML, marker appended.
        const { body } = preview;
        expect(body).not.toContain(HEAVY_FAR_CORNER);
        expect(body).toContain('Preview truncated');
        expect(body.match(/<tr/g)!.length).toBeLessThanOrEqual(200);
        expect(body.match(/<col /g)!.length).toBeLessThanOrEqual(50);
        expect(body.match(/<td/g)!.length).toBeLessThanOrEqual(10_000);
        // First-row content still renders from the top-left of the used range.
        expect(body).toContain('>HA</td>');
    }, 120_000);
});

// A document declares merges and conditional-format ranges; the preview renders a
// 200 × 50 window. The work and the emitted markup must follow the window, not the
// declaration — one legal merge or CF range covers millions of cells.
describe('eigensheets preview (declared spans beyond the window)', () => {
    test('a merge reaching past the window clips its emitted span', () => {
        const sheet: Sheet = {
            id: 'merge',
            name: 'Merge',
            celldata: [{ r: 0, c: 0, v: { v: 'merged', m: 'merged', ct: { fa: 'General', t: 'g' } } }],
            config: { merge: { '0_0': { r: 0, c: 0, rs: 5000, cs: 1000 } } },
        };

        const { html, truncated } = renderSheetsPreviewHtml([sheet]);
        expect(truncated).toBe(true);
        expect(html).toContain(`colspan="${PREVIEW_SHEET_BUDGET.maxCols}"`);
        expect(html).toContain(`rowspan="${PREVIEW_SHEET_BUDGET.maxRows}"`);
    });

    test('a conditional-format rule reaching past the window is clipped before evaluation', () => {
        const cell = { v: 5, m: '5', ct: { fa: 'General', t: 'n' } };
        const sheet: Sheet = {
            id: 'cf',
            name: 'CF',
            celldata: [{ r: 0, c: 0, v: cell }],
            data: [[cell]],
            config: {},
            conditionalFormatRules: [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 100_000], column: [0, 0] }],
                    format: { cellColor: '#d1f0d1' },
                    conditionName: 'formula',
                    conditionValue: ['=A1>1'],
                },
            ],
        };

        const evaluate = spyOn(FormulaEngine.prototype, 'evaluate');
        const { html } = renderSheetsPreviewHtml([sheet]);
        const evaluated = evaluate.mock.calls.length;
        evaluate.mockRestore();

        expect(evaluated).toBe(1); // one rendered cell, one evaluation
        expect(html).toContain('background:#d1f0d1');
    });

    test('a formula rule anchored above the window keeps its anchor', () => {
        // Content starts at row 2, the rule's range at row 0 — its anchor. The engine
        // shifts relative refs by target-minus-anchor, so target (2,0) must evaluate
        // =A3>1 (its own row); a clip that moved the range start would re-anchor the
        // rule and evaluate =A1>1 against the empty row 0 instead.
        const cell = { v: 5, m: '5', ct: { fa: 'General', t: 'n' } };
        const sheet: Sheet = {
            id: 'cf-anchor',
            name: 'CFAnchor',
            celldata: [{ r: 2, c: 0, v: cell }],
            data: [undefined as never, undefined as never, [cell]],
            config: {},
            conditionalFormatRules: [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 10], column: [0, 0] }],
                    format: { cellColor: '#d1f0d1' },
                    conditionName: 'formula',
                    conditionValue: ['=A1>1'],
                },
            ],
        };

        const { html } = renderSheetsPreviewHtml([sheet]);
        expect(html).toContain('background:#d1f0d1');
    });

    test('a formula rule whose kept range stays enormous is dropped, not evaluated', () => {
        const cell = { v: 5, m: '5', ct: { fa: 'General', t: 'n' } };
        const data: Sheet['data'] = [];
        data[1_000_000] = [cell];
        const sheet: Sheet = {
            id: 'cf-drop',
            name: 'CFDrop',
            celldata: [{ r: 1_000_000, c: 0, v: cell }],
            data,
            config: {},
            conditionalFormatRules: [
                {
                    type: 'default',
                    cellrange: [{ row: [0, 10_000_000], column: [0, 0] }],
                    format: { cellColor: '#d1f0d1' },
                    conditionName: 'formula',
                    conditionValue: ['=A1>1'],
                },
            ],
        };

        const evaluate = spyOn(FormulaEngine.prototype, 'evaluate');
        const { html } = renderSheetsPreviewHtml([sheet]);
        const evaluated = evaluate.mock.calls.length;
        evaluate.mockRestore();

        expect(evaluated).toBe(0);
        expect(html).toContain('>5</td>');
    });
});

// Recorded from the deterministic golden fixture. Regenerate (and justify) only on
// an intentional renderer or preview-budget change. Last move: the preview read no
// longer recalcs, so the fixture's valueless formula cells render empty (2026-08-04).
const GOLDEN_BODY_SHA256 = '30976a0476b211d6695e14d2506a824cd9f965f8d00572d6b313ff27e49fa410';
