// The callable behind each function name the engine registers: formulajs's, found by its name or dotted path, an
// override where formulajs's result differs from Excel's, or the engine's own. It hands an empty argument slot on as
// what Excel reads there. The function registry in evaluate-by-operator builds one callable per name in SYMBOL.

// @ts-expect-error - No types available for @formulajs/formulajs
import * as formulajs from '@formulajs/formulajs';
import { numberDisplay } from '@workspace/formula/format';
import { booleanDisplay, isValidNumberFormat } from '../../../format';
import type { FormulaArg, FormulaOutput } from '../../../types';
import { ERROR_NAME, ERROR_NUM, ERROR_VALUE } from '../../error';
import { errorType, iserr, iserror } from '../../functions/information';
import { iferror, ifs, switchValue } from '../../functions/logical';
import { columns, hlookup, index, match, rows, vlookup, xlookup, xmatch } from '../../functions/lookup';
import { aggregate, averageif, averageifs, errorsAsText, maxifs, minifs } from '../../functions/statistical';
import { concatenate, textjoin } from '../../functions/text';
import { referenceGrid } from '../../helper/array';
import { toNumber } from '../../helper/number';
import type { FunctionArg } from '../../omitted';
import { OMITTED } from '../../omitted';
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

// A name, dotted ones such as `NORM.S.DIST` included, as its method and the object that owns it, which the call needs:
// formulajs's methods call each other through `this`, as IMSUM calls this.IMREAL.
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

// formulajs reads an omitted significance as 0 and answers 0, where Excel's default is 1.
function withSignificance(method: FormulajsMethod) {
    return (params: FormulaArg[]) => (params.length === 1 ? method(params[0], 1) : undefined);
}

// formulajs's COUNTIF family, with each error cell as the text it shows, which a criterion such as "#N/A" matches. It
// answers 0 over a range a delete cut to one cell, so `isRange`'s arguments reach it as rows of cells.
function byText(method: FormulajsMethod, isRange: (position: number) => boolean) {
    return (params: FormulaArg[]) =>
        method(...params.map((param, i) => errorsAsText(isRange(i) ? referenceGrid(param) : param)));
}

// formulajs reads a start_num below 1 as 1, where Excel's is #VALUE!, an empty one too.
function startAboveZero(params: FormulaArg[]): FormulaOutput | undefined {
    if (params.length < 3) return undefined;
    const start = params[2];
    if (!((toNumber(start ?? 0) ?? Number.NaN) >= 1)) throw Error(ERROR_VALUE);
    return undefined;
}

// Where formulajs's answer differs from Excel's. A result of `undefined` falls through to formulajs.
const OVERRIDES: Record<string, (params: FormulaArg[]) => FormulaOutput | undefined> = {
    // formulajs's VALUE is #VALUE! for a number, which Excel hands through, and a boolean as 1 or 0.
    VALUE(params) {
        const v = params[0];
        if (typeof v === 'number') return v;
        if (typeof v === 'boolean') return v ? 1 : 0;
        return undefined;
    },

    // formulajs leaves TEXT unimplemented. It formats through the numfmt masks the grid renders with, so `TEXT(x, fa)`
    // reads like a cell under that format.
    TEXT(params) {
        const [value, mask] = params;
        if (params.length < 2) throw Error(ERROR_VALUE);
        // An empty format_text, typed or a blank cell, is empty text: TEXT(5,"") = "".
        if (mask == null || mask === '') return '';
        if (!isValidNumberFormat(String(mask))) throw Error(ERROR_VALUE);
        // Excel hands a boolean through as its text, whatever the mask: TEXT(TRUE,"0") = "TRUE".
        if (typeof value === 'boolean') return numberDisplay(booleanDisplay(value), String(mask));
        // A blank argument is 0, as in Excel.
        const num = toNumber(value ?? 0);
        // Non-numeric text keeps its text, formatted by the mask's text section: TEXT("abc","0") = "abc".
        return numberDisplay(num !== undefined && Number.isFinite(num) ? num : String(value), String(mask));
    },

    CONCAT: concatenate,
    CONCATENATE: concatenate,

    FIND: startAboveZero,
    SEARCH: startAboveZero,

    // formulajs answers NaN for text it can't read, which shows as a blank, where Excel's is #VALUE!.
    NUMBERVALUE(params) {
        const result = formulajs.NUMBERVALUE(...params);
        if (Number.isNaN(result)) throw Error(ERROR_VALUE);
        return result;
    },

    INDEX: index,

    AGGREGATE: aggregate,
    COUNTIF: byText(formulajs.COUNTIF, (i) => i === 0),
    COUNTIFS: byText(formulajs.COUNTIFS, (i) => i % 2 === 0),
    SUMIF: byText(formulajs.SUMIF, (i) => i !== 1),
    SUMIFS: byText(formulajs.SUMIFS, (i) => i === 0 || i % 2 === 1),

    'CEILING.MATH': withSignificance(formulajs.CEILING.MATH),
    'CEILING.PRECISE': withSignificance(formulajs.CEILING.PRECISE),
    'ISO.CEILING': withSignificance(formulajs.ISO.CEILING),
    'FLOOR.MATH': withSignificance(formulajs.FLOOR.MATH),
    'FLOOR.PRECISE': withSignificance(formulajs.FLOOR.PRECISE),

    // formulajs leaves both unimplemented; they are ERF and ERFC of one argument.
    'ERF.PRECISE': ([x]) => formulajs.ERF(x),
    'ERFC.PRECISE': ([x]) => formulajs.ERFC(x),
};

// Functions formulajs 2.9.3 lacks, and ones the engine replaces whole, such as IFERROR. Unlike an override, a result
// of `undefined` is a blank, not a fall-through, and an empty argument arrives as OMITTED, for each to read as Excel
// reads that parameter.
const FUNCTIONS: Record<string, (params: FunctionArg[]) => FormulaOutput> = {
    AVERAGEIF: averageif,
    AVERAGEIFS: averageifs,
    COLUMNS: columns,
    'ERROR.TYPE': errorType,
    HLOOKUP: hlookup,
    IFERROR: iferror,
    IFS: ifs,
    ISERR: iserr,
    ISERROR: iserror,
    MATCH: match,
    MAXIFS: maxifs,
    MINIFS: minifs,
    ROWS: rows,
    SWITCH: switchValue,
    TEXTJOIN: textjoin,
    VLOOKUP: vlookup,
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
    TEXT: [1],
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
