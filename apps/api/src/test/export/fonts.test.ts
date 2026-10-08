import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EIGEN_FONT_NAMES } from '@workspace/lib/constants/fonts';
import { DOCX_FONT_FILES, getFontCSS } from '../../lib/export/fonts';

const UI_STYLES_DIR = path.join(import.meta.dir, '../../../../../packages/ui/src/styles');

function faces(css: string, bytesOf: (src: string) => Buffer): string[] {
    return css
        .split('@font-face')
        .slice(1)
        .map((block) => {
            const field = (name: string) => block.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();
            const src = block.match(/url\("([^"]+)"\)/)?.[1] ?? '';
            const hash = createHash('sha256').update(bytesOf(src)).digest('hex');
            return `${field('font-family')} | ${field('font-weight')} | ${field('font-style')} | ${hash}`;
        })
        .sort();
}

// An export inlines the faces the apps load from fonts.css; a face added or changed on one side only
// renders an export in a fallback font.
test('the export fonts are the faces the apps load', () => {
    const appCSS = fs.readFileSync(path.join(UI_STYLES_DIR, 'fonts.css'), 'utf8');
    const appFaces = faces(appCSS, (src) => fs.readFileSync(path.join(UI_STYLES_DIR, src)));
    const exportFaces = faces(getFontCSS(), (src) => Buffer.from(src.slice(src.indexOf(',') + 1), 'base64'));
    expect(appFaces).toHaveLength(6);
    expect(exportFaces).toEqual(appFaces);
});

// A bounded read of the sfnt table directory: a table past the end of the file throws instead of reading short.
function sfntTables(bytes: Buffer): Map<string, Buffer> {
    const tables = new Map<string, Buffer>();
    for (let i = 0; i < bytes.readUInt16BE(4); i++) {
        const record = 12 + i * 16;
        const offset = bytes.readUInt32BE(record + 8);
        const end = offset + bytes.readUInt32BE(record + 12);
        if (end > bytes.length) throw new Error(`table ${i} ends past the file`);
        tables.set(bytes.toString('latin1', record, record + 4), bytes.subarray(offset, end));
    }
    return tables;
}

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

// Installable or editable: a docx embedding a print-and-preview face opens read-only in Word.
test('every docx font file may be embedded for editing', () => {
    const usage = (face: (typeof docxFaces)[number]) => (face.tables.get('OS/2')?.readUInt16BE(8) ?? 0x0002) & 0x000f;
    expect(docxFaces.filter((face) => ![0, 8].includes(usage(face))).map((face) => face.file)).toEqual([]);
});
