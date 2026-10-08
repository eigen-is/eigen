import { describe, expect, mock, test } from 'bun:test';
import { getSchema, type JSONContent } from '@tiptap/core';
import { getDocExtensions } from '@workspace/lib/docs/eigendoc';
import JSZip from 'jszip';
import { common, createLowlight } from 'lowlight';
import { parseXml, type XmlElement, xmlAttr, xmlChild, xmlChildren, xmlElements, xmlText } from '../../lib/core/xml';
import * as proseCss from '../../lib/export/doc/prose-css';
import { eigendocToDocx } from '../../lib/export/doc/to-docx';
import { buildAllFeaturesDocJson } from '../fixtures/golden-documents';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_TYPES = 'http://schemas.openxmlformats.org/package/2006/content-types';

// U+FFFE, which XML can't hold; the formatter would unescape it into an invisible literal.
const NONCHARACTER = String.fromCharCode(0xfffe);

const schema = getSchema(getDocExtensions({ lowlight: createLowlight(common) }));

// The nodes U2b (lists, tasks, tables, code blocks, quotes, rules) and U2c (figures) map. Each throws until its
// mapping lands and leaves this set; the writer is whole when it is empty.
const PENDING_NODES = new Set([
    'blockquote',
    'bulletList',
    'orderedList',
    'listItem',
    'taskList',
    'taskItem',
    'codeBlock',
    'horizontalRule',
    'table',
    'tableRow',
    'tableCell',
    'tableHeader',
    'figure',
]);

function docx(json: JSONContent, publicOrigin?: string): Promise<Uint8Array> {
    return eigendocToDocx(json, 'Report.eigendoc', publicOrigin);
}

async function unzip(json: JSONContent, publicOrigin?: string): Promise<JSZip> {
    return JSZip.loadAsync(await docx(json, publicOrigin));
}

async function part(zip: JSZip, path: string): Promise<XmlElement> {
    const text = await zip.file(path)?.async('string');
    const root = text === undefined ? null : parseXml(text);
    if (!root) throw new Error(`${path} missing or blank`);
    return root;
}

async function bodyOf(json: JSONContent, publicOrigin?: string): Promise<XmlElement> {
    const body = xmlChild(await part(await unzip(json, publicOrigin), 'word/document.xml'), W, 'body');
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

function doc(...content: JSONContent[]): JSONContent {
    return { type: 'doc', content };
}

function p(...content: JSONContent[]): JSONContent {
    return { type: 'paragraph', content };
}

function text(value: string, ...marks: NonNullable<JSONContent['marks']>): JSONContent {
    return { type: 'text', text: value, marks };
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
    test('the all-features doc is a valid doc holding every node and mark the writer maps', () => {
        const json = buildAllFeaturesDocJson();
        schema.nodeFromJSON(json).check();
        const { nodes, marks } = typesIn(json);

        expect([...nodes].sort()).toEqual(
            Object.keys(schema.nodes)
                .filter((type) => !PENDING_NODES.has(type))
                .sort(),
        );
        expect([...marks].sort()).toEqual(Object.keys(schema.marks).sort());
        for (const type of PENDING_NODES) expect(schema.nodes[type]).toBeDefined();
    });

    test('the all-features doc exports', async () => {
        expect((await docx(buildAllFeaturesDocJson())).byteLength).toBeGreaterThan(0);
    });

    test.each([...PENDING_NODES])('%s has no mapping yet, so it throws', async (type) => {
        await expect(docx(doc({ type }))).rejects.toThrow(`no docx mapping for ${type}`);
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

    test('every part is written, parses and has a content type', async () => {
        const zip = await unzip(buildAllFeaturesDocJson());
        const paths = Object.keys(zip.files);
        expect(paths.sort()).toEqual([...PARTS].sort());

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
            await part(zip, path);
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

        const numIds = xmlChildren(await part(zip, 'word/numbering.xml'), W, 'num').map((n) => w(n, 'numId'));
        for (const numId of descendants(document, W, 'numId')) expect(numIds).toContain(w(numId, 'val'));

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
        const heading = only(
            xmlChildren(
                await bodyOf(doc({ type: 'heading', attrs: { level: 2, textAlign: 'right' }, content: [text('x')] })),
                W,
                'p',
            ),
        );
        const pPr = child(heading, 'pPr');
        expect(shape(pPr ?? heading)).toEqual(['pStyle', 'jc']);
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

describe('docx writer — property order', () => {
    test('every property list writes its children in the ECMA sequence', async () => {
        const zip = await unzip(buildAllFeaturesDocJson());
        const seen = new Set<string>();
        const outOfOrder: string[] = [];
        for (const path of ['word/document.xml', 'word/styles.xml', 'word/settings.xml', 'word/fontTable.xml']) {
            for (const element of elementsOf(await part(zip, path))) {
                const sequence = element.ns === W ? SEQUENCES[element.local] : undefined;
                if (!sequence) continue;
                seen.add(element.local);
                const order = xmlElements(element).map((c) => (c.ns === W ? sequence.indexOf(c.local) : -1));
                if (order.some((index, i) => index < 0 || (i > 0 && index <= (order[i - 1] ?? -1)))) {
                    outOfOrder.push(`${path} ${element.local}: ${shape(element).join(' ')}`);
                }
            }
        }
        expect(outOfOrder).toEqual([]);
        expect([...seen].sort()).toEqual(Object.keys(SEQUENCES).sort());
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
        mock.module('../../lib/export/doc/prose-css', () => ({
            ...original,
            proseValue: (selector: string, property: string) =>
                selector === '.eigen-prose h1' && property === 'font-size'
                    ? '2rem'
                    : original.proseValue(selector, property),
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
