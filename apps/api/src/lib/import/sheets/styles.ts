// The styles part read into one look per cell format (xf), resolved once: fonts, fills, alignment, borders, number
// formats, theme colours and tints. It also reads the conditional formats' looks (dxf). The xlsx reader calls it once
// per workbook, and the rich strings and rules readers reuse its font and colour readers.

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
import type { XmlElement } from '../../core/xml';
import { xmlAttr, xmlChild, xmlChildren } from '../../core/xml';
import { fromHsl, readColorScheme, SCHEME_SLOTS, toHsl } from '../../ooxml/drawingml';
import { isOn, SML_NS } from '../../ooxml/ooxml';
import {
    BUILTIN_NUMBER_FORMATS,
    MAX_NUMBER_FORMAT_LENGTH,
    maxDigitWidth,
    NUMBER_FORMAT_LITERAL,
} from '../../ooxml/spreadsheetml';
import { IMPORT_MESSAGES } from '../messages';

export type ThemePalette = string[];

export type Look = {
    // The keys every cell of the format carries.
    cell: FortuneCell;
    // Its font's, which a rich string's plain text takes.
    font: CellStyle;
    // What a value displays with, as written; undefined for General and for a format numfmt can't parse, which shows
    // General.
    numFmt?: string;
    // The cell's ct.fa: numFmt with month and minute in the Google convention.
    fa?: string;
    isDate: boolean;
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

// The ordinal of each xlsx border style name, the reverse of the shared ordinal table.
const BORDER_STYLE_MAP = new Map<string, number>(
    Object.entries(BORDER_STYLES).map(([ord, { name }]) => [name, Number(ord)]),
);

export const NO_LOOK: Look = { cell: {}, font: {}, isDate: false };

// Excel allows a workbook 250 formats of its own. A format's date test and canonical form cost per character, and so
// does every display through it: one past Excel's length reads as General, and cell formats that name more formats
// than four times Excel's allowance are refused. The corpus's longest is 76 characters, its most formats 126.
const MAX_NUMBER_FORMATS = 1000;

export function readLooks(styleSheet: XmlElement | undefined, palette: ThemePalette): Look[] {
    const list = (group: string, item: string) => {
        const parent = styleSheet && xmlChild(styleSheet, SML_NS, group);
        return parent ? xmlChildren(parent, SML_NS, item) : [];
    };
    const formats = new Map(BUILTIN_NUMBER_FORMATS);
    for (const numFmt of list('numFmts', 'numFmt')) {
        const code = xmlAttr(numFmt, '', 'formatCode');
        if (code) formats.set(Number(xmlAttr(numFmt, '', 'numFmtId')), code);
    }
    const fonts = list('fonts', 'font').map((font) => fontLook(font, palette));
    const fills = list('fills', 'fill').map((fill) => {
        // Any pattern but none paints its foreground; a gradient paints nothing.
        const pattern = xmlChild(fill, SML_NS, 'patternFill');
        if (!pattern || xmlAttr(pattern, '', 'patternType') === 'none') return null;
        return resolveColor(xmlChild(pattern, SML_NS, 'fgColor'), palette);
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
            fa: numFmt && googleMonthMinute(numFmt),
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
        const font = fonts[id('fontId')] ?? {};
        return {
            cell: { ...font, ...(bg && { bg }), ...(alignment && alignmentLook(alignment)) },
            font,
            ...(resolved.get(id('numFmtId')) ?? resolve(id('numFmtId'))),
            border: borders[id('borderId')],
        };
    });
}

// The workbook's default font, the first, whose digit a column width counts.
export function defaultFontDigitWidth(styleSheet: XmlElement | undefined): number {
    const fonts = styleSheet && xmlChild(styleSheet, SML_NS, 'fonts');
    const font = fonts && xmlChild(fonts, SML_NS, 'font');
    const value = (name: string) => {
        const child = font && xmlChild(font, SML_NS, name);
        return child && xmlAttr(child, '', 'val');
    };
    return maxDigitWidth(value('name'), Number.parseFloat(value('sz') ?? ''));
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
        resolveColor(element && xmlChild(element, SML_NS, name), palette);
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
    const color = resolveColor(child('color'), palette);
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
        return { style, color: resolveColor(xmlChild(edge, SML_NS, 'color'), palette) ?? '#000000' };
    };
    const l = side('left');
    const r = side('right');
    const t = side('top');
    const b = side('bottom');
    // Eigen's slash `s` runs from the top left to the bottom right, as xlsx's diagonalDown does. Eigen draws one
    // direction only, so a diagonalUp alone is dropped.
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

// An rgb colour, else a theme colour and its tint. An indexed colour is none.
export function resolveColor(element: XmlElement | undefined, palette: ThemePalette): string | null {
    const rgb = element && xmlAttr(element, '', 'rgb');
    if (rgb) return argbToHex(rgb);
    const theme = Number.parseInt((element && xmlAttr(element, '', 'theme')) ?? '', 10);
    if (!(theme >= 0 && theme < palette.length)) return null;
    const tint = Number.parseFloat((element && xmlAttr(element, '', 'tint')) ?? '');
    return Number.isFinite(tint) ? tinted(palette[theme], tint) : palette[theme];
}

function argbToHex(argb: string): string {
    const rgb = argb.length === 8 ? argb.slice(2) : argb;
    return `#${rgb.toUpperCase()}`;
}

// SpreadsheetML's tint shifts the colour's HLS luminance (ECMA-376 Part 1 § 18.3.1.15), as Excel draws it: toward black
// by the share a negative tint names, toward white by a positive one.
function tinted(hex: string, tint: number): string {
    const value = Number.parseInt(hex.slice(1, 7), 16);
    const [hue, sat, lum] = toHsl((value >> 16) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255);
    const shifted = tint < 0 ? lum * (1 + tint) : lum * (1 - tint) + tint;
    const channels = fromHsl(hue, sat, Math.min(1, Math.max(0, shifted)));
    return `#${channels
        .map((channel) =>
            Math.round(channel * 255)
                .toString(16)
                .padStart(2, '0'),
        )
        .join('')}`.toUpperCase();
}

// SpreadsheetML's theme indices swap each dark and light pair of a:clrScheme's order: 0=lt1, 1=dk1, 2=lt2, 3=dk2.
const THEME_INDEX_ORDER = [1, 0, 3, 2, 4, 5, 6, 7, 8, 9, 10, 11] as const;

export function themePalette(theme: XmlElement | undefined): ThemePalette {
    const scheme = readColorScheme(theme);
    if (scheme.size === 0) return [];
    return THEME_INDEX_ORDER.map((index) => scheme.get(SCHEME_SLOTS[index])?.toUpperCase() ?? '#000000');
}

// Excel writes month and minute both as `m`, told apart by what sits beside it, and numfmt reads it so. The format
// dialog follows Google, `M` for a month and `m` for a minute, so a stored month `mm` would edit as minutes. So each
// run is recased by numfmt's own rule (dateChunks): only the case changes, and the display never does. Only hours and
// seconds, which make a run a minute, and minutes, which a later seconds resolves, take part. Every other date token
// breaks the run.
const DATE_HOUR = 1;
const DATE_MIN = 2;
const DATE_SEC = 4;

type DateChunk = { size: number; used?: boolean; indeterminate?: boolean; mRef?: number };

// A literal, a section's end, a run of one date letter, or any other character.
const FORMAT_TOKEN = new RegExp(
    `${NUMBER_FORMAT_LITERAL.source}|;|[hH]+|[sS]+|[mM]+|[yY]+|[dD]+|[bB]+|[gG]+|e+|[aA]{3,}|[\\s\\S]`,
    'g',
);

function googleMonthMinute(numFmt: string): string {
    if (!/[mM]/.test(numFmt)) return numFmt;
    const out: string[] = [];
    let chunks: DateChunk[] = [];
    for (const [token] of numFmt.matchAll(FORMAT_TOKEN)) {
        const last = chunks.at(-1);
        if (token === ';') {
            // Each section has runs of its own.
            chunks = [];
            out.push(token);
        } else if (/^\[m+\]$/i.test(token)) {
            // Elapsed minutes are always minutes, written lowercase.
            out.push(token.toLowerCase());
            chunks.push({ size: DATE_MIN });
        } else if (/^\[h+\]$|^h+$/i.test(token)) {
            out.push(token);
            chunks.push({ size: DATE_HOUR });
        } else if (/^\[s+\]$/i.test(token)) {
            out.push(token);
            chunks.push({ size: DATE_SEC });
        } else if (/^s+$/i.test(token)) {
            out.push(token);
            let used = false;
            if (last && last.size & DATE_MIN) {
                used = true;
            } else if (last?.indeterminate && last.mRef !== undefined) {
                // Seconds turn a month that waited for them back into a minute.
                last.indeterminate = false;
                last.size = DATE_MIN;
                out[last.mRef] = out[last.mRef].toLowerCase();
                used = true;
            }
            chunks.push({ size: DATE_SEC, used });
        } else if (/^m+$/i.test(token)) {
            const length = token.length;
            if (length >= 3) {
                // mmm, mmmm and mmmmm are always month names.
                out.push('M'.repeat(length));
                chunks.push({ size: 0 });
            } else if (last && !last.used && last.size & (DATE_HOUR | DATE_SEC)) {
                last.used = true;
                out.push('m'.repeat(length));
                chunks.push({ size: DATE_MIN });
            } else {
                // A month, until a later seconds makes it a minute.
                chunks.push({ size: 0, indeterminate: true, mRef: out.length });
                out.push('M'.repeat(length));
            }
        } else if (/^([yYdDbBgGe]+|[aA]{3,})$/.test(token)) {
            // The year, day, Buddhist year, era and weekday only break the run.
            out.push(token);
            chunks.push({ size: 0 });
        } else {
            out.push(token);
        }
    }
    return out.join('');
}
