// The docx writer's fonts. The font table lists each family the doc draws in, and each face it uses is embedded whole,
// so Word draws the doc in Eigen's fonts. useFace records the face a run draws in, which its line's height follows.

import * as fs from 'node:fs';
import { EIGEN_FONTS } from '@workspace/lib/constants/fonts';
import { escapeXml } from '@workspace/lib/xml';
import docxExcalifontRegular from '@workspace/ui/assets/fonts/excalifont/Excalifont-Regular.ttf' with { type: 'file' };
import docxInterBold from '@workspace/ui/assets/fonts/inter/Inter-Bold-renamed.ttf' with { type: 'file' };
import docxInterBoldItalic from '@workspace/ui/assets/fonts/inter/Inter-BoldItalic-renamed.ttf' with { type: 'file' };
import docxInterItalic from '@workspace/ui/assets/fonts/inter/Inter-Italic.ttf' with { type: 'file' };
import docxInterRegular from '@workspace/ui/assets/fonts/inter/Inter-Regular.ttf' with { type: 'file' };
import docxMonoBold from '@workspace/ui/assets/fonts/jetbrains-mono/JetBrainsMono-Bold-renamed.ttf' with {
    type: 'file',
};
import docxMonoBoldItalic from '@workspace/ui/assets/fonts/jetbrains-mono/JetBrainsMono-BoldItalic-renamed.ttf' with {
    type: 'file',
};
import docxMonoItalic from '@workspace/ui/assets/fonts/jetbrains-mono/JetBrainsMono-Italic.ttf' with { type: 'file' };
import docxMonoRegular from '@workspace/ui/assets/fonts/jetbrains-mono/JetBrainsMono-Regular.ttf' with { type: 'file' };
import docxSerifBold from '@workspace/ui/assets/fonts/source-serif/SourceSerif4-Bold.ttf' with { type: 'file' };
import docxSerifBoldItalic from '@workspace/ui/assets/fonts/source-serif/SourceSerif4-BoldIt.ttf' with { type: 'file' };
import docxSerifItalic from '@workspace/ui/assets/fonts/source-serif/SourceSerif4-It.ttf' with { type: 'file' };
import docxSerifRegular from '@workspace/ui/assets/fonts/source-serif/SourceSerif4-Regular.ttf' with { type: 'file' };
import type { RunFace } from '../../../document/looks';
import { halfPoints } from '../../../document/looks';
import { R_NS, W_NS } from '../../../ooxml/ooxml';
import type { Relationship } from '../../../ooxml/opc';
import { partRelationships } from '../../../ooxml/opc';
import type { StyleId } from '../../../ooxml/wordml';
import { FONT_FAMILY } from '../../../ooxml/wordml';
import { CHECKBOX_FONT } from './numbering';
import type { Package } from './package';
import type { RunProps } from './runs';
import type { Styles } from './styles';

export type DocxFontFiles = { Regular: string; Italic?: string; Bold?: string; BoldItalic?: string };

// The static faces a docx embeds per EIGEN_FONTS name, in its order; Word synthesizes a slot a family has no file for.
// Inter's and JetBrains Mono's Bold slots hold their 600s renamed Bold, the weight the editor draws bold in.
export const DOCX_FONT_FILES: ReadonlyMap<string, DocxFontFiles> = new Map([
    [
        'Inter',
        { Regular: docxInterRegular, Italic: docxInterItalic, Bold: docxInterBold, BoldItalic: docxInterBoldItalic },
    ],
    [
        'Source Serif 4',
        { Regular: docxSerifRegular, Italic: docxSerifItalic, Bold: docxSerifBold, BoldItalic: docxSerifBoldItalic },
    ],
    [
        'JetBrains Mono',
        { Regular: docxMonoRegular, Italic: docxMonoItalic, Bold: docxMonoBold, BoldItalic: docxMonoBoldItalic },
    ],
    ['Excalifont', { Regular: docxExcalifontRegular }],
]);

// A bounded read of the sfnt table directory: a table past the end of the file throws instead of reading short.
export function sfntTables(bytes: Buffer): Map<string, Buffer> {
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

// The ECMA-376 order of a font's embed elements.
const FONT_SLOTS = ['Regular', 'Bold', 'Italic', 'BoldItalic'] as const satisfies readonly (keyof DocxFontFiles)[];

export type FontSlot = (typeof FONT_SLOTS)[number];

// Each family's font table entry, from its Regular.
const FONT_ENTRIES = EIGEN_FONTS.map(({ name, category }) => {
    const files = DOCX_FONT_FILES.get(name);
    const os2 = files && sfntTables(fs.readFileSync(files.Regular)).get('OS/2');
    if (!os2) throw new Error(`no OS/2 table for ${name}`);
    const hex32 = (offset: number) => os2.readUInt32BE(offset).toString(16).toUpperCase().padStart(8, '0');
    const sig = Object.entries({ usb0: 42, usb1: 46, usb2: 50, usb3: 54, csb0: 78, csb1: 82 }).map(
        ([field, offset]) => `w:${field}="${hex32(offset)}"`,
    );
    return {
        name,
        properties: `<w:panose1 w:val="${os2.subarray(32, 42).toString('hex').toUpperCase()}"/><w:charset w:val="00"/><w:family w:val="${FONT_FAMILY[category]}"/><w:pitch w:val="${category === 'monospace' ? 'fixed' : 'variable'}"/><w:sig ${sig.join(' ')}/>`,
    };
});

// MS Gothic draws the checkbox glyphs.
export function fontTableXml(checkboxes: boolean, embeds: Map<string, string>): string {
    const fonts = FONT_ENTRIES.map(
        ({ name, properties }) => `<w:font w:name="${escapeXml(name)}">${properties}${embeds.get(name) ?? ''}</w:font>`,
    );
    if (checkboxes)
        fonts.push(
            `<w:font w:name="${CHECKBOX_FONT}"><w:charset w:val="80"/><w:family w:val="modern"/><w:pitch w:val="fixed"/></w:font>`,
        );
    return `<w:fonts xmlns:w="${W_NS}" xmlns:r="${R_NS}">${fonts.join('')}</w:fonts>`;
}

// Each face whole, obfuscated per ECMA-376 Part 1 § 17.8.1 by a GUID hashed from the face, so the bytes are stable.
export function embeddedFonts(faces: Map<string, Set<FontSlot>>): {
    embeds: Map<string, string>;
    relationships: Relationship[];
    files: [path: string, data: Uint8Array][];
} {
    const embeds = new Map<string, string>();
    const { relationships, relate } = partRelationships();
    const files: [path: string, data: Uint8Array][] = [];
    for (const [family, slots] of DOCX_FONT_FILES) {
        let xml = '';
        for (const slot of FONT_SLOTS) {
            const file = slots[slot];
            if (!file || !faces.get(family)?.has(slot)) continue;
            const hash = Bun.CryptoHasher.hash('sha256', `${family}/${slot}`, 'hex').toUpperCase();
            const key = `{${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}}`;
            const digits = key.replace(/[{}-]/g, '');
            const data = new Uint8Array(fs.readFileSync(file));
            for (let i = 0; i < 32; i++)
                data[i] ^= Number.parseInt(digits.slice(30 - 2 * (i % 16), 32 - 2 * (i % 16)), 16);
            const part = `fonts/font${files.length + 1}.odttf`;
            files.push([`word/${part}`, data]);
            xml += `<w:embed${slot} r:id="${relate('font', part)}" w:fontKey="${key}"/>`;
        }
        if (xml) embeds.set(family, xml);
    }
    return { embeds, relationships, files };
}

// As Word resolves a face: the run over its character style over its paragraph style, whose toggles flip each other.
export function useFace(pkg: Package, run: RunProps, paragraphStyle: StyleId | undefined): RunFace {
    const character = styleFace(pkg.styles, run.style);
    const paragraph = styleFace(pkg.styles, paragraphStyle ?? 'Normal');
    const family = run.font ?? character.font ?? paragraph.font ?? pkg.normal.font;
    const size = run.size ?? character.size ?? paragraph.size ?? halfPoints(pkg.normal.size);
    const files = DOCX_FONT_FILES.get(family);
    if (files) {
        const bold = run.bold ?? character.bold !== paragraph.bold;
        const italic = run.italic ?? character.italic !== paragraph.italic;
        const slot = bold ? (italic ? 'BoldItalic' : 'Bold') : italic ? 'Italic' : 'Regular';
        // Word synthesizes a slot without a file from the Regular.
        pkg.faces.set(family, (pkg.faces.get(family) ?? new Set()).add(files[slot] ? slot : 'Regular'));
    }
    return { family, size };
}

// The nearest definition of each face property along a style's chain.
function styleFace(styles: Styles, style: StyleId | undefined): Pick<RunProps, 'font' | 'bold' | 'italic' | 'size'> {
    const face: Pick<RunProps, 'font' | 'bold' | 'italic' | 'size'> = {};
    for (let id = style; id !== undefined; ) {
        const definition = styles.get(id);
        face.font ??= definition?.rPr?.font;
        face.bold ??= definition?.rPr?.bold;
        face.italic ??= definition?.rPr?.italic;
        face.size ??= definition?.rPr?.size;
        id = definition?.basedOn;
    }
    return face;
}
