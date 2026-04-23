// @ts-expect-error - No types available for @formulajs/formulajs
import * as formulajs from '@formulajs/formulajs';
import type { FormulaArg, FormulaOutput } from '../../../types.ts';
import { ERROR_NAME } from '../../error.ts';
import SUPPORTED_FORMULAS from '../../supported-formulas.ts';

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

function func(symbol: string): FormulajsMethod {
    return function __formulaFunction(...params: FormulaArg[]): FormulaOutput {
        const resolved = resolveFormula(symbol.toUpperCase().split('.'));
        if (!resolved) {
            throw Error(ERROR_NAME);
        }
        const [receiver, method] = resolved;
        return method.apply(receiver, params);
    };
}

func.isFactory = true;
func.SYMBOL = SYMBOL;

export default func;
