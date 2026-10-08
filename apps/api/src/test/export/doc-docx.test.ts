import { describe, expect, mock, test } from 'bun:test';
import { getSchema, type JSONContent } from '@tiptap/core';
import { getDocExtensions } from '@workspace/lib/docs/eigendoc';
import JSZip from 'jszip';
import { common, createLowlight } from 'lowlight';
import { parseXml, type XmlElement, xmlAttr, xmlChild, xmlChildren, xmlElements, xmlText } from '../../lib/core/xml';
import { type ExportMedia, toTransferableText } from '../../lib/document/transform/protocol';
import * as proseCss from '../../lib/export/doc/prose-css';
import { eigendocToDocx } from '../../lib/export/doc/to-docx';
import { buildAllFeaturesDocJson, buildAllFeaturesDocMedia } from '../fixtures/golden-documents';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';
const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';

// U+FFFE, which XML can't hold; the formatter would unescape it into an invisible literal.
const NONCHARACTER = String.fromCharCode(0xfffe);

const schema = getSchema(getDocExtensions({ lowlight: createLowlight(common) }));

// Every doc gets the all-features media; the writer embeds only what a figure shows.
function docx(json: JSONContent, publicOrigin?: string, media = buildAllFeaturesDocMedia()): Promise<Uint8Array> {
    return eigendocToDocx(json, media, 'Report.eigendoc', publicOrigin);
}

async function unzip(json: JSONContent, publicOrigin?: string, media?: ExportMedia[]): Promise<JSZip> {
    return JSZip.loadAsync(await docx(json, publicOrigin, media));
}

async function part(zip: JSZip, path: string): Promise<XmlElement> {
    const text = await zip.file(path)?.async('string');
    const root = text === undefined ? null : parseXml(text);
    if (!root) throw new Error(`${path} missing or blank`);
    return root;
}

async function bodyOf(json: JSONContent, publicOrigin?: string, media?: ExportMedia[]): Promise<XmlElement> {
    const body = xmlChild(await part(await unzip(json, publicOrigin, media), 'word/document.xml'), W, 'body');
    if (!body) throw new Error('no w:body');
    return body;
}

function elementsOf(root: XmlElement): XmlElement[] {
    return [root, ...xmlElements(root).flatMap(elementsOf)];
}

function descendants(root: XmlElement, ns: string, local: string): XmlElement[] {
    return elementsOf(root).filter((element) => element !== root && element.ns === ns && element.local === local);
}

// Every r:id and r:embed, whatever element carries it.
function relationshipRefs(root: XmlElement): string[] {
    return elementsOf(root).flatMap((element) =>
        Object.entries(element.attributeNs)
            .filter(([, ns]) => ns === R)
            .map(([name]) => element.attributes[name] ?? ''),
    );
}

function only<T>(items: T[]): T {
    expect(items).toHaveLength(1);
    const [item] = items;
    if (item === undefined) throw new Error('expected one item');
    return item;
}

function w(element: XmlElement | undefined, local: string): string | undefined {
    return element && xmlAttr(element, W, local);
}

function child(element: XmlElement | undefined, local: string): XmlElement | undefined {
    return element && xmlChild(element, W, local);
}

function texts(element: XmlElement): string {
    return descendants(element, W, 't').map(xmlText).join('');
}

// An element's children as local names, the shape the per-node tests compare.
function shape(element: XmlElement): string[] {
    return xmlElements(element).map((e) => e.local);
}

// An element as XML, names as written and namespace declarations left out: the exact-XML oracle. WordprocessingML
// holds text only in leaves, so text before elements loses nothing.
function xmlOf(element: XmlElement | undefined): string {
    if (!element) return '';
    const attributes = Object.entries(element.attributes)
        .filter(([name]) => name !== 'xmlns' && !name.startsWith('xmlns:'))
        .map(([name, value]) => ` ${name}="${value}"`)
        .join('');
    const content = xmlText(element) + xmlElements(element).map(xmlOf).join('');
    return content ? `<${element.name}${attributes}>${content}</${element.name}>` : `<${element.name}${attributes}/>`;
}

async function paragraphsOf(json: JSONContent): Promise<string[]> {
    return xmlChildren(await bodyOf(json), W, 'p').map(xmlOf);
}

// The body's blocks as exact XML, the section properties left out.
async function blocksOf(json: JSONContent, media?: ExportMedia[]): Promise<string[]> {
    return xmlElements(await bodyOf(json, undefined, media))
        .filter((element) => element.local !== 'sectPr')
        .map(xmlOf);
}

async function numberingOf(json: JSONContent): Promise<XmlElement> {
    return part(await unzip(json), 'word/numbering.xml');
}

function doc(...content: JSONContent[]): JSONContent {
    return { type: 'doc', content };
}

function p(...content: JSONContent[]): JSONContent {
    return { type: 'paragraph', content };
}

function text(value: string, ...marks: NonNullable<JSONContent['marks']>): JSONContent {
    return { type: 'text', text: value, marks };
}

function ul(...items: JSONContent[]): JSONContent {
    return { type: 'bulletList', content: items };
}

function ol(attrs: Record<string, unknown>, ...items: JSONContent[]): JSONContent {
    return { type: 'orderedList', attrs, content: items };
}

function li(...content: JSONContent[]): JSONContent {
    return { type: 'listItem', content };
}

function tasks(...items: JSONContent[]): JSONContent {
    return { type: 'taskList', content: items };
}

function task(checked: boolean, ...content: JSONContent[]): JSONContent {
    return { type: 'taskItem', attrs: { checked }, content };
}

function quote(...content: JSONContent[]): JSONContent {
    return { type: 'blockquote', content };
}

function code(value: string, language: string | null = null): JSONContent {
    return { type: 'codeBlock', attrs: { language }, content: [text(value)] };
}

function heading(level: number, ...content: JSONContent[]): JSONContent {
    return { type: 'heading', attrs: { level }, content };
}

function table(...rows: JSONContent[]): JSONContent {
    return { type: 'table', content: rows };
}

function tr(...cells: JSONContent[]): JSONContent {
    return { type: 'tableRow', content: cells };
}

function td(attrs: Record<string, unknown>, ...content: JSONContent[]): JSONContent {
    return { type: 'tableCell', attrs, content };
}

function th(attrs: Record<string, unknown>, ...content: JSONContent[]): JSONContent {
    return { type: 'tableHeader', attrs, content };
}

const RULE: JSONContent = { type: 'horizontalRule' };
const PAGE_BREAK: JSONContent = { type: 'pageBreak' };
const PAGE_BREAK_XML = '<w:p><w:pPr><w:pStyle w:val="PageBreak"/></w:pPr><w:r><w:br w:type="page"/></w:r></w:p>';
const SPACER_XML = '<w:p><w:pPr><w:pStyle w:val="Spacer"/></w:pPr></w:p>';

// The run one plain text writes.
function run(value: string): string {
    return `<w:r><w:t xml:space="preserve">${value}</w:t></w:r>`;
}

function typesIn(json: JSONContent, nodes = new Set<string>(), marks = new Set<string>()) {
    if (json.type) nodes.add(json.type);
    for (const mark of json.marks ?? []) marks.add(mark.type);
    for (const node of json.content ?? []) typesIn(node, nodes, marks);
    return { nodes, marks };
}

async function styles(json: JSONContent = doc(p(text('x')))): Promise<Map<string, XmlElement>> {
    const root = await part(await unzip(json), 'word/styles.xml');
    return new Map(xmlChildren(root, W, 'style').map((style) => [w(style, 'styleId') ?? '', style]));
}

function style(all: Map<string, XmlElement>, id: string): XmlElement {
    const found = all.get(id);
    if (!found) throw new Error(`no style ${id}`);
    return found;
}

describe('docx writer — schema coverage', () => {
    test('the all-features doc is a valid doc holding every node and mark of the schema', () => {
        const json = buildAllFeaturesDocJson();
        schema.nodeFromJSON(json).check();
        const { nodes, marks } = typesIn(json);

        expect([...nodes].sort()).toEqual(Object.keys(schema.nodes).sort());
        expect([...marks].sort()).toEqual(Object.keys(schema.marks).sort());
    });

    test('the all-features doc exports', async () => {
        expect((await docx(buildAllFeaturesDocJson())).byteLength).toBeGreaterThan(0);
    });

    test('an unknown node or mark throws, as the HTML export does', async () => {
        await expect(docx(doc({ type: 'mystery' }))).rejects.toThrow('no docx mapping for mystery');
        await expect(docx(doc(p(text('x', { type: 'glow' }))))).rejects.toThrow('no docx mapping for glow');
    });
});

describe('docx writer — package', () => {
    const PARTS = [
        '[Content_Types].xml',
        '_rels/.rels',
        'docProps/core.xml',
        'word/document.xml',
        'word/_rels/document.xml.rels',
        'word/styles.xml',
        'word/numbering.xml',
        'word/settings.xml',
        'word/fontTable.xml',
        'word/_rels/fontTable.xml.rels',
    ];
    // The all-features doc's chart, photo and SVG, numbered as the figures first show them.
    const MEDIA_PARTS = ['word/media/image1.png', 'word/media/image2.jpeg', 'word/media/image3.png'];

    test('every part is written, parses and has a content type', async () => {
        const zip = await unzip(buildAllFeaturesDocJson());
        const paths = Object.keys(zip.files);
        expect(paths.sort()).toEqual([...PARTS, ...MEDIA_PARTS, 'word/media/image3.svg'].sort());

        const types = await part(zip, '[Content_Types].xml');
        const defaults = new Set(xmlChildren(types, CONTENT_TYPES, 'Default').map((d) => xmlAttr(d, '', 'Extension')));
        const overrides = new Map(
            xmlChildren(types, CONTENT_TYPES, 'Override').map((o) => [
                xmlAttr(o, '', 'PartName'),
                xmlAttr(o, '', 'ContentType'),
            ]),
        );
        expect([...defaults].sort()).toEqual(['jpeg', 'odttf', 'png', 'rels', 'svg', 'xml']);
        for (const path of paths) {
            if (!MEDIA_PARTS.includes(path)) await part(zip, path);
            expect(overrides.has(`/${path}`) || defaults.has(path.split('.').pop())).toBe(true);
        }
        const wml = 'application/vnd.openxmlformats-officedocument.wordprocessingml';
        expect(Object.fromEntries(overrides)).toEqual({
            '/docProps/core.xml': 'application/vnd.openxmlformats-package.core-properties+xml',
            '/word/document.xml': `${wml}.document.main+xml`,
            '/word/styles.xml': `${wml}.styles+xml`,
            '/word/numbering.xml': `${wml}.numbering+xml`,
            '/word/settings.xml': `${wml}.settings+xml`,
            '/word/fontTable.xml': `${wml}.fontTable+xml`,
        });
    });

    test('every relationship resolves, and every id the parts use is a relationship', async () => {
        const zip = await unzip(buildAllFeaturesDocJson());
        for (const relsPath of PARTS.filter((path) => path.endsWith('.rels'))) {
            const folder = relsPath.replace(/_rels\/[^/]*$/, '');
            const source = relsPath.replace('_rels/', '').replace(/\.rels$/, '');
            const relationships = xmlChildren(await part(zip, relsPath), RELS, 'Relationship');
            const ids = new Set(relationships.map((rel) => xmlAttr(rel, '', 'Id')));
            expect(ids.size).toBe(relationships.length);
            for (const rel of relationships) {
                if (xmlAttr(rel, '', 'TargetMode') === 'External') continue;
                expect(zip.file(`${folder}${xmlAttr(rel, '', 'Target')}`)).not.toBeNull();
            }
            if (!source) continue;
            for (const id of relationshipRefs(await part(zip, source))) expect(ids).toContain(id);
        }
    });

    test('every style, numbering and drawing id the document uses is defined once', async () => {
        const zip = await unzip(buildAllFeaturesDocJson());
        const document = await part(zip, 'word/document.xml');
        const stylesRoot = await part(zip, 'word/styles.xml');
        const styleIds = xmlChildren(stylesRoot, W, 'style').map((s) => w(s, 'styleId'));
        expect(new Set(styleIds).size).toBe(styleIds.length);

        const referenced = [
            ...descendants(document, W, 'pStyle'),
            ...descendants(document, W, 'rStyle'),
            ...descendants(stylesRoot, W, 'basedOn'),
            ...descendants(stylesRoot, W, 'next'),
        ].map((e) => w(e, 'val'));
        expect(referenced.length).toBeGreaterThan(0);
        for (const id of referenced) expect(styleIds).toContain(id);

        const numbering = await part(zip, 'word/numbering.xml');
        const numIds = xmlChildren(numbering, W, 'num').map((n) => w(n, 'numId'));
        expect(new Set(numIds).size).toBe(numIds.length);
        const used = descendants(document, W, 'numId');
        expect(used.length).toBeGreaterThan(0);
        for (const numId of used) expect(numIds).toContain(w(numId, 'val'));
        const abstractNumIds = xmlChildren(numbering, W, 'abstractNum').map((a) => w(a, 'abstractNumId'));
        expect(new Set(abstractNumIds).size).toBe(abstractNumIds.length);
        for (const num of xmlChildren(numbering, W, 'num')) {
            expect(abstractNumIds).toContain(w(child(num, 'abstractNumId'), 'val'));
        }

        const docPrIds = descendants(
            document,
            'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
            'docPr',
        ).map((docPr) => xmlAttr(docPr, '', 'id'));
        expect(new Set(docPrIds).size).toBe(docPrIds.length);
    });

    test('the same doc exports to the same bytes', async () => {
        const [first, second] = await Promise.all([docx(buildAllFeaturesDocJson()), docx(buildAllFeaturesDocJson())]);
        expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
        // Two runs inside one zip time tick agree on a clock date too, so the date is pinned on its own.
        const dates = Object.values((await JSZip.loadAsync(first)).files).map((file) => file.date.toISOString());
        expect(new Set(dates)).toEqual(new Set(['1980-01-01T00:00:00.000Z']));
    });

    test('the title is the name without its extension', async () => {
        const core = await part(await unzip(doc(p(text('x')))), 'docProps/core.xml');
        expect(xmlText(only(xmlChildren(core, 'http://purl.org/dc/elements/1.1/', 'title')))).toBe('Report');
    });

    test('settings open the file in Word 2013+ mode, and the font table lists the Eigen fonts', async () => {
        const zip = await unzip(doc(p(text('x'))));
        const settings = await part(zip, 'word/settings.xml');
        expect(w(child(settings, 'defaultTabStop'), 'val')).toBe('720');
        const compat = only(descendants(settings, W, 'compatSetting'));
        expect([w(compat, 'name'), w(compat, 'val')]).toEqual(['compatibilityMode', '15']);

        const fonts = xmlChildren(await part(zip, 'word/fontTable.xml'), W, 'font');
        expect(
            fonts.map((font) => [w(font, 'name'), w(child(font, 'family'), 'val'), w(child(font, 'pitch'), 'val')]),
        ).toEqual([
            ['Inter', 'swiss', 'variable'],
            ['Source Serif 4', 'roman', 'variable'],
            ['JetBrains Mono', 'modern', 'fixed'],
            ['Excalifont', 'script', 'variable'],
        ]);
    });
});

describe('docx writer — text', () => {
    test('tabs and line breaks become w:tab and w:br, and no character is lost', async () => {
        const run = only(descendants(await bodyOf(doc(p(text('a\tb\u000Bc\nd\r\ne')))), W, 'r'));
        expect(shape(run)).toEqual(['t', 'tab', 't', 'br', 't', 'br', 't', 'br', 't']);
        expect(texts(run)).toBe('abcde');
    });

    test('a character XML cannot hold vanishes, leading spaces stay', async () => {
        const run = only(descendants(await bodyOf(doc(p(text(`  lead\u0001ing${NONCHARACTER}`)))), W, 'r'));
        const t = only(xmlChildren(run, W, 't'));
        expect(xmlText(t)).toBe('  leading');
        expect(t.attributes['xml:space']).toBe('preserve');
    });

    test('a hard break is a run holding w:br', async () => {
        const body = await bodyOf(doc(p(text('a'), { type: 'hardBreak' }, text('b'))));
        expect(descendants(body, W, 'r').map(shape)).toEqual([['t'], ['br'], ['t']]);
    });
});

describe('docx writer — page breaks', () => {
    test('a top-level page break is a PageBreak paragraph holding the break, at its place', async () => {
        const body = await bodyOf(doc(p(text('before')), { type: 'pageBreak' }, p(text('after'))));
        const [before, pageBreak, after] = xmlChildren(body, W, 'p');
        expect(texts(before ?? body)).toBe('before');
        expect(texts(after ?? body)).toBe('after');
        expect(shape(pageBreak ?? body)).toEqual(['pPr', 'r']);
        expect(shape(child(pageBreak, 'pPr') ?? body)).toEqual(['pStyle']);
        expect(w(child(child(pageBreak, 'pPr'), 'pStyle'), 'val')).toBe('PageBreak');
        const br = only(xmlElements(child(pageBreak, 'r') ?? body));
        expect([br.local, w(br, 'type')]).toEqual(['br', 'page']);
    });

    test.each([
        ['a list item', (...content: JSONContent[]) => ul(li(...content))],
        ['a task item', (...content: JSONContent[]) => tasks(task(false, ...content))],
        ['a quote', (...content: JSONContent[]) => quote(...content)],
        ['a table cell', (...content: JSONContent[]) => table(tr(td({}, ...content)))],
    ])('a page break in %s is the same unnumbered paragraph, at its place', async (_where, wrap) => {
        const body = await bodyOf(doc(wrap(p(text('before')), PAGE_BREAK, p(text('after')))));
        const [before, pageBreak, after, ...rest] = xmlChildren(descendants(body, W, 'tc')[0] ?? body, W, 'p');
        expect(rest).toEqual([]);
        expect(texts(before ?? body)).toEndWith('before');
        expect(xmlOf(pageBreak ?? body)).toBe(PAGE_BREAK_XML);
        expect(texts(after ?? body)).toBe('after');
    });

    test('the Page Break style shrinks the paragraph mark the break leaves to 1 pt', async () => {
        const pageBreak = style(await styles(), 'PageBreak');
        expect(w(child(pageBreak, 'name'), 'val')).toBe('Page Break');
        const spacing = child(child(pageBreak, 'pPr'), 'spacing');
        expect([w(spacing, 'before'), w(spacing, 'after'), w(spacing, 'line'), w(spacing, 'lineRule')]).toEqual([
            '0',
            '0',
            '20',
            'exact',
        ]);
        expect(w(child(child(pageBreak, 'rPr'), 'sz'), 'val')).toBe('2');
    });
});

describe('docx writer — a doc no editor writes', () => {
    test('stray inline content is wrapped, a nested block hoisted, and every character kept', async () => {
        const body = await bodyOf(
            doc(
                text('stray '),
                { type: 'hardBreak' },
                text('text'),
                p(text('one '), p(text('two')), text(' three')),
                { type: 'heading', attrs: { level: 2 }, content: [text('four'), { type: 'pageBreak' }, text('five')] },
                { type: 'paragraph', content: [{ type: 'text' }] },
            ),
        );
        const paragraphs = xmlChildren(body, W, 'p');
        expect(paragraphs.map(texts)).toEqual(['stray text', 'one ', 'two', ' three', 'four', '', 'five', '']);
        const styleOf = (index: number) => w(child(child(paragraphs[index], 'pPr'), 'pStyle'), 'val');
        expect([styleOf(4), styleOf(5), styleOf(6)]).toEqual(['Heading2', 'PageBreak', 'Heading2']);
    });

    test('attrs of the wrong type fall back', async () => {
        const body = await bodyOf(
            doc(
                { type: 'heading', attrs: { level: 9 }, content: [text('deep')] },
                { type: 'heading', attrs: { level: 'two' }, content: [text('odd')] },
                { type: 'paragraph', attrs: { textAlign: 'middle' }, content: [text('odd')] },
                p(text('odd', { type: 'textStyle', attrs: { color: 7, fontFamily: ['Inter'] } })),
            ),
        );
        const [deep, odd, aligned, marked] = xmlChildren(body, W, 'p');
        expect(w(child(child(deep, 'pPr'), 'pStyle'), 'val')).toBe('Heading6');
        expect(w(child(child(odd, 'pPr'), 'pStyle'), 'val')).toBe('Heading1');
        expect(child(aligned, 'pPr')).toBeUndefined();
        expect(child(child(marked, 'r'), 'rPr')).toBeUndefined();
    });
});

// One run's properties in document order, each with its fill, w:val or font when it has one.
async function runProps(...marks: NonNullable<JSONContent['marks']>): Promise<string[][]> {
    const run = only(descendants(await bodyOf(doc(p(text('x', ...marks)))), W, 'r'));
    return xmlElements(child(run, 'rPr') ?? run)
        .filter((e) => e.local !== 't')
        .map((e) => {
            const value = w(e, 'fill') ?? w(e, 'val') ?? w(e, 'ascii');
            return value === undefined ? [e.local] : [e.local, value];
        });
}

describe('docx writer — paragraphs and headings', () => {
    test.each([
        ['left', 'left'],
        ['center', 'center'],
        ['right', 'right'],
        ['justify', 'both'],
    ])('textAlign %s is w:jc %s', async (textAlign, jc) => {
        const paragraph = only(
            xmlChildren(await bodyOf(doc({ type: 'paragraph', attrs: { textAlign }, content: [text('x')] })), W, 'p'),
        );
        expect(w(child(child(paragraph, 'pPr'), 'jc'), 'val')).toBe(jc);
    });

    test('a heading takes its level style and keeps its alignment', async () => {
        const body = await bodyOf(
            doc(p(text('x')), { type: 'heading', attrs: { level: 2, textAlign: 'right' }, content: [text('x')] }),
        );
        const heading = xmlChildren(body, W, 'p')[1];
        const pPr = child(heading, 'pPr');
        expect(shape(pPr ?? body)).toEqual(['pStyle', 'jc']);
        expect([w(child(pPr, 'pStyle'), 'val'), w(child(pPr, 'jc'), 'val')]).toEqual(['Heading2', 'right']);
    });

    test('a heading style is an outline level the navigator lists, kept with the next paragraph', async () => {
        const all = await styles();
        for (const level of [1, 2, 3, 4, 5, 6]) {
            const heading = style(all, `Heading${level}`);
            expect(w(child(heading, 'name'), 'val')).toBe(`heading ${level}`);
            expect([w(child(heading, 'basedOn'), 'val'), w(child(heading, 'next'), 'val')]).toEqual([
                'Normal',
                'Normal',
            ]);
            const pPr = child(heading, 'pPr');
            expect(child(pPr, 'keepNext')).toBeDefined();
            expect(child(pPr, 'keepLines')).toBeDefined();
            expect(w(child(pPr, 'outlineLvl'), 'val')).toBe(String(level - 1));
            expect(child(child(heading, 'rPr'), 'b')).toBeUndefined();
        }
    });

    test('a heading that opens the document drops its margin above, as h1:first-child to h4:first-child do', async () => {
        const heading = (level: number) => ({ type: 'heading', attrs: { level }, content: [text('x')] });
        const body = await bodyOf(doc(heading(1), heading(1)));
        const [first, second] = xmlChildren(body, W, 'p');
        expect(shape(child(first, 'pPr') ?? body)).toEqual(['pStyle', 'spacing']);
        expect(w(child(child(first, 'pPr'), 'spacing'), 'before')).toBe('0');
        expect(shape(child(second, 'pPr') ?? body)).toEqual(['pStyle']);
        const fifth = only(xmlChildren(await bodyOf(doc(heading(5))), W, 'p'));
        expect(shape(child(fifth, 'pPr') ?? fifth)).toEqual(['pStyle']);
    });

    test('an empty paragraph keeps its properties, and only a bare one is <w:p/>', async () => {
        const body = await bodyOf(
            doc(
                { type: 'paragraph', attrs: { textAlign: 'center' } },
                { type: 'heading', attrs: { level: 3 } },
                { type: 'paragraph' },
            ),
        );
        const [centred, heading, bare] = xmlChildren(body, W, 'p');
        expect(shape(centred ?? body)).toEqual(['pPr']);
        expect(w(child(child(centred, 'pPr'), 'jc'), 'val')).toBe('center');
        expect(w(child(child(heading, 'pPr'), 'pStyle'), 'val')).toBe('Heading3');
        expect(bare?.children).toEqual([]);
    });
});

describe('docx writer — marks', () => {
    test.each([
        ['bold', [['b'], ['bCs']]],
        ['italic', [['i'], ['iCs']]],
        ['underline', [['u', 'single']]],
        ['strike', [['strike']]],
        ['subscript', [['vertAlign', 'subscript']]],
        ['superscript', [['vertAlign', 'superscript']]],
        ['code', [['rStyle', 'Code']]],
    ])('%s', async (type, props) => {
        expect(await runProps({ type })).toEqual(props);
    });

    test('small is direct formatting from the CSS: 9 pt, a little spaced', async () => {
        expect(await runProps({ type: 'small' })).toEqual([
            ['spacing', '2'],
            ['sz', '18'],
            ['szCs', '18'],
        ]);
    });

    test('a text color and an Eigen font are written; rgb() is normalized', async () => {
        expect(
            await runProps({ type: 'textStyle', attrs: { color: 'rgb(192, 0, 0)', fontFamily: 'Source Serif 4' } }),
        ).toEqual([
            ['rFonts', 'Source Serif 4'],
            ['color', 'C00000'],
        ]);
        const run = only(
            descendants(
                await bodyOf(doc(p(text('x', { type: 'textStyle', attrs: { fontFamily: 'Source Serif 4' } })))),
                W,
                'rFonts',
            ),
        );
        expect(['ascii', 'hAnsi', 'eastAsia', 'cs'].map((slot) => w(run, slot))).toEqual(
            Array(4).fill('Source Serif 4'),
        );
    });

    test('a named color and an unknown font are dropped', async () => {
        expect(await runProps({ type: 'textStyle', attrs: { color: 'red', fontFamily: 'Comic Sans' } })).toEqual([]);
    });

    test('a highlight is a shading fill, yellow without a color', async () => {
        expect(await runProps({ type: 'highlight', attrs: { color: '#fef08a' } })).toEqual([['shd', 'FEF08A']]);
        expect(await runProps({ type: 'highlight', attrs: { color: null } })).toEqual([['shd', 'FFFF00']]);
        expect(await runProps({ type: 'highlight', attrs: { color: 'rgba(0, 0, 0, 0)' } })).toEqual([]);
        const shd = only(descendants(await bodyOf(doc(p(text('x', { type: 'highlight' })))), W, 'shd'));
        expect([w(shd, 'val'), w(shd, 'color')]).toEqual(['clear', 'auto']);
    });

    test('a comment mark adds nothing yet, and its text stays', async () => {
        const body = await bodyOf(doc(p(text('noted', { type: 'comment', attrs: { cardId: 'card-1' } }))));
        expect(texts(body)).toBe('noted');
        expect(await runProps({ type: 'comment', attrs: { cardId: 'card-1' } })).toEqual([]);
    });

    test('marks combine on one run in property order', async () => {
        expect(
            await runProps(
                { type: 'textStyle', attrs: { color: '#2563eb' } },
                { type: 'bold' },
                { type: 'italic' },
                { type: 'superscript' },
            ),
        ).toEqual([['b'], ['bCs'], ['i'], ['iCs'], ['color', '2563EB'], ['vertAlign', 'superscript']]);
    });

    test('inline code in a heading is 0.9 of the heading size', async () => {
        const body = await bodyOf(
            doc({ type: 'heading', attrs: { level: 1 }, content: [text('code', { type: 'code' })] }),
        );
        const rPr = child(only(descendants(body, W, 'r')), 'rPr');
        expect([w(child(rPr, 'rStyle'), 'val'), w(child(rPr, 'sz'), 'val'), w(child(rPr, 'szCs'), 'val')]).toEqual([
            'Code',
            '38',
            '38',
        ]);
    });
});

describe('docx writer — links', () => {
    async function hyperlinks(json: JSONContent, publicOrigin?: string) {
        const zip = await unzip(json, publicOrigin);
        const rels = new Map(
            xmlChildren(await part(zip, 'word/_rels/document.xml.rels'), RELS, 'Relationship').map((rel) => [
                xmlAttr(rel, '', 'Id'),
                rel,
            ]),
        );
        return descendants(await part(zip, 'word/document.xml'), W, 'hyperlink').map((link) => {
            const rel = rels.get(xmlAttr(link, R, 'id'));
            return {
                target: rel && xmlAttr(rel, '', 'Target'),
                external: rel && xmlAttr(rel, '', 'TargetMode'),
                type: rel && xmlAttr(rel, '', 'Type'),
                tooltip: w(link, 'tooltip'),
                history: w(link, 'history'),
                text: texts(link),
                styles: descendants(link, W, 'rStyle').map((s) => w(s, 'val')),
            };
        });
    }

    function linked(href: string, title?: string): JSONContent {
        return doc(
            p(text('before '), text('link', { type: 'link', attrs: { href, title: title ?? null } }), text(' after')),
        );
    }

    async function targetOf(href: string, publicOrigin?: string): Promise<string | undefined> {
        return only(await hyperlinks(linked(href), publicOrigin)).target;
    }

    test('a link is an external hyperlink relationship, its runs in the Hyperlink style', async () => {
        expect(await hyperlinks(linked('https://example.com', 'Example site'))).toEqual([
            {
                target: 'https://example.com',
                external: 'External',
                type: `${R}/hyperlink`,
                tooltip: 'Example site',
                history: '1',
                text: 'link',
                styles: ['Hyperlink'],
            },
        ]);
    });

    test('runs that share a link share one hyperlink, and one href is one relationship', async () => {
        const link = { type: 'link', attrs: { href: 'https://example.com/x' } };
        const links = await hyperlinks(
            doc(p(text('one', link), text(' two', link, { type: 'bold' }), text(' gap ')), p(text('three', link))),
        );
        expect(links.map((l) => l.text)).toEqual(['one two', 'three']);
        const zip = await unzip(doc(p(text('one', link)), p(text('two', link))));
        const rels = xmlChildren(await part(zip, 'word/_rels/document.xml.rels'), RELS, 'Relationship');
        expect(rels.filter((rel) => xmlAttr(rel, '', 'TargetMode') === 'External')).toHaveLength(1);
    });

    test.each(['javascript:alert(1)', `java${NONCHARACTER}script:alert(1)`, '\u0001', ''])(
        'a refused href %j leaves the text unlinked and unstyled',
        async (href) => {
            const body = await bodyOf(linked(href));
            expect(descendants(body, W, 'hyperlink')).toEqual([]);
            expect(descendants(body, W, 'rStyle')).toEqual([]);
            expect(texts(body)).toBe('before link after');
        },
    );

    test.each([
        ['https://example.com', 'https://example.com'],
        ['#frag', '#frag'],
        ['foo/bar', 'foo/bar'],
        ['../x', '../x'],
        ['//host/x', 'https://host/x'],
        ['https://example.com/?a=1&b="2"', 'https://example.com/?a=1&b=%222%22'],
        ['https://example.com/a b', 'https://example.com/a%20b'],
        ['/café', '/caf%C3%A9'],
        ['https://example.com/a%20b/caf%C3%A9?q=x%7Cy&n=1%', 'https://example.com/a%20b/caf%C3%A9?q=x%7Cy&n=1%'],
        ['https://example.com/{a}|^`\\<b>', 'https://example.com/%7Ba%7D%7C%5E%60%5C%3Cb%3E'],
        ['/contacts/team/x?contactId=a%40b', '/contacts/team/x?contactId=a%40b'],
    ])('%s is written as %s without a public origin', async (href, target) => {
        expect(await targetOf(href)).toBe(target);
    });

    test.each([
        ['/contacts/team/x?contactId=a%40b', 'https://eigen.example/contacts/team/x?contactId=a%40b'],
        ['/café', 'https://eigen.example/caf%C3%A9'],
        ['//host/x', 'https://host/x'],
        ['#frag', '#frag'],
        ['foo/bar', 'foo/bar'],
    ])('%s is written as %s with the public origin', async (href, target) => {
        expect(await targetOf(href, 'https://eigen.example')).toBe(target);
    });

    test('an encoded href encodes no further', async () => {
        const once = await targetOf('https://example.com/a b');
        expect(once).toBeDefined();
        expect(await targetOf(once ?? '')).toBe(once);
    });
});

describe('docx writer — lists', () => {
    const numbered = (ilvl: number, numId: number, after: number, runs: string) =>
        `<w:p><w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr><w:spacing w:after="${after}"/></w:pPr>${runs}</w:p>`;

    test("an item's first paragraph is numbered, 0.25em after it, the list's last 1em", async () => {
        expect(await paragraphsOf(doc(ul(li(p(text('one'))), li(p(text('two')))), p(text('after'))))).toEqual([
            numbered(0, 1, 55, run('one')),
            numbered(0, 1, 220, run('two')),
            `<w:p>${run('after')}</w:p>`,
        ]);
    });

    test('a list is one abstractNum with its start in all nine levels, and one num pointing at it', async () => {
        const numbering = await numberingOf(doc(ol({ start: 3 }, li(p(text('x'))))));
        const abstractNum = only(xmlChildren(numbering, W, 'abstractNum'));
        expect(w(abstractNum, 'abstractNumId')).toBe('0');
        const levels = xmlChildren(abstractNum, W, 'lvl');
        expect(levels.map((level) => w(level, 'ilvl'))).toEqual(['0', '1', '2', '3', '4', '5', '6', '7', '8']);
        expect(levels.map((level) => xmlOf(level)).filter((_, i) => i === 0 || i === 8)).toEqual([
            '<w:lvl w:ilvl="0"><w:start w:val="3"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="330" w:hanging="330"/></w:pPr></w:lvl>',
            '<w:lvl w:ilvl="8"><w:start w:val="3"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%9."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="2970" w:hanging="330"/></w:pPr></w:lvl>',
        ]);
        expect(xmlOf(only(xmlChildren(numbering, W, 'num')))).toBe(
            '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>',
        );
        expect(descendants(numbering, W, 'lvlOverride')).toEqual([]);
    });

    test('a bullet is a disc at every level', async () => {
        const levels = descendants(await numberingOf(doc(ul(li(p(text('x')))))), W, 'lvl');
        expect(levels).toHaveLength(9);
        for (const level of levels) {
            expect([
                w(child(level, 'start'), 'val'),
                w(child(level, 'numFmt'), 'val'),
                w(child(level, 'lvlText'), 'val'),
            ]).toEqual(['1', 'bullet', '•']);
        }
    });

    test.each([
        ['1', 'decimal'],
        ['a', 'lowerLetter'],
        ['A', 'upperLetter'],
        ['i', 'lowerRoman'],
        ['I', 'upperRoman'],
        [null, 'decimal'],
        ['z', 'decimal'],
    ])('type %p numbers in %s', async (type, format) => {
        const levels = descendants(await numberingOf(doc(ol({ type }, li(p(text('x')))))), W, 'lvl');
        expect(new Set(levels.map((level) => w(child(level, 'numFmt'), 'val')))).toEqual(new Set([format]));
    });

    test.each([
        [-5, '0'],
        [1e9, '32767'],
        [2.6, '3'],
        ['7', '1'],
        [Number.NaN, '1'],
    ])('start %p is written as %s', async (start, written) => {
        const level = descendants(await numberingOf(doc(ol({ start }, li(p(text('x')))))), W, 'lvl')[0];
        expect(w(child(level, 'start'), 'val')).toBe(written);
    });

    test('a nested list is its own abstractNum one level in; only the outer list ends 1em above', async () => {
        const json = doc(
            ul(li(p(text('outer')), ol({}, li(p(text('inner one'))), li(p(text('inner two'))))), li(p(text('last')))),
        );
        expect(await paragraphsOf(json)).toEqual([
            numbered(0, 1, 55, run('outer')),
            numbered(1, 2, 55, run('inner one')),
            numbered(1, 2, 55, run('inner two')),
            numbered(0, 1, 220, run('last')),
        ]);
        const [outer, inner] = xmlChildren(await numberingOf(json), W, 'abstractNum');
        const indent = (list: XmlElement | undefined, ilvl: number) =>
            w(child(child(list && xmlChildren(list, W, 'lvl')[ilvl], 'pPr'), 'ind'), 'left');
        expect([indent(outer, 0), indent(inner, 1)]).toEqual(['330', '660']);
        expect(w(child(child(inner, 'lvl'), 'numFmt'), 'val')).toBe('decimal');
    });

    test('two adjacent lists count separately', async () => {
        const json = doc(ol({}, li(p(text('a')))), ol({}, li(p(text('b')))));
        const numIds = descendants(await bodyOf(json), W, 'numId').map((numId) => w(numId, 'val'));
        expect(numIds).toEqual(['1', '2']);
        const nums = xmlChildren(await numberingOf(json), W, 'num');
        expect(nums.map((num) => w(child(num, 'abstractNumId'), 'val'))).toEqual(['0', '1']);
    });

    test('every abstractNum has an nsid of its own, 8 hex digits, and all abstractNums come before the nums', async () => {
        const numbering = await numberingOf(doc(ul(li(p(text('a')), ul(li(p(text('b')))))), ol({}, li(p(text('c'))))));
        const nsids = descendants(numbering, W, 'nsid').map((nsid) => w(nsid, 'val') ?? '');
        expect(nsids).toHaveLength(3);
        expect(new Set(nsids).size).toBe(3);
        for (const nsid of nsids) expect(nsid).toMatch(/^[0-9A-F]{8}$/);
        expect(shape(numbering)).toEqual(['abstractNum', 'abstractNum', 'abstractNum', 'num', 'num', 'num']);
    });

    test("an item's other blocks are indented to its text, unnumbered", async () => {
        expect(await paragraphsOf(doc(ul(li(p(text('first')), p(text('second'))), li(p(text('next'))))))).toEqual([
            numbered(0, 1, 55, run('first')),
            `<w:p><w:pPr><w:spacing w:after="55"/><w:ind w:left="330"/></w:pPr>${run('second')}</w:p>`,
            numbered(0, 1, 220, run('next')),
        ]);
    });

    test('an empty list item keeps its number', async () => {
        expect(await paragraphsOf(doc(ul(li(p()))))).toEqual([numbered(0, 1, 220, '')]);
    });

    test("a list in a quote is numbered inside the quote's indent", async () => {
        const json = doc(quote(ul(li(p(text('x'))))));
        expect(await paragraphsOf(json)).toEqual([
            `<w:p><w:pPr><w:pStyle w:val="Quote"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:spacing w:after="220"/></w:pPr>${run('x')}</w:p>`,
        ]);
        const level = descendants(await numberingOf(json), W, 'lvl')[0];
        expect(w(child(child(level, 'pPr'), 'ind'), 'left')).toBe('595');
    });

    test('a list item or a task item outside its list is written, unnumbered', async () => {
        const paragraphs = await paragraphsOf(doc(li(p(text('stray'))), task(true, p(text('lost')))));
        expect(paragraphs[0]).toBe(
            `<w:p><w:pPr><w:spacing w:after="55"/><w:ind w:left="330"/></w:pPr>${run('stray')}</w:p>`,
        );
        expect(paragraphs[1]).toContain('lost');
    });
});

describe('docx writer — task lists', () => {
    const checkbox = (checked: boolean) =>
        `<w:sdt><w:sdtPr><w14:checkbox><w14:checked w14:val="${checked ? 1 : 0}"/><w14:checkedState w14:val="2612" w14:font="MS Gothic"/><w14:uncheckedState w14:val="2610" w14:font="MS Gothic"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:rPr><w:rFonts w:ascii="MS Gothic" w:hAnsi="MS Gothic" w:eastAsia="MS Gothic" w:cs="MS Gothic"/><w:strike w:val="0"/></w:rPr><w:t>${checked ? '☒' : '☐'}</w:t></w:r></w:sdtContent></w:sdt><w:r><w:rPr><w:strike w:val="0"/></w:rPr><w:tab/></w:r>`;

    test('an item opens with a checkbox control and a tab that is never struck, its text hanging a level in', async () => {
        expect(
            await paragraphsOf(doc(tasks(task(false, p(text('open'))), task(true, p(text('done')))), p(text('after')))),
        ).toEqual([
            `<w:p><w:pPr><w:spacing w:after="0"/><w:ind w:left="330" w:hanging="330"/></w:pPr>${checkbox(false)}${run('open')}</w:p>`,
            `<w:p><w:pPr><w:pStyle w:val="TaskDone"/><w:spacing w:after="220"/><w:ind w:left="330" w:hanging="330"/></w:pPr>${checkbox(true)}${run('done')}</w:p>`,
            `<w:p>${run('after')}</w:p>`,
        ]);
    });

    test('a checked item strikes all its content, nested items included', async () => {
        const paragraphs = await paragraphsOf(
            doc(tasks(task(true, p(text('done')), p(text('more')), tasks(task(false, p(text('nested'))))))),
        );
        expect(paragraphs.slice(1)).toEqual([
            `<w:p><w:pPr><w:pStyle w:val="TaskDone"/><w:spacing w:after="0"/><w:ind w:left="330"/></w:pPr>${run('more')}</w:p>`,
            `<w:p><w:pPr><w:pStyle w:val="TaskDone"/><w:spacing w:after="220"/><w:ind w:left="660" w:hanging="330"/></w:pPr>${checkbox(false)}${run('nested')}</w:p>`,
        ]);
    });

    test('the Task Done style strikes in the muted color', async () => {
        expect(xmlOf(style(await styles(), 'TaskDone'))).toBe(
            '<w:style w:type="paragraph" w:styleId="TaskDone"><w:name w:val="Task Done"/><w:basedOn w:val="Normal"/><w:rPr><w:strike/><w:color w:val="6B7280"/></w:rPr></w:style>',
        );
    });

    test('MS Gothic, the checkbox glyphs, joins the font table only with a task list', async () => {
        const names = async (json: JSONContent) =>
            xmlChildren(await part(await unzip(json), 'word/fontTable.xml'), W, 'font').map((font) => w(font, 'name'));
        expect(await names(doc(p(text('x'))))).not.toContain('MS Gothic');
        expect(await names(doc(tasks(task(false, p(text('x'))))))).toEqual([
            'Inter',
            'Source Serif 4',
            'JetBrains Mono',
            'Excalifont',
            'MS Gothic',
        ]);
    });
});

describe('docx writer — tables', () => {
    const tablesIn = async (json: JSONContent) => xmlChildren(await bodyOf(json), W, 'tbl');
    const cell = (width: number, runs: string, tcPr = '', pPr = '<w:spacing w:after="0"/>') =>
        `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${tcPr}</w:tcPr><w:p><w:pPr>${pPr}</w:pPr>${runs}</w:p></w:tc>`;
    const SHADED = '<w:shd w:val="clear" w:color="auto" w:fill="F9FAFB"/>';
    const SPACER = '<w:p><w:pPr><w:pStyle w:val="Spacer"/><w:spacing w:before="165"/></w:pPr></w:p>';
    const gridOf = (tbl: XmlElement | undefined) => {
        const grid = child(tbl, 'tblGrid');
        return grid ? xmlChildren(grid, W, 'gridCol').map((gridCol) => Number(w(gridCol, 'w'))) : [];
    };

    test("every column known is a fixed table that wide, with the editor's borders and cell padding", async () => {
        const tbl = only(
            await tablesIn(
                doc(
                    table(
                        tr(th({ colwidth: [120] }, p(text('A'))), th({ colwidth: [160] }, p(text('B')))),
                        tr(td({ colwidth: [120] }, p(text('a'))), td({ colwidth: [160] }, p(text('b')))),
                    ),
                ),
            ),
        );
        const border = (side: string) => `<w:${side} w:val="single" w:sz="6" w:space="0" w:color="D1D5DB"/>`;
        const margin = (side: string, width: number) => `<w:${side} w:w="${width}" w:type="dxa"/>`;
        expect(xmlOf(child(tbl, 'tblPr'))).toBe(
            `<w:tblPr><w:tblW w:w="4200" w:type="dxa"/><w:tblInd w:w="0" w:type="dxa"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar>${margin('top', 88)}${margin('left', 176)}${margin('bottom', 88)}${margin('right', 176)}</w:tblCellMar></w:tblPr>`,
        );
        expect(xmlOf(child(tbl, 'tblGrid'))).toBe(
            '<w:tblGrid><w:gridCol w:w="1800"/><w:gridCol w:w="2400"/></w:tblGrid>',
        );
        expect(xmlChildren(tbl, W, 'tr').map(xmlOf)).toEqual([
            `<w:tr><w:trPr><w:tblHeader/></w:trPr>${cell(1800, run('A'), SHADED)}${cell(2400, run('B'), SHADED)}</w:tr>`,
            `<w:tr>${cell(1800, run('a'))}${cell(2400, run('b'))}</w:tr>`,
        ]);
    });

    test('colwidths past the text column are scaled to it, none narrower than 25 px', async () => {
        const widths = [400, 400, 400, 10].map((width) => td({ colwidth: [width] }, p(text('x'))));
        const tbl = only(await tablesIn(doc(table(tr(...widths)))));
        expect(gridOf(tbl)).toEqual([3180, 3180, 3180, 375]);
        expect(w(child(child(tbl, 'tblPr'), 'tblW'), 'w')).toBe('9915');
    });

    test('a column without a colwidth shares what the known ones leave, and the table fills the column', async () => {
        const [shared, floored] = await tablesIn(
            doc(
                table(tr(td({ colwidth: [100] }, p()), td({}, p()), td({ colwidth: null }, p()))),
                table(tr(td({ colwidth: [640] }, p()), td({ colwidth: [0] }, p()))),
            ),
        );
        expect(gridOf(shared)).toEqual([1500, 4065, 4065]);
        expect(gridOf(floored)).toEqual([9600, 375]);
        const tblPr = child(shared, 'tblPr');
        expect(xmlOf(child(tblPr, 'tblW'))).toBe('<w:tblW w:w="5000" w:type="pct"/>');
        expect(child(tblPr, 'tblLayout')).toBeUndefined();
    });

    test("a colspan spans its columns' widths, a rowspan restarts a vertical merge its covered cells continue", async () => {
        const tbl = only(
            await tablesIn(
                doc(
                    table(
                        tr(...['a', 'b', 'c'].map((value) => td({ colwidth: [100] }, p(text(value))))),
                        tr(
                            td({ colspan: 2, colwidth: [100, 100] }, p(text('wide'))),
                            td({ rowspan: 2, colwidth: [100] }, p(text('tall'))),
                        ),
                        tr(td({ colwidth: [100] }, p(text('d'))), td({ colwidth: [100] }, p(text('e')))),
                    ),
                ),
            ),
        );
        const [, second, third] = xmlChildren(tbl, W, 'tr').map(xmlOf);
        expect(second).toBe(
            `<w:tr>${cell(3000, run('wide'), '<w:gridSpan w:val="2"/>')}${cell(1500, run('tall'), '<w:vMerge w:val="restart"/>')}</w:tr>`,
        );
        expect(third).toBe(
            `<w:tr>${cell(1500, run('d'))}${cell(1500, run('e'))}<w:tc><w:tcPr><w:tcW w:w="1500" w:type="dxa"/><w:vMerge/></w:tcPr><w:p/></w:tc></w:tr>`,
        );
    });

    test('a covered cell sits at its column, before the cells right of it, and spans as its merge does', async () => {
        const tbl = only(
            await tablesIn(
                doc(
                    table(
                        tr(
                            td({ colspan: 2, rowspan: 2, colwidth: [100, 100] }, p(text('x'))),
                            td({ colwidth: [100] }, p(text('y'))),
                        ),
                        tr(td({ colwidth: [100] }, p(text('z')))),
                    ),
                ),
            ),
        );
        expect(xmlOf(xmlChildren(tbl, W, 'tr')[1])).toBe(
            `<w:tr><w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:gridSpan w:val="2"/><w:vMerge/></w:tcPr><w:p/></w:tc>${cell(1500, run('z'))}</w:tr>`,
        );
    });

    test('a short row is filled with empty cells', async () => {
        const tbl = only(
            await tablesIn(doc(table(tr(td({}, p(text('a'))), td({}, p(text('b')))), tr(td({}, p(text('c'))))))),
        );
        expect(xmlOf(xmlChildren(tbl, W, 'tr')[1])).toBe(
            `<w:tr>${cell(4815, run('c'))}<w:tc><w:tcPr><w:tcW w:w="4815" w:type="dxa"/></w:tcPr><w:p/></w:tc></w:tr>`,
        );
    });

    test('only a row of header cells repeats as a header; a header column is only shaded; no tblHeader is off', async () => {
        const body = await bodyOf(
            doc(
                table(tr(th({}, p(text('A'))), th({}, p(text('B')))), tr(th({}, p(text('row'))), td({}, p(text('x'))))),
            ),
        );
        const [header, row] = descendants(body, W, 'tr');
        expect(shape(header ?? body)).toEqual(['trPr', 'tc', 'tc']);
        expect(shape(row ?? body)).toEqual(['tc', 'tc']);
        expect(descendants(row ?? body, W, 'shd').map((shd) => w(shd, 'fill'))).toEqual(['F9FAFB']);
        for (const tblHeader of descendants(body, W, 'tblHeader')) expect(tblHeader.attributes).toEqual({});
    });

    test("a cell's align is the jc of each paragraph in it without its own", async () => {
        const body = await bodyOf(
            doc(
                table(
                    tr(
                        td(
                            { align: 'center' },
                            p(text('a')),
                            { type: 'paragraph', attrs: { textAlign: 'right' }, content: [text('b')] },
                            quote(p(text('c'))),
                        ),
                        td({ align: 'sideways' }, p(text('d'))),
                    ),
                ),
            ),
        );
        expect(descendants(body, W, 'jc').map((jc) => w(jc, 'val'))).toEqual(['center', 'right', 'center']);
    });

    test('spans past the grid or the rows are clamped, and ones of the wrong type are 1', async () => {
        const tbl = only(
            await tablesIn(
                doc(table(tr(td({ colspan: 1000, rowspan: 9 }, p(text('x'))), td({ colspan: 'two' }, p(text('y')))))),
            ),
        );
        expect(gridOf(tbl)).toHaveLength(63);
        expect(descendants(tbl, W, 'gridSpan').map((gridSpan) => w(gridSpan, 'val'))).toEqual(['63']);
        expect(descendants(tbl, W, 'vMerge')).toEqual([]);
    });

    test("the grid stops at Word's 63 columns: a colspan takes what is left, a cell past it joins the row's last cell", async () => {
        const wide = (value: string) => td({ colspan: 30 }, p(text(value)));
        const tbl = only(
            await tablesIn(
                doc(
                    table(
                        tr(wide('a'), wide('b'), wide('c'), td({}, p(text('d'))), td({}, p(text('e')))),
                        tr(td({ colspan: 63, rowspan: 2 }, p(text('f')))),
                        tr(td({}, p(text('g')))),
                    ),
                ),
            ),
        );
        expect(gridOf(tbl)).toHaveLength(63);
        const [first, second, third] = xmlChildren(tbl, W, 'tr');
        expect(descendants(first ?? tbl, W, 'gridSpan').map((gridSpan) => w(gridSpan, 'val'))).toEqual([
            '30',
            '30',
            '3',
        ]);
        expect(xmlChildren(first ?? tbl, W, 'tc').map(texts)).toEqual(['a', 'b', 'cde']);
        expect(xmlChildren(second ?? tbl, W, 'tc').map(texts)).toEqual(['fg']);
        expect(xmlChildren(third ?? tbl, W, 'tc').map(texts)).toEqual(['']);
    });

    test('a known colwidth past the column is scaled beside an unknown one, in whole twips', async () => {
        const tbl = only(await tablesIn(doc(table(tr(td({ colwidth: [1e20] }, p()), td({ colwidth: null }, p()))))));
        expect(gridOf(tbl)).toEqual([9630, 375]);
        expect(descendants(tbl, W, 'tcW').map((tcW) => w(tcW, 'w'))).toEqual(['9630', '375']);
    });

    test('a table that ends the body or a cell is followed by a Spacer, and two tables are kept apart by one', async () => {
        const one = table(tr(td({}, p(text('x')))));
        const body = await bodyOf(doc(one, one, p(text('after')), one));
        expect(shape(body)).toEqual(['tbl', 'p', 'tbl', 'p', 'tbl', 'p', 'sectPr']);
        const [, between, , after, , last] = xmlElements(body).map(xmlOf);
        expect([between, last]).toEqual([SPACER, SPACER]);
        expect(after).toBe(`<w:p><w:pPr><w:spacing w:before="165"/></w:pPr>${run('after')}</w:p>`);

        const [tc] = descendants(await bodyOf(doc(table(tr(td({}, p(text('x')), one, one))))), W, 'tc');
        expect(tc && shape(tc)).toEqual(['tcPr', 'p', 'tbl', 'p', 'tbl', 'p']);
        expect(tc && xmlChildren(tc, W, 'p').slice(1).map(xmlOf)).toEqual([SPACER, SPACER]);
    });

    test('the block after a table keeps a larger margin of its own above, and takes the margin in a list too', async () => {
        const one = table(tr(td({}, p(text('x')))));
        const [, afterHeading] = xmlElements(await bodyOf(doc(one, heading(1, text('h')))));
        expect(xmlOf(child(afterHeading, 'pPr'))).toBe('<w:pPr><w:pStyle w:val="Heading1"/></w:pPr>');

        const body = await bodyOf(doc(ul(li(p(text('x')), one), li(p(text('y'))))));
        expect(w(child(child(child(body, 'tbl'), 'tblPr'), 'tblInd'), 'w')).toBe('330');
        const next = xmlChildren(body, W, 'p')[1];
        expect(xmlOf(child(child(next, 'pPr'), 'spacing'))).toBe('<w:spacing w:before="165" w:after="220"/>');
    });

    test('a table in a list item is scaled to what its indent leaves, a nested table to its cell', async () => {
        const wide = table(tr(td({ colwidth: [700] }, p(text('x')))));
        expect(gridOf((await tablesIn(doc(ul(li(p(text('x')), wide)))))[0])).toEqual([9300]);
        const nested = table(tr(td({ colwidth: [300] }, wide)));
        const [outer] = await tablesIn(doc(nested));
        expect(gridOf(child(child(child(outer, 'tr'), 'tc'), 'tbl'))).toEqual([4140]);
    });

    test('an empty cell is one paragraph, and a table with no cells writes nothing', async () => {
        const tbl = only(await tablesIn(doc(table(tr(td({}))))));
        expect(xmlOf(only(descendants(tbl, W, 'p')))).toBe('<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>');
        expect(shape(await bodyOf(doc(table(), table(tr()))))).toEqual(['sectPr']);
    });

    test('a row or cell outside a table, and content outside a row or cell, still export, in a table', async () => {
        const body = await bodyOf(
            doc(
                { type: 'tableRow', content: [td({}, p(text('row')))] },
                th({}, p(text('cell'))),
                { type: 'table', content: [p(text('stray'))] },
                table({ type: 'tableRow', content: [p(text('loose'))] }),
            ),
        );
        expect(descendants(body, W, 'tbl').map(texts)).toEqual(['row', 'cell', 'stray', 'loose']);
    });
});

describe('docx writer — code blocks', () => {
    // Each line's runs as text, color and italic.
    async function codeLines(json: JSONContent): Promise<(string | undefined)[][][]> {
        const paragraphs = xmlChildren(await bodyOf(json), W, 'p');
        for (const paragraph of paragraphs) {
            expect(w(child(child(paragraph, 'pPr'), 'pStyle'), 'val')).toBe('CodeBlock');
        }
        return paragraphs.map((paragraph) =>
            xmlChildren(paragraph, W, 'r').map((r) => {
                const rPr = child(r, 'rPr');
                return [texts(r), w(child(rPr, 'color'), 'val'), child(rPr, 'i') && 'i'];
            }),
        );
    }

    test('one paragraph per line in the Code Block style, tokens colored as the editor colors them', async () => {
        expect(await codeLines(doc(code('const a = "x";\nreturn 1;', 'javascript')))).toEqual([
            [
                ['const', 'CBA6F7', undefined],
                [' a = ', undefined, undefined],
                ['"x"', 'A6E3A1', undefined],
                [';', undefined, undefined],
            ],
            [
                ['return', 'CBA6F7', undefined],
                [' ', undefined, undefined],
                ['1', 'FAB387', undefined],
                [';', undefined, undefined],
            ],
        ]);
    });

    test('a token spanning lines is split at the break and keeps its color and italic on both lines', async () => {
        expect(await codeLines(doc(code('/* one\ntwo */', 'javascript')))).toEqual([
            [['/* one', '6C7086', 'i']],
            [['two */', '6C7086', 'i']],
        ]);
    });

    test("a token inside another without a color of its own keeps the outer one's", async () => {
        expect(await codeLines(doc(code('f"a{b}"', 'python')))).toEqual([
            [
                ['f"a', 'A6E3A1', undefined],
                ['{b}', 'A6E3A1', undefined],
                ['"', 'A6E3A1', undefined],
            ],
        ]);
    });

    test('\\r\\n and U+000B split lines too, an empty line stays, a tab stays in its line', async () => {
        const body = await bodyOf(doc(code('a\r\nb\u000Bc\n\n\td', 'plaintext')));
        const paragraphs = xmlChildren(body, W, 'p');
        expect(paragraphs.map(texts)).toEqual(['a', 'b', 'c', '', 'd']);
        expect(xmlOf(paragraphs[3] ?? body)).toBe('<w:p><w:pPr><w:pStyle w:val="CodeBlock"/></w:pPr></w:p>');
        expect(shape(child(paragraphs[4], 'r') ?? body)).toEqual(['tab', 't']);
    });

    test('the language is not written, and one lowlight lacks is highlighted automatically, as in the HTML', async () => {
        const auto = await paragraphsOf(doc(code('const a = 1;')));
        expect(await paragraphsOf(doc(code('const a = 1;', 'no-such-language')))).toEqual(auto);
        expect(auto.join('')).toContain('w:color');
        expect(auto.join('')).not.toContain('no-such-language');
    });

    test("the Code Block style is the editor's dark box: borders as its padding, shading, mono at 286 auto", async () => {
        expect(xmlOf(style(await styles(), 'CodeBlock'))).toBe(
            '<w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:pPr><w:pBdr><w:top w:val="single" w:sz="4" w:space="11" w:color="1E1E2E"/><w:left w:val="single" w:sz="4" w:space="14" w:color="1E1E2E"/><w:bottom w:val="single" w:sz="4" w:space="11" w:color="1E1E2E"/><w:right w:val="single" w:sz="4" w:space="14" w:color="1E1E2E"/></w:pBdr><w:shd w:val="clear" w:color="auto" w:fill="1E1E2E"/><w:spacing w:before="165" w:after="165" w:line="286" w:lineRule="auto"/><w:ind w:left="290" w:right="290"/><w:contextualSpacing/></w:pPr><w:rPr><w:rFonts w:ascii="JetBrains Mono" w:hAnsi="JetBrains Mono" w:eastAsia="JetBrains Mono" w:cs="JetBrains Mono"/><w:color w:val="CDD6F4"/><w:sz w:val="19"/><w:szCs w:val="19"/></w:rPr></w:style>',
        );
    });

    test('two adjacent code blocks are kept apart by a Spacer, or readers draw one box', async () => {
        const paragraphs = await paragraphsOf(doc(code('a', 'plaintext'), code('b', 'plaintext'), p(text('c'))));
        expect(paragraphs.map((paragraph) => paragraph.includes('CodeBlock'))).toEqual([true, false, true, false]);
        expect(paragraphs[1]).toBe(SPACER_XML);
        const inItem = await paragraphsOf(doc(ul(li(p(text('x')), code('a', 'plaintext'), code('b', 'plaintext')))));
        expect(inItem[2]).toBe(SPACER_XML);
        expect(await paragraphsOf(doc(code('a', 'plaintext'), p(text('b')), code('c', 'plaintext')))).not.toContain(
            SPACER_XML,
        );
    });

    test("a code block in a list item moves its box to the item's text", async () => {
        const paragraphs = await paragraphsOf(doc(ul(li(p(text('x')), code('a', 'plaintext')), li(p(text('y'))))));
        expect(paragraphs[1]).toBe(
            '<w:p><w:pPr><w:pStyle w:val="CodeBlock"/><w:ind w:left="620" w:right="290"/></w:pPr><w:r><w:t xml:space="preserve">a</w:t></w:r></w:p>',
        );
    });
});

describe('docx writer — quotes', () => {
    const quoted = (runs: string, pPr = '') => `<w:p><w:pPr><w:pStyle w:val="Quote"/>${pPr}</w:pPr>${runs}</w:p>`;

    test('each paragraph takes the Quote style, the last 1em above the next block', async () => {
        expect(await paragraphsOf(doc(quote(p(text('one')), p(text('two'))), p(text('after'))))).toEqual([
            quoted(run('one')),
            quoted(run('two'), '<w:spacing w:after="220"/>'),
            `<w:p>${run('after')}</w:p>`,
        ]);
    });

    test("the Quote style is the editor's bar, padding and grey italic", async () => {
        expect(xmlOf(style(await styles(), 'Quote'))).toBe(
            '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="11" w:color="D1D5DB"/></w:pBdr><w:spacing w:after="0"/><w:ind w:left="265"/></w:pPr><w:rPr><w:i/><w:iCs/><w:color w:val="6B7280"/></w:rPr></w:style>',
        );
    });

    test('a heading in a quote keeps its style and takes the bar and indent directly', async () => {
        expect(await paragraphsOf(doc(quote(heading(2, text('quoted')), p(text('body')))))).toEqual([
            `<w:p><w:pPr><w:pStyle w:val="Heading2"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="11" w:color="D1D5DB"/></w:pBdr><w:spacing w:before="0"/><w:ind w:left="265"/></w:pPr>${run('quoted')}</w:p>`,
            quoted(run('body'), '<w:spacing w:after="220"/>'),
        ]);
    });

    test('two adjacent quotes are kept apart by a Spacer, or readers draw one bar', async () => {
        expect(await paragraphsOf(doc(quote(p(text('one'))), quote(p(text('two')))))).toEqual([
            quoted(run('one'), '<w:spacing w:after="220"/>'),
            SPACER_XML,
            quoted(run('two'), '<w:spacing w:after="220"/>'),
        ]);
        expect(await paragraphsOf(doc(quote(p(text('one'))), code('x', 'plaintext')))).not.toContain(SPACER_XML);
    });

    test('a nested quote adds its indent', async () => {
        expect(await paragraphsOf(doc(quote(p(text('outer')), quote(p(text('inner'))))))).toEqual([
            quoted(run('outer')),
            quoted(run('inner'), '<w:spacing w:after="220"/><w:ind w:left="530"/>'),
        ]);
    });

    test("a quote in a list item sits at the item's text", async () => {
        const paragraphs = await paragraphsOf(doc(ul(li(p(text('item')), quote(p(text('quoted')))))));
        expect(paragraphs[1]).toBe(quoted(run('quoted'), '<w:spacing w:after="220"/><w:ind w:left="595"/>'));
    });
});

describe('docx writer — horizontal rules', () => {
    test('a rule is an empty paragraph in the Horizontal Rule style, its line a bottom border', async () => {
        expect(await paragraphsOf(doc(RULE))).toEqual(['<w:p><w:pPr><w:pStyle w:val="HorizontalRule"/></w:pPr></w:p>']);
        expect(xmlOf(style(await styles(), 'HorizontalRule'))).toBe(
            '<w:style w:type="paragraph" w:styleId="HorizontalRule"><w:name w:val="Horizontal Rule"/><w:basedOn w:val="Normal"/><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="E0E0E6"/></w:pBdr><w:spacing w:before="330" w:after="330" w:line="20" w:lineRule="exact"/></w:pPr><w:rPr><w:sz w:val="2"/><w:szCs w:val="2"/></w:rPr></w:style>',
        );
    });

    test("a rule in a list item starts at the item's text, and keeps its own larger margin below", async () => {
        const paragraphs = await paragraphsOf(doc(ul(li(p(text('x')), RULE))));
        expect(paragraphs[1]).toBe('<w:p><w:pPr><w:pStyle w:val="HorizontalRule"/><w:ind w:left="330"/></w:pPr></w:p>');
    });
});

function figure(attrs: Record<string, unknown>): JSONContent {
    return { type: 'figure', attrs };
}

describe('docx writer — figures', () => {
    // The fixture's media: chart.png 800 × 500, photo.jpeg 4000 × 3000, diagram.svg 300 × 150 beside its PNG.
    const CHART = { mediaName: 'chart.png' };
    // The A4 text column less 2 cm margins, 9638 twips, in whole px.
    const COLUMN_PX = 642;
    const IMAGE_REL = `${R}/image`;

    // The drawing exactly as § 3.4 writes it; the namespace declaration on svgBlip is left out by xmlOf.
    function drawing(o: {
        id: number;
        px: number;
        ratio: number;
        part: string;
        embed: string;
        descr?: string;
        svg?: string;
    }) {
        const cx = o.px * 9525;
        const cy = Math.round(cx * o.ratio);
        const descr = o.descr ?? '';
        const blip = o.svg
            ? `<a:blip r:embed="${o.embed}"><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip r:embed="${o.svg}"/></a:ext></a:extLst></a:blip>`
            : `<a:blip r:embed="${o.embed}"/>`;
        return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${o.id}" name="Picture ${o.id}" descr="${descr}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${o.id}" name="${o.part}" descr="${descr}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill>${blip}<a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    }

    const chart = (px: number, id = 1) => drawing({ id, px, ratio: 500 / 800, part: 'image1.png', embed: 'rId5' });

    const imageParagraph = (runs: string, jc = 'center', after = 165, ind = '') =>
        `<w:p><w:pPr><w:spacing w:before="165" w:after="${after}" w:line="240" w:lineRule="auto"/>${ind}<w:jc w:val="${jc}"/></w:pPr>${runs}</w:p>`;

    // The width of each figure's extent, in px.
    async function widthsOf(json: JSONContent): Promise<number[]> {
        return descendants(await bodyOf(json), WP, 'extent').map((extent) => Number(xmlAttr(extent, '', 'cx')) / 9525);
    }

    async function relationshipsOf(zip: JSZip) {
        return xmlChildren(await part(zip, 'word/_rels/document.xml.rels'), RELS, 'Relationship').map((rel) => [
            xmlAttr(rel, '', 'Id'),
            xmlAttr(rel, '', 'Type'),
            xmlAttr(rel, '', 'Target'),
        ]);
    }

    function floating(side: 'left' | 'right', px: number, cell: string) {
        const tw = px * 15;
        const nil = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
            .map((b) => `<w:${b} w:val="nil"/>`)
            .join('');
        const flush = ['top', 'left', 'bottom', 'right'].map((b) => `<w:${b} w:w="0" w:type="dxa"/>`).join('');
        return `<w:tbl><w:tblPr><w:tblpPr w:leftFromText="${side === 'right' ? 220 : 0}" w:rightFromText="${side === 'left' ? 220 : 0}" w:topFromText="55" w:bottomFromText="110" w:vertAnchor="text" w:horzAnchor="margin" w:tblpXSpec="${side}" w:tblpY="1"/><w:tblOverlap w:val="never"/><w:tblW w:w="${tw}" w:type="dxa"/><w:tblBorders>${nil}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar>${flush}</w:tblCellMar></w:tblPr><w:tblGrid><w:gridCol w:w="${tw}"/></w:tblGrid><w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc><w:tcPr><w:tcW w:w="${tw}" w:type="dxa"/></w:tcPr>${cell}</w:tc></w:tr></w:tbl>`;
    }

    const floatingImage = (runs: string) =>
        `<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/><w:jc w:val="center"/></w:pPr>${runs}</w:p>`;
    const floatingCaption = (value: string) =>
        `<w:p><w:pPr><w:pStyle w:val="Caption"/><w:spacing w:before="23" w:after="0"/><w:jc w:val="center"/></w:pPr>${run(value)}</w:p>`;

    test('a block figure is an inline drawing in a single-spaced paragraph, its extent from the width and the ratio', async () => {
        expect(await blocksOf(doc(p(figure({ ...CHART, width: 320, alt: 'A chart' }))))).toEqual([
            imageParagraph(
                drawing({ id: 1, px: 320, ratio: 500 / 800, part: 'image1.png', embed: 'rId5', descr: 'A chart' }),
            ),
        ]);
    });

    test('a caption follows in the Caption style, both aligned as the figure, and takes the margin below', async () => {
        expect(
            await blocksOf(doc(p(figure({ ...CHART, width: 320, alignment: 'right', caption: 'Figure 1\tchart' })))),
        ).toEqual([
            imageParagraph(chart(320), 'right', 0),
            '<w:p><w:pPr><w:pStyle w:val="Caption"/><w:jc w:val="right"/></w:pPr><w:r><w:t xml:space="preserve">Figure 1</w:t><w:tab/><w:t xml:space="preserve">chart</w:t></w:r></w:p>',
        ]);
    });

    test.each([
        ['left', 'left'],
        ['center', 'center'],
        ['right', 'right'],
        ['sideways', 'center'],
        [null, 'center'],
    ])('alignment %p is w:jc %s', async (alignment, jc) => {
        const [image] = xmlChildren(await bodyOf(doc(p(figure({ ...CHART, width: 100, alignment })))), W, 'p');
        expect(w(child(child(image, 'pPr'), 'jc'), 'val')).toBe(jc);
    });

    test.each([
        [2000, COLUMN_PX],
        [320.4, 320],
        [null, COLUMN_PX],
        [0, COLUMN_PX],
        [-50, COLUMN_PX],
        [Number.NaN, COLUMN_PX],
        ['300', COLUMN_PX],
    ])('width %p shows %p px wide, inside the column', async (width, px) => {
        expect(await widthsOf(doc(p(figure({ ...CHART, width }))))).toEqual([px]);
    });

    test('without a width a figure is its natural size, capped at the column, half of it when wrapped', async () => {
        const natural = await widthsOf(
            doc(
                p(figure({ mediaName: 'diagram.svg' })),
                p(figure({ mediaName: 'photo.jpeg' })),
                p(figure({ ...CHART, layout: 'wrap-left' })),
                p(figure({ ...CHART, layout: 'wrap-right', width: 500 })),
            ),
        );
        expect(natural).toEqual([300, COLUMN_PX, 321, 500]);
        const extent = only(descendants(await bodyOf(doc(p(figure({ mediaName: 'photo.jpeg' })))), WP, 'extent'));
        expect([xmlAttr(extent, '', 'cx'), xmlAttr(extent, '', 'cy')]).toEqual(['6115050', '4586288']);
    });

    test("a figure in a list item is indented to the item's text and capped at what the indent leaves", async () => {
        const body = await bodyOf(doc(ul(li(p(text('x')), p(figure({ ...CHART, width: 2000 }))))));
        const image = xmlChildren(body, W, 'p')[1];
        expect(w(child(child(image, 'pPr'), 'ind'), 'left')).toBe('330');
        expect(descendants(body, WP, 'extent').map((extent) => Number(xmlAttr(extent, '', 'cx')) / 9525)).toEqual([
            620,
        ]);
    });

    test('a block figure breaks the paragraph that holds it, the text on both sides kept', async () => {
        expect(await blocksOf(doc(p(text('before '), figure({ ...CHART, width: 100 }), text(' after'))))).toEqual([
            `<w:p>${run('before ')}</w:p>`,
            imageParagraph(chart(100)),
            `<w:p>${run(' after')}</w:p>`,
        ]);
    });

    test('a wrapped figure is a borderless floating one-cell table before its paragraph, the row kept whole', async () => {
        const cell = floatingImage(chart(220)) + floatingCaption('Wrapped');
        expect(
            await blocksOf(
                doc(
                    p(
                        text('before '),
                        figure({ ...CHART, width: 220, layout: 'wrap-left', caption: 'Wrapped' }),
                        text('after'),
                    ),
                ),
            ),
        ).toEqual([floating('left', 220, cell), `<w:p>${run('before ')}${run('after')}</w:p>`]);
        const [right] = await blocksOf(doc(p(figure({ ...CHART, width: 220, layout: 'wrap-right' })), p(text('x'))));
        expect(right).toBe(floating('right', 220, floatingImage(chart(220))));
    });

    test('two floating figures keep a Spacer between their tables; an emptied holder goes, the last one is a Spacer', async () => {
        const left = figure({ ...CHART, width: 100, layout: 'wrap-left' });
        const right = figure({ ...CHART, width: 100, layout: 'wrap-right' });
        const blocks = await blocksOf(doc(p(left), p(right, text('flows'))));
        expect(blocks.map((block) => block.slice(0, 6))).toEqual(['<w:tbl', '<w:p><', '<w:tbl', '<w:p><']);
        expect(blocks[1]).toBe(SPACER_XML);
        expect(blocks[3]).toBe(`<w:p>${run('flows')}</w:p>`);
        expect((await blocksOf(doc(p(text('x')), p(left)))).slice(1).map((block) => block.slice(0, 6))).toEqual([
            '<w:tbl',
            '<w:p><',
        ]);
        expect((await blocksOf(doc(p(left))))[1]).toBe(SPACER_XML);
    });

    test('a floating figure keeps no table margin, and stays apart from an in-flow table', async () => {
        const left = figure({ ...CHART, width: 100, layout: 'wrap-left' });
        const blocks = await blocksOf(doc(table(tr(td({}, p(text('cell'))))), p(left, text('next'))));
        expect(blocks.map((block) => block.slice(0, 6))).toEqual(['<w:tbl', '<w:p><', '<w:tbl', '<w:p><']);
        expect(blocks[1]).toBe('<w:p><w:pPr><w:pStyle w:val="Spacer"/><w:spacing w:before="165"/></w:pPr></w:p>');
        expect(blocks[3]).toBe(`<w:p>${run('next')}</w:p>`);
    });

    test("a wrapped figure in an item's first paragraph leaves the number on its text", async () => {
        const body = await bodyOf(doc(ul(li(p(figure({ ...CHART, width: 100, layout: 'wrap-left' }), text('item'))))));
        expect(shape(body)).toEqual(['tbl', 'p', 'sectPr']);
        expect(w(child(child(child(xmlChildren(body, W, 'p')[0], 'pPr'), 'numPr'), 'numId'), 'val')).toBe('1');
    });

    test('an SVG is its PNG blip with the SVG beside it, each a part and an image relationship', async () => {
        const json = doc(p(figure({ mediaName: 'diagram.svg', width: 200 })));
        const zip = await unzip(json);
        expect(await blocksOf(json)).toEqual([
            imageParagraph(
                drawing({ id: 1, px: 200, ratio: 150 / 300, part: 'image1.png', embed: 'rId5', svg: 'rId6' }),
            ),
        ]);
        const svgNs = 'http://schemas.microsoft.com/office/drawing/2016/SVG/main';
        const svgBlip = only(descendants(await part(zip, 'word/document.xml'), svgNs, 'svgBlip'));
        expect(xmlAttr(svgBlip, R, 'embed')).toBe('rId6');
        expect((await relationshipsOf(zip)).slice(4)).toEqual([
            ['rId5', IMAGE_REL, 'media/image1.png'],
            ['rId6', IMAGE_REL, 'media/image1.svg'],
        ]);
        expect((await part(zip, 'word/media/image1.svg')).local).toBe('svg');
        expect(await zip.file('word/media/image1.png')?.async('string')).toBe('diagram png');
    });

    test('a raster is its PNG or JPEG part as prepared, and no WebP type is declared', async () => {
        const zip = await unzip(doc(p(figure({ mediaName: 'photo.jpeg' })), p(figure(CHART))));
        expect((await relationshipsOf(zip)).slice(4)).toEqual([
            ['rId5', IMAGE_REL, 'media/image1.jpeg'],
            ['rId6', IMAGE_REL, 'media/image2.png'],
        ]);
        expect(await zip.file('word/media/image1.jpeg')?.async('string')).toBe('photo jpeg');
        // Stored, not deflated: the bytes stand in the zip as prepared.
        const bytes = await docx(doc(p(figure({ mediaName: 'photo.jpeg' }))));
        expect(Buffer.from(bytes).includes('photo jpeg')).toBe(true);
        const types = await part(zip, '[Content_Types].xml');
        const extensions = xmlChildren(types, CONTENT_TYPES, 'Default').map((d) => xmlAttr(d, '', 'Extension'));
        expect(extensions).not.toContain('webp');
        expect(extensions).toEqual(expect.arrayContaining(['png', 'jpeg', 'svg']));
    });

    test('media one doc shows twice is one part and one relationship, and every drawing has its own id', async () => {
        const zip = await unzip(
            doc(p(figure({ ...CHART, width: 100 })), p(figure({ ...CHART, width: 200, layout: 'wrap-left' }))),
        );
        expect((await relationshipsOf(zip)).slice(4)).toEqual([['rId5', IMAGE_REL, 'media/image1.png']]);
        expect(Object.keys(zip.files).filter((path) => path.startsWith('word/media/'))).toEqual([
            'word/media/image1.png',
        ]);
        const document = await part(zip, 'word/document.xml');
        expect(descendants(document, WP, 'docPr').map((docPr) => xmlAttr(docPr, '', 'id'))).toEqual(['1', '2']);
        expect(
            descendants(document, 'http://schemas.openxmlformats.org/drawingml/2006/picture', 'cNvPr').map((cNvPr) =>
                xmlAttr(cNvPr, '', 'id'),
            ),
        ).toEqual(['1', '2']);
    });

    test('alt text is escaped into both descriptions, and a comment on the figure adds nothing yet', async () => {
        const plain = await blocksOf(doc(p(figure({ ...CHART, width: 100, alt: 'a < b & "c"' }))));
        const docPr = only(descendants(await bodyOf(doc(p(figure({ ...CHART, alt: 'a < b & "c"' })))), WP, 'docPr'));
        expect(xmlAttr(docPr, '', 'descr')).toBe('a < b & "c"');
        expect(
            await blocksOf(doc(p(figure({ ...CHART, width: 100, alt: 'a < b & "c"', commentCardId: 'card-1' })))),
        ).toEqual(plain);
    });

    // A PNG named x as the prep would hand it over, but for what each case changes.
    const media = (over: Partial<ExportMedia>): ExportMedia[] => [
        { name: 'x', contentType: 'image/png', data: toTransferableText('x'), width: 10, height: 10, ...over },
    ];

    test.each([
        ['missing media', { mediaName: 'gone' }, media({})],
        ['an external src', { src: 'https://example.com/x.png' }, media({})],
        ['a WebP', { mediaName: 'x' }, media({ contentType: 'image/webp' })],
        ['an SVG without its PNG', { mediaName: 'x' }, media({ contentType: 'image/svg+xml' })],
        ['no width', { mediaName: 'x' }, media({ width: undefined })],
        ['a zero height', { mediaName: 'x' }, media({ height: 0 })],
        ['an infinite width', { mediaName: 'x' }, media({ width: Number.POSITIVE_INFINITY })],
    ])('a figure with %s writes nothing, and its paragraph keeps its text', async (_case, attrs, prepared) => {
        const json = doc(p(text('a'), figure(attrs), text('b')), p(figure(attrs)));
        expect(await blocksOf(json, prepared)).toEqual([`<w:p>${run('a')}${run('b')}</w:p>`, '<w:p/>']);
        const zip = await unzip(json, undefined, prepared);
        expect(Object.keys(zip.files).filter((path) => path.startsWith('word/media/'))).toEqual([]);
        expect((await relationshipsOf(zip)).map(([, type]) => type)).not.toContain(IMAGE_REL);
        const plain = await unzip(json, undefined, media({}));
        expect(Object.keys(plain.files).filter((path) => path.startsWith('word/media/'))).toEqual(
            'mediaName' in attrs && attrs.mediaName === 'x' ? ['word/media/image1.png'] : [],
        );
    });
});

// ECMA-376 sequence orders, the test's own oracle: Word calls a file with a child out of order unreadable. A child
// missing from its list fails too, so a writer that starts emitting it extends the list here.
const SEQUENCES: Record<string, string[]> = {
    pPr: [
        ...['pStyle', 'keepNext', 'keepLines', 'pageBreakBefore', 'framePr', 'widowControl', 'numPr'],
        ...['suppressLineNumbers', 'pBdr', 'shd', 'tabs', 'suppressAutoHyphens', 'kinsoku', 'wordWrap'],
        ...['overflowPunct', 'topLinePunct', 'autoSpaceDE', 'autoSpaceDN', 'bidi', 'adjustRightInd', 'snapToGrid'],
        ...['spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection'],
        ...['textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange'],
    ],
    rPr: [
        ...['rStyle', 'rFonts', 'b', 'bCs', 'i', 'iCs', 'caps', 'smallCaps', 'strike', 'dstrike', 'outline'],
        ...['shadow', 'emboss', 'imprint', 'noProof', 'snapToGrid', 'vanish', 'webHidden', 'color', 'spacing', 'w'],
        ...['kern', 'position', 'sz', 'szCs', 'highlight', 'u', 'effect', 'bdr', 'shd', 'fitText', 'vertAlign'],
        ...['rtl', 'cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath'],
    ],
    style: [
        ...['name', 'aliases', 'basedOn', 'next', 'link', 'autoRedefine', 'hidden', 'uiPriority', 'semiHidden'],
        ...['unhideWhenUsed', 'qFormat', 'locked', 'personal', 'personalCompose', 'personalReply', 'rsid', 'pPr'],
        ...['rPr', 'tblPr', 'trPr', 'tcPr', 'tblStylePr'],
    ],
    docDefaults: ['rPrDefault', 'pPrDefault'],
    pBdr: ['top', 'left', 'bottom', 'right', 'between', 'bar'],
    tbl: ['tblPr', 'tblGrid', 'tr'],
    tblPr: [
        ...['tblStyle', 'tblpPr', 'tblOverlap', 'bidiVisual', 'tblStyleRowBandSize', 'tblStyleColBandSize', 'tblW'],
        ...['jc', 'tblCellSpacing', 'tblInd', 'tblBorders', 'shd', 'tblLayout', 'tblCellMar', 'tblLook'],
        ...['tblCaption', 'tblDescription', 'tblPrChange'],
    ],
    tblBorders: ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'],
    tblCellMar: ['top', 'left', 'bottom', 'right'],
    tblGrid: ['gridCol', 'tblGridChange'],
    tr: ['tblPrEx', 'trPr', 'tc'],
    trPr: [
        ...['cnfStyle', 'divId', 'gridBefore', 'gridAfter', 'wBefore', 'wAfter', 'cantSplit', 'trHeight'],
        ...['tblHeader', 'tblCellSpacing', 'jc', 'hidden', 'ins', 'del', 'trPrChange'],
    ],
    tcPr: [
        ...['cnfStyle', 'tcW', 'gridSpan', 'hMerge', 'vMerge', 'tcBorders', 'shd', 'noWrap', 'tcMar'],
        ...['textDirection', 'tcFitText', 'vAlign', 'hideMark', 'headers', 'cellIns', 'cellDel', 'cellMerge'],
        ...['tcPrChange'],
    ],
    numPr: ['ilvl', 'numId', 'numberingChange', 'ins'],
    numbering: ['numPicBullet', 'abstractNum', 'num', 'numIdMacAtCleanup'],
    abstractNum: ['nsid', 'multiLevelType', 'tmpl', 'name', 'styleLink', 'numStyleLink', 'lvl'],
    num: ['abstractNumId', 'lvlOverride'],
    lvl: [
        ...['start', 'numFmt', 'lvlRestart', 'pStyle', 'isLgl', 'suff', 'lvlText', 'lvlPicBulletId', 'legacy'],
        ...['lvlJc', 'pPr', 'rPr'],
    ],
    font: [
        ...['altName', 'panose1', 'charset', 'family', 'notTrueType', 'pitch', 'sig', 'embedRegular', 'embedBold'],
        ...['embedItalic', 'embedBoldItalic'],
    ],
    settings: [
        ...['writeProtection', 'view', 'zoom', 'removePersonalInformation', 'removeDateAndTime'],
        ...['doNotDisplayPageBoundaries', 'displayBackgroundShape', 'printPostScriptOverText'],
        ...['printFractionalCharacterWidth', 'printFormsData', 'embedTrueTypeFonts', 'embedSystemFonts'],
        ...['saveSubsetFonts', 'saveFormsData', 'mirrorMargins', 'alignBordersAndEdges', 'bordersDoNotSurroundHeader'],
        ...['bordersDoNotSurroundFooter', 'gutterAtTop', 'hideSpellingErrors', 'hideGrammaticalErrors'],
        ...['activeWritingStyle', 'proofState', 'formsDesign', 'attachedTemplate', 'linkStyles'],
        ...['stylePaneFormatFilter', 'stylePaneSortMethod', 'documentType', 'mailMerge', 'revisionView'],
        ...['trackRevisions', 'doNotTrackMoves', 'doNotTrackFormatting', 'documentProtection', 'autoFormatOverride'],
        ...['styleLockTheme', 'styleLockQFSet', 'defaultTabStop', 'autoHyphenation', 'consecutiveHyphenLimit'],
        ...['hyphenationZone', 'doNotHyphenateCaps', 'showEnvelope', 'summaryLength', 'clickAndTypeStyle'],
        ...['defaultTableStyle', 'evenAndOddHeaders', 'bookFoldRevPrinting', 'bookFoldPrinting'],
        ...['bookFoldPrintingSheets', 'drawingGridHorizontalSpacing', 'drawingGridVerticalSpacing'],
        ...['displayHorizontalDrawingGridEvery', 'displayVerticalDrawingGridEvery'],
        ...['doNotUseMarginsForDrawingGridOrigin', 'drawingGridHorizontalOrigin', 'drawingGridVerticalOrigin'],
        ...['doNotShadeFormData', 'noPunctuationKerning', 'characterSpacingControl', 'printTwoOnOne'],
        ...['strictFirstAndLastChars', 'noLineBreaksAfter', 'noLineBreaksBefore', 'savePreviewPicture'],
        ...['doNotValidateAgainstSchema', 'saveInvalidXml', 'ignoreMixedContent', 'alwaysShowPlaceholderText'],
        ...['doNotDemarcateInvalidXml', 'saveXmlDataOnly', 'useXSLTWhenSaving', 'saveThroughXslt', 'showXMLTags'],
        ...['alwaysMergeEmptyNamespace', 'updateFields', 'hdrShapeDefaults', 'footnotePr', 'endnotePr', 'compat'],
    ],
    sectPr: [
        ...['footnotePr', 'endnotePr', 'type', 'pgSz', 'pgMar', 'paperSrc', 'pgBorders', 'lnNumType', 'pgNumType'],
        ...['cols', 'formProt', 'vAlign', 'noEndnote', 'titlePg', 'textDirection', 'bidi', 'rtlGutter', 'docGrid'],
    ],
};

// The drawing's sequences (CT_Inline, CT_Picture and the DrawingML they hold), by the names the writer gives them.
const DRAWING_SEQUENCES: Record<string, string[]> = {
    'wp:inline': ['wp:extent', 'wp:effectExtent', 'wp:docPr', 'wp:cNvGraphicFramePr', 'a:graphic'],
    'wp:cNvGraphicFramePr': ['a:graphicFrameLocks', 'a:extLst'],
    'a:graphic': ['a:graphicData'],
    'a:graphicData': ['pic:pic'],
    'pic:pic': ['pic:nvPicPr', 'pic:blipFill', 'pic:spPr', 'pic:style', 'pic:extLst'],
    'pic:nvPicPr': ['pic:cNvPr', 'pic:cNvPicPr', 'pic:nvPr'],
    'pic:blipFill': ['a:blip', 'a:srcRect', 'a:tile', 'a:stretch'],
    'a:blip': ['a:extLst'],
    'a:extLst': ['a:ext'],
    'a:stretch': ['a:fillRect'],
    'pic:spPr': ['a:xfrm', 'a:custGeom', 'a:prstGeom', 'a:noFill', 'a:ln', 'a:effectLst', 'a:extLst'],
    'a:xfrm': ['a:off', 'a:ext'],
    'a:prstGeom': ['a:avLst'],
};

// The children a sequence may repeat in a row.
const REPEATED = new Set(['abstractNum', 'num', 'lvl', 'numPicBullet', 'lvlOverride', 'tr', 'tc', 'gridCol', 'a:ext']);

describe('docx writer — property order', () => {
    test('every property list writes its children in the ECMA sequence', async () => {
        const zip = await unzip(buildAllFeaturesDocJson());
        const seen = new Set<string>();
        const outOfOrder: string[] = [];
        const paths = ['document', 'styles', 'numbering', 'settings', 'fontTable'].map((name) => `word/${name}.xml`);
        for (const path of paths) {
            for (const element of elementsOf(await part(zip, path))) {
                const wml = element.ns === W;
                const key = wml ? element.local : element.name;
                const sequence = wml ? SEQUENCES[key] : DRAWING_SEQUENCES[key];
                if (!sequence) continue;
                seen.add(key);
                const children = xmlElements(element);
                const names = children.map((c) => (wml ? (c.ns === W ? c.local : '') : c.name));
                const order = names.map((name) => sequence.indexOf(name));
                const misplaced = (index: number, i: number) => {
                    const previous = order[i - 1] ?? -1;
                    return index < previous || (index === previous && !REPEATED.has(names[i] ?? ''));
                };
                if (order.some((index, i) => index < 0 || misplaced(index, i))) {
                    outOfOrder.push(`${path} ${element.local}: ${shape(element).join(' ')}`);
                }
            }
        }
        expect(outOfOrder).toEqual([]);
        expect([...seen].sort()).toEqual([...Object.keys(SEQUENCES), ...Object.keys(DRAWING_SEQUENCES)].sort());
    });
});

describe('docx writer — the page', () => {
    test('A4 with 2 cm margins, from pageTwips', async () => {
        const body = await bodyOf(doc(p(text('x'))));
        const sectPr = xmlElements(body).at(-1);
        expect(sectPr?.local).toBe('sectPr');
        const pgSz = child(sectPr, 'pgSz');
        expect([w(pgSz, 'w'), w(pgSz, 'h'), w(pgSz, 'orient')]).toEqual(['11906', '16838', undefined]);
        const pgMar = child(sectPr, 'pgMar');
        expect(['top', 'right', 'bottom', 'left', 'header', 'footer', 'gutter'].map((side) => w(pgMar, side))).toEqual([
            ...Array(4).fill('1134'),
            '709',
            '709',
            '0',
        ]);
    });
});

describe('docx writer — styles from the CSS', () => {
    function spacingOf(element: XmlElement): (string | undefined)[] {
        const spacing = child(child(element, 'pPr'), 'spacing');
        return [w(spacing, 'before'), w(spacing, 'after'), w(spacing, 'line'), w(spacing, 'lineRule')];
    }

    function sizeOf(element: XmlElement | undefined): (string | undefined)[] {
        const rPr = child(element, 'rPr');
        return [w(child(rPr, 'sz'), 'val'), w(child(rPr, 'szCs'), 'val')];
    }

    test('the defaults are the prose body: Inter 11 pt in #1a1a2e, no language', async () => {
        const root = await part(await unzip(doc(p(text('x')))), 'word/styles.xml');
        const rPr = child(child(child(root, 'docDefaults'), 'rPrDefault'), 'rPr');
        const fonts = child(rPr, 'rFonts');
        expect(['ascii', 'hAnsi', 'eastAsia', 'cs'].map((slot) => w(fonts, slot))).toEqual(Array(4).fill('Inter'));
        expect(w(child(rPr, 'color'), 'val')).toBe('1A1A2E');
        expect(sizeOf(child(child(root, 'docDefaults'), 'rPrDefault'))).toEqual(['22', '22']);
        expect(descendants(root, W, 'lang')).toEqual([]);
    });

    test('a paragraph is .eigen-prose p: 1 em after, line height 1.7 as an auto multiple of Inter', async () => {
        const normal = style(await styles(), 'Normal');
        expect(w(normal, 'default')).toBe('1');
        expect(spacingOf(normal)).toEqual([undefined, '220', '337', 'auto']);
    });

    test('headings take their size, margins, line height and tracking from the CSS; h5 and h6 the body size', async () => {
        const all = await styles();
        const rows = [1, 2, 3, 4, 5, 6].map((level) => {
            const heading = style(all, `Heading${level}`);
            return [...sizeOf(heading), ...spacingOf(heading), w(child(child(heading, 'rPr'), 'spacing'), 'val')];
        });
        expect(rows).toEqual([
            ['42', '42', '630', '210', '238', 'auto', '-8'],
            ['33', '33', '495', '165', '248', 'auto', '-5'],
            ['27', '27', '405', '135', '258', 'auto', '-3'],
            ['24', '24', '360', '120', '278', 'auto', undefined],
            ['22', '22', '330', '110', '298', 'auto', undefined],
            ['22', '22', '330', '110', '298', 'auto', undefined],
        ]);
    });

    test('inline code, links and captions are styled as the editor draws them', async () => {
        const all = await styles();
        const code = style(all, 'Code');
        expect(w(code, 'type')).toBe('character');
        expect(w(child(child(code, 'rPr'), 'rFonts'), 'ascii')).toBe('JetBrains Mono');
        expect(w(child(child(code, 'rPr'), 'color'), 'val')).toBe('DC2626');
        expect(w(child(child(code, 'rPr'), 'shd'), 'fill')).toBe('F3F4F6');
        expect(sizeOf(code)).toEqual(['20', '20']);

        const hyperlink = style(all, 'Hyperlink');
        expect(w(hyperlink, 'type')).toBe('character');
        expect(shape(child(hyperlink, 'rPr') ?? hyperlink)).toEqual(['color']);
        expect(w(child(child(hyperlink, 'rPr'), 'color'), 'val')).toBe('2563EB');

        const caption = style(all, 'Caption');
        expect(w(child(caption, 'name'), 'val')).toBe('caption');
        expect(spacingOf(caption)).toEqual(['23', '165', undefined, undefined]);
        expect(w(child(child(caption, 'pPr'), 'jc'), 'val')).toBe('center');
        expect(w(child(child(caption, 'rPr'), 'color'), 'val')).toBe('6B7280');
        expect(sizeOf(caption)).toEqual(['18', '18']);

        const spacer = style(all, 'Spacer');
        expect(spacingOf(spacer)).toEqual(['0', '0', '20', 'exact']);
        expect(sizeOf(spacer)).toEqual(['2', '2']);
    });

    test('a heading size follows the CSS', async () => {
        const original = { ...proseCss };
        const proseValueIfSet = (selector: string, property: string) =>
            selector === '.eigen-prose h1' && property === 'font-size'
                ? '2rem'
                : original.proseValueIfSet(selector, property);
        mock.module('../../lib/export/doc/prose-css', () => ({
            ...original,
            proseValueIfSet,
            proseValue: (selector: string, property: string) =>
                proseValueIfSet(selector, property) ?? original.proseValue(selector, property),
        }));
        try {
            const heading = style(await styles(), 'Heading1');
            expect([...sizeOf(heading), ...spacingOf(heading)]).toEqual(['48', '48', '720', '240', '238', 'auto']);
            expect(w(child(child(heading, 'rPr'), 'spacing'), 'val')).toBe('-10');
            const body = await bodyOf(
                doc({ type: 'heading', attrs: { level: 1 }, content: [text('x', { type: 'code' })] }),
            );
            expect(w(only(descendants(body, W, 'sz')), 'val')).toBe('43');
        } finally {
            mock.module('../../lib/export/doc/prose-css', () => original);
        }
    });
});

describe('docx writer — bounds', () => {
    async function xmlBytes(json: JSONContent): Promise<number> {
        const zip = await unzip(json);
        const sizes = await Promise.all(
            Object.values(zip.files).map(async (file) => (await file.async('string')).length),
        );
        return sizes.reduce((sum, size) => sum + size, 0);
    }

    // What the walk amplifies: a row of wide cells widens the grid every later row is filled to.
    function hostile(rows: number): JSONContent {
        const cell = (attrs: Record<string, unknown>) => td(attrs, p(text('x')));
        return doc(
            table(
                tr(...Array.from({ length: rows }, () => cell({ colspan: 63 }))),
                ...Array.from({ length: rows }, () => tr(cell({}))),
            ),
        );
    }

    test('the output grows linearly with a hostile doc, within a bounded factor of its JSON', async () => {
        const [small, large] = await Promise.all([xmlBytes(hostile(50)), xmlBytes(hostile(100))]);
        expect(large / small).toBeLessThan(2.2);
        expect(large).toBeLessThan(100 * JSON.stringify(hostile(100)).length);
    });
});
