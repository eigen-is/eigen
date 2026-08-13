// @ts-expect-error - No types available for @formulajs/formulajs
import * as formulajs from '@formulajs/formulajs';
import type { FormulaArg, FormulaOutput } from '../../../types';
import { ERROR_NAME } from '../../error';
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
};

function func(symbol: string): FormulajsMethod {
    const upper = symbol.toUpperCase();
    const override = OVERRIDES[upper];
    return function __formulaFunction(...params: FormulaArg[]): FormulaOutput {
        if (override) {
            const result = override(params);
            if (result !== undefined) return result;
        }
        const resolved = resolveFormula(upper.split('.'));
        if (!resolved) {
            throw Error(ERROR_NAME);
        }
        const [receiver, method] = resolved;
        return method.apply(receiver, params);
    };
}

func.isFactory = true as const;
func.SYMBOL = SYMBOL;

export default func;
