// The engine's own order of text, the same on every browser and on the server, where the host's collation would
// follow the language data of whichever machine runs it. Text is compared on its key, the upper-cased form, so
// case never matters and "straße" equals "STRASSE" as in Excel. Keys order by character, with an accented Latin
// letter right after its base letter and every mark ahead of the digits. Whatever orders text, such as a
// comparison operator or a sorted lookup, does it through textKey and compareText.

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
    const shared = Math.min(a.length, b.length);
    for (let at = 0; at < shared; at += 1) {
        const left = a.charCodeAt(at);
        const right = b.charCodeAt(at);
        if (left === right) continue;
        const leftWeight = WEIGHTS[left] ?? left * STEP;
        const rightWeight = WEIGHTS[right] ?? right * STEP;
        return leftWeight < rightWeight ? -1 : 1;
    }
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}
