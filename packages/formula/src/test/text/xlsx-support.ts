import { FUNCTIONS } from '../../functions/library';
import type { FormulaNode } from '../../text';
import { intersect, isLegacy, parseXlsx, printA1, printXlsx, xlsxTree } from '../../text';
import { at, dice, findSheet, sheetName } from './support';

// A formula as a file holds it, read at a cell.
export function read(text: string, host = 'D2'): FormulaNode {
    const parsed = parseXlsx(text, ...at(host), findSheet);
    if ('reason' in parsed) throw new Error(`${text}: ${parsed.reason} at ${parsed.at}`);
    return parsed;
}

// What the formula bar shows for the plain <f> of a file.
export function bar(text: string, host = 'D2'): string {
    return printA1(intersect(read(text, host), FUNCTIONS), ...at(host), sheetName);
}

// The mark and the text a tree is written to a file with, as an exporter asks for them.
export function fileOf(tree: FormulaNode, host = 'D2'): { legacy: boolean; text: string } {
    const legacy = isLegacy(tree, FUNCTIONS);
    return { legacy, text: printXlsx(xlsxTree(tree, FUNCTIONS, legacy), ...at(host), sheetName) };
}

// A seeded generator of formula text as a file spells it, written from the grammar: every prefix, SINGLE and
// ANCHORARRAY around anything, LET and LAMBDA with their parameters, functions the engine has, lacks and never heard
// of, and every kind of reference. With `marked` false it writes no SINGLE, as a file from before dynamic arrays.
export function fileFormulas(seed: number, marked: boolean): () => string {
    const { random, chance, pick } = dice(seed);
    const space = () => (chance(0.85) ? '' : pick([' ', '  ', '\n']));
    const dollar = () => (chance(0.3) ? '$' : '');
    const column = () => dollar() + pick(['A', 'B', 'C', 'N', 'AA', 'XFD']);
    const row = () => dollar() + pick(['1', '2', '5', '14', '1048576']);
    const cell = () => column() + row();
    const sheet = () =>
        pick(['Sheet2!', "'My Sheet'!", 'NoSuch!', 'Sheet1:Sheet3!', '[1]Sheet1!', '[1]!', "'[1]x y'!", '[2]Jan:Dec!']);
    const reference = (): string =>
        (chance(0.7) ? '' : sheet()) +
        pick([cell, cell, () => `${cell()}:${cell()}`, () => `${column()}:${column()}`, () => `${row()}:${row()}`])();
    const constant = () =>
        pick(['0', '1', '2.5', '"a"', '""', 'TRUE', 'FALSE', '#N/A', '#REF!', '{1,2,3}', '{1;"a"}', 'Rate', 'x.y']);
    const names = [
        ...['SUM', 'SUM', 'IF', 'IF', 'INDEX', 'INDEX', 'MATCH', 'VLOOKUP', 'LOOKUP', 'SUMPRODUCT', 'ABS', 'LEN'],
        ...['ROW', 'N', 'CHOOSE', 'IFERROR', 'OFFSET', 'INDIRECT', 'COUNTIF', 'SUMIF', 'AND', 'ROWS', 'SUBTOTAL'],
        ...['_xlfn.XLOOKUP', '_xlfn.IFS', '_xlfn.IFNA', '_xlfn.CONCAT', '_xlfn.NORM.S.DIST', '_xlfn._xlws.FILTER'],
        ...['_xlfn._xlws.SORT', '_xlfn.UNIQUE', '_xlfn.SEQUENCE', 'TRANSPOSE', 'GETPIVOTDATA', 'NPV', 'MMULT'],
        ...['MYUDF', '_xludf.FOO', '_xll.ADDIN', '_xlfn.NEWTHING', '__xludf.DUMMYFUNCTION', 'TRUE'],
        ...['_xlfn.ANCHORARRAY', marked ? '_xlfn.SINGLE' : 'T'],
    ];
    const list = (depth: number, bound: readonly string[]) => {
        const count = Math.floor(random() * 4);
        const items = Array.from({ length: count }, () => (chance(0.1) ? '' : expression(depth - 1, bound)));
        return `(${count === 1 && items[0] === '' ? '' : items.join(',')}${space()})`;
    };
    const parameter = () => pick(['x', 'y', 'f', 'Rate', 'total_2']);
    const binder = (depth: number, bound: readonly string[]): string => {
        const own = [parameter(), parameter()];
        if (chance(0.5)) {
            const first = expression(depth - 1, bound);
            const second = expression(depth - 1, [...bound, own[0]]);
            const body = expression(depth - 1, [...bound, ...own]);
            return `_xlfn.LET(_xlpm.${own[0]},${first},_xlpm.${own[1]},${second},${body})`;
        }
        const lambda = `_xlfn.LAMBDA(_xlpm.${own[0]},_xlpm.${own[1]},${expression(depth - 1, [...bound, ...own])})`;
        return chance(0.5) ? lambda : `${lambda}(${expression(depth - 1, bound)},1)`;
    };
    const region = (depth: number, bound: readonly string[]) =>
        pick([reference, reference, () => '#REF!', () => pick(names) + list(depth, bound)])();
    const primary = (depth: number, bound: readonly string[]): string => {
        const leaves = [constant, reference, reference, () => (bound.length > 0 ? `_xlpm.${pick(bound)}` : 'Rate')];
        if (depth <= 0) return space() + pick(leaves)();
        return (
            space() +
            pick([
                ...leaves,
                () => pick(names) + list(depth, bound),
                () => pick(names) + list(depth, bound),
                () => `${marked ? '_xlfn.SINGLE' : ''}(${expression(depth - 1, bound)})`,
                () => `_xlfn.ANCHORARRAY(${expression(depth - 1, bound)})`,
                () => `_xlfn.ANCHORARRAY(${reference()})`,
                () =>
                    bound.length > 0 ? `_xlpm.${pick(bound)}${list(depth, bound)}` : `[1]!Func${list(depth, bound)}`,
                () => binder(depth, bound),
                () => `(${expression(depth - 1, bound)}${space()})`,
                () => `(${region(depth, bound)},${region(depth, bound)})`,
                () => `${region(depth, bound)} ${region(depth, bound)}`,
                () => `${cell()}:${pick(names)}${list(depth, bound)}`,
            ])()
        );
    };
    const operand = (depth: number, bound: readonly string[]): string => {
        let text = '';
        while (chance(0.12)) text += pick(['-', '+']);
        text += primary(depth, bound);
        while (chance(0.08)) text += '%';
        return text;
    };
    const expression = (depth: number, bound: readonly string[]): string => {
        let text = operand(depth, bound);
        while (chance(0.3))
            text += space() + pick(['+', '-', '*', '/', '^', '&', '=', '<>', '<', '>=']) + operand(depth, bound);
        return text;
    };
    return () => expression(3, []);
}
