// Sine, cosine and tangent as Excel answers them. Excel measures the turn by a pi that is a little longer than
// pi, so SIN(PI()) is 1.22514845490862E-16 where the true sine of that double ends in 1.2246. The difference grows
// with the angle, reaches the twelfth digit near 1E+8, and from 2^27 on Excel has no answer at all, which is a NaN
// here. The function library calls these once per cell.

// How far Excel's angle falls behind per radian: its pi is 5.0165576127E-20 too long, read off SIN(PI()).
const LAG = 5.0165576127e-20 / Math.PI;

const LIMIT = 2 ** 27;

export function sine(angle: number): number {
    if (Math.abs(angle) >= LIMIT) return Number.NaN;
    return Math.sin(angle) - angle * LAG * Math.cos(angle);
}

export function cosine(angle: number): number {
    if (Math.abs(angle) >= LIMIT) return Number.NaN;
    return Math.cos(angle) + angle * LAG * Math.sin(angle);
}

export function tangent(angle: number): number {
    return sine(angle) / cosine(angle);
}
