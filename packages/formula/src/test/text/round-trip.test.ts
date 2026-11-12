import { describe, expect, test } from 'bun:test';
import type { FormulaNode } from '../../text';
import { NodeKind, parseA1, parseStored, printA1, printStored, RefFlag } from '../../text';
import { ShapeTable } from '../../text/shapes';
import { failure, findSheet, formulas, keepsLaws, sheetName, soup, treeStored, typedFormulas } from './support';

const RUNS = 3000;
const SOUP_RUNS = 100000;
// The first and last rows and columns of the grid, and a few between.
const HOST_ROWS = [0, 0, 1, 4, 1003, 1048574, 1048575];
const HOST_COLUMNS = [0, 0, 1, 13, 200, 16382, 16383];

function walk(node: FormulaNode, visit: (node: FormulaNode) => void): void {
    visit(node);
    for (const child of node.children) walk(child, visit);
}

describe('round trip', () => {
    test('stored text → tree → stored text, over random trees of every kind', () => {
        const next = formulas(1, false);
        const kinds = new Set<number>();
        const refKinds = new Set<number>();
        const sheetKinds = new Set<number>();
        const flags = new Set<number>();
        let spaced = 0;
        for (let run = 0; run < RUNS; run += 1) {
            const text = next();
            const tree = treeStored(text);
            expect(printStored(tree)).toBe(text);
            walk(tree, (node) => {
                kinds.add(node.kind);
                sheetKinds.add(node.sheetKind);
                if (node.space !== '' || node.spaceEnd !== '') spaced += 1;
                if (node.kind !== NodeKind.Ref) return;
                refKinds.add(node.op);
                flags.add(node.flags);
            });
        }
        expect([...kinds].sort((a, b) => a - b)).toEqual(Object.values(NodeKind));
        expect([...refKinds].sort()).toEqual([0, 1, 2, 3]);
        expect([...sheetKinds].sort()).toEqual([0, 1, 2, 3, 4]);
        for (const flag of Object.values(RefFlag)) {
            expect([...flags].some((seen) => seen & flag)).toBe(true);
            expect([...flags].some((seen) => !(seen & flag))).toBe(true);
        }
        expect(spaced).toBeGreaterThan(RUNS);
    });

    test('parse(print(tree)) is the tree itself', () => {
        const next = formulas(2, false);
        for (let run = 0; run < 300; run += 1) {
            const tree = treeStored(next());
            expect(parseStored(printStored(tree))).toEqual(tree);
        }
    });

    test('A1 at a random host → tree → A1 at that host', () => {
        const next = formulas(3, false);
        for (let run = 0; run < RUNS; run += 1) {
            const tree = treeStored(next());
            const row = 5 + ((run * 7919) % 1000);
            const column = 5 + ((run * 104729) % 200);
            const a1 = printA1(tree, row, column, sheetName);
            const back = parseA1(a1, row, column, findSheet);
            if ('reason' in back) throw new Error(`${a1}: ${back.reason} at ${back.at}`);
            expect(printA1(back, row, column, sheetName)).toBe(a1);
        }
    });

    test('with corners in order, A1 at a host parses back to the same stored text', () => {
        const next = formulas(4, true);
        for (let run = 0; run < RUNS; run += 1) {
            const text = next();
            const row = 5 + ((run * 7919) % 1000);
            const column = 5 + ((run * 104729) % 200);
            const a1 = printA1(treeStored(text), row, column, sheetName);
            const back = parseA1(a1, row, column, findSheet);
            if ('reason' in back) throw new Error(`${a1}: ${back.reason} at ${back.at}`);
            expect(printStored(back)).toBe(text);
        }
    });

    test('equal stored text is equal shape id, and only then', () => {
        const next = formulas(5, false);
        const table = new ShapeTable();
        const idOf = new Map<string, number>();
        for (let run = 0; run < RUNS; run += 1) {
            const text = next();
            const id = run % 2 === 0 ? table.intern(text) : table.internTree(treeStored(text));
            expect(idOf.get(text) ?? id).toBe(id);
            idOf.set(text, id);
        }
        expect(new Set(idOf.values()).size).toBe(idOf.size);
        expect(table.size).toBe(idOf.size);
    });

    test('typed text of every kind, at hosts up to the edges of the grid, keeps the laws', () => {
        const next = typedFormulas(6);
        const seen = new Map<string, string>();
        let longest = 0;
        for (let run = 0; run < RUNS; run += 1) {
            const text = next();
            longest = Math.max(longest, text.length);
            const row = HOST_ROWS[run % HOST_ROWS.length];
            const column = HOST_COLUMNS[(run * 3 + Math.floor(run / 7)) % HOST_COLUMNS.length];
            if (!keepsLaws(text, true, row, column, seen)) throw new Error(`run ${run}: ${failure(text)}`);
        }
        expect(longest).toBeGreaterThan(5000);
        expect(seen.size).toBeGreaterThan(RUNS * 0.85);
    });

    test('a token soup of either grammar keeps the laws, and nothing throws', () => {
        const seen = new Map<string, string>();
        let parsed = 0;
        for (const typed of [true, false]) {
            const next = soup(typed ? 7 : 8, typed);
            for (let run = 0; run < SOUP_RUNS; run += 1) {
                const row = HOST_ROWS[run % HOST_ROWS.length];
                const column = HOST_COLUMNS[(run * 3 + Math.floor(run / 7)) % HOST_COLUMNS.length];
                if (keepsLaws(next(), typed, row, column, seen)) parsed += 1;
            }
        }
        expect(parsed).toBeGreaterThan(SOUP_RUNS / 10);
    });
});
