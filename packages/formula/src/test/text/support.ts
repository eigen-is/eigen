import type { FormulaNode } from '../../text';
import {
    ERROR_LITERALS,
    NodeKind,
    parseA1,
    parseStored,
    printA1,
    printStored,
    RefFlag,
    RefKind,
    ShapeTable,
    SheetKind,
    sheetFinder,
    storedText,
    Token,
    typedText,
} from '../../text';

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

// Seeded dice, so a run that fails fails again.
export function dice(seed: number) {
    let state = seed;
    const random = () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const chance = (p: number) => random() < p;
    const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
    return { random, chance, pick };
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
    const { random, chance, pick } = dice(seed);
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
                  "'[2]Jan:Dec'!",
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
            () => pick(['0', '1', '42', '2.5', '0.001', '1E+21', '0.00000015', '6.626E-34', '123456789012345']),
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
    const region = (depth: number) =>
        space() + pick([reference, reference, () => 'Rate', () => '#REF!', () => call(depth)])();
    const primary = (depth: number): string => {
        const leaves = [
            () => space() + constant(),
            () => space() + reference(),
            () => space() + reference() + (chance(0.2) ? `${space()}#` : ''),
            () => space() + pick(['Rate', 'total_2', 'rc', 'x.y', '[s2]!Scoped', "'Missing'!Scoped", '[pl]!#REF!']),
            () => space() + pick(["'[1]'!Rate", "'[1]'!'SGJ212,LA'", "'[1]'!'A1'", "'[1]x'!'it''s'", "'[1]'!'RC'"]),
        ];
        if (depth <= 0) return pick(leaves)();
        return pick([
            ...leaves,
            () => space() + call(depth),
            () => space() + call(depth) + list(depth),
            () => space() + pick(["'[1]'!Func", "'[1]'!'TAX2'", "'[1]Book'!'my fn'"]) + list(depth),
            () => `${space()}(${expression(depth - 1)}${space()})${chance(0.1) ? list(depth) : ''}`,
            () => `${space()}(${region(depth)},${region(depth)}${space()})`,
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

// A seeded generator of formula text as a person types it, written from the grammar: every text it makes parses.
// It reaches what the stored generator cannot: labels up to the last cell of the grid, a sheet prefix on the second
// corner, 3-D names that read as columns, names that read as stored references, every error and long chains.
export function typedFormulas(seed: number): () => string {
    const { random, chance, pick } = dice(seed);
    const space = () => (chance(0.8) ? '' : pick([' ', '  ', '\n']));
    const dollar = () => (chance(0.3) ? '$' : '');
    const column = () => dollar() + pick(['A', 'B', 'C', 'N', 'Z', 'AA', 'XFC', 'XFD', 'a', 'xfd']);
    const row = () => dollar() + pick(['1', '2', '5', '14', '1000', '1048575', '1048576']);
    const cell = () => column() + row();
    const sheet = () =>
        pick([
            'Sheet2!',
            'sheet1!',
            "'My Sheet'!",
            "'Bob''s'!",
            "'A1'!",
            'NoSuch!',
            "'No Such'!",
            'Sheet1:Sheet3!',
            'Jan:Dec!',
            'Q:FY!',
            'Rate:Sheet2!',
            "'A 1:B 2'!",
            '[1]Sheet1!',
            '[1]!',
            '[2]Jan:Dec!',
            "'[1]x y'!",
            "'C:\\path\\[Book.xlsx]Sheet1'!",
        ]);
    const reference = (): string => {
        const prefix = chance(0.6) ? '' : sheet();
        if (prefix !== '' && chance(0.2)) {
            const end = pick([cell, cell, column, row]);
            return `${prefix}${end()}:${prefix}${end()}`;
        }
        if (prefix !== '' && chance(0.1)) return `${prefix}#REF!`;
        return (
            prefix +
            pick([
                cell,
                cell,
                () => `${cell()}:${cell()}`,
                () => `${column()}:${column()}`,
                () => `${row()}:${row()}`,
            ])()
        );
    };
    const name = () => pick(['Rate', 'total_2', 'x.y', '_a', 'RC', 'R1C1', 'r', 'C', 'R5C', 'rc', 'XFE1', 'A1048577']);
    const number = () =>
        pick([
            '0',
            '1',
            '42',
            '2.5',
            '.5',
            '1.',
            '1E3',
            '1e-9',
            '1.5E+7',
            '12345678901234567',
            '0.1234567890123456789',
        ]);
    const constant = () =>
        pick([
            number,
            number,
            () => pick(['"a"', '""', '"a""b"', '"x, (y) \'z\'"']),
            () => pick(['TRUE', 'false', 'True']),
            () => pick([pick(ERROR_LITERALS), pick(ERROR_LITERALS).toLowerCase()]),
        ])();
    const list = (depth: number) => {
        const count = Math.floor(random() * 4);
        const items = Array.from({ length: count }, () => (chance(0.15) ? '' : expression(depth - 1)));
        return `(${count === 1 && items[0] === '' ? '' : items.join(',')}${space()})`;
    };
    const call = (depth: number) =>
        pick(['SUM', 'if', 'Log10', 'NORM.S.DIST', '_xlfn.XLOOKUP', 'nosuchfn']) + list(depth);
    const array = () => {
        const columns = Math.floor(random() * 3) + 1;
        const element = () => space() + (chance(0.2) ? pick(['-', '+']) + number() : constant());
        const line = () => Array.from({ length: columns }, element).join(',');
        return `{${Array.from({ length: Math.floor(random() * 3) + 1 }, line).join(';')}${space()}}`;
    };
    const region = (depth: number) => pick([reference, reference, () => '#REF!', () => call(depth)])();
    const primary = (depth: number): string => {
        const leaves = [
            constant,
            reference,
            () => reference() + (chance(0.2) ? '#' : ''),
            name,
            () => `Sheet2!${name()}`,
        ];
        if (depth <= 0) return space() + pick(leaves)();
        return (
            space() +
            pick([
                ...leaves,
                () => call(depth),
                () => call(depth) + list(depth),
                () => pick(['[1]!Func', '[1]!TAX2', "[1]!'my fn'", "'[1]x y'!rc"]) + list(depth),
                () => pick(["[1]!'SGJ212,LA'", "[1]!'A1'", "'[1]x y'!'it''s'", "[1]!'Rate'"]),
                () => `(${expression(depth - 1)}${space()})`,
                () => `(${region(depth)},${region(depth)}${space()})`,
                array,
                () => `${region(depth)}${pick([' ', '  ', '\n'])}${region(depth)}`,
                () => `${cell()}${space()}:${space()}${call(depth)}`,
                () => `#REF!:${cell()}`,
            ])()
        );
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
        while (chance(0.35)) text += space() + pick(OPERATORS) + operand(depth);
        return text;
    };
    // One text in fifty is a chain of thousands of operands, close to the longest a person may type.
    return () => {
        let text = `=${expression(3)}`;
        if (chance(0.02)) while (text.length < 8000) text += pick(OPERATORS) + operand(0);
        return text;
    };
}

const OPERATORS = ['+', '-', '*', '/', '^', '&', '=', '<>', '<', '<=', '>', '>='];

const TYPED_WORDS = [
    ...['A1', '$A$1', 'B$2', '$C3', 'A:A', '$A:C', '1:1', '$1:3', 'A1:B2', 'B2:A1', 'B$2:B1', 'XFD1048576', 'XFE1'],
    ...['A', 'B', 'R', 'C', 'RC', 'R1C1', 'rc', 'R1', 'C1', 'R[1]C[1]', 'RC[1]', 'C[-1]', 'A[1]', 'Rate', 'x.y', '_a'],
    ...['TRUE', 'FALSE', 'true', 'SUM', 'IF', 'F', 'SUM(', 'IF(', ')(', ',,', 'F()', '{1,2;3,4}', '{-1,"a"', 'A1#'],
    ...['1', '2.5', '1E3', '.5', '1.', '11.', '1E-9', '12345678901234567', '"a"', '""', '"a""b"', '"', "'"],
    ...['#N/A', '#REF!', '#DIV/0!', '#NAME?', '#FOO!', '#REF?', '#ref!', '#GETTING_DATA', '#'],
    ...['Sheet2!', "'My Sheet'!", 'NoSuch!', "'No Such'!", 'Sheet1:Sheet2!', "'A B:C D'!", '[1]Sheet1!', "'[1]x y'!"],
    ...['Jan:Dec!', 'Q:FY!', 'A1Sheet!', 'B1x!', '[s2]!', '[1]', '!', '$', '.', '?', '\u00a0', 'é'],
    ...['+', '-', '@', '%', '#', '^', '*', '/', '&', '=', '<>', '<', '<=', '>', '>=', ':', ',', ';', '{', '}'],
    ...['(', ')', '(', ')', '(', ')', ',', ':', ':', ':'],
    ...['SUM (', 'TRUE (', 'F  (', 'RC (', 'A1 (', 'Rate\n('],
    ...['Sheet2!A', 'Sheet2!A', 'Sheet2!$B', 'Sheet2!1', 'Sheet2!$2', 'Sheet2!A1', "'No Such'!B", 'NoSuch!B'],
    ...['A1 TRUE', 'A1 5', 'A1 "x"', '(1,2)', '(A1,2)', '(A1,B1)', 'A1 B1', 'A1##'],
    ...['[1]!', '[1]!', '[1]!Func(', '[2]A:B!', "'x,y'", "'A1'", "'Rate'", "'[1]'!", 'TAX2('],
    ...["''!A1", "''!A", '5!', '+!', '#REF!!'],
    ...['#REF!A1', '#REF!$B$2', '#ref!A', '#REF!1', '#REF!A1:B2', '#N/AA1'],
    ...[
        '\u3000',
        '\u200b',
        '\uff11',
        '\uff0b',
        '\uff21',
        '\u00d7',
        '\u201c',
        '\u3164',
        '\ufe0f',
        '\ud83d\ude00',
        '\ud83d',
    ],
    ...['\u0394x', '\u6570\u636e', '\u6570\u636e!', '\ud840\udc00', 'x\u0663', '\\a', 'a?'],
];

const STORED_WORDS = [
    ...['RC', 'R[1]C[-1]', 'R1C1', 'R[-2]C3', 'R5C', 'C[1]:C[3]', 'C1:C2', 'R[1]:R[2]', 'R1:R[3]', 'R[2]C[2]:RC'],
    ...['R', 'C', 'R5', 'C3', 'rc', 'r1c1', 'A', 'B', 'XFD', 'A1', 'Rate', 'x.y', 'TRUE', 'FALSE', 'SUM', 'IF', 'F'],
    ...['SUM(', 'IF(', ')(', ',,', 'F()', '{1,2;3,4}', 'RC#', '1', '2.5', '1E+21', '1E-9', '0.5', '11.', '1.'],
    ...['"a"', '""', '"a""b"', '"', "'", '#N/A', '#REF!', '#DIV/0!', '#FOO!', '#'],
    ...['[s2]!', '[my]!', '[gone]!', "'No Such'!", "'A:B'!", "'[1]x'!", 'NoSuch!', '[1]x!', 'Jan:Dec!', '[', ']'],
    ...['+', '-', '@', '%', '#', '^', '*', '/', '&', '=', '=', '<>', '<', '<=', '>', '>=', ':', ',', ';', '{', '}'],
    ...['(', ')', '(', ')', '(', ')', ',', ':', ':', ':', '!', '$'],
    ...['SUM (', 'TRUE (', 'F  (', 'RC (', 'A1 (', 'rc (', 'Rate\n('],
    ...['[s2]!C1', '[s2]!C[2]', '[s2]!R', '[s2]!R2', '[s2]!A', '[s2]!B', '[s2]!RC', "'x'!C"],
    ...['RC TRUE', 'RC 5', 'RC "x"', '(1,2)', '(RC,2)', '(RC,R1C1)', 'RC R1C1', 'RC##'],
    ...["'[1]'!", "'[1]'!", "'[1]'!Func(", "'[2]A:B'!", "'x,y'", "'A1'", "'Rate'", "'RC'", 'TAX2('],
    ...["''!RC", "''!C", '5!', '+!', '#REF!!'],
    ...['#REF!RC', '#REF!R1C1', '#REF!A1', '#REF!C'],
    ...[
        '\u3000',
        '\u200b',
        '\uff11',
        '\uff0b',
        '\u00d7',
        '\u3164',
        '\ud83d\ude00',
        '\ud83d',
        '\u0394x',
        '\u6570\u636e',
    ],
];

// A seeded token soup: a few words of one grammar's vocabulary in any order, most of which do not parse.
export function soup(seed: number, typed: boolean): () => string {
    const { random, pick } = dice(seed);
    const words = typed ? TYPED_WORDS : STORED_WORDS;
    return () => {
        let text = '=';
        for (let count = 1 + Math.floor(random() * 9); count > 0; count -= 1) {
            text += pick(['', '', '', '', ' ', '  ', '\n']) + pick(words);
        }
        return text;
    };
}

// Whether a tree shows at a host as text that is another shape: a range's corners are out of order there, where the
// A1 printer swaps them, or a sheet is gone, or a sheet kept by its name has come to exist.
export function showsAsAnother(node: FormulaNode, row: number, column: number): boolean {
    if (node.sheetKind === SheetKind.Id && sheetName(node.sheet) === undefined) return true;
    if (node.sheetKind === SheetKind.Name && findSheet(node.sheet)) return true;
    if (node.kind === NodeKind.Ref && node.op !== RefKind.Cell) {
        const { flags } = node;
        const top = flags & RefFlag.RowAbsolute ? node.row : node.row + row;
        const bottom = flags & RefFlag.Row2Absolute ? node.row2 : node.row2 + row;
        const left = flags & RefFlag.ColumnAbsolute ? node.column : node.column + column;
        const right = flags & RefFlag.Column2Absolute ? node.column2 : node.column2 + column;
        if (top > bottom || left > right) return true;
    }
    return node.children.some((child) => showsAsAnother(child, row, column));
}

// The laws every text keeps, as typed at a cell or as stored. Throws naming the one that broke. `seen` holds every
// stored text printed so far with its tree, across calls. Returns whether the text parsed.
export function keepsLaws(
    text: string,
    typed: boolean,
    row: number,
    column: number,
    seen: Map<string, string>,
): boolean {
    const broke = (law: string, detail: string) =>
        new Error(`${law}: ${JSON.stringify(text.slice(0, 300))} at ${row},${column} ${detail.slice(0, 300)}`);
    const tree = typed ? parseA1(text, row, column, findSheet) : parseStored(text);
    if ('reason' in tree) {
        if (!typed) return false;
        // Text that fails as typed never comes back as a formula, and shows as it was typed.
        const kept = storedText(text, row, column, findSheet);
        const table = new ShapeTable();
        const shape = table.shape(table.intern(kept));
        if (shape.tree !== null || !('reason' in parseStored(kept))) throw broke('unparsable text came alive', kept);
        if (typedText(shape, row, column, sheetName) !== text) throw broke('unparsable text changed', kept);
        return false;
    }
    const stored = printStored(tree);
    const back = parseStored(stored);
    const json = JSON.stringify(tree);
    if ('reason' in back) throw broke('stored text does not parse back', stored);
    if (JSON.stringify(back) !== json) throw broke('stored text parses back to another tree', stored);
    if ((seen.get(stored) ?? json) !== json) throw broke('two trees print one stored text', stored);
    seen.set(stored, json);
    const a1 = printA1(tree, row, column, sheetName);
    const again = parseA1(a1, row, column, findSheet);
    if ('reason' in again) throw broke('A1 text does not parse back', a1);
    // A reference that is off the grid at this host shows as #REF! and stays that.
    const offGrid = a1.split('#REF!').length !== stored.split('#REF!').length;
    if (offGrid || showsAsAnother(tree, row, column)) return true;
    if (printStored(again) !== stored) {
        throw broke('A1 text parses back to another shape', `${a1} -> ${printStored(again)}, not ${stored}`);
    }
    return true;
}
