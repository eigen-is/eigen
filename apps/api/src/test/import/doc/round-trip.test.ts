import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { JSONContent } from '@tiptap/core';
import { docSchema } from '../../../lib/document/doc-schema';
import { eigendocToDocx } from '../../../lib/export/doc/to-docx';
import { type DocxImage, docxToPmJson } from '../../../lib/import/doc/from-docx';
import { buildAllFeaturesDocJson, buildAllFeaturesDocMedia } from '../../fixtures/golden-documents';

// Eigen → docx → Eigen loses nothing the schema holds, except exactly what the list below names.

const ORIGIN = 'https://eigen.example';

type Mark = NonNullable<JSONContent['marks']>[number];

// Each imported media name is the source's whose bytes it holds.
function sourceNames(images: DocxImage[]): Map<string, string> {
    const media = buildAllFeaturesDocMedia();
    return new Map(
        images.flatMap((image) => {
            const source = media.find((item) => Buffer.from(item.data).equals(image.data));
            return source ? [[image.name, source.name]] : [];
        }),
    );
}

// The source as the import gives it back. (1) R5: no comment marks and no figure comment card. (2) The writer gives a
// column or an image without a width the one it lays it out at. (3) Media are named by order, matched here by bytes.
// (4) R1: left is no alignment. (5) R2: black is no color. (6) Ruling: the writer percent-encodes a space in an href.
// (7) OWNER: a run of empty paragraphs right before a page break goes.
function expected(source: JSONContent, imported: JSONContent | undefined): JSONContent {
    const attrs = source.attrs && { ...source.attrs };
    if (attrs) {
        for (const name of ['colwidth', 'width'])
            if (name in attrs && attrs[name] === null) attrs[name] = imported?.attrs?.[name] ?? null;
        if ('commentCardId' in attrs) attrs['commentCardId'] = null;
        if (attrs['textAlign'] === 'left') attrs['textAlign'] = null;
    }
    const marks = source.marks?.flatMap((mark): Mark[] => {
        if (mark.type === 'comment') return [];
        if (mark.type === 'link' && typeof mark.attrs?.['href'] === 'string')
            return [{ ...mark, attrs: { ...mark.attrs, href: mark.attrs['href'].replaceAll(' ', '%20') } }];
        if (mark.type === 'textStyle' && mark.attrs?.['color'] === '#000000') {
            return mark.attrs['fontFamily'] ? [{ ...mark, attrs: { ...mark.attrs, color: null } }] : [];
        }
        return [mark];
    });
    const kept = source.content?.filter((_, index, siblings) => !blankBeforeBreak(siblings, index));
    const content = kept?.map((child, index) => expected(child, imported?.content?.[index]));
    return {
        ...source,
        ...(attrs && { attrs }),
        ...(marks && (marks.length > 0 ? { marks } : { marks: undefined })),
        ...(content && { content }),
    };
}

function blankBeforeBreak(siblings: JSONContent[], index: number): boolean {
    const next = siblings
        .slice(index)
        .find((sibling) => sibling.type !== 'paragraph' || (sibling.content ?? []).length > 0);
    return siblings[index]?.type === 'paragraph' && next?.type === 'pageBreak';
}

function withSourceNames(node: JSONContent, names: Map<string, string>): JSONContent {
    const mediaName = node.attrs?.['mediaName'];
    return {
        ...node,
        ...(typeof mediaName === 'string' && {
            attrs: { ...node.attrs, mediaName: names.get(mediaName) ?? mediaName },
        }),
        ...(node.content && { content: node.content.map((child) => withSourceNames(child, names)) }),
    };
}

// JSON round trips drop undefined keys, so both sides compare as stored.
const stored = (json: JSONContent): JSONContent => JSON.parse(JSON.stringify(json));

describe('the all-features doc', () => {
    test('comes back as it was written, but for the named differences', async () => {
        const source = docSchema().nodeFromJSON(buildAllFeaturesDocJson()).toJSON();
        const docx = await eigendocToDocx(
            buildAllFeaturesDocJson(),
            buildAllFeaturesDocMedia(),
            'All features',
            ORIGIN,
        );
        const { json, images } = docxToPmJson(Buffer.from(docx), { publicOrigin: ORIGIN });
        const imported = withSourceNames(json, sourceNames(images));
        expect(stored(imported)).toEqual(stored(expected(source, imported)));
    });
});

const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const quote = (...content: JSONContent[]) => ({ type: 'blockquote', content });
const code = (text: string) => ({
    type: 'codeBlock',
    attrs: { language: 'javascript' },
    content: [{ type: 'text', text }],
});
const rule = { type: 'horizontalRule' };
const pageBreak = { type: 'pageBreak' };
const table = {
    type: 'table',
    content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [p('Cell')] }] }],
};
const ordered = (...items: JSONContent[][]) => ({
    type: 'orderedList',
    attrs: { start: 1, type: null },
    content: items.map((content) => ({ type: 'listItem', content })),
});
const bullets = (...items: JSONContent[][]) => ({
    type: 'bulletList',
    content: items.map((content) => ({ type: 'listItem', content })),
});
const tasks = (...items: JSONContent[][]) => ({
    type: 'taskList',
    content: items.map((content) => ({ type: 'taskItem', attrs: { checked: false }, content })),
});

// The source as the schema stores it, and what an import of its docx gives back.
async function roundTrip(content: JSONContent[]): Promise<{ source: JSONContent; json: JSONContent }> {
    const source = docSchema().nodeFromJSON({ type: 'doc', content }).toJSON();
    const { json } = docxToPmJson(Buffer.from(await eigendocToDocx(source, [], 'Nested', undefined)));
    return { source, json };
}

// The writer keeps a block's container as its indent, so each comes back inside it.
describe('a block inside a list item or a quote', () => {
    test.each<[string, JSONContent[]]>([
        [
            'a quote in an item and in a nested item, two deep',
            [ordered([p('One'), quote(p('Said'), quote(p('Deeper')))], [p('Two')]), quote(p('After the list'))],
        ],
        ['code in an item', [ordered([p('One'), code('one()')], [p('Two')])]],
        ['a rule in an item, and a quote after it', [ordered([p('One'), rule, quote(p('Said'))], [p('Two')])]],
        [
            'code and a rule in a nested item',
            [ordered([p('One'), ordered([p('One a'), code('a()'), rule], [p('One b')])], [p('Two')])],
        ],
        ['code in a quote', [quote(p('Said'), code('said()'), p('Done'))]],
        ['code in a quote in an item', [ordered([p('One'), quote(p('Said'), code('said()'))], [p('Two')])]],
        ['code opening a quote in an item', [ordered([p('One'), quote(code('said()'), p('Done'))], [p('Two')])]],
        ['code in an item in a quote', [quote(p('Said'), ordered([p('One'), code('one()')]), p('Done'))]],
        [
            'code at the margin after a list, then a quote two deep',
            [bullets([p('One')]), code('x()'), quote(quote(p('Deep')))],
        ],
        [
            'code and a rule at the margin after a list, code in its last item',
            [ordered([p('One'), code('in()')]), code('after()'), ordered([p('Two')]), rule],
        ],
        ['a quote in an item in a quote', [quote(p('Said'), ordered([p('One'), quote(p('Inner'))]), p('Done'))]],
        [
            'code opening a quote in an item in a quote',
            [quote(p('Said'), ordered([p('One'), quote(code('inner()'), p('Inner'))]), p('Done'))],
        ],
        ['a rule in a quote', [quote(p('Said'), rule, p('Done'))]],
        ['a rule in a quote two deep', [quote(p('Said'), quote(p('Deep'), rule, p('Deeper')), p('Done'))]],
        ['a table in a quote', [quote(p('Said'), table, p('Done'))]],
        ['a table in a quote two deep', [quote(quote(p('Deep'), table))]],
        ['a page break after a table in a quote', [quote(p('Said'), table, pageBreak, p('Done'))]],
        ['a table in an item in a quote', [quote(ordered([p('One'), table]))]],
        ['a rule and a paragraph in an item in a quote', [quote(bullets([p('One'), rule, p('More')]))]],
        ['a table and a rule in a quote in an item', [bullets([p('One'), quote(p('Said'), table, rule)])]],
        ['a list opening a quote in a quote', [quote(p('Said'), quote(bullets([p('One')])))]],
        ['a list in a quote two deep, then a paragraph', [quote(quote(ordered([p('One')])), p('Done'))]],
        ['a quote opening with a list in an item', [bullets([p('One'), quote(ordered([p('Two')]))])]],
        ["a quote after an item's second paragraph", [bullets([p('One'), p('More'), quote(p('Said'))], [p('Two')])]],
        ['a quote holding a list of two in an item', [bullets([p('One'), quote(bullets([p('a')], [p('b')]))])]],
        [
            'a quote holding a paragraph and a list of two in an item',
            [bullets([p('One'), quote(p('Said'), bullets([p('a')], [p('b')]))])],
        ],
        [
            'a quote holding an item of two paragraphs in an item',
            [bullets([p('One'), quote(bullets([p('a'), p('More')]))], [p('Two')])],
        ],
        ['code after a nested list', [ordered([p('One'), bullets([p('a')]), code('one()')], [p('Two')])]],
        ['code after a nested task list', [ordered([p('One'), tasks([p('a')]), code('one()')], [p('Two')])]],
        ['a quote after a nested list', [bullets([p('One'), ordered([p('a')]), quote(p('Said'))], [p('Two')])]],
        [
            'a quote opening with a list after a nested list',
            [bullets([p('One'), ordered([p('a')]), quote(bullets([p('Said')]))], [p('Two')])],
        ],
        ['a paragraph after a nested list in a quote', [quote(ordered([p('One'), bullets([p('a')]), p('More')]))]],
        ['a rule after a nested list in a quote', [quote(ordered([p('One'), bullets([p('a')]), rule]))]],
        ['a table after a nested list in a quote', [quote(ordered([p('One'), bullets([p('a')]), table]))]],
        ['code after a nested list in a quote', [quote(ordered([p('One'), bullets([p('a')]), code('one()')]))]],
        ['a quote after a nested list in a quote', [quote(ordered([p('One'), bullets([p('a')]), quote(p('Said'))]))]],
    ])('%s', async (_name, content) => {
        const { source, json } = await roundTrip(content);
        expect(stored(json)).toEqual(stored(expected(source, json)));
    });
});

// The writer gives each list its own w:num, so lists side by side stay apart.
describe('lists side by side', () => {
    test.each<[string, JSONContent[]]>([
        ['two bullet lists', [bullets([p('One')]), bullets([p('Two')])]],
        ['two bullet lists in an item', [ordered([p('One'), bullets([p('a')]), bullets([p('b')])])]],
        ['a bullet and an ordered list across a page break', [bullets([p('One')]), pageBreak, ordered([p('Two')])]],
        ['two bullet lists across a page break', [bullets([p('One')]), pageBreak, bullets([p('Two')])]],
    ])('%s come back apart', async (_name, content) => {
        const { source, json } = await roundTrip(content);
        expect(stored(json)).toEqual(stored(expected(source, json)));
    });
});

// The writer sets a task's checkbox at its container's text, so its quotes count from there.
describe('a task list in a quote', () => {
    test.each<[string, JSONContent[]]>([
        ['after a quote in the quote', [quote(p('Said'), quote(p('Deep')), tasks([p('Task')]))]],
        ['two deep', [quote(quote(tasks([p('Task')]))), p('Done')]],
        ['in an item', [bullets([p('One'), quote(tasks([p('Task')]))], [p('Two')])]],
        ['after a paragraph in an item', [bullets([p('One'), quote(p('Said'), tasks([p('Task')]))])]],
        ['in a task', [tasks([p('One'), quote(tasks([p('Task')]))])]],
        ['nested in a list', [quote(bullets([p('One'), tasks([p('Task')])]))]],
        ['nested in a list after a deeper quote', [quote(quote(p('Deep')), bullets([p('One'), tasks([p('Task')])]))]],
    ])('%s comes back as written', async (_name, content) => {
        const { source, json } = await roundTrip(content);
        expect(stored(json)).toEqual(stored(expected(source, json)));
    });
});

// The writer sets a Spacer between two boxes, code or a quote, which stands in the quote around them.
describe('boxes side by side in a quote', () => {
    test.each<[string, JSONContent[]]>([
        ['two code blocks', [quote(p('Said'), code('one()'), code('two()'), p('Done'))]],
        ['a quote and code', [quote(quote(p('Deep')), code('one()'))]],
        ['code and a quote', [quote(code('one()'), quote(p('Deep')))]],
        ['two code blocks two deep', [quote(quote(code('one()'), code('two()')))]],
        ['two code blocks in a quote in an item', [bullets([p('One'), quote(code('one()'), code('two()'))])]],
        ['a quote, then a quote opening with code', [quote(p('Said')), quote(code('one()'))]],
        ['a quote ending in code, then a quote', [quote(code('one()')), quote(p('Said'))]],
        ['two code blocks at the margin', [code('one()'), code('two()')]],
    ])('%s come back as written', async (_name, content) => {
        const { source, json } = await roundTrip(content);
        expect(stored(json)).toEqual(stored(expected(source, json)));
    });
});

// The writer sets a page break at the margin, so the block after it says which item holds it.
describe('a page break in an item', () => {
    test.each<[string, JSONContent[]]>([
        ['before a nested list', [ordered([p('One'), pageBreak, bullets([p('a')])], [p('Two')])]],
        [
            'before a paragraph after a nested list',
            [bullets([p('One'), ordered([p('a')]), pageBreak, p('More')], [p('Two')])],
        ],
        ['before code', [ordered([p('One'), pageBreak, code('one()')], [p('Two')])]],
        ['before a rule', [ordered([p('One'), pageBreak, rule], [p('Two')])]],
        ['before a quote', [ordered([p('One'), pageBreak, quote(p('Said'))], [p('Two')])]],
        ['before a table', [ordered([p('One'), pageBreak, table], [p('Two')])]],
        ['between two tasks', [tasks([p('One'), pageBreak], [p('Two')])]],
    ])('%s stays in the item', async (_name, content) => {
        const { source, json } = await roundTrip(content);
        expect(stored(json)).toEqual(stored(expected(source, json)));
    });
});

// The Hyperlink style draws the editor's link look; a link's own color and underline are the author's.
describe("a link's own look", () => {
    const link = { type: 'link', attrs: { href: 'https://example.com/', title: null } };
    test.each<[string, Mark]>([
        ['a color', { type: 'textStyle', attrs: { color: '#ff0000', fontFamily: null } }],
        ['an underline', { type: 'underline' }],
    ])('%s comes back', async (_name, mark) => {
        const { source, json } = await roundTrip([
            { type: 'paragraph', content: [{ type: 'text', text: 'Link', marks: [link, mark] }] },
        ]);
        expect(stored(json)).toEqual(stored(expected(source, json)));
    });
});

// Google Docs drops every custom style, so the code block's language; a page break in a table cell; a link's title.
// It keeps one placeholder for the export's media, so names don't say which image is which. The recording predates
// caps.
function googleLosses(node: JSONContent, imported: JSONContent | undefined): JSONContent {
    const content = node.content
        ?.filter((child) => !(child.type === 'pageBreak' && (node.type === 'tableCell' || node.type === 'tableHeader')))
        .map((child, index) => googleLosses(child, imported?.content?.[index]));
    const attrs = node.attrs && {
        ...node.attrs,
        ...(node.type === 'codeBlock' && { language: null }),
        ...(node.type === 'figure' && { mediaName: imported?.attrs?.['mediaName'] }),
    };
    const marks = node.marks?.map((mark) =>
        mark.type === 'link'
            ? { ...mark, attrs: { ...mark.attrs, title: null } }
            : mark.type === 'textStyle'
              ? { ...mark, attrs: { ...mark.attrs, caps: null } }
              : mark,
    );
    return { ...node, ...(attrs && { attrs }), ...(marks && { marks }), ...(content && { content }) };
}

describe("the all-features doc's Google Docs re-save", () => {
    test('comes back as written, but for the named differences and what Google Docs drops', async () => {
        const bytes = await Bun.file(
            join(import.meta.dir, '../../fixtures/docx/google-docs-all-features.docx'),
        ).arrayBuffer();
        const { json } = docxToPmJson(Buffer.from(bytes), { publicOrigin: ORIGIN });
        const source = docSchema().nodeFromJSON(buildAllFeaturesDocJson()).toJSON();
        expect(stored(json)).toEqual(stored(googleLosses(expected(source, json), json)));
    });
});
