export const error: Record<string, string> = {
    v: '#VALUE!', // Wrong argument or operator
    n: '#NAME?', // Formula name error
    na: '#N/A', // No value available in a function or formula
    r: '#REF!', // A cell referenced by other formulas was deleted
    d: '#DIV/0!', // Divisor is 0 or an empty cell
    nm: '#NUM!', // A number in a formula or function is invalid
    nl: '#NULL!', // The intersection operator (space) is used incorrectly
    sp: '#SPILL!', // Array range contains other values
};

const errorValues = Object.values(error);

export function valueIsError(value: string): boolean {
    return errorValues.includes(value);
}

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

function checkDateTime(str: string, format: string): boolean {
    const reg1 =
        format === '24'
            ? /^(\d{4})-(\d{1,2})-(\d{1,2})(\s(\d{1,2}):(\d{1,2})(:(\d{1,2}))?)?$/
            : /^(\d{4})-(\d{1,2})-(\d{1,2})(\s(\d{1,2}):(\d{1,2})(:(\d{1,2}))?)?\s?(AM|PM)?$/;
    const reg2 =
        format === '24'
            ? /^(\d{4})\/(\d{1,2})\/(\d{1,2})(\s(\d{1,2}):(\d{1,2})(:(\d{1,2}))?)?$/
            : /^(\d{4})\/(\d{1,2})\/(\d{1,2})(\s(\d{1,2}):(\d{1,2})(:(\d{1,2}))?)?\s?(AM|PM)?$/;

    if (!reg1.test(str) && !reg2.test(str)) {
        return false;
    }

    const year = Number(RegExp.$1);
    const month = Number(RegExp.$2);
    const day = Number(RegExp.$3);

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

export function isdatetime(s: unknown, format: string = '24'): boolean {
    if (s == null) {
        return false;
    }
    const str = String(s);
    if (str.length < 5) {
        return false;
    }
    return checkDateTime(str, format);
}
