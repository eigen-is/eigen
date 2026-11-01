import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FONT_SLICES } from '@workspace/lib/constants/font-slices';
import { EIGEN_FONT_NAMES, EIGEN_FONTS } from '@workspace/lib/constants/fonts';
import { DOCX_FONT_FILES, sfntTables } from '../../lib/export/doc/docx/fonts';
import { drawnCodePoints, slicesFaceCss } from '../../lib/export/fonts';

const FONTS_DIR = path.join(import.meta.dir, '../../../../../packages/ui/src/assets/fonts');

function rules(css: string) {
    return css
        .split('@font-face')
        .slice(1)
        .map((rule) => {
            const field = (name: string) => rule.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();
            const src = rule.match(/url\("data:font\/woff2;base64,([^"]+)"\)/)?.[1] ?? '';
            return {
                family: field('font-family')?.replace(/"/g, ''),
                style: field('font-style'),
                weight: field('font-weight'),
                unicodeRange: field('unicode-range'),
                bytes: Buffer.from(src, 'base64'),
            };
        });
}

// Every character of every range, the keycap mark too, touches every slice once.
const EVERY_CODE_POINT = new Set(
    FONT_SLICES.flatMap((slice) =>
        slice.unicodeRange.split(', ').flatMap((range) => {
            const [start, end = start] = range.slice(2).split('-');
            const from = Number.parseInt(start, 16);
            return Array.from({ length: Number.parseInt(end, 16) - from + 1 }, (_, i) => from + i);
        }),
    ),
);

// A slice an export embeds is the file fonts.css loads, read through the server's own path to it, under the rule the
// browser has for it.
test('the export embeds each slice as the file the apps load, with its family, style, weight and range', () => {
    const families = new Set(FONT_SLICES.map((slice) => slice.family));
    expect(rules(slicesFaceCss(EVERY_CODE_POINT, families))).toEqual(
        FONT_SLICES.map((slice) => ({
            family: slice.family,
            style: slice.style,
            weight: slice.weight,
            unicodeRange: slice.unicodeRange,
            bytes: fs.readFileSync(path.join(FONTS_DIR, slice.file)),
        })),
    );
});

test('the export embeds only the slices of the families asked for that its characters touch', () => {
    const families = (css: string) => rules(css).map((rule) => `${rule.family} ${rule.style}`);
    expect(families(slicesFaceCss(drawnCodePoints('A'), ['Inter', 'Unknown']))).toEqual([
        'Inter normal',
        'Inter italic',
    ]);
    expect(slicesFaceCss(drawnCodePoints('中'), ['Inter'])).not.toContain('Noto Sans SC');
});

describe('drawnCodePoints', () => {
    const chars = (markup: string) => new Set(Array.from(drawnCodePoints(markup), (cp) => String.fromCodePoint(cp)));

    test('printable ASCII and the list disc are always drawn', () => {
        expect(chars('')).toEqual(
            new Set(['\u2022', ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(0x20 + i))]),
        );
    });

    test("a character, its other case for CSS caps, and a numeric reference's character", () => {
        expect(chars('é中')).toEqual(new Set([...chars(''), 'é', 'É', '中']));
        expect(chars('&#x4E2D;&#54620;')).toEqual(new Set([...chars(''), '中', '한']));
    });
});

function nameRecords(name: Buffer): string[] {
    const strings = name.readUInt16BE(4);
    return Array.from({ length: name.readUInt16BE(2) }, (_, i) => {
        const record = 6 + i * 12;
        const platform = name.readUInt16BE(record);
        const start = strings + name.readUInt16BE(record + 10);
        const bytes = name.subarray(start, start + name.readUInt16BE(record + 8));
        const value = platform === 3 ? Buffer.from(bytes).swap16().toString('utf16le') : bytes.toString('latin1');
        return `${name.readUInt16BE(record + 6)} ${platform}/${name.readUInt16BE(record + 2)}/${name.readUInt16BE(record + 4)} ${value}`;
    });
}

const docxFaces = [...DOCX_FONT_FILES].flatMap(([family, files]) =>
    Object.entries(files).map(([slot, file]) => ({ family, slot, file, tables: sfntTables(fs.readFileSync(file)) })),
);

// The renamed faces are upstream 600s moved into the family's Bold slots; the others keep their upstream names.
const renamedFaces = docxFaces.filter((face) => path.basename(face.file).endsWith('-renamed.ttf'));

test('every font has a docx Regular file', () => {
    expect([...DOCX_FONT_FILES.keys()]).toEqual([...EIGEN_FONT_NAMES]);
    for (const files of DOCX_FONT_FILES.values()) expect(fs.existsSync(files.Regular)).toBe(true);
    expect(docxFaces).toHaveLength(13);
    expect(renamedFaces).toHaveLength(4);
});

test('each docx font file has the weight and style bits of its slot', () => {
    for (const face of docxFaces) {
        const os2 = face.tables.get('OS/2');
        const head = face.tables.get('head');
        if (!os2 || !head) throw new Error(`${face.file} has no OS/2 or head table`);
        const fsSelection = os2.readUInt16BE(62);
        const macStyle = head.readUInt16BE(44);
        const bold = face.slot.startsWith('Bold');
        const italic = face.slot.endsWith('Italic');
        expect({
            file: face.file,
            weight: os2.readUInt16BE(4),
            fsSelectionItalic: (fsSelection & 0x01) !== 0,
            fsSelectionBold: (fsSelection & 0x20) !== 0,
            fsSelectionRegular: (fsSelection & 0x40) !== 0,
            macStyleBold: (macStyle & 0x01) !== 0,
            macStyleItalic: (macStyle & 0x02) !== 0,
        }).toEqual({
            file: face.file,
            weight: bold ? (renamedFaces.includes(face) ? 600 : 700) : 400,
            fsSelectionItalic: italic,
            fsSelectionBold: bold,
            fsSelectionRegular: face.slot === 'Regular',
            macStyleBold: bold,
            macStyleItalic: italic,
        });
    }
});

test('the renamed docx faces carry the family and slot names, with no typographic names', () => {
    for (const face of renamedFaces) {
        const name = face.tables.get('name');
        if (!name) throw new Error(`${face.file} has no name table`);
        const subfamily = face.slot === 'BoldItalic' ? 'Bold Italic' : 'Bold';
        const names = {
            1: face.family,
            2: subfamily,
            4: `${face.family} ${subfamily}`,
            6: `${face.family.replaceAll(' ', '')}-${subfamily.replaceAll(' ', '')}`,
        };
        const expected = Object.entries(names).flatMap(([id, value]) => [
            `${id} 1/0/0 ${value}`,
            `${id} 3/1/1033 ${value}`,
        ]);
        const records = nameRecords(name).filter((record) => /^(1|2|4|6|16|17|21|22) /.test(record));
        expect(records.sort()).toEqual(expected.sort());
    }
});

// A face filed under another font would embed that font's glyphs under this one's name.
test('every docx face names the font it is filed under', () => {
    for (const face of docxFaces) {
        const name = face.tables.get('name');
        if (!name) throw new Error(`${face.file} has no name table`);
        const families = nameRecords(name).filter((record) => record.startsWith('1 3/1/1033 '));
        expect({ file: face.file, families }).toEqual({ file: face.file, families: [`1 3/1/1033 ${face.family}`] });
    }
});

// Installable or editable: a docx embedding a print-and-preview face opens read-only in Word.
test('every docx font file may be embedded for editing', () => {
    const usage = (face: (typeof docxFaces)[number]) => (face.tables.get('OS/2')?.readUInt16BE(8) ?? 0x0002) & 0x000f;
    expect(docxFaces.filter((face) => ![0, 8].includes(usage(face))).map((face) => face.file)).toEqual([]);
});

// Each family's single line is a number of lib's, as the editor, the canvas and the docx all read it; it is Word's,
// (usWinAscent + usWinDescent) / unitsPerEm of the Regular the docx embeds.
test.each(EIGEN_FONTS.map((font) => [font.name, font.lineHeight] as const))(
    "%s's single line is its TTF's",
    (name, lineHeight) => {
        const regular = DOCX_FONT_FILES.get(name)?.Regular;
        if (!regular) throw new Error(`no TTF for ${name}`);
        const tables = sfntTables(fs.readFileSync(regular));
        const os2 = tables.get('OS/2');
        const head = tables.get('head');
        if (!os2 || !head) throw new Error(`no OS/2 or head table for ${name}`);
        expect((os2.readUInt16BE(74) + os2.readUInt16BE(76)) / head.readUInt16BE(18)).toBeCloseTo(lineHeight, 3);
    },
);
