import type { EigenFont } from '@workspace/lib/constants/fonts';
import type { ConditionalFormatConditionName } from '@workspace/lib/sheets';
import { SHEET_DEFAULT_DIGIT_WIDTH, SHEET_DEFAULT_FONT } from '@workspace/lib/sheets';

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

// The default font's widest digit in pixels as Excel for Windows draws it at 96 dpi, by the least point size each holds
// from. GDI's hinted advances, not the outline's, so measured: EPPlus' FontSize table, which the corpus' Excel-written
// widths agree with. Aptos Narrow draws Calibri's grid, and a metric-compatible face counts as the one it stands in for.
const CALIBRI_DIGIT: [number, number][] = [
    [7.5, 6],
    [9.5, 7],
    [12, 8],
    [12.5, 9],
    [14, 10],
    [15.5, 11],
];
const ARIAL_DIGIT: [number, number][] = [
    [9, 7],
    [10.5, 8],
    [12, 9],
    [13.5, 10],
    [14, 11],
    [15.5, 12],
];
const TIMES_DIGIT: [number, number][] = [
    [10.5, 7],
    [12, 8],
    [12.5, 9],
    [15, 10],
    [15.5, 11],
];
const DIGIT_WIDTHS = new Map<string, [number, number][]>([
    ['calibri', CALIBRI_DIGIT],
    ['carlito', CALIBRI_DIGIT],
    ['aptos narrow', CALIBRI_DIGIT],
    ['arial', ARIAL_DIGIT],
    ['liberation sans', ARIAL_DIGIT],
    // Cambria's digits are Arial's up to 16 pt.
    ['cambria', ARIAL_DIGIT],
    ['caladea', ARIAL_DIGIT],
    ['times new roman', TIMES_DIGIT],
    ['liberation serif', TIMES_DIGIT],
]);
// Calibri 11's, Excel's default since 2007, and Arial 10's before it.
const FALLBACK_DIGIT_WIDTH = 7;

// An Eigen export's default font is Inter, whose digit the writer converts through.
export function maxDigitWidth(font: string | undefined, size: number): number {
    if (font === SHEET_DEFAULT_FONT.name) return SHEET_DEFAULT_DIGIT_WIDTH;
    let digit = FALLBACK_DIGIT_WIDTH;
    for (const [from, px] of DIGIT_WIDTHS.get(font?.toLowerCase() ?? '') ?? []) if (size >= from) digit = px;
    return digit;
}

// A column width counts digits plus 5 px of padding, in 256ths of a digit (ECMA-376 Part 1 § 18.3.1.13). The writer
// truncates to the 256th below, so the reader's half-256th rounding lands back on the pixel.
export function columnWidthToPx(width: number, digit: number): number {
    return Math.trunc(((256 * width + Math.trunc(128 / digit)) / 256) * digit);
}

export function pxToColumnWidth(px: number, digit: number): number {
    return Math.trunc((px * 256) / digit) / 256;
}

// Excel's limits on a formula's characters and a number format's, and on a string a formula quotes, a list
// validation's literal among them.
export const MAX_FORMULA_LENGTH = 8192;
export const MAX_NUMBER_FORMAT_LENGTH = 255;
export const MAX_FORMULA_STRING_LENGTH = 255;

// ECMA-376 § 18.8.30's built-in formats that name one code whatever the locale.
export const BUILTIN_NUMBER_FORMATS = new Map<number, string>([
    [0, 'General'],
    [1, '0'],
    [2, '0.00'],
    [3, '#,##0'],
    [4, '#,##0.00'],
    [9, '0%'],
    [10, '0.00%'],
    [11, '0.00E+00'],
    [12, '# ?/?'],
    [13, '# ??/??'],
    [14, 'mm-dd-yy'],
    [15, 'd-mmm-yy'],
    [16, 'd-mmm'],
    [17, 'mmm-yy'],
    [18, 'h:mm AM/PM'],
    [19, 'h:mm:ss AM/PM'],
    [20, 'h:mm'],
    [21, 'h:mm:ss'],
    [22, 'm/d/yy h:mm'],
    [37, '#,##0 ;(#,##0)'],
    [38, '#,##0 ;[Red](#,##0)'],
    [39, '#,##0.00 ;(#,##0.00)'],
    [40, '#,##0.00 ;[Red](#,##0.00)'],
    [45, 'mm:ss'],
    [46, '[h]:mm:ss'],
    [47, 'mmss.0'],
    [48, '##0.0E+0'],
    [49, '@'],
]);

// A font's category as styles.xml's <family> numbers it (ECMA-376 Part 1 § 18.8.18).
export const FONT_FAMILY_NUMBER: Record<EigenFont['category'], number> = {
    serif: 1,
    'sans-serif': 2,
    monospace: 3,
    'hand-drawn': 4,
};

// A character XML can't hold is written _xHHHH_, and _x005F_ escapes the underscore of a literal one.
const ESCAPED = /_x([0-9A-Fa-f]{4})_/g;

export function decodeEscapes(text: string): string {
    return text.includes('_x')
        ? text.replace(ESCAPED, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
        : text;
}

// A number as a rule's operand holds it, unquoted; anything else is a reference, a function or a quoted string.
export const NUMERIC = /^-?(?:\d+(?:\.\d*)?|\.\d+)$/;

// A cellIs rule's operators, which the engine's comparisons are named after.
export const CF_CELL_IS_CONDITION = new Map<string, ConditionalFormatConditionName>([
    ['greaterThan', 'greaterThan'],
    ['greaterThanOrEqual', 'greaterThanOrEqual'],
    ['lessThan', 'lessThan'],
    ['lessThanOrEqual', 'lessThanOrEqual'],
    ['equal', 'equal'],
    ['notEqual', 'notEqual'],
    ['between', 'between'],
    ['notBetween', 'notBetween'],
]);

// A data validation's type and the engine's for it, one list both ways. Excel's decimal admits any number, as the
// engine's number does, while number_decimal rejects integers: it writes as decimal and reads back as number.
const DV_TYPES: [string, string][] = [
    ['list', 'dropdown'],
    ['whole', 'number_integer'],
    ['decimal', 'number'],
    ['textLength', 'text_length'],
    ['date', 'date'],
];
export const DV_TYPE = new Map(DV_TYPES);
export const DV_XLSX_TYPE = new Map([
    ...DV_TYPES.map(([type, engineType]): [string, string] => [engineType, type]),
    ['number_decimal', 'decimal'],
]);

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
