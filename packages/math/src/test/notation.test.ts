import { expect, test } from 'bun:test';
import { ACCENTS, COMBINING_ACCENTS, FENCES, fromAlphanumeric, LINES, toAlphanumeric } from '../notation';
import { MATH_VARIANTS } from '../tree';

test('alphanumerics map both ways, Letterlike holes included', () => {
    expect(toAlphanumeric('h', 'italic')).toBe('ℎ');
    expect(toAlphanumeric('R', 'double-struck')).toBe('ℝ');
    expect(toAlphanumeric('C', 'fraktur')).toBe('ℭ');
    expect(toAlphanumeric('B', 'script')).toBe('ℬ');
    expect(toAlphanumeric('ϖ', 'bold')).toBe('𝛡');
    expect(toAlphanumeric('9', 'monospace')).toBe('𝟿');
    expect(toAlphanumeric('0', 'bold-italic')).toBeUndefined();
    expect(toAlphanumeric('x', 'normal')).toBeUndefined();
    for (const variant of MATH_VARIANTS) {
        for (const char of 'AZaz09αΩ∂') {
            const styled = toAlphanumeric(char, variant);
            if (styled) expect(fromAlphanumeric(styled)).toEqual([char, variant]);
        }
    }
    // The block's reserved code points are no letters: they stay as they are.
    expect(fromAlphanumeric('\u{1D455}')).toBeUndefined();
});

test('each accent has its own spacing character, never the line’s', () => {
    const spacing = [...ACCENTS.values()];
    expect(new Set(spacing).size).toBe(spacing.length);
    expect(spacing).not.toContain(LINES.over);
    for (const [combining, char] of ACCENTS) expect(COMBINING_ACCENTS.get(char)).toBe(combining);
});

// An editor's Unicode normalisation turns U+2329 and U+232A into U+3008 and U+3009, so the source escapes them.
test('the fences hold Word’s angle brackets, U+2329 and U+232A, not the CJK ones', () => {
    expect(FENCES.has('\u2329') && FENCES.has('\u232A')).toBe(true);
    expect(FENCES.has('\u3008') || FENCES.has('\u3009')).toBe(false);
});
