import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JSONContent } from '@tiptap/core';
import { MIN_TABLE_COLUMN_PX } from '@workspace/lib/docs/eigendoc';
import { ApiError } from '../../../lib/core/errors';
import * as xml from '../../../lib/core/xml';
import { openZip, ZipReader } from '../../../lib/core/zip';
import { documentTransformRunner, TRANSFORM_LIMITS } from '../../../lib/document/transform/runner';
import { COLUMN_PX, MAX_LIST_DEPTH, MAX_QUOTE_DEPTH } from '../../../lib/import/doc/assemble';
import { docxToPmJson } from '../../../lib/import/doc/from-docx';
import { MAX_DOCX_XML_BYTES, MAX_DOCX_XML_TAGS } from '../../../lib/import/doc/package';
import { MAX_TABLE_DEPTH } from '../../../lib/import/doc/tables';
import {
    buildDocxWithBody,
    GOLDEN_DOCX_IMAGE_RUN,
    importDocxBody,
    marksOfType,
    nodesOfType,
} from '../../fixtures/golden-docx';
import { build, deflated, stored } from '../../fixtures/raw-zip';

// The bounds an untrusted docx meets: the XML the reader parses, the structures it walks and every value it writes.

const run = (text: string, rPr = '') => `<w:r>${rPr && `<w:rPr>${rPr}</w:rPr>`}<w:t>${text}</w:t></w:r>`;
const paragraph = (inner: string, pPr = '') => `<w:p>${pPr && `<w:pPr>${pPr}</w:pPr>`}${inner}</w:p>`;
const cell = (text: string, tcPr = '') => `<w:tc>${tcPr && `<w:tcPr>${tcPr}</w:tcPr>`}${paragraph(run(text))}</w:tc>`;
const table = (grid: number[], rows: string[][]) =>
    `<w:tbl><w:tblGrid>${grid.map((width) => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>${rows
        .map((cells) => `<w:tr>${cells.join('')}</w:tr>`)
        .join('')}</w:tbl>`;
const picture = (cx: number | string) =>
    GOLDEN_DOCX_IMAGE_RUN.replace('<wp:extent cx="381000"', `<wp:extent cx="${cx}"`);
const ordered = (numId: number, level = 0) =>
    `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`;
const numberedFrom = (start: string) =>
    `<w:abstractNum w:abstractNumId="5"><w:lvl w:ilvl="0"><w:start w:val="${start}"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="5"><w:abstractNumId w:val="5"/></w:num>`;

const noteRef = (id: number) => `<w:r><w:footnoteReference w:id="${id}"/></w:r>`;
const footnote = (id: number, inner: string) => `<w:footnote w:id="${id}">${inner}</w:footnote>`;
const floating = (inner: string) =>
    `<w:tbl><w:tblPr><w:tblpPr w:tblpX="0"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc>${inner}</w:tc></w:tr></w:tbl>`;

const imported = async (body: string, parts = {}) => (await importDocxBody(body, parts)).json;
const cells = (json: JSONContent) => nodesOfType(json, 'tableCell');
const texts = (json: JSONContent) => nodesOfType(json, 'text').map((node) => node.text);
// The notes list closes the document, one item per note.
const notes = (json: JSONContent) => (json.content?.at(-1)?.content ?? []).map((item) => texts(item).join(''));

// A process of its own with a deadline, for a file that could hold the reader in a loop.
function importInChild(docx: ArrayBuffer, timeout: number): JSONContent {
    const script = `
        const { docxToPmJson } = await import(process.env.READER);
        const { json } = await docxToPmJson(Buffer.from(await Bun.stdin.arrayBuffer()));
        console.log(JSON.stringify(json));
    `;
    const child = Bun.spawnSync([process.execPath, '-e', script], {
        env: { ...process.env, READER: Bun.resolveSync('../../../lib/import/doc/from-docx', import.meta.dir) },
        stdin: new Uint8Array(docx),
        timeout,
    });
    expect(child.exitedDueToTimeout).toBe(false);
    expect(child.stderr.toString()).toBe('');
    return JSON.parse(child.stdout.toString());
}

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
    const error = await promise.then(
        () => undefined,
        (reason: unknown) => reason,
    );
    if (!(error instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(error)}`);
    return error;
}

describe('XML budget', () => {
    afterEach(() => {
        for (const spy of spies) spy.mockRestore();
        spies.length = 0;
    });
    const spies: { mockRestore(): void }[] = [];
    const padding = (bytes: number) => `<!--${'x'.repeat(bytes)}-->`;

    test('a document.xml past the budget is 413 before it inflates or parses', async () => {
        const docx = await buildDocxWithBody(`${paragraph(run('Body'))}${padding(MAX_DOCX_XML_BYTES)}`);
        const reads = spyOn(ZipReader.prototype, 'read');
        const parses = spyOn(xml, 'parseXml');
        spies.push(reads, parses);
        const error = await rejection(docxToPmJson(Buffer.from(docx)));
        expect([error.status, error.message]).toEqual([413, 'Document too large']);
        // The package's structure was read through the spies; the body was not.
        expect(parses).toHaveBeenCalled();
        expect(reads.mock.calls.map(([name]) => name)).not.toContain('word/document.xml');
        expect(Math.max(...parses.mock.calls.map(([input]) => input.length))).toBeLessThan(MAX_DOCX_XML_BYTES);
    });

    // Memory follows the elements, not the bytes: 4.5 MB of empty paragraphs would cost more than 16 MB of prose.
    test('a body past the tag budget is 413 before it parses', async () => {
        const docx = await buildDocxWithBody('<w:p/>'.repeat(MAX_DOCX_XML_TAGS));
        const parses = spyOn(xml, 'parseXml');
        spies.push(parses);
        const error = await rejection(docxToPmJson(Buffer.from(docx)));
        expect([error.status, error.message]).toEqual([413, 'Document too large']);
        expect(Math.max(...parses.mock.calls.map(([input]) => input.length))).toBeLessThan(1024 * 1024);
    });

    test('the budget counts the parts together', async () => {
        const half = padding(MAX_DOCX_XML_BYTES / 2);
        const error = await rejection(importDocxBody(`${paragraph(run('Body'))}${half}`, { styles: half }));
        expect([error.status, error.message]).toEqual([413, 'Document too large']);
    });

    test('a 23 MB webSettings.xml beside a small body imports: the reader never parses it', async () => {
        const webSettings = `<w:webSettings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${padding(23 * 1024 * 1024)}</w:webSettings>`;
        const { json } = await importDocxBody(paragraph(run('Body')), {
            rels: '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/webSettings" Target="webSettings.xml"/>',
            media: { 'word/webSettings.xml': new TextEncoder().encode(webSettings) },
        });
        expect(nodesOfType(json, 'text').map((node) => node.text)).toEqual(['Body']);
    });

    // As a malformed one does: the text is the document's, a theme only its looks.
    test('a corrupt optional part costs its looks, not the document', async () => {
        const golden = openZip(new Uint8Array(await buildDocxWithBody(paragraph(run('Body')))));
        const parts = golden.names().map((name) => {
            const data = golden.read(name) ?? new Uint8Array();
            return name === 'word/styles.xml' ? { ...stored(name, data), crc: 0 } : stored(name, data);
        });
        const { json } = await docxToPmJson(build(parts));
        expect(nodesOfType(json, 'text').map((node) => node.text)).toEqual(['Body']);
    });

    test('a part every relationship names is parsed once', async () => {
        const golden = openZip(new Uint8Array(await buildDocxWithBody(paragraph(run('Body')))));
        const types = ['styles', 'numbering', 'theme', 'footnotes', 'endnotes'];
        const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${types
            .map(
                (type) =>
                    `<Relationship Id="${type}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="document.xml"/>`,
            )
            .join('')}</Relationships>`;
        const parts = golden.names().map((name) => {
            const data = golden.read(name) ?? new Uint8Array();
            return stored(name, name === 'word/_rels/document.xml.rels' ? new TextEncoder().encode(rels) : data);
        });
        const parses = spyOn(xml, 'parseXml');
        spies.push(parses);
        const { json } = await docxToPmJson(build(parts));
        expect(texts(json)).toEqual(['Body']);
        const size = golden.entry('word/document.xml')?.size;
        expect(parses.mock.calls.filter(([input]) => input.length === size)).toHaveLength(1);
    });

    test('a corrupt part every relationship names is parsed once and costs only its looks', async () => {
        const golden = openZip(new Uint8Array(await buildDocxWithBody(paragraph(run('Body')))));
        const types = ['styles', 'numbering', 'theme', 'footnotes', 'endnotes'];
        const rels = `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${types
            .map(
                (type) =>
                    `<Relationship Id="${type}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="broken.xml"/>`,
            )
            .join('')}</Relationships>`;
        const broken = new TextEncoder().encode('<w:styles><w:style></w:styles>');
        const parts = [
            ...golden.names().map((name) => {
                const data = golden.read(name) ?? new Uint8Array();
                return stored(name, name === 'word/_rels/document.xml.rels' ? new TextEncoder().encode(rels) : data);
            }),
            stored('word/broken.xml', broken),
        ];
        const parses = spyOn(xml, 'parseXml');
        spies.push(parses);
        const { json } = await docxToPmJson(build(parts));
        expect(texts(json)).toEqual(['Body']);
        expect(parses.mock.calls.filter(([input]) => input.length === broken.length)).toHaveLength(1);
    });

    // The second name reads the part's error, not a part without relationships.
    test('a corrupt part fails alike for every name that reads it', async () => {
        const encode = (text: string) => new TextEncoder().encode(text);
        const notes = `<w:notes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:endnote w:id="1">${paragraph(run('Note'))}</w:endnote></w:notes>`;
        const { json } = await importDocxBody(paragraph(`${run('Body')}<w:r><w:endnoteReference w:id="1"/></w:r>`), {
            rels: ['footnotes', 'endnotes']
                .map(
                    (type) =>
                        `<Relationship Id="${type}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="notes.xml"/>`,
                )
                .join(''),
            media: { 'word/notes.xml': encode(notes), 'word/_rels/notes.xml.rels': encode('<Relationships>') },
        });
        expect(texts(json)).toEqual(['Body', '[1]']);
    });

    // As a corrupt file is, rather than as a server error.
    test('a reader slip on a file is 400', async () => {
        const docx = await buildDocxWithBody(paragraph(run('Body')));
        const parses = spyOn(xml, 'parseXml').mockImplementationOnce(() => {
            throw new TypeError('slip');
        });
        spies.push(parses);
        const error = await rejection(docxToPmJson(Buffer.from(docx)));
        expect([error.status, error.message]).toEqual([400, 'Not a valid docx file']);
    });

    test('a part that inflates past its declared size is a corrupt file, 400', async () => {
        const golden = openZip(new Uint8Array(await buildDocxWithBody(paragraph(run('Body')))));
        const parts = golden.names().map((name) => {
            const data = golden.read(name) ?? new Uint8Array();
            return name === 'word/document.xml' ? { ...deflated(name, data), size: 10 } : stored(name, data);
        });
        const error = await rejection(docxToPmJson(build(parts)));
        expect([error.status, error.message]).toEqual([400, 'Not a valid docx file']);
    });
});

describe('structure', () => {
    // Word's column limit; a looped gridSpan of 2e9 would hold the Worker to its deadline.
    test('a gridSpan past the grid spans the grid', async () => {
        const json = await imported(table([2000, 2000], [[cell('Wide', '<w:gridSpan w:val="2000000000"/>')]]));
        expect(cells(json).map((node) => node.attrs?.['colspan'])).toEqual([2]);
    }, 5000);

    test('a grid of more than 63 columns is read as 63', async () => {
        const json = await imported(table(Array(100).fill(100), [[cell('All', '<w:gridSpan w:val="100"/>')]]));
        const [only] = cells(json);
        expect(only?.attrs?.['colspan']).toBe(63);
        expect(only?.attrs?.['colwidth']).toHaveLength(63);
    });

    test('a merge that starts in the last row spans that row alone', async () => {
        const json = await imported(
            table(
                [2000],
                [
                    [cell('Top', '<w:vMerge w:val="restart"/>')],
                    [cell('', '<w:vMerge/>')],
                    [cell('Last', '<w:vMerge w:val="restart"/>')],
                ],
            ),
        );
        expect(cells(json).map((node) => node.attrs?.['rowspan'])).toEqual([2, 1]);
    });

    test('a basedOn cycle stops at the first repeat', async () => {
        const styles = `<w:style w:type="paragraph" w:styleId="A"><w:name w:val="A"/><w:basedOn w:val="B"/><w:rPr><w:b/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="B"><w:name w:val="B"/><w:basedOn w:val="A"/></w:style>`;
        const json = await imported(paragraph(run('Loop'), '<w:pStyle w:val="A"/>'), { styles });
        expect(marksOfType(json, 'bold').map((mark) => mark.text)).toEqual(['Loop']);
    });

    test('a numStyleLink cycle stops at the first repeat', async () => {
        const styles = `<w:style w:type="numbering" w:styleId="L1"><w:name w:val="L1"/><w:pPr><w:numPr><w:numId w:val="11"/></w:numPr></w:pPr></w:style>
<w:style w:type="numbering" w:styleId="L2"><w:name w:val="L2"/><w:pPr><w:numPr><w:numId w:val="10"/></w:numPr></w:pPr></w:style>`;
        const numbering = `<w:abstractNum w:abstractNumId="10"><w:numStyleLink w:val="L1"/></w:abstractNum>
<w:abstractNum w:abstractNumId="11"><w:numStyleLink w:val="L2"/><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
<w:num w:numId="10"><w:abstractNumId w:val="10"/></w:num><w:num w:numId="11"><w:abstractNumId w:val="11"/></w:num>`;
        const json = await imported(paragraph(run('Item'), ordered(10)), { styles, numbering });
        expect(nodesOfType(json, 'orderedList')).toHaveLength(1);
    }, 5000);

    test('quotes nest at most eight deep, deeper ones joining the eighth', async () => {
        const bar = '<w:pBdr><w:left w:val="single" w:sz="24" w:space="12" w:color="E5E7EB"/></w:pBdr>';
        const json = await imported(paragraph(run('Deep'), `${bar}<w:ind w:left="999999999"/>`));
        let depth = 0;
        for (let node = json.content?.[0]; node?.type === 'blockquote'; node = node.content?.[0]) depth++;
        expect(depth).toBe(MAX_QUOTE_DEPTH);
    }, 5000);

    // Each list of its own definition nests under the item above by indent; 3,000 deep overflowed the Worker's stack.
    test('lists nest at most nine deep, deeper items opening lists at the deepest level', async () => {
        const count = 50;
        const numbering = Array.from(
            { length: count },
            (_, index) =>
                `<w:abstractNum w:abstractNumId="${100 + index}"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="${100 + index}"><w:abstractNumId w:val="${100 + index}"/></w:num>`,
        ).join('');
        const body = Array.from({ length: count }, (_, index) =>
            paragraph(run(`Item ${index}`), `${ordered(100 + index)}<w:ind w:left="${720 * (index + 1)}"/>`),
        ).join('');
        const json = await imported(body, { numbering });
        const depth = (node: JSONContent): number =>
            (node.type === 'bulletList' ? 1 : 0) + Math.max(0, ...(node.content ?? []).map(depth));
        expect(depth(json)).toBe(MAX_LIST_DEPTH);
        expect(nodesOfType(json, 'listItem')).toHaveLength(count);
    });

    test('tables nest at most eight deep, a deeper one reading as its cells', async () => {
        const body = `${'<w:tbl><w:tr><w:tc>'.repeat(50)}${paragraph(run('Core'))}${'</w:tc></w:tr></w:tbl>'.repeat(50)}`;
        const json = await imported(body);
        expect(nodesOfType(json, 'table')).toHaveLength(MAX_TABLE_DEPTH);
        expect(nodesOfType(json, 'text').map((node) => node.text)).toEqual(['Core']);
    });

    test('a level outside 0 to 8 is read within it', async () => {
        const json = await imported(paragraph(run('Item'), ordered(2, -3)));
        expect(nodesOfType(json, 'orderedList')).toHaveLength(1);
    });

    test('10,000 lists stay linear', async () => {
        const nums = Array.from(
            { length: 10_000 },
            (_, index) =>
                `<w:num w:numId="${100 + index}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`,
        ).join('');
        const body = Array.from({ length: 10_000 }, (_, index) => paragraph(run('Item'), ordered(100 + index))).join(
            '',
        );
        const started = performance.now();
        const json = await imported(body, { numbering: nums });
        expect(nodesOfType(json, 'orderedList')).toHaveLength(10_000);
        expect(performance.now() - started).toBeLessThan(2000);
    }, 10_000);

    // A label grows with its lvlText and, in letters, with every item; a heading keeps it as text.
    test('numbered heading labels are capped, so many cost no more than short ones', async () => {
        const numbering = `<w:abstractNum w:abstractNumId="6"><w:lvl w:ilvl="0"><w:start w:val="30000"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="${'%1'.repeat(2000)}"/></w:lvl></w:abstractNum><w:num w:numId="6"><w:abstractNumId w:val="6"/></w:num>`;
        const heading = paragraph(run('Title'), `<w:pStyle w:val="Heading1"/>${ordered(6)}`);
        const started = performance.now();
        const json = await imported(heading.repeat(5000), { numbering });
        expect(performance.now() - started).toBeLessThan(2000);
        const [first] = nodesOfType(json, 'heading');
        expect(nodesOfType(first ?? {}, 'text')[0]?.text?.length).toBeLessThanOrEqual(255 + ' Title'.length);
    }, 20_000);

    test('a 4 MB lvlText costs a heading what a short one does', async () => {
        const numbering = `<w:abstractNum w:abstractNumId="6"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="${'%1'.repeat(2_000_000)}"/></w:lvl></w:abstractNum><w:num w:numId="6"><w:abstractNumId w:val="6"/></w:num>`;
        const heading = paragraph(run('Title'), `<w:pStyle w:val="Heading1"/>${ordered(6)}`);
        const started = performance.now();
        const json = await imported(heading.repeat(200), { numbering });
        expect(performance.now() - started).toBeLessThan(2000);
        expect(nodesOfType(json, 'heading')).toHaveLength(200);
    }, 30_000);

    test('a footnote that references itself, or one that references it back, is read once', async () => {
        const docx = await buildDocxWithBody(paragraph(`${run('Body')}${noteRef(1)}${noteRef(3)}`), {
            footnotes: [
                footnote(1, paragraph(`${run('One')}${noteRef(2)}`)),
                footnote(2, paragraph(`${run('Two')}${noteRef(1)}`)),
                footnote(3, paragraph(`${run('Self')}${noteRef(3)}`)),
            ].join(''),
        });
        const json = importInChild(docx, 10_000);
        expect(notes(json)).toEqual(['One[3] ↑', 'Self[2] ↑', 'Two[1] ↑']);
        expect(texts(json.content?.[0] ?? {})).toEqual(['Body', '[1]', '[2]']);
    }, 15_000);

    test('a long note referenced 400 times is read once', async () => {
        const body = paragraph(noteRef(1).repeat(400));
        const footnotes = footnote(1, paragraph(run('Note')).repeat(2000));
        const started = performance.now();
        const json = await imported(body, { footnotes });
        expect(performance.now() - started).toBeLessThan(1000);
        expect(notes(json)).toHaveLength(1);
        expect(texts(json.content?.[0] ?? {})).toEqual(['[1]'.repeat(400)]);
    }, 20_000);

    test('20,000 notes stay linear', async () => {
        const count = 20_000;
        const ids = Array.from({ length: count }, (_, index) => index + 1);
        const body = paragraph(ids.map(noteRef).join(''));
        const footnotes = ids.map((id) => footnote(id, paragraph(run(`N${id}`)))).join('');
        const started = performance.now();
        const json = await imported(body, { footnotes });
        expect(performance.now() - started).toBeLessThan(2000);
        expect(notes(json)).toHaveLength(count);
    }, 60_000);

    test('a floating one-cell table that holds no figure is read once', async () => {
        const item = (text: string) => paragraph(run(text), ordered(2));
        const body = `${item('One')}${floating(`${item('Two')}${paragraph(`${run('Cell')}${noteRef(1)}`)}`)}${item('Three')}`;
        const json = await imported(body, { footnotes: footnote(1, paragraph(run('Note'))) });
        expect(nodesOfType(json, 'orderedList').map((list) => list.attrs?.['start'])).toEqual([1, 2, 3, 1]);
        expect(notes(json)).toEqual(['Note ↑']);
    });

    test('floating tables nest at most eight deep, each read once', async () => {
        const depth = 24;
        const open = '<w:tbl><w:tblPr><w:tblpPr w:tblpX="0"/></w:tblPr><w:tr><w:tc>';
        const body = `${open.repeat(depth)}${paragraph(run('Core'))}${'</w:tc></w:tr></w:tbl>'.repeat(depth)}`;
        const started = performance.now();
        const json = await imported(body);
        expect(performance.now() - started).toBeLessThan(1000);
        expect(nodesOfType(json, 'table')).toHaveLength(MAX_TABLE_DEPTH);
        expect(texts(json)).toEqual(['Core']);
    }, 20_000);

    test('a 10,000-deep basedOn chain costs each paragraph style no more than a short one', async () => {
        const count = 10_000;
        const styles = Array.from(
            { length: count },
            (_, index) =>
                `<w:style w:type="paragraph" w:styleId="s${index}">${index > 0 ? `<w:basedOn w:val="s${index - 1}"/>` : '<w:rPr><w:b/></w:rPr>'}</w:style>`,
        ).join('');
        const body = Array.from({ length: 300 }, (_, index) =>
            paragraph(run('Text'), `<w:pStyle w:val="s${count - 1 - index}"/>`),
        ).join('');
        const started = performance.now();
        const json = await imported(body, { styles });
        expect(performance.now() - started).toBeLessThan(2000);
        expect(nodesOfType(json, 'paragraph')).toHaveLength(300);
    }, 60_000);

    test('a 5,000-link numStyleLink chain is walked once, not per item', async () => {
        const links = 5000;
        const chain = Array.from({ length: links }, (_, index) => 10 + index);
        const numbering = chain
            .map(
                (id) =>
                    `<w:num w:numId="${id}"><w:abstractNumId w:val="${id}"/></w:num><w:abstractNum w:abstractNumId="${id}"><w:numStyleLink w:val="S${id}"/></w:abstractNum>`,
            )
            .join('');
        const styles = chain
            .map(
                (id) =>
                    `<w:style w:type="numbering" w:styleId="S${id}"><w:pPr><w:numPr><w:numId w:val="${id + 1}"/></w:numPr></w:pPr></w:style>`,
            )
            .join('');
        const body = paragraph(run('Item'), ordered(10)).repeat(10_000);
        const started = performance.now();
        await imported(body, { numbering, styles });
        expect(performance.now() - started).toBeLessThan(2000);
    }, 60_000);

    test('fields left open cost each run what one field does', async () => {
        const open = '<w:fldChar w:fldCharType="begin"/><w:fldChar w:fldCharType="separate"/>';
        const body = paragraph(`<w:r>${open.repeat(40_000)}${'<w:t>x</w:t>'.repeat(40_000)}</w:r>`);
        const started = performance.now();
        const json = await imported(body);
        expect(performance.now() - started).toBeLessThan(1000);
        expect(texts(json).join('')).toHaveLength(40_000);
    }, 60_000);
});

describe('values', () => {
    test.each(['red', '12345', 'GGGGGG', '000000', 'auto'])('w:color %s is no color', async (value) => {
        const json = await imported(paragraph(run('Text', `<w:color w:val="${value}"/>`)));
        expect(marksOfType(json, 'textStyle')).toEqual([]);
    });

    test('a six-hex w:color is a color', async () => {
        const json = await imported(paragraph(run('Text', '<w:color w:val="C0392B"/>')));
        expect(marksOfType(json, 'textStyle').map((mark) => mark.attrs['color'])).toEqual(['#c0392b']);
    });

    test.each(['purple', 'none', 'valueOf', 'hasOwnProperty', '__proto__'])(
        'w:highlight %s is no highlight',
        async (value) => {
            const json = await imported(paragraph(run('Text', `<w:highlight w:val="${value}"/>`)));
            expect(marksOfType(json, 'highlight')).toEqual([]);
        },
    );

    test('a named highlight and a six-hex shading are highlights', async () => {
        const json = await imported(
            paragraph(
                `${run('A', '<w:highlight w:val="green"/>')}${run('B', '<w:shd w:val="clear" w:fill="FFE4B5"/>')}`,
            ),
        );
        expect(marksOfType(json, 'highlight').map((mark) => mark.attrs['color'])).toEqual(['#00ff00', '#ffe4b5']);
    });

    test('a font that is no Eigen name gives no font', async () => {
        const json = await imported(paragraph(run('Text', '<w:rFonts w:ascii="Inter;x" w:hAnsi="Inter;x"/>')));
        expect(marksOfType(json, 'textStyle')).toEqual([]);
    });

    test.each([
        ['-5', 1],
        ['1e9', 1],
        ['32767', 32767],
        ['0', 0],
    ])('w:start %s starts the list at %d', async (start, expected) => {
        const json = await imported(paragraph(run('Item'), ordered(5)), { numbering: numberedFrom(start) });
        expect(nodesOfType(json, 'orderedList')[0]?.attrs?.['start']).toBe(expected);
    });

    test('a list that continues past 32,767 starts again at 1', async () => {
        const body = `${paragraph(run('Last'), ordered(5))}${paragraph(run('Between'))}${paragraph(run('Next'), ordered(5))}`;
        const json = await imported(body, { numbering: numberedFrom('32767') });
        expect(nodesOfType(json, 'orderedList').map((list) => list.attrs?.['start'])).toEqual([32767, 1]);
    });

    test('a column width stays between the narrowest column and the text column', async () => {
        const json = await imported(table([1, 99_999_999], [[cell('Thin'), cell('Wide')]]));
        expect(cells(json).map((node) => node.attrs?.['colwidth'])).toEqual([
            [MIN_TABLE_COLUMN_PX],
            [COLUMN_PX - MIN_TABLE_COLUMN_PX],
        ]);
    });

    test('an image width stays within the text column', async () => {
        const json = await imported(paragraph(picture('999999999999')));
        expect(nodesOfType(json, 'figure').map((node) => node.attrs?.['width'])).toEqual([COLUMN_PX]);
    });
});

describe('figures and media', () => {
    const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

    test('a figure names its media and carries no src', async () => {
        const { json, images } = await importDocxBody(paragraph(picture(381000)));
        expect(nodesOfType(json, 'figure').map((node) => [node.attrs?.['mediaName'], node.attrs?.['src']])).toEqual([
            ['image-1.png', null],
        ]);
        expect(images.map((image) => image.name)).toEqual(['image-1.png']);
    });

    // A file may hold 200 MB of media; each image is the bytes the zip read, not a copy of them.
    test('an image is a view of the bytes read, not a copy', async () => {
        const media = { 'word/media/pixel.png': new Uint8Array(64 * 1024).fill(1) };
        const golden = openZip(new Uint8Array(await buildDocxWithBody(paragraph(picture(381000)), { media })));
        const input = build(golden.names().map((name) => stored(name, golden.read(name) ?? new Uint8Array())));
        const { images } = await docxToPmJson(input);
        expect(images[0]?.data.buffer).toBe(input.buffer);
    });

    test('a part of a type no image has is not stored: the figure goes, its caption stays', async () => {
        const styles = '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/></w:style>';
        const { json, images } = await importDocxBody(
            `${paragraph(GOLDEN_DOCX_IMAGE_RUN.replace('rId4', 'rId9'))}${paragraph(run('Figure 1'), '<w:pStyle w:val="Caption"/>')}`,
            {
                styles,
                rels: `<Relationship Id="rId9" Type="${IMAGE_REL}" Target="media/page.png"/>`,
                contentTypes: '<Override PartName="/word/media/page.png" ContentType="text/html"/>',
                media: { 'word/media/page.png': new TextEncoder().encode('<script>alert(1)</script>') },
            },
        );
        expect(images).toEqual([]);
        expect(nodesOfType(json, 'figure')).toEqual([]);
        expect(nodesOfType(json, 'text').map((node) => node.text)).toEqual(['Figure 1']);
    });

    test('a linked picture is dropped, its alt text kept as text', async () => {
        const linked = GOLDEN_DOCX_IMAGE_RUN.replace('r:embed="rId4"', 'r:link="rId9"');
        const { json, images } = await importDocxBody(paragraph(linked), {
            rels: `<Relationship Id="rId9" Type="${IMAGE_REL}" Target="https://example.com/chart.png" TargetMode="External"/>`,
        });
        expect(images).toEqual([]);
        expect(nodesOfType(json, 'figure')).toEqual([]);
        expect(nodesOfType(json, 'text').map((node) => node.text)).toEqual(['A pixel']);
    });
});

describe('links', () => {
    const HYPERLINK = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
    const linked = (target: string) =>
        importDocxBody(paragraph(`<w:hyperlink r:id="rId9">${run('Link')}</w:hyperlink>`), {
            rels: `<Relationship Id="rId9" Type="${HYPERLINK}" Target="${target}" TargetMode="External"/>`,
        });

    test('a scheme the editor refuses links nowhere', async () => {
        const { json } = await linked('javascript:alert(1)');
        expect(marksOfType(json, 'link')).toEqual([]);
    });

    test.each([
        ['https://eigen.example/doc/x?y#z', '/doc/x?y#z'],
        ['https://eigen.example//evil.example/x', 'https://eigen.example//evil.example/x'],
        ['https://eigen.example/\\evil.example', 'https://eigen.example/\\evil.example'],
        ['https://elsewhere.example/doc/x', 'https://elsewhere.example/doc/x'],
    ])('with the instance origin, %s links to %s', async (target, href) => {
        const { json } = await importDocxBody(
            paragraph(`<w:hyperlink r:id="rId9">${run('Link')}</w:hyperlink>`),
            { rels: `<Relationship Id="rId9" Type="${HYPERLINK}" Target="${target}" TargetMode="External"/>` },
            { publicOrigin: 'https://eigen.example' },
        );
        expect(marksOfType(json, 'link').map((mark) => mark.attrs['href'])).toEqual([href]);
    });
});

// The measure behind the budget: a tree costs 20–40× its XML. Seconds of work, so on CI and locally on request.
const runSlow = Boolean(process.env['CI'] || process.env['EIGEN_SLOW_TESTS']);

// What a long report holds: headings, sentences in styled runs, links, lists two deep and tables, repeated up to
// whichever budget it meets first.
function honestBody(): string {
    const sentence = 'The committee reviewed the quarterly figures and agreed on the next steps for the project. ';
    const blocks = [
        paragraph(run('Section heading on the review'), '<w:pStyle w:val="Heading1"/>'),
        paragraph(
            `${run(sentence)}${run(sentence, '<w:b/>')}${run(sentence, '<w:i/><w:color w:val="C0392B"/>')}<w:hyperlink r:id="rId3">${run('the full minutes')}</w:hyperlink>${run(sentence)}`,
        ),
        paragraph(run(sentence), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),
        paragraph(run(sentence), ordered(2)),
        paragraph(run(sentence), ordered(2, 1)),
        table(
            [3000, 3000, 3000],
            [
                [cell(sentence), cell(sentence), cell(sentence)],
                [cell(sentence), cell(sentence), cell(sentence)],
            ],
        ),
    ].join('');
    const tags = blocks.split('<').length - 1;
    const margin = 0.98;
    return blocks.repeat(Math.floor(margin * Math.min(MAX_DOCX_XML_BYTES / blocks.length, MAX_DOCX_XML_TAGS / tags)));
}

describe.skipIf(!runSlow)('an honest document just under the budget', () => {
    const dir = mkdtempSync(join(tmpdir(), 'docx-budget-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    // A process of its own, so its peak RSS is the import's alone.
    const script = `
        const { docxToPmJson } = await import(process.env.READER);
        const bytes = Buffer.from(await Bun.file(process.env.DOCX).arrayBuffer());
        const peak = process.resourceUsage().maxRSS * 1024;
        const cpu = process.cpuUsage();
        const { json } = await docxToPmJson(bytes);
        const used = process.cpuUsage(cpu);
        console.log(JSON.stringify({
            blocks: json.content.length,
            rssGrowth: process.resourceUsage().maxRSS * 1024 - peak,
            cpuMs: (used.user + used.system) / 1000,
        }));
    `;

    // A Worker's stack takes a spread of no more than about 500,000 arguments.
    test('600,000 paragraphs inside one content control import in the Worker', async () => {
        const body = `<w:sdt><w:sdtContent>${'<w:p/>'.repeat(600_000)}</w:sdtContent></w:sdt>`;
        const response = await documentTransformRunner.run(
            {
                kind: 'import',
                sourceFormat: 'docx',
                targetType: 'eigendoc',
                publicOrigin: undefined,
                data: await buildDocxWithBody(body),
            },
            { ...TRANSFORM_LIMITS.import, priority: 'foreground' },
        );
        expect(response.ok || response.error).toBe(true);
    }, 120_000);

    test('imports within 1 GB of peak RSS and 10 s of CPU', async () => {
        const path = join(dir, 'report.docx');
        writeFileSync(path, new Uint8Array(await buildDocxWithBody(honestBody())));
        const child = Bun.spawnSync([process.execPath, '-e', script], {
            env: {
                ...process.env,
                READER: Bun.resolveSync('../../../lib/import/doc/from-docx', import.meta.dir),
                DOCX: path,
            },
        });
        expect(child.stderr.toString()).toBe('');
        const result: { blocks: number; rssGrowth: number; cpuMs: number } = JSON.parse(child.stdout.toString());
        expect(result.blocks).toBeGreaterThan(10_000);
        expect(result.rssGrowth).toBeLessThan(1024 * 1024 * 1024);
        expect(result.cpuMs).toBeLessThan(10_000);
    }, 120_000);
});
