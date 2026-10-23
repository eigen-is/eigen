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

// Machado, Oliveira & Fernandes 2009, each dichromacy at severity 1, on linear RGB.
const VISIONS = {
    normal: null,
    deuteranopia: [
        [0.367322, 0.860646, -0.227968],
        [0.280085, 0.672501, 0.047413],
        [-0.01182, 0.04294, 0.968881],
    ],
    protanopia: [
        [0.152286, 1.052583, -0.204868],
        [0.114503, 0.786281, 0.099216],
        [-0.003882, -0.048116, 1.051998],
    ],
    tritanopia: [
        [1.255528, -0.076749, -0.178779],
        [-0.078411, 0.930809, 0.147602],
        [0.004733, 0.691367, 0.3039],
    ],
};
type Vision = keyof typeof VISIONS;

function lab(hex: string, vision: Vision): number[] {
    const rgb = linearRgb(hex);
    const matrix = VISIONS[vision];
    const [r, g, b] = matrix
        ? matrix.map((row) => Math.min(1, Math.max(0, row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2])))
        : rgb;
    const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
    const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
    const y = f(0.2126729 * r + 0.7151522 * g + 0.072175 * b);
    const z = f((0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const hue = (b: number, a: number) => ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;

// CIEDE2000 between two accents as the given vision sees them.
function distance(hexA: string, hexB: string, vision: Vision): number {
    const [l1, a1, b1] = lab(hexA, vision);
    const [l2, a2, b2] = lab(hexB, vision);
    const cMean7 = ((Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2) ** 7;
    const g = 0.5 * (1 - Math.sqrt(cMean7 / (cMean7 + 25 ** 7)));
    const c1 = Math.hypot((1 + g) * a1, b1);
    const c2 = Math.hypot((1 + g) * a2, b2);
    const h1 = hue(b1, (1 + g) * a1);
    const h2 = hue(b2, (1 + g) * a2);
    const dh = c1 * c2 === 0 ? 0 : ((h2 - h1 + 540) % 360) - 180;
    const dH = 2 * Math.sqrt(c1 * c2) * Math.sin(rad(dh / 2));
    const lMean = (l1 + l2) / 2;
    const cMean = (c1 + c2) / 2;
    // The mean of the two hues the short way round the circle.
    const hMean = c1 * c2 === 0 || Math.abs(h1 - h2) <= 180 ? (h1 + h2) / 2 : ((h1 + h2 + 360) / 2) % 360;
    const t =
        1 -
        0.17 * Math.cos(rad(hMean - 30)) +
        0.24 * Math.cos(rad(2 * hMean)) +
        0.32 * Math.cos(rad(3 * hMean + 6)) -
        0.2 * Math.cos(rad(4 * hMean - 63));
    const sL = 1 + (0.015 * (lMean - 50) ** 2) / Math.sqrt(20 + (lMean - 50) ** 2);
    const sC = 1 + 0.045 * cMean;
    const sH = 1 + 0.015 * cMean * t;
    const rC = 2 * Math.sqrt(cMean ** 7 / (cMean ** 7 + 25 ** 7));
    const rT = -Math.sin(rad(60 * Math.exp(-(((hMean - 275) / 25) ** 2)))) * rC;
    const dL = (l2 - l1) / sL;
    const dC = (c2 - c1) / sC;
    return Math.sqrt(dL ** 2 + dC ** 2 + (dH / sH) ** 2 + rT * dC * (dH / sH));
}

function closestPair(count: number, vision: Vision): number {
    const first = ORDER.slice(0, count);
    return Math.min(...first.flatMap((a, i) => first.slice(i + 1).map((b) => distance(a.value, b.value, vision))));
}

describe('accent order', () => {
    test('is the seventeen accents, each once', () => {
        expect(ORDER.map(({ value }) => value).sort()).toEqual(EIGEN_ACCENT_COLORS.map(({ value }) => value).sort());
    });

    test('the first is indigo, the brand accent, so a default calendar and a first series keep it', () => {
        expect(ORDER[0].label).toBe('indigo-500');
    });

    test('the first three are 20 apart for every vision, the first four 15', () => {
        for (const vision of Object.keys(VISIONS) as Vision[]) {
            expect(closestPair(3, vision)).toBeGreaterThanOrEqual(20);
            expect(closestPair(4, vision)).toBeGreaterThanOrEqual(15);
        }
    });

    test('every neighbor is 24 apart in normal vision, for a deuteranope and for a protanope', () => {
        for (const vision of ['normal', 'deuteranopia', 'protanopia'] as const) {
            for (let i = 1; i < ORDER.length; i++) {
                expect(distance(ORDER[i - 1].value, ORDER[i].value, vision)).toBeGreaterThanOrEqual(24);
            }
        }
    });

    test('none of the first eight is under 2:1 on white', () => {
        for (const { value } of ORDER.slice(0, 8)) expect(contrastOnWhite(value)).toBeGreaterThanOrEqual(2);
    });

    test('pink, the background a new deck opens on, comes last', () => {
        expect(ORDER.at(-1)?.label).toBe('pink-500');
    });
});
