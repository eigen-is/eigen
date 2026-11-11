import { describe, expect, test } from 'bun:test';
import { newChartSpecParts, sampleChartSpec } from '@workspace/lib/charts';
import type { Sheet } from '@workspace/lib/sheets';
import { createDefaultSheets } from '../../engine/defaults';
import { replaySheetsOps } from '../../engine/replay-ops';
import { normalizeSheetConfig, SHEET_CONFIG_COLLECTIONS } from '../../engine/sheet-config';
import type { ExtendedSheetConfig } from '../../engine/types';

describe('normalizeSheetConfig', () => {
    test('materializes every config collection and the charts map', () => {
        const config: ExtendedSheetConfig = {};
        const sheet: Sheet = { id: 's1', name: 'Sheet1', config };
        normalizeSheetConfig(sheet);
        for (const key of SHEET_CONFIG_COLLECTIONS) expect(config[key]).toEqual({});
        expect(sheet.charts).toEqual({});
        expect(sheet.dataValidations).toEqual({});
    });

    test('keeps the well-formed validation rules a sheet has and leaves out the rest', () => {
        const entry = {
            ranges: [{ row: [0, 4], column: [1, 1] }],
            rule: { type: 'dropdown', type2: '', value1: 'a', value2: '' },
        };
        const sheet: Sheet = JSON.parse(
            JSON.stringify({ id: 's1', name: 'Sheet1', dataValidations: { v1: entry, v2: { ranges: [] } } }),
        );
        normalizeSheetConfig(sheet);
        expect(sheet.dataValidations).toEqual({ v1: entry });
    });

    test('keeps the charts a sheet already has', () => {
        const chart = {
            id: 'c1',
            index: 'a0',
            x: 0,
            y: 0,
            width: 400,
            height: 300,
            ...newChartSpecParts(sampleChartSpec('column')),
        };
        const sheet: Sheet = { id: 's1', name: 'Sheet1', charts: { c1: chart } };
        normalizeSheetConfig(sheet);
        expect(sheet.charts).toEqual({ c1: chart });
    });

    test('a forged images or charts value that is no map becomes an empty one', () => {
        const sheet: Sheet = JSON.parse('{"id":"s1","name":"Sheet1","images":"forged","charts":"forged"}');
        normalizeSheetConfig(sheet);
        expect(sheet.images).toEqual({});
        expect(sheet.charts).toEqual({});
    });

    test('a default workbook and every replayed sheet carry the charts map', () => {
        expect(createDefaultSheets()[0].charts).toEqual({});
        const [base, added] = replaySheetsOps(
            [{ id: 's1', name: 'Sheet1', celldata: [] }],
            [[{ op: 'addSheet', id: 's2', path: [], value: { id: 's2', name: 'Sheet2', celldata: [] } }]],
        );
        expect(base.charts).toEqual({});
        expect(added.charts).toEqual({});
        expect(base.dataValidations).toEqual({});
        expect(added.dataValidations).toEqual({});
    });
});
