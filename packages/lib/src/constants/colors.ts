// Eigen's color palette, based on Tailwind's colors, with the pink column's accent row as Eigen's accent, and the
// one reader of a written color. Readers such as a sheet cell's fill, a doc's text color and the Office exports
// check a hex with isHexColor, read its channels with hexChannels and read an rgb() with parseRgb, so they agree on
// what a color is.

export type EigenColor = {
    label: string;
    value: string; // hex value
};

const EIGEN_COLOR_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
const EIGEN_COLOR_NAMES = [
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

export const EIGEN_COLORS: EigenColor[][] = EIGEN_COLORS_MAP.map((col, i) =>
    col.map((hex, s) => ({ label: `${EIGEN_COLOR_NAMES[i]}-${EIGEN_COLOR_STEPS[s]}`, value: hex })),
);
export const EIGEN_ACCENT_COLORS = EIGEN_COLORS.map((col) => col[EIGEN_ACCENT_COLOR_ROW]);
// The order calendars, labels, chart series and presence hand the accents out in. Pink, Eigen's accent, comes first;
// each next one is the furthest (CIEDE2000) from those before it for normal vision and simulated deuteranopia, then
// protanopia and tritanopia. Yellow and lime (under 2:1 on white) sit past the eighth, and rose and fuchsia, which sit
// close to pink, come late. colors.test.ts pins it.
const EIGEN_ACCENT_ORDER = [
    'pink',
    'green',
    'sky',
    'amber',
    'indigo',
    'red',
    'teal',
    'orange',
    'violet',
    'yellow',
    'fuchsia',
    'lime',
    'cyan',
    'rose',
    'blue',
    'emerald',
    'purple',
] as const satisfies readonly (typeof EIGEN_COLOR_NAMES)[number][];
export const EIGEN_ACCENT_COLORS_SHUFFLED = EIGEN_ACCENT_ORDER.map(
    (name) => EIGEN_ACCENT_COLORS[EIGEN_COLOR_NAMES.indexOf(name)],
);

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

// Whether black text reads better than white on a #rrggbb color. Anything else counts as dark.
export function isLightColor(hex: string): boolean {
    const channels = hexChannels(hex, [6, 8]);
    if (!channels) return false;
    const { red, green, blue } = channels;
    return (0.299 * red + 0.587 * green + 0.114 * blue) / 255 > 0.5;
}

// A #rrggbb color moved toward white by an amount from 0 to 1. A color that is no hex stays as it is.
export function lightenColor(hex: string, amount: number): string {
    const channels = hexChannels(hex, [6, 8]);
    if (!channels) return hex;
    const { red, green, blue } = channels;
    return `#${[red, green, blue]
        .map((c) =>
            Math.round(c + (255 - c) * amount)
                .toString(16)
                .padStart(2, '0'),
        )
        .join('')}`;
}

// A hex color: `#` and then one of the digit counts the caller takes, in either case. Each reader names its own
// counts, such as six for a doc's text color.
export function isHexColor(value: string, digits: readonly (3 | 4 | 6 | 8)[]): boolean {
    return /^#[0-9a-f]+$/i.test(value) && digits.some((count) => value.length === count + 1);
}

export type ColorChannels = { red: number; green: number; blue: number; alpha: number };

// A hex color's channels, from 0 to 255, and its alpha, from 0 to 1, for the digit counts the caller takes. A short
// form doubles each digit, as CSS does. Undefined for any other value.
export function hexChannels(value: string, digits: readonly (3 | 4 | 6 | 8)[]): ColorChannels | undefined {
    if (!isHexColor(value, digits)) return undefined;
    const hex = value.length <= 5 ? value.slice(1).replace(/./g, (digit) => digit + digit) : value.slice(1);
    const byte = (index: number) => Number.parseInt(hex.slice(2 * index, 2 * index + 2), 16);
    return { red: byte(0), green: byte(1), blue: byte(2), alpha: hex.length === 8 ? byte(3) / 255 : 1 };
}

// A number is digits with an optional fraction, or a bare fraction. The two branches start on different characters, so
// a long run of digits has one way to match and a hostile stored color costs a linear scan.
const RGB_NUMBER = String.raw`(\d+(?:\.\d+)?|\.\d+)`;
const RGB_COLOR = new RegExp(
    String.raw`^rgba?\(\s*${RGB_NUMBER}[\s,]+${RGB_NUMBER}[\s,]+${RGB_NUMBER}(?:\s*[,/]\s*${RGB_NUMBER}(%?))?\s*\)$`,
    'i',
);

// An rgb() or rgba() color, as a browser computes it or a stylesheet writes it: commas or spaces, channels
// rounded to whole numbers, and an alpha as a number or a percent. It reads as #rrggbb and an alpha from 0 to 1.
// A channel past 255 is no color.
export function parseRgb(color: string): { hex: string; alpha: number } | undefined {
    const [, red, green, blue, alpha, percent] = RGB_COLOR.exec(color) ?? [];
    const channels = [red, green, blue].map((channel) => Math.round(Number(channel)));
    if (red === undefined || channels.some((channel) => channel > 255)) return undefined;
    return {
        hex: `#${channels.map((channel) => channel.toString(16).padStart(2, '0')).join('')}`,
        alpha: alpha === undefined ? 1 : Math.min(Number(alpha) / (percent ? 100 : 1), 1),
    };
}
