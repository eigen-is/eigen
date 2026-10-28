import { describe, expect, test } from 'bun:test';
import {
    EIGEN_ACCENT_COLORS,
    EIGEN_ACCENT_COLORS_SHUFFLED,
    hexChannels,
    isHexColor,
    isLightColor,
    lightenColor,
    parseRgb,
} from '../../constants/colors';

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

    test('the first is pink, Eigen’s accent, so a default calendar and a first series take it', () => {
        expect(ORDER[0].label).toBe('pink-500');
    });

    // What the order reaches with pink first: amber and green, second and fourth, are closest for a protanope.
    test('the first three and the first four keep each vision’s floor', () => {
        for (const [vision, three, four] of [
            ['normal', 50, 45],
            ['deuteranopia', 20, 10],
            ['protanopia', 20, 6],
            ['tritanopia', 10, 10],
        ] as const) {
            expect(closestPair(3, vision)).toBeGreaterThanOrEqual(three);
            expect(closestPair(4, vision)).toBeGreaterThanOrEqual(four);
        }
    });

    test('every neighbor is 23 apart in normal vision, for a deuteranope and for a protanope', () => {
        for (const vision of ['normal', 'deuteranopia', 'protanopia'] as const) {
            for (let i = 1; i < ORDER.length; i++) {
                expect(distance(ORDER[i - 1].value, ORDER[i].value, vision)).toBeGreaterThanOrEqual(23);
            }
        }
    });

    test('none of the first eight is under 2:1 on white', () => {
        for (const { value } of ORDER.slice(0, 8)) expect(contrastOnWhite(value)).toBeGreaterThanOrEqual(2);
    });
});

describe('isHexColor', () => {
    test.each([
        ['#abc', [3]],
        ['#ABC', [3]],
        ['#abcd', [3, 4, 6, 8]],
        ['#aabbcc', [6]],
        ['#AaBbCc', [6]],
        ['#aabbccdd', [3, 6, 8]],
    ] as const)('%s has one of the digit counts %p', (value, digits) => {
        expect(isHexColor(value, digits)).toBe(true);
    });

    test.each([
        ['#abcd', [3, 6, 8]],
        ['#abc', [6]],
        ['#aabbccdd', [6]],
        ['aabbcc', [6]],
        ['#ggg', [3]],
        ['#12345', [3, 4, 6, 8]],
        ['#abc;color:red', [3]],
        ['#abc\n', [3]],
        ['', [3]],
    ] as const)('%p is not a hex color of %p digits', (value, digits) => {
        expect(isHexColor(value, digits)).toBe(false);
    });
});

describe('hexChannels', () => {
    test.each([
        ['#e60076', { red: 230, green: 0, blue: 118, alpha: 1 }],
        ['#E60076', { red: 230, green: 0, blue: 118, alpha: 1 }],
        ['#e6007680', { red: 230, green: 0, blue: 118, alpha: 128 / 255 }],
        ['#f08', { red: 255, green: 0, blue: 136, alpha: 1 }],
        ['#f080', { red: 255, green: 0, blue: 136, alpha: 0 }],
    ])('%s reads as its channels', (value, channels) => {
        expect(hexChannels(value, [3, 4, 6, 8])).toEqual(channels);
    });

    test('a value of another digit count, or no hex at all, has none', () => {
        expect(hexChannels('#f08', [6, 8])).toBeUndefined();
        expect(hexChannels('#ggg', [3])).toBeUndefined();
        expect(hexChannels('rgb(1, 2, 3)', [3, 6])).toBeUndefined();
    });
});

describe('isLightColor and lightenColor', () => {
    test('read #rrggbb, with or without an alpha', () => {
        expect([isLightColor('#ffffff'), isLightColor('#000000'), isLightColor('#ffffff80')]).toEqual([
            true,
            false,
            true,
        ]);
        expect(lightenColor('#000000', 0.5)).toBe('#808080');
        expect(lightenColor('#00000080', 0.5)).toBe('#808080');
    });

    test('leave a color that is no #rrggbb as it is, and count it as dark', () => {
        expect(isLightColor('#fff')).toBe(false);
        expect(lightenColor('#fff', 0.5)).toBe('#fff');
    });
});

describe('parseRgb', () => {
    test.each([
        ['rgb(0, 128, 255)', '#0080ff', 1],
        ['rgb(0,128,255)', '#0080ff', 1],
        ['rgb(0 128 255)', '#0080ff', 1],
        ['RGB( 0, 128, 255 )', '#0080ff', 1],
        ['rgba(1, 2, 3, 0.5)', '#010203', 0.5],
        ['rgb(1 2 3 / 50%)', '#010203', 0.5],
        ['rgba(0, 0, 0, 0)', '#000000', 0],
        ['rgb(1.4, 2.6, 3)', '#010303', 1],
        ['rgba(1, 2, 3, 2)', '#010203', 1],
    ])('%s is %s at alpha %p', (color, hex, alpha) => {
        expect(parseRgb(color)).toEqual({ hex, alpha });
    });

    test.each([
        'rgb(300, 0, 0)',
        'rgb(-1, 0, 0)',
        'rgb(1, 2)',
        'rgb(1.2.3, 0, 0)',
        'rgb(50%, 0, 0)',
        'rgb(1, 2, 3);background:url(x)',
        'hsl(0, 0%, 0%)',
        '#010203',
        'red',
        '',
    ])('%p is no rgb() color', (color) => {
        expect(parseRgb(color)).toBeUndefined();
    });
});

describe('parseRgb on hostile input', () => {
    test.each([
        ['a channel slot', `rgb(${'1'.repeat(100_000)}x`],
        ['an alpha slot', `rgba(1, 2, 3, ${'1'.repeat(100_000)}x`],
        ['a long fraction', `rgb(1, 2, 3.${'1'.repeat(100_000)}x`],
    ])('a 100k-character run in %s costs little CPU', (_slot, color) => {
        const started = process.cpuUsage();
        expect(parseRgb(color)).toBeUndefined();
        const { user, system } = process.cpuUsage(started);
        expect((user + system) / 1000).toBeLessThan(100);
    });
});
