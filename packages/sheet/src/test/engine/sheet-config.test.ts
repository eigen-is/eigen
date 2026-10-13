import { describe, expect, test } from 'bun:test';
import type { Sheet } from '@workspace/lib/sheets';
import { createDefaultSheets } from '../../engine/defaults';
import { replaySheetsOps } from '../../engine/replay-ops';
import { normalizeSheetConfig, SHEET_CONFIG_COLLECTIONS } from '../../engine/sheet-config';

describe('normalizeSheetConfig', () => {
    test('materializes every config collection and the charts map', () => {
        const sheet: Sheet = { id: 's1', name: 'Sheet1' };
        normalizeSheetConfig(sheet);
        for (const key of SHEET_CONFIG_COLLECTIONS) expect(sheet.config?.[key]).toEqual({});
        expect(sheet.charts).toEqual({});
    });

    test('keeps the charts a sheet already has', () => {
        const chart = { id: 'c1', index: 'a0', x: 0, y: 0, width: 400, height: 300, spec: '{}' };
        const sheet: Sheet = { id: 's1', name: 'Sheet1', charts: { c1: chart } };
        normalizeSheetConfig(sheet);
        expect(sheet.charts).toEqual({ c1: chart });
    });

    test('a default workbook and every replayed sheet carry the charts map', () => {
        expect(createDefaultSheets()[0].charts).toEqual({});
        const [base, added] = replaySheetsOps(
            [{ id: 's1', name: 'Sheet1', celldata: [] }],
            [[{ op: 'addSheet', id: 's2', path: [], value: { id: 's2', name: 'Sheet2', celldata: [] } }]],
        );
        expect(base.charts).toEqual({});
        expect(added.charts).toEqual({});
    });
});
