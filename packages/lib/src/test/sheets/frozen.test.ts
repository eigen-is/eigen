import { describe, expect, test } from 'bun:test';
import { freezesColumns, freezesRows } from '../../sheets';
import type { Sheet } from '../../sheets/types';

const AXES: [NonNullable<Sheet['frozen']>['type'], { rows: boolean; columns: boolean }][] = [
    ['row', { rows: true, columns: false }],
    ['column', { rows: false, columns: true }],
    ['both', { rows: true, columns: true }],
    ['rangeRow', { rows: true, columns: false }],
    ['rangeColumn', { rows: false, columns: true }],
    ['rangeBoth', { rows: true, columns: true }],
];

describe('the axes a frozen pane freezes', () => {
    for (const [type, { rows, columns }] of AXES) {
        test(`'${type}'`, () => {
            expect(freezesRows({ type })).toBe(rows);
            expect(freezesColumns({ type })).toBe(columns);
        });
    }

    test('no frozen pane freezes neither axis', () => {
        expect(freezesRows(undefined)).toBe(false);
        expect(freezesColumns(undefined)).toBe(false);
    });
});
