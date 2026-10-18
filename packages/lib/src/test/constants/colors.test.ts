import { describe, expect, test } from 'bun:test';
import { EIGEN_ACCENT_COLORS, EIGEN_ACCENT_COLORS_SHUFFLED } from '../../constants/colors';

const ORDER = EIGEN_ACCENT_COLORS_SHUFFLED;

function linearRgb(hex: string): number[] {
    return [1, 3, 5].map((i) => {
        const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
}

function contrastOnWhite(hex: string): number {
    const [r, g, b] = linearRgb(hex);
    return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
}

// Machado, Oliveira & Fernandes 2009, deuteranopia at severity 1, on linear RGB.
const DEUTERANOPIA = [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
];

function deuteranopeLab(hex: string): number[] {
    const rgb = linearRgb(hex);
    const [r, g, b] = DEUTERANOPIA.map((row) =>
        Math.min(1, Math.max(0, row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2])),
    );
    const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
    const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
    const y = f(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
    const z = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

// ΔE76 between two accents as a deuteranope sees them. 60 is past every pair of this palette under ΔE2000 20.
function deuteranopeDistance(a: string, b: string): number {
    const [l1, a1, b1] = deuteranopeLab(a);
    const [l2, a2, b2] = deuteranopeLab(b);
    return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

describe('accent order', () => {
    test('is the seventeen accents, each once', () => {
        expect(ORDER.map(({ value }) => value).sort()).toEqual(EIGEN_ACCENT_COLORS.map(({ value }) => value).sort());
    });

    test('the first three are 3:1 or more on white, and none of the first eight is under 2:1', () => {
        for (const { value } of ORDER.slice(0, 3)) expect(contrastOnWhite(value)).toBeGreaterThanOrEqual(3);
        for (const { value } of ORDER.slice(0, 8)) expect(contrastOnWhite(value)).toBeGreaterThanOrEqual(2);
    });

    test('a deuteranope tells every neighbor apart, around all seventeen and from the eighth back to the first', () => {
        const pairs = [...ORDER.map((color, i) => [color, ORDER[(i + 1) % ORDER.length]]), [ORDER[7], ORDER[0]]];
        for (const [a, b] of pairs) expect(deuteranopeDistance(a.value, b.value)).toBeGreaterThanOrEqual(60);
    });

    test('pink, the background a new deck opens on, is past the first eight', () => {
        expect(ORDER.slice(0, 8).map(({ label }) => label)).not.toContain('pink-500');
    });
});
