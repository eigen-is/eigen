// Based on Tailwind Colors

function goldenRatioIndices(n: number): number[] {
    const phi = (Math.sqrt(5) - 1) / 2; // golden ratio conjugate ≈ 0.6180339887
    return Array.from({ length: n }, (_, i) => i).sort((a, b) => ((a * phi) % 1) - ((b * phi) % 1));
}

function goldenRatioShuffle<T>(arr: T[]): T[] {
    return goldenRatioIndices(arr.length).map((i) => arr[i]);
}

export type EigenColor = {
    label: string;
    value: string; // hex value
};

export const EIGEN_COLOR_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
export const EIGEN_COLOR_NAMES = [
    'red',
    'orange',
    'amber',
    'yellow',
    'lime',
    'green',
    'emerald',
    'teal',
    'cyan',
    'sky',
    'blue',
    'indigo',
    'violet',
    'purple',
    'fuchsia',
    'pink',
    'rose',
] as const;
export const EIGEN_COLORS_MAP = [
    [
        '#fef2f2',
        '#ffe2e2',
        '#ffc9c9',
        '#ffa2a2',
        '#ff6467',
        '#fb2c36',
        '#e7000b',
        '#c10007',
        '#9f0712',
        '#82181a',
        '#460809',
    ],
    [
        '#fff7ed',
        '#ffedd4',
        '#ffd6a7',
        '#ffb86a',
        '#ff8904',
        '#ff6900',
        '#f54900',
        '#ca3500',
        '#9f2d00',
        '#7e2a0c',
        '#441306',
    ],
    [
        '#fffbeb',
        '#fef3c6',
        '#fee685',
        '#ffd230',
        '#ffb900',
        '#fe9a00',
        '#e17100',
        '#bb4d00',
        '#973c00',
        '#7b3306',
        '#461901',
    ],
    [
        '#fefce8',
        '#fef9c2',
        '#fff085',
        '#ffdf20',
        '#fdc700',
        '#f0b100',
        '#d08700',
        '#a65f00',
        '#894b00',
        '#733e0a',
        '#432004',
    ],
    [
        '#f7fee7',
        '#ecfcca',
        '#d8f999',
        '#bbf451',
        '#9ae600',
        '#7ccf00',
        '#5ea500',
        '#497d00',
        '#3c6300',
        '#35530e',
        '#192e03',
    ],
    [
        '#f0fdf4',
        '#dcfce7',
        '#b9f8cf',
        '#7bf1a8',
        '#05df72',
        '#00c950',
        '#00a63e',
        '#008236',
        '#016630',
        '#0d542b',
        '#032e15',
    ],
    [
        '#ecfdf5',
        '#d0fae5',
        '#a4f4cf',
        '#5ee9b5',
        '#00d492',
        '#00bc7d',
        '#009966',
        '#007a55',
        '#006045',
        '#004f3b',
        '#002c22',
    ],
    [
        '#f0fdfa',
        '#cbfbf1',
        '#96f7e4',
        '#46ecd5',
        '#00d5be',
        '#00bba7',
        '#009689',
        '#00786f',
        '#005f5a',
        '#0b4f4a',
        '#022f2e',
    ],
    [
        '#ecfeff',
        '#cefafe',
        '#a2f4fd',
        '#53eafd',
        '#00d3f2',
        '#00b8db',
        '#0092b8',
        '#007595',
        '#005f78',
        '#104e64',
        '#053345',
    ],
    [
        '#f0f9ff',
        '#dff2fe',
        '#b8e6fe',
        '#74d4ff',
        '#00bcff',
        '#00a6f4',
        '#0084d1',
        '#0069a8',
        '#00598a',
        '#024a70',
        '#052f4a',
    ],
    [
        '#eff6ff',
        '#dbeafe',
        '#bedbff',
        '#8ec5ff',
        '#51a2ff',
        '#2b7fff',
        '#155dfc',
        '#1447e6',
        '#193cb8',
        '#1c398e',
        '#162456',
    ],
    [
        '#eef2ff',
        '#e0e7ff',
        '#c6d2ff',
        '#a3b3ff',
        '#7c86ff',
        '#615fff',
        '#4f39f6',
        '#432dd7',
        '#372aac',
        '#312c85',
        '#1e1a4d',
    ],
    [
        '#f5f3ff',
        '#ede9fe',
        '#ddd6ff',
        '#c4b4ff',
        '#a684ff',
        '#8e51ff',
        '#7f22fe',
        '#7008e7',
        '#5d0ec0',
        '#4d179a',
        '#2f0d68',
    ],
    [
        '#faf5ff',
        '#f3e8ff',
        '#e9d4ff',
        '#dab2ff',
        '#c27aff',
        '#ad46ff',
        '#9810fa',
        '#8200db',
        '#6e11b0',
        '#59168b',
        '#3c0366',
    ],
    [
        '#fdf4ff',
        '#fae8ff',
        '#f6cfff',
        '#f4a8ff',
        '#ed6aff',
        '#e12afb',
        '#c800de',
        '#a800b7',
        '#8a0194',
        '#721378',
        '#4b004f',
    ],
    [
        '#fdf2f8',
        '#fce7f3',
        '#fccee8',
        '#fda5d5',
        '#fb64b6',
        '#f6339a',
        '#e60076',
        '#c6005c',
        '#a3004c',
        '#861043',
        '#510424',
    ],
    [
        '#fff1f2',
        '#ffe4e6',
        '#ffccd3',
        '#ffa1ad',
        '#ff637e',
        '#ff2056',
        '#ec003f',
        '#c70036',
        '#a50036',
        '#8b0836',
        '#4d0218',
    ],
] as const;

export const EIGEN_ACCENT_COLOR_ROW = 5;
export const EIGEN_STICKIES_COLOR_ROW = 1;

export const EIGEN_COLORS = EIGEN_COLORS_MAP.map((col, i) =>
    col.map((hex, s) => ({ label: `${EIGEN_COLOR_NAMES[i]}-${EIGEN_COLOR_STEPS[s]}`, value: hex })),
) as EigenColor[][];
export const EIGEN_ACCENT_COLORS = EIGEN_COLORS.map((col) => col[EIGEN_ACCENT_COLOR_ROW]) as EigenColor[];
export const EIGEN_ACCENT_COLORS_SHUFFLED = goldenRatioShuffle(EIGEN_ACCENT_COLORS);

// Deterministic accent color (hex) for a user id. Stable across sessions and
// editors so a collaborator keeps one color everywhere (docs carets, sheet
// cursors). Same hash the docs presence caret has always used.
export function userColor(userId: string): string {
    const hash = Math.abs([...userId].reduce((h, c) => (h << 5) - h + c.charCodeAt(0), 0));
    return EIGEN_ACCENT_COLORS_SHUFFLED[hash % EIGEN_ACCENT_COLORS_SHUFFLED.length].value;
}
export const EIGEN_STICKIES_COLORS = [EIGEN_STICKIES_COLOR_ROW].map((ri) =>
    [1, 3, 5, 7, 9, 11, 13, 15].map((ci) => EIGEN_COLORS[ci][ri]),
);

export const EIGEN_STICKIES_INDICATOR_ROW = 4;
export const EIGEN_STICKIES_INDICATOR_MAP: Map<string, string> = new Map(
    [1, 3, 5, 7, 9, 11, 13, 15].map((ci) => [
        EIGEN_COLORS_MAP[ci][EIGEN_STICKIES_COLOR_ROW],
        EIGEN_COLORS_MAP[ci][EIGEN_STICKIES_INDICATOR_ROW],
    ]),
);

export function isLightColor(hex: string): boolean {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.5;
}

export function lightenColor(hex: string, amount: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `#${[r, g, b]
        .map((c) =>
            Math.round(c + (255 - c) * amount)
                .toString(16)
                .padStart(2, '0'),
        )
        .join('')}`;
}
