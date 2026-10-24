import { describe, expect, test } from 'bun:test';
import type { Cell } from '@workspace/lib/sheets';
import { SHEET_DEFAULT_DIGIT_WIDTH } from '@workspace/lib/sheets';
import type { CountedWarningCode } from '../../../../lib/document/transform/protocol';
import { styleRegistry } from '../../../../lib/export/sheets/xlsx/styles';
import { defaultFontDigitWidth, readDxfs, readLooks } from '../../../../lib/import/sheets/styles';
import { parseOoxml } from '../../../../lib/ooxml/ooxml';

function registryOf() {
    const lost: CountedWarningCode[] = [];
    return { styles: styleRegistry((code) => lost.push(code)), lost };
}

function styleSheet(xml: string) {
    const root = parseOoxml(xml);
    if (!root) throw new Error('no styleSheet');
    return root;
}

describe('the style registry', () => {
    test("Inter at the sheet's default size is the first font, so a column width counts its digit", () => {
        const { styles } = registryOf();
        const xml = styles.xml();
        expect(xml.match(/<fonts\b[^>]*>(<font>.*?<\/font>)/)?.[1]).toBe(
            '<font><sz val="10"/><name val="Inter"/><family val="2"/></font>',
        );
        expect(xml).toContain(
            '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>',
        );
        expect(defaultFontDigitWidth(styleSheet(xml))).toBe(SHEET_DEFAULT_DIGIT_WIDTH);
    });

    test('a cell without a look of its own is the default format; one look is one format however many cells hold it', () => {
        const { styles } = registryOf();
        expect(styles.xf(undefined, undefined)).toBe(0);
        expect(styles.xf({ v: 1, m: '1', ct: { fa: 'General', t: 'n' } }, undefined)).toBe(0);
        const bold: Cell = { v: 'a', bl: 1 };
        expect(styles.xf(bold, undefined)).toBe(1);
        expect(styles.xf({ v: 'b', bl: 1 }, undefined)).toBe(1);
        expect(styles.xf({ v: 'c', bl: 1 }, { l: { style: 1, color: '#000000' } })).toBe(2);
        expect(styles.xml()).toContain('<cellXfs count="3">');
    });

    test('each look reads back as written: font, fill, alignment, rotation, borders and the diagonal', () => {
        const { styles } = registryOf();
        const cells: Cell[] = [
            { bl: 1, it: 1, un: 1, cl: 1, fs: 14, ff: 'Georgia', fc: '#FF0000' },
            { bg: 'rgb(0, 128, 255)', ht: 0, vt: 0, tb: '2' },
            { rt: 45, ht: 2, vt: 1 },
            { rt: -45 },
            { rt: 'vertical' },
        ];
        const ids = cells.map((cell) => styles.xf(cell, undefined));
        const border = {
            l: { style: 8, color: '#FF0000' },
            t: { style: 1, color: '#000' },
            s: { style: 2, color: '#00FF00' },
        };
        const bordered = styles.xf(undefined, border);
        const looks = readLooks(styleSheet(styles.xml()), []);
        // The import gives every cell of a format its font whole.
        const font = { fs: 10, ff: 'Inter' };
        expect(looks[ids[0]].cell).toEqual({ bl: 1, it: 1, un: 1, cl: 1, fs: 14, fc: '#FF0000', ff: 'Source Serif 4' });
        expect(looks[ids[1]].cell).toEqual({ ...font, bg: '#0080FF', ht: 0, vt: 0, tb: '2' });
        expect(looks[ids[2]].cell).toEqual({ ...font, rt: 45, ht: 2, vt: 1 });
        expect(looks[ids[3]].cell).toEqual({ ...font, rt: -45 });
        expect(looks[ids[4]].cell).toEqual({ ...font, rt: 'vertical' });
        expect(looks[bordered].border).toEqual({
            l: { style: 8, color: '#FF0000' },
            t: { style: 1, color: '#000000' },
            s: { style: 2, color: '#00FF00' },
        });
    });

    test("a colour Office can't hold paints nothing", () => {
        const { styles } = registryOf();
        expect(styles.xf({ fc: 'red', bg: 'rgba(0, 0, 0, 0)' }, undefined)).toBe(0);
    });

    test("number formats: General is the default, Excel's locale-free built-ins by id, the rest from 164 in Excel's case", () => {
        const { styles } = registryOf();
        const format = (fa: string, t = 'n') => styles.xf({ v: 1, ct: { fa, t } }, undefined);
        const ids = [
            format('General'),
            format('0.00%'),
            format('#,##0.00'),
            format('@'),
            format('M/d/yyyy', 'd'),
            format('yyyy-MM-dd hh:mm:ss', 'd'),
            format('[$€]#,##0.00'),
            format('h:mm AM/PM "Mon" \\M [Magenta]0'),
            format('mm-dd-yy', 'd'),
        ];
        const xml = styles.xml();
        expect(xml).toContain('<numFmt numFmtId="164" formatCode="m/d/yyyy"/>');
        expect(xml).toContain('<numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm:ss"/>');
        expect(xml).toContain('<numFmt numFmtId="166" formatCode="[$€]#,##0.00"/>');
        expect(xml).toContain('<numFmt numFmtId="167" formatCode="h:mm AM/PM &quot;Mon&quot; \\M [Magenta]0"/>');
        // A short date's built-in id shows in the reader's locale, so it is written as a code of its own.
        expect(xml).toContain('<numFmt numFmtId="168" formatCode="mm-dd-yy"/>');
        const looks = readLooks(styleSheet(xml), []);
        expect(ids[0]).toBe(0);
        // The import draws a format numfmt can't parse as General.
        expect(ids.slice(1).map((id) => looks[id].numFmt)).toEqual([
            '0.00%',
            '#,##0.00',
            '@',
            'm/d/yyyy',
            'yyyy-mm-dd hh:mm:ss',
            '[$€]#,##0.00',
            undefined,
            'mm-dd-yy',
        ]);
        expect(xml).toMatch(/<xf numFmtId="10" /);
        expect(xml).toMatch(/<xf numFmtId="4" /);
        expect(xml).toMatch(/<xf numFmtId="49" /);
    });

    test('a date whose format draws no date is written m/d/yyyy, so it reads back as a date', () => {
        const { styles } = registryOf();
        const id = styles.xf({ v: 45366, ct: { fa: 'General', t: 'd' } }, undefined);
        expect(readLooks(styleSheet(styles.xml()), [])[id]).toMatchObject({ numFmt: 'm/d/yyyy', isDate: true });
    });

    test("past Excel's 255 characters a format is General, counted", () => {
        const { styles, lost } = registryOf();
        expect(styles.xf({ v: 1, ct: { fa: `0.${'0'.repeat(300)}`, t: 'n' } }, undefined)).toBe(0);
        expect(lost).toEqual(['number-formats-dropped']);
    });

    test("past Excel's 64,000 cell formats a cell keeps the default, counted", () => {
        const { styles, lost } = registryOf();
        const hex = (index: number) => `#${index.toString(16).padStart(6, '0')}`;
        for (let index = 0; index < 64_002; index++) styles.xf({ bg: hex(index) }, undefined);
        expect(styles.xf({ bg: hex(1) }, undefined)).toBe(2);
        expect(styles.xf({ bg: hex(64_100) }, undefined)).toBe(0);
        expect(lost).toEqual(Array(4).fill('cell-formats-dropped'));
        expect(styles.xml()).toContain('<cellXfs count="64000">');
    });

    test("a conditional format's look is a dxf, interned, that reads back as given", () => {
        const { styles } = registryOf();
        expect(styles.dxf({ textColor: '#AA0000', cellColor: '#00FF00' })).toBe(0);
        expect(styles.dxf({ textColor: null, cellColor: '#00FF00' })).toBe(1);
        expect(styles.dxf({ textColor: 'rgb(170, 0, 0)', cellColor: '#0f0' })).toBe(0);
        expect(readDxfs(styleSheet(styles.xml()), [])).toEqual([
            { textColor: '#AA0000', cellColor: '#00FF00' },
            { textColor: null, cellColor: '#00FF00' },
        ]);
    });

    test('the parts come in the order CT_Stylesheet sets', () => {
        const { styles } = registryOf();
        styles.xf({ v: 1, ct: { fa: '0.0000', t: 'n' } }, undefined);
        const names = [
            ...styles.xml().matchAll(/<(numFmts|fonts|fills|borders|cellStyleXfs|cellXfs|cellStyles|dxfs)\b/g),
        ];
        expect(names.map(([, name]) => name)).toEqual([
            'numFmts',
            'fonts',
            'fills',
            'borders',
            'cellStyleXfs',
            'cellXfs',
            'cellStyles',
            'dxfs',
        ]);
    });
});
