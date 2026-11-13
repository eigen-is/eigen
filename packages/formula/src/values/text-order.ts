// The engine's own order of text, the same on every browser and on the server, where the host's collation would
// follow the language data of whichever machine runs it. Text is compared on its key, the upper-cased form, so
// case never matters and "straße" equals "STRASSE" as in Excel. Keys order by character: the space, the marks,
// the digits, the letters, an accented Latin letter right after its base letter. A hyphen and an apostrophe only
// order two texts that are equal without them, such as "co-op" right after "coop".

// Each base letter followed by its accented forms, in the order they sort.
const ACCENTED = [
    'AÀÁÂÃÄÅĀĂĄÆ',
    'CÇĆĈĊČ',
    'DĎĐ',
    'EÈÉÊËĒĔĖĘĚ',
    'GĜĞĠĢ',
    'HĤĦ',
    'IÌÍÎÏĨĪĬĮİ',
    'JĴ',
    'KĶ',
    'LĹĻĽĿŁ',
    'NÑŃŅŇ',
    'OÒÓÔÕÖØŌŎŐŒ',
    'RŔŖŘ',
    'SŚŜŞŠ',
    'TŢŤŦ',
    'UÙÚÛÜŨŪŬŮŰŲ',
    'WŴ',
    'YÝŶŸ',
    'ZŹŻŽ',
];

// The slash, followed by the marks whose codes come after the digits. In Excel those sort before the digits, as
// the marks up to the slash do by their code: "k?" is below "k1".
const LATE_MARKS = '/:;<=>?@[\\]^_`{|}~';

const APOSTROPHE = 39;
const HYPHEN = 45;

// Room after a character code for the characters that sort right behind it.
const STEP = 32;

// The sort weight of every character up to the last accented one; a character past them weighs its code times STEP.
const WEIGHTS = new Uint16Array(0x180);
for (let code = 0; code < WEIGHTS.length; code += 1) WEIGHTS[code] = code * STEP;
for (const group of [LATE_MARKS, ...ACCENTED]) {
    for (let rank = 1; rank < group.length; rank += 1) {
        WEIGHTS[group.charCodeAt(rank)] = group.charCodeAt(0) * STEP + rank;
    }
}

// The form text is compared on. Compute it once per text and compare keys.
export function textKey(text: string): string {
    return text.toUpperCase();
}

// Orders two keys, not raw text: -1, 0 or 1, and 0 only for equal keys.
export function compareText(a: string, b: string): number {
    let atA = 0;
    let atB = 0;
    while (atA < a.length && atB < b.length) {
        const left = a.charCodeAt(atA);
        const right = b.charCodeAt(atB);
        if (left === right) {
            atA += 1;
            atB += 1;
        } else if (isUnweighed(left)) atA += 1;
        else if (isUnweighed(right)) atB += 1;
        else return (WEIGHTS[left] ?? left * STEP) < (WEIGHTS[right] ?? right * STEP) ? -1 : 1;
    }
    while (isUnweighed(a.charCodeAt(atA))) atA += 1;
    while (isUnweighed(b.charCodeAt(atB))) atB += 1;
    if (atA < a.length || atB < b.length) return atA < a.length ? 1 : -1;
    // Equal without the marks that take no part. Where the keys first differ one of them has such a mark, and
    // that key is the later one; of two marks the one with the higher code is.
    const shared = Math.min(a.length, b.length);
    for (let at = 0; at < shared; at += 1) {
        const left = a.charCodeAt(at);
        const right = b.charCodeAt(at);
        if (left !== right) return !isUnweighed(left) || (isUnweighed(right) && left < right) ? -1 : 1;
    }
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

function isUnweighed(code: number): boolean {
    return code === HYPHEN || code === APOSTROPHE;
}
