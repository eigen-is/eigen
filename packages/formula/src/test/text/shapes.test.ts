import { describe, expect, test } from 'bun:test';
import { NodeKind, parseA1, printA1, RefKind, ShapeTable } from '../../text';
import { at, findSheet, sheetName, stored, treeA1 } from './support';

describe('ShapeTable', () => {
    test('equal stored text is one shape, different text another', () => {
        const table = new ShapeTable();
        const first = table.intern('=RC[-2]+R1C2');
        expect(first).toBe(1);
        expect(table.intern('=RC[-2]+R1C2')).toBe(first);
        expect(table.intern('=RC[-2] + R1C2')).toBe(2);
        expect(table.intern('=RC[-2]+R1C2')).toBe(first);
        expect(table.size).toBe(2);
        expect(table.shape(first).text).toBe('=RC[-2]+R1C2');
        expect(table.shape(2).text).toBe('=RC[-2] + R1C2');
    });

    test('a formula filled down or across is one shape', () => {
        const table = new ShapeTable();
        const ids = [
            ['C1', '=A1+$B$1'],
            ['C2', '=A2+$B$1'],
            ['C9', '=a9+$b$1'],
            ['D1', '=B1+$B$1'],
        ].map(([host, text]) => table.internTree(treeA1(text, host)));
        expect(ids).toEqual([1, 1, 1, 1]);
    });

    test.each([
        ['whitespace', 'C1', '=A1+$B$1', 'C1', '=A1 + $B$1', false],
        ['the case of a function name', 'C1', '=sum(A1:B1)', 'C1', '=SUM(A1:B1)', true],
        ['a written sheet prefix', 'C1', '=A1', 'C1', '=Sheet1!A1', false],
        ['corner order at the host', 'A1', '=SUM(B$2:B1)', 'A4', '=SUM(B$2:B4)', true],
        ['parentheses', 'A1', '=1+2', 'A1', '=(1+2)', false],
        ['a $', 'B2', '=A1', 'B2', '=$A1', false],
        ['the same cell from another host', 'B2', '=A1', 'B3', '=A1', false],
    ])('%s: %s %s and %s %s share a shape: %p', (_what, hostA, textA, hostB, textB, same) => {
        const table = new ShapeTable();
        const a = table.internTree(treeA1(textA, hostA));
        const b = table.internTree(treeA1(textB, hostB));
        expect(a === b).toBe(same);
        expect(stored(textA, hostA) === stored(textB, hostB)).toBe(same);
    });

    test('a typed tree and its stored text intern to one id, and the tree is kept', () => {
        const table = new ShapeTable();
        const tree = treeA1('=SUM(A1:A3)*2', 'A4');
        const id = table.internTree(tree);
        expect(table.intern('=SUM(R[-3]C:R[-1]C)*2')).toBe(id);
        expect(table.shape(id).tree).toBe(tree);
        const other = new ShapeTable();
        expect(other.shape(other.intern('=SUM(R[-3]C:R[-1]C)*2')).tree).toEqual(tree);
    });

    test('a shape lists its reference leaves in the order written', () => {
        const table = new ShapeTable();
        const shape = table.shape(table.intern('=IF(RC[-1]>0,SUM(C1:C2,(R1C1)),-[s2]!R[1]C%)+Rate'));
        expect(shape.refs.map((ref) => ref.op)).toEqual([RefKind.Cell, RefKind.Columns, RefKind.Cell, RefKind.Cell]);
        expect(shape.refs.every((ref) => ref.kind === NodeKind.Ref)).toBe(true);
        expect(shape.refs[3].sheet).toBe('s2');
        expect(table.shape(table.intern('=1+2')).refs).toEqual([]);
        const chain = table.shape(table.intern(`=${'RC[1]+R1C1*RC[2]-'.repeat(450)}(RC[3],RC[4])`));
        expect(chain.refs).toHaveLength(1352);
        expect(chain.refs.slice(0, 4).map((ref) => ref.column)).toEqual([1, 0, 2, 1]);
        expect(chain.refs.slice(-3).map((ref) => ref.column)).toEqual([2, 3, 4]);
    });

    test('a shape that is not kept is forgotten, and its id goes to a new shape that starts with nothing', () => {
        const table = new ShapeTable();
        const [a, b, c] = ['=R1C1', '=R1C2', '=R1C3'].map((text) => table.intern(text));
        table.facts[a] = 7;
        table.facts[c] = 9;
        const held = new Uint8Array(table.size + 1);
        held[b] = 1;
        table.keep(held);
        // Kept twice, a forgotten id is still given out once.
        table.keep(held);
        expect(table.intern('=R1C2')).toBe(b);
        const next = table.intern('=ROW()');
        const again = table.intern('=R1C1');
        expect([next, again].sort()).toEqual([a, c].sort());
        expect([table.shape(next).text, table.shape(again).text]).toEqual(['=ROW()', '=R1C1']);
        expect([table.facts[next], table.facts[again], table.facts[b]]).toEqual([-1, -1, -1]);
        expect(table.intern('=ROW()')).toBe(next);
        expect(table.size).toBe(3);
        expect(table.intern('=R1C3')).toBe(4);
    });

    test('a shape that names a sheet that does not exist says so', () => {
        const table = new ShapeTable();
        expect(table.shape(table.intern("=SUM('Later'!RC)")).namesSheet).toBe(true);
        expect(table.shape(table.intern("='Later'!Rate")).namesSheet).toBe(true);
        expect(table.shape(table.intern('=SUM([s2]!RC)')).namesSheet).toBe(false);
        expect(table.shape(table.intern("='[1]Book'!RC")).namesSheet).toBe(false);
        expect(table.shape(table.internTree(treeA1('=Nowhere!A1'))).namesSheet).toBe(true);
    });

    test('text that does not parse is kept as a shape without a tree', () => {
        const table = new ShapeTable();
        const id = table.intern('=SUM(1,');
        expect(table.shape(id)).toEqual({ text: '=SUM(1,', tree: null, refs: [], namesSheet: false });
        expect(table.intern('=SUM(1,')).toBe(id);
    });

    test('two tables share nothing', () => {
        const one = new ShapeTable();
        const two = new ShapeTable();
        one.intern('=1');
        expect(two.intern('=2')).toBe(1);
        expect(two.size).toBe(1);
    });

    test('a shape prints at each of its cells', () => {
        const table = new ShapeTable();
        const parsed = parseA1('=A1+$B$1', ...at('C1'), findSheet);
        if ('reason' in parsed) throw new Error(parsed.reason);
        const { tree } = table.shape(table.internTree(parsed));
        if (!tree) throw new Error('no tree');
        expect(printA1(tree, ...at('C7'), sheetName)).toBe('=A7+$B$1');
    });
});
