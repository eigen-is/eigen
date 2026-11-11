// The engine's own order of text, the same on every browser and on the server, where the host's collation would
// follow the language data of whichever machine runs it. Text is compared on its key, the upper-cased form, so
// case never matters and "straße" equals "STRASSE" as in Excel. Keys order by character, with an accented Latin
// letter right after its base letter. Whatever orders text, such as a comparison operator, does it through textKey and compareText.

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

// Room between two character codes for the accented forms of a letter.
const STEP = 16;

// The sort weight of every character up to the last accented one; a character past them weighs its code times STEP.
const WEIGHTS = new Uint16Array(0x180);
for (let code = 0; code < WEIGHTS.length; code += 1) WEIGHTS[code] = code * STEP;
for (const letters of ACCENTED) {
    for (let rank = 1; rank < letters.length; rank += 1) {
        WEIGHTS[letters.charCodeAt(rank)] = letters.charCodeAt(0) * STEP + rank;
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
