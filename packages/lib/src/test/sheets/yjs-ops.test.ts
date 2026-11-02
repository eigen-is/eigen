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

    // A tab still open on the build before images became a map writes the whole array; no per-image write could
    // resolve on it, so it is ignored as the decoder ignores a stored one.
    test("an older tab's whole images array is dropped, a map passes", () => {
        const images = { img1: { id: 'img1', index: 'a0', mediaName: 'a.png', x: 0, y: 0, width: 10, height: 10 } };
        const ops: Op[] = [
            { op: 'replace', id: 'sheet-1', path: ['images'], value: [images.img1] },
            { op: 'replace', id: 'sheet-1', path: ['images'], value: images },
        ];
        const [patches] = opToPatchOnSheets(SHEETS, ops);
        expect(patches).toEqual([{ op: 'replace', value: images, path: [0, 'images'] }]);
    });

    // A peer can store anything under an id, and every reader walks an entry's ranges, so a write that would leave an
    // entry not well formed never applies.
    test('a validation write applies only when it leaves every entry well formed', () => {
        const entry = {
            ranges: [{ row: [0, 9], column: [1, 1] }],
            rule: { type: 'dropdown', type2: '', value1: 'a', value2: '' },
        };
        const ops: Op[] = [
            { op: 'add', id: 'sheet-1', path: ['dataValidations', 'v1'], value: entry },
            { op: 'remove', id: 'sheet-1', path: ['dataValidations', 'v1'] },
            { op: 'replace', id: 'sheet-1', path: ['dataValidations'], value: { v1: entry } },
            { op: 'add', id: 'sheet-1', path: ['dataValidations', 'v2'], value: { ...entry, ranges: 'A1' } },
            { op: 'replace', id: 'sheet-1', path: ['dataValidations'], value: { v1: entry, v2: {} } },
            { op: 'remove', id: 'sheet-1', path: ['dataValidations'] },
            { op: 'replace', id: 'sheet-1', path: ['dataValidations', 'v1', 'ranges'], value: [] },
        ];
        const [patches] = opToPatchOnSheets(SHEETS, ops);
        expect(patches).toEqual([
            { op: 'add', value: entry, path: [0, 'dataValidations', 'v1'] },
            { op: 'remove', value: undefined, path: [0, 'dataValidations', 'v1'] },
            { op: 'replace', value: { v1: entry }, path: [0, 'dataValidations'] },
        ]);
    });

    // A whole-entry write over a rule a peer deleted would bring the rule back. Immer writes `add` for an id its base
    // lacked, so a `replace` means the writer saw the rule, and where it is gone the delete wins.
    test('a whole-entry replace of a rule the sheet no longer holds is dropped', () => {
        const entry = {
            ranges: [{ row: [0, 9], column: [1, 1] }],
            rule: { type: 'dropdown', type2: '', value1: 'a', value2: '' },
        };
        const sheets: Sheet[] = [{ ...SHEETS[0], dataValidations: { x: entry } }];
        const ops: Op[] = [
            { op: 'replace', id: 'sheet-1', path: ['dataValidations', 'gone'], value: entry },
            { op: 'replace', id: 'sheet-1', path: ['dataValidations', 'x'], value: entry },
            { op: 'remove', id: 'sheet-1', path: ['dataValidations', 'x'] },
            { op: 'replace', id: 'sheet-1', path: ['dataValidations', 'x'], value: entry },
            { op: 'add', id: 'sheet-1', path: ['dataValidations', 'y'], value: entry },
            { op: 'replace', id: 'sheet-1', path: ['dataValidations', 'y'], value: entry },
            { op: 'replace', id: 'sheet-1', path: ['dataValidations'], value: { z: entry } },
            { op: 'replace', id: 'sheet-1', path: ['dataValidations', 'y'], value: entry },
            { op: 'replace', id: 'sheet-1', path: ['dataValidations', 'z'], value: entry },
        ];
        const [patches] = opToPatchOnSheets(sheets, ops);
        expect(patches.map(({ op, path }) => [op, ...path])).toEqual([
            ['replace', 0, 'dataValidations', 'x'],
            ['remove', 0, 'dataValidations', 'x'],
            ['add', 0, 'dataValidations', 'y'],
            ['replace', 0, 'dataValidations', 'y'],
            ['replace', 0, 'dataValidations'],
            ['replace', 0, 'dataValidations', 'z'],
        ]);
    });
});
