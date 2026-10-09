import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { importDocxBody, marksOfType, nodesOfType } from '../../fixtures/golden-docx';

// The body font, OWNER ruling: a foreign body font of Eigen's body category (sans) is no mark; serif and mono are a
// mark on every run; an unknown category is none. A monospace body is a font, never code.

const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const paragraph = (inner: string) => `<w:p>${inner}</w:p>`;
const BODY = `${paragraph(`${run('First line ')}${run('of the body.')}`)}${paragraph(run('Second line.'))}`;
const bodyFont = (fonts: string) =>
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts ${fonts}/></w:rPr></w:rPrDefault></w:docDefaults>`;

const fontsOf = (json: JSONContent) =>
    nodesOfType(json, 'text').map(
        (node) => node.marks?.find((mark) => mark.type === 'textStyle')?.attrs?.['fontFamily'] ?? null,
    );

describe('body font', () => {
    test('a Times New Roman body is Source Serif 4 on every run', async () => {
        const { json } = await importDocxBody(BODY, {
            styles: bodyFont('w:ascii="Times New Roman" w:hAnsi="Times New Roman"'),
        });
        expect(fontsOf(json)).toEqual(['Source Serif 4', 'Source Serif 4']);
    });

    test('a Calibri body is no mark', async () => {
        const { json } = await importDocxBody(BODY, { styles: bodyFont('w:ascii="Calibri" w:hAnsi="Calibri"') });
        expect(marksOfType(json, 'textStyle')).toEqual([]);
    });

    test('a Courier New body is JetBrains Mono on every run, with no code mark and no code block', async () => {
        const { json } = await importDocxBody(BODY, {
            styles: bodyFont('w:ascii="Courier New" w:hAnsi="Courier New"'),
        });
        expect(fontsOf(json)).toEqual(['JetBrains Mono', 'JetBrains Mono']);
        expect(marksOfType(json, 'code')).toEqual([]);
        expect(nodesOfType(json, 'codeBlock')).toEqual([]);
    });

    test('an unknown font is no mark', async () => {
        const { json } = await importDocxBody(BODY, {
            styles: bodyFont('w:ascii="Wingdings Pro Fancy" w:hAnsi="Wingdings Pro Fancy"'),
        });
        expect(marksOfType(json, 'textStyle')).toEqual([]);
    });

    test('a theme font resolves through theme1.xml', async () => {
        const theme = `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office"><a:themeElements><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont><a:minorFont><a:latin typeface="Georgia"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`;
        const { json } = await importDocxBody(BODY, {
            styles: bodyFont('w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi"'),
            theme,
        });
        expect(fontsOf(json)).toEqual(['Source Serif 4', 'Source Serif 4']);
    });
});
