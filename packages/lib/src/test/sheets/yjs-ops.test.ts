import { describe, expect, test } from 'bun:test';
import type { Op, Sheet } from '../../sheets/types';
import { opToPatchOnSheets } from '../../sheets/yjs-ops';

const SHEETS: Sheet[] = [
    { id: 'sheet-1', name: 'Sheet1', order: 0, celldata: [], config: {} },
    { id: 'sheet-2', name: 'Sheet2', order: 1, celldata: [], config: {} },
];

describe('opToPatchOnSheets', () => {
    test('replace op on existing sheet → patch with [i, ...path]', () => {
        const ops: Op[] = [{ op: 'replace', id: 'sheet-2', path: ['celldata', 0, 'v'], value: 42 }];
        const [patches, special] = opToPatchOnSheets(SHEETS, ops);
        expect(patches).toEqual([{ op: 'replace', value: 42, path: [1, 'celldata', 0, 'v'] }]);
        expect(special).toEqual([]);
    });

    test('orphan op (sheet id not in array) → dropped', () => {
        const ops: Op[] = [{ op: 'replace', id: 'sheet-missing', path: ['celldata', 0], value: 99 }];
        const [patches, special] = opToPatchOnSheets(SHEETS, ops);
        expect(patches).toEqual([]);
        expect(special).toEqual([]);
    });

    test('op with no id → dropped (no Sheet[]-rooted mapping)', () => {
        // The wholesale ['sheets'] replace patch that immer emits when
        // the sheet reducer reassigns ctx.sheets (row/col ops)
        // would otherwise produce a Sheet[]-rooted patch with a non-numeric
        // key, throwing immer error 14 in applyPatches.
        const ops: Op[] = [
            { op: 'replace', path: ['sheets'], value: SHEETS },
            { op: 'add', path: ['something'], value: 1 },
        ];
        const [patches] = opToPatchOnSheets(SHEETS, ops);
        expect(patches).toEqual([]);
    });

    test('special ops are partitioned out', () => {
        const ops: Op[] = [
            { op: 'replace', id: 'sheet-1', path: ['name'], value: 'Renamed' },
            { op: 'addSheet', path: [], value: { id: 'sheet-3', name: 'Sheet3' } },
            { op: 'deleteSheet', path: [], value: { id: 'sheet-2' } },
        ];
        const [patches, special] = opToPatchOnSheets(SHEETS, ops);
        expect(patches).toEqual([{ op: 'replace', value: 'Renamed', path: [0, 'name'] }]);
        expect(special).toHaveLength(2);
        expect(special[0].op).toBe('addSheet');
        expect(special[1].op).toBe('deleteSheet');
    });
});
