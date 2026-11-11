import { describe, expect, test } from 'bun:test';
import type { Sheet } from '@workspace/lib/sheets';
import type { CountedWarningCode } from '../../../../lib/document/transform/protocol';
import { sharedStringTable } from '../../../../lib/export/sheets/xlsx/strings';
import { styleRegistry } from '../../../../lib/export/sheets/xlsx/styles';
import { worksheetPart } from '../../../../lib/export/sheets/xlsx/worksheet';

function partOf(sheet: Sheet, options: { selected?: boolean; names?: Map<string, string>; drawing?: string } = {}) {
    const lost: CountedWarningCode[] = [];
    const record = (code: CountedWarningCode) => lost.push(code);
    const part = worksheetPart(sheet, {
        name: options.names?.get(sheet.name) ?? sheet.name,
        writtenName: (name) => options.names?.get(name),
        selected: options.selected ?? false,
        drawing: options.drawing,
        styles: styleRegistry(record),
        strings: sharedStringTable(record),
        lost: record,
    });
    return { xml: [...part.xml()].join(''), relationships: part.relationships, lost };
}

describe('a worksheet part', () => {
    test('writes its parts in the order CT_Worksheet sets', () => {
        const { xml } = partOf(
            {
                id: 'fixture-8',
                name: 'Sheet1',
                color: '#FF0000',
                celldata: [
                    {
                        r: 0,
                        c: 0,
                        v: {
                            v: 'x',
                            mc: { r: 0, c: 0, rs: 1, cs: 2 },
                            link: { type: 'webpage', address: 'https://example.com' },
                        },
                    },
                ],
                config: { columnlen: { 0: 90 }, merge: { '0_0': { r: 0, c: 0, rs: 1, cs: 2 } } },
                filterRange: { row: [0, 4], column: [0, 1] },
                frozen: { type: 'row' },
            },
            { drawing: '../drawings/drawing1.xml' },
        );
        const order = [...xml.matchAll(/<(\w+)\b/g)]
            .map(([, name]) => name)
            .filter((name) =>
                [
                    'sheetPr',
                    'dimension',
                    'sheetViews',
                    'sheetFormatPr',
                    'cols',
                    'sheetData',
                    'autoFilter',
                    'mergeCells',
                    'hyperlinks',
                    'pageMargins',
                    'drawing',
                ].includes(name),
            );
        expect(order).toEqual([
            'sheetPr',
            'dimension',
            'sheetViews',
            'sheetFormatPr',
            'cols',
            'sheetData',
            'autoFilter',
            'mergeCells',
            'hyperlinks',
            'pageMargins',
            'drawing',
        ]);
        expect(xml).toContain('<sheetPr><tabColor rgb="FFFF0000"/></sheetPr><dimension ref="A1"/>');
        expect(xml).toContain('<autoFilter ref="A1:B5"/><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>');
        expect(xml).toContain('<drawing r:id="rId1"/>');
    });

    test("the sheet's default width and height, or the app's, are its sheetFormatPr", () => {
        expect(
            partOf({ id: 'fixture-7', name: 'Excel', celldata: [], defaultColWidth: 72, defaultRowHeight: 17 }).xml,
        ).toContain('<sheetFormatPr defaultColWidth="8" defaultRowHeight="12.75" customHeight="1"/>');
        expect(partOf({ id: 'fixture-6', name: 'Eigen', celldata: [] }).xml).toContain(
            '<sheetFormatPr defaultColWidth="11.109375" defaultRowHeight="15" customHeight="1"/>',
        );
    });

    test('columns of one width and one hidden flag are one run', () => {
        const { xml } = partOf({
            id: 'fixture-5',
            name: 'Sheet1',
            celldata: [],
            config: { columnlen: { 0: 90, 1: 90, 2: 131, 4: 90 }, colhidden: { 2: 0, 3: 0, 4: 0 } },
        });
        expect(xml).toContain(
            [
                '<cols>',
                '<col min="1" max="2" width="10" customWidth="1"/>',
                '<col min="3" max="3" width="14.5546875" customWidth="1" hidden="1"/>',
                '<col min="4" max="4" hidden="1"/>',
                '<col min="5" max="5" width="10" customWidth="1" hidden="1"/>',
                '</cols>',
            ].join(''),
        );
    });

    test('a frozen pane splits after the last frozen row and column; gridlines and the selected tab share its view', () => {
        const view = (sheet: Partial<Sheet>, selected = false) =>
            partOf({ id: 'fixture', name: 'Sheet1', celldata: [], ...sheet }, { selected }).xml.match(
                /<sheetViews>.*<\/sheetViews>/,
            )?.[0];
        expect(view({}, true)).toBe('<sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews>');
        expect(
            view({ showGridLines: 0, frozen: { type: 'rangeBoth', range: { row_focus: 1, column_focus: 2 } } }),
        ).toBe(
            '<sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane xSplit="3" ySplit="2" topLeftCell="D3" activePane="bottomRight" state="frozen"/><selection pane="bottomRight"/></sheetView></sheetViews>',
        );
        expect(view({ frozen: { type: 'row' } })).toContain(
            '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/>',
        );
        expect(view({ frozen: { type: 'rangeColumn', range: { row_focus: 0, column_focus: 0 } } })).toContain(
            '<pane xSplit="1" topLeftCell="B1" activePane="topRight" state="frozen"/><selection pane="topRight"/>',
        );
    });

    test('a bare frozen type splits the same axes as its range form', () => {
        const pane = (type: NonNullable<Sheet['frozen']>['type']) =>
            partOf({
                id: 'fixture-4',
                name: 'Sheet1',
                celldata: [],
                frozen: { type, range: { row_focus: 1, column_focus: 2 } },
            }).xml.match(/<pane[^>]*>/)?.[0];
        const rows = '<pane ySplit="2" topLeftCell="A3" activePane="bottomLeft" state="frozen"/>';
        const columns = '<pane xSplit="3" topLeftCell="D1" activePane="topRight" state="frozen"/>';
        const both = '<pane xSplit="3" ySplit="2" topLeftCell="D3" activePane="bottomRight" state="frozen"/>';
        expect(pane('row')).toBe(rows);
        expect(pane('rangeRow')).toBe(rows);
        expect(pane('column')).toBe(columns);
        expect(pane('rangeColumn')).toBe(columns);
        expect(pane('both')).toBe(both);
        expect(pane('rangeBoth')).toBe(both);
    });

    test('links are a block of their own: web links by relationship, places in the workbook by location, the whole range kept; one it cannot write is counted', () => {
        const { xml, relationships, lost } = partOf(
            {
                id: 'fixture-3',
                name: 'Sheet1',
                celldata: [
                    {
                        r: 0,
                        c: 0,
                        v: { v: 'web', m: 'web', link: { type: 'webpage', address: 'https://example.com/a b' } },
                    },
                    {
                        r: 1,
                        c: 0,
                        v: { v: 6, f: '=SUM(B1:B3)', link: { type: 'webpage', address: 'https://example.com/x!B2' } },
                    },
                    {
                        r: 2,
                        c: 0,
                        v: { v: 'R&D "stuff"', m: 'R&D "stuff"', link: { type: 'sheet', address: 'My/Sheet' } },
                    },
                    { r: 3, c: 0, v: { v: 'range', link: { type: 'cellrange', address: 'Sheet2!B2:C3' } } },
                    { r: 4, c: 0, v: { link: { type: 'cellrange', address: 'D4' } } },
                    { r: 5, c: 0, v: { link: { type: 'webpage', address: 'javascript:alert(1)' } } },
                    { r: 6, c: 0, v: { link: { type: 'cellrange', address: 'not a ref' } } },
                ],
            },
            { names: new Map([['My/Sheet', 'My_Sheet']]) },
        );
        expect(xml.match(/<hyperlinks>.*<\/hyperlinks>/)?.[0]).toBe(
            [
                '<hyperlinks>',
                '<hyperlink ref="A1" r:id="rId1"/>',
                '<hyperlink ref="A2" r:id="rId2"/>',
                '<hyperlink ref="A3" location="&apos;My_Sheet&apos;!A1" display="R&amp;D &quot;stuff&quot;"/>',
                '<hyperlink ref="A4" location="Sheet2!B2:C3" display="range"/>',
                '<hyperlink ref="A5" location="&apos;Sheet1&apos;!D4" display="D4"/>',
                '</hyperlinks>',
            ].join(''),
        );
        expect(relationships).toEqual([
            { type: `${R}/hyperlink`, target: 'https://example.com/a%20b', external: true },
            { type: `${R}/hyperlink`, target: 'https://example.com/x!B2', external: true },
        ]);
        expect(lost).toEqual(['links-dropped', 'links-dropped']);
    });

    test('a drawing is the first relationship, the links after it', () => {
        const { relationships } = partOf(
            {
                id: 'fixture-2',
                name: 'Sheet1',
                celldata: [{ r: 0, c: 0, v: { link: { type: 'webpage', address: 'https://example.com' } } }],
            },
            { drawing: '../drawings/drawing1.xml' },
        );
        expect(relationships).toEqual([
            { type: `${R}/drawing`, target: '../drawings/drawing1.xml' },
            { type: `${R}/hyperlink`, target: 'https://example.com', external: true },
        ]);
    });

    test("a peer's address and text can't break out of the XML", () => {
        const location = '"/><evil a="';
        const { xml } = partOf({
            id: 'fixture-1',
            name: 'Sheet1',
            celldata: [{ r: 0, c: 0, v: { v: '<evil/>', m: '<evil/>', link: { type: 'sheet', address: location } } }],
        });
        expect(xml).not.toContain('<evil');
    });

    test("past Excel's 65,530 links a sheet's further links are left out, counted", () => {
        const celldata: NonNullable<Sheet['celldata']> = [];
        for (let r = 0; r < 65_532; r++) celldata.push({ r, c: 0, v: { link: { type: 'cellrange', address: 'B1' } } });
        const { xml, lost } = partOf({ id: 'fixture-1', name: 'Sheet1', celldata });
        expect(xml.match(/<hyperlink /g)).toHaveLength(65_530);
        expect(lost).toEqual(['links-dropped', 'links-dropped']);
    });
});

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
