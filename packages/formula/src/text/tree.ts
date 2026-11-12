// The parsed formula: one node shape for every kind, told apart by an integer, so a walker is a switch and a new
// kind cannot be forgotten by one that reads `children`, the one way down the tree. A tree is immutable and holds
// nothing that depends on the cell it sits in: a relative reference is an offset, a sheet is an id, and the corners
// of a range stay as typed. The three constructors here are the one place a node is made, and endsAt says where a
// reference points from a cell.

export const NodeKind = {
    Number: 0,
    String: 1,
    Boolean: 2,
    Error: 3,
    // An argument left out between two separators, as in IF(A1,,2).
    Empty: 4,
    Ref: 5,
    Name: 6,
    Call: 7,
    // A call of what an expression returns, as in LAMBDA(x,x+1)(2), or of another workbook's name, as in
    // [1]!Rate(2): the first child is called with the rest.
    Invoke: 8,
    Prefix: 9,
    Postfix: 10,
    // A long sum is a chain thousands of nodes deep down its left operands, so a walker reads that side in a loop.
    // By any other way down, a tree is at most a few hundred nodes deep.
    Binary: 11,
    Paren: 12,
    // An array constant, its elements row by row, with the column count in `op`.
    Array: 13,
    // A reference into a table of a file, such as Sales[[#This Row],[Qty]]: `text` is the table's name, which is
    // empty for the table the cell is in, and its brackets as written. An importer puts the range in its place.
    Table: 14,
} as const;

export const RefKind = { Cell: 0, Range: 1, Columns: 2, Rows: 3 } as const;

export const SheetKind = {
    Host: 0,
    Id: 1,
    // A sheet that does not exist, kept as the name that was typed.
    Name: 2,
    // Another workbook, kept as its prefix text, such as [1]Sheet1, on a reference or a name.
    External: 3,
    // A 3-D reference, kept as its two names with the colon between them.
    Span: 4,
} as const;

export const RefFlag = { RowAbsolute: 1, ColumnAbsolute: 2, Row2Absolute: 4, Column2Absolute: 8 } as const;

export type FormulaNode = {
    readonly kind: (typeof NodeKind)[keyof typeof NodeKind];
    // The operator of a prefix, postfix or binary node, the RefKind of a reference, the column count of an array.
    readonly op: number;
    // A number, 1 for TRUE, or the place of an error in ERROR_LITERALS, from 1.
    readonly value: number;
    // A string's content, a name, a function name.
    readonly text: string;
    readonly children: readonly FormulaNode[];
    // The whitespace before the node's own token, which for a binary or postfix node is its operator.
    readonly space: string;
    // The whitespace between the name of a call and its parenthesis.
    readonly spaceOpen: string;
    // The whitespace before the closing bracket of a call, a parenthesis or an array.
    readonly spaceEnd: string;
    readonly sheetKind: (typeof SheetKind)[keyof typeof SheetKind];
    readonly sheet: string;
    // Per axis an index from 0 when its flag says absolute, else an offset from the host cell.
    readonly row: number;
    readonly column: number;
    readonly row2: number;
    readonly column2: number;
    readonly flags: number;
};

// Every field is set in one order by the three constructors, so the engine sees one object layout.
const NO_CHILDREN: readonly FormulaNode[] = [];

export function leaf(
    kind: FormulaNode['kind'],
    value: number,
    text: string,
    space: string,
    sheetKind: FormulaNode['sheetKind'],
    sheet: string,
): FormulaNode {
    return {
        kind,
        op: 0,
        value,
        text,
        children: NO_CHILDREN,
        space,
        spaceOpen: '',
        spaceEnd: '',
        sheetKind,
        sheet,
        row: 0,
        column: 0,
        row2: 0,
        column2: 0,
        flags: 0,
    };
}

export function branch(
    kind: FormulaNode['kind'],
    op: number,
    text: string,
    children: readonly FormulaNode[],
    space: string,
    spaceOpen: string,
    spaceEnd: string,
): FormulaNode {
    return {
        kind,
        op,
        value: 0,
        text,
        children,
        space,
        spaceOpen,
        spaceEnd,
        sheetKind: SheetKind.Host,
        sheet: '',
        row: 0,
        column: 0,
        row2: 0,
        column2: 0,
        flags: 0,
    };
}

export function referenceNode(
    op: number,
    space: string,
    sheetKind: FormulaNode['sheetKind'],
    sheet: string,
    row: number,
    column: number,
    row2: number,
    column2: number,
    flags: number,
): FormulaNode {
    return {
        kind: NodeKind.Ref,
        op,
        value: 0,
        text: '',
        children: NO_CHILDREN,
        space,
        spaceOpen: '',
        spaceEnd: '',
        sheetKind,
        sheet,
        row,
        column,
        row2,
        column2,
        flags,
    };
}

// The one node of an argument left out.
export const EMPTY = leaf(NodeKind.Empty, 0, '', '', SheetKind.Host, '');

// The lines a reference names on one axis at a host, in the order they were typed. The caller's own, written by
// endsAt, so that reading a reference allocates nothing.
export type Ends = { first: number; second: number };

// Writes the rows, or the columns, a reference names from a host on line `host` into `into`, and says whether both
// are on an axis of `lines` lines. A cell's second end is its first; a whole column names the host's own row twice.
export function endsAt(reference: FormulaNode, rows: boolean, host: number, lines: number, into: Ends): boolean {
    const { flags } = reference;
    const absolute = flags & (rows ? RefFlag.RowAbsolute : RefFlag.ColumnAbsolute);
    const absolute2 = flags & (rows ? RefFlag.Row2Absolute : RefFlag.Column2Absolute);
    const first = (rows ? reference.row : reference.column) + (absolute ? 0 : host);
    const second =
        reference.op === RefKind.Cell ? first : (rows ? reference.row2 : reference.column2) + (absolute2 ? 0 : host);
    into.first = first;
    into.second = second;
    return first >= 0 && first < lines && second >= 0 && second < lines;
}
