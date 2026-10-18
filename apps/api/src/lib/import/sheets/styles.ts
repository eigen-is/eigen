import { bundledFont } from '@workspace/lib/constants/fonts';
import type {
    BorderSide,
    CellBorderSides,
    CellStyle,
    DefaultConditionalFormatRule,
    Cell as FortuneCell,
} from '@workspace/lib/sheets';
import { BORDER_STYLES } from '@workspace/lib/sheets';
import { is_date, isValidNumberFormat } from '@workspace/sheet/engine';
import { ApiError } from '../../core/errors';
import { A_NS, isOn, SML_NS } from '../../core/ooxml';
import { type XmlElement, xmlAttr, xmlChild, xmlChildren } from '../../core/xml';
import { IMPORT_MESSAGES } from '../messages';

// The styles part read into one look per cell format (xf), resolved once: fonts, fills, alignment, borders, number
// formats, theme colours and tints; and the conditional formats' looks (dxf).

export type ThemePalette = string[];

// An rgb, else a theme colour and its tint.
type XlsxColor = { argb?: string; theme?: number; tint?: number };

export type Look = {
    // The keys every cell of the format carries.
    cell: FortuneCell;
    // What a value displays with, as written; undefined for General and for a format numfmt can't parse, which shows
    // General.
    numFmt?: string;
    // The cell's ct.fa: numFmt with month and minute in the Google convention.
    fa?: string;
    isDate: boolean;
    // The format names a horizontal alignment, General too, so a number keeps it rather than aligning right.
    aligned: boolean;
    border?: CellBorderSides;
};

const HORIZONTAL_MAP = new Map<string, 0 | 1 | 2>([
    ['left', 1],
    ['center', 0],
    ['right', 2],
    ['fill', 1],
    ['justify', 1],
    ['centerContinuous', 0],
    ['distributed', 0],
]);

const VERTICAL_MAP = new Map<string, 0 | 1 | 2>([
    ['top', 1],
    ['center', 0],
    ['bottom', 2],
    ['distributed', 0],
    ['justify', 0],
]);

// xlsx style name → ordinal, derived from the shared ordinal table (the reverse of its `name`).
const BORDER_STYLE_MAP = new Map<string, number>(
    Object.entries(BORDER_STYLES).map(([ord, { name }]) => [name, Number(ord)]),
);

// ECMA-376 § 18.8.30's built-in formats that name one code whatever the locale.
const BUILTIN_FORMATS = new Map<number, string>([
    [0, 'General'],
    [1, '0'],
    [2, '0.00'],
    [3, '#,##0'],
    [4, '#,##0.00'],
    [9, '0%'],
    [10, '0.00%'],
    [11, '0.00E+00'],
    [12, '# ?/?'],
    [13, '# ??/??'],
    [14, 'mm-dd-yy'],
    [15, 'd-mmm-yy'],
    [16, 'd-mmm'],
    [17, 'mmm-yy'],
    [18, 'h:mm AM/PM'],
    [19, 'h:mm:ss AM/PM'],
    [20, 'h:mm'],
    [21, 'h:mm:ss'],
    [22, 'm/d/yy h:mm'],
    [37, '#,##0 ;(#,##0)'],
    [38, '#,##0 ;[Red](#,##0)'],
    [39, '#,##0.00 ;(#,##0.00)'],
    [40, '#,##0.00 ;[Red](#,##0.00)'],
    [45, 'mm:ss'],
    [46, '[h]:mm:ss'],
    [47, 'mmss.0'],
    [48, '##0.0E+0'],
    [49, '@'],
]);

export const NO_LOOK: Look = { cell: {}, aligned: false, isDate: false };

// Excel's own limits are a format of 255 characters and 250 of the workbook's own. A format's date test and canonical
// form cost per character, and so does every display through it: a longer one reads as General, and cell formats that
// name more formats than four times Excel's allowance are refused. The corpus's longest is 76 characters, its most
// formats 126.
const MAX_NUMBER_FORMAT_LENGTH = 255;
const MAX_NUMBER_FORMATS = 1000;

export function readLooks(styleSheet: XmlElement | undefined, palette: ThemePalette): Look[] {
    const list = (group: string, item: string) => {
        const parent = styleSheet && xmlChild(styleSheet, SML_NS, group);
        return parent ? xmlChildren(parent, SML_NS, item) : [];
    };
    const formats = new Map(BUILTIN_FORMATS);
    for (const numFmt of list('numFmts', 'numFmt')) {
        const code = xmlAttr(numFmt, '', 'formatCode');
        if (code) formats.set(Number(xmlAttr(numFmt, '', 'numFmtId')), code);
    }
    const fonts = list('fonts', 'font').map((font) => fontLook(font, palette));
    const fills = list('fills', 'fill').map((fill) => {
        // Any pattern but none paints its foreground; a gradient paints nothing.
        const pattern = xmlChild(fill, SML_NS, 'patternFill');
        if (!pattern || xmlAttr(pattern, '', 'patternType') === 'none') return null;
        return resolveColor(colorOf(xmlChild(pattern, SML_NS, 'fgColor')), palette);
    });
    const borders = list('borders', 'border').map((border) => bordersOf(border, palette));
    // Once per format, not per xf: a long code costs its canonical form and date test, and many xfs can name it.
    const resolved = new Map<number, Pick<Look, 'numFmt' | 'fa' | 'isDate'>>();
    const resolve = (id: number) => {
        if (resolved.size >= MAX_NUMBER_FORMATS) throw new ApiError(413, IMPORT_MESSAGES.xlsx.tooLarge);
        const code = formats.get(id);
        const numFmt = code === 'General' || (code?.length ?? 0) > MAX_NUMBER_FORMAT_LENGTH ? undefined : code;
        // numfmt parses a format it can't read again on every display, to throw; it shows General.
        const drawn = numFmt && isValidNumberFormat(numFmt) ? numFmt : undefined;
        const format = {
            numFmt: drawn,
            fa: numFmt && normalizeMonthMinuteTokens(numFmt),
            isDate: drawn !== undefined && is_date(drawn),
        };
        resolved.set(id, format);
        return format;
    };
    return list('cellXfs', 'xf').map((xf, index): Look => {
        // The workbook's default look, which Eigen draws with its own.
        if (index === 0) return NO_LOOK;
        // An id that is no number reads as NaN, which indexes nothing.
        const id = (name: string) => Number(xmlAttr(xf, '', name));
        const alignment = xmlChild(xf, SML_NS, 'alignment');
        const bg = fills[id('fillId')];
        return {
            cell: { ...fonts[id('fontId')], ...(bg && { bg }), ...(alignment && alignmentLook(alignment)) },
            ...(resolved.get(id('numFmtId')) ?? resolve(id('numFmtId'))),
            aligned: Boolean(alignment && xmlAttr(alignment, '', 'horizontal')),
            border: borders[id('borderId')],
        };
    });
}

// The workbook's default font, the first, which a column width counts in.
export function defaultFontName(styleSheet: XmlElement | undefined): string | undefined {
    const fonts = styleSheet && xmlChild(styleSheet, SML_NS, 'fonts');
    const font = fonts && xmlChild(fonts, SML_NS, 'font');
    const name = font && xmlChild(font, SML_NS, 'name');
    return name && xmlAttr(name, '', 'val');
}

// What a conditional format paints: its font's colour and its fill's.
export type DxfLook = DefaultConditionalFormatRule['format'];

export function readDxfs(styleSheet: XmlElement | undefined, palette: ThemePalette): DxfLook[] {
    const dxfs = styleSheet && xmlChild(styleSheet, SML_NS, 'dxfs');
    return dxfs ? xmlChildren(dxfs, SML_NS, 'dxf').map((dxf) => dxfLook(dxf, palette)) : [];
}

// A dxf's solid fill names its colour in bgColor, as Excel writes it, or in both, as Google Sheets does; a pattern of
// none is a font-only dxf, and a gradient paints nothing.
export function dxfLook(dxf: XmlElement | undefined, palette: ThemePalette): DxfLook {
    const font = dxf && xmlChild(dxf, SML_NS, 'font');
    const fill = dxf && xmlChild(dxf, SML_NS, 'fill');
    const pattern = fill && xmlChild(fill, SML_NS, 'patternFill');
    const color = (element: XmlElement | undefined, name: string) =>
        resolveColor(colorOf(element && xmlChild(element, SML_NS, name)), palette);
    return {
        textColor: color(font, 'color'),
        cellColor:
            pattern && xmlAttr(pattern, '', 'patternType') !== 'none'
                ? (color(pattern, 'fgColor') ?? color(pattern, 'bgColor'))
                : null,
    };
}

// A run's properties read as a font, its face named by rFont.
export function fontLook(font: XmlElement | undefined, palette: ThemePalette): CellStyle {
    const look: CellStyle = {};
    if (!font) return look;
    const child = (name: string) => xmlChild(font, SML_NS, name);
    // A bare toggle is on.
    const on = (name: string) => {
        const toggle = child(name);
        return toggle !== undefined && isOn(xmlAttr(toggle, '', 'val')) !== false;
    };
    if (on('b')) look.bl = 1;
    if (on('i')) look.it = 1;
    const underline = child('u');
    if (underline && xmlAttr(underline, '', 'val') !== 'none') look.un = 1;
    if (on('strike')) look.cl = 1;
    const size = child('sz');
    const points = size ? Number.parseFloat(xmlAttr(size, '', 'val') ?? '') : Number.NaN;
    if (Number.isFinite(points)) look.fs = points;
    const face = child('name') ?? child('rFont');
    const name = face && xmlAttr(face, '', 'val');
    const mapped = name && bundledFont(name);
    if (mapped) look.ff = mapped;
    const color = resolveColor(colorOf(child('color')), palette);
    if (color) look.fc = color;
    return look;
}

function alignmentLook(alignment: XmlElement): FortuneCell {
    const look: FortuneCell = {};
    const horizontal = HORIZONTAL_MAP.get(xmlAttr(alignment, '', 'horizontal') ?? '');
    if (horizontal !== undefined) look.ht = horizontal;
    const vertical = VERTICAL_MAP.get(xmlAttr(alignment, '', 'vertical') ?? '');
    if (vertical !== undefined) look.vt = vertical;
    if (isOn(xmlAttr(alignment, '', 'wrapText'))) look.tb = '2';
    // 0 to 90 turns up, 91 to 180 down by the excess over 90, and 255 stacks the characters.
    const rotation = Number.parseInt(xmlAttr(alignment, '', 'textRotation') ?? '', 10);
    if (rotation === 255) look.rt = 'vertical';
    else if (rotation > 0 && rotation <= 90) look.rt = rotation;
    else if (rotation > 90 && rotation <= 180) look.rt = 90 - rotation;
    return look;
}

function bordersOf(border: XmlElement, palette: ThemePalette): CellBorderSides | undefined {
    const side = (name: string): BorderSide | undefined => {
        const edge = xmlChild(border, SML_NS, name);
        const style = edge && BORDER_STYLE_MAP.get(xmlAttr(edge, '', 'style') ?? '');
        if (!edge || style === undefined) return undefined;
        return { style, color: resolveColor(colorOf(xmlChild(edge, SML_NS, 'color')), palette) ?? '#000000' };
    };
    const l = side('left');
    const r = side('right');
    const t = side('top');
    const b = side('bottom');
    // Our slash `s` is a top-left → bottom-right diagonal, i.e. xlsx's diagonalDown; a diagonalUp-only border has no
    // equivalent in our single-direction slash and is dropped.
    const s = isOn(xmlAttr(border, '', 'diagonalDown')) ? side('diagonal') : undefined;
    const sides: CellBorderSides = {
        ...(l && { l }),
        ...(r && { r }),
        ...(t && { t }),
        ...(b && { b }),
        ...(s && { s }),
    };
    return Object.keys(sides).length > 0 ? sides : undefined;
}

// An indexed colour is none.
export function colorOf(element: XmlElement | undefined): XlsxColor | undefined {
    const rgb = element && xmlAttr(element, '', 'rgb');
    if (rgb) return { argb: rgb };
    const theme = element && xmlAttr(element, '', 'theme');
    if (!element || !theme) return undefined;
    const tint = Number.parseFloat(xmlAttr(element, '', 'tint') ?? '');
    return { theme: Number.parseInt(theme, 10), ...(Number.isFinite(tint) && { tint }) };
}

function argbToHex(argb: string): string {
    const rgb = argb.length === 8 ? argb.slice(2) : argb;
    return `#${rgb.toUpperCase()}`;
}

export function resolveColor(color: XlsxColor | undefined, theme: ThemePalette): string | null {
    if (!color) return null;
    if (color.argb) {
        const hex = argbToHex(color.argb);
        return color.tint != null ? applyTint(hex, color.tint) : hex;
    }
    if (color.theme != null && color.theme >= 0 && color.theme < theme.length) {
        const hex = theme[color.theme];
        return color.tint != null ? applyTint(hex, color.tint) : hex;
    }
    return null;
}

function applyTint(hex: string, tint: number): string {
    const raw = hex.replace('#', '');
    let r = Number.parseInt(raw.substring(0, 2), 16);
    let g = Number.parseInt(raw.substring(2, 4), 16);
    let b = Number.parseInt(raw.substring(4, 6), 16);
    if (tint > 0) {
        r = Math.round(r + (255 - r) * tint);
        g = Math.round(g + (255 - g) * tint);
        b = Math.round(b + (255 - b) * tint);
    } else {
        r = Math.round(r * (1 + tint));
        g = Math.round(g * (1 + tint));
        b = Math.round(b * (1 + tint));
    }
    const toHex = (v: number) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0').toUpperCase();
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// SpreadsheetML theme indices: 0=lt1, 1=dk1, 2=lt2, 3=dk2, 4-9=accent1-6, 10=hlink, 11=folHlink.
// The clrScheme XML lists them as dk1,lt1,dk2,lt2,accent1-6,hlink,folHlink — reorder to match.
const CLR_SCHEME_ELEMENTS = [
    'dk1',
    'lt1',
    'dk2',
    'lt2',
    'accent1',
    'accent2',
    'accent3',
    'accent4',
    'accent5',
    'accent6',
    'hlink',
    'folHlink',
] as const;
const THEME_INDEX_ORDER = [1, 0, 3, 2, 4, 5, 6, 7, 8, 9, 10, 11] as const;

export function themePalette(theme: XmlElement | undefined): ThemePalette {
    const elements = theme?.ns === A_NS ? xmlChild(theme, A_NS, 'themeElements') : undefined;
    const scheme = elements && xmlChild(elements, A_NS, 'clrScheme');
    if (!scheme) return [];

    const xmlColors: string[] = [];
    for (const el of CLR_SCHEME_ELEMENTS) {
        const slot = xmlChild(scheme, A_NS, el);
        const srgb = slot && xmlChild(slot, A_NS, 'srgbClr');
        const sys = slot && xmlChild(slot, A_NS, 'sysClr');
        const hex = (srgb && xmlAttr(srgb, '', 'val')) ?? (sys && xmlAttr(sys, '', 'lastClr'));
        xmlColors.push(hex && /^[A-Fa-f0-9]{6}$/.test(hex) ? `#${hex.toUpperCase()}` : '#000000');
    }

    const palette: ThemePalette = [];
    for (const xmlIndex of THEME_INDEX_ORDER) {
        palette.push(xmlColors[xmlIndex]);
    }
    return palette;
}

// Excel writes month and minute both as `m`, told apart by what sits beside it, and numfmt reads it so. The format
// dialog follows Google (`M` month, `m` minute), so a stored month `mm` would edit as minutes: each run is recased by
// numfmt's own rule (dateChunks), so only the case changes and the display never does. Only hours and seconds, which
// make a run a minute, and minutes, which a later seconds resolves, take part; every other date token breaks the run.
const DATE_HOUR = 1;
const DATE_MIN = 2;
const DATE_SEC = 4;

type DateChunk = { size: number; used?: boolean; indeterminate?: boolean; mRef?: number };

// Split on top-level `;` section separators, leaving separators inside quoted literals,
// `\`-escapes and `[...]` brackets in place.
function splitFormatSections(fmt: string): string[] {
    const sections: string[] = [];
    let current = '';
    let i = 0;
    while (i < fmt.length) {
        const ch = fmt[i];
        if (ch === '"') {
            const end = fmt.indexOf('"', i + 1);
            const stop = end === -1 ? fmt.length : end + 1;
            current += fmt.slice(i, stop);
            i = stop;
        } else if (ch === '\\' && i + 1 < fmt.length) {
            current += fmt.slice(i, i + 2);
            i += 2;
        } else if (ch === '[') {
            const end = fmt.indexOf(']', i + 1);
            const stop = end === -1 ? fmt.length : end + 1;
            current += fmt.slice(i, stop);
            i = stop;
        } else if (ch === ';') {
            sections.push(current);
            current = '';
            i += 1;
        } else {
            current += ch;
            i += 1;
        }
    }
    sections.push(current);
    return sections;
}

function normalizeSectionMonthMinute(section: string): string {
    const out: string[] = [];
    const chunks: DateChunk[] = [];
    let i = 0;
    while (i < section.length) {
        const rest = section.slice(i);
        const ch = section[i];

        if (ch === '"') {
            const end = section.indexOf('"', i + 1);
            const stop = end === -1 ? section.length : end + 1;
            out.push(section.slice(i, stop));
            i = stop;
            continue;
        }
        // `\x` escape and `_x`/`*x` fill/skip all consume the next char as a literal —
        // its letter must never be read as a date token.
        if ((ch === '\\' || ch === '_' || ch === '*') && i + 1 < section.length) {
            out.push(section.slice(i, i + 2));
            i += 2;
            continue;
        }
        // AM/PM and A/P carry `m`/`p` letters but are not adjacency tokens — skip whole.
        const ampm = rest.match(/^(am\/pm|a\/p)/i);
        if (ampm) {
            out.push(ampm[0]);
            i += ampm[0].length;
            continue;
        }
        if (ch === '[') {
            const end = section.indexOf(']', i + 1);
            if (end !== -1) {
                const inner = section.slice(i + 1, end);
                if (/^m+$/i.test(inner)) {
                    // Elapsed minutes `[m]`/`[mm]` — always minute, always lowercase.
                    out.push(`[${'m'.repeat(inner.length)}]`);
                    chunks.push({ size: DATE_MIN });
                } else if (/^h+$/i.test(inner)) {
                    out.push(section.slice(i, end + 1));
                    chunks.push({ size: DATE_HOUR });
                } else if (/^s+$/i.test(inner)) {
                    out.push(section.slice(i, end + 1));
                    chunks.push({ size: DATE_SEC });
                } else {
                    // Color / condition / currency locale — not a date token.
                    out.push(section.slice(i, end + 1));
                }
                i = end + 1;
                continue;
            }
        }

        const hour = rest.match(/^[hH]+/);
        if (hour) {
            out.push(hour[0]);
            chunks.push({ size: DATE_HOUR });
            i += hour[0].length;
            continue;
        }
        const sec = rest.match(/^[sS]+/);
        if (sec) {
            out.push(sec[0]);
            const last = chunks[chunks.length - 1];
            let usedByMinute = false;
            if (last && last.size & DATE_MIN) {
                usedByMinute = true;
            } else if (last?.indeterminate && last.mRef != null) {
                // Seconds resolve a deferred month back to a minute.
                last.indeterminate = false;
                last.size = DATE_MIN;
                out[last.mRef] = out[last.mRef].toLowerCase();
                usedByMinute = true;
            }
            chunks.push({ size: DATE_SEC, used: usedByMinute });
            i += sec[0].length;
            continue;
        }
        const month = rest.match(/^[mM]+/);
        if (month) {
            const len = month[0].length;
            const idx = out.length;
            if (len >= 3) {
                // mmm/mmmm/mmmmm are always month names.
                out.push('M'.repeat(len));
                chunks.push({ size: 0 });
            } else {
                const last = chunks[chunks.length - 1];
                if (last && !last.used && last.size & (DATE_HOUR | DATE_SEC)) {
                    last.used = true;
                    out.push('m'.repeat(len));
                    chunks.push({ size: DATE_MIN });
                } else {
                    // Undecided → month for now; a later seconds token may flip it.
                    out.push('M'.repeat(len));
                    chunks.push({ size: 0, indeterminate: true, mRef: idx });
                }
            }
            i += len;
            continue;
        }
        // Other date tokens (year/day/b-year/era/weekday) only break hour/second adjacency.
        const other = rest.match(/^([yY]+|[dD]+|[bB]+|[gG]+|e+|[aA]{3,})/);
        if (other) {
            out.push(other[0]);
            chunks.push({ size: 0 });
            i += other[0].length;
            continue;
        }

        out.push(ch);
        i += 1;
    }
    return out.join('');
}

function normalizeMonthMinuteTokens(numFmt: string): string {
    if (!/[mM]/.test(numFmt)) return numFmt;
    return splitFormatSections(numFmt).map(normalizeSectionMonthMinute).join(';');
}
