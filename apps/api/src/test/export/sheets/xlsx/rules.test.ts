import { describe, expect, test } from 'bun:test';
import type {
    DataValidationRule,
    DefaultConditionalFormatRule,
    Sheet,
    SheetValidation,
    SingleRange,
} from '@workspace/lib/sheets';
import { MAX_RULE_RANGES, orderedRules, REFERENCE_ROW_COUNT } from '@workspace/lib/sheets';
import { generateNKeysBetween } from '@workspace/lib/vector';
import type { CountedWarningCode } from '../../../../lib/document/transform/protocol';
import { rulesXml } from '../../../../lib/export/sheets/xlsx/rules';
import { styleRegistry } from '../../../../lib/export/sheets/xlsx/styles';
import { readRules } from '../../../../lib/import/sheets/rules';
import { readDxfs } from '../../../../lib/import/sheets/styles';
import { parseOoxml } from '../../../../lib/ooxml/ooxml';
import { formatList, formatsOf, ruleAt, rulesByCell, validationsByCell } from '../../../fixtures/validations';
import { sheetXml } from '../../../fixtures/xlsx';

// A sheet's conditional formats and data validations, written and read back through the reader, with the dxfs the
// registry wrote.

function roundTrip(sheet: Partial<Sheet>) {
    const lost: CountedWarningCode[] = [];
    const styles = styleRegistry((code) => lost.push(code));
    const started = performance.now();
    const xml = rulesXml({ id: 'fixture', name: 'Sheet1', ...sheet }, styles, (code) => lost.push(code));
    const writeMs = performance.now() - started;
    const looks = readDxfs(parseOoxml(styles.xml()) ?? undefined, []);
    const read = readRules(parseOoxml(sheetXml({ after: xml })) ?? undefined, {
        dxfs: looks,
        palette: [],
        date1904: false,
        charge: () => {},
        chargeElements: () => {},
        lost: () => {},
        inline: (formula) => formula,
        dates: new Set(),
    });
    return { xml, lost, looks, writeMs, ...read, formats: formatList(read.conditionalFormats) };
}

type FormatList = ReturnType<typeof formatList>;

const RANGE: SingleRange[] = [{ row: [0, 4], column: [1, 1] }];
const RED = { textColor: '#9C0006', cellColor: '#FFC7CE' };

const condition = (
    conditionName: DefaultConditionalFormatRule['conditionName'],
    conditionValue: string[],
    format: DefaultConditionalFormatRule['format'] = RED,
    ranges = RANGE,
): FormatList[number] => ({
    type: 'default',
    ranges,
    format,
    conditionName,
    conditionRange: [],
    conditionValue,
});

describe('a conditional format', () => {
    // The exporter trusts the rule's shape (a malformed rule is dropped where it enters a workbook), but a well-typed
    // range can still lie outside Excel's grid.
    test('a range past the grid is cut to it, and a rule with none inside it is dropped and counted', () => {
        const rules: FormatList = [
            condition('greaterThan', ['1'], RED, []),
            condition('textContains', ['x'], RED, [{ row: [2_000_000, 2_000_001], column: [0, 0] }]),
            condition('greaterThan', ['1'], RED, [{ row: [4, 0], column: [1, 1] }]),
            condition('lessThan', ['5'], RED, [{ row: [1_048_570, 2_000_000], column: [16_380, 20_000] }]),
        ];
        const { xml, lost } = roundTrip({ conditionalFormats: formatsOf(rules) });
        expect(lost).toEqual(Array(3).fill('conditional-formats-dropped'));
        expect(xml).toBe(
            '<conditionalFormatting sqref="XFA1048571:XFD1048576"><cfRule type="cellIs" dxfId="0" priority="1" operator="lessThan"><formula>5</formula></cfRule></conditionalFormatting>',
        );
    });

    test('every rule kind the engine evaluates reads back as itself, in order', () => {
        const rules: FormatList = [
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
            { type: 'colorGradation', ranges: RANGE, format: ['#63BE7B', '#FFEB84', '#F8696B'] },
            { type: 'colorGradation', ranges: RANGE, format: ['#FFFFFF', '#5A8AC6'] },
            { type: 'dataBar', ranges: RANGE, format: ['#638EC6'] },
        ];
        const { formats, lost } = roundTrip({ conditionalFormats: formatsOf(rules) });
        expect(lost).toEqual([]);
        expect(formats).toEqual(rules);
    });

    test("Excel's canonical forms: the 2007 elements, a text rule's formula on its anchor, operands quoted", () => {
        const { xml } = roundTrip({
            conditionalFormats: formatsOf([
                condition('textContains', ['a"b'], RED, [
                    { row: [2, 8], column: [2, 2] },
                    { row: [0, 0], column: [0, 0] },
                ]),
                condition('equal', ['say "hi"']),
                condition('top10_percent', ['20']),
                condition('belowAverage', []),
                condition('duplicateValue', ['1']),
                { type: 'colorGradation', ranges: RANGE, format: ['rgb(99, 190, 123)', '#fff'] },
                { type: 'dataBar', ranges: RANGE, format: ['#638EC6'] },
            ]),
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
        const { xml, formats } = roundTrip({ conditionalFormats: formatsOf(rules) });
        expect(xml).toContain(
            '<cfRule type="expression" dxfId="0" priority="1"><formula>_xlfn.XLOOKUP(B1,A:A,C:C)&gt;0</formula>',
        );
        expect(formats).toEqual(rules);
    });

    test('equal looks share a dxf through the registry, and a rule without colors names none', () => {
        const { xml, looks, formats } = roundTrip({
            conditionalFormats: formatsOf([
                condition('greaterThan', ['1']),
                condition('lessThan', ['0'], { textColor: null, cellColor: '#00FF00' }),
                condition('equal', ['2']),
                condition('notEqual', ['3'], { textColor: null, cellColor: null }),
            ]),
        });
        expect(looks).toEqual([RED, { textColor: null, cellColor: '#00FF00' }]);
        expect([...xml.matchAll(/<cfRule [^>]*>/g)].map(([tag]) => tag.match(/dxfId="(\d+)"/)?.[1])).toEqual([
            '0',
            '1',
            '0',
            undefined,
        ]);
        expect(formats[3]).toMatchObject({ format: { textColor: null, cellColor: null } });
    });

    test('the last rule has priority 1, a dropped rule leaves no gap, and the rest are dropped and counted', () => {
        const long = `"${'x'.repeat(256)}"`;
        const { xml, lost, formats } = roundTrip({
            conditionalFormats: formatsOf([
                condition('greaterThan', ['1']),
                condition('occurrenceDate', ['2026/01/01 - 2026/01/31']),
                condition('lessThan', ['0']),
                condition('duplicateValue', ['2']),
                { type: 'colorGradation', ranges: RANGE, format: ['#FFFFFF', 'hsl(0, 50%, 50%)'] },
                { type: 'colorGradation', ranges: RANGE, format: ['#FFFFFF'] },
                { type: 'dataBar', ranges: RANGE, format: ['transparent'] },
                condition('formula', [`=LEN(B1)>${'1+'.repeat(4096)}1`]),
                condition('equal', ['x'.repeat(256)]),
                condition('textContains', ['x'.repeat(256)]),
                condition('formula', [`=B1=${long}`]),
                condition('equal', ['3']),
            ]),
        });
        expect([...xml.matchAll(/priority="(\d+)"/g)].map(([, priority]) => priority)).toEqual(['3', '2', '1']);
        expect(formats.map((rule) => rule.type === 'default' && rule.conditionName)).toEqual([
            'greaterThan',
            'lessThan',
            'equal',
        ]);
        expect(lost).toEqual(Array(9).fill('conditional-formats-dropped'));
    });

    test("a rule's order key decides its priority through the file and back, whatever its id", () => {
        const { xml, conditionalFormats } = roundTrip({
            conditionalFormats: {
                a: { ...condition('equal', ['3']), order: 'a2' },
                z: { ...condition('greaterThan', ['1']), order: 'a0' },
                m: { ...condition('lessThan', ['0']), order: 'a1' },
            },
        });
        expect([...xml.matchAll(/priority="(\d+)" operator="(\w+)"/g)].map(([, n, operator]) => [n, operator])).toEqual(
            [
                ['3', 'greaterThan'],
                ['2', 'lessThan'],
                ['1', 'equal'],
            ],
        );
        expect(
            orderedRules(conditionalFormats).map(([id, rule]) => [id, rule.type === 'default' && rule.conditionName]),
        ).toEqual([
            ['format-1', 'greaterThan'],
            ['format-2', 'lessThan'],
            ['format-3', 'equal'],
        ]);
    });

    test('a sheet without rules writes nothing', () => {
        expect(roundTrip({}).xml).toBe('');
        expect(roundTrip({ conditionalFormats: {}, dataValidations: {} }).xml).toBe('');
    });
});

// Validation rules from a list, the last in the list winning where they overlap: the ids validation-1 and on, each
// with the next order key, as the importer numbers them.
function numbered(rules: Pick<SheetValidation, 'ranges' | 'rule'>[]): Record<string, SheetValidation> {
    const orders = generateNKeysBetween(null, null, rules.length);
    return Object.fromEntries(rules.map((rule, i) => [`validation-${i + 1}`, { ...rule, order: orders[i] }]));
}

const validation = (rule: Partial<DataValidationRule>): DataValidationRule => ({
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
        const dataValidations = validationsByCell(Object.fromEntries(rules.map((rule, row) => [`${row}_0`, rule])));
        const { lost, ...read } = roundTrip({ dataValidations });
        expect(lost).toEqual([]);
        expect(rulesByCell(read.dataValidations)).toEqual(
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
            dataValidations: validationsByCell({
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
            }),
        });
        expect(xml).toBe(
            '<dataValidations count="3">' +
                '<dataValidation type="date" allowBlank="1" sqref="A1"><formula1>46027</formula1><formula2>46387</formula2></dataValidation>' +
                '<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="A2"><formula1>Sheet2!$A$1:$B$3</formula1></dataValidation>' +
                '<dataValidation type="decimal" operator="greaterThan" allowBlank="1" showInputMessage="1" prompt="Over a half" sqref="A3"><formula1>0.5</formula1></dataValidation>' +
                '</dataValidations>',
        );
    });

    test('one element a rule over its ranges, the ranges and the rules in order of their top-left cells', () => {
        const list = validation({ type: 'dropdown', type2: '', value1: 'a,b', value2: '' });
        const number = validation({});
        // An L of the list, B5 and B2:C4, beside a column of numbers broken by a gap.
        const dataValidations = {
            list: {
                ranges: [
                    { row: [4, 4], column: [1, 1] },
                    { row: [1, 3], column: [1, 2] },
                ],
                order: 'a0',
                rule: list,
            },
            numbers: {
                ranges: [
                    { row: [0, 2], column: [4, 4] },
                    { row: [5, 5], column: [4, 4] },
                ],
                order: 'a1',
                rule: number,
            },
        };
        const { xml, ...read } = roundTrip({ dataValidations });
        expect([...xml.matchAll(/sqref="([^"]*)"/g)].map(([, sqref]) => sqref)).toEqual(['E1:E3 E6', 'B2:C4 B5']);
        expect(rulesByCell(read.dataValidations)).toEqual(rulesByCell(dataValidations));
    });

    // Where rules overlap the last in order wins, and a file read back numbers its rules in the file's order. So the
    // export cuts each rule out of the cells a later rule holds, and no two sqrefs overlap.
    test('rules that overlap keep the winner of every cell through the file and back', () => {
        const wide = validation({ type: 'dropdown', type2: '', value1: 'a,b', value2: '' });
        const inside = validation({ type: 'dropdown', type2: '', value1: 'x,y', value2: '' });
        const dataValidations = numbered([
            { ranges: [{ row: [5, 6], column: [1, 2] }], rule: inside },
            { ranges: [{ row: [0, 9], column: [0, 1] }], rule: wide },
        ]);
        const { xml, ...read } = roundTrip({ dataValidations });
        expect([...xml.matchAll(/sqref="([^"]*)"/g)].map(([, sqref]) => sqref)).toEqual(['A1:B10', 'C6:C7']);
        for (let r = 0; r < 10; r += 1) {
            for (let c = 0; c < 3; c += 1) {
                expect(ruleAt(read.dataValidations, r, c)).toEqual(ruleAt(dataValidations, r, c));
            }
        }
    });

    // Many small ranges over many others, every pair close, which a check per pair made take seconds.
    test('two rules of as many ranges as a rule may hold, close together, cut in a moment and read back', () => {
        const list = validation({ type: 'dropdown', type2: '', value1: 'a,b', value2: '' });
        const cells = (from: number) =>
            Array.from({ length: MAX_RULE_RANGES }, (_, i) => ({
                row: [from + 2 * i, from + 2 * i],
                column: [1, 1],
            }));
        const dataValidations = numbered([
            { ranges: cells(0), rule: list },
            { ranges: cells(1), rule: list },
        ]);
        const started = performance.now();
        const { lost, ...read } = roundTrip({ dataValidations });
        expect(performance.now() - started).toBeLessThan(1000);
        expect(lost).toEqual([]);
        for (const r of [0, 1, 2 * MAX_RULE_RANGES - 1]) {
            expect(ruleAt(read.dataValidations, r, 1)).toEqual(ruleAt(dataValidations, r, 1));
        }
    });

    // Every rule's ranges spread over the rows of all the others, so each rule is near every range of every higher one,
    // which a check of each rule against those ranges made take seconds.
    test('as many rules as a sheet may hold, spread over each other, cut in a moment and read back', () => {
        const list = validation({ type: 'dropdown', type2: '', value1: 'a,b', value2: '' });
        const count = 1024;
        const dataValidations = numbered(
            Array.from({ length: count }, (_, k) => ({
                ranges: Array.from({ length: 64 }, (_, i) => ({
                    row: [count * i + k, count * i + k],
                    column: [1, 1],
                })),
                rule: list,
            })),
        );
        const started = performance.now();
        const { lost, ...read } = roundTrip({ dataValidations });
        expect(performance.now() - started).toBeLessThan(1000);
        expect(lost).toEqual([]);
        for (const r of [0, count - 1, count * 64 - 1]) {
            expect(ruleAt(read.dataValidations, r, 1)).toEqual(ruleAt(dataValidations, r, 1));
        }
    });

    // Each rule in a band of rows of its own, with as many ranges as a rule may hold side by side, so a lookup that
    // walks a rule's own ranges, or every range above it, takes most of a minute.
    const bandList = (height: number) =>
        Array.from({ length: 64 }, (_, k) => ({
            ranges: Array.from({ length: MAX_RULE_RANGES }, (_, i) => ({
                row: [height * k, height * k + height - 1],
                column: [i, i],
            })),
            rule: validation({ type: 'dropdown', type2: '', value1: 'a,b', value2: '' }),
        }));

    // Each rule's ranges as the file lists them, in the file's order of rules.
    const sqrefs = (xml: string) => [...xml.matchAll(/ sqref="([^"]*)"/g)].map(([, sqref]) => sqref.split(' '));

    test('many rules of many ranges, each in a band of its own, are kept whole in a moment', () => {
        for (const height of [64, 16384]) {
            const { xml, lost, writeMs } = roundTrip({ dataValidations: numbered(bandList(height)) });
            expect(writeMs).toBeLessThan(2000);
            expect(lost).toEqual([]);
            const written = sqrefs(xml);
            expect(written.map((ranges) => ranges.length)).toEqual(Array(64).fill(MAX_RULE_RANGES));
            expect(written.map(([first]) => first)).toEqual(
                Array.from({ length: 64 }, (_, k) => `A${height * k + 1}:A${height * k + height}`),
            );
        }
    }, 30_000);

    test('many rules of many ranges, each in a band a higher rule touches once, are cut in a moment', () => {
        const dataValidations = numbered([
            ...bandList(64),
            {
                ranges: Array.from({ length: 64 }, (_, k) => ({ row: [64 * k, 64 * k], column: [0, 0] })),
                rule: validation({ type: 'dropdown', type2: '', value1: 'x', value2: '' }),
            },
        ]);
        const { lost, writeMs, ...kept } = roundTrip({ dataValidations });
        expect(writeMs).toBeLessThan(2000);
        expect(lost).toEqual([]);
        for (const [r, c] of [
            [0, 0],
            [1, 0],
            [0, 1],
            [64 * 63, 0],
            [64 * 63 + 63, MAX_RULE_RANGES - 1],
        ]) {
            expect(ruleAt(kept.dataValidations, r, c)).toEqual(ruleAt(dataValidations, r, c));
        }
    }, 30_000);

    // Whole rows, each rule's a row in every band of 64, so each range covers too many square tiles to keep in them.
    // A lookup that checks every such range against every other takes most of a minute.
    test('many rules of whole rows, interleaved, are kept whole in a moment', () => {
        const dataValidations = numbered(
            Array.from({ length: 64 }, (_, k) => ({
                ranges: Array.from({ length: 2048 }, (_, i) => ({
                    row: [64 * i + k, 64 * i + k],
                    column: [0, 16383],
                })),
                rule: validation({ type: 'dropdown', type2: '', value1: 'a,b', value2: '' }),
            })),
        );
        const { xml, lost, writeMs } = roundTrip({ dataValidations });
        expect(writeMs).toBeLessThan(2000);
        expect(lost).toEqual([]);
        expect(sqrefs(xml).map((ranges) => ranges.length)).toEqual(Array(64).fill(2048));
    }, 30_000);

    // A whole column sits in the index's grid of tall bands, while single cells sit in its square tiles and a whole row
    // in its wide bands. A lookup must find the overlaps across grids both ways: a column under higher cells and rows,
    // and cells and a row under a higher column.
    test('whole columns cut and are cut by cells and rows kept in the other grids', () => {
        const rule = (value1: string) => validation({ type: 'dropdown', type2: '', value1, value2: '' });
        const column = (c: number) => ({ row: [0, REFERENCE_ROW_COUNT - 1], column: [c, c] });
        const row = (r: number) => ({ row: [r, r], column: [0, 16383] });
        const cell = (r: number, c: number) => ({ row: [r, r], column: [c, c] });
        const dataValidations = numbered([
            { ranges: [cell(19, 1), cell(19, 2), cell(29, 3), row(39)], rule: rule('bottom') },
            { ranges: [column(1), column(3)], rule: rule('columns') },
            { ranges: [cell(2, 1), row(9), cell(70_000, 3)], rule: rule('top') },
        ]);
        const { lost, dataValidations: kept = {} } = roundTrip({ dataValidations });
        expect(lost).toEqual([]);
        const rows = [0, 2, 9, 19, 29, 39, 70_000, REFERENCE_ROW_COUNT - 1];
        for (const r of rows) {
            for (const c of [0, 1, 2, 3, 4, 16383]) {
                const covering = Object.values(kept).filter(({ ranges }) =>
                    ranges.some(({ row, column }) => r >= row[0] && r <= row[1] && c >= column[0] && c <= column[1]),
                );
                expect(covering.length).toBeLessThanOrEqual(1);
                expect(ruleAt(kept, r, c)).toEqual(ruleAt(dataValidations, r, c));
            }
        }
    });

    // A cut can split each of a rule's ranges in two, and the importer drops a rule of more ranges than a rule may
    // hold. So the export joins what it cut, and drops and counts a rule still past the cap.
    test('a rule the cuts leave with more ranges than a rule may hold is dropped and counted', () => {
        const list = validation({ type: 'dropdown', type2: '', value1: 'a,b', value2: '' });
        const rows = Array.from({ length: MAX_RULE_RANGES }, (_, r) => ({ row: [r, r], column: [0, 9] }));
        const cuts = Array.from({ length: MAX_RULE_RANGES }, (_, i) => ({ row: [2 * i, 2 * i], column: [4, 4] }));
        const column = [{ row: [0, 2 * MAX_RULE_RANGES - 1], column: [4, 4] }];
        const cut = roundTrip({
            dataValidations: numbered([
                { ranges: rows, rule: list },
                { ranges: cuts, rule: list },
            ]),
        });
        expect(cut.lost).toEqual(['validations-dropped']);
        expect(Object.keys(cut.dataValidations ?? {})).toHaveLength(1);
        const rejoined = roundTrip({
            dataValidations: numbered([
                { ranges: rows, rule: list },
                { ranges: column, rule: list },
            ]),
        });
        expect(rejoined.lost).toEqual([]);
        expect(rejoined.xml).toContain('sqref="A1:D8192 F1:J8192"');
    });

    test('a whole-column rule writes the whole column, and reads back as one', () => {
        const list = validation({ type: 'dropdown', type2: '', value1: 'a,b', value2: '' });
        const ranges = [{ row: [0, REFERENCE_ROW_COUNT - 1], column: [1, 1] }];
        const { xml, ...read } = roundTrip({ dataValidations: { v: { ranges, order: 'a0', rule: list } } });
        expect(xml).toContain(`sqref="B1:B${REFERENCE_ROW_COUNT}"`);
        expect(Object.values(read.dataValidations ?? {})).toEqual([{ ranges, order: 'a0', rule: list }]);
    });

    test('a text rule is a custom formula on the first cell; the reader drops custom rules', () => {
        const { xml, dataValidations, lost } = roundTrip({
            dataValidations: {
                v: {
                    ranges: [{ row: [2, 3], column: [1, 1] }],
                    order: 'a0',
                    rule: validation({ type: 'text_content', type2: 'include', value1: 'a"b', value2: '' }),
                },
            },
        });
        expect(xml).toContain(
            '<dataValidation type="custom" allowBlank="1" sqref="B3:B4"><formula1>ISNUMBER(SEARCH(&quot;a&quot;&quot;b&quot;,B3))</formula1></dataValidation>',
        );
        expect(dataValidations).toBeUndefined();
        expect(lost).toEqual([]);
    });

    test('what Excel cannot hold is dropped, counted once a rule; a long prompt is cut and counted', () => {
        const checkbox = validation({ type: 'checkbox', type2: '', value1: 'TRUE', value2: 'FALSE' });
        const { dataValidations, lost } = roundTrip({
            dataValidations: {
                ...validationsByCell({
                    '2_0': validation({ type: 'validity', type2: '', value1: 'phone', value2: '' }),
                    '3_0': validation({ type: 'dropdown', type2: '', value1: 'x'.repeat(256), value2: '' }),
                    '4_0': validation({ type: 'number', type2: 'between', value1: 'abc' }),
                    '5_0': validation({ type: 'date', type2: 'laterThan', value1: 'soon', value2: '' }),
                    '6_0': validation({ type: 'number', type2: 'include' }),
                    '7_0': validation({ type: 'dropdown', type2: '', value1: 'x'.repeat(255), value2: '' }),
                    '8_0': validation({ type: 'number', type2: 'equal', hintShow: true, hintValue: 'p'.repeat(300) }),
                    // Shaped like a cell past Excel's last column: a defined name an older import kept.
                    '9_0': validation({ type: 'dropdown', type2: '', value1: 'UkRegion2', value2: '' }),
                }),
                ticks: { ranges: [{ row: [0, 1], column: [0, 0] }], order: 'a0', rule: checkbox },
            },
        });
        const kept = rulesByCell(dataValidations);
        expect(Object.keys(kept)).toEqual(['7_0', '8_0']);
        expect(kept['8_0']?.hintValue).toBe('p'.repeat(255));
        expect(lost).toEqual([
            ...Array(6).fill('validations-dropped'),
            'validation-prompts-cut',
            'validations-dropped',
        ]);
    });

    test("a prompt is cut before a surrogate pair's halves, never between them", () => {
        const prompt = `${'p'.repeat(254)}😀`;
        const { xml, dataValidations, lost } = roundTrip({
            dataValidations: validationsByCell({
                '0_0': validation({ type: 'number', type2: 'equal', hintShow: true, hintValue: prompt }),
            }),
        });
        expect(rulesByCell(dataValidations)['0_0']?.hintValue).toBe('p'.repeat(254));
        expect(xml).not.toContain('&#xD83D;');
        expect(lost).toEqual(['validation-prompts-cut']);
    });

    test('conditional formats come before validations, as CT_Worksheet orders them', () => {
        const { xml } = roundTrip({
            dataValidations: validationsByCell({ '0_0': validation({}) }),
            conditionalFormats: formatsOf([condition('greaterThan', ['1'])]),
        });
        expect(xml.indexOf('<conditionalFormatting')).toBe(0);
        expect(xml.indexOf('<dataValidations')).toBeGreaterThan(0);
    });
});
