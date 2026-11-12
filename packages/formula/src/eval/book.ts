// What a function's body gets of the workbook itself, for the few things no argument carries: whether a cell holds
// a formula and its text, how many sheets there are, and a reference that is written in a text. A book is asked
// about one cell, and the call wrapper picks it: the first cell of the reference the row was given, or the cell of
// the formula. So no member takes a place, and a body reaches no cell its row does not name. A book is the one of
// its call's frame, so a formula computed while the body runs aims another. What a book answers can change with no
// value changing, so every row that takes one is computed again in every pass that has a write.

import { isUnparsed, parseA1, parseStored } from '../text/parser';
import { printA1 } from '../text/printer';
import { findSheetByName, quoteSheetName } from '../text/sheet-name';
import { NodeKind, SheetKind } from '../text/tree';
import type { FormulaError } from '../values/errors';
import { REF } from '../values/errors';
import type { Reference, Scalar } from '../values/value';
import { isReference } from '../values/value';
import type { Evaluator } from './evaluator';
import type { Entry, Held } from './signature';
import { Prepare } from './signature';

export class Book {
    // Truly private, where a reader's fields are private by type alone: a key in brackets reaches neither.
    readonly #ctx: Evaluator;
    // The cell the book is asked about, or null for the cell of the formula that asks.
    #cell: Reference | null = null;

    public constructor(ctx: Evaluator) {
        this.#ctx = ctx;
    }

    // Makes `book` the book of a call of `entry`, whose `count` written arguments are read into `held`.
    public static aim(book: Book, entry: Entry, held: readonly Held[], count: number): Book {
        const at = entry.slots.findIndex((slot) => slot.prepare === Prepare.Reference);
        const given = at < 0 || at >= count ? undefined : held[at];
        book.#cell = isReference(given) ? given : null;
        return book;
    }

    // The formula of the cell as it reads there, or null when it holds none.
    public formula(): string | null {
        const { workbook } = this.#ctx;
        const { sheet, top, left } = this.#asked();
        const column = workbook.sheets[sheet].columns[left];
        const shape = column === undefined || top >= column.length ? 0 : column.shape[top];
        if (shape === 0) return null;
        const { tree, text } = workbook.shapes.shape(shape);
        // Text that did not parse is kept as it was typed, behind a second =.
        if (tree === null) return isUnparsed(text) ? text.slice(1) : text;
        return printA1(tree, top, left, (id) => workbook.sheet(id)?.name);
    }

    // The value of the cell, its own formula computed first. A row that was given no reference reads nothing:
    // the formula's own cell is still being computed, so it is a blank.
    public value(): Scalar {
        if (this.#cell === null) return null;
        const { sheet, top, left } = this.#cell;
        return this.#ctx.recalc.valueOf(this.#ctx.workbook.sheets[sheet], top, left);
    }

    // The name of the cell's sheet when that is another than the formula's, and else null.
    public elsewhere(): string | null {
        const { sheet } = this.#asked();
        return sheet === this.#ctx.recalc.running().sheet ? null : this.#ctx.workbook.sheets[sheet].name;
    }

    public sheets(): number {
        return this.#ctx.workbook.sheets.length;
    }

    // The reference a text spells, read from the formula's own cell: as A1 when `a1`, and else as R1C1, where
    // R[1]C is the cell below. A text that is no one reference, or names no sheet of the workbook, is #REF!.
    public refer(text: string, a1: boolean): Reference | FormulaError {
        const ctx = this.#ctx;
        const { sheets } = ctx.workbook;
        const host = ctx.recalc.running();
        let sheet = sheets[host.sheet];
        let tree = a1 ? parseA1(`=${text}`, host.top, host.left, (name) => findSheetByName(sheets, name)) : null;
        if (!a1) {
            // The stored form of a reference is R1C1 with no sheet, so the name before the ! is read here, by the
            // rule a typed formula's is: in quotes, or one word that may stand bare.
            const bang = text.lastIndexOf('!');
            const quoted = bang > 1 && text.startsWith("'") && text[bang - 1] === "'";
            const name = quoted ? text.slice(1, bang - 1).replaceAll("''", "'") : text.slice(0, Math.max(bang, 0));
            const named = bang < 0 ? sheet : findSheetByName(sheets, name);
            if (named === undefined || (bang >= 0 && !quoted && quoteSheetName(name) !== name)) return REF;
            sheet = named;
            tree = parseStored(`=${text.slice(bang + 1).toUpperCase()}`);
        }
        if (tree === null || 'reason' in tree || tree.kind !== NodeKind.Ref || tree.space !== '') return REF;
        if (tree.sheetKind !== SheetKind.Host && tree.sheetKind !== SheetKind.Id) return REF;
        const found = ctx.evaluate(tree, sheet, host.top, host.left);
        return isReference(found) ? found : REF;
    }

    #asked(): Reference {
        return this.#cell ?? this.#ctx.recalc.running();
    }
}
