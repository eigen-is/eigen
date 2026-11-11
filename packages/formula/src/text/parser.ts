// The formula parser: text to the immutable tree, by precedence climbing over one table of binding powers. One
// parser reads both grammars. parseA1 reads what a person types at a cell, resolving sheet names to ids and turning
// relative references into offsets from that cell; parseStored reads the stored shape text, where they already are.
// Text that does not parse is a result, never a throw, and the limits on length, nesting and arguments are kept here.

import { GRID_COLUMNS, GRID_ROWS } from './a1';
import { continuesWord, lexAt, Token, tokenEnd, tokenKind } from './lexer';
import type { FormulaNode } from './tree';
import { branch, EMPTY, leaf, NodeKind, RefFlag, RefKind, referenceNode, SheetKind } from './tree';

export const MAX_FORMULA_LENGTH = 8192;
export const MAX_NESTING = 64;
export const MAX_ARGUMENTS = 255;

export type SheetFinder = (name: string) => { readonly id: string } | undefined;

export type ParseFailure = {
    readonly reason: 'syntax' | 'too-long' | 'too-deep' | 'too-many-arguments';
    readonly at: number;
};

export type A1Range = {
    readonly sheet?: string;
    readonly start: { readonly col: number; readonly row: number };
    readonly end: { readonly col: number; readonly row: number };
};

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

const LEG_CELL = 1;
const LEG_COLUMN = 2;
const LEG_ROW = 3;

// What a space between two operands can intersect: whatever may yield a reference.
function yieldsReference(node: FormulaNode): boolean {
    switch (node.kind) {
        case NodeKind.Ref:
        case NodeKind.Name:
        case NodeKind.Call:
        case NodeKind.Invoke:
        case NodeKind.Paren:
            return true;
        case NodeKind.Postfix:
            return node.op === Token.Hash;
        case NodeKind.Binary:
            return node.op === Token.Colon || node.op === Token.Space || node.op === Token.Comma;
        default:
            return false;
    }
}

function returnsFunction(node: FormulaNode): boolean {
    return node.kind === NodeKind.Call || node.kind === NodeKind.Invoke || node.kind === NodeKind.Paren;
}

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
    // What the leg and sheet readers found last: they return a position, so their findings land here.
    private legKind = 0;
    private legRow = 0;
    private legColumn = 0;
    private legFlags = 0;
    private index = 0;
    private absolute = false;
    private sheetKind: FormulaNode['sheetKind'] = SheetKind.Host;
    private sheet = '';

    public constructor(text: string, stored: boolean, hostRow: number, hostColumn: number, findSheet: SheetFinder) {
        this.text = text;
        this.stored = stored;
        this.hostRow = hostRow;
        this.hostColumn = hostColumn;
        this.findSheet = findSheet;
    }

    public formula(): FormulaNode | ParseFailure {
        if (this.text.length > MAX_FORMULA_LENGTH) return { reason: 'too-long', at: MAX_FORMULA_LENGTH };
        if (this.text.charCodeAt(0) === 61) {
            this.end = 1;
            this.next();
        }
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
            if (op === Token.Open && (space !== '' || !returnsFunction(left))) power = 0;
            if (power === 0) {
                if (space === '' || !this.startsReference() || !yieldsReference(left)) break;
                op = Token.Space;
                power = BINDING[op];
            }
            if (power < minPower) break;
            if (op === Token.Hash && !yieldsReference(left)) return this.fail();
            if (op === Token.Hash || op === Token.Percent) {
                this.next();
                left = branch(NodeKind.Postfix, op, '', [left], space, '');
                height += 1;
                continue;
            }
            if (op === Token.Open) {
                const called = [left];
                left = branch(NodeKind.Invoke, 0, '', called, '', this.argumentList(called));
                height = Math.max(height, this.height) + 1;
                continue;
            }
            // An intersection is written as the whitespace itself, so its right operand starts with none.
            if (op === Token.Space) this.space = '';
            else this.next();
            left = branch(NodeKind.Binary, op, '', [left, this.expression(power + 1, union)], space, '');
            height = Math.max(height, this.height);
        }
        // A postfix operator wraps what was already read, so the limit on nesting is checked on the way out too.
        if (height > MAX_NESTING) return this.fail('too-deep');
        this.height = height;
        return left;
    }

    private startsReference(): boolean {
        const { kind } = this;
        if (kind === Token.Number) return this.text.charCodeAt(this.end) === 58;
        return kind === Token.Word || kind === Token.Quote || kind === Token.Bracket || kind === Token.Open;
    }

    private operand(union: boolean): FormulaNode {
        const { text, kind, pos, end, space } = this;
        this.height = 0;
        switch (kind) {
            case Token.Number: {
                if (text.charCodeAt(end) === 58) {
                    const rows = this.reference(space, SheetKind.Host, '');
                    if (rows) return rows;
                }
                let value = Number(text.slice(pos, end));
                // A literal keeps 15 digits, as Excel stores it.
                if (end - pos > 15) value = Number(value.toPrecision(15));
                if (value === Infinity) return this.fail();
                this.next();
                return leaf(NodeKind.Number, value, '', space, SheetKind.Host, '');
            }
            case Token.String: {
                const content = text.slice(pos + 1, end - 1);
                this.next();
                return leaf(
                    NodeKind.String,
                    0,
                    content.includes('"') ? content.replaceAll('""', '"') : content,
                    space,
                    SheetKind.Host,
                    '',
                );
            }
            case Token.Error:
                this.next();
                return leaf(NodeKind.Error, 0, text.slice(pos, end).toUpperCase(), space, SheetKind.Host, '');
            case Token.Plus:
            case Token.Minus:
            case Token.At: {
                if (!this.enter()) return EMPTY;
                this.next();
                const child = this.expression(PREFIX_POWER, union);
                this.depth -= 1;
                this.height += 1;
                return branch(NodeKind.Prefix, kind, '', [child], space, '');
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
                return branch(NodeKind.Paren, 0, '', [child], space, spaceEnd);
            }
            case Token.BraceOpen:
                return this.array(space);
            case Token.Word:
                return this.word(space);
            case Token.Quote:
                if (text.charCodeAt(end) !== 33) return this.fail();
                this.nameSheet(this.unquoted(pos, end));
                return this.prefixed(space, end, this.sheetKind, this.sheet);
            case Token.Bracket: {
                if (this.stored) {
                    if (text.charCodeAt(end) !== 33) return this.fail();
                    return this.prefixed(space, end, SheetKind.Id, text.slice(pos + 1, end - 1));
                }
                // Another workbook as a file writes it: its index, then the sheet, if any.
                const sheet = lexAt(text, end);
                const bang = tokenKind(sheet) === Token.Word ? tokenEnd(sheet) : end;
                if (text.charCodeAt(bang) !== 33) return this.fail();
                return this.prefixed(space, bang, SheetKind.External, text.slice(pos, bang));
            }
            default:
                return this.fail();
        }
    }

    // A word is whole before it is anything: a function before (, a sheet before !, else a reference, a boolean, the
    // first sheet of a 3-D reference, or a name.
    private word(space: string): FormulaNode {
        const { text, pos, end } = this;
        const after = text.charCodeAt(end);
        if (after === 40) {
            const name = text.slice(pos, end).toUpperCase();
            this.next();
            const args: FormulaNode[] = [];
            const spaceEnd = this.argumentList(args);
            this.height += 1;
            return branch(NodeKind.Call, 0, name, args, space, spaceEnd);
        }
        if (after === 33) {
            this.nameSheet(text.slice(pos, end));
            return this.prefixed(space, end, this.sheetKind, this.sheet);
        }
        const reference = this.reference(space, SheetKind.Host, '');
        if (reference) return reference;
        if (end - pos === 4 || end - pos === 5) {
            const upper = text.slice(pos, end).toUpperCase();
            if (upper === 'TRUE' || upper === 'FALSE') {
                this.next();
                return leaf(NodeKind.Boolean, upper === 'TRUE' ? 1 : 0, '', space, SheetKind.Host, '');
            }
        }
        if (after === 58 && !this.stored) {
            const last = lexAt(text, end + 1);
            if (tokenKind(last) === Token.Word && text.charCodeAt(tokenEnd(last)) === 33) {
                return this.prefixed(space, tokenEnd(last), SheetKind.Span, text.slice(pos, tokenEnd(last)));
            }
        }
        return this.name(space, SheetKind.Host, '');
    }

    // A name must not read as a reference in the other grammar, or it would come back as one: typed, it is stored
    // in lower case, which the stored grammar never reads as R1C1; stored, it is refused.
    private name(space: string, sheetKind: FormulaNode['sheetKind'], sheet: string): FormulaNode {
        const { pos, end } = this;
        let name = this.text.slice(pos, end);
        if (name.includes('$') || name.includes('[')) return this.fail();
        if (this.stored) {
            if (this.a1Leg(pos) === end && this.legKind === LEG_CELL) return this.fail();
        } else if (this.storedLeg(pos) === end) {
            name = name.toLowerCase();
        }
        this.next();
        return leaf(NodeKind.Name, 0, name, space, sheetKind, sheet);
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
        return branch(NodeKind.Array, columns, '', elements, space, spaceEnd);
    }

    // The name inside a quoted token, where a quote is written twice.
    private unquoted(start: number, end: number): string {
        const name = this.text.slice(start + 1, end - 1);
        return name.includes("'") ? name.replaceAll("''", "'") : name;
    }

    // Which sheet a prefix names, into sheetKind and sheet. Only typed text is looked up: stored text names by id.
    private nameSheet(name: string): void {
        this.sheet = name;
        if (name.includes('[')) {
            this.sheetKind = SheetKind.External;
        } else if (name.includes(':')) {
            this.sheetKind = SheetKind.Span;
        } else {
            const found = this.stored ? undefined : this.findSheet(name);
            this.sheetKind = found ? SheetKind.Id : SheetKind.Name;
            if (found) this.sheet = found.id;
        }
    }

    // What follows the ! of a sheet prefix: a reference, a name scoped to the sheet, or the #REF! a deletion left.
    private prefixed(space: string, bang: number, sheetKind: FormulaNode['sheetKind'], sheet: string): FormulaNode {
        this.end = bang + 1;
        this.next();
        if (this.space !== '') return this.fail();
        if (this.kind === Token.Error) {
            const error = this.text.slice(this.pos, this.end).toUpperCase();
            this.next();
            return leaf(NodeKind.Error, 0, error, space, sheetKind, sheet);
        }
        if (this.kind !== Token.Word && this.kind !== Token.Number) return this.fail();
        const reference = this.reference(space, sheetKind, sheet);
        if (reference) return reference;
        return this.kind === Token.Word ? this.name(space, sheetKind, sheet) : this.fail();
    }

    // A reference at the current token: a cell, or two legs of one kind around a colon, such as A1:B2, A:C or 1:5.
    // Null when the token is none. A second sheet prefix must repeat the first.
    private reference(space: string, sheetKind: FormulaNode['sheetKind'], sheet: string): FormulaNode | null {
        const { text } = this;
        const end = this.leg(this.pos);
        if (end !== this.end) return null;
        const kind = this.legKind;
        const row = this.legRow;
        const column = this.legColumn;
        const flags = this.legFlags;
        if (text.charCodeAt(end) === 58) {
            let second = end + 1;
            let legEnd = this.leg(second);
            if (legEnd === -1 || text.charCodeAt(legEnd) === 33) {
                const prefix = lexAt(text, second);
                const quoted = tokenKind(prefix) === Token.Quote;
                legEnd = -1;
                if ((quoted || tokenKind(prefix) === Token.Word) && text.charCodeAt(tokenEnd(prefix)) === 33) {
                    this.nameSheet(
                        quoted ? this.unquoted(second, tokenEnd(prefix)) : text.slice(second, tokenEnd(prefix)),
                    );
                    if (this.sheetKind !== sheetKind || this.sheet !== sheet) return this.fail();
                    second = tokenEnd(prefix) + 1;
                    legEnd = this.leg(second);
                }
            }
            const after = text.charCodeAt(legEnd);
            if (legEnd !== -1 && this.legKind === kind && after !== 40 && after !== 33 && !continuesWord(after)) {
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
        if (text.charCodeAt(at) === 36) {
            flags = RefFlag.ColumnAbsolute;
            at += 1;
        }
        const lettersAt = at;
        let column = 0;
        for (;;) {
            const letter = (text.charCodeAt(at) | 32) - 96;
            if (!(letter >= 1 && letter <= 26)) break;
            column = column * 26 + letter;
            at += 1;
        }
        const letters = at - lettersAt;
        if (letters === 0) {
            if (flags !== 0) flags = RefFlag.RowAbsolute;
        } else if (text.charCodeAt(at) === 36) {
            flags |= RefFlag.RowAbsolute;
            at += 1;
        }
        const digitsAt = at;
        let row = 0;
        for (;;) {
            const digit = text.charCodeAt(at) - 48;
            if (!(digit >= 0 && digit <= 9)) break;
            row = row * 10 + digit;
            at += 1;
        }
        const digits = at - digitsAt;
        this.legKind = 0;
        if (letters > 3 || digits > 7 || letters + digits === 0) return -1;
        if (letters > 0 && column > GRID_COLUMNS) return -1;
        if (digits > 0 ? row < 1 || row > GRID_ROWS : (flags & RefFlag.RowAbsolute) !== 0) return -1;
        this.legKind = digits === 0 ? LEG_COLUMN : letters === 0 ? LEG_ROW : LEG_CELL;
        this.legFlags = flags;
        this.legRow = digits === 0 ? 0 : flags & RefFlag.RowAbsolute ? row - 1 : row - 1 - this.hostRow;
        this.legColumn = letters === 0 ? 0 : flags & RefFlag.ColumnAbsolute ? column - 1 : column - 1 - this.hostColumn;
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
        if (text.charCodeAt(at) === 82) {
            at = this.storedIndex(at + 1);
            if (at === -1) return -1;
            row = this.index;
            if (this.absolute) flags = RefFlag.RowAbsolute;
            this.legKind = LEG_ROW;
        }
        if (text.charCodeAt(at) === 67) {
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
        const bracket = text.charCodeAt(at) === 91;
        if (bracket) at += 1;
        const negative = bracket && text.charCodeAt(at) === 45;
        if (negative) at += 1;
        const digitsAt = at;
        let value = 0;
        for (;;) {
            const digit = text.charCodeAt(at) - 48;
            if (!(digit >= 0 && digit <= 9)) break;
            value = value * 10 + digit;
            at += 1;
        }
        const digits = at - digitsAt;
        if (digits > 7) return -1;
        this.absolute = !bracket && digits > 0;
        if (bracket) {
            if (digits === 0 || text.charCodeAt(at) !== 93) return -1;
            this.index = negative ? -value : value;
            return at + 1;
        }
        if (digits > 0 && value < 1) return -1;
        this.index = digits > 0 ? value - 1 : 0;
        return at;
    }
}

// A formula as typed at a cell, such as =SUM(A1:B2)*Sheet2!$C$1, with the row and column from 0.
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

// The reference that starts at `from` in typed text, and where it ends. Its sheet, if any, stays a name.
export function referenceAt(text: string, from: number): { readonly node: FormulaNode; readonly end: number } | null {
    return new Parser(text, false, 0, 0, noSheet).referenceFrom(from);
}

// A cell or a rectangle with an optional sheet, such as Sheet1!$A$1:B3, as indexes from 0. Null for anything else.
export function parseA1Range(range: string): A1Range | null {
    const found = referenceAt(range, 0);
    if (!found || found.end !== range.length) return null;
    const { node } = found;
    if (node.op > RefKind.Range || node.sheetKind > SheetKind.Name) return null;
    const start = { col: node.column, row: node.row };
    return {
        sheet: node.sheetKind === SheetKind.Name ? node.sheet : undefined,
        start,
        end: node.op === RefKind.Cell ? { ...start } : { col: node.column2, row: node.row2 },
    };
}
