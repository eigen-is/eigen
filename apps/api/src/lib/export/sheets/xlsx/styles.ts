// The xlsx writer's styles: the workbook's looks, each interned once by its canonical key as the sheets are written,
// then written as styles.xml after them.

import { EIGEN_FONTS } from '@workspace/lib/constants/fonts';
import type { BorderSide, Cell, CellBorderSides, CellStyle, DefaultConditionalFormatRule } from '@workspace/lib/sheets';
import { BORDER_STYLES, cellFontName, SHEET_DEFAULT_FONT, SHEET_DEFAULT_FONT_SIZE } from '@workspace/lib/sheets';
import { escapeXml } from '@workspace/lib/xml';
import { is_date, isValidNumberFormat } from '@workspace/sheet/engine';
import { cssColorToHex } from '../../../document/colors';
import type { Lost } from '../../../document/transform/protocol';
import { SML_NS } from '../../../ooxml/ooxml';
import {
    BUILTIN_NUMBER_FORMATS,
    cellFontSize,
    DATE_FORMAT,
    FONT_FAMILY_NUMBER,
    MAX_CELL_FORMATS,
    MAX_NUMBER_FORMAT_LENGTH,
} from '../../../ooxml/spreadsheetml';
import { HORIZONTAL_ALIGN, isNumericRotation, VERTICAL_ALIGN } from '../cell-style';

// The rules of a sheet take their dxfs through it.
export type StyleRegistry = {
    // The cellXfs index of a cell's look with its own borders: 0, the workbook's default, for none.
    xf(cell: Cell | undefined, border: CellBorderSides | undefined): number;
    dxf(format: DefaultConditionalFormatRule['format']): number;
    xml(): string;
};

// The cell's hex colors and the rgb(…) strings of the editor's CSS pipeline alike; undefined for one Office can't
// hold, which the caller leaves out. No reader checks a stored color, so a peer's can be anything, not only a string.
export function argbOf(color: unknown): string | undefined {
    const hex = typeof color === 'string' ? cssColorToHex(color) : undefined;
    return hex && `FF${hex}`;
}

// A run's font, whole, so no reader fills a gap from its own default.
export function runPropertiesXml(style: CellStyle): string {
    return `<rPr>${fontXml(style, 'rFont')}</rPr>`;
}

// The family lets a reader without the face substitute one of its category.
function fontXml(style: CellStyle, face: 'name' | 'rFont'): string {
    const name = cellFontName(style.ff) ?? SHEET_DEFAULT_FONT.name;
    const category = EIGEN_FONTS.find((font) => font.name === name)?.category;
    const argb = argbOf(style.fc);
    return [
        style.bl === 1 ? '<b/>' : '',
        style.it === 1 ? '<i/>' : '',
        style.cl === 1 ? '<strike/>' : '',
        style.un === 1 ? '<u/>' : '',
        `<sz val="${cellFontSize(style.fs)}"/>`,
        argb ? `<color rgb="${argb}"/>` : '',
        `<${face} val="${escapeXml(name)}"/>`,
        category ? `<family val="${FONT_FAMILY_NUMBER[category]}"/>` : '',
    ].join('');
}

// The workbook's default font, the one a column width counts the digit of. No color, so automatic: the import gives a
// cell of any other format its font whole, and a color would read as one the cell picked.
const DEFAULT_FONT = `<font><sz val="${SHEET_DEFAULT_FONT_SIZE}"/><name val="${escapeXml(SHEET_DEFAULT_FONT.name)}"/><family val="${FONT_FAMILY_NUMBER[SHEET_DEFAULT_FONT.category]}"/></font>`;
const DEFAULT_FILLS = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
];
const NO_BORDER = '<border><left/><right/><top/><bottom/><diagonal/></border>';

// Ids 14 to 22 show dates and times in the reader's locale, so only the others are written by id.
const BUILTIN_FORMAT_IDS = new Map(
    [...BUILTIN_NUMBER_FORMATS].filter(([id]) => id > 0 && (id < 14 || id > 22)).map(([id, code]) => [code, id]),
);
const FIRST_CUSTOM_FORMAT = 164;

// Google's `M` for month is Excel's `m`, which Excel tells from a minute by what sits beside it. Quoted text, an
// escaped, skipped or repeated character, a bracket and AM/PM keep their case.
const FORMAT_TOKENS = /"[^"]*"?|\\.|[_*].|\[[^\]]*\]?|am\/pm|a\/p|M/gi;

type Look = { numFmt: number; font: number; fill: number; alignment: string };

// The keys a cell's look is made of, beside its number format.
const LOOK_KEYS = ['bl', 'it', 'un', 'cl', 'fs', 'ff', 'fc', 'bg', 'ht', 'vt', 'tb', 'rt'] as const;

// Most cells have none: they cost no key.
function hasLook(cell: Cell): boolean {
    if (cell.ct?.t === 'd' || (cell.ct?.fa !== undefined && cell.ct.fa !== 'General')) return true;
    for (const name of LOOK_KEYS) if (cell[name] !== undefined) return true;
    return false;
}

export function styleRegistry(lost: Lost): StyleRegistry {
    const intern = (map: Map<string, number>, xml: string) => {
        let id = map.get(xml);
        if (id === undefined) {
            id = map.size;
            map.set(xml, id);
        }
        return id;
    };
    const fonts = new Map([[DEFAULT_FONT, 0]]);
    const fills = new Map(DEFAULT_FILLS.map((fill, id) => [fill, id]));
    const borders = new Map([[NO_BORDER, 0]]);
    const formats = new Map<string, number>();
    const xfs = new Map([['0,0,0,0,', 0]]);
    const cellXfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
    const dxfs = new Map<string, number>();
    const looks = new Map<string, Look>();

    const numFmtOf = (cell: Cell): number => {
        const stored = cell.ct?.fa === 'General' ? undefined : cell.ct?.fa;
        const canonical = stored?.replace(FORMAT_TOKENS, (token) => (token === 'M' ? 'm' : token));
        const drawsDate = canonical !== undefined && isValidNumberFormat(canonical) && is_date(canonical);
        const code = cell.ct?.t === 'd' && !drawsDate ? DATE_FORMAT : canonical;
        if (code === undefined) return 0;
        if (code.length > MAX_NUMBER_FORMAT_LENGTH) {
            lost('number-formats-dropped');
            return 0;
        }
        return BUILTIN_FORMAT_IDS.get(code) ?? FIRST_CUSTOM_FORMAT + intern(formats, code);
    };
    const lookOf = (cell: Cell): Look => {
        const fc = argbOf(cell.fc);
        const hasFont =
            cell.bl === 1 ||
            cell.it === 1 ||
            cell.un === 1 ||
            cell.cl === 1 ||
            typeof cell.fs === 'number' ||
            fc !== undefined ||
            cellFontName(cell.ff) !== undefined;
        const bg = argbOf(cell.bg);
        const horizontal = cell.ht === undefined ? undefined : HORIZONTAL_ALIGN[cell.ht];
        const vertical = cell.vt === undefined ? undefined : VERTICAL_ALIGN[cell.vt];
        // 255 stacks the characters; 91 to 180 turn down by the excess over 90.
        const rotation =
            cell.rt === 'vertical' ? 255 : isNumericRotation(cell) ? (cell.rt > 0 ? cell.rt : 90 - cell.rt) : 0;
        const alignment = [
            horizontal ? ` horizontal="${horizontal}"` : '',
            vertical ? ` vertical="${vertical === 'middle' ? 'center' : vertical}"` : '',
            rotation ? ` textRotation="${rotation}"` : '',
            cell.tb === '2' ? ' wrapText="1"' : '',
        ].join('');
        return {
            numFmt: numFmtOf(cell),
            font: hasFont ? intern(fonts, `<font>${fontXml(cell, 'name')}</font>`) : 0,
            fill: bg
                ? intern(
                      fills,
                      `<fill><patternFill patternType="solid"><fgColor rgb="${bg}"/><bgColor indexed="64"/></patternFill></fill>`,
                  )
                : 0,
            alignment: alignment && `<alignment${alignment}/>`,
        };
    };

    return {
        xf(cell, border) {
            let look: Look | undefined;
            if (cell && hasLook(cell)) {
                // Resolved once a look, as a workbook repeats a few hundred across all its cells.
                const key = `${LOOK_KEYS.map((name) => cell[name]).join('|')}|${cell.ct?.fa}|${cell.ct?.t === 'd'}`;
                look = looks.get(key);
                if (!look) {
                    look = lookOf(cell);
                    looks.set(key, look);
                }
            }
            const { numFmt = 0, font = 0, fill = 0, alignment = '' } = look ?? {};
            const borderId = border ? intern(borders, borderXml(border)) : 0;
            const key = `${numFmt},${font},${fill},${borderId},${alignment}`;
            const id = xfs.get(key);
            if (id !== undefined) return id;
            if (xfs.size >= MAX_CELL_FORMATS) {
                lost('cell-formats-dropped');
                return 0;
            }
            const applied = [
                numFmt ? ' applyNumberFormat="1"' : '',
                font ? ' applyFont="1"' : '',
                fill ? ' applyFill="1"' : '',
                borderId ? ' applyBorder="1"' : '',
                alignment ? ' applyAlignment="1"' : '',
            ].join('');
            const attributes = `numFmtId="${numFmt}" fontId="${font}" fillId="${fill}" borderId="${borderId}" xfId="0"${applied}`;
            cellXfs.push(alignment ? `<xf ${attributes}>${alignment}</xf>` : `<xf ${attributes}/>`);
            xfs.set(key, xfs.size);
            return xfs.size - 1;
        },
        dxf({ textColor, cellColor }) {
            const text = argbOf(textColor);
            const cell = argbOf(cellColor);
            // Excel reads a dxf's solid fill from bgColor, the import from fgColor: both hold it.
            return intern(
                dxfs,
                [
                    text ? `<font><color rgb="${text}"/></font>` : '',
                    cell
                        ? `<fill><patternFill patternType="solid"><fgColor rgb="${cell}"/><bgColor rgb="${cell}"/></patternFill></fill>`
                        : '',
                ].join(''),
            );
        },
        xml() {
            const list = (name: string, items: Iterable<string>, size: number) =>
                `<${name} count="${size}">${[...items].join('')}</${name}>`;
            const numFmts = [...formats.keys()].map(
                (code, index) => `<numFmt numFmtId="${FIRST_CUSTOM_FORMAT + index}" formatCode="${escapeXml(code)}"/>`,
            );
            return [
                `<styleSheet xmlns="${SML_NS}">`,
                numFmts.length > 0 ? list('numFmts', numFmts, numFmts.length) : '',
                list('fonts', fonts.keys(), fonts.size),
                list('fills', fills.keys(), fills.size),
                list('borders', borders.keys(), borders.size),
                '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>',
                list('cellXfs', cellXfs, cellXfs.length),
                '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>',
                list(
                    'dxfs',
                    [...dxfs.keys()].map((dxf) => `<dxf>${dxf}</dxf>`),
                    dxfs.size,
                ),
                '</styleSheet>',
            ].join('');
        },
    };
}

// Each side as stored. The slash `s` is painted top-left to bottom-right, xlsx's diagonalDown.
function borderXml(sides: CellBorderSides): string {
    const side = (name: string, stored: BorderSide | undefined) => {
        if (!stored) return `<${name}/>`;
        const argb = argbOf(stored.color);
        const style = BORDER_STYLES[stored.style]?.name ?? 'thin';
        return argb ? `<${name} style="${style}"><color rgb="${argb}"/></${name}>` : `<${name} style="${style}"/>`;
    };
    const xml = [
        side('left', sides.l),
        side('right', sides.r),
        side('top', sides.t),
        side('bottom', sides.b),
        side('diagonal', sides.s),
    ].join('');
    return `<border${sides.s ? ' diagonalDown="1"' : ''}>${xml}</border>`;
}
