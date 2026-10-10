import { describe, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { Editor, type JSONContent } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { fixTables, TableMap } from '@tiptap/pm/tables';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { ApiError } from '../../../lib/core/errors';
import { docExtensions, docSchema } from '../../../lib/document/doc-schema';
import { asOpened, importDocxToEigendocUpdate, MAX_TABLE_REPAIRS } from '../../../lib/import/doc/transform';
import { buildDocxWithBody, nodesOfType } from '../../fixtures/golden-docx';

// An imported doc is stored as the editor leaves it on open: a first open that pads a table or appends a paragraph
// writes Yjs updates nobody typed, and two people opening it together write them twice.

const editor = new Editor({ extensions: docExtensions(), content: { type: 'doc', content: [] } });

function stored(data: ArrayBuffer): JSONContent {
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, new Uint8Array(importDocxToEigendocUpdate(data, undefined).update));
    return yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment('default'), editor.schema).toJSON();
}

// The doc after the editor's plugins have seen it arrive, as the Yjs binding's first sync hands it over.
function opened(json: JSONContent): JSONContent {
    const empty = EditorState.create({ schema: editor.schema, plugins: editor.extensionManager.plugins });
    const content = editor.schema.nodeFromJSON(json).content;
    return empty.applyTransaction(empty.tr.replaceWith(0, empty.doc.content.size, content)).state.doc.toJSON();
}

const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const paragraph = (inner: string, pPr = '') => `<w:p>${pPr && `<w:pPr>${pPr}</w:pPr>`}${inner}</w:p>`;
const cell = (text: string) => `<w:tc>${paragraph(run(text))}</w:tc>`;
const grid = '<w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>';
const table = (rows: string[]) => `<w:tbl>${grid}${rows.map((cells) => `<w:tr>${cells}</w:tr>`).join('')}</w:tbl>`;
const bullet = (text: string) => paragraph(run(text), '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>');

describe('an imported doc is stored as the editor leaves it on open', () => {
    test('a row Word draws short of the grid ends in a cell over the columns it misses, with their widths', async () => {
        const json = stored(
            await buildDocxWithBody(
                `${table([cell('A') + cell('B') + cell('C'), cell('D')])}${paragraph(run('After.'))}`,
            ),
        );
        expect(nodesOfType(json, 'tableRow').map((row) => row.content?.length)).toEqual([3, 2]);
        expect(opened(json)).toEqual(json);
    });

    test('a doc ending in a list ends with an empty paragraph after it', async () => {
        const json = stored(await buildDocxWithBody(`${paragraph(run('Before.'))}${bullet('One')}${bullet('Two')}`));
        expect((json.content ?? []).map((node) => node.type)).toEqual(['paragraph', 'bulletList', 'paragraph']);
        expect(opened(json)).toEqual(json);
    });

    test('a doc ending in a table ends with an empty paragraph after it', async () => {
        const json = stored(await buildDocxWithBody(table([cell('A') + cell('B') + cell('C')])));
        expect((json.content ?? []).map((node) => node.type)).toEqual(['table', 'paragraph']);
        expect(opened(json)).toEqual(json);
    });

    test.each([
        'docx4j-loadAndSave.docx',
        'govuk-Application_for_Approval_as_a_Community_Sponsor.docx',
        'lo-ooxmlexport-tdf126287.docx',
        'lo-ooxmlimport-tdf136952_pgBreak3.docx',
        'mammoth-text-box.docx',
        'poi-Numbering.docx',
        'poi-delins.docx',
        'poi-rtl.docx',
        'google-docs-all-features.docx',
    ])('%s', async (name) => {
        const json = stored(await Bun.file(join(import.meta.dir, '../../fixtures/docx', name)).arrayBuffer());
        expect(opened(json)).toEqual(json);
    });
});

// The reader opens its tables itself; fixTables, the safety net, keeps a copy of the table per repair.
describe('the repairs on open are bounded', () => {
    const cell = { type: 'tableCell', content: [{ type: 'paragraph' }] };
    // Every row but the first a cell short: a repair per row.
    const ragged = (rows: number) =>
        docSchema().nodeFromJSON({
            type: 'doc',
            content: [
                {
                    type: 'table',
                    content: Array.from({ length: rows }, (_, index) => ({
                        type: 'tableRow',
                        content: index === 0 ? [cell, cell] : [cell],
                    })),
                },
            ],
        });
    const side = Math.floor(Math.sqrt(MAX_TABLE_REPAIRS));

    test('a table with repairs times rows within the bound is repaired', () => {
        const doc = asOpened(ragged(side));
        expect(nodesOfType(doc.toJSON(), 'tableRow').every((row) => row.content?.length === 2)).toBe(true);
    });

    test('a table past it is 413', () => {
        expect(() => asOpened(ragged(side + 2))).toThrow('Document too large');
    });

    const stacked = (rows: [number, number][]) =>
        docSchema().nodeFromJSON({
            type: 'doc',
            content: [
                {
                    type: 'table',
                    content: rows.map(([colspan, rowspan]) => ({
                        type: 'tableRow',
                        content: [{ ...cell, attrs: { colspan, rowspan } }],
                    })),
                },
            ],
        });

    test('a table one pass repairs is repaired', () => {
        const doc = asOpened(
            stacked([
                [1, 2],
                [2, 2],
            ]),
        );
        expect(fixTables(EditorState.create({ doc }))).toBeUndefined();
    });

    // A pass's collisions can leave new ones, as colspan x rowspan: this one repairs in two.
    test('a table a second pass would repair is 413', () => {
        expect(() =>
            asOpened(
                stacked([
                    [1, 2],
                    [1, 2],
                    [2, 1],
                ]),
            ),
        ).toThrow('Document too large');
    });
});

// What converting the doc throws is mapped as the reader's throws are.
describe('a slip converting the doc is refused as the reader refuses one', () => {
    test.each([
        ['a TypeError', new TypeError('slip'), 400, 'Not a valid docx file', 1],
        ['a stack overflow', new RangeError('Maximum call stack size exceeded.'), 413, 'Document too large', 0],
        ['an allocation past memory', new RangeError('Out of memory'), 413, 'Document too large', 0],
        ['a schema RangeError', new RangeError('Invalid content for node table'), 400, 'Not a valid docx file', 1],
    ])('%s is a %d', async (_name, thrown, status, message, logged) => {
        const docx = await buildDocxWithBody(table([cell('A') + cell('B') + cell('C')]));
        const slip = spyOn(TableMap, 'get').mockImplementationOnce(() => {
            throw thrown;
        });
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const error = await Promise.resolve()
                .then(() => importDocxToEigendocUpdate(docx, undefined))
                .catch((reason: unknown) => reason);
            expect(error).toBeInstanceOf(ApiError);
            expect(error).toMatchObject({ status, message });
            expect(warn).toHaveBeenCalledTimes(logged);
        } finally {
            slip.mockRestore();
            warn.mockRestore();
        }
    });
});
