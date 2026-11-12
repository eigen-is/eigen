// The formula parser: text to the immutable tree, by precedence climbing over one table of binding powers. One
// parser reads both grammars. parseA1 reads what a person types at a cell, resolving sheet names to ids and turning
// relative references into offsets from that cell; parseStored reads the stored shape text, where they already are.
// Text that does not parse is a result, never a throw, and the limits on length, nesting and arguments are kept here.

import { columnIndex, GRID_ROWS } from './a1';
import {
    BANG,
    BRACKET_CLOSE,
    BRACKET_OPEN,
    COLON,
    DOLLAR,
    DOT,
    EQUALS,
    LOWER_A,
    LOWER_E,
    MINUS,
    OPEN,
    UPPER_C,
    UPPER_R,
    ZERO,
} from './chars';
import { continuesWord, errorCode, lexAt, REF_ERROR, Token, tokenEnd, tokenKind } from './lexer';
import type { FormulaNode } from './tree';
import { branch, EMPTY, leaf, NodeKind, RefFlag, RefKind, referenceNode, SheetKind } from './tree';

// The cap on a formula's text in every spelling. One formula is longer stored or in a file than typed, as a!A1 is
// with a uuid for the sheet, so a cap per spelling would refuse text the engine printed itself.
export const MAX_STORED_LENGTH = 131072;
// Brackets, calls and prefix or postfix operators, one inside the other. A chain of binary operators is not nesting.
export const MAX_NESTING = 64;
export const MAX_ARGUMENTS = 255;

export type SheetFinder = (name: string) => { readonly id: string } | undefined;

export type ParseFailure = {
    readonly reason: 'syntax' | 'too-long' | 'too-deep' | 'too-many-arguments';
    readonly at: number;
};

export type A1Range = {
    readonly sheet?: string;
    readonly start: { readonly column: number; readonly row: number };
    readonly end: { readonly column: number; readonly row: number };
};

// Whether stored text is typed text that did not parse, kept behind a second =. No printed shape starts with two,
// so the mark alone says the text is no formula, whatever the stored grammar would make of the rest.
export function isUnparsed(stored: string): boolean {
    return stored.charCodeAt(0) === EQUALS && stored.charCodeAt(1) === EQUALS;
}

// A formula as typed at a cell, such as =SUM(A1:B2)*Sheet2!$C$1, with the row and column from 0. The = may be
// left out, as a file leaves it out.
export function parseA1(
    text: string,
    hostRow: number,
    hostColumn: number,
    findSheet: SheetFinder,
): FormulaNode | ParseFailure {
    return new Parser(text, false, hostRow, hostColumn, findSheet).formula();
}

// A formula in its stored form, such as =SUM(R[-3]C:R[-1]C)*[k3f9]!R2C1.
export function parseStored(text: string): FormulaNode | ParseFailure {
    return new Parser(text, true, 0, 0, noSheet).formula();
}

function noSheet(): undefined {
    return undefined;
}

// Whether the word from `pos` to `end` is a function called with whitespace before its parenthesis, as in SUM (1).
// A word that reads as a reference in either notation is none: with the whitespace, that is an intersection.
export function callsSpaced(text: string, pos: number, end: number): boolean {
    const gap = lexAt(text, end);
    if (tokenKind(gap) !== Token.Space || text.charCodeAt(tokenEnd(gap)) !== OPEN) return false;
    return !readsAsReference(text.slice(pos, end));
}

// The tree, or the failure of one that nests deeper than its stored text reads back. The parser counts as it reads;
// this measures a tree that a walk made deeper than the text it came from, as reading a file's spellings does.
export function bounded(tree: FormulaNode): FormulaNode | ParseFailure {
    return nesting(tree) > MAX_NESTING ? { reason: 'too-deep', at: 0 } : tree;
}

// Whether a word is a cell label or a stored reference by its form alone, in any letter case and on or off the
// grid, or holds what no name does. Such a word is never a name where a reference could stand.
export function readsAsReference(word: string): boolean {
    return READS_AS_REFERENCE.test(word);
}

// The reference that starts at `from` in typed text, and where it ends. Its sheet, if any, stays a name.
export function referenceAt(text: string, from: number): { readonly node: FormulaNode; readonly end: number } | null {
    return new Parser(text, false, 0, 0, noSheet).referenceFrom(from);
}

// A cell or a rectangle with an optional sheet, such as Sheet1!$A$1:B3, as indexes from 0 with the corners in
// order. Null for anything else.
export function parseA1Range(range: string): A1Range | null {
    const found = referenceAt(range, 0);
    if (!found || found.end !== range.length) return null;
    const { node } = found;
    if (node.op > RefKind.Range || node.sheetKind > SheetKind.Name) return null;
    const { row, column } = node;
    const row2 = node.op === RefKind.Cell ? row : node.row2;
    const column2 = node.op === RefKind.Cell ? column : node.column2;
    return {
        sheet: node.sheetKind === SheetKind.Name ? node.sheet : undefined,
        start: { column: Math.min(column, column2), row: Math.min(row, row2) },
        end: { column: Math.max(column, column2), row: Math.max(row, row2) },
    };
}

// How tightly each operator holds its operands, tightest first. A prefix operator sits between union and %, so
// -2^2 is 4, and every binary operator groups to the left, ^ included.
const PREFIX_POWER = 13;
const BINDING = new Uint8Array(64);
for (const [power, ...operators] of [
    [21, Token.Hash, Token.Open],
    [19, Token.Colon],
    [17, Token.Space],
    [15, Token.Comma],
    [11, Token.Percent],
    [9, Token.Power],
    [7, Token.Multiply, Token.Divide],
    [5, Token.Plus, Token.Minus],
    [3, Token.Concat],
    [1, Token.Equal, Token.NotEqual, Token.Less, Token.LessEqual, Token.Greater, Token.GreaterEqual],
]) {
    for (const operator of operators) BINDING[operator] = power;
}

const READS_AS_REFERENCE = /^(?:[A-Z]{1,3}\d+|(?:R\d*)?(?:C\d*)?)$|[$[]/i;

const LEG_CELL = 1;
const LEG_COLUMN = 2;
const LEG_ROW = 3;

class Parser {
    private readonly text: string;
    private readonly stored: boolean;
    private readonly hostRow: number;
    private readonly hostColumn: number;
    private readonly findSheet: SheetFinder;
    // The current token, and the whitespace before it.
    private kind: number = Token.End;
    private pos = 0;
    private end = 0;
    private space = '';
    private depth = 0;
    // How many brackets and prefix or postfix operators deep the operand or expression read last is.
    private height = 0;
    private reason: ParseFailure['reason'] | '' = '';
    private failedAt = 0;
    // What the leg readers found last: they return a position, so their findings land here.
    private legKind = 0;
    private legRow = 0;
    private legColumn = 0;
    private legFlags = 0;
    private index = 0;
    private absolute = false;
    // What sheetPrefix found last.
    private prefixKind: FormulaNode['sheetKind'] = SheetKind.Host;
    private prefixSheet = '';

    public constructor(text: string, stored: boolean, hostRow: number, hostColumn: number, findSheet: SheetFinder) {
        this.text = text;
        this.stored = stored;
        this.hostRow = hostRow;
        this.hostColumn = hostColumn;
        this.findSheet = findSheet;
    }

    public formula(): FormulaNode | ParseFailure {
        if (this.text.length > MAX_STORED_LENGTH) return { reason: 'too-long', at: MAX_STORED_LENGTH };
        if (isUnparsed(this.text)) return { reason: 'syntax', at: 1 };
        // A formula in a file has no = of its own, and reads from its first character.
        if (this.text.charCodeAt(0) === EQUALS) this.end = 1;
        this.next();
        const tree = this.expression(0, false);
        if (this.kind !== Token.End) this.fail();
        return this.reason === '' ? tree : { reason: this.reason, at: this.failedAt };
    }

    // The reference that starts at `from`, sheet prefix and both legs, or null when none does.
    public referenceFrom(from: number): { readonly node: FormulaNode; readonly end: number } | null {
        this.end = from;
        this.next();
        if (this.space !== '') return null;
        const node = this.operand(false);
        return this.reason === '' && node.kind === NodeKind.Ref ? { node, end: this.pos - this.space.length } : null;
    }

    private next(): void {
        const { text } = this;
        let start = this.end;
        let token = lexAt(text, start);
        if (tokenKind(token) === Token.Space) {
            this.space = text.slice(start, tokenEnd(token));
            start = tokenEnd(token);
            token = lexAt(text, start);
        } else {
            this.space = '';
        }
        this.pos = start;
        this.kind = tokenKind(token);
        this.end = tokenEnd(token);
    }

    // The first failure is the one reported. Parsing then sees the end of the text, so every loop unwinds.
    private fail(reason: ParseFailure['reason'] = 'syntax'): FormulaNode {
        if (this.reason === '') {
            this.reason = reason;
            this.failedAt = this.pos;
        }
        this.kind = Token.End;
        this.end = this.text.length;
        this.space = '';
        return EMPTY;
    }

    private enter(): boolean {
        this.depth += 1;
        if (this.depth <= MAX_NESTING) return true;
        this.fail('too-deep');
        return false;
    }

    private expression(minPower: number, union: boolean): FormulaNode {
        let left = this.operand(union);
        let height = this.height;
        for (;;) {
            let op = this.kind;
            const { space } = this;
            let power = BINDING[op];
            // A comma is a union only inside parentheses of its own, and ( calls only what can return a function.
            if (op === Token.Comma && !union) power = 0;
            const callable =
                left.kind === NodeKind.Call ||
                left.kind === NodeKind.Invoke ||
                left.kind === NodeKind.Paren ||
                (left.kind === NodeKind.Name && left.sheetKind === SheetKind.External);
            if (op === Token.Open && (space !== '' || !callable)) power = 0;
            if (power === 0) {
                if (space === '' || !this.startsReference() || !yieldsReference(left)) break;
                op = Token.Space;
                power = BINDING[op];
            }
            if (power < minPower) break;
            if (op === Token.Hash && !yieldsReference(left)) return this.fail();
            if (op === Token.Hash || op === Token.Percent) {
                this.next();
                left = branch(NodeKind.Postfix, op, '', [left], space, '', '');
                height += 1;
                continue;
            }
            if (op === Token.Open) {
                const called = [left];
                left = branch(NodeKind.Invoke, 0, '', called, '', '', this.argumentList(called));
                height = Math.max(height, this.height) + 1;
                continue;
            }
            // An intersection is written as the whitespace itself, so its right operand starts with none.
            if (op === Token.Space) this.space = '';
            else this.next();
            const right = this.expression(power + 1, union);
            height = Math.max(height, this.height);
            // A number never stands beside a colon as a row would: each of these joins what may yield a reference.
            const joinsReferences = op === Token.Colon || op === Token.Space || op === Token.Comma;
            if (joinsReferences && !(yieldsReference(left) && yieldsReference(right))) return this.fail();
            left =
                op === Token.Colon
                    ? this.colon(left, right, space)
                    : branch(NodeKind.Binary, op, '', [left, right], space, '', '');
        }
        // A postfix operator wraps what was already read, so the limit on nesting is checked on the way out too.
        if (height > MAX_NESTING) return this.fail('too-deep');
        this.height = height;
        return left;
    }

    // The node of a colon between two operands, which is where a range that was not read as one reference is built.
    private colon(left: FormulaNode, right: FormulaNode, space: string): FormulaNode {
        if (space === '') {
            const before = left.kind === NodeKind.Binary ? left.children[1] : left;
            let after = right;
            while (after.kind === NodeKind.Postfix || after.kind === NodeKind.Invoke) after = after.children[0];
            // Two cells with only a colon between them are one reference, so the second names no sheet of its own.
            const cell = before.kind === NodeKind.Ref && before.op === RefKind.Cell;
            if (cell && after.kind === NodeKind.Ref && after.op <= RefKind.Range && after.space === '') {
                return this.fail();
            }
            // A name that is a column label, a colon and a column would show as one range, as would a function named
            // like a column and called with whitespace. Only stored text gets here that way.
            const label = after.kind === NodeKind.Name || after.spaceOpen !== '';
            const column = after.kind === NodeKind.Ref ? after.op === RefKind.Columns : label && isColumn(after);
            if (before.kind === NodeKind.Name && isColumn(before) && column && after.space === '') return this.fail();
        }
        return branch(NodeKind.Binary, Token.Colon, '', [left, right], space, '', '');
    }

    private startsReference(): boolean {
        const { kind } = this;
        if (kind === Token.Number) return this.text.charCodeAt(this.end) === COLON;
        if (kind === Token.Error) return errorCode(this.text, this.pos) === REF_ERROR;
        return kind === Token.Word || kind === Token.Quote || kind === Token.Bracket || kind === Token.Open;
    }

    private operand(union: boolean): FormulaNode {
        const { text, kind, pos, end, space } = this;
        this.height = 0;
        switch (kind) {
            case Token.Number: {
                if (text.charCodeAt(end) === COLON) {
                    const rows = this.reference(space, SheetKind.Host, '');
                    if (rows) return rows;
                }
                let literal = text.slice(pos, end);
                if (end - pos > 15) {
                    // A literal keeps its first 15 significant digits and the rest count as zeros, as Excel reads it.
                    let significant = 0;
                    let at = pos;
                    literal = '';
                    for (; at < end && (text.charCodeAt(at) | 32) !== LOWER_E; at += 1) {
                        const code = text.charCodeAt(at);
                        if (code !== DOT && (significant > 0 || code !== ZERO)) significant += 1;
                        literal += significant > 15 && code !== DOT ? '0' : text.charAt(at);
                    }
                    literal += text.slice(at, end);
                }
                const value = Number(literal);
                if (value === Infinity) return this.fail();
                this.next();
                return leaf(NodeKind.Number, value, '', space, SheetKind.Host, '');
            }
            case Token.String: {
                const quoted = text.slice(pos + 1, end - 1);
                const content = quoted.includes('"') ? quoted.replaceAll('""', '"') : quoted;
                this.next();
                return leaf(NodeKind.String, 0, content, space, SheetKind.Host, '');
            }
            case Token.Error: {
                const code = errorCode(text, pos);
                this.next();
                // Typed text may hold Excel's spelling of a reference to a deleted sheet, #REF!A1. The error forgets
                // the cells, so they are read and dropped.
                const cells = this.kind === Token.Word || this.kind === Token.Number;
                if (code === REF_ERROR && !this.stored && this.space === '' && cells) {
                    this.reference('', SheetKind.Host, '');
                }
                return leaf(NodeKind.Error, code, '', space, SheetKind.Host, '');
            }
            case Token.Plus:
            case Token.Minus:
            case Token.At: {
                if (!this.enter()) return EMPTY;
                this.next();
                const child = this.expression(PREFIX_POWER, union);
                this.depth -= 1;
                this.height += 1;
                return branch(NodeKind.Prefix, kind, '', [child], space, '', '');
            }
            case Token.Open: {
                if (!this.enter()) return EMPTY;
                this.next();
                const child = this.expression(0, true);
                if (this.kind !== Token.Close) return this.fail();
                const spaceEnd = this.space;
                this.next();
                this.depth -= 1;
                this.height += 1;
                return branch(NodeKind.Paren, 0, '', [child], space, '', spaceEnd);
            }
            case Token.BraceOpen:
                return this.array(space);
            case Token.Word:
                return this.word(space);
            case Token.Quote:
            case Token.Bracket: {
                const bang = this.sheetPrefix(pos, kind, end);
                // A bracket that is no sheet's is a reference into the table the cell is in.
                return bang === -1 && kind === Token.Bracket
                    ? this.name(space, SheetKind.Host, '')
                    : this.prefixed(space, bang);
            }
            default:
                return this.fail();
        }
    }

    // A word is whole before it is anything: a function before (, a sheet before !, else a reference, a function
    // with whitespace before its (, a boolean, the first sheet of a 3-D reference, or a name.
    private word(space: string): FormulaNode {
        const { text, pos, end } = this;
        const after = text.charCodeAt(end);
        if (after === OPEN) return this.call(space);
        if (after === BANG) return this.prefixed(space, this.sheetPrefix(pos, Token.Word, end));
        const reference = this.reference(space, SheetKind.Host, '');
        if (reference) return reference;
        if (callsSpaced(text, pos, end)) return this.call(space);
        if (end - pos === 4 || end - pos === 5) {
            const upper = text.slice(pos, end).toUpperCase();
            if (upper === 'TRUE' || upper === 'FALSE') {
                this.next();
                return leaf(NodeKind.Boolean, upper === 'TRUE' ? 1 : 0, '', space, SheetKind.Host, '');
            }
        }
        if (after === COLON) {
            const bang = this.sheetPrefix(pos, Token.Word, end);
            if (bang !== -1) return this.prefixed(space, bang);
        }
        return this.name(space, SheetKind.Host, '');
    }

    private call(space: string): FormulaNode {
        const name = this.text.slice(this.pos, this.end).toUpperCase();
        this.next();
        const spaceOpen = this.space;
        const args: FormulaNode[] = [];
        const spaceEnd = this.argumentList(args);
        this.height += 1;
        return branch(NodeKind.Call, 0, name, args, space, spaceOpen, spaceEnd);
    }

    // A name, or a table reference: a name, which may be none, and the brackets right after it. A name must not
    // read as a reference in the other grammar, or it would come back as one: typed, it is stored in lower case,
    // which the stored grammar never reads as R1C1; stored, it is refused. Before a bracket a cell label is too.
    private name(space: string, sheetKind: FormulaNode['sheetKind'], sheet: string): FormulaNode {
        const { text, pos } = this;
        // A word runs on through a bracket of digits, so the name of Sales[2019] ends inside its token.
        const inWord = text.slice(pos, this.end).indexOf('[');
        const end = inWord === -1 ? this.end : pos + inWord;
        const table = text.charCodeAt(end) === BRACKET_OPEN;
        let name = text.slice(pos, end);
        if (name.includes('$')) return this.fail();
        if ((this.stored || table) && this.a1Leg(pos) === end && this.legKind === LEG_CELL) return this.fail();
        if (this.storedLeg(pos) >= end) {
            if (this.stored) return this.fail();
            name = name.toLowerCase();
        }
        if (table) {
            const brackets = lexAt(text, end);
            if (tokenKind(brackets) !== Token.Bracket) return this.fail();
            this.end = tokenEnd(brackets);
            name += text.slice(end, this.end);
        }
        this.next();
        return leaf(table ? NodeKind.Table : NodeKind.Name, 0, name, space, sheetKind, sheet);
    }

    // The arguments from the current ( to its ), appended to `list`, and the height of the tallest into `height`.
    // Returns the whitespace before the ).
    private argumentList(list: FormulaNode[]): string {
        const before = list.length;
        let height = 0;
        if (!this.enter()) return '';
        this.next();
        if (this.kind !== Token.Close) {
            for (;;) {
                if (this.kind === Token.Comma || this.kind === Token.Close) {
                    list.push(EMPTY);
                } else {
                    list.push(this.expression(0, false));
                    height = Math.max(height, this.height);
                }
                if (this.kind !== Token.Comma) break;
                this.next();
            }
        }
        if (this.kind !== Token.Close) this.fail();
        else if (list.length - before > MAX_ARGUMENTS) this.fail('too-many-arguments');
        const spaceEnd = this.space;
        this.next();
        this.depth -= 1;
        this.height = height;
        return spaceEnd;
    }

    // An array constant: constants only, each with an optional sign, in rows of one length.
    private array(space: string): FormulaNode {
        if (!this.enter()) return EMPTY;
        const elements: FormulaNode[] = [];
        let columns = 0;
        let rowStart = 0;
        let height = 0;
        for (;;) {
            this.next();
            const element = this.operand(false);
            height = Math.max(height, this.height);
            const constant =
                element.kind === NodeKind.Prefix
                    ? element.op !== Token.At && element.children[0].kind === NodeKind.Number
                    : element.kind <= NodeKind.Error;
            if (!constant) return this.fail();
            elements.push(element);
            if (this.kind === Token.Comma) continue;
            if (columns === 0) columns = elements.length;
            if (elements.length - rowStart !== columns) return this.fail();
            rowStart = elements.length;
            if (this.kind !== Token.Semicolon) break;
        }
        if (this.kind !== Token.BraceClose) return this.fail();
        const spaceEnd = this.space;
        this.next();
        this.depth -= 1;
        this.height = height + 1;
        return branch(NodeKind.Array, columns, '', elements, space, '', spaceEnd);
    }

    // The sheet prefix that starts at `pos` with a token of this kind and end, into the prefix fields, such as a
    // quoted name or the two names of a 3-D reference. Returns where its ! is, or -1 when no prefix starts there.
    private sheetPrefix(pos: number, kind: number, end: number): number {
        const { text } = this;
        let bang = end;
        let name = '';
        if (kind === Token.Quote) {
            const quoted = text.slice(pos + 1, bang - 1);
            name = quoted.includes("'") ? quoted.replaceAll("''", "'") : quoted;
        } else if (kind === Token.Bracket && this.stored) {
            this.prefixKind = SheetKind.Id;
            this.prefixSheet = text.slice(pos + 1, bang - 1);
            return text.charCodeAt(bang) === BANG ? bang : -1;
        } else if (kind !== Token.Word && kind !== Token.Bracket) {
            return -1;
        } else {
            let named = kind === Token.Word;
            if (!named) {
                const sheet = lexAt(text, bang);
                named = tokenKind(sheet) === Token.Word;
                if (named) bang = tokenEnd(sheet);
            }
            if (named && text.charCodeAt(bang) === COLON) {
                const last = lexAt(text, bang + 1);
                if (tokenKind(last) === Token.Word) bang = tokenEnd(last);
            }
            name = text.slice(pos, bang);
            // Another workbook's bracket inside a name needs quotes, or it would read as a stored offset.
            if (kind === Token.Word && name.includes('[')) return -1;
        }
        if (text.charCodeAt(bang) !== BANG) return -1;
        this.prefixSheet = name;
        if (name.includes('[')) {
            this.prefixKind = SheetKind.External;
        } else if (name.includes(':')) {
            this.prefixKind = SheetKind.Span;
        } else {
            // Only typed text is looked up: stored text names a sheet by id.
            const found = this.stored ? undefined : this.findSheet(name);
            this.prefixKind = found ? SheetKind.Id : SheetKind.Name;
            if (found) this.prefixSheet = found.id;
        }
        return bang;
    }

    // What follows the ! of the sheet prefix read last: a reference, a name scoped to the sheet, or the #REF! a
    // deletion left.
    private prefixed(space: string, bang: number): FormulaNode {
        if (bang === -1) return this.fail();
        const sheetKind = this.prefixKind;
        const sheet = this.prefixSheet;
        this.end = bang + 1;
        this.next();
        if (this.space !== '') return this.fail();
        if (this.kind === Token.Error && errorCode(this.text, this.pos) === REF_ERROR) {
            this.next();
            return leaf(NodeKind.Error, REF_ERROR, '', space, sheetKind, sheet);
        }
        if (sheetKind === SheetKind.External) {
            // Another workbook's name may be quoted, and one right before ( is a function whatever it reads as.
            const { text, pos, end } = this;
            const functionName = this.kind === Token.Word && text.charCodeAt(end) === OPEN;
            if (this.kind === Token.Quote || functionName) {
                const name = functionName ? text.slice(pos, end) : text.slice(pos + 1, end - 1).replaceAll("''", "'");
                this.next();
                return leaf(NodeKind.Name, 0, name, space, sheetKind, sheet);
            }
        }
        const reference = this.reference(space, sheetKind, sheet);
        if (reference) return reference;
        return this.kind === Token.Word ? this.name(space, sheetKind, sheet) : this.fail();
    }

    // A reference at the current token: a cell, or two legs of one kind around a colon, such as A1:B2, A:C or 1:5.
    // Null when the token is none.
    private reference(space: string, sheetKind: FormulaNode['sheetKind'], sheet: string): FormulaNode | null {
        const { text } = this;
        const end = this.leg(this.pos);
        if (end !== this.end) return null;
        const kind = this.legKind;
        const row = this.legRow;
        const column = this.legColumn;
        const flags = this.legFlags;
        if (text.charCodeAt(end) === COLON) {
            let second = end + 1;
            if (sheetKind !== SheetKind.Host) {
                // The second end may repeat the sheet of the first, as in HR!B9:HR!M9.
                const repeat = lexAt(text, second);
                const bang = this.sheetPrefix(second, tokenKind(repeat), tokenEnd(repeat));
                if (bang !== -1 && this.prefixKind === sheetKind && this.prefixSheet === sheet) second = bang + 1;
            }
            const legEnd = this.leg(second);
            const after = text.charCodeAt(legEnd);
            const whole = after !== OPEN && after !== BANG && !continuesWord(text, legEnd);
            if (legEnd !== -1 && this.legKind === kind && whole) {
                this.end = legEnd;
                this.next();
                const op = kind === LEG_CELL ? RefKind.Range : kind === LEG_COLUMN ? RefKind.Columns : RefKind.Rows;
                const both = flags | (this.legFlags << 2);
                return referenceNode(op, space, sheetKind, sheet, row, column, this.legRow, this.legColumn, both);
            }
        }
        if (kind !== LEG_CELL) return null;
        this.next();
        return referenceNode(RefKind.Cell, space, sheetKind, sheet, row, column, 0, 0, flags);
    }

    // One end of a reference at `pos`, into the leg fields. Returns where it ends, or -1.
    private leg(pos: number): number {
        return this.stored ? this.storedLeg(pos) : this.a1Leg(pos);
    }

    // $A$1, a column alone ($A) or a row alone ($1), inside the grid.
    private a1Leg(pos: number): number {
        const { text } = this;
        let at = pos;
        let flags = 0;
        if (text.charCodeAt(at) === DOLLAR) {
            flags = RefFlag.ColumnAbsolute;
            at += 1;
        }
        const lettersAt = at;
        for (;;) {
            const letter = (text.charCodeAt(at) | 32) - LOWER_A;
            if (!(letter >= 0 && letter < 26)) break;
            at += 1;
        }
        const letters = at - lettersAt;
        const column = columnIndex(text, lettersAt, at);
        if (letters === 0) {
            if (flags !== 0) flags = RefFlag.RowAbsolute;
        } else if (text.charCodeAt(at) === DOLLAR) {
            flags |= RefFlag.RowAbsolute;
            at += 1;
        }
        const digitsAt = at;
        let row = 0;
        for (;;) {
            const digit = text.charCodeAt(at) - ZERO;
            if (!(digit >= 0 && digit <= 9)) break;
            row = row * 10 + digit;
            at += 1;
        }
        const digits = at - digitsAt;
        this.legKind = 0;
        if (digits > 7 || letters + digits === 0 || (letters > 0 && column === -1)) return -1;
        if (digits > 0 ? row < 1 || row > GRID_ROWS : (flags & RefFlag.RowAbsolute) !== 0) return -1;
        this.legKind = digits === 0 ? LEG_COLUMN : letters === 0 ? LEG_ROW : LEG_CELL;
        this.legFlags = flags;
        this.legRow = digits === 0 ? 0 : flags & RefFlag.RowAbsolute ? row - 1 : row - 1 - this.hostRow;
        this.legColumn = letters === 0 ? 0 : flags & RefFlag.ColumnAbsolute ? column : column - this.hostColumn;
        return at;
    }

    // R[-1]C[2], a row alone (R5) or a column alone (C[1]), in upper case only.
    private storedLeg(pos: number): number {
        const { text } = this;
        let at = pos;
        let flags = 0;
        let row = 0;
        let column = 0;
        this.legKind = 0;
        if (text.charCodeAt(at) === UPPER_R) {
            at = this.storedIndex(at + 1);
            if (at === -1) return -1;
            row = this.index;
            if (this.absolute) flags = RefFlag.RowAbsolute;
            this.legKind = LEG_ROW;
        }
        if (text.charCodeAt(at) === UPPER_C) {
            at = this.storedIndex(at + 1);
            if (at === -1) return -1;
            column = this.index;
            if (this.absolute) flags |= RefFlag.ColumnAbsolute;
            this.legKind = this.legKind === LEG_ROW ? LEG_CELL : LEG_COLUMN;
        }
        if (this.legKind === 0) return -1;
        this.legFlags = flags;
        this.legRow = row;
        this.legColumn = column;
        return at;
    }

    // One axis of a stored leg, into index and absolute: nothing is offset 0, [n] an offset, n an index from 1.
    private storedIndex(pos: number): number {
        const { text } = this;
        let at = pos;
        const bracket = text.charCodeAt(at) === BRACKET_OPEN;
        if (bracket) at += 1;
        const negative = bracket && text.charCodeAt(at) === MINUS;
        if (negative) at += 1;
        const digitsAt = at;
        let value = 0;
        for (;;) {
            const digit = text.charCodeAt(at) - ZERO;
            if (!(digit >= 0 && digit <= 9)) break;
            value = value * 10 + digit;
            at += 1;
        }
        const digits = at - digitsAt;
        if (digits > 7) return -1;
        this.absolute = !bracket && digits > 0;
        if (bracket) {
            if (digits === 0 || text.charCodeAt(at) !== BRACKET_CLOSE) return -1;
            this.index = negative ? -value : value;
            return at + 1;
        }
        if (digits > 0 && value < 1) return -1;
        this.index = digits > 0 ? value - 1 : 0;
        return at;
    }
}

// What a colon, a space or a union's comma can join: whatever may yield a reference.
function yieldsReference(node: FormulaNode): boolean {
    switch (node.kind) {
        case NodeKind.Ref:
        case NodeKind.Name:
        case NodeKind.Table:
        case NodeKind.Call:
        case NodeKind.Invoke:
        case NodeKind.Paren:
            return true;
        case NodeKind.Error:
            return node.value === REF_ERROR;
        case NodeKind.Postfix:
            return node.op === Token.Hash;
        case NodeKind.Binary:
            return node.op === Token.Colon || node.op === Token.Space || node.op === Token.Comma;
        default:
            return false;
    }
}

// How many levels a tree nests. Its first children are read in a loop, as a long sum or a row of % is that deep.
function nesting(tree: FormulaNode): number {
    let levels = 0;
    let deepest = 0;
    for (let node = tree; ; node = node.children[0]) {
        const { kind, children } = node;
        if (kind >= NodeKind.Call && kind !== NodeKind.Binary && kind !== NodeKind.Table) levels += 1;
        for (let i = 1; i < children.length; i += 1) deepest = Math.max(deepest, levels + nesting(children[i]));
        if (children.length === 0) return Math.max(deepest, levels);
    }
}

function isColumn(named: FormulaNode): boolean {
    return columnIndex(named.text) !== -1;
}
