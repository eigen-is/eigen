import type { FormulaNode } from '../../text';
import { NodeKind, parseA1, parseStored, printA1, printStored, sheetFinder, Token } from '../../text';

export const SHEETS = [
    { id: 's1', name: 'Sheet1' },
    { id: 's2', name: 'Sheet2' },
    { id: 'my', name: 'My Sheet' },
    { id: 'bob', name: "Bob's" },
    { id: 'pl', name: 'P&L' },
    { id: 'y24', name: '2024' },
    { id: 'a1', name: 'A1' },
    { id: 'true', name: 'TRUE' },
    { id: 'rc', name: 'RC' },
];

export const findSheet = sheetFinder(SHEETS);

export function sheetName(id: string): string | undefined {
    return SHEETS.find((sheet) => sheet.id === id)?.name;
}

// "N1" → [row, column], both from 0.
export function at(label: string): [number, number] {
    const letters = label.replace(/\d+/, '');
    let column = 0;
    for (const letter of letters) column = column * 26 + letter.charCodeAt(0) - 64;
    return [Number(label.slice(letters.length)) - 1, column - 1];
}

export function treeA1(text: string, host = 'N1'): FormulaNode {
    const parsed = parseA1(text, ...at(host), findSheet);
    if ('reason' in parsed) throw new Error(`${text}: ${parsed.reason} at ${parsed.at}`);
    return parsed;
}

export function treeStored(text: string): FormulaNode {
    const parsed = parseStored(text);
    if ('reason' in parsed) throw new Error(`${text}: ${parsed.reason} at ${parsed.at}`);
    return parsed;
}

// The stored text a typed formula becomes at its cell.
export function stored(text: string, host = 'N1'): string {
    return printStored(treeA1(text, host));
}

// What the formula bar shows for a typed formula.
export function shown(text: string, host = 'N1'): string {
    return printA1(treeA1(text, host), ...at(host), sheetName);
}

export function failure(text: string, host = 'N1'): string {
    const parsed = parseA1(text, ...at(host), findSheet);
    return 'reason' in parsed ? parsed.reason : 'parsed';
}

const SYMBOLS: Record<number, string> = {
    [Token.Space]: ' ',
    [Token.Colon]: ':',
    [Token.Comma]: ',',
    [Token.Plus]: '+',
    [Token.Minus]: '-',
    [Token.At]: '@',
    [Token.Percent]: '%',
    [Token.Hash]: '#',
    [Token.Power]: '^',
    [Token.Multiply]: '*',
    [Token.Divide]: '/',
    [Token.Concat]: '&',
    [Token.Equal]: '=',
    [Token.NotEqual]: '<>',
    [Token.Less]: '<',
    [Token.LessEqual]: '<=',
    [Token.Greater]: '>',
    [Token.GreaterEqual]: '>=',
};

// The tree with every operator's operands bracketed, so a test reads the grouping the parser chose. Leaves print as
// the stored form writes them.
export function grouped(node: FormulaNode): string {
    const kids = node.children.map(grouped);
    switch (node.kind) {
        case NodeKind.Binary:
            return `(${kids[0]}${SYMBOLS[node.op]}${kids[1]})`;
        case NodeKind.Prefix:
            return `(${SYMBOLS[node.op]}${kids[0]})`;
        case NodeKind.Postfix:
            return `(${kids[0]}${SYMBOLS[node.op]})`;
        case NodeKind.Paren:
            return `[${kids[0]}]`;
        case NodeKind.Call:
            return `${node.text}(${kids.join(',')})`;
        case NodeKind.Invoke:
            return `${kids[0]}(${kids.slice(1).join(',')})`;
        case NodeKind.Array:
            return `{${kids.join(',')}}`;
        case NodeKind.Empty:
            return '_';
        default:
            return printStored({ ...node, space: '' }).slice(1);
    }
}

// A seeded generator of stored formula text, written from the grammar and not from the parser: every text it makes
// is canonical, so printing its tree must give it back to the character. With `ordered`, the two corners of a range
// are in order at every host, so the A1 text at a host parses back to the same tree.
export function formulas(seed: number, ordered: boolean): () => string {
    let state = seed;
    const random = () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const chance = (p: number) => random() < p;
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
    const small = () => Math.floor(random() * 3) + 1;
    const space = () => (chance(0.75) ? '' : pick([' ', '  ', '\n', '\t ', ' \r\n']));

    const index = () => pick([() => '', () => `[${small()}]`, () => `[-${small()}]`, () => String(small())])();
    // Two indexes of one axis, both absolute or both offsets, the first not past the second.
    const span = (): [string, string] => {
        const low = small();
        const high = low + Math.floor(random() * 3);
        if (chance(0.5)) return [String(low), String(high)];
        const offset = (value: number) => (value === 2 ? '' : `[${value - 2}]`);
        return [offset(low), offset(high)];
    };
    const ends = (): [string, string] => (ordered ? span() : [index(), index()]);
    const prefix = () =>
        chance(0.6)
            ? ''
            : pick([
                  '[s2]!',
                  '[pl]!',
                  '[s1]!',
                  "'No Such'!",
                  "'Missing'!",
                  "'[1]Book'!",
                  "'Sheet1:Sheet3'!",
                  "'A 1:B 2'!",
              ]);
    const cell = () => `R${index()}C${index()}`;
    const reference = (): string => {
        const [from, to] = ends();
        const [from2, to2] = ends();
        return (
            prefix() +
            pick([
                cell,
                cell,
                () => `R${from}C${from2}:R${to}C${to2}`,
                () => `C${from}:C${to}`,
                () => `R${from}:R${to}`,
            ])()
        );
    };
    const constant = () =>
        pick([
            () => pick(['0', '1', '42', '2.5', '0.001', '1E+21', '1.5E-7', '123456789012345']),
            () => pick(['"a"', '""', '"a""b"', '"x, (y) \'z\'"', '"line\nbreak"']),
            () => pick(['TRUE', 'FALSE']),
            () => pick(['#N/A', '#DIV/0!', '#NAME?', '#VALUE!', '#REF!', '#GETTING_DATA']),
        ])();
    const list = (depth: number) => {
        const count = Math.floor(random() * 4);
        const items = Array.from({ length: count }, () => (chance(0.15) ? '' : expression(depth - 1)));
        return `(${count === 1 && items[0] === '' ? '' : items.join(',')}${space()})`;
    };
    const call = (depth: number) => pick(['SUM', 'IF', 'LOG10', 'NORM.S.DIST', 'NOSUCHFN']) + list(depth);
    const array = () => {
        const columns = small();
        const element = () => space() + (chance(0.2) ? pick(['-', '+']) + pick(['1', '2.5']) : constant());
        const row = () => Array.from({ length: columns }, element).join(',');
        return `{${Array.from({ length: small() }, row).join(';')}${space()}}`;
    };
    const primary = (depth: number): string => {
        const leaves = [
            () => space() + constant(),
            () => space() + reference(),
            () => space() + reference() + (chance(0.2) ? `${space()}#` : ''),
            () => space() + pick(['Rate', 'total_2', 'rc', 'x.y', '[s2]!Scoped', "'Missing'!Scoped", '[pl]!#REF!']),
        ];
        if (depth <= 0) return pick(leaves)();
        return pick([
            ...leaves,
            () => space() + call(depth),
            () => space() + call(depth) + list(depth),
            () => `${space()}(${expression(depth - 1)}${space()})${chance(0.1) ? list(depth) : ''}`,
            () => `${space()}(${expression(depth - 1)},${expression(depth - 1)}${space()})`,
            () => space() + array(),
            () => space() + reference() + pick([' ', '  ', '\n']) + pick([reference, () => call(depth)])(),
            () => `${space()}${pick([cell, () => call(depth)])()}${space()}:${space()}${call(depth)}`,
        ])();
    };
    const operand = (depth: number): string => {
        let text = '';
        while (chance(0.15)) text += space() + pick(['-', '+', '@']);
        text += primary(depth);
        while (chance(0.1)) text += `${space()}%`;
        return text;
    };
    const expression = (depth: number): string => {
        let text = operand(depth);
        while (chance(0.35)) {
            text += space() + pick(['+', '-', '*', '/', '^', '&', '=', '<>', '<', '<=', '>', '>=']) + operand(depth);
        }
        return text;
    };
    return () => `=${expression(4)}`;
}
