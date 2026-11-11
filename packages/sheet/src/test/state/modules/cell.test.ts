// A rule that prohibits input reads a commit as the write will, and text the editor was seeded with changes nothing.
describe('state/modules/cell — updateCell under a prohibiting rule', () => {
    function commit(rule: DataValidationRule, cell: Cell | null, text: string) {
        const data: CellMatrix = [[cell]];
        const dataValidations = validationsByCell({ '0_0': { ...rule, prohibitInput: true } });
        const ctx = workbookContextFactory({
            currentSheetId: 'id_1',
            sheets: [{ name: 'sheet', id: 'id_1', order: 0, data, dataValidations }],
        });
        const input = document.createElement('div');
        input.innerText = text;
        updateCell(ctx, 0, 0, input);
        return { warned: ctx.warnDialog, written: data[0][0] };
    }
    const rule = (type: string, type2: string, value1: string): DataValidationRule => ({
        type,
        type2,
        value1,
        value2: '',
    });

    test('a date shown as dd/MM/yyyy commits unchanged', () => {
        const date = { v: 45306, m: '15/01/2024', ct: { fa: 'dd/MM/yyyy', t: 'd' } };
        const { warned, written } = commit(rule('date', 'laterThan', '2020-01-01'), date, '15/01/2024');
        expect(warned).toBeUndefined();
        expect(written?.v).toBe(45306);
    });

    test('an unchanged formula, and Enter on an empty cell, are no input', () => {
        const formula = { v: 3, m: '3', f: '=1+2' };
        expect(commit(rule('number', 'lessThan', '1'), formula, '=1+2').warned).toBeUndefined();
        expect(commit(rule('number', 'lessThan', '1'), null, '').warned).toBeUndefined();
    });

    test('typed text is read as the write reads it', () => {
        expect(commit(rule('number', 'moreThanThe', '1000'), null, '1,234.50').written?.v).toBe(1234.5);
        expect(commit(rule('number', 'lessThan', '1'), null, '50%').written?.v).toBe(0.5);
        expect(commit(rule('date', 'laterThan', '2020-01-01'), null, '2024-06-15').warned).toBeUndefined();
    });

    test('a value that fails is refused, and the cell keeps its own', () => {
        const number = { v: 5, m: '5' };
        const { warned, written } = commit(rule('number', 'moreThanThe', '3'), number, '2');
        expect(warned).toBe('Input must be a number greater than 3.');
        expect(written?.v).toBe(5);
        expect(commit(rule('date', 'laterThan', '2020-01-01'), null, '15/01/2024').warned).toContain('Date must be');
    });
});

// Cell text is a schemaless CRDT string — authored by any collaborator, or carried
// in from an uploaded xlsx — and getInlineStringHTML writes it into the formula bar
// and the in-cell editor through innerHTML. The package used to guard those writes
// with its own escapeHTMLTag, which handed back anything starting with `<span` or
// `=` unescaped: a stored-XSS vector against every viewer, read-only included.
// escapeHtml itself is pinned in packages/lib/src/test/core/html.test.ts.

import { describe, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';
import { applyPatches, enablePatches, produce, produceWithPatches } from 'immer';
import { evaluateConditionalFormat } from '../../../engine/conditional-format';
import type { CellType } from '../../../engine/types';
import type { Context } from '../../../state/context';
import {
    getCellValue,
    getFormulaHtml,
    getInlineStringHTML,
    normalizedCellAttr,
    setCellValue,
    updateCell,
} from '../../../state/modules/cell';
import { clearMeasureTextCache } from '../../../state/modules/text';
import type { Cell, CellMatrix, DataValidationRule, SheetConfig } from '../../../state/types';
import { filterPatch } from '../../../state/utils/patch';
import { contextFactory, workbookContextFactory } from '../factories/context';
import { stubMeasuringCanvas } from '../factories/measuring-canvas';
import { formatsOf, validationsByCell } from '../factories/validations';

enablePatches();

// The auto-height tests below commit through a real editor element.
const win = installHappyDom();
stubMeasuringCanvas(win);

describe('state/modules/cell — getInlineStringHTML', () => {
    function inlineCell(runs: { v: string; fc?: string }[]): CellMatrix {
        return [[{ ct: { t: 'inlineStr', fa: 'General', s: runs } }]] as unknown as CellMatrix;
    }

    test('escapes the text of each rich-text run', () => {
        const html = getInlineStringHTML(0, 0, inlineCell([{ v: '<img src=q onerror=alert(1)>' }]));
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img src=q onerror=alert(1)&gt;');
    });

    test('a style value cannot close its own attribute', () => {
        // `fc` comes from the cell, so a color like `red' onload='alert(1)` would otherwise
        // end the style attribute and start an event handler. Stripping quotes leaves the
        // text inert inside the value; what matters is that nothing can escape the quotes.
        const html = getInlineStringHTML(0, 0, inlineCell([{ v: 'x', fc: "red' onload='alert(1)" }]));
        const styleValue = /style="([^"]*)"/.exec(html)?.[1];
        expect(styleValue).toBeDefined();
        expect(styleValue).not.toMatch(/['"<>]/);
    });
});

// getCellValue returns the attribute it is asked for, and getFormulaHtml is where the
// formula becomes colored spans. They were one function until a shipped regression:
// an escaping pass wrapped what read as a plain attribute read, and printed the markup
// at the user instead of rendering it.
describe('state/modules/cell — getCellValue / getFormulaHtml', () => {
    const formula = '=IFERROR((D37/E37),"No input yet")';
    const data = [
        [
            { f: formula, v: 'No input yet', m: 'No input yet' },
            { v: 42, m: '42' },
        ],
    ] as CellMatrix;

    test("getCellValue(…, 'f') returns the formula, not markup", () => {
        expect(getCellValue(0, 0, data, 'f')).toBe(formula);
    });

    test("getCellValue(…, 'f') is null on a cell with no formula, not its value", () => {
        expect(getCellValue(0, 1, data, 'f')).toBeNull();
    });

    test("getCellValue(…, 'f') on a date cell is its formula, and 'v' and 'm' its date", () => {
        const dated = [[{ f: '=DATE(2026,1,4)', v: 46026, m: '04/01/2026', ct: { fa: 'dd/MM/yyyy', t: 'd' } }]];
        expect(getCellValue(0, 0, dated, 'f')).toBe('=DATE(2026,1,4)');
        expect(getCellValue(0, 0, dated)).toBe('04/01/2026');
        expect(getCellValue(0, 0, dated, 'm')).toBe('04/01/2026');
    });

    test('getFormulaHtml renders the formula as coloured spans', () => {
        const html = getFormulaHtml(0, 0, data);
        expect(html).toStartWith('<span');
        expect(html).toContain('sheet-formula-text-func');
    });

    test('getFormulaHtml is null on a cell with no formula', () => {
        expect(getFormulaHtml(0, 1, data)).toBeNull();
    });

    test('its text content is the formula, so it renders unescaped safely', () => {
        const rendered = document.createElement('div');
        rendered.innerHTML = getFormulaHtml(0, 0, data) ?? '';
        expect(rendered.textContent).toBe(formula);
    });
});

// Committing multi-line text into a cell grows the row to fit it. The grown height has to
// land on the sheet's config — that is what calcRowColSize measures from and what syncs —
// or the row keeps its old height and the text stays clipped. Driving updateCell through
// produceWithPatches is what exposes a write that never lands.
describe('state/modules/cell — updateCell auto-height', () => {
    // The commit path handleGlobalEnter takes: the editor's text, newlines and all.
    function multilineInput(): HTMLDivElement {
        const input = win.document.createElement('div');
        input.innerHTML = 'line one\nline two\nline three';
        return input as unknown as HTMLDivElement;
    }

    function editContext(): Context {
        const config: SheetConfig = { columnlen: { 0: 40 } };
        const ctx = contextFactory({ config }) as Context;
        ctx.sheets[0].data = [
            [{ v: 'x', m: 'x', ct: { fa: 'General', t: 'g' } }, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
            [null, null, null, null],
        ];
        ctx.defaultrowlen = 19;
        ctx.defaultcollen = 73;
        return ctx;
    }

    test('the grown row height lands on the sheet the grid measures from', () => {
        clearMeasureTextCache();
        const [grown] = produceWithPatches(editContext(), (ctx: Context) => {
            updateCell(ctx, 0, 0, multilineInput());
        });

        expect(grown.sheets[0].config?.rowlen?.[0]).toBeGreaterThan(19);
    });

    test('a merged cell leaves its row alone, as its text fits the merge and not its first column', () => {
        clearMeasureTextCache();
        const base = editContext();
        const [next] = produceWithPatches(base, (ctx: Context) => {
            const cell = ctx.sheets[0].data?.[0][0];
            if (cell) cell.mc = { r: 0, c: 0, rs: 1, cs: 4 };
            updateCell(ctx, 0, 0, multilineInput());
        });

        expect(next.sheets[0].config?.rowlen?.[0]).toBeUndefined();
    });

    test('and still syncs, because the patch that survives filterPatch carries it', () => {
        clearMeasureTextCache();
        const base = editContext();
        const [grown, patches] = produceWithPatches(base, (ctx: Context) => {
            updateCell(ctx, 0, 0, multilineInput());
        });

        const synced = applyPatches(base, filterPatch(patches));
        expect(synced.sheets[0].config?.rowlen?.[0]).toBe(grown.sheets[0].config?.rowlen?.[0]);
    });

    test('a rich edit recomputes the formulas that read the cell', () => {
        const ctx = editContext();
        ctx.sheets[0].data![0][0] = { ct: { fa: 'General', t: 'inlineStr', s: [{ v: 'Cherry', bl: 1 }] } };
        updateCell(ctx, 0, 1, null, '=A1&"!"');
        expect(ctx.sheets[0].data![0][1]?.v).toBe('Cherry!');
        const input = win.document.createElement('div');
        input.innerHTML = '<span style="font-weight: bold;">Kiwi</span>';
        updateCell(ctx, 0, 0, input as unknown as HTMLDivElement);
        expect(ctx.sheets[0].data![0][0]?.ct?.t).toBe('inlineStr');
        expect(ctx.sheets[0].data![0][1]?.v).toBe('Kiwi!');
    });
});

describe('state/modules/cell — setCellValue typed numbers', () => {
    function typed(text: string) {
        const ctx = contextFactory({}) as Context;
        const data: CellMatrix = [[null]];
        setCellValue(ctx, 0, 0, data, text);
        return data[0][0];
    }

    test("a typed number shows Excel's default-width General", () => {
        expect(typed('123456789012')).toMatchObject({ m: '1.23457E+11', ct: { fa: 'General', t: 'n' } });
        expect(typed('1234567.891234')?.m).toBe('1234567.891');
    });

    test('a typed number is stored as a number', () => {
        expect(typed('28254')?.v).toBe(28254);
        expect(typed('.75')?.v).toBe(0.75);
        expect(typed('000')?.v).toBe(0);
    });

    test('a radix prefix or Infinity stays text, as in Excel', () => {
        expect(typed('0x10')).toMatchObject({ v: '0x10', ct: { t: 'g' } });
        expect(typed('Infinity')).toMatchObject({ v: 'Infinity', ct: { t: 'g' } });

        const ctx = contextFactory({}) as Context;
        const data: CellMatrix = [[{ ct: { fa: '0.00', t: 'n' } }]];
        setCellValue(ctx, 0, 0, data, '0x10');
        expect(data[0][0]?.v).toBe('0x10');
    });

    test('a number typed into a text-formatted cell stays a string', () => {
        const ctx = contextFactory({}) as Context;
        const data: CellMatrix = [[{ ct: { fa: '@', t: 's' } }]];
        setCellValue(ctx, 0, 0, data, '28254');
        expect(data[0][0]?.v).toBe('28254');
    });

    // Excel keeps #N/A typed into a text-formatted cell as text, so a formula reading it sees no error.
    test('an error typed into a text-formatted cell stays text', () => {
        const ctx = contextFactory({}) as Context;
        const data: CellMatrix = [[{ ct: { fa: '@', t: 's' } }, { ct: { fa: '@', t: 's' }, f: '=1/0' }]];
        setCellValue(ctx, 0, 0, data, '#N/A');
        expect(data[0][0]).toMatchObject({ v: '#N/A', m: '#N/A', ct: { fa: '@', t: 's' } });
        setCellValue(ctx, 0, 1, data, '#DIV/0!');
        expect(data[0][1]?.ct?.t).toBe('e');
    });

    test('a typed number matches a greater-than conditional format', () => {
        const data: CellMatrix = [[typed('50') ?? null]];
        const styles = evaluateConditionalFormat(
            formatsOf([
                {
                    type: 'default',
                    ranges: [{ row: [0, 0], column: [0, 0] }],
                    format: { cellColor: '#ff0000' },
                    conditionName: 'greaterThan',
                    conditionRange: [],
                    conditionValue: ['10'],
                },
            ]),
            data,
        );
        expect(styles['0_0']?.cellColor).toBe('#ff0000');
    });
});

// Excel's General alignment: a cell without its own puts numbers and dates right, booleans and errors centred, text
// left (ht 0 centre, 1 left, 2 right).
describe('state/modules/cell — normalizedCellAttr General alignment', () => {
    function typed(text: string) {
        const ctx = contextFactory({}) as Context;
        const data: CellMatrix = [[null]];
        setCellValue(ctx, 0, 0, data, text);
        return data[0][0] ?? {};
    }

    test('numbers and dates go right, booleans and errors centre, text left', () => {
        expect(['42', '12%', '2024-01-05', '1,000.50'].map((text) => normalizedCellAttr(typed(text), 'ht'))).toEqual([
            '2',
            '2',
            '2',
            '2',
        ]);
        expect(['TRUE', '#N/A'].map((text) => normalizedCellAttr(typed(text), 'ht'))).toEqual(['0', '0']);
        expect(['abc', "'42", '0x10'].map((text) => normalizedCellAttr(typed(text), 'ht'))).toEqual(['1', '1', '1']);
        expect(normalizedCellAttr({ v: '#DIV/0!', m: '#DIV/0!', ct: { fa: 'General', t: 's' } }, 'ht')).toBe('0');
    });

    test("a cell's own alignment wins", () => {
        expect(normalizedCellAttr({ ...typed('42'), ht: 1 }, 'ht')).toBe('1');
        expect(normalizedCellAttr({ ...typed('abc'), ht: 0 }, 'ht')).toBe('0');
    });
});

describe('state/modules/cell — setCellValue formula results', () => {
    function computed(v: string | number | boolean, ct?: CellType) {
        const ctx = contextFactory({}) as Context;
        const data: CellMatrix = [[ct ? { ct } : null]];
        setCellValue(ctx, 0, 0, data, { f: '=X', v });
        return data[0][0];
    }

    test('a text result stays text, as server recalc stores it', () => {
        expect(computed('005')).toMatchObject({ v: '005', m: '005' });
        expect(computed('23')).toMatchObject({ v: '23', m: '23' });
        expect(computed('0x10')?.v).toBe('0x10');
        expect(computed('2024-05-06', { fa: 'yyyy-mm-dd', t: 'd' })).toMatchObject({
            v: '2024-05-06',
            m: '2024-05-06',
        });
    });

    test('an empty-text result is stored, and a blank one holds no value and no type its last one left', () => {
        expect(computed('')).toMatchObject({ v: '', m: '', ct: { fa: 'General', t: 'g' } });
        const ctx = contextFactory({}) as Context;
        const data: CellMatrix = [[{ f: '=X', v: '#N/A', m: '#N/A', ct: { fa: 'General', t: 'e' } }]];
        setCellValue(ctx, 0, 0, data, { f: '=X' });
        expect(data[0][0]).toEqual({ f: '=X', ct: { fa: 'General', t: 'g' } });
    });

    test('a number result stays a number in the cell format', () => {
        expect(computed(2)).toMatchObject({ v: 2, m: '2', ct: { fa: 'General', t: 'n' } });
        expect(computed(0.5, { fa: '0.00', t: 'n' })).toMatchObject({ v: 0.5, m: '0.50' });
    });

    test.each<[string, CellType | undefined, string | number | boolean, Partial<Cell>]>([
        ['text after a number', { fa: 'General', t: 'n' }, '005', { m: '005', ct: { fa: 'General', t: 'g' } }],
        ['text after an error', { fa: 'General', t: 'e' }, 'ok', { m: 'ok', ct: { fa: 'General', t: 'g' } }],
        ['a number after an error', { fa: 'General', t: 'e' }, 5, { m: '5', ct: { fa: 'General', t: 'n' } }],
        ['a number after text', { fa: 'General', t: 'g' }, 5, { m: '5', ct: { fa: 'General', t: 'n' } }],
        ['a boolean after a number', { fa: 'General', t: 'n' }, true, { m: 'TRUE', ct: { fa: 'General', t: 'b' } }],
        ['a number after a boolean', { fa: 'General', t: 'b' }, 5, { m: '5', ct: { fa: 'General', t: 'n' } }],
        ['an error after a number', { fa: 'General', t: 'n' }, '#N/A', { m: '#N/A', ct: { fa: 'General', t: 'e' } }],
    ])('its type follows the result: %s', (_, ct, v, expected) => {
        expect(computed(v, ct)).toMatchObject({ v, ...expected });
    });

    // A person chose the format, so it outlives every result, and the next number shows in it again.
    test.each<[string, CellType, string | number | boolean, Partial<Cell>]>([
        ['text', { fa: '0.00', t: 'n' }, 'none', { m: 'none', ct: { fa: '0.00', t: 'g' } }],
        ['an error', { fa: '0.00', t: 'n' }, '#N/A', { m: '#N/A', ct: { fa: '0.00', t: 'e' } }],
        ['a boolean', { fa: '0.00', t: 'n' }, false, { m: 'FALSE', ct: { fa: '0.00', t: 'b' } }],
        ['a number after text', { fa: '0.00', t: 'g' }, 2, { m: '2.00', ct: { fa: '0.00', t: 'n' } }],
        ['a number after an error', { fa: '0.00', t: 'e' }, 2, { m: '2.00', ct: { fa: '0.00', t: 'n' } }],
        ['a number after a boolean', { fa: '0.00', t: 'b' }, 2, { m: '2.00', ct: { fa: '0.00', t: 'n' } }],
        ['a date format after text', { fa: 'yyyy-mm-dd', t: 'g' }, 46027, { ct: { fa: 'yyyy-mm-dd', t: 'd' } }],
        ['a date format after a date', { fa: 'yyyy-mm-dd', t: 'd' }, 46027, { ct: { fa: 'yyyy-mm-dd', t: 'd' } }],
        ['text in a date format', { fa: 'yyyy-mm-dd', t: 'd' }, 'none', { ct: { fa: 'yyyy-mm-dd', t: 'g' } }],
        ['a text format keeps its type', { fa: '@', t: 'e' }, 'ok', { ct: { fa: '@', t: 's' } }],
        ['a number in a text format', { fa: '@', t: 's' }, 5, { ct: { fa: '@', t: 's' } }],
        ['an error in a text format', { fa: '@', t: 's' }, '#N/A', { ct: { fa: '@', t: 'e' } }],
    ])('its format stays: %s', (_, ct, v, expected) => {
        expect(computed(v, ct)).toMatchObject({ v, ...expected });
    });

    test('a formula reads the text another formula turned to, not the number it was', () => {
        let next = workbookContextFactory({
            currentSheetId: 's1',
            sheets: [{ id: 's1', name: 'One', data: [Array.from({ length: 4 }, () => null)] }],
        });
        const edit = (c: number, value: string) => {
            next = produce(next, (draft: Context) => {
                draft.selections = [{ row: [0, 0], column: [c, c], row_focus: 0, column_focus: c }];
                updateCell(draft, 0, c, null, value);
            });
        };
        const at = (c: number) => next.sheets[0].data?.[0][c];
        edit(0, '0');
        edit(1, '=IF(A1>0,TEXT(A1,"000"),0)');
        edit(2, '=B1&D1');
        expect(at(1)?.ct?.t).toBe('n');
        edit(0, '5');
        expect(at(1)).toMatchObject({ v: '005', ct: { t: 'g' } });
        edit(3, 'x');
        expect(at(2)?.v).toBe('005x');
        edit(3, 'y');
        expect(at(2)?.v).toBe('005y');
    });
});
