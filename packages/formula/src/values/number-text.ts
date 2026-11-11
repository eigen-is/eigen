// A number as text, the way the & operator and text parameters see it: Excel's General at 15 significant digits,
// whatever number format the cell has. LEN(1/3) is 17 because of it. The digits are written plainly while they fit
// and in scientific notation past that. Display in a cell is another matter and belongs to the number formats.

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
