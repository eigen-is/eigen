// @ts-expect-error - No types available for @formulajs/formulajs
import * as formulajs from '@formulajs/formulajs';
import { booleanDisplay, update } from '../../../format';
import type { FormulaArg, FormulaOutput } from '../../../types';
import { ERROR_NAME, ERROR_NUM, ERROR_VALUE } from '../../error';
import { xlookup, xmatch } from '../../functions/lookup';
import { maxifs, minifs } from '../../functions/statistical';
import { textjoin } from '../../functions/text';
import { toNumber } from '../../helper/number';
import { type FunctionArg, OMITTED } from '../../omitted';
import SUPPORTED_FORMULAS from '../../supported-formulas';

// Narrow view over the untyped formulajs module: a tree of callable functions keyed by name, a dotted
// name nested under a namespace or a function (`NORM.S.DIST`, `STDEV.S`).
type FormulajsMethod = (...params: FormulaArg[]) => FormulaOutput;
type FormulajsBranch = { [key: string]: FormulajsNode };
type FormulajsNode = (FormulajsMethod & FormulajsBranch) | FormulajsBranch;
const root = formulajs as FormulajsBranch;

// Excel's dotted names formulajs 2.9.3 nests. Not every nested path: formulajs aliases leave junk such
// as `STDEVS.P` and `CEILINGMATH.MATH`, which Excel doesn't know. T.DIST, T.TEST and F.TEST stay out:
// formulajs computes something else under those names, and #NAME? keeps an imported cell's cached value.
export const DOTTED_FUNCTIONS = [
    'BETA.DIST',
    'BETA.INV',
    'BINOM.DIST',
    'BINOM.DIST.RANGE',
    'BINOM.INV',
    'CEILING.MATH',
    'CEILING.PRECISE',
    'CHISQ.DIST',
    'CHISQ.DIST.RT',
    'CHISQ.INV',
    'CHISQ.INV.RT',
    'CHISQ.TEST',
    'CONFIDENCE.NORM',
    'CONFIDENCE.T',
    'COVARIANCE.P',
    'COVARIANCE.S',
    'ERF.PRECISE',
    'ERFC.PRECISE',
    'ERROR.TYPE',
    'EXPON.DIST',
    'F.DIST',
    'F.DIST.RT',
    'F.INV',
    'F.INV.RT',
    'FLOOR.MATH',
    'FLOOR.PRECISE',
    'GAMMA.DIST',
    'GAMMA.INV',
    'GAMMALN.PRECISE',
    'HYPGEOM.DIST',
    'ISO.CEILING',
    'LOGNORM.DIST',
    'LOGNORM.INV',
    'MODE.MULT',
    'MODE.SNGL',
    'NEGBINOM.DIST',
    'NETWORKDAYS.INTL',
    'NORM.DIST',
    'NORM.INV',
    'NORM.S.DIST',
    'NORM.S.INV',
    'PERCENTILE.EXC',
    'PERCENTILE.INC',
    'PERCENTRANK.EXC',
    'PERCENTRANK.INC',
    'POISSON.DIST',
    'QUARTILE.EXC',
    'QUARTILE.INC',
    'RANK.AVG',
    'RANK.EQ',
    'SKEW.P',
    'STDEV.P',
    'STDEV.S',
    'T.DIST.2T',
    'T.DIST.RT',
    'T.INV',
    'T.INV.2T',
    'VAR.P',
    'VAR.S',
    'WEIBULL.DIST',
    'WORKDAY.INTL',
    'Z.TEST',
];

// Resolve a dotted symbol like `NORM.S.DIST` to `[receiver, method]`. The
// receiver is the object on which the method must be invoked — formulajs methods
// use `this` internally (e.g. IMSUM calls this.IMREAL), so preserving the owning
// object is required for correct behavior.
function resolveFormula(symbolParts: string[]): [object, FormulajsMethod] | null {
    let receiver: FormulajsBranch = root;
    let node: FormulajsNode | undefined = receiver[symbolParts[0]];
    for (let i = 1; i < symbolParts.length; i += 1) {
        if (node == null) return null;
        receiver = node;
        node = receiver[symbolParts[i]];
    }
    return typeof node === 'function' ? [receiver, node] : null;
}

// Excel-correct overrides for formulajs functions whose behavior diverges from
// Excel in ways that real-world spreadsheets depend on. Each takes the raw
// `params` array and returns either a value (used directly), an Error (in-band
// error), or `undefined` to fall through to the formulajs implementation.
// formulajs reads an omitted significance as 0 and answers 0, where Excel's default is 1.
function withSignificance(method: FormulajsMethod) {
    return (params: FormulaArg[]) => (params.length === 1 ? method(params[0], 1) : undefined);
}

const OVERRIDES: Record<string, (params: FormulaArg[]) => FormulaOutput | undefined> = {
    // formulajs.VALUE rejects numbers with #VALUE!. Excel accepts numbers as a
    // pass-through (and booleans as 1/0). Without this fix, calendar templates
    // like `IF(VALUE(prev) > daysInMonth, "", prev+1)` are #VALUE! on every
    // numeric cell.
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

    'CEILING.MATH': withSignificance(formulajs.CEILING.MATH),
    'CEILING.PRECISE': withSignificance(formulajs.CEILING.PRECISE),
    'ISO.CEILING': withSignificance(formulajs.ISO.CEILING),
    'FLOOR.MATH': withSignificance(formulajs.FLOOR.MATH),
    'FLOOR.PRECISE': withSignificance(formulajs.FLOOR.PRECISE),

    // formulajs leaves both unimplemented; they are ERF and ERFC of one argument.
    'ERF.PRECISE': ([x]) => formulajs.ERF(x),
    'ERFC.PRECISE': ([x]) => formulajs.ERFC(x),
};

// Functions formulajs 2.9.3 lacks. Unlike an override, a result of `undefined` is a blank, not a fall-through,
// and an empty argument arrives as OMITTED, for each to read as Excel reads that parameter.
const FUNCTIONS: Record<string, (params: FunctionArg[]) => FormulaOutput> = {
    MAXIFS: maxifs,
    MINIFS: minifs,
    TEXTJOIN: textjoin,
    XLOOKUP: xlookup,
    XMATCH: xmatch,
};

export const SYMBOL = [...SUPPORTED_FORMULAS, ...DOTTED_FUNCTIONS, ...Object.keys(FUNCTIONS)];

// The text parameters of formulajs's text functions, by position, or all of them. Excel reads an empty argument
// as "" there and as 0 everywhere else: SUM(1,,2) is 3, ROUND(2.5,) 3, IF(TRUE,,1) 0, VLOOKUP's range_lookup FALSE.
const TEXT_PARAMETERS: Record<string, number[] | 'all'> = {
    CLEAN: [0],
    CODE: [0],
    CONCAT: 'all',
    CONCATENATE: 'all',
    EXACT: [0, 1],
    FIND: [0, 1],
    LEFT: [0],
    LEN: [0],
    LOWER: [0],
    MID: [0],
    NUMBERVALUE: [0, 1, 2],
    PROPER: [0],
    REGEXEXTRACT: [0, 1],
    REGEXMATCH: [0, 1],
    REGEXREPLACE: [0, 1, 2],
    REPLACE: [0, 3],
    REPT: [0],
    RIGHT: [0],
    SEARCH: [0, 1],
    SPLIT: [0, 1],
    SUBSTITUTE: [0, 1, 2],
    TRIM: [0],
    UNICODE: [0],
    UPPER: [0],
};

function func(symbol: string): (...params: FunctionArg[]) => FormulaOutput {
    const upper = symbol.toUpperCase();
    const own = FUNCTIONS[upper];
    if (own) return (...params) => own(params);
    const override = OVERRIDES[upper];
    const text = TEXT_PARAMETERS[upper];
    const empty = (i: number) => (text === 'all' || text?.includes(i) ? '' : 0);
    return function __formulaFunction(...args: FunctionArg[]): FormulaOutput {
        const params = args.map((arg, i) => (arg === OMITTED ? empty(i) : arg));
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
