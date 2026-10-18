// Excel's vocabulary, which the xlsx writer writes and the xlsx reader recognises, one source both ways. The OOXML every
// format shares is core/ooxml.ts.

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
