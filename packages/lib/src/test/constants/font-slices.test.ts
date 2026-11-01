import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { FontSlice } from '../../constants/font-slices';
import { FONT_SLICES, parseUnicodeRange, sliceStyle, slicesFor } from '../../constants/font-slices';
import { FALLBACK_FONTS, FONT_FACES } from '../../constants/fonts';

const FONTS_DIR = path.join(import.meta.dir, '../../../../ui/src/assets/fonts');
const ALL_FAMILIES = [...new Set(FONT_SLICES.map((slice) => slice.family))];
const ZWJ = 0x200d;
const VS15 = 0xfe0e;
const VS16 = 0xfe0f;
const KEYCAP = 0x20e3;
const COMPONENTS = [ZWJ, VS15, VS16, KEYCAP, 0xe0020, 0xe0067, 0xe007f];
const KEYCAP_BASES = [...'#*0123456789'].map((char) => char.charCodeAt(0));
// The most a chunk of a face's rest may weigh, about one of Google's published slices for that face.
const CJK_REST_BOUND = 60 * 1024;
const REST_BOUND = 40 * 1024;

function codePoints(...parts: (string | number)[]): Set<number> {
    const text = parts.map((part) => (typeof part === 'number' ? String.fromCodePoint(part) : part)).join('');
    return new Set(Array.from(text, (char) => char.codePointAt(0) ?? 0));
}

function rangeCodePoints(slice: FontSlice): number[] {
    return parseUnicodeRange(slice.unicodeRange).flatMap(([start, end]) =>
        Array.from({ length: end - start + 1 }, (_, i) => start + i),
    );
}

function sizeOf(slice: FontSlice): number {
    return fs.statSync(path.join(FONTS_DIR, slice.file)).size;
}

const kindOf = new Map(FALLBACK_FONTS.map((font) => [font.family, font.kind]));

describe('slicesFor', () => {
    test('a lone emoji picks one emoji slice', () => {
        const picked = slicesFor(codePoints('😀'), ALL_FAMILIES);
        expect(picked.map((slice) => slice.family)).toEqual(['Eigen Emoji']);
    });

    test('a component alone picks nothing, in any family', () => {
        for (const component of COMPONENTS) expect(slicesFor(codePoints(component), ALL_FAMILIES)).toEqual([]);
        expect(slicesFor(codePoints(ZWJ, VS16), ALL_FAMILIES)).toEqual([]);
    });

    test('a keycap picks the keycap slice, and a bare digit no emoji slice', () => {
        const keycap = slicesFor(codePoints('1', VS16, KEYCAP), ['Eigen Emoji']);
        expect(keycap).toHaveLength(1);
        expect(rangeCodePoints(keycap[0])).toEqual(expect.arrayContaining([...KEYCAP_BASES, VS16, KEYCAP]));
        expect(slicesFor(codePoints('1'), ['Eigen Emoji'])).toEqual([]);
        expect(slicesFor(codePoints('1'), ['Inter', 'Eigen Emoji']).map((slice) => slice.family)).toEqual([
            'Inter',
            'Inter',
        ]);
    });

    test('© ® ™ pick the Latin slices of Inter, and ❤ an emoji slice', () => {
        const latin = slicesFor(codePoints('A'), ['Inter']);
        expect(slicesFor(codePoints('©®™'), ['Inter', 'Eigen Emoji'])).toEqual(latin);
        expect(slicesFor(codePoints('❤'), ['Inter', 'Eigen Emoji']).map((slice) => slice.family)).toEqual([
            'Eigen Emoji',
        ]);
    });

    test('中 picks one Chinese slice, and 한 one Korean slice', () => {
        expect(slicesFor(codePoints('中'), ALL_FAMILIES).map((slice) => slice.family)).toEqual(['Noto Sans SC']);
        expect(slicesFor(codePoints('한'), ALL_FAMILIES).map((slice) => slice.family)).toEqual(['Noto Sans KR']);
    });

    test('a Han character outside every published range picks one rest chunk of Noto Sans SC, no larger than a slice', () => {
        const picked = slicesFor(codePoints('囒'), ALL_FAMILIES);
        expect(picked).toHaveLength(1);
        expect(picked[0].file).toMatch(/^noto-sans-sc\/NotoSansSC\.rest-\d+\.woff2$/);
        expect(sizeOf(picked[0])).toBeLessThanOrEqual(CJK_REST_BOUND);
    });

    test('→, which no published range of Inter holds, picks one small Inter slice', () => {
        const picked = slicesFor(codePoints('→'), ['Inter']);
        expect(picked.map((slice) => slice.style)).toEqual(['normal', 'italic']);
        for (const slice of picked) expect(sizeOf(slice)).toBeLessThanOrEqual(REST_BOUND);
    });

    test('a leading, a vowel and a trailing jamo pick one Korean slice, as they compose only inside one font', () => {
        expect(slicesFor(codePoints(0x1100, 0x1161, 0x11a8), ALL_FAMILIES)).toHaveLength(1);
        expect(slicesFor(codePoints(0xa960, 0xd7b0, 0xd7cb), ALL_FAMILIES)).toHaveLength(1);
    });

    test('only the families asked for, each slice once', () => {
        expect(slicesFor(codePoints('中😀'), ['Inter'])).toEqual([]);
        expect(slicesFor(codePoints('AB'), ['Inter'])).toHaveLength(2);
    });
});

describe('sliceStyle', () => {
    test("an italic run draws in its family's italic slices, and a family without them in its upright ones", () => {
        expect(sliceStyle('Inter', 'italic')).toBe('italic');
        expect(sliceStyle('Source Serif 4', 'oblique')).toBe('italic');
        expect(sliceStyle('Inter', 'normal')).toBe('normal');
        expect(sliceStyle('Excalifont', 'italic')).toBe('normal');
        expect(sliceStyle('Eigen Emoji', 'italic')).toBe('normal');
    });
});

describe('parseUnicodeRange', () => {
    test('a range is its first and last character, and a lone character is both', () => {
        expect(parseUnicodeRange('U+0-FF, U+131,U+2000-206F')).toEqual([
            [0, 0xff],
            [0x131, 0x131],
            [0x2000, 0x206f],
        ]);
    });
});

describe('the range data', () => {
    test('every face and every fallback has slices, and each slice is a file the build can serve', () => {
        const families = new Set([...FONT_FACES.map((face) => face.family), ...kindOf.keys()]);
        expect(new Set(ALL_FAMILIES)).toEqual(families);
        for (const slice of FONT_SLICES) {
            expect(slice.file).toMatch(/^[^/]+\/[^/]+\.woff2$/);
            expect(fs.existsSync(path.join(FONTS_DIR, slice.file))).toBe(true);
        }
    });

    test('an emoji or CJK family shares no character with another family, but the keycap bases', () => {
        const familiesOf = new Map<number, Set<string>>();
        for (const slice of FONT_SLICES) {
            if (kindOf.get(slice.family) === 'math') continue;
            for (const codePoint of rangeCodePoints(slice)) {
                familiesOf.set(codePoint, (familiesOf.get(codePoint) ?? new Set()).add(slice.family));
            }
        }
        const shared = [...familiesOf]
            .filter(([, families]) => families.size > 1 && [...families].some((family) => kindOf.has(family)))
            .map(([codePoint]) => codePoint);
        expect(shared.sort((a, b) => a - b)).toEqual([...KEYCAP_BASES].sort((a, b) => a - b));
    });

    test('within an emoji or CJK face, only the emoji components repeat', () => {
        const seen = new Set<string>();
        const repeated = new Set<number>();
        for (const slice of FONT_SLICES) {
            if (!kindOf.has(slice.family) || kindOf.get(slice.family) === 'math') continue;
            for (const codePoint of rangeCodePoints(slice)) {
                const key = `${slice.family}|${codePoint}`;
                if (seen.has(key)) repeated.add(codePoint);
                seen.add(key);
            }
        }
        const components = new Set([ZWJ, VS16, KEYCAP]);
        expect([...repeated].filter((codePoint) => !components.has(codePoint) && codePoint < 0xe0020)).toEqual([]);
    });

    test('every chunk of a rest is within its bound, unless it draws one character or is the jamo', () => {
        const rests = FONT_SLICES.filter(
            (slice) => /\.rest(-\d+)?\.woff2$/.test(slice.file) && slice.family !== 'Noto Sans KR',
        );
        expect(rests.length).toBeGreaterThan(0);
        for (const slice of rests) {
            const bound = kindOf.get(slice.family) === 'cjk' ? CJK_REST_BOUND : REST_BOUND;
            if (rangeCodePoints(slice).length > 1) expect(sizeOf(slice)).toBeLessThanOrEqual(bound);
        }
    });

    test('no CJK slice holds Basic Latin', () => {
        const cjk = FONT_SLICES.filter((slice) => kindOf.get(slice.family) === 'cjk');
        expect(cjk.length).toBeGreaterThan(0);
        for (const slice of cjk) expect(rangeCodePoints(slice).filter((codePoint) => codePoint < 0x80)).toEqual([]);
    });
});
