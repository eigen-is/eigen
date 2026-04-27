import { describe, expect, test } from 'bun:test';
import type { Sheet } from '@workspace/lib/sheets';
import ExcelJS from 'exceljs';
import { sheetsToXlsx } from '../lib/export/sheets/xlsx';

async function exportAndReload(sheets: Sheet[]): Promise<ExcelJS.Workbook> {
    const buffer = await sheetsToXlsx(sheets);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    return wb;
}

describe('Sheets xlsx export', () => {
    test('writes textRotation in degrees', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [
                    { r: 0, c: 0, v: { v: '45-up', rt: 45 } },
                    { r: 1, c: 0, v: { v: '90-up', rt: 90 } },
                    { r: 2, c: 0, v: { v: '45-down', rt: 135 } },
                    { r: 3, c: 0, v: { v: '90-down', rt: 180 } },
                    { r: 4, c: 0, v: { v: 'vertical', tr: '3' } },
                ],
            },
        ];
        const wb = await exportAndReload(sheets);
        const ws = wb.getWorksheet('Sheet1');
        if (!ws) throw new Error('Sheet1 missing');
        expect(ws.getCell('A1').alignment?.textRotation).toBe(45);
        expect(ws.getCell('A2').alignment?.textRotation).toBe(90);
        expect(ws.getCell('A3').alignment?.textRotation).toBe(-45);
        expect(ws.getCell('A4').alignment?.textRotation).toBe(-90);
        expect(ws.getCell('A5').alignment?.textRotation).toBe('vertical');
    });

    test('derives textRotation from menu preset (tr) when rt is absent', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [
                    { r: 0, c: 0, v: { v: 'angleup', tr: '1' } },
                    { r: 1, c: 0, v: { v: 'angledown', tr: '2' } },
                    { r: 2, c: 0, v: { v: 'rotation-up', tr: '4' } },
                    { r: 3, c: 0, v: { v: 'rotation-down', tr: '5' } },
                ],
            },
        ];
        const wb = await exportAndReload(sheets);
        const ws = wb.getWorksheet('Sheet1');
        if (!ws) throw new Error('Sheet1 missing');
        expect(ws.getCell('A1').alignment?.textRotation).toBe(45);
        expect(ws.getCell('A2').alignment?.textRotation).toBe(-45);
        expect(ws.getCell('A3').alignment?.textRotation).toBe(90);
        expect(ws.getCell('A4').alignment?.textRotation).toBe(-90);
    });

    test('rt=0 and tr="0" produce no textRotation', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [
                    { r: 0, c: 0, v: { v: 'rt-zero', rt: 0 } },
                    { r: 1, c: 0, v: { v: 'tr-none', tr: '0' } },
                    { r: 2, c: 0, v: { v: 'plain' } },
                ],
            },
        ];
        const wb = await exportAndReload(sheets);
        const ws = wb.getWorksheet('Sheet1');
        if (!ws) throw new Error('Sheet1 missing');
        expect(ws.getCell('A1').alignment?.textRotation).toBeUndefined();
        expect(ws.getCell('A2').alignment?.textRotation).toBeUndefined();
        expect(ws.getCell('A3').alignment?.textRotation).toBeUndefined();
    });

    test('writes font.name when ff is a string', async () => {
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [
                    { r: 0, c: 0, v: { v: 'georgia', ff: 'Georgia' } },
                    { r: 1, c: 0, v: { v: 'spaced', ff: 'Times New Roman' } },
                ],
            },
        ];
        const wb = await exportAndReload(sheets);
        const ws = wb.getWorksheet('Sheet1');
        if (!ws) throw new Error('Sheet1 missing');
        expect(ws.getCell('A1').font?.name).toBe('Georgia');
        expect(ws.getCell('A2').font?.name).toBe('Times New Roman');
    });

    test('round-trip preserves rotation and font family through export → reload', async () => {
        // Confirms rt 91-180 (downward) survives the conversion to negative textRotation
        // and back, since this is the most error-prone direction.
        const sheets: Sheet[] = [
            {
                name: 'Sheet1',
                celldata: [{ r: 0, c: 0, v: { v: 'down', rt: 135, ff: 'Verdana' } }],
            },
        ];
        const wb = await exportAndReload(sheets);
        const ws = wb.getWorksheet('Sheet1');
        if (!ws) throw new Error('Sheet1 missing');
        const cell = ws.getCell('A1');
        expect(cell.alignment?.textRotation).toBe(-45);
        expect(cell.font?.name).toBe('Verdana');
    });
});
