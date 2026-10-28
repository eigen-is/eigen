import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { DEFAULT_CHART_SERIES_STYLE, newSheetChartSpecParts, sampleChartSpec } from '@workspace/lib/charts';
import type { Sheet } from '@workspace/lib/sheets';
import { SHEET_DEFAULT_COL_WIDTH, SHEET_DEFAULT_ROW_HEIGHT } from '@workspace/lib/sheets';
import type { DrivePath } from '@workspace/lib/types/drive';
import { FormulaEngine } from '@workspace/sheet/engine';
import * as Y from 'yjs';
import { PREVIEW_SHEET_BUDGET, renderSheetsHtml, renderSheetsPreviewHtml } from '../../lib/export/sheets/render';
import { getHome } from '../../lib/home/get-home';
import { renderEigensheetsPreviewBody } from '../../lib/preview/eigensheets-render';
import { cpuClock } from '../cpu-time';
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
import { authedRequest, driveGet, drivePost, getTestContext, NO_MEDIA, NO_PIXELS } from '../setup';

// Golden output assertions for the eigensheets preview pipeline. The hash at
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
        expect(body).not.toContain(`>${GOLDEN_ROW1_TOTAL}</div></div></td>`);
        expect(body).not.toContain('>low</div></div></td>');
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

        const { body: rendered, warnings } = renderEigensheetsPreviewBody(doc, NO_MEDIA);
        expect(rendered).toContain('Region 1');
        expect(rendered).not.toContain(`>${GOLDEN_ROW1_TOTAL}</div></div></td>`);
        expect(warnings).toEqual([]);
        doc.destroy();
    });

    // A cell background is escapeHtml'd into the style attribute, so a CRDT string like
    // `red;background-image:url(http://…)` reaches the preview intact. The body renders as
    // live DOM in the drive hero, so the shared sanitizer must neutralize the url() — else
    // every viewer fires the beacon.
    test('a hostile cell background cannot beacon a viewer', () => {
        const cell = {
            v: 'Beacon',
            m: 'Beacon',
            ct: { fa: 'General', t: 'g' },
            bg: 'red;background-image:url(http://evil.example/x)',
        };
        const sheet: Sheet = {
            id: 'beacon',
            name: 'Beacon',
            celldata: [{ r: 0, c: 0, v: cell }],
            data: [[cell]],
            config: {},
        };
        const doc = new Y.Doc();
        seedSheetsDoc(doc, [sheet], []);

        const { body } = renderEigensheetsPreviewBody(doc, NO_MEDIA);
        expect(body).toContain('Beacon');
        expect(body).not.toContain('http://evil.example');
        expect(body).not.toMatch(/url\(http/i);
        doc.destroy();
    });
});

// Floating images are a media reference: the main thread resolves the name to a
// /file/<id>/preview URL, and the preview body embeds it. A separate fixture — the golden
// one above pins bytes that must not move for this.
describe('eigensheets preview (floating images)', () => {
    const IMAGE_URL = 'http://api.test/drive/owner/default/file/media-1/preview';

    function seedImageSheet(x = 90): Y.Doc {
        const cell = { v: 'Grid', m: 'Grid', ct: { fa: 'General', t: 'g' } };
        const sheet: Sheet = {
            id: 'images',
            name: 'Images',
            celldata: [{ r: 0, c: 0, v: cell }],
            data: [[cell]],
            config: {},
            images: { img_1: { id: 'img_1', index: 'a0', mediaName: 'chart.png', x, y: 30, width: 160, height: 120 } },
        };
        const doc = new Y.Doc();
        seedSheetsDoc(doc, [sheet], []);
        return doc;
    }

    test('the image reaches the body at its stored geometry', () => {
        const doc = seedImageSheet();
        const { body } = renderEigensheetsPreviewBody(doc, new Map([['chart.png', IMAGE_URL]]));
        expect(body).toContain(`src="${IMAGE_URL}"`);
        expect(body).toContain('left:90px;top:30px;width:160px;height:120px');
        doc.destroy();
    });

    // The overlay draws from the used range's origin, so an image anchored deeper in the
    // grid keeps its cell only if the preview subtracts exactly what the export subtracts.
    // The quick look renders this fragment at 1:1 in app CSS, where the grid under the
    // overlay must keep the declared pitch (packages/ui globals.css, .eigensheets-preview).
    test('an image past the used range origin gets the export geometry', () => {
        // Used range starts at C5, the image at E7 — both in default grid pixels.
        const cell = { v: 'C5', m: 'C5', ct: { fa: 'General', t: 'g' } };
        const sheet: Sheet = {
            id: 'offset',
            name: 'Offset',
            celldata: [{ r: 4, c: 2, v: cell }],
            config: {},
            images: {
                img_1: {
                    id: 'img_1',
                    index: 'a0',
                    mediaName: 'chart.png',
                    x: 4 * SHEET_DEFAULT_COL_WIDTH,
                    y: 6 * SHEET_DEFAULT_ROW_HEIGHT,
                    width: 160,
                    height: 120,
                },
            },
        };
        const media = new Map([['chart.png', IMAGE_URL]]);
        // The C5 origin takes two columns and four rows off the stored geometry.
        const geometry = `position:absolute;left:${2 * SHEET_DEFAULT_COL_WIDTH}px;top:${2 * SHEET_DEFAULT_ROW_HEIGHT}px;width:160px;height:120px`;

        const doc = new Y.Doc();
        seedSheetsDoc(doc, [sheet], []);
        expect(renderEigensheetsPreviewBody(doc, media).body).toContain(`style="${geometry}"`);
        // The full export interns the very same declaration into its stylesheet.
        expect(renderSheetsHtml([sheet], media, 'screen', NO_PIXELS).css).toContain(`{${geometry}}`);
        doc.destroy();
    });

    test('an image anchored above the used range reaches the body', () => {
        const cell = { v: 'C5', m: 'C5', ct: { fa: 'General', t: 'g' } };
        const sheet: Sheet = {
            id: 'above',
            name: 'Above',
            celldata: [{ r: 4, c: 2, v: cell }],
            config: {},
            images: { img_1: { id: 'img_1', index: 'a0', mediaName: 'chart.png', x: 0, y: 0, width: 160, height: 60 } },
        };
        const doc = new Y.Doc();
        seedSheetsDoc(doc, [sheet], []);
        const { body } = renderEigensheetsPreviewBody(doc, new Map([['chart.png', IMAGE_URL]]));
        expect(body).toContain('left:0px;top:0px;width:160px;height:60px');
        doc.destroy();
    });

    // Past the budget window's own right edge, not merely past the one-cell grid: the
    // overlay would stretch the fragment's scroll width and collapse the thumbnail.
    test('an image parked far outside the budget window stays out of the body', () => {
        const doc = seedImageSheet(20_000);
        const { body } = renderEigensheetsPreviewBody(doc, new Map([['chart.png', IMAGE_URL]]));
        expect(body).toContain('Grid');
        expect(body).not.toContain('<img');
        doc.destroy();
    });

    // A sheet with nothing but an image takes the blank-grid branch, which renders its own overlay.
    function seedImageOnlySheet(x: number): Y.Doc {
        const sheet: Sheet = {
            id: 'image',
            name: 'Image',
            celldata: [],
            data: [],
            config: {},
            images: { img_1: { id: 'img_1', index: 'a0', mediaName: 'chart.png', x, y: 30, width: 160, height: 120 } },
        };
        const doc = new Y.Doc();
        seedSheetsDoc(doc, [sheet], []);
        return doc;
    }

    test('an image-only sheet clips its overlay to the budget window as well', () => {
        const far = seedImageOnlySheet(20_000);
        expect(renderEigensheetsPreviewBody(far, new Map([['chart.png', IMAGE_URL]])).body).not.toContain('<img');
        far.destroy();

        const origin = seedImageOnlySheet(0);
        expect(renderEigensheetsPreviewBody(origin, new Map([['chart.png', IMAGE_URL]])).body).toContain(
            `src="${IMAGE_URL}"`,
        );
        origin.destroy();
    });

    // The budget counts shown columns, so its box spans 50 of them. With B to K hidden, an image 4,500 px from A1 sits over
    // the 46th shown column, beside a one-cell sheet or over one that renders.
    test.each([
        ['beside a one-cell sheet', [0]],
        ['over a rendered column', [0, 59]],
    ])('the budget box skips hidden columns: an image %s is drawn', (_, columns) => {
        const cell = { v: 'Grid', m: 'Grid', ct: { fa: 'General', t: 'g' } };
        const sheet: Sheet = {
            id: 'hidden',
            name: 'Hidden',
            celldata: columns.map((c) => ({ r: 0, c, v: cell })),
            config: { colhidden: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [i + 1, 0])) },
            images: {
                img_1: { id: 'img_1', index: 'a0', mediaName: 'chart.png', x: 4500, y: 0, width: 50, height: 20 },
            },
        };
        const { html } = renderSheetsPreviewHtml([sheet], new Map([['chart.png', IMAGE_URL]]));
        expect(html).toContain(`src="${IMAGE_URL}"`);
    });

    test('a name the main thread could not resolve renders no img at all', () => {
        const doc = seedImageSheet();
        const { body } = renderEigensheetsPreviewBody(doc, NO_MEDIA);
        expect(body).toContain('Grid');
        expect(body).not.toContain('<img');
        doc.destroy();
    });
});

// A chart draws from the stored values: the preview never recalcs, so a formula cell without one is a gap.
describe('eigensheets preview (charts)', () => {
    test("the chart reaches the body as SVG with its cells' labels and values", () => {
        const cell = (v: string | number) => ({
            v,
            m: String(v),
            ct: { fa: 'General', t: typeof v === 'number' ? 'n' : 'g' },
        });
        const ref = (row: [number, number], column: [number, number]) => ({ sheetId: 'data', row, column });
        const sheet: Sheet = {
            id: 'data',
            name: 'Data',
            celldata: [
                { r: 0, c: 0, v: cell('Team') },
                { r: 0, c: 1, v: cell('Points') },
                { r: 1, c: 0, v: cell('Ajax') },
                { r: 1, c: 1, v: cell(42) },
                { r: 2, c: 0, v: cell('PSV') },
                { r: 2, c: 1, v: { f: '=B2*2' } },
            ],
            config: {},
            charts: {
                c1: {
                    id: 'c1',
                    index: 'a0',
                    x: 200,
                    y: 0,
                    width: 400,
                    height: 300,
                    ...newSheetChartSpecParts({
                        ...sampleChartSpec('column'),
                        title: { text: 'Scores' },
                        series: { 's-1': { ...DEFAULT_CHART_SERIES_STYLE, color: '#2a78d6' } },
                        data: {
                            source: 'range',
                            categories: ref([1, 2], [0, 0]),
                            series: [
                                {
                                    id: 's-1',
                                    name: ref([0, 0], [1, 1]),
                                    values: ref([1, 2], [1, 1]),
                                },
                            ],
                        },
                    }),
                },
            },
        };
        const doc = new Y.Doc();
        seedSheetsDoc(doc, [sheet], []);
        const { body } = renderEigensheetsPreviewBody(doc, NO_MEDIA);
        const svg = body.slice(body.indexOf('<svg'), body.indexOf('</svg>'));
        expect(body).toContain('left:200px;top:0px;width:400px;height:300px');
        for (const label of ['>Scores<', '>Ajax<', '>PSV<', '>Points<']) expect(svg).toContain(label);
        // PSV's formula has no stored value and the preview computes none, so the axis stops near Ajax's 42.
        expect(svg).toContain('>40<');
        expect(svg).not.toContain('>80<');
        doc.destroy();
    });

    // The truncated notice follows the overlay's box in the flow, so the box reaches the lowest chart, cut at
    // the budget window, whose edge clips a chart that crosses it.
    const chartBelow = (y: number): Sheet => ({
        id: 'below',
        name: 'Below',
        celldata: [{ r: 0, c: 0, v: { v: 'Grid', m: 'Grid', ct: { fa: 'General', t: 'g' } } }],
        config: {},
        charts: {
            c1: {
                id: 'c1',
                index: 'a0',
                x: 0,
                y,
                width: 400,
                height: 300,
                ...newSheetChartSpecParts(sampleChartSpec('column')),
            },
        },
    });

    test('the overlay box is as tall as the chart below the table, so the truncated notice starts under it', () => {
        const { html, truncated } = renderSheetsPreviewHtml([chartBelow(40), chartBelow(40)], NO_MEDIA);
        expect(truncated).toBe(true);
        expect(html).toContain('position:relative;width:400px;min-height:340px;overflow:hidden');
    });

    test('a chart crossing the budget window is clipped at its edge', () => {
        const bottom = PREVIEW_SHEET_BUDGET.maxRows * SHEET_DEFAULT_ROW_HEIGHT;
        const { html } = renderSheetsPreviewHtml([chartBelow(bottom - 100)], NO_MEDIA);
        expect(html).toContain(`min-height:${bottom}px;overflow:hidden`);
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

        // Budget contract: at most 200 rows × 50 columns / 10k cells from the top-left,
        // valid HTML, marker appended.
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

        const { html, truncated } = renderSheetsPreviewHtml([sheet], NO_MEDIA);
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

        const evaluate = spyOn(FormulaEngine.prototype, 'evaluateCompiled');
        const { html } = renderSheetsPreviewHtml([sheet], NO_MEDIA);
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

        const { html } = renderSheetsPreviewHtml([sheet], NO_MEDIA);
        expect(html).toContain('background:#d1f0d1');
    });

    test('a formula rule anchored far above the window evaluates only the rendered cell', () => {
        const cell = { v: 5, m: '5', ct: { fa: 'General', t: 'n' } };
        const data: Sheet['data'] = [];
        data[1_000_000] = [cell];
        const sheet: Sheet = {
            id: 'cf-far',
            name: 'CFFar',
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

        const evaluate = spyOn(FormulaEngine.prototype, 'evaluateCompiled');
        const { html } = renderSheetsPreviewHtml([sheet], NO_MEDIA);
        const evaluated = evaluate.mock.calls.length;
        evaluate.mockRestore();

        expect(evaluated).toBe(1);
        expect(html).toContain('background:#d1f0d1');
    });

    test('a formula rule whose first range lies past the window still reads from that range', () => {
        const cell = { v: 5, m: '5', ct: { fa: 'General', t: 'n' } };
        const sheet: Sheet = {
            id: 'cf-first-out',
            name: 'CFFirstOut',
            celldata: [{ r: 0, c: 0, v: cell }],
            data: [[cell]],
            config: {},
            conditionalFormatRules: [
                {
                    type: 'default',
                    cellrange: [
                        { row: [299, 310], column: [0, 0] },
                        { row: [0, 2], column: [0, 0] },
                    ],
                    format: { cellColor: '#d1f0d1' },
                    conditionName: 'formula',
                    conditionValue: ['=A300>1'],
                },
            ],
        };

        const { html } = renderSheetsPreviewHtml([sheet], NO_MEDIA);
        expect(html).toContain('background:#d1f0d1');
    });

    test('a key far above the grid costs the preview its own window, with no walk over the rows it names', () => {
        const sheet: Sheet = {
            id: 'far',
            name: 'Far',
            celldata: [{ r: 0, c: 0, v: { v: 'a', m: 'a' } }],
            config: { rowhidden: { 3: 0 }, borderInfo: { '-10000000_0': { b: { style: 1, color: '#000' } } } },
        };
        const cpuMs = cpuClock();
        const { html, truncated } = renderSheetsPreviewHtml([sheet], NO_MEDIA);
        expect(cpuMs()).toBeLessThan(500);
        expect(truncated).toBe(false);
        expect(html).toContain('>a<');
        expect(html.match(/<tr /g)).toHaveLength(1);
    });
});

describe('eigensheets export and preview (hidden sheets)', () => {
    // The tabs a reader sees are the sheets an export prints, as Excel prints them.
    test('a hidden sheet renders in neither the export nor the preview', () => {
        const sheetOf = (id: string, text: string, hide?: number): Sheet => {
            const cell = { v: text, m: text, ct: { fa: 'General', t: 's' } };
            return { id, name: id, ...(hide && { hide }), celldata: [{ r: 0, c: 0, v: cell }], data: [[cell]] };
        };
        const sheets = [sheetOf('First', 'secret', 1), sheetOf('Second', 'shown'), sheetOf('Third', 'unseen', 1)];
        const { html } = renderSheetsHtml(sheets, NO_MEDIA, 'screen', NO_PIXELS);
        expect(html).toContain('shown');
        expect(html).not.toContain('secret');
        expect(html).not.toContain('unseen');
        const preview = renderSheetsPreviewHtml(sheets, NO_MEDIA);
        expect(preview.html).toContain('shown');
        expect(preview.html).not.toContain('secret');
        expect(preview.truncated).toBe(false);
    });
});

// Recorded from the deterministic golden fixture. Regenerate (and justify) only on
// an intentional renderer or preview-budget change. Last move: only a cell whose
// text can pass its rows is clipped to them (2026-10-27).
const GOLDEN_BODY_SHA256 = '22d84e290caeffe8920970fb650928580cc22e08175f49f604ed7f420b10c63f';
