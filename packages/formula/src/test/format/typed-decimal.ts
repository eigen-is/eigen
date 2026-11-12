// Decimals as a person types them, with the text of each rounded half away from zero worked out from its digits
// alone, so that a test can hold a display against a reference no double took part in.

// Mulberry32, so that a failing case can be found again.
export function seeded(seed: number): () => number {
    let state = seed;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
        mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
        return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
    };
}

// A typed decimal of up to 15 digits, and the digits of it rounded half away from zero at `decimals`, both made
// from the same digits with no arithmetic on a double. Half of them end in a 5, and `half` says the cut is at it.
export function typedDecimal(
    random: () => number,
    decimals: number,
): { typed: string; rounded: string; negative: boolean; half: boolean } {
    const whole = Math.floor(random() * 8);
    const places = 1 + Math.floor(random() * (15 - Math.max(whole, 1)));
    let digits = '';
    for (let at = 0; at < whole + places; at += 1) digits += Math.floor(random() * 10);
    if (random() < 0.5) digits = `${digits.slice(0, -1)}5`;
    if (digits.startsWith('0')) digits = `1${digits.slice(1)}`;
    const negative = random() < 0.3;
    const typed = `${negative ? '-' : ''}${digits.slice(0, whole) || '0'}.${digits.slice(whole)}`;
    const unit = 10n ** BigInt(Math.max(places - decimals, 0));
    const half = (BigInt(digits) % unit) * 2n === unit;
    const kept = ((BigInt(digits) + unit / 2n) / unit) * 10n ** BigInt(Math.max(decimals - places, 0));
    const text = kept.toString().padStart(decimals + 1, '0');
    const point = text.length - decimals;
    return { typed, rounded: decimals === 0 ? text : `${text.slice(0, point)}.${text.slice(point)}`, negative, half };
}

export function grouped(digits: string): string {
    const [whole, fraction] = digits.split('.');
    const commas = whole.replace(/\B(?=(\d{3})+$)/g, ',');
    return fraction === undefined ? commas : `${commas}.${fraction}`;
}
