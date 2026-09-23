// @ts-expect-error - No types available for @formulajs/formulajs
import * as formulajs from '@formulajs/formulajs';
import { booleanDisplay, update } from '../../../format';
import type { FormulaArg, FormulaOutput } from '../../../types';
import { ERROR_NAME, ERROR_NUM, ERROR_VALUE } from '../../error';
import { toNumber } from '../../helper/number';
import SUPPORTED_FORMULAS from '../../supported-formulas';

export const SYMBOL = SUPPORTED_FORMULAS;

// Narrow view over the untyped formulajs module: a tree of callable functions
// keyed by name, optionally nested one level deep (e.g. `FINANCIAL.NPV`).
type FormulajsMethod = (...params: FormulaArg[]) => FormulaOutput;
type FormulajsNode = FormulajsMethod | { [key: string]: FormulajsNode };
const root = formulajs as Record<string, FormulajsNode>;

// Resolve a dotted symbol like `FINANCIAL.NPV` to `[receiver, method]`. The
// receiver is the object on which the method must be invoked — formulajs methods
// use `this` internally (e.g. IMSUM calls this.IMREAL), so preserving the owning
// object is required for correct behavior.
function resolveFormula(symbolParts: string[]): [object, FormulajsMethod] | null {
    let receiver: Record<string, FormulajsNode> = root;
    let node: FormulajsNode | undefined = receiver[symbolParts[0]];
    for (let i = 1; i < symbolParts.length; i += 1) {
        if (typeof node !== 'object' || node == null) return null;
        receiver = node;
        node = receiver[symbolParts[i]];
    }
    return typeof node === 'function' ? [receiver, node] : null;
}

// Excel-correct overrides for formulajs functions whose behavior diverges from
// Excel in ways that real-world spreadsheets depend on. Each takes the raw
// `params` array and returns either a value (used directly), an Error (in-band
// error), or `undefined` to fall through to the formulajs implementation.
const OVERRIDES: Record<string, (params: FormulaArg[]) => FormulaOutput | undefined> = {
    // formulajs.VALUE rejects numbers with #VALUE!. Excel accepts numbers as a
    // pass-through (and booleans as 1/0). Without this fix, calendar templates
    // like `IF(VALUE(prev) > daysInMonth, "", prev+1)` always take the fallback
    // branch because VALUE(numberCell) errors and the comparison silently
    // coerces the Error to false.
    VALUE(params) {
        const v = params[0];
        if (typeof v === 'number') return v;
        if (typeof v === 'boolean') return v ? 1 : 0;
        return undefined;
    },

    // formulajs ships TEXT as `throw new Error('TEXT is not implemented')`, so every
    // `=TEXT(...)` was #ERROR!. Format through `update()` — the same numfmt masks the
    // grid renders cells with, so `TEXT(x, fa)` reads like the formatted cell it mimics.
    TEXT(params) {
        const [value, mask] = params;
        if (value instanceof Error) return value;
        if (mask instanceof Error) return mask;
        if (mask === undefined || mask === null || mask === '') throw Error(ERROR_VALUE);
        // Excel hands a boolean through as its text, whatever the mask: TEXT(TRUE,"0") = "TRUE".
        if (typeof value === 'boolean') return update(String(mask), booleanDisplay(value));
        // A blank argument is 0, as in Excel.
        const num = toNumber(value ?? 0);
        // Non-numeric text keeps its text, formatted by the mask's text section: TEXT("abc","0") = "abc".
        return update(String(mask), num !== undefined && Number.isFinite(num) ? num : String(value));
    },
};

function func(symbol: string): FormulajsMethod {
    const upper = symbol.toUpperCase();
    const override = OVERRIDES[upper];
    return function __formulaFunction(...params: FormulaArg[]): FormulaOutput {
        let result = override?.(params);
        if (result === undefined) {
            const resolved = resolveFormula(upper.split('.'));
            if (!resolved) {
                throw Error(ERROR_NAME);
            }
            const [receiver, method] = resolved;
            result = method.apply(receiver, params);
        }
        // formulajs hands an overflow back as Infinity; Excel shows #NUM!, as the operators do.
        if (result === Infinity || result === -Infinity) {
            throw Error(ERROR_NUM);
        }
        return result;
    };
}

func.SYMBOL = SYMBOL;

export default func;
