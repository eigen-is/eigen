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

// G5: a name the map doesn't know draws in its fontTable.xml category: fixed pitch is monospace, roman serif and swiss
// sans at a variable pitch; script, decorative and auto are an unknown category (P4), and so is a family at pitch
// default, which Word writes for a font it has no metrics of.
describe('fontTable.xml fallback', () => {
    const font = (name: string, family: string, pitch = 'variable') =>
        `<w:font w:name="${name}"><w:family w:val="${family}"/><w:pitch w:val="${pitch}"/></w:font>`;
    const fontTable = [
        font('Fixed Fancy', 'auto', 'fixed'),
        font('Modern Fancy', 'modern'),
        font('Roman Fancy', 'roman'),
        font('Swiss Fancy', 'swiss'),
        font('Script Fancy', 'script'),
        font('Decorative Fancy', 'decorative'),
        font('Unmeasured Fancy', 'roman', 'default'),
        font('Georgia', 'swiss'),
    ].join('');
    const runIn = (name: string) =>
        `<w:r><w:rPr><w:rFonts w:ascii="${name}" w:hAnsi="${name}"/></w:rPr><w:t>${name}</w:t></w:r>`;

    test('an unknown name maps by its family and pitch; a known name by its own', async () => {
        const names = [
            'Fixed Fancy',
            'Modern Fancy',
            'Roman Fancy',
            'Swiss Fancy',
            'Script Fancy',
            'Decorative Fancy',
            'Unmeasured Fancy',
            'Georgia',
            'Unlisted Fancy',
        ];
        const { json } = await importDocxBody(names.map((name) => paragraph(runIn(name))).join(''), { fontTable });
        expect(fontsOf(json)).toEqual([
            'JetBrains Mono',
            null,
            'Source Serif 4',
            null,
            null,
            null,
            null,
            'Source Serif 4',
            null,
        ]);
    });

    test('a shaded paragraph in an unknown fixed-pitch font is the code a Google Docs re-save flattens', async () => {
        const shaded = `<w:p><w:pPr><w:shd w:val="clear" w:fill="F3F4F6"/></w:pPr>${runIn('Fixed Fancy')}</w:p>`;
        const { json } = await importDocxBody(shaded, { fontTable });
        expect(nodesOfType(json, 'codeBlock')).toHaveLength(1);
    });
});
