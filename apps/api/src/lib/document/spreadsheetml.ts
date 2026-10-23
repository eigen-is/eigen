// Excel's vocabulary, which the xlsx writer writes and the xlsx reader recognises, one source both ways. The OOXML every
// format shares is core/ooxml.ts.

// Day 0 of Excel's 1900 date system is 1899-12-30, as Lotus 1-2-3 counted a 29 February 1900 that never was.
export const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
export const DAY_MS = 86_400_000;
// A 1904 workbook counts its days from 1904-01-01, 1,462 days after the 1900 system's day 0.
export const DAYS_1904 = 1462;

// A sheet's defaults when its sheetFormatPr names none (ECMA-376 Part 1 § 18.3.1.81): baseColWidth's 8 digits, and
// Excel's row at Calibri 11 in points.
export const DEFAULT_BASE_COL_WIDTH = 8;
export const DEFAULT_ROW_HEIGHT_PT = 15;

// A number as a rule's operand holds it, unquoted; anything else is a reference, a function or a quoted string.
export const NUMERIC = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;

type DvOperator =
    | 'between'
    | 'notBetween'
    | 'equal'
    | 'notEqual'
    | 'greaterThan'
    | 'lessThan'
    | 'greaterThanOrEqual'
    | 'lessThanOrEqual';

// A data validation's operator and the engine's type2 for it (DataVerificationRule), one list both ways; a date rule
// words its comparisons as the date dialog does.
const DV_COMMON_OPERATORS: [DvOperator, string][] = [
    ['between', 'between'],
    ['notBetween', 'notBetween'],
    ['equal', 'equal'],
    ['notEqual', 'notEqualTo'],
];
const DV_OPERATORS: [DvOperator, string][] = [
    ...DV_COMMON_OPERATORS,
    ['greaterThan', 'moreThanThe'],
    ['lessThan', 'lessThan'],
    ['greaterThanOrEqual', 'greaterOrEqualTo'],
    ['lessThanOrEqual', 'lessThanOrEqualTo'],
];
const DV_DATE_OPERATORS: [DvOperator, string][] = [
    ...DV_COMMON_OPERATORS,
    ['greaterThan', 'laterThan'],
    ['lessThan', 'earlierThan'],
    ['greaterThanOrEqual', 'noEarlierThan'],
    ['lessThanOrEqual', 'noLaterThan'],
];

export const DV_OPERATOR = new Map<string, string>(DV_OPERATORS);
export const DV_DATE_OPERATOR = new Map<string, string>(DV_DATE_OPERATORS);
export const DV_XLSX_OPERATOR = new Map<string, DvOperator>(DV_OPERATORS.map(([operator, type2]) => [type2, operator]));
export const DV_XLSX_DATE_OPERATOR = new Map<string, DvOperator>(
    DV_DATE_OPERATORS.map(([operator, type2]) => [type2, operator]),
);

// The functions Excel added after 2007, which a file stores as `_xlfn.NAME`, so an Excel that lacks one shows #NAME?
// rather than misreading it. Excel reads one without the prefix as an unknown name, so the writer must add it back.
const FUTURE_FUNCTIONS = new Set([
    'ACOT',
    'ACOTH',
    'AGGREGATE',
    'ANCHORARRAY',
    'ARABIC',
    'ARRAYTOTEXT',
    'BASE',
    'BETA.DIST',
    'BETA.INV',
    'BINOM.DIST',
    'BINOM.DIST.RANGE',
    'BINOM.INV',
    'BITAND',
    'BITLSHIFT',
    'BITOR',
    'BITRSHIFT',
    'BITXOR',
    'BYCOL',
    'BYROW',
    'CEILING.MATH',
    'CEILING.PRECISE',
    'CHISQ.DIST',
    'CHISQ.DIST.RT',
    'CHISQ.INV',
    'CHISQ.INV.RT',
    'CHISQ.TEST',
    'CHOOSECOLS',
    'CHOOSEROWS',
    'COMBINA',
    'CONCAT',
    'CONFIDENCE.NORM',
    'CONFIDENCE.T',
    'COT',
    'COTH',
    'COVARIANCE.P',
    'COVARIANCE.S',
    'CSC',
    'CSCH',
    'DAYS',
    'DECIMAL',
    'DROP',
    'ERF.PRECISE',
    'ERFC.PRECISE',
    'EXPAND',
    'EXPON.DIST',
    'F.DIST',
    'F.DIST.RT',
    'F.INV',
    'F.INV.RT',
    'F.TEST',
    'FILTER',
    'FILTERXML',
    'FLOOR.MATH',
    'FLOOR.PRECISE',
    'FORECAST.ETS',
    'FORECAST.ETS.CONFINT',
    'FORECAST.ETS.SEASONALITY',
    'FORECAST.ETS.STAT',
    'FORECAST.LINEAR',
    'FORMULATEXT',
    'GAMMA',
    'GAMMA.DIST',
    'GAMMA.INV',
    'GAMMALN.PRECISE',
    'GAUSS',
    'HSTACK',
    'HYPGEOM.DIST',
    'IFNA',
    'IFS',
    'IMCOSH',
    'IMCOT',
    'IMCSC',
    'IMCSCH',
    'IMSEC',
    'IMSECH',
    'IMSINH',
    'IMTAN',
    'ISFORMULA',
    'ISOMITTED',
    'ISOWEEKNUM',
    'LAMBDA',
    'LET',
    'LOGNORM.DIST',
    'LOGNORM.INV',
    'MAKEARRAY',
    'MAP',
    'MAXIFS',
    'MINIFS',
    'MODE.MULT',
    'MODE.SNGL',
    'MUNIT',
    'NEGBINOM.DIST',
    'NETWORKDAYS.INTL',
    'NORM.DIST',
    'NORM.INV',
    'NORM.S.DIST',
    'NORM.S.INV',
    'NUMBERVALUE',
    'PDURATION',
    'PERCENTILE.EXC',
    'PERCENTILE.INC',
    'PERCENTRANK.EXC',
    'PERCENTRANK.INC',
    'PERMUTATIONA',
    'PHI',
    'POISSON.DIST',
    'QUARTILE.EXC',
    'QUARTILE.INC',
    'QUERYSTRING',
    'RANDARRAY',
    'RANK.AVG',
    'RANK.EQ',
    'REDUCE',
    'RRI',
    'SCAN',
    'SEC',
    'SECH',
    'SEQUENCE',
    'SHEET',
    'SHEETS',
    'SINGLE',
    'SKEW.P',
    'SORT',
    'SORTBY',
    'STDEV.P',
    'STDEV.S',
    'SWITCH',
    'T.DIST',
    'T.DIST.2T',
    'T.DIST.RT',
    'T.INV',
    'T.INV.2T',
    'T.TEST',
    'TAKE',
    'TEXTAFTER',
    'TEXTBEFORE',
    'TEXTJOIN',
    'TEXTSPLIT',
    'TOCOL',
    'TOROW',
    'UNICHAR',
    'UNICODE',
    'UNIQUE',
    'VALUETOTEXT',
    'VAR.P',
    'VAR.S',
    'VSTACK',
    'WEBSERVICE',
    'WEIBULL.DIST',
    'WORKDAY.INTL',
    'WRAPCOLS',
    'WRAPROWS',
    'XLOOKUP',
    'XMATCH',
    'XOR',
    'Z.TEST',
]);

// Two of them carry a second prefix, the worksheet functions': `_xlfn._xlws.FILTER`.
const WORKSHEET_FUNCTIONS = new Set(['FILTER', 'SORT']);

const PREFIXES = ['_xlfn.', '_xlws.'];

// The engine knows a function by its name alone, so a stored one loses its prefixes and recomputes.
export function withoutFuturePrefixes(formula: string): string {
    return renameFunctions(formula, (name) => {
        let bare = name;
        for (const prefix of PREFIXES) if (bare.toLowerCase().startsWith(prefix)) bare = bare.slice(prefix.length);
        return bare;
    });
}

export function withFuturePrefixes(formula: string): string {
    return renameFunctions(formula, (name) => {
        const upper = name.toUpperCase();
        if (!FUTURE_FUNCTIONS.has(upper)) return name;
        return `_xlfn.${WORKSHEET_FUNCTIONS.has(upper) ? '_xlws.' : ''}${name}`;
    });
}

// Each name a `(` follows, outside a string, a quoted sheet name and a structured reference's brackets.
function renameFunctions(formula: string, rename: (name: string) => string): string {
    let out = '';
    let at = 0;
    while (at < formula.length) {
        const char = formula[at];
        if (char === '"' || char === "'") {
            // A doubled quote is one inside the text.
            let end = at + 1;
            while (end < formula.length && (formula[end] !== char || formula[end + 1] === char))
                end += formula[end] === char ? 2 : 1;
            out += formula.slice(at, end + 1);
            at = end + 1;
        } else if (char === '[') {
            // Inside the brackets a `'` escapes the character after it, a bracket too.
            let depth = 0;
            let end = at;
            for (; end < formula.length; end++) {
                if (formula[end] === "'") end++;
                else if (formula[end] === '[') depth++;
                else if (formula[end] === ']' && --depth === 0) break;
            }
            out += formula.slice(at, end + 1);
            at = end + 1;
        } else if (isNameStart(char) && (at === 0 || !isNamePart(formula[at - 1]))) {
            let end = at + 1;
            while (end < formula.length && isNamePart(formula[end])) end++;
            const name = formula.slice(at, end);
            out += formula[end] === '(' ? rename(name) : name;
            at = end;
        } else {
            out += char;
            at++;
        }
    }
    return out;
}

function isNameStart(char: string): boolean {
    return (char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z') || char === '_';
}

function isNamePart(char: string): boolean {
    return isNameStart(char) || (char >= '0' && char <= '9') || char === '.';
}
