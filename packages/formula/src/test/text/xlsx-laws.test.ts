import { describe, expect, test } from 'bun:test';
import { FUNCTIONS } from '../../functions/library';
import type { FormulaNode } from '../../text';
import { intersect, isLegacy, NodeKind, parseStored, parseXlsx, printStored, printXlsx, xlsxTree } from '../../text';
import { dice, findSheet, sheetName, showsAsAnother } from './support';
import { fileFormulas } from './xlsx-support';

const RUNS = 4000;

// Whether a tree holds what makes its mark an array formula whatever the @ pass did: the named set of what the
// rule cannot tell, read off the text of the tree.
function unsure(node: FormulaNode): boolean {
    return /\b(?:LET|LAMBDA)\(/.test(printStored(node));
}

// The stored text of a tree without the whitespace a round trip does not keep: what stands after an @ comes back
// before it, and what stands inside the brackets of SINGLE or ANCHORARRAY, or before a #, is dropped.
function key(tree: FormulaNode): string {
    return printStored(tree)
        .replace(/@(\s+)/g, '$1@')
        .replace(/\s+/g, ' ')
        .replace(/([(@]) | (?=[)#])/g, '$1');
}

function count(text: string, part: string): number {
    return text.split(part).length - 1;
}

function holds(node: FormulaNode, test: (node: FormulaNode) => boolean): boolean {
    return test(node) || node.children.some((child) => holds(child, test));
}

// Every text the generator makes that reads, with the cell it is read at.
function* cases(
    seed: number,
    marked: boolean,
): Generator<{ text: string; row: number; column: number; tree: FormulaNode }> {
    const next = fileFormulas(seed, marked);
    const { random } = dice(seed + 1);
    for (let run = 0; run < RUNS; run += 1) {
        const text = next();
        const row = Math.floor(random() * 40);
        const column = Math.floor(random() * 40);
        const tree = parseXlsx(text, row, column, findSheet);
        if (!('reason' in tree)) yield { text, row, column, tree };
    }
}

describe('text/xlsx laws, over generated file text', () => {
    test('tree equality: the stored text of every tree the reader makes reads back as that tree', () => {
        let trees = 0;
        for (const marked of [false, true]) {
            for (const { text, tree } of cases(11, marked)) {
                for (const made of [tree, intersect(tree, FUNCTIONS)]) {
                    const back = parseStored(printStored(made));
                    if (JSON.stringify(back) !== JSON.stringify(made))
                        throw new Error(`${text} -> ${printStored(made)}`);
                    trees += 1;
                }
            }
        }
        expect(trees).toBeGreaterThan(8000);
    });

    test('law A: the @ the pass puts into a text without one are the @ the writer leaves out again', () => {
        let read = 0;
        let cut = 0;
        let array = 0;
        for (const { text, row, column, tree } of cases(23, false)) {
            const legacy = intersect(tree, FUNCTIONS);
            const plain = printXlsx(xlsxTree(tree, FUNCTIONS, false), row, column, sheetName);
            read += 1;
            if (legacy !== tree) cut += 1;
            if (!isLegacy(legacy, FUNCTIONS)) {
                // The pass leaves no place that certainly wants one value without its @, so what is left is of the
                // named set the rule cannot tell: there every @ is written, as SINGLE, and none is lost.
                array += 1;
                const marked = printXlsx(xlsxTree(legacy, FUNCTIONS, false), row, column, sheetName);
                if (marked.replaceAll('_xlfn.SINGLE', '') !== plain.replaceAll(/(?<=\()\(|\)(?=\))/g, '')) {
                    if (count(printStored(legacy), '@') !== count(marked, '_xlfn.SINGLE'))
                        throw new Error(`${text}: ${marked}`);
                }
                continue;
            }
            const written = printXlsx(xlsxTree(legacy, FUNCTIONS, true), row, column, sheetName);
            if (written !== plain) throw new Error(`${text}: ${written} is not ${plain}`);
        }
        expect(read).toBeGreaterThan(3500);
        expect(cut).toBeGreaterThan(1000);
        expect(array).toBeLessThan(read / 2);
    });

    test('law B: what is written reads back as the same shape, and is written the same again', () => {
        let written = 0;
        for (const marked of [false, true]) {
            for (const { text, row, column, tree } of cases(37, marked)) {
                for (const made of [tree, intersect(tree, FUNCTIONS)]) {
                    const legacy = isLegacy(made, FUNCTIONS);
                    const file = printXlsx(xlsxTree(made, FUNCTIONS, legacy), row, column, sheetName);
                    const back = parseXlsx(file, row, column, findSheet);
                    if ('reason' in back) throw new Error(`${text}: ${file} does not read back`);
                    const again = legacy ? intersect(back, FUNCTIONS) : back;
                    const mark = isLegacy(again, FUNCTIONS);
                    if (mark !== legacy) throw new Error(`${text}: ${file} changes its mark`);
                    const second = printXlsx(xlsxTree(again, FUNCTIONS, mark), row, column, sheetName);
                    if (second !== file) throw new Error(`${text}: ${file} is written again as ${second}`);
                    written += 1;
                    // A range whose corners are out of order, a reference off the grid and a sheet that came to exist
                    // show as another shape at this cell, by the A1 printer's own rules.
                    const moved = file.includes('#REF!') || holds(made, (node) => showsAsAnother(node, row, column));
                    if (!moved && key(again) !== key(made)) {
                        throw new Error(
                            `${text}: ${file} reads back as ${printStored(again)}, not ${printStored(made)}`,
                        );
                    }
                }
            }
        }
        expect(written).toBeGreaterThan(8000);
    });

    test('a tree with LET or LAMBDA is never plain, and the pass leaves it as it is', () => {
        let found = 0;
        for (const { tree } of cases(41, false)) {
            if (!unsure(tree)) continue;
            found += 1;
            expect(isLegacy(intersect(tree, FUNCTIONS), FUNCTIONS)).toBe(false);
            if (tree.kind === NodeKind.Call && (tree.text === 'LET' || tree.text === 'LAMBDA')) {
                expect(intersect(tree, FUNCTIONS)).toBe(tree);
            }
        }
        expect(found).toBeGreaterThan(100);
    });
});
