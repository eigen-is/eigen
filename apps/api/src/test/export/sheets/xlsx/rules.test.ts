import { describe, expect, test } from 'bun:test';
import type {
    ConditionalFormatRule,
    DataVerificationRule,
    DefaultConditionalFormatRule,
    Sheet,
    SingleRange,
} from '@workspace/lib/sheets';
import { parseOoxml } from '../../../../lib/core/ooxml';
import type { CountedWarningCode } from '../../../../lib/document/transform/protocol';
import { rulesXml } from '../../../../lib/export/sheets/xlsx/rules';
import type { StyleRegistry } from '../../../../lib/export/sheets/xlsx/styles';
import { readRules } from '../../../../lib/import/sheets/rules';
import type { DxfLook } from '../../../../lib/import/sheets/styles';
import { sheetXml } from '../../../fixtures/xlsx';

// A sheet's conditional formats and data validations, written and read back through the reader, whose dxfs are the
// looks the registry interned.

function roundTrip(sheet: Partial<Sheet>) {
    const looks: DxfLook[] = [];
    const ids = new Map<string, number>();
    const styles: StyleRegistry = {
        dxf(format) {
            const key = JSON.stringify(format);
            const id = ids.get(key) ?? looks.push(format) - 1;
            ids.set(key, id);
            return id;
        },
    };
    const lost: CountedWarningCode[] = [];
    const xml = rulesXml({ name: 'Sheet1', ...sheet }, styles, (code) => lost.push(code));
    const read = readRules(parseOoxml(sheetXml({ after: xml })) ?? undefined, {
        dxfs: looks,
        palette: [],
        date1904: false,
        rows: 100,
        columns: 26,
        charge: () => {},
        chargeElements: () => {},
        dates: new Set(),
    });
    return { xml, lost, looks, ...read };
}

const RANGE: SingleRange[] = [{ row: [0, 4], column: [1, 1] }];
const RED = { textColor: '#9C0006', cellColor: '#FFC7CE' };

const condition = (
    conditionName: DefaultConditionalFormatRule['conditionName'],
    conditionValue: string[],
    format: DefaultConditionalFormatRule['format'] = RED,
    cellrange = RANGE,
): DefaultConditionalFormatRule => ({
    type: 'default',
    cellrange,
    format,
    conditionName,
    conditionRange: [],
    conditionValue,
});

describe('a conditional format', () => {
    test('every rule kind the engine evaluates reads back as itself, in order', () => {
        const rules: ConditionalFormatRule[] = [
            condition('greaterThan', ['10']),
            condition('greaterThanOrEqual', ['-1.5']),
            condition('lessThan', ['0']),
            condition('lessThanOrEqual', ['.5']),
            condition('equal', ['say "hi"']),
            condition('notEqual', ['x']),
            condition('between', ['1', '5']),
            condition('notBetween', ['2', 'b']),
            condition('textContains', ['a "b" & <c>']),
            condition('formula', ['=AND(B1>2,$A$1<>"")']),
            condition('top10', ['3']),
            condition('top10_percent', ['20']),
            condition('last10', ['4']),
            condition('last10_percent', ['15']),
            condition('aboveAverage', []),
            condition('belowAverage', []),
            condition('duplicateValue', ['0']),
            condition('duplicateValue', ['1']),
            { type: 'colorGradation', cellrange: RANGE, format: ['#63BE7B', '#FFEB84', '#F8696B'] },
            { type: 'colorGradation', cellrange: RANGE, format: ['#FFFFFF', '#5A8AC6'] },
            { type: 'dataBar', cellrange: RANGE, format: ['#638EC6'] },
        ];
        const { conditionalFormatRules, lost } = roundTrip({ conditionalFormatRules: rules });
        expect(lost).toEqual([]);
        expect(conditionalFormatRules).toEqual(rules);
    });

    test("Excel's canonical forms: the 2007 elements, a text rule's formula on its anchor, operands quoted", () => {
        const { xml } = roundTrip({
            conditionalFormatRules: [
                condition('textContains', ['a"b'], RED, [
                    { row: [2, 8], column: [2, 2] },
                    { row: [0, 0], column: [0, 0] },
                ]),
                condition('equal', ['say "hi"']),
                condition('top10_percent', ['20']),
                condition('belowAverage', []),
                condition('duplicateValue', ['1']),
                { type: 'colorGradation', cellrange: RANGE, format: ['rgb(99, 190, 123)', '#fff'] },
                { type: 'dataBar', cellrange: RANGE, format: ['#638EC6'] },
            ],
        });
        expect(xml).toBe(
            '<conditionalFormatting sqref="C3:C9 A1">' +
                '<cfRule type="containsText" dxfId="0" priority="7" operator="containsText" text="a&quot;b"><formula>NOT(ISERROR(SEARCH(&quot;a&quot;&quot;b&quot;,C3)))</formula></cfRule>' +
                '</conditionalFormatting>' +
                '<conditionalFormatting sqref="B1:B5">' +
                '<cfRule type="cellIs" dxfId="0" priority="6" operator="equal"><formula>&quot;say &quot;&quot;hi&quot;&quot;&quot;</formula></cfRule>' +
                '<cfRule type="top10" dxfId="0" priority="5" percent="1" rank="20"/>' +
                '<cfRule type="aboveAverage" dxfId="0" priority="4" aboveAverage="0"/>' +
                '<cfRule type="uniqueValues" dxfId="0" priority="3"/>' +
                '<cfRule type="colorScale" priority="2"><colorScale><cfvo type="min"/><cfvo type="max"/><color rgb="FFFFFFFF"/><color rgb="FF63BE7B"/></colorScale></cfRule>' +
                '<cfRule type="dataBar" priority="1"><dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="FF638EC6"/></dataBar></cfRule>' +
                '</conditionalFormatting>',
        );
    });

    test('a formula is written without its = and with the prefix Excel stores a newer function under', () => {
        const rules = [condition('formula', ['=XLOOKUP(B1,A:A,C:C)>0'])];
        const { xml, conditionalFormatRules } = roundTrip({ conditionalFormatRules: rules });
        expect(xml).toContain(
            '<cfRule type="expression" dxfId="0" priority="1"><formula>_xlfn.XLOOKUP(B1,A:A,C:C)&gt;0</formula>',
        );
        expect(conditionalFormatRules).toEqual(rules);
    });

    test('equal looks share a dxf through the registry, and a rule without colours names none', () => {
        const { xml, looks, conditionalFormatRules } = roundTrip({
            conditionalFormatRules: [
                condition('greaterThan', ['1']),
                condition('lessThan', ['0'], { textColor: null, cellColor: '#00FF00' }),
                condition('equal', ['2']),
                condition('notEqual', ['3'], { textColor: null, cellColor: null }),
            ],
        });
        expect(looks).toEqual([RED, { textColor: null, cellColor: '#00FF00' }]);
        expect([...xml.matchAll(/<cfRule [^>]*>/g)].map(([tag]) => tag.match(/dxfId="(\d+)"/)?.[1])).toEqual([
            '0',
            '1',
            '0',
            undefined,
        ]);
        expect(conditionalFormatRules?.[3]).toMatchObject({ format: { textColor: null, cellColor: null } });
    });

    test('the last rule has priority 1, a dropped rule leaves no gap, and the rest are dropped and counted', () => {
        const long = `"${'x'.repeat(256)}"`;
        const { xml, lost, conditionalFormatRules } = roundTrip({
            conditionalFormatRules: [
                condition('greaterThan', ['1']),
                { type: 'icons', cellrange: RANGE },
                condition('occurrenceDate', ['2026/01/01 - 2026/01/31']),
                condition('lessThan', ['0']),
                condition('duplicateValue', ['2']),
                { type: 'colorGradation', cellrange: RANGE, format: ['#FFFFFF', 'hsl(0, 50%, 50%)'] },
                { type: 'colorGradation', cellrange: RANGE, format: ['#FFFFFF'] },
                { type: 'dataBar', cellrange: RANGE, format: ['transparent'] },
                condition('formula', [`=LEN(B1)>${'1+'.repeat(4096)}1`]),
                condition('equal', ['x'.repeat(256)]),
                condition('textContains', ['x'.repeat(256)]),
                condition('formula', [`=B1=${long}`]),
                condition('equal', ['3']),
            ],
        });
        expect([...xml.matchAll(/priority="(\d+)"/g)].map(([, priority]) => priority)).toEqual(['3', '2', '1']);
        expect(conditionalFormatRules?.map((rule) => rule.type === 'default' && rule.conditionName)).toEqual([
            'greaterThan',
            'lessThan',
            'equal',
        ]);
        expect(lost).toEqual(Array(10).fill('conditional-formats-dropped'));
    });

    test('a sheet without rules writes nothing', () => {
        expect(roundTrip({}).xml).toBe('');
        expect(roundTrip({ conditionalFormatRules: [], dataVerification: {} }).xml).toBe('');
    });
});

const validation = (rule: Partial<DataVerificationRule>): DataVerificationRule => ({
    type: 'number',
    type2: 'between',
    value1: '1',
    value2: '10',
    prohibitInput: false,
    hintShow: false,
    hintValue: '',
    ...rule,
});

describe('a data validation', () => {
    test('each kind Excel holds reads back as itself', () => {
        const rules = [
            validation({ type: 'dropdown', type2: '', value1: 'Red,Green,"Blue"', value2: '' }),
            validation({ type: 'dropdown', type2: '', value1: "'My Sheet'!$A$1:$A$3", value2: '' }),
            validation({ type: 'number', type2: 'notBetween', value1: '-1.5', value2: '2.25' }),
            validation({ type: 'number_integer', type2: 'moreThanThe', value1: '5', value2: '' }),
            validation({ type: 'text_length', type2: 'lessThanOrEqualTo', value1: '12', value2: '' }),
            validation({ type: 'date', type2: 'between', value1: '2026-01-05', value2: '2026-12-31' }),
            validation({ type: 'date', type2: 'noEarlierThan', value1: '2026-01-05', value2: '' }),
            validation({ type: 'number', type2: 'equal', value1: '3', prohibitInput: true }),
            validation({
                type: 'number',
                type2: 'notEqualTo',
                value1: '3',
                hintShow: true,
                hintValue: 'Not "3" & <b>',
            }),
        ];
        const dataVerification = Object.fromEntries(rules.map((rule, row) => [`${row}_0`, rule]));
        const { lost, ...read } = roundTrip({ dataVerification });
        expect(lost).toEqual([]);
        expect(read.dataVerification).toEqual(
            Object.fromEntries(
                rules.map((rule, row) => [
                    `${row}_0`,
                    { ...rule, value2: rule.type2.endsWith('etween') ? rule.value2 : '' },
                ]),
            ),
        );
    });

    test("Excel's canonical forms: dates as serials, a list's range absolute, allowBlank, a prompt", () => {
        const { xml } = roundTrip({
            dataVerification: {
                '0_0': validation({ type: 'date', type2: 'between', value1: '2026-01-05', value2: '2026-12-31' }),
                '1_0': validation({
                    type: 'dropdown',
                    type2: '',
                    value1: 'Sheet2!A1:B3',
                    value2: '',
                    prohibitInput: true,
                }),
                '2_0': validation({
                    type: 'number_decimal',
                    type2: 'moreThanThe',
                    value1: '0.5',
                    hintShow: true,
                    hintValue: 'Over a half',
                }),
            },
        });
        expect(xml).toBe(
            '<dataValidations count="3">' +
                '<dataValidation type="date" allowBlank="1" sqref="A1"><formula1>46027</formula1><formula2>46387</formula2></dataValidation>' +
                '<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="A2"><formula1>Sheet2!$A$1:$B$3</formula1></dataValidation>' +
                '<dataValidation type="decimal" operator="greaterThan" allowBlank="1" showInputMessage="1" prompt="Over a half" sqref="A3"><formula1>0.5</formula1></dataValidation>' +
                '</dataValidations>',
        );
    });

    test("a rule's cells coalesce into rectangles, one element a rule, ordered by their first cell", () => {
        const list = validation({ type: 'dropdown', type2: '', value1: 'a,b', value2: '' });
        const number = validation({});
        const dataVerification: Record<string, DataVerificationRule> = {};
        // An L of the list: B2:C4 and B5, beside a column of numbers broken by a gap.
        for (let r = 1; r <= 3; r++) for (let c = 1; c <= 2; c++) dataVerification[`${r}_${c}`] = { ...list };
        dataVerification['4_1'] = { ...list };
        for (const r of [0, 1, 2, 5]) dataVerification[`${r}_4`] = { ...number };
        const { xml, ...read } = roundTrip({ dataVerification });
        expect([...xml.matchAll(/sqref="([^"]*)"/g)].map(([, sqref]) => sqref)).toEqual(['E1:E3 E6', 'B2:C4 B5']);
        expect(read.dataVerification).toEqual(dataVerification);
    });

    test('a tick-box text rule is a custom formula on the first cell; the reader drops custom rules', () => {
        const { xml, dataVerification, lost } = roundTrip({
            dataVerification: {
                '2_1': validation({ type: 'text_content', type2: 'include', value1: 'a"b', value2: '' }),
                '3_1': validation({ type: 'text_content', type2: 'include', value1: 'a"b', value2: '' }),
            },
        });
        expect(xml).toContain(
            '<dataValidation type="custom" allowBlank="1" sqref="B3:B4"><formula1>ISNUMBER(SEARCH(&quot;a&quot;&quot;b&quot;,B3))</formula1></dataValidation>',
        );
        expect(dataVerification).toBeUndefined();
        expect(lost).toEqual([]);
    });

    test('what Excel cannot hold is dropped, counted once a rule; a long prompt is cut and counted', () => {
        const checkbox = validation({ type: 'checkbox', type2: '', value1: 'TRUE', value2: 'FALSE' });
        const { dataVerification, lost } = roundTrip({
            dataVerification: {
                '0_0': checkbox,
                '1_0': { ...checkbox },
                '2_0': validation({ type: 'validity', type2: '', value1: 'phone', value2: '' }),
                '3_0': validation({ type: 'dropdown', type2: '', value1: 'x'.repeat(256), value2: '' }),
                '4_0': validation({ type: 'number', type2: 'between', value1: 'abc' }),
                '5_0': validation({ type: 'date', type2: 'laterThan', value1: 'soon', value2: '' }),
                '6_0': validation({ type: 'number', type2: 'include' }),
                '7_0': validation({ type: 'dropdown', type2: '', value1: 'x'.repeat(255), value2: '' }),
                '8_0': validation({ type: 'number', type2: 'equal', hintShow: true, hintValue: 'p'.repeat(300) }),
            },
        });
        expect(Object.keys(dataVerification ?? {})).toEqual(['7_0', '8_0']);
        expect(dataVerification?.['8_0']?.hintValue).toBe('p'.repeat(255));
        expect(lost).toEqual([...Array(6).fill('validations-dropped'), 'validation-prompts-cut']);
    });

    test('conditional formats come before validations, as CT_Worksheet orders them', () => {
        const { xml } = roundTrip({
            dataVerification: { '0_0': validation({}) },
            conditionalFormatRules: [condition('greaterThan', ['1'])],
        });
        expect(xml.indexOf('<conditionalFormatting')).toBe(0);
        expect(xml.indexOf('<dataValidations')).toBeGreaterThan(0);
    });
});
