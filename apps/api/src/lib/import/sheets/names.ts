// A workbook's defined names, written into the formulas that use them while the xlsx reader reads each formula. The
// engine has no names, so `=SUM(Sales)` is stored as `=SUM(Data!$A$1:$A$9)` and still computes after an edit. The
// reader builds one inliner per workbook and hands it every formula, rule formula and list source with the sheet it
// sits on. A name that can't be written into a formula, such as one into another workbook, stays as written and counts.

import { functionCopy, inlineNames, iscelldata } from '@workspace/sheet/engine';
import type { LossCounter } from '../../document/transform/protocol';
import { MAX_FORMULA_LENGTH, withoutFuturePrefixes } from '../../ooxml/spreadsheetml';
import type { DefinedName } from './package';

// How many names deep a name may name another. A deeper one stays as written, and so does one that names itself,
// directly or round a circle.
const MAX_NAME_DEPTH = 8;

// A formula's text, and the sheet it sits on as the workbook writes the sheet's name.
export type NameInliner = (formula: string, sheet: string) => string;

// The walk over a formula's text is charged with `charge`, which throws past the import's budget.
export function nameInliner(
    names: DefinedName[],
    lost: LossCounter['lost'],
    charge: (chars: number) => void,
): NameInliner {
    if (names.length === 0) return (formula) => formula;
    // Excel compares names and sheet names without case. The first name of a key wins.
    const defined = new Map<string, DefinedName>();
    const spellings = new Set<string>();
    for (const name of names) {
        const key = nameKey(name.name, name.sheet);
        if (!defined.has(key)) defined.set(key, name);
        spellings.add(name.name.toLowerCase());
    }
    // A formula is walked only when one of its tokens is spelled as a name. So a defined name costs a formula that
    // doesn't use it one scan, however many names the workbook holds.
    const usesName = (formula: string) => {
        for (const [token] of formula.matchAll(TOKEN)) if (spellings.has(token.toLowerCase())) return true;
        return false;
    };
    // A bare name is the sheet's own before the workbook's. A name qualified with a sheet is that sheet's only.
    const find = (written: string, qualified: string | undefined, sheet: string) =>
        qualified === undefined
            ? (defined.get(nameKey(written, sheet)) ?? defined.get(nameKey(written, undefined)))
            : defined.get(nameKey(written, qualified));
    // The names inside a local name are read on its sheet, and those inside a workbook name on the sheet that uses it.
    // So a name's text is kept per sheet: inlined, or null where it can't be.
    const inlined = new Map<string, string | null>();
    const resolve = (name: DefinedName, sheet: string, depth: number): string | null => {
        const on = name.sheet ?? sheet;
        const key = `${nameKey(name.name, name.sheet)}\n${on.toLowerCase()}`;
        const known = inlined.get(key);
        if (known !== undefined) return known;
        if (depth > MAX_NAME_DEPTH) return null;
        const source = withoutFuturePrefixes(name.text.trim().replace(/^=/, ''));
        charge(source.length);
        let failed = !inlinable(source);
        const text = failed
            ? source
            : inlineNames(source, (written, qualified) => {
                  const inner = find(written, qualified, on);
                  const value = inner ? resolve(inner, qualified ?? on, depth + 1) : undefined;
                  if (value === null) failed = true;
                  return value ?? undefined;
              });
        const result = failed || text.length > MAX_FORMULA_LENGTH ? null : operand(text);
        inlined.set(key, result);
        return result;
    };
    return (formula, sheet) => {
        if (!usesName(formula)) return formula;
        charge(formula.length);
        const used = new Set<DefinedName>();
        const text = inlineNames(formula, (written, qualified) => {
            const name = find(written, qualified, sheet);
            if (!name) return undefined;
            const value = resolve(name, qualified ?? sheet, 0);
            if (value === null) lost('names-dropped', name);
            else used.add(name);
            return value ?? undefined;
        });
        if (text.length <= MAX_FORMULA_LENGTH) return text;
        for (const name of used) lost('names-dropped', name);
        return formula;
    };
}

// The walker ends a name at a space, a parenthesis, a quote, a comma, an operator, a sheet's `!` and a range's `:`. A
// token ends at each of them too, so every name the walker would inline is a token. A word in a string or a sheet's
// name is a token as well, which costs only a walk that inlines nothing.
const TOKEN = /[^\s"'(),&!:=<>+\-*/%^]+/gu;

function nameKey(name: string, sheet: string | undefined): string {
    return `${sheet?.toLowerCase() ?? ''}!${name.toLowerCase()}`;
}

const REF_ERROR = /^(?:.+!)?#REF!$/;
const LITERAL = /^(?:\d+(?:\.\d+)?(?:E[+-]?\d+)?|"(?:[^"]|"")*")$/i;

// A ref, a number or a string stands in a formula as it is, and any other formula in parentheses. Excel shows #REF! for
// a name whose range was deleted, and so does a formula that uses it.
function operand(text: string): string {
    if (REF_ERROR.test(text)) return '#REF!';
    return iscelldata(text) || LITERAL.test(text) ? text : `(${text})`;
}

// A name into another workbook (`[1]Prices!$A$1`), over several areas, or relative to the cell that uses it can't be
// written into a formula as text.
function inlinable(text: string): boolean {
    if (text === '' || /\[\d+\]/.test(text)) return false;
    // A copy moves a relative ref and leaves an absolute one.
    if (functionCopy(text, 1, 1) !== functionCopy(text, 0, 0)) return false;
    let depth = 0;
    let quote = '';
    for (const char of text) {
        if (quote) {
            if (char === quote) quote = '';
        } else if (char === '"' || char === "'") quote = char;
        else if (char === '(' || char === '{') depth++;
        else if (char === ')' || char === '}') depth--;
        else if (char === ',' && depth === 0) return false;
    }
    return true;
}
