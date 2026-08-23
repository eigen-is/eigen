// ─────────────────────────────────────────────────────────────────────────────
// Vendored fractional-indexing core.
// Source: https://www.npmjs.com/package/fractional-indexing (via Excalidraw's fork,
//         packages/fractional-indexing/src/index.ts). License: CC0 (no rights reserved).
// Based on https://observablehq.com/@dgreensp/implementing-fractional-indexing
// Vendored verbatim to pin z-order behaviour; the Eigen repair layer follows below.
// ─────────────────────────────────────────────────────────────────────────────

export const BASE_62_DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

// `a` may be empty string, `b` is null or non-empty string.
// `a < b` lexicographically if `b` is non-null.
// no trailing zeros allowed.
// digits is a string such as '0123456789' for base 10. Digits must be in
// ascending character code order!
function midpoint(a: string, b: string | null | undefined, digits: string): string {
    const zero = digits[0];
    if (b != null && a >= b) {
        throw new Error(`${a} >= ${b}`);
    }
    if (a.slice(-1) === zero || (b && b.slice(-1) === zero)) {
        throw new Error('trailing zero');
    }
    if (b) {
        // remove longest common prefix. pad `a` with 0s as we go. note that we don't
        // need to pad `b`, because it can't end before `a` while traversing the prefix.
        let n = 0;
        while ((a[n] || zero) === b[n]) {
            n++;
        }
        if (n > 0) {
            return b.slice(0, n) + midpoint(a.slice(n), b.slice(n), digits);
        }
    }
    // first digits (or lack of digit) are different
    const digitA = a ? digits.indexOf(a[0]) : 0;
    const digitB = b != null ? digits.indexOf(b[0]) : digits.length;
    if (digitB - digitA > 1) {
        const midDigit = Math.round(0.5 * (digitA + digitB));
        return digits[midDigit];
    }
    // first digits are consecutive
    if (b && b.length > 1) {
        return b.slice(0, 1);
    }
    // `b` is null or has length 1 (a single digit). the first digit of `a` is the
    // previous digit to `b`, or 9 if `b` is null.
    return digits[digitA] + midpoint(a.slice(1), null, digits);
}

function validateInteger(int: string): void {
    if (int.length !== getIntegerLength(int[0])) {
        throw new Error(`invalid integer part of order key: ${int}`);
    }
}

function getIntegerLength(head: string): number {
    if (head >= 'a' && head <= 'z') {
        return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
    }
    if (head >= 'A' && head <= 'Z') {
        return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
    }
    throw new Error(`invalid order key head: ${head}`);
}

function getIntegerPart(key: string): string {
    const integerPartLength = getIntegerLength(key[0]);
    if (integerPartLength > key.length) {
        throw new Error(`invalid order key: ${key}`);
    }
    return key.slice(0, integerPartLength);
}

export function validateOrderKey(key: string, digits: string = BASE_62_DIGITS): void {
    const validChars = key.split('').every((char) => digits.includes(char));
    if (key === `A${digits[0].repeat(26)}` || !validChars) {
        throw new Error(`invalid order key: ${key}`);
    }
    // getIntegerPart will throw if the first character is bad, or the key is too short.
    const i = getIntegerPart(key);
    const f = key.slice(i.length);
    if (f.slice(-1) === digits[0]) {
        throw new Error(`invalid order key: ${key}`);
    }
}

// note that this may return null, as there is a largest integer
function incrementInteger(x: string, digits: string): string | null {
    validateInteger(x);
    const [head, ...digs] = x.split('');
    let carry = true;
    for (let i = digs.length - 1; carry && i >= 0; i--) {
        const d = digits.indexOf(digs[i]) + 1;
        if (d === digits.length) {
            digs[i] = digits[0];
        } else {
            digs[i] = digits[d];
            carry = false;
        }
    }
    if (carry) {
        if (head === 'Z') {
            return `a${digits[0]}`;
        }
        if (head === 'z') {
            return null;
        }
        const h = String.fromCharCode(head.charCodeAt(0) + 1);
        if (h > 'a') {
            digs.push(digits[0]);
        } else {
            digs.pop();
        }
        return h + digs.join('');
    }
    return head + digs.join('');
}

// note that this may return null, as there is a smallest integer
function decrementInteger(x: string, digits: string): string | null {
    validateInteger(x);
    const [head, ...digs] = x.split('');
    let borrow = true;
    for (let i = digs.length - 1; borrow && i >= 0; i--) {
        const d = digits.indexOf(digs[i]) - 1;
        if (d === -1) {
            digs[i] = digits.slice(-1);
        } else {
            digs[i] = digits[d];
            borrow = false;
        }
    }
    if (borrow) {
        if (head === 'a') {
            return `Z${digits.slice(-1)}`;
        }
        if (head === 'A') {
            return null;
        }
        const h = String.fromCharCode(head.charCodeAt(0) - 1);
        if (h < 'Z') {
            digs.push(digits.slice(-1));
        } else {
            digs.pop();
        }
        return h + digs.join('');
    }
    return head + digs.join('');
}

// `a` is an order key or null (START). `b` is an order key or null (END).
// `a < b` lexicographically if both are non-null.
export function generateKeyBetween(
    a: string | null | undefined,
    b: string | null | undefined,
    digits = BASE_62_DIGITS,
): string {
    if (a != null) {
        validateOrderKey(a, digits);
    }
    if (b != null) {
        validateOrderKey(b, digits);
    }
    if (a != null && b != null && a >= b) {
        throw new Error(`${a} >= ${b}`);
    }
    if (a == null) {
        if (b == null) {
            return `a${digits[0]}`;
        }
        const ib = getIntegerPart(b);
        const fb = b.slice(ib.length);
        if (ib === `A${digits[0].repeat(26)}`) {
            return ib + midpoint('', fb, digits);
        }
        if (ib < b) {
            return ib;
        }
        const res = decrementInteger(ib, digits);
        if (res == null) {
            throw new Error('cannot decrement any more');
        }
        return res;
    }
    if (b == null) {
        const ia = getIntegerPart(a);
        const fa = a.slice(ia.length);
        const i = incrementInteger(ia, digits);
        return i == null ? ia + midpoint(fa, null, digits) : i;
    }
    const ia = getIntegerPart(a);
    const fa = a.slice(ia.length);
    const ib = getIntegerPart(b);
    const fb = b.slice(ib.length);
    if (ia === ib) {
        return ia + midpoint(fa, fb, digits);
    }
    const i = incrementInteger(ia, digits);
    if (i == null) {
        throw new Error('cannot increment any more');
    }
    if (i < b) {
        return i;
    }
    return ia + midpoint(fa, null, digits);
}

// Same preconditions as generateKeyBetween. n >= 0. Returns n distinct keys in sorted
// order. If a and b are both null, returns [a0, a1, ...].
export function generateNKeysBetween(
    a: string | null | undefined,
    b: string | null | undefined,
    n: number,
    digits = BASE_62_DIGITS,
): string[] {
    if (n === 0) {
        return [];
    }
    if (n === 1) {
        return [generateKeyBetween(a, b, digits)];
    }
    if (b == null) {
        let c = generateKeyBetween(a, b, digits);
        const result = [c];
        for (let i = 0; i < n - 1; i++) {
            c = generateKeyBetween(c, b, digits);
            result.push(c);
        }
        return result;
    }
    if (a == null) {
        let c = generateKeyBetween(a, b, digits);
        const result = [c];
        for (let i = 0; i < n - 1; i++) {
            c = generateKeyBetween(a, c, digits);
            result.push(c);
        }
        result.reverse();
        return result;
    }
    const mid = Math.floor(n / 2);
    const c = generateKeyBetween(a, b, digits);
    return [...generateNKeysBetween(a, c, mid, digits), c, ...generateNKeysBetween(c, b, n - mid - 1, digits)];
}

// ─────────────────────────────────────────────────────────────────────────────
// Eigen repair layer — the reusable core of Excalidraw's fractionalIndex.ts wrapper,
// trimmed of the bound-text / mutateElement / versioning machinery. Elements here are
// plain materialized objects, so repair mutates `index` in place.
// ─────────────────────────────────────────────────────────────────────────────

type IndexedElement = { id: string; index: string };

// Format-check `index`, then confirm it sits strictly between its neighbours.
export function isValidFractionalIndex(
    index: string | undefined,
    predecessor: string | undefined,
    successor: string | undefined,
): boolean {
    if (!index) {
        return false;
    }
    try {
        validateOrderKey(index);
    } catch {
        return false;
    }
    if (predecessor && successor) {
        return predecessor < index && index < successor;
    }
    if (!predecessor && successor) {
        return index < successor;
    }
    if (predecessor && !successor) {
        return predecessor < index;
    }
    return true;
}

// Order elements by fractional index, tie-breaking on id (deterministic across peers).
export function orderByFractionalIndex<T extends IndexedElement>(elements: T[]): T[] {
    return [...elements].sort((a, b) => {
        if (a.index < b.index) return -1;
        if (a.index > b.index) return 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}

// Contiguous groups of invalid indices in the array's current order. First and last item
// of each group are the found valid lower/upper bound indices (may be -1 / length).
function getInvalidIndicesGroups(elements: readonly IndexedElement[]): number[][] {
    const indicesGroups: number[][] = [];

    let lowerBound: string | undefined;
    let upperBound: string | undefined;
    let lowerBoundIndex = -1;
    let upperBoundIndex = 0;

    const getLowerBound = (index: number): [string | undefined, number] => {
        const bound = elements[lowerBoundIndex] ? elements[lowerBoundIndex].index : undefined;
        const candidate = elements[index - 1]?.index;
        if ((!bound && candidate) || (bound && candidate && candidate > bound)) {
            return [candidate, index - 1];
        }
        return [bound, lowerBoundIndex];
    };

    const getUpperBound = (index: number): [string | undefined, number] => {
        const bound = elements[upperBoundIndex] ? elements[upperBoundIndex].index : undefined;
        if (bound && index < upperBoundIndex) {
            return [bound, upperBoundIndex];
        }
        let i = upperBoundIndex;
        while (++i < elements.length) {
            const candidate = elements[i]?.index;
            if ((!bound && candidate) || (bound && candidate && candidate > bound)) {
                return [candidate, i];
            }
        }
        return [undefined, i];
    };

    let i = 0;
    while (i < elements.length) {
        const current = elements[i].index;
        [lowerBound, lowerBoundIndex] = getLowerBound(i);
        [upperBound, upperBoundIndex] = getUpperBound(i);

        if (!isValidFractionalIndex(current, lowerBound, upperBound)) {
            const indicesGroup = [lowerBoundIndex, i];
            while (++i < elements.length) {
                const next = elements[i].index;
                const [nextLower, nextLowerIndex] = getLowerBound(i);
                const [nextUpper, nextUpperIndex] = getUpperBound(i);
                if (isValidFractionalIndex(next, nextLower, nextUpper)) {
                    break;
                }
                [lowerBound, lowerBoundIndex] = [nextLower, nextLowerIndex];
                [upperBound, upperBoundIndex] = [nextUpper, nextUpperIndex];
                indicesGroup.push(i);
            }
            indicesGroup.push(upperBoundIndex);
            indicesGroups.push(indicesGroup);
        } else {
            i++;
        }
    }

    return indicesGroups;
}

// Repair all invalid fractional indices to match the array's order, mutating `index` in
// place. Use on load/restore when the moved set is unknown. WARN (from Excalidraw): in
// edge cases it can rewrite untouched elements, since the moved set can't be recovered
// from the array alone.
export function syncInvalidIndices<T extends IndexedElement>(elements: T[]): T[] {
    for (const indices of getInvalidIndicesGroups(elements)) {
        const lowerBoundIndex = indices.shift();
        const upperBoundIndex = indices.pop();
        if (lowerBoundIndex === undefined || upperBoundIndex === undefined) continue;
        const keys = generateNKeysBetween(
            elements[lowerBoundIndex]?.index,
            elements[upperBoundIndex]?.index,
            indices.length,
        );
        for (let i = 0; i < indices.length; i++) {
            elements[indices[i]].index = keys[i];
        }
    }
    return elements;
}
