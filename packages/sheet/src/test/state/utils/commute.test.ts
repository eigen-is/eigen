import { describe, expect, test } from 'bun:test';
import type { Op } from '../../../state/types';
import { commutes } from '../../../state/utils/commute';

const replace = (path: Op['path'], id = 's1'): Op[] => [{ op: 'replace', id, path, value: { v: 'x', m: 'x' } }];
const add = (path: Op['path']): Op[] => [{ op: 'add', id: 's1', path, value: {} }];
const rowInsert: Op[] = [
    { op: 'insertRowCol', id: 's1', path: [], value: { type: 'row', index: 0, count: 1, direction: 'lefttop' } },
];

describe('commutes', () => {
    test('fails for a rename, which rewrites formulas on any sheet', () => {
        const rename: Op[] = [{ op: 'renameSheet', id: 's1', path: [], value: { name: 'New' } }];
        expect(commutes([rename], [replace(['data', 0, 0], 's2')])).toBe(false);
        expect(commutes([replace(['data', 0, 0], 's2')], [rename])).toBe(false);
    });

    test('holds for writes to different cells', () => {
        expect(commutes([replace(['data', 0, 0])], [replace(['data', 1, 1])])).toBe(true);
    });

    test('holds for the same cell on different sheets', () => {
        expect(commutes([replace(['data', 0, 0], 's1')], [replace(['data', 0, 0], 's2')])).toBe(true);
    });

    test('fails for two writes to one cell', () => {
        expect(commutes([replace(['data', 0, 0])], [replace(['data', 0, 0])])).toBe(false);
    });

    test('fails when one side writes a path inside or above the other', () => {
        expect(commutes([replace(['data', 0])], [replace(['data', 0, 0])])).toBe(false);
        expect(commutes([replace(['data', 0, 0, 'v'])], [replace(['data', 0, 0])])).toBe(false);
    });

    test('fails for two adds at an array index, which both move the array', () => {
        expect(commutes([add(['conditionalFormatRules', 0])], [add(['conditionalFormatRules', 1])])).toBe(false);
    });

    test('fails when either side moves rows', () => {
        expect(commutes([rowInsert], [replace(['data', 5, 0])])).toBe(false);
        expect(commutes([replace(['data', 5, 0])], [rowInsert])).toBe(false);
    });
});
