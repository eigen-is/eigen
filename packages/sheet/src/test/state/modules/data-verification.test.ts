// Data-validation runtime paths the xlsx importer relies on. The dominant
// imported shape is a dropdown whose value1 is a live quoted cross-sheet
// $-anchored range ref ('MASTER DATA'!$B$2:$B$4) — getDropdownList must keep
// resolving it by sheet NAME. Date rules carry YYYY-MM-DD operand strings,
// the format validateCellData parses via isdatetime + dayjs.

import { describe, expect, test } from 'bun:test';
import type { Context } from '../../../state/context';
import { getDropdownList, validateCellData } from '../../../state/modules/data-verification';
import type { DataVerificationRule } from '../../../state/types';
import { contextFactory } from '../factories/context';

describe('getDropdownList', () => {
    test('resolves a quoted cross-sheet $-anchored range ref by sheet name', () => {
        const ctx = contextFactory() as Context;
        ctx.sheets[1].name = 'MASTER DATA';
        ctx.sheets[1].data = [
            [null, null, null, null],
            [null, { v: 'Alpha', m: 'Alpha' }, null, null],
            [null, { v: 'Beta', m: 'Beta' }, null, null],
            [null, { v: 'Beta', m: 'Beta' }, null, null],
        ];
        expect(getDropdownList(ctx, "'MASTER DATA'!$B$2:$B$4")).toEqual(['Alpha', 'Beta']);
    });

    test('splits a comma literal into options', () => {
        const ctx = contextFactory() as Context;
        expect(getDropdownList(ctx, 'Red,Green,Blue')).toEqual(['Red', 'Green', 'Blue']);
    });
});

describe('validateCellData', () => {
    test('parses the importer date operand format (YYYY-MM-DD)', () => {
        const ctx = contextFactory() as Context;
        const rule: DataVerificationRule = {
            type: 'date',
            type2: 'between',
            value1: '2024-01-01',
            value2: '2024-12-31',
        };
        expect(validateCellData(ctx, rule, '2024-06-15')).toBe(true);
        expect(validateCellData(ctx, rule, '2025-06-15')).toBe(false);
    });
});
