import { describe, expect, test } from 'bun:test';
import type { CountedWarningCode } from '../../../lib/document/transform/protocol';
import { readRules } from '../../../lib/import/sheets/rules';
import { readDxfs } from '../../../lib/import/sheets/styles';
import { cellKey } from '../../../lib/import/sheets/worksheet';
import { parseOoxml } from '../../../lib/ooxml/ooxml';
import { SML, sheetXml } from '../../fixtures/xlsx';

// A worksheet's conditional formats and data validations, Excel 2010's extensions besides, and each rule's output
// charged before it is built.

const PALETTE = ['#FFFFFF', '#000000', '#E7E6E6', '#44546A', '#4472C4'];
const X14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main';
const XM = 'http://schemas.microsoft.com/office/excel/2006/main';

const DXFS = readDxfs(
    parseOoxml(
        `<styleSheet xmlns="${SML}"><dxfs count="5">
<dxf><font><color rgb="FF9C0006"/></font><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf>
<dxf><fill><patternFill patternType="solid"><fgColor rgb="FF00FF00"/><bgColor rgb="FF0000FF"/></patternFill></fill></dxf>
<dxf><font><b/><color theme="4"/></font><fill><patternFill patternType="none"><bgColor rgb="FFFF0000"/></patternFill></fill></dxf>
<dxf><fill><gradientFill><stop position="0"><color rgb="FFFF0000"/></stop></gradientFill></fill></dxf>
<dxf><fill><patternFill><bgColor indexed="64"/></patternFill></fill></dxf>
</dxfs></styleSheet>`,
    ) ?? undefined,
    PALETTE,
);

type Options = {
    rows?: number;
    columns?: number;
    date1904?: boolean;
    charge?: (cells: number, text: number) => void;
    chargeElements?: (count: number) => void;
    lost?: (code: CountedWarningCode) => void;
    dates?: number[][];
};

function read(after: string, options: Options = {}) {
    const charged: { cells: number; text: number }[] = [];
    const rules = readRules(parseOoxml(sheetXml({ after })) ?? undefined, {
        dxfs: DXFS,
        palette: PALETTE,
        date1904: options.date1904 ?? false,
        rows: options.rows ?? 10,
        columns: options.columns ?? 5,
        charge: options.charge ?? ((cells, text) => charged.push({ cells, text })),
        chargeElements: options.chargeElements ?? (() => {}),
        lost: options.lost ?? (() => {}),
        dates: new Set((options.dates ?? []).map(([r, c]) => cellKey(r, c))),
    });
    return { ...rules, charged };
}

const cf = (sqref: string, ...rules: string[]) =>
    `<conditionalFormatting sqref="${sqref}">${rules.join('')}</conditionalFormatting>`;
const dv = (...validations: string[]) => `<dataValidations>${validations.join('')}</dataValidations>`;
const extension = (inner: string) =>
    `<extLst><ext uri="{78C0D931-6437-407d-A8EE-F0AAD7539E65}" xmlns:x14="${X14}" xmlns:xm="${XM}">${inner}</ext></extLst>`;

describe('a dxf', () => {
    test('names its fill in bgColor, or fgColor first where both are, and its font colour from the theme', () => {
        expect(DXFS).toEqual([
            { textColor: '#9C0006', cellColor: '#FFC7CE' },
            { textColor: null, cellColor: '#00FF00' },
            { textColor: '#4472C4', cellColor: null },
            { textColor: null, cellColor: null },
            { textColor: null, cellColor: null },
        ]);
    });

    test('is none without a styles part', () => {
        expect(readDxfs(undefined, PALETTE)).toEqual([]);
    });
});

describe('a conditional format', () => {
    test('a literal comparison keeps its operands, a quoted percent as its number, with its dxf', () => {
        const { conditionalFormatRules } = read(
            cf(
                'B1:B5',
                '<cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>10</formula></cfRule>',
                '<cfRule type="cellIs" dxfId="1" priority="2" operator="lessThanOrEqual"><formula>"5%"</formula></cfRule>',
                '<cfRule type="cellIs" dxfId="1" priority="3" operator="between"><formula>2</formula><formula>"say ""hi"""</formula></cfRule>',
            ),
        );
        const range = [{ row: [0, 4], column: [1, 1] }];
        // The lowest priority number wins in Excel and the last rule in the engine, so they come highest first.
        expect(conditionalFormatRules).toEqual([
            {
                type: 'default',
                cellrange: range,
                format: { textColor: null, cellColor: '#00FF00' },
                conditionName: 'between',
                conditionRange: [],
                conditionValue: ['2', 'say "hi"'],
            },
            {
                type: 'default',
                cellrange: range,
                format: { textColor: null, cellColor: '#00FF00' },
                conditionName: 'lessThanOrEqual',
                conditionRange: [],
                conditionValue: ['0.05'],
            },
            {
                type: 'default',
                cellrange: range,
                format: { textColor: '#9C0006', cellColor: '#FFC7CE' },
                conditionName: 'greaterThan',
                conditionRange: [],
                conditionValue: ['10'],
            },
        ]);
    });

    test('a comparison with a reference is a formula anchored at the first range, a missing dxf no look', () => {
        const { conditionalFormatRules } = read(
            cf(
                'C3:C9 A1',
                '<cfRule type="cellIs" priority="1" operator="notEqual"><formula>$A$1</formula></cfRule>',
                '<cfRule type="cellIs" dxfId="9" priority="2" operator="notBetween"><formula>$A$1</formula><formula>5</formula></cfRule>',
            ),
        );
        expect(conditionalFormatRules?.map((rule) => rule.type === 'default' && rule.conditionValue)).toEqual([
            ['=NOT(AND(C3>=$A$1,C3<=5))'],
            ['=C3<>$A$1'],
        ]);
        expect(conditionalFormatRules?.[0]).toMatchObject({
            conditionName: 'formula',
            format: { textColor: null, cellColor: null },
            cellrange: [
                { row: [2, 8], column: [2, 2] },
                { row: [0, 0], column: [0, 0] },
            ],
        });
    });

    test('an expression, and the text and date rules Excel stores a formula for, are formula rules', () => {
        const formula = (type: string, text: string, priority: number) =>
            `<cfRule type="${type}" dxfId="0" priority="${priority}"><formula>${text}</formula></cfRule>`;
        const { conditionalFormatRules } = read(
            cf(
                'B2:B4 D2:D4',
                formula('expression', 'SUM(B2:$C$3)&gt;2', 7),
                formula('containsText', 'NOT(ISERROR(SEARCH(LEFT($A$1),B2)))', 6),
                formula('notContainsText', 'ISERROR(SEARCH("x",B2))', 5),
                formula('beginsWith', 'LEFT(B2,1)="a"', 4),
                formula('timePeriod', 'FLOOR(B2,1)=TODAY()', 3),
                formula('containsBlanks', 'LEN(TRIM(B2))=0', 2),
                formula('containsErrors', 'ISERROR(B2)', 1),
            ),
        );
        expect(conditionalFormatRules?.map((rule) => rule.type === 'default' && rule.conditionValue[0])).toEqual([
            '=SUM(B2:$C$3)>2',
            '=NOT(ISERROR(SEARCH(LEFT($A$1),B2)))',
            '=ISERROR(SEARCH("x",B2))',
            '=LEFT(B2,1)="a"',
            '=FLOOR(B2,1)=TODAY()',
            '=LEN(TRIM(B2))=0',
            '=ISERROR(B2)',
        ]);
    });

    test("a text rule is the engine's own when its formula searches a literal", () => {
        const { conditionalFormatRules } = read(
            cf(
                'A1:A3',
                '<cfRule type="containsText" dxfId="0" priority="1" operator="containsText" text="ignored"><formula>NOT(ISERROR(SEARCH("a ""b""",A1)))</formula></cfRule>',
            ),
        );
        expect(conditionalFormatRules).toEqual([
            {
                type: 'default',
                cellrange: [{ row: [0, 2], column: [0, 0] }],
                format: { textColor: '#9C0006', cellColor: '#FFC7CE' },
                conditionName: 'textContains',
                conditionRange: [],
                conditionValue: ['a "b"'],
            },
        ]);
    });

    test('top and bottom, average and duplicate rules', () => {
        const { conditionalFormatRules } = read(
            cf(
                'A1:A9',
                '<cfRule type="top10" dxfId="0" priority="1" rank="3"/>',
                '<cfRule type="top10" dxfId="0" priority="2" bottom="1" percent="true"/>',
                '<cfRule type="aboveAverage" dxfId="0" priority="3"/>',
                '<cfRule type="aboveAverage" dxfId="0" priority="4" aboveAverage="0"/>',
                '<cfRule type="duplicateValues" dxfId="0" priority="5"/>',
                '<cfRule type="uniqueValues" dxfId="0" priority="6"/>',
            ),
        );
        expect(
            conditionalFormatRules?.map((rule) => rule.type === 'default' && [rule.conditionName, rule.conditionValue]),
        ).toEqual([
            ['duplicateValue', ['1']],
            ['duplicateValue', ['0']],
            ['belowAverage', []],
            ['aboveAverage', []],
            ['last10_percent', ['10']],
            ['top10', ['3']],
        ]);
    });

    test('a colour scale lists its stops from the maximum; a data bar is one solid colour', () => {
        const { conditionalFormatRules } = read(
            cf(
                'C1:C3',
                '<cfRule type="colorScale" priority="1"><colorScale><cfvo type="min"/><cfvo type="percentile" val="50"/><cfvo type="max"/><color rgb="FFF8696B"/><color theme="0" tint="-0.5"/><color theme="4"/></colorScale></cfRule>',
                '<cfRule type="dataBar" priority="2"><dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="FF638EC6"/></dataBar></cfRule>',
            ),
        );
        const cellrange = [{ row: [0, 2], column: [2, 2] }];
        expect(conditionalFormatRules).toEqual([
            { type: 'dataBar', cellrange, format: ['#638EC6'] },
            { type: 'colorGradation', cellrange, format: ['#4472C4', '#808080', '#F8696B'] },
        ]);
    });

    test('what the engine has no rule for is dropped, the rest of the block kept', () => {
        const { conditionalFormatRules } = read(
            cf(
                'A1:A3',
                '<cfRule type="iconSet" priority="1"><iconSet iconSet="3Arrows"><cfvo type="percent" val="0"/><cfvo type="percent" val="33"/><cfvo type="percent" val="67"/></iconSet></cfRule>',
                '<cfRule type="colorScale" priority="2"><colorScale><cfvo type="min"/><cfvo type="max"/><color indexed="2"/><color rgb="FF000000"/></colorScale></cfRule>',
                '<cfRule type="dataBar" priority="3"><dataBar><cfvo type="min"/><cfvo type="max"/><color auto="1"/></dataBar></cfRule>',
                '<cfRule type="cellIs" priority="4" operator="constructor"><formula>1</formula></cfRule>',
                '<cfRule type="expression" priority="5"/>',
                '<cfRule type="cellIs" dxfId="0" priority="6" operator="equal"><formula>1</formula></cfRule>',
            ) +
                cf(
                    'nowhere',
                    '<cfRule type="cellIs" dxfId="0" priority="7" operator="equal"><formula>1</formula></cfRule>',
                ),
        );
        expect(conditionalFormatRules).toEqual([
            {
                type: 'default',
                cellrange: [{ row: [0, 2], column: [0, 0] }],
                format: { textColor: '#9C0006', cellColor: '#FFC7CE' },
                conditionName: 'equal',
                conditionRange: [],
                conditionValue: ['1'],
            },
        ]);
    });

    test('each rule left out is counted, one the engine has none for or one over no range', () => {
        const lost: CountedWarningCode[] = [];
        read(
            cf(
                'A1:A3',
                '<cfRule type="iconSet" priority="1"><iconSet iconSet="3Arrows"/></cfRule>',
                '<cfRule type="cellIs" dxfId="0" priority="2" operator="equal"><formula>1</formula></cfRule>',
            ) +
                cf(
                    'nowhere',
                    '<cfRule type="cellIs" dxfId="0" priority="3" operator="equal"><formula>1</formula></cfRule>',
                    '<cfRule type="expression" dxfId="0" priority="4"><formula>A1</formula></cfRule>',
                ),
            { lost: (code) => lost.push(code) },
        );
        expect(lost).toEqual(Array(3).fill('conditional-formats-dropped'));
    });

    test('a range is cut to the grid, and one starting past it dropped', () => {
        const { conditionalFormatRules } = read(
            cf(
                `B2:A99999999 XFE1 ${'A'.repeat(300)}1 C1:${'Z'.repeat(300)}2`,
                '<cfRule type="expression" priority="1"><formula>1</formula></cfRule>',
            ),
        );
        expect(conditionalFormatRules?.[0].cellrange).toEqual([
            { row: [1, 1048575], column: [0, 1] },
            { row: [0, 1], column: [2, 16383] },
        ]);
    });

    test("Excel 2010's rules hold their formulas and look themselves, ordered among the others by priority", () => {
        const { conditionalFormatRules } = read(
            cf(
                'A1:A5',
                '<cfRule type="cellIs" dxfId="0" priority="1" operator="lessThan"><formula>0</formula></cfRule>',
            ) +
                extension(
                    `<x14:conditionalFormattings><x14:conditionalFormatting><x14:cfRule type="cellIs" priority="2" operator="greaterThan" id="{1}"><xm:f>3</xm:f><x14:dxf><font><color rgb="FF9C0006"/></font><fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/></patternFill></fill></x14:dxf></x14:cfRule><x14:cfRule type="expression" priority="3" id="{2}"><xm:f>Other!$A$1&gt;G3</xm:f><x14:dxf/></x14:cfRule><x14:cfRule type="dataBar" id="{3}"><x14:dataBar><x14:cfvo type="autoMin"/><x14:cfvo type="autoMax"/></x14:dataBar></x14:cfRule><xm:sqref>G3:G4</xm:sqref></x14:conditionalFormatting></x14:conditionalFormattings>`,
                ),
        );
        const cellrange = [{ row: [2, 3], column: [6, 6] }];
        expect(conditionalFormatRules).toEqual([
            {
                type: 'default',
                cellrange,
                format: { textColor: null, cellColor: null },
                conditionName: 'formula',
                conditionRange: [],
                conditionValue: ['=Other!$A$1>G3'],
            },
            {
                type: 'default',
                cellrange,
                format: { textColor: '#9C0006', cellColor: '#FFC7CE' },
                conditionName: 'greaterThan',
                conditionRange: [],
                conditionValue: ['3'],
            },
            {
                type: 'default',
                cellrange: [{ row: [0, 4], column: [0, 0] }],
                format: { textColor: '#9C0006', cellColor: '#FFC7CE' },
                conditionName: 'lessThan',
                conditionRange: [],
                conditionValue: ['0'],
            },
        ]);
    });

    test('each range is charged once for each rule before it is built, and each rule its formulas, kept or not', () => {
        const { charged } = read(
            cf(
                'A1:A5 C1 nowhere E1:F2',
                '<cfRule type="expression" priority="1"><formula>A1&gt;1</formula></cfRule>',
                '<cfRule type="iconSet" priority="2"><iconSet/></cfRule>',
            ),
        );
        expect(charged).toEqual([
            { cells: 2, text: 0 },
            { cells: 2, text: 0 },
            { cells: 2, text: 0 },
            { cells: 0, text: 4 },
            { cells: 0, text: 0 },
        ]);
        const refusal = new Error('over budget');
        expect(() =>
            read(cf('A1:A2', '<cfRule type="expression" priority="1"><formula>1</formula></cfRule>'), {
                charge: () => {
                    throw refusal;
                },
            }),
        ).toThrow(refusal);
    });

    // A sqref of millions of references, parsed whatever they emit, held the reader for 10 to 16 s.
    test('each reference of a sqref is charged before it is parsed, and a block without rules reads none of its', () => {
        let references = 0;
        const chargeElements = (count: number) => {
            references += count;
        };
        read(cf('A1:A5 nowhere C1', '<cfRule type="expression" priority="1"><formula>1</formula></cfRule>'), {
            chargeElements,
        });
        expect(references).toBe(3);
        references = 0;
        const list = (sqref: string) =>
            dv(`<dataValidation type="list" sqref="${sqref}"><formula1>"a"</formula1></dataValidation>`);
        read(`${cf('A1 B1 C1')}${list('XFD1048576 A1')}`, { chargeElements });
        expect(references).toBe(2);
        const refusal = new Error('over budget');
        expect(() =>
            read(list('A1'), {
                chargeElements: () => {
                    throw refusal;
                },
            }),
        ).toThrow(refusal);
    });

    test('reads a million digits before no number, and a million spaces between ranges, in linear time', () => {
        const started = performance.now();
        read(
            cf(
                `A1${' '.repeat(1_000_000)}B1`,
                `<cfRule type="cellIs" priority="1" operator="equal"><formula>${'1'.repeat(1_000_000)}x</formula></cfRule>`,
                `<cfRule type="containsText" priority="2"><formula>NOT(ISERROR(SEARCH("${'a'.repeat(1_000_000)}</formula></cfRule>`,
            ),
        );
        expect(performance.now() - started).toBeLessThan(1000);
    });

    // A 1904 workbook's date cell holds its serial from 1904, which the reader moves to the 1900 system: a comparison
    // with a date moves with it, one with a number doesn't.
    test("a 1904 workbook's comparison over dates counts from 1904", () => {
        const rule = (sqref: string) =>
            cf(
                sqref,
                '<cfRule type="cellIs" dxfId="0" priority="1" operator="between"><formula>43000</formula><formula>"x"</formula></cfRule>',
            );
        const { conditionalFormatRules } = read(`${rule('A1:A3')}${rule('B1')}`, { date1904: true, dates: [[0, 0]] });
        expect(conditionalFormatRules?.map((format) => 'conditionValue' in format && format.conditionValue)).toEqual([
            ['44462', 'x'],
            ['43000', 'x'],
        ]);
    });
});

describe('a data validation', () => {
    const list = (sqref: string, formula: string, attributes = '') =>
        `<dataValidation type="list" allowBlank="1" sqref="${sqref}"${attributes}><formula1>${formula}</formula1></dataValidation>`;

    test('a literal list is a dropdown on every cell of its ranges', () => {
        const { dataVerification } = read(dv(list('B2:B3 D1', '"Red,Green,Blue"')));
        const expected = {
            type: 'dropdown',
            type2: '',
            value1: 'Red,Green,Blue',
            value2: '',
            prohibitInput: false,
            hintShow: false,
            hintValue: '',
        };
        expect(dataVerification).toEqual({ '1_1': expected, '2_1': expected, '0_3': expected });
    });

    test('a list over a range keeps the reference; a defined name, an empty list or a custom rule is dropped', () => {
        const { dataVerification } = read(
            dv(
                list('A1', "'Other Sheet'!$B$1:$B$5"),
                list('A2', '=$C$1:$C$3'),
                list('A3', 'MyNamedRange'),
                // A name shaped like a cell past Excel's last column.
                list('A8', 'UkRegion2'),
                list('A4', '""'),
                '<dataValidation type="custom" sqref="A5"><formula1>A5&gt;0</formula1></dataValidation>',
                '<dataValidation sqref="A6"/>',
                '<dataValidation type="constructor" sqref="A7"><formula1>1</formula1></dataValidation>',
            ),
        );
        expect(Object.keys(dataVerification ?? {})).toEqual(['0_0', '1_0']);
        expect(dataVerification?.['0_0'].value1).toBe("'Other Sheet'!$B$1:$B$5");
        expect(dataVerification?.['1_0'].value1).toBe('$C$1:$C$3');
    });

    test('numbers, lengths and dates map onto the engine types and operators', () => {
        const { dataVerification } = read(
            dv(
                '<dataValidation type="whole" sqref="A1"><formula1>1</formula1><formula2>10.7</formula2></dataValidation>',
                '<dataValidation type="decimal" operator="greaterThan" sqref="A2"><formula1>2.5</formula1></dataValidation>',
                '<dataValidation type="textLength" operator="lessThanOrEqual" sqref="A3"><formula1>5</formula1></dataValidation>',
                '<dataValidation type="date" operator="between" sqref="A4"><formula1>45292</formula1><formula2>45657</formula2></dataValidation>',
                '<dataValidation type="date" operator="greaterThan" sqref="A5"><formula1>45458</formula1></dataValidation>',
                '<dataValidation type="whole" operator="greaterThan" sqref="A6"><formula1>$B$1</formula1></dataValidation>',
                '<dataValidation type="whole" sqref="A7"><formula1>1</formula1></dataValidation>',
                '<dataValidation type="whole" operator="sideways" sqref="A8"><formula1>1</formula1></dataValidation>',
            ),
        );
        expect(dataVerification).toMatchObject({
            '0_0': { type: 'number_integer', type2: 'between', value1: '1', value2: '10' },
            // Excel's decimal takes any number, as the engine's number does; its number_decimal refuses an integer.
            '1_0': { type: 'number', type2: 'moreThanThe', value1: '2.5', value2: '' },
            '2_0': { type: 'text_length', type2: 'lessThanOrEqualTo', value1: '5' },
            '3_0': { type: 'date', type2: 'between', value1: '2024-01-01', value2: '2024-12-31' },
            '4_0': { type: 'date', type2: 'laterThan', value1: '2024-06-15', value2: '' },
        });
        expect(Object.keys(dataVerification ?? {})).toHaveLength(5);
    });

    test("a 1904 workbook's date serial counts from 1904", () => {
        const { dataVerification } = read(
            dv(
                '<dataValidation type="date" operator="lessThan" sqref="A1"><formula1>43830</formula1></dataValidation>',
            ),
            { date1904: true },
        );
        expect(dataVerification?.['0_0']).toMatchObject({ type2: 'earlierThan', value1: '2024-01-01' });
    });

    test('a prompt shows when asked to, and an error stops the value unless it only warns', () => {
        const { dataVerification } = read(
            dv(
                list('A1', '"Yes,No"', ' showInputMessage="1" promptTitle="Pick" prompt="Choose Yes or No"'),
                list('A2', '"Yes,No"', ' showErrorMessage="true" error="Invalid"'),
                list('A3', '"Yes,No"', ' showErrorMessage="1" errorStyle="warning"'),
                list('A4', '"Yes,No"', ' showInputMessage="1"'),
                list('A5', '"Yes,No"', ' prompt="Hidden"'),
            ),
        );
        expect(dataVerification).toMatchObject({
            '0_0': { hintShow: true, hintValue: 'Choose Yes or No', prohibitInput: false },
            '1_0': { hintShow: false, hintValue: '', prohibitInput: true },
            '2_0': { prohibitInput: false },
            '3_0': { hintShow: false, hintValue: '' },
            '4_0': { hintShow: false, hintValue: '' },
        });
    });

    test('stops a margin past the cells, and a later rule on a cell wins', () => {
        const { dataVerification } = read(
            dv(list('C1:C5000', '"Yes,No"'), list('A1:XFD1', '"x"'), list('C2 B5:A4', '"Later"')),
            { rows: 5, columns: 3 },
        );
        const keys = Object.keys(dataVerification ?? {});
        expect(dataVerification?.['1004_2']).toMatchObject({ value1: 'Yes,No' });
        expect(dataVerification?.['1005_2']).toBeUndefined();
        expect(dataVerification?.['0_102']).toMatchObject({ value1: 'x' });
        expect(dataVerification?.['0_103']).toBeUndefined();
        expect(dataVerification?.['1_2']).toMatchObject({ value1: 'Later' });
        expect(dataVerification?.['3_0']).toMatchObject({ value1: 'Later' });
        expect(dataVerification?.['4_1']).toMatchObject({ value1: 'Later' });
        expect(keys).toHaveLength(1005 + 102 + 4);
    });

    test("Excel 2010's lists name their source and ranges in its own elements", () => {
        const { dataVerification } = read(
            dv(list('A1', '"a,b"')) +
                extension(
                    `<x14:dataValidations count="2"><x14:dataValidation type="list" allowBlank="1" showInputMessage="1" prompt="From lists"><x14:formula1><xm:f>lists!$A$2:$A$22</xm:f></x14:formula1><xm:sqref>E2:E3 A1</xm:sqref></x14:dataValidation><x14:dataValidation type="whole"><x14:formula1><xm:f>1</xm:f></x14:formula1><x14:formula2><xm:f>9</xm:f></x14:formula2><xm:sqref>F1</xm:sqref></x14:dataValidation></x14:dataValidations>`,
                ),
        );
        const fromLists = { type: 'dropdown', value1: 'lists!$A$2:$A$22', hintShow: true, hintValue: 'From lists' };
        expect(dataVerification).toMatchObject({
            '0_0': fromLists,
            '1_4': fromLists,
            '2_4': fromLists,
            '0_5': { type: 'number_integer', type2: 'between', value1: '1', value2: '9' },
        });
        expect(Object.keys(dataVerification ?? {})).toHaveLength(4);
    });

    test('each range is charged its cells past the clamp, and its list and prompt per cell, before a key is built', () => {
        const { charged } = read(
            dv(
                list('A1:B2 Z9000 C1', '"Yes,No"', ' showInputMessage="1" prompt="Pick"'),
                '<dataValidation type="custom" sqref="A1:XFD1048576"><formula1>1</formula1></dataValidation>',
            ),
            { rows: 2, columns: 2 },
        );
        expect(charged).toEqual([
            { cells: 4, text: 4 * 10 },
            { cells: 1, text: 10 },
        ]);
        const refusal = new Error('over budget');
        expect(() =>
            read(dv(list('A1:XFD1048576', '"x"')), {
                charge: (cells) => {
                    expect(cells).toBe(1010 * 105);
                    throw refusal;
                },
            }),
        ).toThrow(refusal);
    });
});

test('a sheet without rules has none', () => {
    expect(read('')).toEqual({ charged: [] });
    expect(
        readRules(undefined, {
            dxfs: [],
            palette: [],
            date1904: false,
            rows: 0,
            columns: 0,
            charge: () => {},
            chargeElements: () => {},
            lost: () => {},
            dates: new Set(),
        }),
    ).toEqual({});
});
