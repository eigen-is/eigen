import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EIGEN_FONT_NAMES, EIGEN_FONTS, FONT_FACES } from '@workspace/lib/constants/fonts';
import { DOCX_FONT_FILES, sfntTables } from '../../lib/export/doc/docx/fonts';
import { allFontFaceCss, fontFaceCssOf } from '../../lib/export/fonts';

const UI_STYLES_DIR = path.join(import.meta.dir, '../../../../../packages/ui/src/styles');

function faces(css: string, bytesOf: (src: string) => Buffer): string[] {
    return css
        .split('@font-face')
        .slice(1)
        .map((block) => {
            const field = (name: string) => block.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();
            const src = block.match(/url\("([^"]+)"\)/)?.[1] ?? '';
            const hash = new Bun.CryptoHasher('sha256').update(bytesOf(src)).digest('hex');
            return `${field('font-family')} | ${field('font-weight')} | ${field('font-style')} | ${hash}`;
        })
        .sort();
}

// An export inlines the faces the apps load from fonts.css; a face added or changed on one side only
// renders an export in a fallback font. The math face is no font a user picks, so no export embeds it with the rest.
test('the export fonts are the faces the apps load', () => {
    const appCSS = fs.readFileSync(path.join(UI_STYLES_DIR, 'fonts.css'), 'utf8');
    const appFaces = faces(appCSS, (src) => fs.readFileSync(path.join(UI_STYLES_DIR, src))).filter(
        (face) => !face.startsWith('"STIX Two Math"'),
    );
    const exportFaces = faces(allFontFaceCss(), (src) => Buffer.from(src.slice(src.indexOf(',') + 1), 'base64'));
    expect(appFaces).toHaveLength(6);
    expect(exportFaces).toEqual(appFaces);
});

// The faces are the registry's, which the browser's image writer embeds too, in its order.
test('the export embeds the registry faces, and only those of the families asked for', () => {
    const families = (css: string) => [...css.matchAll(/font-family: "([^"]+)"/g)].map((m) => m[1]);
    expect(families(allFontFaceCss())).toEqual(FONT_FACES.map((face) => face.family));
    expect(families(fontFaceCssOf(['Inter', 'Unknown']))).toEqual(['Inter', 'Inter']);
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
