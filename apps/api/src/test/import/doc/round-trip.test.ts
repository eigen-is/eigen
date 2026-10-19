import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JSONContent } from '@tiptap/core';
import { sampleChartSpec } from '@workspace/lib/charts';
import { DEFAULT_NORMAL_STYLE, DEFAULT_PAGE_SETUP } from '@workspace/lib/docs/eigendoc';
import { readOmml, writeMathml } from '@workspace/math';
import { M_NS, parseOoxml, W_NS } from '../../../lib/core/ooxml';
import { xmlChild, xmlChildren, xmlElements } from '../../../lib/core/xml';
import { openZip } from '../../../lib/core/zip';
import { docSchema } from '../../../lib/document/doc-schema';
import { readStoredEquation } from '../../../lib/document/equation';
import { HEADER_CELL_LOOK, HEADING_LOOKS, SMALL_LOOK } from '../../../lib/document/looks';
import { chartFigureMedia, eigendocToDocx } from '../../../lib/export/doc/to-docx';
import { withSvgFallbacks } from '../../../lib/export/office-image';
import { type DocxImage, docxToPmJson } from '../../../lib/import/doc/from-docx';
import { buildAllFeaturesDocJson, buildAllFeaturesDocMedia } from '../../fixtures/golden-documents';
import { importDocxBody } from '../../fixtures/golden-docx';

// Eigen → docx → Eigen loses nothing the schema holds, except exactly what the list below names.

const HEADER_GREY = `#${HEADER_CELL_LOOK.fill.toLowerCase()}`;

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
// (7) OWNER: a run of empty paragraphs right before a page break goes. (8) The fixture's media holds no chart drawing,
// which the transform process makes, so a chart writes nothing; 'a chart' round-trips one. (9) Small is written as its
// look and comes back as that size. (10) OMML has no slot for the typed LaTeX. (11) In Word a display equation is a
// paragraph of its own, and every piece but the last keeps the writer's no space after, so the pieces draw as one
// paragraph. (12) A header cell beside a body cell is marked by the Table Header style on its plain paragraphs, so
// one holding none, only quotes, code, headings, rules or done tasks, comes back a body cell in the header's grey.
function expected(source: JSONContent, imported: JSONContent | undefined): JSONContent {
    const attrs = source.attrs && { ...source.attrs };
    if (attrs) {
        for (const name of ['colwidth', 'width'])
            if (name in attrs && attrs[name] === null) attrs[name] = imported?.attrs?.[name] ?? null;
        if ('commentCardId' in attrs) attrs['commentCardId'] = null;
        if (attrs['textAlign'] === 'left') attrs['textAlign'] = null;
        if (source.type === 'equation') attrs['mathml'] = writeMathml(readStoredEquation(attrs).row);
    }
    const small = source.marks?.some((mark) => mark.type === 'small');
    const styled = source.marks?.some((mark) => mark.type === 'textStyle');
    const smallSize = (attrs: Mark['attrs']): Mark => ({
        type: 'textStyle',
        attrs: { color: null, fontFamily: null, caps: null, ...attrs, fontSize: SMALL_LOOK.sizePt },
    });
    const marks = source.marks?.flatMap((mark): Mark[] => {
        if (mark.type === 'comment') return [];
        // Small's rank is right before textStyle's, so its place in the marks is the size's.
        if (mark.type === 'small') return styled ? [] : [smallSize({})];
        if (mark.type === 'textStyle' && small) return [smallSize(mark.attrs)];
        if (mark.type === 'link' && typeof mark.attrs?.['href'] === 'string')
            return [{ ...mark, attrs: { ...mark.attrs, href: mark.attrs['href'].replaceAll(' ', '%20') } }];
        if (mark.type === 'textStyle' && mark.attrs?.['color'] === '#000000') {
            return mark.attrs['fontFamily'] ? [{ ...mark, attrs: { ...mark.attrs, color: null } }] : [];
        }
        return [mark];
    });
    const mixed = source.type === 'tableRow' && source.content?.some((cell) => cell.type === 'tableCell');
    const kept = source.content
        ?.filter((child, index, siblings) => child.type !== 'chart' && !blankBeforeBreak(siblings, index))
        .flatMap(splitAtDisplayEquations)
        .map((child) =>
            mixed && child.type === 'tableHeader' && !child.content?.some(isPlain) ? asBodyCell(child) : child,
        );
    const content = kept?.map((child, index) => expected(child, imported?.content?.[index]));
    return {
        ...source,
        ...(attrs && { attrs }),
        ...(marks && (marks.length > 0 ? { marks } : { marks: undefined })),
        ...(content && { content }),
    };
}

const isPlain = (block: JSONContent): boolean =>
    ['paragraph', 'bulletList', 'orderedList'].includes(block.type ?? '') ||
    (block.type === 'taskList' && !!block.content?.some((item) => !item.attrs?.['checked']));

const asBodyCell = (cell: JSONContent): JSONContent => ({
    ...cell,
    type: 'tableCell',
    attrs: { ...cell.attrs, backgroundColor: cell.attrs?.['backgroundColor'] ?? HEADER_GREY },
});

const isDisplayEquation = (node: JSONContent) => node.type === 'equation' && node.attrs?.['display'] === true;

function splitAtDisplayEquations(node: JSONContent): JSONContent[] {
    if (!node.content?.some(isDisplayEquation)) return [node];
    const pieces: JSONContent[][] = [[]];
    for (const child of node.content) {
        if (isDisplayEquation(child)) pieces.push([child], []);
        else pieces.at(-1)?.push(child);
    }
    return pieces
        .filter((piece) => piece.length > 0)
        .map((content, index, all) =>
            index < all.length - 1
                ? { ...node, attrs: { ...node.attrs, spaceAfter: 0 }, content }
                : { ...node, content },
        );
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
            {},
            DEFAULT_PAGE_SETUP,
            DEFAULT_NORMAL_STYLE,
            buildAllFeaturesDocMedia(),
            'All features',
            ORIGIN,
        );
        const { json, images } = docxToPmJson(Buffer.from(docx), { publicOrigin: ORIGIN });
        const imported = withSourceNames(json, sourceNames(images));
        expect(stored(imported)).toEqual(stored(expected(source, imported)));
    });
});

describe('a chart', () => {
    test('comes back as an image of its SVG, at its width, its title its alt, its caption and layout kept', async () => {
        const spec = JSON.stringify(sampleChartSpec('column'));
        const chart = {
            type: 'chart',
            attrs: { spec, width: 480, height: 300, caption: 'Points', layout: 'wrap-left' },
        };
        const source = { type: 'doc', content: [{ type: 'paragraph', content: [chart] }] };
        const media = await withSvgFallbacks(await chartFigureMedia([source]));
        const docx = await eigendocToDocx(source, {}, DEFAULT_PAGE_SETUP, DEFAULT_NORMAL_STYLE, media, 'Chart', ORIGIN);
        const { json, images } = docxToPmJson(Buffer.from(docx), { publicOrigin: ORIGIN });
        expect(json.content?.[0]?.content).toEqual([
            {
                type: 'figure',
                attrs: {
                    mediaName: 'image-1.svg',
                    src: null,
                    alt: 'Points scored',
                    caption: 'Points',
                    commentCardId: null,
                    width: 480,
                    alignment: 'center',
                    layout: 'wrap-left',
                },
            },
        ]);
        expect(images.map((image) => image.contentType)).toEqual(['image/svg+xml']);
    });
});

describe('the page', () => {
    test('Letter landscape with 1 cm margins comes back as it was written, within a twip', async () => {
        const page = {
            width: 279.4,
            height: 215.9,
            margin: { top: 10, right: 10, bottom: 10, left: 10 },
            differentFirstPage: false,
        };
        const source = buildAllFeaturesDocJson();
        const { page: read } = docxToPmJson(
            Buffer.from(await eigendocToDocx(source, {}, page, DEFAULT_NORMAL_STYLE, [], 'Letter', undefined)),
        );
        expect(read.width).toBe(279.4);
        expect(read.height).toBe(215.9);
        for (const side of ['top', 'right', 'bottom', 'left'] as const) expect(read.margin[side]).toBeCloseTo(10, 2);
        expect(read.differentFirstPage).toBe(false);
    });

    // Each band comes back where it was, page numbers as fields and an equation as Word's; page 1's footer is the empty
    // part the writer stands in.
    test("the header, the footer and page 1's own header come back as they were written", async () => {
        const number = (kind: string) => ({ type: 'pageNumber', attrs: { kind } });
        const equation = { type: 'equation', attrs: { mathml: writeMathml([{ kind: 'identifier', text: 'y' }]) } };
        const bands = {
            header: {
                type: 'doc',
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Acme ' }, equation] }],
            },
            footer: {
                type: 'doc',
                content: [
                    {
                        type: 'paragraph',
                        content: [
                            { type: 'text', text: 'Page ' },
                            number('page'),
                            { type: 'text', text: ' of ' },
                            number('pages'),
                        ],
                    },
                ],
            },
            headerFirst: { type: 'doc', content: [p('Letterhead')] },
        };
        const docx = await eigendocToDocx(
            { type: 'doc', content: [p('Body')] },
            bands,
            { ...DEFAULT_PAGE_SETUP, differentFirstPage: true },
            DEFAULT_NORMAL_STYLE,
            [],
            'Bands',
            undefined,
        );
        const { bands: read, page } = docxToPmJson(Buffer.from(docx));
        expect(page.differentFirstPage).toBe(true);
        expect(Object.keys(read)).toEqual(['header', 'footer', 'headerFirst']);
        for (const root of ['header', 'footer', 'headerFirst'] as const)
            expect(stored(read[root] ?? {})).toEqual(stored(docSchema().nodeFromJSON(bands[root]).toJSON()));
    });
});

describe('the Normal', () => {
    // Every key apart from Eigen's.
    const normal = {
        font: 'Source Serif 4',
        size: 12,
        lineSpacing: 1,
        spaceBefore: 6,
        spaceAfter: 0,
        color: '#000000',
    };

    test("docDefaults and the Normal style come back as the doc's Normal, and what sets a paragraph or a run apart stays", async () => {
        const text = (value: string, marks?: Mark[]): JSONContent => ({ type: 'text', text: value, marks });
        const source = docSchema()
            .nodeFromJSON({
                type: 'doc',
                content: [
                    { type: 'paragraph', content: [text('Plain')] },
                    { type: 'paragraph', attrs: { lineSpacing: 1.5, spaceAfter: 12 }, content: [text('Spaced')] },
                    {
                        type: 'paragraph',
                        content: [
                            text('Sans', [{ type: 'textStyle', attrs: { fontFamily: 'Inter' } }]),
                            text(' big', [{ type: 'textStyle', attrs: { fontSize: 14 } }]),
                        ],
                    },
                ],
            })
            .toJSON();
        // A header is a part of its own over the same styles.xml, so its text draws in the Normal with no marks either.
        const header = { type: 'doc', content: [{ type: 'paragraph', content: [text('Acme')] }] };
        const { json, bands, style } = docxToPmJson(
            Buffer.from(await eigendocToDocx(source, { header }, DEFAULT_PAGE_SETUP, normal, [], 'Word', undefined)),
        );
        expect(style).toEqual(normal);
        expect(stored(json)).toEqual(stored(source));
        expect(stored(bands['header'] ?? {})).toEqual(stored(docSchema().nodeFromJSON(header).toJSON()));
    });

    test("Eigen's own Normal comes back as the default", async () => {
        const source = buildAllFeaturesDocJson();
        const { style } = docxToPmJson(
            Buffer.from(
                await eigendocToDocx(source, {}, DEFAULT_PAGE_SETUP, DEFAULT_NORMAL_STYLE, [], 'Eigen', undefined),
            ),
        );
        expect(style).toEqual(DEFAULT_NORMAL_STYLE);
    });
});

// T3-R4: the package's Word equations, through the server's parser, the import and the export, are the trees they were.
describe("the math package's corpus equations", () => {
    test('docx → Eigen → docx gives back each tree, display kept', async () => {
        const corpus: { omml: string; display: boolean }[] = JSON.parse(
            readFileSync(
                new URL('../../../../../../packages/math/src/test/fixtures/omml-corpus.json', import.meta.url),
                'utf8',
            ),
        );
        const input = corpus
            .map(
                ({ omml, display }) =>
                    `<w:p>${display ? `<m:oMathPara xmlns:m="${M_NS}">${omml}</m:oMathPara>` : omml}</w:p>`,
            )
            .join('');
        const { json } = await importDocxBody(input);
        const docx = await eigendocToDocx(json, {}, DEFAULT_PAGE_SETUP, DEFAULT_NORMAL_STYLE, [], 'Equations', ORIGIN);
        const document = parseOoxml(openZip(new Uint8Array(docx)).read('word/document.xml') ?? '');
        const body = document && xmlChild(document, W_NS, 'body');
        if (!body) throw new Error('no w:body');
        const written = xmlChildren(body, W_NS, 'p').flatMap((paragraph) =>
            xmlElements(paragraph)
                .filter((math) => math.ns === M_NS)
                .map((math) => {
                    const display = math.local === 'oMathPara';
                    const oMath = display ? xmlChild(math, M_NS, 'oMath') : math;
                    return { row: oMath ? readOmml(oMath) : [], display };
                }),
        );
        const read = corpus.map(({ omml, display }) => {
            const oMath = parseOoxml(omml);
            return { row: oMath ? readOmml(oMath) : [], display };
        });
        expect(written).toHaveLength(108);
        expect(written).toStrictEqual(read);
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
const heading = (text: string) => ({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text }] });
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
    const { json } = docxToPmJson(
        Buffer.from(
            await eigendocToDocx(source, {}, DEFAULT_PAGE_SETUP, DEFAULT_NORMAL_STYLE, [], 'Nested', undefined),
        ),
    );
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
        ['a heading in an item', [ordered([p('One'), heading('Part')], [p('Two')])]],
        ['a heading in an item in a quote', [quote(ordered([p('One'), heading('Part')], [p('Two')]))]],
        ['a quote two deep after a list', [bullets([p('One')]), quote(quote(p('Deep')))]],
        ['a quote two deep holding a rule after a list', [bullets([p('One')]), quote(quote(p('Deep'), rule))]],
        ['a quote two deep holding a table after a list', [tasks([p('One')]), quote(quote(p('Deep'), table))]],
        [
            'a quote three deep after a nested list',
            [bullets([p('One'), bullets([p('a')])]), quote(quote(quote(p('Deep'))))],
        ],
        [
            'a quote two deep opening with a list after a list',
            [ordered([p('One')]), quote(quote(bullets([p('Deep')])))],
        ],
        [
            'a quote two deep opening with a task list after a list',
            [ordered([p('One')]), quote(quote(tasks([p('Deep')])))],
        ],
        ['a quote two deep after a nested list', [ordered([p('One'), bullets([p('a')]), quote(quote(p('Deep')))])]],
        ['code two deep after a nested list', [ordered([p('One'), bullets([p('a')]), quote(quote(code('one()')))])]],
        ['a table after a quote in an item in a quote', [quote(ordered([p('One'), quote(p('Said'))]), table)]],
        ['a rule after a quote in an item in a quote', [quote(bullets([p('One'), quote(p('Said'))]), rule)]],
        [
            'a rule after a list in a quote two deep after a task list',
            [tasks([p('One')]), quote(quote(ordered([p('Two')]), rule))],
        ],
        [
            'a quote in a nested item, then one in the outer item',
            [bullets([p('One'), ordered([p('a'), quote(p('Inner'))]), quote(p('Outer'))])],
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

// Format › Bullets and numbering's five styles, and the lists Restart numbering splits one into.
describe("a numbered list's style and start", () => {
    const numbered = (start: number, type: string | null, ...texts: string[]) => ({
        ...ordered(...texts.map((text) => [p(text)])),
        attrs: { start, type },
    });
    test.each<[string, JSONContent[]]>([
        ['decimal from 4', [numbered(4, null, 'One', 'Two')]],
        ['small letters', [numbered(1, 'a', 'One', 'Two')]],
        ['capital letters from 3', [numbered(3, 'A', 'One')]],
        ['small roman numerals from 2', [numbered(2, 'i', 'One')]],
        ['capital roman numerals', [numbered(1, 'I', 'One', 'Two')]],
        ['a list restarted at its second item', [numbered(1, 'a', 'One'), numbered(1, 'a', 'Two', 'Three')]],
        ['a list split where its numbers run on', [numbered(1, 'i', 'One'), numbered(2, 'i', 'Two')]],
    ])('%s comes back as written', async (_name, content) => {
        const { source, json } = await roundTrip(content);
        expect(stored(json)).toEqual(stored(expected(source, json)));
    });
});

// A size is the editor's own, so it comes back in pt, Word's half points kept; in a heading too, over its style's.
test('font sizes come back as written, in a paragraph and in a heading', async () => {
    const sized = (text: string, fontSize: number) => ({
        type: 'text',
        text,
        marks: [{ type: 'textStyle', attrs: { fontSize } }],
    });
    const { source, json } = await roundTrip([
        { type: 'paragraph', content: [{ type: 'text', text: 'body ' }, sized('big', 14), sized(' half', 10.5)] },
        { type: 'heading', attrs: { level: 2 }, content: [sized('Plan', 30), { type: 'text', text: ' styled' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'fine', marks: [{ type: 'small' }] }] },
    ]);
    expect(stored(json)).toEqual(stored(expected(source, json)));
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

// The writer sets a page break at the margin, so the blocks around it say where it stands.
describe('a page break between containers', () => {
    test.each<[string, JSONContent[]]>([
        [
            'after a quote in an item, before a quote',
            [bullets([p('One'), quote(p('Said'))]), pageBreak, quote(p('After'))],
        ],
        [
            'after a nested task list, before a task list',
            [ordered([p('One'), tasks([p('a')])]), pageBreak, tasks([p('b')])],
        ],
    ])('%s stands between them', async (_name, content) => {
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
        ['two tables', [quote(p('Said'), table, table)]],
        ['a table in an item and one after the list', [quote(bullets([p('One'), table]), table)]],
        ['a quote ending in a list, and code', [quote(quote(bullets([p('One'), p('More')])), code('one()'))]],
        ['code and a quote opening with a list', [quote(code('one()'), quote(bullets([p('One')])))]],
        [
            'a quote ending in code in an item, then a quote opening with code',
            [quote(bullets([p('One'), code('one()')])), quote(code('two()'))],
        ],
        [
            'a quote ending in code in an item, then a quote opening with a quote',
            [quote(bullets([p('One'), code('one()')])), quote(quote(p('Deep')))],
        ],
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
        ['before a heading', [ordered([p('One'), pageBreak, heading('Part')], [p('Two')])]],
        ['in a quote, before a rule', [bullets([p('One'), quote(p('Said'), pageBreak, rule)])]],
        ['in a quote, before a table', [bullets([p('One'), quote(p('Said'), pageBreak, table)])]],
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

// Heading 6's style is italic, so an italic mark in it is written upright and read back as one.
describe("a heading's italic", () => {
    const fine = (level: number) => ({
        type: 'heading',
        attrs: { level },
        content: [
            { type: 'text', text: 'Fine ' },
            { type: 'text', text: 'print', marks: [{ type: 'italic' }] },
        ],
    });
    test.each<[string, JSONContent[]]>([
        ['in Heading 5', [fine(5)]],
        ['in Heading 6', [fine(6)]],
        ['in Heading 6 in a quote', [quote(fine(6))]],
    ])('%s comes back', async (_name, content) => {
        const { source, json } = await roundTrip(content);
        expect(stored(json)).toEqual(stored(expected(source, json)));
    });
});

// Google Docs drops every custom style, so the code block's language and the mark of a header cell beside a body cell,
// which comes back a body cell in the header's grey; a page break in a table cell; a link's title.
// It keeps one placeholder for the export's media, so names don't say which image is which. The recording predates
// caps, and Heading 6's italic, so its Heading 6 draws upright: there a plain run is the italic mark, and a marked one plain.
function googleLosses(node: JSONContent, imported: JSONContent | undefined): JSONContent {
    const upright = node.type === 'heading' && !!HEADING_LOOKS[node.attrs?.['level'] - 1]?.italic;
    const mixed = node.type === 'tableRow' && node.content?.some((cell) => cell.type === 'tableCell');
    const content = node.content
        ?.filter((child) => !(child.type === 'pageBreak' && (node.type === 'tableCell' || node.type === 'tableHeader')))
        .map((child) => (mixed && child.type === 'tableHeader' ? asBodyCell(child) : child))
        .map((child, index) => googleLosses(upright ? toggleItalic(child) : child, imported?.content?.[index]));
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

function toggleItalic(node: JSONContent): JSONContent {
    const marks = (node.marks ?? []).filter((mark) => mark.type !== 'italic');
    if (marks.length === (node.marks ?? []).length) marks.push({ type: 'italic' });
    return { ...node, marks };
}

// D13: a paragraph's own format comes back as set, in another family too, where the writer scales its line.
describe("a paragraph's format", () => {
    const formatted = (attrs: Record<string, unknown>, ...marks: NonNullable<JSONContent['marks']>): JSONContent => ({
        type: 'paragraph',
        attrs,
        content: [{ type: 'text', text: 'Text', ...(marks.length > 0 && { marks }) }],
    });
    const serif = { type: 'textStyle', attrs: { fontFamily: 'Source Serif 4' } };
    test.each<[string, JSONContent[]]>([
        [
            'line spacing and spacing',
            [
                formatted({ lineSpacing: 1.15 }),
                formatted({ lineSpacing: 2, spaceBefore: 6, spaceAfter: 0 }),
                formatted({ lineSpacing: 1.5 }, serif),
                formatted({}, serif),
            ],
        ],
        [
            'indents',
            [
                formatted({ indentLeft: 36, indentRight: 18 }),
                formatted({ indentFirstLine: 18 }),
                formatted({ indentLeft: 36, indentFirstLine: -36 }),
            ],
        ],
        [
            'a heading and the title',
            [
                { type: 'title', attrs: { spaceAfter: 12 }, content: [{ type: 'text', text: 'T' }] },
                { type: 'heading', attrs: { level: 2, lineSpacing: 1 }, content: [{ type: 'text', text: 'H' }] },
            ],
        ],
        ['an indent in an item, past its text', [bullets([p('One'), formatted({ indentLeft: 36, lineSpacing: 1.5 })])]],
        // Random seed 326: a table holds no space after, so the writer gives the paragraph below it the gap.
        ['a paragraph after a table', [table, p('After')]],
        ['a paragraph after a list whose last item ends in a table', [bullets([p('One'), table]), p('After')]],
        ['a paragraph after a quote that ends in a table', [quote(p('Said'), table), p('After')]],
        // Random seed 1215: a quote's lists number by the numbered lists around the item that holds it.
        ['a numbered list in a quote in a numbered item', [ordered([p('One'), quote(ordered([p('Inner')]))])]],
        [
            'a heading after a table',
            [table, { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'H' }] }],
        ],
    ])('%s come back as set', async (_name, content) => {
        const { source, json } = await roundTrip(content);
        expect(stored(json)).toEqual(stored(expected(source, json)));
    });
});

// A header cell beside a body cell is marked by its paragraphs' style; a fill is a cell's look, whatever its color.
describe("a cell's fill and header", () => {
    const cell = (type: string, text: string, backgroundColor?: string) => ({
        type,
        attrs: backgroundColor ? { backgroundColor } : {},
        content: [p(text)],
    });
    const grid = (...rows: JSONContent[][]) => ({
        type: 'table',
        content: rows.map((content) => ({ type: 'tableRow', content })),
    });
    test.each<[string, JSONContent]>([
        [
            'a header cell beside a body cell, filled or in the grey',
            grid(
                [cell('tableHeader', 'Own', '#cfe2f3'), cell('tableCell', 'A')],
                [cell('tableHeader', 'Grey'), cell('tableCell', 'B')],
            ),
        ],
        [
            "a body cell in the header's grey, and a filled first row",
            grid(
                [cell('tableCell', 'Filled', '#1f4e79'), cell('tableCell', 'Too', '#1f4e79')],
                [cell('tableCell', 'Grey', HEADER_GREY), cell('tableCell', 'Plain')],
            ),
        ],
        [
            'a header row with a fill of its own',
            grid(
                [cell('tableHeader', 'H', '#cfe2f3'), cell('tableHeader', 'I')],
                [cell('tableCell', 'A'), cell('tableCell', 'B')],
            ),
        ],
    ])('%s come back as written', async (_name, table) => {
        const { source, json } = await roundTrip([table]);
        expect(stored(json)).toEqual(stored(expected(source, json)));
    });
});

// Word draws a line in its tallest face, the paragraph mark's when it's taller than the runs', and the reader reads it so.
describe('a line under a Normal in another family', () => {
    test.each<[string, string | undefined]>([
        ['in a shorter family', 'Inter'],
        ['in two families', undefined],
        ['with no text', undefined],
    ])('a paragraph %s keeps its line spacing, trip after trip', async (name, font) => {
        const runs: JSONContent[] =
            name === 'with no text'
                ? []
                : name === 'in two families'
                  ? [
                        { type: 'text', text: 'Serif ' },
                        {
                            type: 'text',
                            text: 'Mono',
                            marks: [{ type: 'textStyle', attrs: { fontFamily: 'JetBrains Mono' } }],
                        },
                    ]
                  : [{ type: 'text', text: 'Text', marks: [{ type: 'textStyle', attrs: { fontFamily: font } }] }];
        let content: JSONContent[] = [{ type: 'paragraph', attrs: { lineSpacing: 2 }, content: runs }];
        let style = { ...DEFAULT_NORMAL_STYLE, font: 'Source Serif 4' };
        for (let trip = 0; trip < 3; trip++) {
            const docx = await eigendocToDocx(
                { type: 'doc', content },
                {},
                DEFAULT_PAGE_SETUP,
                style,
                [],
                'Line',
                undefined,
            );
            const imported = docxToPmJson(Buffer.from(docx));
            content = imported.json.content ?? [];
            style = imported.style;
            expect(content[0]?.attrs?.['lineSpacing']).toBe(2);
        }
    });
});

describe("the all-features doc's Google Docs re-save", () => {
    test('comes back as written, but for the named differences and what Google Docs drops', async () => {
        const bytes = await Bun.file(
            join(import.meta.dir, '../../fixtures/docx/google-docs-all-features.docx'),
        ).arrayBuffer();
        const { json } = docxToPmJson(Buffer.from(bytes), { publicOrigin: ORIGIN });
        const source = docSchema().nodeFromJSON(buildAllFeaturesDocJson()).toJSON();
        // The recording predates the title, the subtitle, the note's paragraph, the equations' paragraph and the page
        // number, so it holds none of them.
        source.content = source.content.filter(
            (block: JSONContent) =>
                block.type !== 'title' &&
                block.type !== 'subtitle' &&
                !block.content?.some((inline: JSONContent) =>
                    ['pageNumber', 'equation', 'footnote'].includes(inline.type ?? ''),
                ),
        );
        expect(stored(json)).toEqual(stored(googleLosses(expected(source, json), json)));
    });
});

// Seeded, so a failure repeats; it prints the seed and the smallest document that still fails.
describe('random documents', () => {
    const runSlow = Boolean(process.env['CI'] || process.env['EIGEN_SLOW_TESTS']);
    const CASES = runSlow ? 5000 : 300;

    test(`${CASES} come back as written`, async () => {
        for (let seed = 1; seed <= CASES; seed++) {
            const content = randomDocument(seed);
            if (!writable(content) || (await comesBack(content))) continue;
            const smallest = await shrink(content);
            console.error(`seed ${seed}: ${JSON.stringify(smallest)}`);
            const { source, json } = await roundTrip(smallest);
            expect(stored(json)).toEqual(stored(expected(source, json)));
        }
    }, 600_000);
});

const BLOCKS = ['paragraph', 'heading', 'quote', 'bullets', 'ordered', 'tasks', 'code', 'rule', 'table', 'pageBreak'];

// Three containers deep at most.
function randomDocument(seed: number): JSONContent[] {
    let state = seed;
    const next = () => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state / 0x7fffffff;
    };
    const below = (count: number) => Math.floor(next() * count);
    let written = 0;
    const text = () => `T${++written}`;
    const blocks = (depth: number, least: number): JSONContent[] =>
        Array.from({ length: least + below(3) }, () => block(depth));
    const items = (depth: number) =>
        Array.from({ length: 1 + below(2) }, () => [p(text()), ...(next() < 0.6 ? blocks(depth + 1, 0) : [])]);
    const cell = (depth: number, attrs: Record<string, number>) => ({
        type: next() < 0.2 ? 'tableHeader' : 'tableCell',
        attrs,
        content: depth < 2 && next() < 0.3 ? blocks(depth + 1, 1) : [p(text())],
    });
    const block = (depth: number): JSONContent => {
        switch (depth >= 3 ? 'paragraph' : BLOCKS[below(BLOCKS.length)]) {
            case 'heading':
                return { type: 'heading', attrs: { level: 1 + below(3) }, content: [{ type: 'text', text: text() }] };
            case 'quote':
                return quote(...blocks(depth + 1, 1));
            case 'bullets':
                return bullets(...items(depth));
            case 'ordered':
                return ordered(...items(depth));
            case 'tasks':
                return {
                    type: 'taskList',
                    content: items(depth).map((content) => ({
                        type: 'taskItem',
                        attrs: { checked: next() < 0.5 },
                        content,
                    })),
                };
            case 'code':
                return code(text());
            case 'rule':
                return rule;
            case 'pageBreak':
                return pageBreak;
            case 'table': {
                const row = (...cells: JSONContent[]) => ({ type: 'tableRow', content: cells });
                if (next() < 0.5) {
                    return {
                        type: 'table',
                        content: [row(cell(depth, {}), cell(depth, {})), row(cell(depth, {}), cell(depth, {}))],
                    };
                }
                return {
                    type: 'table',
                    content: [
                        row(cell(depth, { rowspan: 2 }), cell(depth, {})),
                        row(cell(depth, {})),
                        row(cell(depth, { colspan: 2 })),
                    ],
                };
            }
            default:
                return p(text());
        }
    };
    return blocks(0, 1);
}

// What the writer writes the same as another document, left out, and one reader limit.
function writable(content: JSONContent[], container = 'doc'): boolean {
    const box = (node: JSONContent | undefined) => node?.type === 'codeBlock' || node?.type === 'blockquote';
    const end = (node: JSONContent | undefined, quotes = false): JSONContent | undefined => {
        if (LISTS.has(node?.type ?? '')) return end(node?.content?.at(-1)?.content?.at(-1), quotes);
        return quotes && node?.type === 'blockquote' ? end(node.content?.at(-1), quotes) : node;
    };
    // Nothing marks a rule or a table as in the quote it opens, and a page break sits at the margin.
    if (container === 'blockquote' && ['horizontalRule', 'table', 'pageBreak'].includes(content[0]?.type ?? ''))
        return false;
    if (container !== 'doc' && content.at(-1)?.type === 'pageBreak') return false;
    const blocks = content.filter((node) => node.type !== 'pageBreak');
    for (const [index, node] of blocks.entries()) {
        const previous = blocks[index - 1];
        // No task list is numbered, so two apart by nothing or page breaks are one.
        if (node.type === 'taskList' && previous?.type === 'taskList') return false;
        if (node.type !== 'blockquote' || previous?.type !== 'blockquote') continue;
        const last = previous.content?.at(-1);
        // A break between quotes is one in a quote; nothing parts a quote that ends deep in a table from the next.
        if (content.indexOf(node) > content.indexOf(previous) + 1 || end(last, true)?.type === 'table') return false;
        // Boxes meeting are one quote holding both; a quote ending a list's last item doesn't say where it sits.
        if (box(node.content?.[0]) && (box(last) || end(last)?.type === 'blockquote')) return false;
    }
    return content.every((node) => {
        const children = node.content ?? [];
        if (node.type === 'table' || node.type === 'tableRow')
            return children.every((child) => writable([child], node.type));
        return children.every((child) => child.type === 'text') || writable(children, node.type);
    });
}

const LISTS = new Set(['bulletList', 'orderedList', 'taskList']);

async function comesBack(content: JSONContent[]): Promise<boolean> {
    const { source, json } = await roundTrip(content);
    return JSON.stringify(stored(json)) === JSON.stringify(stored(expected(source, json)));
}

// A block dropped or a container unwrapped at a time; a table loses no cell, so it stays a grid.
async function shrink(content: JSONContent[]): Promise<JSONContent[]> {
    for (let smaller = true; smaller; ) {
        smaller = false;
        for (const candidate of smallerDocuments(content)) {
            if (!isValid(candidate) || !writable(candidate) || (await comesBack(candidate))) continue;
            content = candidate;
            smaller = true;
            break;
        }
    }
    return content;
}

function* smallerDocuments(content: JSONContent[]): Generator<JSONContent[]> {
    const paths: number[][] = [];
    const walk = (nodes: JSONContent[], path: number[], inGrid: boolean) => {
        for (const [index, node] of nodes.entries()) {
            if (node.type === 'text') continue;
            if (!inGrid) paths.push([...path, index]);
            const grid = node.type === 'table' || node.type === 'tableRow';
            walk(node.content ?? [], [...path, index], grid);
        }
    };
    walk(content, [], false);
    for (const path of paths) {
        const copy = structuredClone(content);
        let siblings = copy;
        for (const index of path.slice(0, -1)) siblings = siblings[index]?.content ?? [];
        const at = path.at(-1) ?? 0;
        const [removed] = siblings.splice(at, 1);
        if (siblings.length > 0) yield structuredClone(copy);
        if (!removed || TEXTBLOCKS.has(removed.type ?? '') || !removed.content) continue;
        siblings.splice(at, 0, ...removed.content.flatMap(blocksIn));
        yield copy;
    }
}

const TEXTBLOCKS = new Set(['paragraph', 'heading', 'codeBlock']);
const WRAPPERS = new Set(['listItem', 'taskItem', 'tableRow', 'tableCell', 'tableHeader']);

const blocksIn = (node: JSONContent): JSONContent[] =>
    WRAPPERS.has(node.type ?? '') ? (node.content ?? []).flatMap(blocksIn) : [node];

function isValid(content: JSONContent[]): boolean {
    try {
        docSchema().nodeFromJSON({ type: 'doc', content }).check();
        return true;
    } catch {
        return false;
    }
}
