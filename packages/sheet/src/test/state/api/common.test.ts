import { describe, expect, test } from 'bun:test';
import { getSheet } from '../../../state/api/common';
import type { Context } from '../../../state/context';
import { contextFactory } from '../factories/context';

describe('sheet/core/api/common', () => {
    const expectedSheet = {
        id: 'id_2',
        name: 'sheet2',
        data: [[{ v: 'rose' }]],
        celldat: [
            {
                c: 0,
                r: 0,
                v: {
                    v: 'rose',
                },
            },
        ],
    };
    const getContext = () =>
        contextFactory({
            sheets: [
                {
                    id: 'id_1',
                    name: 'sheet1',
                    data: [[]],
                },
                expectedSheet,
            ],
        }) as Context;

    test('getSheet', async () => {
        const ctx = getContext();
        expect(getSheet(ctx, { id: 'id_2' })).toEqual(expectedSheet);
    });
});
