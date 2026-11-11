import { describe, expect, test } from 'bun:test';
import type { FormulaNode } from '../../text';
import { NodeKind, parseA1, parseStored, printA1, printStored, RefFlag, ShapeTable } from '../../text';
import { findSheet, formulas, sheetName, treeStored } from './support';

const RUNS = 3000;

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
});
