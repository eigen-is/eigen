// The three coercions of a value, each one function for operators and function arguments alike. A text becomes a
// number when a person could have typed it into a cell as one, and empty text is 0 and FALSE, as a blank is. A
// coercion that fails is #VALUE!, and an error goes through as itself, so a caller checks one result.

import type { FormulaError } from './errors';
import { VALUE } from './errors';
import { numberToText } from './number-text';
import { parseNumber } from './parse-number';
import type { Value } from './value';
import { isError } from './value';

export function toNumber(value: Value): number | FormulaError {
    switch (typeof value) {
        case 'number':
            return value;
        case 'boolean':
            return value ? 1 : 0;
        case 'string':
            return value === '' ? 0 : (parseNumber(value) ?? VALUE);
        default:
            if (value === null) return 0;
            return isError(value) ? value : VALUE;
    }
}

export function toText(value: Value): string | FormulaError {
    switch (typeof value) {
        case 'string':
            return value;
        case 'number':
            return numberToText(value);
        case 'boolean':
            return value ? 'TRUE' : 'FALSE';
        default:
            if (value === null) return '';
            return isError(value) ? value : VALUE;
    }
}

export function toBoolean(value: Value): boolean | FormulaError {
    switch (typeof value) {
        case 'boolean':
            return value;
        case 'number':
            return value !== 0;
        case 'string':
            return value === '' ? false : (spelledBoolean(value) ?? VALUE);
        default:
            if (value === null) return false;
            return isError(value) ? value : VALUE;
    }
}

// The boolean a text spells, in any letter case and with nothing around it.
export function spelledBoolean(text: string): boolean | undefined {
    const upper = text.toUpperCase();
    return upper === 'TRUE' ? true : upper === 'FALSE' ? false : undefined;
}
