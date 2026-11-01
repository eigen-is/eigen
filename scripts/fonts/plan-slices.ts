// Which characters each slice of a bundled face draws, the planning half of the font vendoring script. A slice starts
// as one of Google's published ranges, cut to what the font maps, to what its kind of font covers and to what no
// earlier family claimed. The emoji slices then move so every RGI sequence sits whole in one slice. This works on sets
// of code points only; build-font-slices does the downloads, the cutting and the writing.

export type Slice = { label: string; codePoints: Set<number> };

// One rule of Google's CSS for a family: its subset's name, such as "latin" or "119", its style and its range.
export type PublishedSubset = { label: string; style: string; unicodeRange: string };

// The characters that only join others into one emoji: they repeat in every slice whose emoji need them.
const ZWJ = 0x200d;
const VS16 = 0xfe0f;
const KEYCAP = 0x20e3;
const EMOJI_COMPONENTS = new Set([ZWJ, VS16, KEYCAP, ...span(0xe0020, 0xe007f)]);
// The text faces keep these three: Extended_Pictographic holds them, but body text writes them often.
const TEXT_SYMBOLS = new Set([0xa9, 0xae, 0x2122]);

export const CJK_SC_COVERAGE = new Set([
    ...span(0x4e00, 0x9fff), // CJK Unified Ideographs
    ...span(0x3400, 0x4dbf), // Extension A
    ...span(0xf900, 0xfaff), // Compatibility Ideographs
    ...span(0x2f800, 0x2fa1f), // Compatibility Ideographs Supplement
    ...span(0x3040, 0x30ff), // Hiragana and Katakana
    ...span(0x31f0, 0x31ff), // Katakana Phonetic Extensions
    ...span(0x3100, 0x312f), // Bopomofo
    ...span(0x31a0, 0x31bf), // Bopomofo Extended
    ...span(0x3000, 0x303f), // CJK Symbols and Punctuation
    ...span(0xff00, 0xffef), // Halfwidth and Fullwidth Forms
    ...span(0x3200, 0x32ff), // Enclosed CJK Letters and Months
    ...span(0x1f200, 0x1f2ff), // Enclosed Ideographic Supplement
    ...span(0x3300, 0x33ff), // CJK Compatibility
]);

export const CJK_KR_COVERAGE = new Set([
    ...span(0xac00, 0xd7af), // Hangul Syllables
    ...span(0x1100, 0x11ff), // Hangul Jamo
    ...span(0x3130, 0x318f), // Hangul Compatibility Jamo
    ...span(0xa960, 0xa97f), // Hangul Jamo Extended-A
    ...span(0xd7b0, 0xd7ff), // Hangul Jamo Extended-B
]);

// Each published range, kept to the characters the font maps and its kind of font covers, minus what an earlier family
// claimed.
export function publishedSlices(
    subsets: readonly PublishedSubset[],
    cmap: ReadonlySet<number>,
    coverage: ReadonlySet<number>,
    claimed: ReadonlySet<number>,
): Slice[] {
    return subsets
        .map((subset) => ({
            label: subset.label,
            codePoints: new Set(
                parseRange(subset.unicodeRange).filter(
                    (codePoint) => cmap.has(codePoint) && coverage.has(codePoint) && !claimed.has(codePoint),
                ),
            ),
        }))
        .filter((slice) => slice.codePoints.size > 0);
}

// One more slice, "rest", for what the font covers and no published range holds; "all" for a face Google doesn't serve.
export function withRest(
    slices: Slice[],
    cmap: ReadonlySet<number>,
    coverage: ReadonlySet<number>,
    claimed: ReadonlySet<number>,
): Slice[] {
    const sliced = new Set(slices.flatMap((slice) => [...slice.codePoints]));
    const rest = [...cmap].filter(
        (codePoint) => coverage.has(codePoint) && !claimed.has(codePoint) && !sliced.has(codePoint),
    );
    if (rest.length === 0) return slices;
    return [...slices, { label: slices.length === 0 ? 'all' : 'rest', codePoints: new Set(rest) }];
}

// Extended_Pictographic, the components and the skin tones, flags and tags, from Unicode's emoji-data.txt; never
// Basic Latin, and not © ® ™.
export function emojiCoverage(emojiData: string): Set<number> {
    const coverage = new Set([...EMOJI_COMPONENTS, ...span(0x1f3fb, 0x1f3ff), ...span(0x1f1e6, 0x1f1ff)]);
    for (const line of emojiData.split('\n')) {
        const [codePoints, property] = line
            .split('#')[0]
            .split(';')
            .map((part) => part.trim());
        if (property !== 'Extended_Pictographic') continue;
        const [start, end = start] = codePoints.split('..');
        for (const codePoint of span(Number.parseInt(start, 16), Number.parseInt(end, 16))) coverage.add(codePoint);
    }
    for (const codePoint of coverage) if (codePoint < 0x80 || TEXT_SYMBOLS.has(codePoint)) coverage.delete(codePoint);
    return coverage;
}

// Every RGI emoji of more than one character the emoji face draws whole, from Unicode's sequence files. A keycap
// counts, though its base stays a text character; ©️, ®️ and ™️ don't, since their base draws in the text face.
export function rgiSequences(
    sequenceFiles: readonly string[],
    cmap: ReadonlySet<number>,
    coverage: ReadonlySet<number>,
): number[][] {
    const sequences: number[][] = [];
    for (const line of sequenceFiles.flatMap((text) => text.split('\n'))) {
        const field = line.split('#')[0].split(';')[0].trim();
        if (field === '' || field.includes('..')) continue;
        const codePoints = field.split(/\s+/).map((hex) => Number.parseInt(hex, 16));
        const drawn = (codePoint: number) =>
            cmap.has(codePoint) && (coverage.has(codePoint) || codePoints.includes(KEYCAP));
        if (codePoints.length > 1 && codePoints.every(drawn)) sequences.push(codePoints);
    }
    return sequences;
}

// Google's emoji ranges repeat about ninety characters, such as ❤ and 🔥, so which slice draws an emoji like ❤️‍🔥
// would depend on the order of the rules in WebKit, Firefox and Pango. So every character joined to another by an RGI
// sequence moves, with all it is joined to, into the slice that already holds most of them. The skin tones join the
// people they modify, so they sit in one slice. A character no sequence joins stays in the first slice that holds it,
// and one no published range holds goes to a "rest" slice. The components repeat as Google repeats them, and the
// keycap bases sit in the slice of the keycap mark.
export function closeSequences(
    published: Slice[],
    sequences: readonly number[][],
    coverage: ReadonlySet<number>,
    cmap: ReadonlySet<number>,
): Slice[] {
    const rest: Slice = { label: 'rest', codePoints: new Set() };
    const slices = [...published, rest];

    // A union-find over the joined characters: root(x) names the group x belongs to.
    const parent = new Map<number, number>();
    const root = (codePoint: number): number => {
        const up = parent.get(codePoint) ?? codePoint;
        if (up === codePoint) return codePoint;
        const top = root(up);
        parent.set(codePoint, top);
        return top;
    };
    const joined = (codePoint: number) => codePoint >= 0x80 && !EMOJI_COMPONENTS.has(codePoint);
    for (const sequence of sequences) {
        const [first, ...others] = sequence.filter(joined);
        if (first === undefined) continue;
        // Recorded even when nothing joins it, as ❤ in ❤️ is, so it counts as a group of its own.
        parent.set(first, root(first));
        for (const codePoint of others) parent.set(root(codePoint), root(first));
    }
    const groups = new Map<number, { members: Set<number>; sequences: number[][] }>();
    const groupOf = (top: number) => {
        const group = groups.get(top) ?? { members: new Set<number>(), sequences: [] };
        groups.set(top, group);
        return group;
    };
    for (const codePoint of parent.keys()) groupOf(root(codePoint)).members.add(codePoint);
    for (const sequence of sequences) {
        const first = sequence.find(joined);
        if (first !== undefined) groupOf(root(first)).sequences.push(sequence);
    }

    for (const { members, sequences: joinedBy } of groups.values()) {
        const overlap = (slice: Slice) => [...members].filter((codePoint) => slice.codePoints.has(codePoint)).length;
        const home = published.reduce<Slice>((best, slice) => (overlap(slice) > overlap(best) ? slice : best), rest);
        for (const slice of slices) for (const codePoint of members) slice.codePoints.delete(codePoint);
        for (const sequence of joinedBy) for (const codePoint of sequence) home.codePoints.add(codePoint);
        for (const codePoint of members) home.codePoints.add(codePoint);
    }

    const keycapHome = published.find((slice) => slice.codePoints.has(KEYCAP));
    if (keycapHome === undefined) throw new Error('no emoji slice holds the keycap mark');
    for (const sequence of sequences.filter((codePoints) => codePoints.includes(KEYCAP))) {
        for (const codePoint of sequence) keycapHome.codePoints.add(codePoint);
    }

    const placed = new Set<number>(parent.keys());
    for (const slice of slices) {
        for (const codePoint of slice.codePoints) {
            if (!joined(codePoint) || parent.has(codePoint)) continue;
            if (placed.has(codePoint)) slice.codePoints.delete(codePoint);
            placed.add(codePoint);
        }
    }
    for (const codePoint of cmap) {
        if (coverage.has(codePoint) && joined(codePoint) && !placed.has(codePoint)) rest.codePoints.add(codePoint);
    }

    for (const sequence of sequences) {
        if (!slices.some((slice) => sequence.every((codePoint) => slice.codePoints.has(codePoint)))) {
            throw new Error(`no emoji slice holds the whole of ${String.fromCodePoint(...sequence)}`);
        }
    }
    // A slice whose emoji all moved away keeps only components, which never select it.
    return slices.filter((slice) => [...slice.codePoints].some((codePoint) => !EMOJI_COMPONENTS.has(codePoint)));
}

// Sorted characters as a CSS unicode-range, each run of neighbours one range.
export function formatRange(codePoints: ReadonlySet<number>): string {
    const sorted = [...codePoints].sort((a, b) => a - b);
    const ranges: string[] = [];
    for (let i = 0; i < sorted.length; i++) {
        let j = i;
        while (sorted[j + 1] === sorted[j] + 1) j++;
        const hex = (codePoint: number) => codePoint.toString(16).toUpperCase();
        ranges.push(i === j ? `U+${hex(sorted[i])}` : `U+${hex(sorted[i])}-${hex(sorted[j])}`);
        i = j;
    }
    return ranges.join(', ');
}

function parseRange(unicodeRange: string): number[] {
    return unicodeRange.split(',').flatMap((part) => {
        const [start, end = start] = part.trim().slice(2).split('-');
        return span(Number.parseInt(start, 16), Number.parseInt(end, 16));
    });
}

function span(start: number, end: number): number[] {
    return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}
