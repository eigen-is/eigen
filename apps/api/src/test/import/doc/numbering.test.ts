import { describe, expect, test } from 'bun:test';
import type { JSONContent } from '@tiptap/core';
import { importDocxBody, nodesOfType } from '../../fixtures/golden-docx';

// Word's counters, in document order.

const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const numbered = (numId: number, text: string, ilvl = 0, pPr = '') =>
    `<w:p><w:pPr>${pPr}<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr>${run(text)}</w:p>`;
const plain = (text: string) => `<w:p>${run(text)}</w:p>`;
const level = (ilvl: number, format: string, text: string, extra = '') =>
    `<w:lvl w:ilvl="${ilvl}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${text}"/>${extra}</w:lvl>`;

const NUMBERING = `<w:abstractNum w:abstractNumId="10">${level(0, 'decimal', '%1.')}${level(1, 'decimal', '%1.%2.')}</w:abstractNum>
<w:abstractNum w:abstractNumId="11">${level(0, 'lowerLetter', '%1)')}</w:abstractNum>
<w:abstractNum w:abstractNumId="12">${level(0, 'upperRoman', '%1.')}</w:abstractNum>
<w:abstractNum w:abstractNumId="13">${level(0, 'none', '')}</w:abstractNum>
<w:num w:numId="10"><w:abstractNumId w:val="10"/></w:num>
<w:num w:numId="11"><w:abstractNumId w:val="10"/></w:num>
<w:num w:numId="12"><w:abstractNumId w:val="10"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>
<w:num w:numId="13"><w:abstractNumId w:val="11"/></w:num>
<w:num w:numId="14"><w:abstractNumId w:val="12"/></w:num>
<w:num w:numId="15"><w:abstractNumId w:val="13"/></w:num>`;

const imported = async (body: string) => (await importDocxBody(body, { numbering: NUMBERING })).json;
const lists = (json: JSONContent) =>
    nodesOfType(json, 'orderedList').map((list) => [
        list.attrs?.['start'],
        list.attrs?.['type'],
        (list.content ?? []).length,
    ]);

describe('counters', () => {
    test('lists sharing a definition continue across a paragraph between them', async () => {
        const json = await imported(
            [numbered(10, 'One'), numbered(10, 'Two'), plain('Between'), numbered(11, 'Three')].join(''),
        );
        expect(lists(json)).toEqual([
            [1, null, 2],
            [3, null, 1],
        ]);
    });

    test('a start override restarts the shared counter once', async () => {
        const json = await imported(
            [numbered(10, 'One'), numbered(10, 'Two'), plain('Between'), numbered(12, 'One'), numbered(12, 'Two')].join(
                '',
            ),
        );
        expect(lists(json)).toEqual([
            [1, null, 2],
            [1, null, 2],
        ]);
    });

    test('letters and roman numerals keep their type', async () => {
        const json = await imported([numbered(13, 'a'), plain('Between'), numbered(14, 'I')].join(''));
        expect(lists(json)).toEqual([
            [1, 'a', 1],
            [1, 'I', 1],
        ]);
    });

    // A plain object would read the prototype's constructor as a type.
    test('a format named after an object key is a decimal list', async () => {
        const numbering = `<w:abstractNum w:abstractNumId="1">${level(0, 'constructor', '%1.')}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>`;
        expect(lists((await importDocxBody(numbered(1, 'One'), { numbering })).json)).toEqual([[1, null, 1]]);
    });

    test('a level numbered none is no list', async () => {
        expect(lists(await imported(numbered(15, 'Plain')))).toEqual([]);
    });

    // The schema holds no numbered heading, so its label is text, as Word draws it.
    test('a numbered heading keeps its label as text', async () => {
        const heading = '<w:pStyle w:val="Heading1"/>';
        const json = await imported(
            [
                numbered(10, 'Intro', 0, heading),
                numbered(10, 'Scope', 1, heading),
                numbered(10, 'Method', 0, heading),
            ].join(''),
        );
        expect(nodesOfType(json, 'heading').map((node) => nodesOfType(node, 'text')[0]?.text)).toEqual([
            '1. Intro',
            '1.1. Scope',
            '2. Method',
        ]);
    });
});
