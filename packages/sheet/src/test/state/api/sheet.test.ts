import { describe, expect, test } from 'bun:test';
import { getCellValue } from '../../../state/api/cell';
import { calculateFormula, getAllSheets } from '../../../state/api/sheet';
import type { Context } from '../../../state/context';
import { contextFactory, selectionFactory } from '../factories/context';

describe('sheet/core/api/sheet', () => {
    const getContext = () =>
        contextFactory({
            selections: selectionFactory([0, 0], [0, 0], 0, 0),
        }) as Context;
    test('getAllSheets', () => {
        const ctx = getContext();
        expect(getAllSheets(ctx).length).toBe(2);
        expect(getAllSheets(ctx)).toMatchObject([{ id: 'id_1' }, { id: 'id_2' }]);
    });

    test('calculateFormula works before currentSheetId is initialized', () => {
        const ctx = contextFactory({
            currentSheetId: '',
            sheets: [
                {
                    name: 'Sheet1',
                    id: 'id_1',
                    order: 0,
                    data: [
                        [
                            { v: 10, ct: { t: 'n', fa: 'General' } },
                            { f: '=A1+A2', ct: { t: 'n', fa: 'General' } },
                        ],
                        [{ v: 5, ct: { t: 'n', fa: 'General' } }, null],
                    ],
                },
            ],
        }) as Context;

        expect(() => calculateFormula(ctx)).not.toThrow();
        expect(getCellValue(ctx, 0, 1, { id: 'id_1', type: 'v' })).toBe(15);
    });

    test("calculateFormula without id writes each sheet's result to its own sheet", () => {
        const ctx = contextFactory({
            currentSheetId: 'id_1',
            sheets: [
                {
                    name: 'Sheet1',
                    id: 'id_1',
                    order: 0,
                    data: [
                        [
                            { v: 10, ct: { t: 'n', fa: 'General' } },
                            { f: '=A1+A2', ct: { t: 'n', fa: 'General' } },
                        ],
                        [{ v: 5, ct: { t: 'n', fa: 'General' } }, null],
                    ],
                },
                {
                    name: 'Sheet2',
                    id: 'id_2',
                    order: 1,
                    data: [
                        [
                            { v: 20, ct: { t: 'n', fa: 'General' } },
                            { f: '=A1+A2', ct: { t: 'n', fa: 'General' } },
                        ],
                        [{ v: 7, ct: { t: 'n', fa: 'General' } }, null],
                    ],
                },
            ],
        }) as Context;

        calculateFormula(ctx);

        expect(getCellValue(ctx, 0, 1, { id: 'id_1', type: 'v' })).toBe(15);
        expect(getCellValue(ctx, 0, 1, { id: 'id_2', type: 'v' })).toBe(27);
    });
});
