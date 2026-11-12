// Text patterns as criteria, exact lookups and SEARCH read them: * stands for any run of characters, ? for one, and
// a ~ in front of *, ? or ~ makes that character itself. A pattern is read once and then matched against the
// upper-cased form of each text, so case never matters. It never becomes a regular expression.

const ANY_RUN = -1;
const ANY_ONE = -2;

const TILDE = 126;
const STAR = 42;
const QUESTION = 63;

export type Pattern = {
    // The character codes to match, with the two wildcards as negative numbers.
    readonly codes: readonly number[];
    // The text the pattern stands for when it holds no wildcard, and null when it holds one.
    readonly literal: string | null;
};

// Takes the key of a text, its upper-cased form.
export function patternOf(key: string): Pattern {
    const codes: number[] = [];
    let literal = '';
    let wild = false;
    for (let at = 0; at < key.length; at += 1) {
        let code = key.charCodeAt(at);
        if (code === STAR || code === QUESTION) {
            codes.push(code === STAR ? ANY_RUN : ANY_ONE);
            wild = true;
            continue;
        }
        const next = key.charCodeAt(at + 1);
        if (code === TILDE && (next === STAR || next === QUESTION || next === TILDE)) {
            code = next;
            at += 1;
        }
        codes.push(code);
        literal += key.charAt(at);
    }
    return { codes, literal: wild ? null : literal };
}

// Whether the pattern covers the whole key. A mismatch goes back to the last *, which then takes one more character.
export function patternMatches(pattern: Pattern, key: string): boolean {
    const { codes } = pattern;
    let at = 0;
    let p = 0;
    let star = -1;
    let resume = 0;
    while (at < key.length) {
        const code = p < codes.length ? codes[p] : 0;
        if (code === ANY_RUN) {
            star = p;
            resume = at;
            p += 1;
        } else if (p < codes.length && (code === ANY_ONE || code === key.charCodeAt(at))) {
            p += 1;
            at += 1;
        } else if (star >= 0) {
            p = star + 1;
            resume += 1;
            at = resume;
        } else return false;
    }
    while (p < codes.length && codes[p] === ANY_RUN) p += 1;
    return p === codes.length;
}

// Where the pattern `sought` first starts in the key at or after `from`, or -1. A ~ that ends the pattern stands
// for nothing. Each run between two * is taken at the first place it fits, so a text is walked once per start.
export function patternStart(sought: string, key: string, from: number): number {
    let tildes = 0;
    while (sought.charCodeAt(sought.length - 1 - tildes) === TILDE) tildes += 1;
    const pattern = patternOf(tildes % 2 === 1 ? sought.slice(0, -1) : sought);
    if (pattern.literal !== null) return key.indexOf(pattern.literal, from);
    // What follows the pattern does not matter, which is a * at its end.
    const codes = [...pattern.codes, ANY_RUN];
    const first = codes.indexOf(ANY_RUN);
    for (let start = from; start + first <= key.length; start += 1) {
        if (!runFits(codes, 0, first, key, start)) continue;
        let at = start + first;
        let p = first;
        while (p < codes.length) {
            const next = codes.indexOf(ANY_RUN, p + 1);
            const end = next < 0 ? codes.length : next;
            while (!runFits(codes, p + 1, end, key, at)) {
                at += 1;
                if (at > key.length) return -1;
            }
            at += end - p - 1;
            p = end;
        }
        return start;
    }
    return -1;
}

// Whether the codes from `p` up to `end`, which hold no *, match the key at `at`.
function runFits(codes: readonly number[], p: number, end: number, key: string, at: number): boolean {
    if (at + end - p > key.length) return false;
    for (let i = p; i < end; i += 1) {
        if (codes[i] !== ANY_ONE && codes[i] !== key.charCodeAt(at + i - p)) return false;
    }
    return true;
}
