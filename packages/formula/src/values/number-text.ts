// A number as text without a number format: the way the & operator and text parameters see it, Excel's General
// at 15 significant digits, so LEN(1/3) is 17, and the way FIXED and DOLLAR write it out. Both write the 15 digits
// Excel holds, and zeros where a large number has more. Display in a cell is another matter and belongs to the
// number formats.

// The longest plain form, counted without its sign; a longer one is written in scientific notation.
const PLAIN_LENGTH = 20;

const ZERO = 48;

export function numberToText(n: number): string {
    if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
    // One digit, a point, 14 digits, e, a sign and the exponent.
    const text = Math.abs(n).toExponential(14);
    let last = 15;
    while (text.charCodeAt(last) === ZERO) last -= 1;
    const digits = last === 1 ? text.charAt(0) : text.charAt(0) + text.slice(2, last + 1);
    const exponent = Number(text.slice(17));
    const sign = n < 0 ? '-' : '';
    const whole = exponent + 1;
    if (exponent < 0) {
        if (1 - exponent + digits.length <= PLAIN_LENGTH) return `${sign}0.${'0'.repeat(-whole)}${digits}`;
    } else if (digits.length <= whole) {
        if (whole <= PLAIN_LENGTH) return sign + digits + '0'.repeat(whole - digits.length);
    } else return `${sign}${digits.slice(0, whole)}.${digits.slice(whole)}`;
    const power = Math.abs(exponent);
    const fraction = digits.length > 1 ? `.${digits.slice(1)}` : '';
    return `${sign}${digits.charAt(0)}${fraction}E${exponent < 0 ? '-' : '+'}${power < 10 ? '0' : ''}${power}`;
}

// The number with exactly `decimals` digits after the point and, when `grouped`, a comma between every three
// before it. It takes a number that holds no more decimals than that, as roundDecimal leaves it.
export function fixedText(n: number, decimals: number, grouped: boolean): string {
    const text = Math.abs(n).toExponential(14);
    const digits = text.charAt(0) + text.slice(2, 16);
    const exponent = Number(text.slice(17));
    let fixed = exponent < 0 ? '0' : digits.slice(0, exponent + 1).padEnd(exponent + 1, '0');
    if (grouped) {
        for (let at = fixed.length - 3; at > 0; at -= 3) fixed = `${fixed.slice(0, at)},${fixed.slice(at)}`;
    }
    if (decimals > 0) {
        const after = exponent < 0 ? '0'.repeat(-exponent - 1) + digits : digits.slice(exponent + 1);
        fixed += `.${after.slice(0, decimals).padEnd(decimals, '0')}`;
    }
    return n < 0 ? `-${fixed}` : fixed;
}
