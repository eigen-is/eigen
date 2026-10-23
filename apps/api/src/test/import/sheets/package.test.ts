import { describe, expect, test } from 'bun:test';
import { ApiError } from '../../../lib/core/errors';
import { XmlError, xmlAttr, xmlChild, xmlElements } from '../../../lib/core/xml';
import {
    BATCH_BYTES,
    MAX_XLSX_ELEMENTS,
    readBudget,
    readInBatches,
    readPackage,
} from '../../../lib/import/sheets/package';
import { MAX_PACKAGE_XML_BYTES, MAX_PACKAGE_XML_TAGS } from '../../../lib/ooxml/opc';
import { writeZip, ZipError } from '../../../lib/ooxml/zip';
import { OFFICE_COLORS, SML, sheetXml, xlsxFixture } from '../../fixtures/xlsx';

// The workbook part through the package's relationships, and a part's children read a batch at a time.

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';

function thrown(run: () => unknown): unknown {
    try {
        run();
    } catch (error) {
        return error;
    }
    throw new Error('expected a throw');
}

describe('the workbook', () => {
    test('lists its worksheets in order, by name, part and visibility', () => {
        const book = readPackage(
            xlsxFixture({
                sheets: [{ name: 'One' }, { name: 'Two', state: 'hidden' }, { name: 'Three', state: 'veryHidden' }],
            }),
        );
        expect(book.sheets).toEqual([
            { name: 'One', path: 'xl/worksheets/sheet1.xml', hidden: false, chartSheet: false },
            { name: 'Two', path: 'xl/worksheets/sheet2.xml', hidden: true, chartSheet: false },
            { name: 'Three', path: 'xl/worksheets/sheet3.xml', hidden: true, chartSheet: false },
        ]);
        expect(book.date1904).toBe(false);
    });

    // A package read as OPC reads it, not by where Excel puts the parts.
    test('is found through the package relationships, its sheets through its own, a chartsheet among them; a link is no sheet', () => {
        const rel = (id: string, type: string, target: string, mode = '') =>
            `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"${mode}/>`;
        const book = readPackage(
            writeZip([
                {
                    name: '_rels/.rels',
                    data: `<Relationships xmlns="${PACKAGE_RELS}">${rel('rId1', 'officeDocument', 'book/main.xml')}</Relationships>`,
                },
                {
                    name: 'book/main.xml',
                    data: `<workbook xmlns="${SML}" xmlns:r="${R}"><workbookPr date1904="true"/><sheets><sheet name="Grid" r:id="a"/><sheet name="Chart" r:id="b"/><sheet name="Far" r:id="c"/><sheet name="Lost" r:id="d"/><sheet r:id="a"/></sheets></workbook>`,
                },
                {
                    name: 'book/_rels/main.xml.rels',
                    data: `<Relationships xmlns="${PACKAGE_RELS}">${rel('a', 'worksheet', '../grid/one.xml')}${rel('b', 'chartsheet', 'charts/one.xml')}${rel('c', 'worksheet', 'https://example.com/x.xml', ' TargetMode="External"')}${rel('s', 'styles', 'look.xml')}</Relationships>`,
                },
                { name: 'book/look.xml', data: `<styleSheet xmlns="${SML}"/>` },
            ]),
        );
        expect(book.sheets).toEqual([
            { name: 'Grid', path: 'grid/one.xml', hidden: false, chartSheet: false },
            { name: 'Chart', path: 'book/charts/one.xml', hidden: false, chartSheet: true },
        ]);
        expect(book.date1904).toBe(true);
        expect(book.styles?.local).toBe('styleSheet');
        expect(book.theme).toBeUndefined();
        expect(book.sharedStrings).toBeUndefined();
    });

    // Read once per entry, a part named by many sheets was a 0.2 MB zip that took a minute and 6.7 GB.
    test('a part several sheets name is one sheet, named and placed by the last of them', () => {
        const rel = (id: string, target: string) =>
            `<Relationship Id="${id}" Type="${R}/worksheet" Target="${target}"/>`;
        const book = readPackage(
            writeZip([
                {
                    name: '_rels/.rels',
                    data: `<Relationships xmlns="${PACKAGE_RELS}"><Relationship Id="rId1" Type="${R}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
                },
                {
                    name: 'xl/workbook.xml',
                    data: `<workbook xmlns="${SML}" xmlns:r="${R}"><sheets><sheet name="A" r:id="one"/><sheet name="B" r:id="two"/><sheet name="C" r:id="also-one" state="hidden"/></sheets></workbook>`,
                },
                {
                    name: 'xl/_rels/workbook.xml.rels',
                    data: `<Relationships xmlns="${PACKAGE_RELS}">${rel('one', 'worksheets/sheet1.xml')}${rel('two', 'worksheets/sheet2.xml')}${rel('also-one', '/xl/worksheets/sheet1.xml')}</Relationships>`,
                },
            ]),
        );
        expect(book.sheets).toEqual([
            { name: 'B', path: 'xl/worksheets/sheet2.xml', hidden: false, chartSheet: false },
            { name: 'C', path: 'xl/worksheets/sheet1.xml', hidden: true, chartSheet: false },
        ]);
    });

    test("finds the styles, theme and shared strings through the workbook's relationships", () => {
        const book = readPackage(
            xlsxFixture({
                sheets: [{}],
                styles: '<fonts/>',
                colors: OFFICE_COLORS,
                strings: ['<t>a</t>'],
                workbookPr: '<workbookPr date1904="1"/>',
            }),
        );
        expect(book.styles?.local).toBe('styleSheet');
        expect(book.theme?.local).toBe('theme');
        expect(new TextDecoder().decode(book.sharedStrings)).toContain('<si><t>a</t></si>');
        expect(book.date1904).toBe(true);
    });

    test('a damaged styles or theme part costs the looks, not the workbook', () => {
        const book = readPackage(
            xlsxFixture({
                sheets: [{}],
                parts: [
                    { name: 'xl/styles.xml', data: '<styleSheet' },
                    { name: 'xl/theme/theme1.xml', data: '<!DOCTYPE x><x/>' },
                ],
            }),
        );
        expect(book.styles).toBeUndefined();
        expect(book.theme).toBeUndefined();
    });

    test('Strict namespaces read as transitional', () => {
        const book = readPackage(
            writeZip([
                {
                    name: '_rels/.rels',
                    data: `<Relationships xmlns="${PACKAGE_RELS}"><Relationship Id="r1" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
                },
                {
                    name: 'xl/workbook.xml',
                    data: '<workbook xmlns="http://purl.oclc.org/ooxml/spreadsheetml/main" xmlns:r="http://purl.oclc.org/ooxml/officeDocument/relationships"><sheets><sheet name="S" r:id="r1"/></sheets></workbook>',
                },
                {
                    name: 'xl/_rels/workbook.xml.rels',
                    data: `<Relationships xmlns="${PACKAGE_RELS}"><Relationship Id="r1" Type="http://purl.oclc.org/ooxml/officeDocument/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
                },
            ]),
        );
        expect(book.sheets).toEqual([
            { name: 'S', path: 'xl/worksheets/sheet1.xml', hidden: false, chartSheet: false },
        ]);
    });

    test('a package without a workbook is not a valid xlsx file; an encrypted one says so', () => {
        const noWorkbook = thrown(() => readPackage(writeZip([{ name: 'word/document.xml', data: '<x/>' }])));
        expect(noWorkbook).toBeInstanceOf(ApiError);
        expect(noWorkbook).toMatchObject({ status: 400, message: 'Not a valid xlsx file' });
        const ole = new Uint8Array(4096);
        ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
        ole.set(Buffer.from('EncryptedPackage', 'utf16le'), 1024);
        expect(thrown(() => readPackage(ole))).toMatchObject({
            status: 400,
            message: 'This spreadsheet is password-protected. Remove the password in Excel and import it again.',
        });
        expect(thrown(() => readPackage(new Uint8Array(100)))).toBeInstanceOf(ZipError);
    });
});

describe("a part's children, a batch at a time", () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    const rowsOf = (part: string) => {
        const { rest, children } = readInBatches(encode(part), 'sheetData', 'row', readBudget());
        return { rows: [...children].map((row) => xmlAttr(row, '', 'r') ?? ''), rest };
    };
    // Enough rows to cut the grid into several batches.
    const manyRows = (count: number) =>
        Array.from(
            { length: count },
            (_, index) => `<row r="${index + 1}"><c r="A${index + 1}"><v>${'7'.repeat(40)}</v></c></row>`,
        ).join('');
    const COUNT = Math.ceil((3 * BATCH_BYTES) / 60);

    test('visits every child in order across batches, and gives the part without them', () => {
        const { rows, rest } = rowsOf(
            sheetXml({ data: manyRows(COUNT), before: '<dimension ref="A1"/>', after: '<mergeCells/>' }),
        );
        expect(rows).toHaveLength(COUNT);
        expect(rows.at(-1)).toBe(String(COUNT));
        expect(rows.every((r, index) => r === String(index + 1))).toBe(true);
        if (!rest) throw new Error('no rest');
        expect(xmlElements(rest).map((element) => element.local)).toEqual(['dimension', 'sheetData', 'mergeCells']);
        expect(rest && xmlChild(rest, SML, 'sheetData')?.children).toEqual([]);
    });

    test("reads a prefixed part, and the container's own declarations bind in every batch", () => {
        const part = `<x:worksheet xmlns:x="${SML}"><x:sheetData xmlns:z="urn:z">${manyRows(COUNT).replaceAll('<row ', '<x:row z:a="1" ').replaceAll('</row>', '</x:row>').replaceAll('<c ', '<x:c ').replaceAll('</c>', '</x:c>').replaceAll('<v>', '<x:v>').replaceAll('</v>', '</x:v>')}</x:sheetData></x:worksheet>`;
        expect(rowsOf(part).rows).toHaveLength(COUNT);
    });

    test('the root itself can hold the children, as the shared strings do', () => {
        const part = `<?xml version="1.0"?><sst xmlns="${SML}">${Array.from({ length: COUNT }, (_, index) => `<si><t>${index}${'x'.repeat(40)}</t></si>`).join('')}</sst>`;
        expect([...readInBatches(encode(part), undefined, 'si', readBudget()).children]).toHaveLength(COUNT);
    });

    // A cut inside a comment, CDATA or an instruction leaves its batch malformed, never misread: the part is read whole
    // from there, past the rows already read.
    test('a cut that falls inside a comment, CDATA or an instruction reads the part whole', () => {
        let filler = '';
        let count = 0;
        while (filler.length < BATCH_BYTES - 5000) filler += `<row r="${++count}"/>`;
        // The first row tag past a batch's length is the hidden one.
        const padding = ' '.repeat(10_000);
        for (const hidden of [
            `<!--${padding}<row r="999999"/> -->`,
            `<row r="999997"><c r="A999997" t="inlineStr"><is><t><![CDATA[${padding}<row b]]></t></is></c></row>`,
            `<?x ${padding}<row r="999999"/> ?>`,
        ]) {
            const part = sheetXml({ data: `${filler}${hidden}<row r="999998"/>` });
            const { rows } = rowsOf(part);
            expect(rows.slice(0, count)).toEqual(Array.from({ length: count }, (_, index) => String(index + 1)));
            expect(rows.slice(count)).toEqual(hidden.startsWith('<row') ? ['999997', '999998'] : ['999998']);
        }
    });

    test('a grid a comment pretends to start is no grid: the part is read whole', () => {
        const part = sheetXml({
            before: '<!-- <sheetData><row r="666"/></sheetData> --><sheetPr><![CDATA[<sheetData><row r="667"/></sheetData>]]></sheetPr>',
            data: '<row r="1"/><row r="2"/>',
        });
        expect(rowsOf(part).rows).toEqual(['1', '2']);
    });

    test('a DOCTYPE is refused', () => {
        const part = `<!DOCTYPE worksheet [<!ENTITY x "y">]>${sheetXml({ data: '<row r="1"/>' }).replace(/^<\?xml[^>]*>\n/, '')}`;
        expect(thrown(() => rowsOf(part))).toBeInstanceOf(XmlError);
        expect(
            thrown(() =>
                rowsOf(
                    `<?xml version="1.0"?><!DOCTYPE x><worksheet xmlns="${SML}"><sheetData><row r="1"/></sheetData></worksheet>`,
                ),
            ),
        ).toBeInstanceOf(XmlError);
    });

    test('a part in UTF-16, or one with no grid, is read whole', () => {
        const utf16 = Buffer.from(
            `﻿${sheetXml({ data: '<row r="1"/><row r="2"/>' }).replace('UTF-8', 'UTF-16')}`,
            'utf16le',
        );
        const rows = [...readInBatches(utf16, 'sheetData', 'row', readBudget()).children].map((row) =>
            xmlAttr(row, '', 'r'),
        );
        expect(rows).toEqual(['1', '2']);
        expect(rowsOf(`<worksheet xmlns="${SML}"><sheetData/></worksheet>`).rows).toEqual([]);
        expect(rowsOf(`<worksheet xmlns="${SML}"/>`).rest?.local).toBe('worksheet');
    });

    test("the children's elements are charged together, before the first batch is parsed", () => {
        // Five elements: two rows, two cells and a value.
        const part = encode(sheetXml({ data: '<row><c/></row><row r="2"><c><v>1</v></c></row>' }));
        const budget = readBudget();
        budget.chargeElements(MAX_XLSX_ELEMENTS - 8);
        readInBatches(part, 'sheetData', 'row', budget);
        expect(thrown(() => readInBatches(part, 'sheetData', 'row', budget))).toMatchObject({
            status: 413,
            message: 'This spreadsheet is too large to import',
        });
    });

    // The prolog and start tags are parsed again in front of every batch: 1 MB of instructions before the root was
    // 38M nodes over 180 batches, none of them charged.
    test("the wrapper's elements are charged again for every batch it is parsed in", () => {
        const WRAPPER_ELEMENTS = 50_002;
        const part = encode(
            `${'<?a?>'.repeat(WRAPPER_ELEMENTS - 2)}<worksheet xmlns="${SML}"><sheetData>${manyRows(COUNT)}</sheetData></worksheet>`,
        );
        const charged: number[] = [];
        const budget = { ...readBudget(), chargeElements: (count: number) => void charged.push(count) };
        const { children } = readInBatches(part, 'sheetData', 'row', budget);
        expect([...children]).toHaveLength(COUNT);
        const [, ...perBatch] = charged;
        expect(perBatch.length).toBeGreaterThanOrEqual(3);
        expect(perBatch.every((count) => count === WRAPPER_ELEMENTS)).toBe(true);
    });

    test('what is parsed whole, the rest of a part or a part that must be, is charged its bytes and tags', () => {
        const part = encode(sheetXml({ data: '<row r="1"/>' }));
        const nearlyFull = (spend: (budget: ReturnType<typeof readBudget>) => void) => {
            const budget = readBudget();
            spend(budget);
            return budget;
        };
        for (const budget of [
            nearlyFull((budget) => budget.chargeWhole(new Uint8Array(MAX_PACKAGE_XML_BYTES - 100))),
            nearlyFull((budget) => budget.chargeWhole(Buffer.from('<a>'.repeat(MAX_PACKAGE_XML_TAGS - 2)))),
        ]) {
            expect(thrown(() => readInBatches(part, 'sheetData', 'row', budget))).toMatchObject({ status: 413 });
            expect(
                thrown(() => readInBatches(encode(`<worksheet xmlns="${SML}"/>`), 'sheetData', 'row', budget)),
            ).toMatchObject({
                status: 413,
            });
        }
    });

    // A single 40 MB row was one batch of 2.25 GB.
    test('a child longer than a batch may be is too large before it is parsed', () => {
        const part = encode(sheetXml({ data: `<row r="1">${'<c><v>1</v></c>'.repeat(900_000)}</row><row r="2"/>` }));
        const { children } = readInBatches(part, 'sheetData', 'row', readBudget());
        expect(thrown(() => [...children])).toMatchObject({
            status: 413,
            message: 'This spreadsheet is too large to import',
        });
    });

    test('a malformed batch is malformed XML', () => {
        expect(thrown(() => rowsOf(sheetXml({ data: '<row r="1"><c></row>' })))).toBeInstanceOf(XmlError);
        expect(thrown(() => rowsOf(sheetXml({ data: '<row r="1"/></worksheet><worksheet>' })))).toBeInstanceOf(
            XmlError,
        );
    });
});
