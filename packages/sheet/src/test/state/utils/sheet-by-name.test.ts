import { describe, expect, test } from 'bun:test';
import { getSheetIdByName } from '../../../state/utils';
import { workbookContextFactory } from '../factories/context';

describe('getSheetIdByName', () => {
    const ctx = workbookContextFactory({
        sheets: [
            { id: 'upper', name: 'Data', order: 0 },
            { id: 'lower', name: 'data', order: 1 },
        ],
    });

    test('in a workbook holding Data and data, each name finds its own sheet, and another case the first', () => {
        expect(['Data', 'data', 'DATA'].map((name) => getSheetIdByName(ctx, name))).toEqual([
            'upper',
            'lower',
            'upper',
        ]);
    });
});
