import formulaError, {
    ERROR_DIV_ZERO,
    ERROR_NAME,
    ERROR_NOT_AVAILABLE,
    ERROR_NULL,
    ERROR_NUM,
    ERROR_REF,
    ERROR_SPILL,
    ERROR_VALUE,
} from './parser/error';

// The cell-level spelling of the parser's error table (parser/error.ts owns the strings).
export const error = {
    v: formulaError(ERROR_VALUE), // Wrong argument or operator
    n: formulaError(ERROR_NAME), // Formula name error
    na: formulaError(ERROR_NOT_AVAILABLE), // No value available in a function or formula
    r: formulaError(ERROR_REF), // A cell referenced by other formulas was deleted
    d: formulaError(ERROR_DIV_ZERO), // Divisor is 0 or an empty cell
    nm: formulaError(ERROR_NUM), // A number in a formula or function is invalid
    nl: formulaError(ERROR_NULL), // The intersection operator (space) is used incorrectly
    sp: formulaError(ERROR_SPILL), // Array range contains other values
};

export { valueIsError } from './parser/error';

// Whether the value is empty
export function isRealNull(val: unknown): boolean {
    return val == null || String(val).replace(/\s/g, '') === '';
}

// Whether the value is a pure number
export function isRealNum(val: unknown): boolean {
    if (val == null || String(val).replace(/\s/g, '') === '') {
        return false;
    }

    if (typeof val === 'boolean') {
        return false;
    }

    return !Number.isNaN(Number(val));
}

// Number() also reads "Infinity" and the radix prefixes parseFloat stops at ("0x10" → 0); Excel keeps both as text.
export function isPlainNumber(val: unknown): boolean {
    const parsed = parseFloat(String(val));
    return isRealNum(val) && Number.isFinite(parsed) && parsed === Number(val);
}

// A Chinese resident ID number stays text, however numeric it reads.
export const ID_CARD_NUMBER = /^\d{6}(18|19|20)?\d{2}(0[1-9]|1[12])(0[1-9]|[12]\d|3[01])\d{3}(\d|X)$/i;

function checkDateTime(str: string, format: '12' | '24'): boolean {
    const reg1 =
        format === '24'
            ? /^(\d{4})-(\d{1,2})-(\d{1,2})(\s(\d{1,2}):(\d{1,2})(:(\d{1,2}))?)?$/
            : /^(\d{4})-(\d{1,2})-(\d{1,2})(\s(\d{1,2}):(\d{1,2})(:(\d{1,2}))?)?\s?(AM|PM)?$/;
    const reg2 =
        format === '24'
            ? /^(\d{4})\/(\d{1,2})\/(\d{1,2})(\s(\d{1,2}):(\d{1,2})(:(\d{1,2}))?)?$/
            : /^(\d{4})\/(\d{1,2})\/(\d{1,2})(\s(\d{1,2}):(\d{1,2})(:(\d{1,2}))?)?\s?(AM|PM)?$/;

    const match = reg1.exec(str) ?? reg2.exec(str);
    if (!match) {
        return false;
    }

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);

    if (year < 1900) {
        return false;
    }

    if (month > 12) {
        return false;
    }

    if (day > 31) {
        return false;
    }

    if (month === 2) {
        if (new Date(year, 1, 29).getDate() === 29 && day > 29) {
            return false;
        }
        if (new Date(year, 1, 29).getDate() !== 29 && day > 28) {
            return false;
        }
    }
    return true;
}

export function isdatetime(s: unknown, format: '12' | '24' = '24'): boolean {
    if (s == null) {
        return false;
    }
    const str = String(s);
    if (str.length < 5) {
        return false;
    }
    return checkDateTime(str, format);
}
