import { beforeAll, describe, expect, test } from 'bun:test';
import type { DrivePath } from '@workspace/lib/types/drive';
import { EXPORT_CSP } from '../../lib/export/sanitize';
import { isWeasyPrintAvailable } from '../../lib/export/weasyprint';
import { getHome } from '../../lib/home/get-home';
import { xlsxToSheets } from '../../lib/import/sheets/from-xlsx';
import { buildGoldenOps, buildGoldenSheets, GOLDEN_ROW1_TOTAL, seedSheetsDoc } from '../fixtures/heavy-sheets';
import { authedRequest, driveGet, drivePost, getTestContext } from '../setup';

// Response contract of GET /drive/:ownerId/:mountId/file/:pathId/export/:format for
// eigensheets: content types, filenames, Content-Disposition, and error statuses.
// Pinned here so moving the transforms into the document-transform Worker cannot
// change what the route hands back.

const mountId = 'default';
let ctx: Awaited<ReturnType<typeof getTestContext>>;
let sheetsPath: DrivePath;

beforeAll(async () => {
    ctx = await getTestContext();
    const root = await driveGet<DrivePath>(ctx.alice.user.sessionToken, ctx.alice.user.id, mountId, 'root');
    sheetsPath = await drivePost<DrivePath>(
        ctx.alice.user.sessionToken,
        ctx.alice.user.id,
        mountId,
        `folder/${root.id}/create/sheets`,
        { fileName: 'Export Contract' },
    );
    const home = await getHome(ctx.alice.user.id);
    const collab = await home.drive.getCollabDocument(mountId, sheetsPath.id);
    seedSheetsDoc(collab.doc, buildGoldenSheets(), buildGoldenOps());
});

function exportRequest(format: string) {
    return authedRequest(
        ctx.alice.user.sessionToken,
        `/drive/${ctx.alice.user.id}/${mountId}/file/${sheetsPath.id}/export/${format}`,
    );
}

describe('Sheets export route — response contract', () => {
    test('html export serves a standalone document as an attachment', async () => {
        const res = await exportRequest('html');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
        expect(res.headers.get('content-disposition')).toBe('attachment; filename="Export Contract.html"');
        expect(res.headers.get('content-security-policy')).toBe(EXPORT_CSP);

        const html = await res.text();
        expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
        expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${EXPORT_CSP}">`);
        expect(html).toContain('<title>Export Contract</title>');
        // Full workbook, not the budgeted preview: every sheet renders, computed
        // formulas included, and hostile fixture content stays sanitized.
        expect(html).toContain('Region 1');
        expect(html).toContain(`>${GOLDEN_ROW1_TOTAL}</div></div></td>`);
        expect(html).toContain('SHEET2-ONLY-CONTENT');
        expect(html).not.toMatch(/<script/i);
    }, 60_000);

    test('xlsx export serves a workbook with the spreadsheet content type', async () => {
        const res = await exportRequest('xlsx');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe(
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        );
        expect(res.headers.get('content-disposition')).toBe('attachment; filename="Export Contract.xlsx"');

        const buffer = Buffer.from(await res.arrayBuffer());
        expect(buffer.subarray(0, 2).toString()).toBe('PK');
        const sheets = xlsxToSheets(buffer);
        expect(sheets.map((sheet) => sheet.name)).toEqual(['Dashboard', 'Data', 'Empty']);
        const cell = (r: number, c: number) => sheets[0].celldata?.find((entry) => entry.r === r && entry.c === c)?.v;
        expect(cell(1, 0)?.v).toBe('Region 1');
        expect(cell(1, 1)?.v).toBe(48);
        // The server-side recalc ran before the workbook was built.
        expect(cell(1, 5)).toMatchObject({ f: '=SUM(B2:E2)', v: GOLDEN_ROW1_TOTAL });
    }, 60_000);

    test('an unsupported format is rejected with 400', async () => {
        const res = await exportRequest('docx');
        expect(res.status).toBe(400);
        expect(await res.text()).toContain('not supported');
    }, 60_000);
});

const suite = (await isWeasyPrintAvailable()) ? describe : describe.skip;

suite('Sheets export route — PDF (WeasyPrint end-to-end)', () => {
    test('pdf export serves a rendered PDF as an attachment', async () => {
        const res = await exportRequest('pdf');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/pdf');
        expect(res.headers.get('content-disposition')).toBe('attachment; filename="Export Contract.pdf"');
        const pdf = Buffer.from(await res.arrayBuffer());
        expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    }, 120_000);
});
