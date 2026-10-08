import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import type { JSONContent } from '@tiptap/core';
import { isAllowedUri } from '@tiptap/extension-link';
import { EIGEN_FONT_NAMES, EIGEN_FONTS, type EigenFont, getFontName } from '@workspace/lib/constants/fonts';
import { DEFAULT_PAGE_SETUP, MIN_TABLE_COLUMN_PX, pageTwips } from '@workspace/lib/docs/eigendoc';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { escapeXml, escapeXmlText, stripNonXmlChars } from '@workspace/lib/xml';
import JSZip from 'jszip';
import type { ExportMedia } from '../../document/transform/protocol';
import { cssColorToHex, isTransparentCssColor } from '../colors';
import { DOCX_FONT_FILES, type DocxFontFiles, sfntTables } from '../fonts';
import { proseValue, proseValueIfSet } from './prose-css';
import { FIGURE_WRAP_MARGIN_EM, type HastNode, highlightCode } from './render';

// ProseMirror JSON -> hand-written WordprocessingML, in the transform Worker, so it never reaches the Mount or the
// preview cache. Every look comes from eigen-prose.css; no schema checked the CRDT's JSON, so attrs are checked at use.
export async function eigendocToDocx(
    json: JSONContent,
    media: ExportMedia[],
    title: string,
    publicOrigin: string | undefined,
): Promise<Uint8Array> {
    const pkg: Package = {
        relationships: ['styles', 'numbering', 'settings', 'fontTable'].map((type) => ({
            type: `${R_NS}/${type}`,
            target: `${type}.xml`,
        })),
        hyperlinks: new Map(),
        publicOrigin,
        lists: [],
        bullets: new Map(),
        checkboxes: false,
        media: new Map(media.map((item) => [item.name, item])),
        images: new Map(),
        files: [],
        drawings: 0,
        // A Spacer's and a figure's mark draw in the body's Regular.
        faces: new Map([[BODY.font, new Set<FontSlot>(['Regular'])]]),
    };
    const flow: Context = { pkg, first: false, column: TEXT_COLUMN, indent: 0, depth: 0, quotes: 0 };
    const body = blocksXml(blocksOf(json.content ?? [], {}, flow, false));
    const fonts = embeddedFonts(pkg.faces);

    const parts: [path: string, xml: string, contentType?: string][] = [
        ['_rels/.rels', relationshipsXml(PACKAGE_RELATIONSHIPS)],
        [
            'docProps/core.xml',
            `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${escapeXml(stripEigenExtension(title))}</dc:title></cp:coreProperties>`,
            'application/vnd.openxmlformats-package.core-properties+xml',
        ],
        [
            'word/document.xml',
            `<w:document ${DOCUMENT_NAMESPACES}><w:body>${body}${SECTION_XML}</w:body></w:document>`,
            `${WML}.document.main+xml`,
        ],
        ['word/_rels/document.xml.rels', relationshipsXml(pkg.relationships)],
        ['word/styles.xml', stylesXml(), `${WML}.styles+xml`],
        ['word/numbering.xml', numberingXml(pkg.lists), `${WML}.numbering+xml`],
        ['word/settings.xml', SETTINGS_XML, `${WML}.settings+xml`],
        ['word/fontTable.xml', fontTableXml(pkg.checkboxes, fonts.embeds), `${WML}.fontTable+xml`],
        ['word/_rels/fontTable.xml.rels', relationshipsXml(fonts.relationships)],
    ];
    const overrides = parts.map(([path, , contentType]) =>
        contentType ? `<Override PartName="/${path}" ContentType="${contentType}"/>` : '',
    );

    const zip = new JSZip();
    const options = { date: ZIP_DATE, compression: 'DEFLATE', createFolders: false } as const;
    zip.file(
        '[Content_Types].xml',
        `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${DEFAULT_CONTENT_TYPES}${overrides.join('')}</Types>`,
        options,
    );
    for (const [path, xml] of parts) zip.file(path, `${XML_DECLARATION}${xml}`, options);
    for (const [path, data] of fonts.files) zip.file(path, data, options);
    for (const [path, data] of pkg.files) zip.file(path, data, { ...options, compression: 'STORE' });
    return zip.generateAsync({ type: 'uint8array' });
}

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const WML = 'application/vnd.openxmlformats-officedocument.wordprocessingml';
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
// The DOS epoch: a fixed date, so one doc always exports to the same bytes.
const ZIP_DATE = new Date(Date.UTC(1980, 0, 1));

const DOCUMENT_NAMESPACES = [
    `xmlns:w="${W_NS}"`,
    `xmlns:r="${R_NS}"`,
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
    'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"',
    'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
    'mc:Ignorable="w14"',
].join(' ');

const DEFAULT_CONTENT_TYPES = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Default Extension="png" ContentType="image/png"/>',
    '<Default Extension="jpeg" ContentType="image/jpeg"/>',
    '<Default Extension="svg" ContentType="image/svg+xml"/>',
    '<Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/>',
].join('');

type Relationship = { type: string; target: string; external?: true };

const PACKAGE_RELATIONSHIPS: Relationship[] = [
    { type: `${R_NS}/officeDocument`, target: 'word/document.xml' },
    {
        type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
        target: 'docProps/core.xml',
    },
];

function relationshipsXml(relationships: Relationship[]): string {
    const items = relationships.map(
        ({ type, target, external }, index) =>
            `<Relationship Id="rId${index + 1}" Type="${type}" Target="${escapeXml(target)}"${external ? ' TargetMode="External"' : ''}/>`,
    );
    return `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join('')}</Relationships>`;
}

// What one export accumulates as it walks, each hyperlink target, image, shared bullet numbering and face once.
type Package = {
    relationships: Relationship[];
    hyperlinks: Map<string, string>;
    publicOrigin: string | undefined;
    lists: List[];
    bullets: Map<number, number>;
    checkboxes: boolean;
    media: Map<string, ExportMedia>;
    images: Map<string, Image>;
    files: [path: string, data: ArrayBuffer][];
    drawings: number;
    faces: Map<string, Set<FontSlot>>;
};

// The walk's surroundings, so a nested block sizes and indents itself against its parent: column and indent in twips.
type Context = {
    pkg: Package;
    first: boolean;
    column: number;
    indent: number;
    depth: number;
    quotes: number;
    style?: string;
    after?: number;
    align?: string;
    list?: NumberingRef;
    headingPt?: number;
};

const PAGE = pageTwips(DEFAULT_PAGE_SETUP);

const TEXT_COLUMN = PAGE.width - PAGE.margin.left - PAGE.margin.right;

// The prose body, the size every em in the body text is of.
const BODY = {
    font: proseFont('.eigen-prose'),
    sizePt: cssPt(proseValue('.eigen-prose', 'font-size'), 12),
    color: proseColor('.eigen-prose', 'color'),
};

// Word's default 1.25 cm from the page edge, inside a smaller margin.
const HEADER_DISTANCE = 709;

const SECTION_XML = `<w:sectPr><w:pgSz w:w="${PAGE.width}" w:h="${PAGE.height}"${PAGE.width > PAGE.height ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="${PAGE.margin.top}" w:right="${PAGE.margin.right}" w:bottom="${PAGE.margin.bottom}" w:left="${PAGE.margin.left}" w:header="${Math.min(HEADER_DISTANCE, PAGE.margin.top)}" w:footer="${Math.min(HEADER_DISTANCE, PAGE.margin.bottom)}" w:gutter="0"/></w:sectPr>`;

// Without the compatibility mode Word opens the file in Compatibility Mode. The fonts are embedded whole, so no subset flag.
const SETTINGS_XML = `<w:settings xmlns:w="${W_NS}"><w:embedTrueTypeFonts/><w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

const FONT_FAMILY: Record<EigenFont['category'], string> = {
    'sans-serif': 'swiss',
    serif: 'roman',
    monospace: 'modern',
    'hand-drawn': 'script',
};

// The ECMA-376 order of a font's embed elements.
const FONT_SLOTS = ['Regular', 'Bold', 'Italic', 'BoldItalic'] as const satisfies readonly (keyof DocxFontFiles)[];

type FontSlot = (typeof FONT_SLOTS)[number];

// Each family's font table entry and Word's line height, (usWinAscent + usWinDescent) / unitsPerEm, from its Regular.
const FONT_ENTRIES = EIGEN_FONTS.map(({ name, category }) => {
    const files = DOCX_FONT_FILES.get(name);
    const tables = files && sfntTables(fs.readFileSync(files.Regular));
    const os2 = tables?.get('OS/2');
    const head = tables?.get('head');
    if (!os2 || !head) throw new Error(`no OS/2 or head table for ${name}`);
    const hex32 = (offset: number) => os2.readUInt32BE(offset).toString(16).toUpperCase().padStart(8, '0');
    const sig = Object.entries({ usb0: 42, usb1: 46, usb2: 50, usb3: 54, csb0: 78, csb1: 82 }).map(
        ([field, offset]) => `w:${field}="${hex32(offset)}"`,
    );
    return {
        name,
        lineHeight: (os2.readUInt16BE(74) + os2.readUInt16BE(76)) / head.readUInt16BE(18),
        properties: `<w:panose1 w:val="${os2.subarray(32, 42).toString('hex').toUpperCase()}"/><w:charset w:val="00"/><w:family w:val="${FONT_FAMILY[category]}"/><w:pitch w:val="${category === 'monospace' ? 'fixed' : 'variable'}"/><w:sig ${sig.join(' ')}/>`,
    };
});

const FONT_LINE_HEIGHT = new Map(FONT_ENTRIES.map(({ name, lineHeight }) => [name, lineHeight]));

// MS Gothic draws the checkbox glyphs.
function fontTableXml(checkboxes: boolean, embeds: Map<string, string>): string {
    const fonts = FONT_ENTRIES.map(
        ({ name, properties }) => `<w:font w:name="${escapeXml(name)}">${properties}${embeds.get(name) ?? ''}</w:font>`,
    );
    if (checkboxes)
        fonts.push(
            `<w:font w:name="${CHECKBOX_FONT}"><w:charset w:val="80"/><w:family w:val="modern"/><w:pitch w:val="fixed"/></w:font>`,
        );
    return `<w:fonts xmlns:w="${W_NS}" xmlns:r="${R_NS}">${fonts.join('')}</w:fonts>`;
}

// Each face whole, obfuscated per ECMA-376 Part 1 § 17.8.1 by a GUID hashed from the face, so the bytes are stable.
function embeddedFonts(faces: Map<string, Set<FontSlot>>): {
    embeds: Map<string, string>;
    relationships: Relationship[];
    files: [path: string, data: Uint8Array][];
} {
    const embeds = new Map<string, string>();
    const relationships: Relationship[] = [];
    const files: [path: string, data: Uint8Array][] = [];
    for (const [family, slots] of DOCX_FONT_FILES) {
        let xml = '';
        for (const slot of FONT_SLOTS) {
            const file = slots[slot];
            if (!file || !faces.get(family)?.has(slot)) continue;
            const hash = createHash('sha256').update(`${family}/${slot}`).digest('hex').toUpperCase();
            const key = `{${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}}`;
            const digits = key.replace(/[{}-]/g, '');
            const data = new Uint8Array(fs.readFileSync(file));
            for (let i = 0; i < 32; i++)
                data[i] ^= Number.parseInt(digits.slice(30 - 2 * (i % 16), 32 - 2 * (i % 16)), 16);
            const part = `fonts/font${files.length + 1}.odttf`;
            files.push([`word/${part}`, data]);
            const rId = relationships.push({ type: `${R_NS}/font`, target: part });
            xml += `<w:embed${slot} r:id="rId${rId}" w:fontKey="${key}"/>`;
        }
        if (xml) embeds.set(family, xml);
    }
    return { embeds, relationships, files };
}

// A run's family and size in half-points, which the height of its line follows.
type RunFace = { family: string; size: number };

// As Word resolves a face: the run over its character style over its paragraph style, whose toggles flip each other.
function useFace(pkg: Package, run: RunProps, paragraphStyle: string | undefined): RunFace {
    const character = styleFace(run.style);
    const paragraph = styleFace(paragraphStyle ?? 'Normal');
    const family = run.font ?? character.font ?? paragraph.font ?? BODY.font;
    const size = run.size ?? character.size ?? paragraph.size ?? halfPoints(BODY.sizePt);
    const files = DOCX_FONT_FILES.get(family);
    if (files) {
        const bold = run.bold ?? character.bold !== paragraph.bold;
        const italic = run.italic ?? character.italic !== paragraph.italic;
        const slot = bold ? (italic ? 'BoldItalic' : 'Bold') : italic ? 'Italic' : 'Regular';
        // Word synthesizes a slot without a file from the Regular.
        pkg.faces.set(family, (pkg.faces.get(family) ?? new Set()).add(files[slot] ? slot : 'Regular'));
    }
    return { family, size };
}

// The nearest definition of each face property along a style's chain.
function styleFace(style: string | undefined): Pick<RunProps, 'font' | 'bold' | 'italic' | 'size'> {
    const face: Pick<RunProps, 'font' | 'bold' | 'italic' | 'size'> = {};
    for (let id = style; id !== undefined; ) {
        const definition = STYLES.get(id);
        face.font ??= definition?.rPr?.font;
        face.bold ??= definition?.rPr?.bold;
        face.italic ??= definition?.rPr?.italic;
        face.size ??= definition?.rPr?.size;
        id = definition?.basedOn;
    }
    return face;
}

// Word's auto line scales with the tallest face, CSS's doesn't: a paragraph all in one family other than its mark's gets rescaled, unless the mark's taller.
function familyLine(style: string | undefined, markFace: RunFace, faces: RunFace[]): number | undefined {
    const family = faces[0]?.family;
    if (family === undefined || faces.some((face) => face.family !== family)) return undefined;
    const mark = fontLineHeight(markFace.family) * markFace.size;
    let tallest = mark;
    for (const face of faces) tallest = Math.max(tallest, fontLineHeight(face.family) * face.size);
    return tallest === mark ? undefined : Math.round((styleSpacing(style, 'line') * mark) / tallest);
}

// ── Properties, written in the ECMA-376 sequence: Word reports a child out of order as unreadable content ─────────

type Spacing = { before?: number; after?: number; line?: number; exact?: true };

// sz in eighths of a point, space in points.
type Border = { sz: number; space: number; color: string };

const BORDER_SIDES = ['top', 'left', 'bottom', 'right'] as const;

type NumberingRef = { numId: number; ilvl: number };

type ParagraphProps = {
    style?: string;
    keepNext?: true;
    keepLines?: true;
    numPr?: NumberingRef;
    pBdr?: Partial<Record<(typeof BORDER_SIDES)[number], Border>>;
    shading?: string;
    spacing?: Spacing;
    ind?: { left: number; right?: number; hanging?: number };
    contextualSpacing?: true;
    jc?: string;
    outlineLvl?: number;
};

// size in half-points, spacing in twips, colors as RRGGBB.
type RunProps = {
    style?: string;
    font?: string;
    bold?: true;
    italic?: true;
    // false undoes a style's strike.
    strike?: boolean;
    color?: string;
    spacing?: number;
    size?: number;
    underline?: true;
    shading?: string;
    vertAlign?: 'subscript' | 'superscript';
};

// A paragraph its wrapped figures emptied is only a holder: an item opens it, every other flow drops it.
type Paragraph = { props: ParagraphProps; runs: string; emptied?: true };

// The block after an in-flow table takes its after; a floating one holds a wrapped figure and keeps no margin.
type Block = Paragraph | { table: string; after?: number; float?: true };

function pPrXml(props: ParagraphProps): string {
    const { style, keepNext, keepLines, numPr, pBdr, shading, spacing, ind, contextualSpacing, jc, outlineLvl } = props;
    return [
        style && `<w:pStyle w:val="${style}"/>`,
        keepNext && '<w:keepNext/>',
        keepLines && '<w:keepLines/>',
        numPr && `<w:numPr><w:ilvl w:val="${numPr.ilvl}"/><w:numId w:val="${numPr.numId}"/></w:numPr>`,
        pBdr && `<w:pBdr>${bordersXml(BORDER_SIDES, pBdr)}</w:pBdr>`,
        shading && `<w:shd w:val="clear" w:color="auto" w:fill="${shading}"/>`,
        spacing &&
            `<w:spacing${spacing.before === undefined ? '' : ` w:before="${spacing.before}"`}${spacing.after === undefined ? '' : ` w:after="${spacing.after}"`}${spacing.line === undefined ? '' : ` w:line="${spacing.line}" w:lineRule="${spacing.exact ? 'exact' : 'auto'}"`}/>`,
        ind &&
            `<w:ind w:left="${ind.left}"${ind.right === undefined ? '' : ` w:right="${ind.right}"`}${ind.hanging === undefined ? '' : ` w:hanging="${ind.hanging}"`}/>`,
        contextualSpacing && '<w:contextualSpacing/>',
        jc && `<w:jc w:val="${jc}"/>`,
        outlineLvl !== undefined && `<w:outlineLvl w:val="${outlineLvl}"/>`,
    ]
        .filter(Boolean)
        .join('');
}

function bordersXml<Side extends string>(sides: readonly Side[], borders: Partial<Record<Side, Border>>): string {
    return sides
        .map((side) => {
            const border = borders[side];
            return border
                ? `<w:${side} w:val="single" w:sz="${border.sz}" w:space="${border.space}" w:color="${border.color}"/>`
                : '';
        })
        .join('');
}

function rPrXml(props: RunProps): string {
    const { style, font, bold, italic, strike, color, spacing, size, underline, shading, vertAlign } = props;
    return [
        style && `<w:rStyle w:val="${style}"/>`,
        font && `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/>`,
        bold && '<w:b/><w:bCs/>',
        italic && '<w:i/><w:iCs/>',
        strike === true && '<w:strike/>',
        strike === false && '<w:strike w:val="0"/>',
        color && `<w:color w:val="${color}"/>`,
        spacing !== undefined && `<w:spacing w:val="${spacing}"/>`,
        size !== undefined && `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`,
        underline && '<w:u w:val="single"/>',
        shading && `<w:shd w:val="clear" w:color="auto" w:fill="${shading}"/>`,
        vertAlign && `<w:vertAlign w:val="${vertAlign}"/>`,
    ]
        .filter(Boolean)
        .join('');
}

// An empty paragraph keeps its properties; only one with none is <w:p/>.
function paragraphXml({ props, runs }: Paragraph): string {
    const pPr = pPrXml(props);
    if (!pPr && !runs) return '<w:p/>';
    return `<w:p>${pPr && `<w:pPr>${pPr}</w:pPr>`}${runs}</w:p>`;
}

// ── Blocks ──────────────────────────────────────────────────────────────────────────────────────────────────────

const BLOCKS = new Map<string, (node: JSONContent, context: Context) => Block[]>([
    [
        'paragraph',
        (node, context) => blocksOf(node.content ?? [], textProps({ jc: justification(node) }, context), context, true),
    ],
    [
        'heading',
        (node, context) => {
            const level = clampInt(node.attrs?.['level'], 1, 6, 1);
            const { sizePt } = headingMetrics(level);
            const firstMargin = context.first
                ? proseValueIfSet(`.eigen-prose h${level}:first-child`, 'margin-top')
                : undefined;
            const props = textProps(
                {
                    style: `Heading${level}`,
                    spacing: firstMargin === undefined ? undefined : { before: twips(cssPt(firstMargin, sizePt)) },
                    jc: justification(node),
                },
                context,
            );
            return blocksOf(node.content ?? [], props, { ...context, headingPt: sizePt }, true);
        },
    ],
    ['pageBreak', () => [{ props: { style: 'PageBreak' }, runs: '<w:r><w:br w:type="page"/></w:r>' }]],
    [
        'horizontalRule',
        (_node, context) => [
            { props: { style: 'HorizontalRule', ind: indentOf('HorizontalRule', context) }, runs: '' },
        ],
    ],
    [
        'blockquote',
        (node, context) => {
            const indent = context.indent + (context.quotes < LIST_LEVELS ? QUOTE_LOOK.indent : 0);
            const quote = { ...context, indent, quotes: context.quotes + 1, style: 'Quote', after: undefined };
            const blocks = blocksOf(node.content ?? [], textProps({}, quote), quote, false);
            return withAfter(blocks, proseTwips('.eigen-prose blockquote', 'margin-bottom'));
        },
    ],
    [
        'codeBlock',
        (node, context) => {
            const language = node.attrs?.['language'];
            const tree = highlightCode(typeof language === 'string' ? language : '', textOf(node));
            // The mark of an empty or comment-only line draws in the style's Regular.
            useFace(context.pkg, {}, 'CodeBlock');
            const { indent } = CODE_BLOCK_LOOK;
            const ind = context.indent === 0 ? undefined : { left: context.indent + indent, right: indent };
            return codeLines(tree, context.pkg).map((runs) => ({ props: { style: 'CodeBlock', ind }, runs }));
        },
    ],
    ['bulletList', (node, context) => listOf(node, context, 'ul', { format: 'bullet', start: 1 })],
    [
        'orderedList',
        (node, context) => {
            const type = node.attrs?.['type'];
            const format = (typeof type === 'string' && LIST_FORMATS.get(type)) || 'decimal';
            return listOf(node, context, 'ol', { format, start: clampInt(node.attrs?.['start'], 0, 32767, 1) });
        },
    ],
    ['taskList', (node, context) => listOf(node, context, 'ul', undefined)],
    ['table', (node, context) => tableOf(node.content ?? [], context)],
    ['tableRow', (node, context) => tableOf([node], context)],
    ['tableCell', (node, context) => tableOf([{ type: 'tableRow', content: [node] }], context)],
    ['tableHeader', (node, context) => tableOf([{ type: 'tableRow', content: [node] }], context)],
    [
        'listItem',
        (node, context) =>
            itemOf(node, context, proseTwips('.eigen-prose li', 'margin-bottom'), (first) =>
                context.list ? { ...first, props: { ...first.props, numPr: context.list, ind: undefined } } : first,
            ),
    ],
    [
        'taskItem',
        (node, context) => {
            const checked = node.attrs?.['checked'] === true;
            const done = checked ? { ...context, style: 'TaskDone' } : context;
            context.pkg.checkboxes = true;
            const after = proseTwips('.eigen-prose ul[data-type="taskList"] li', 'margin-bottom');
            return itemOf(node, done, after, (first, inner) => ({
                props: { ...first.props, ind: { left: inner.indent, hanging: LIST_LEVEL } },
                runs: checkboxXml(checked) + first.runs,
            }));
        },
    ],
]);

// Never fails on structure: inline content where a block belongs is wrapped in a paragraph, a nested block hoisted out.
function blocksOf(nodes: JSONContent[], props: ParagraphProps, context: Context, textblock: boolean): Block[] {
    const blocks: Block[] = [];
    let inline: JSONContent[] = [];
    let pieces = 0;
    const flush = () => {
        const faces: RunFace[] = [];
        const runs = runsXml(inline, context, props.style, faces);
        const line = familyLine(props.style, useFace(context.pkg, {}, props.style), faces);
        let own = line === undefined ? props : { ...props, spacing: { ...props.spacing, line } };
        // Word's navigator lists every paragraph at an outline level, so a heading a figure splits keeps one entry.
        if (pieces++ > 0 && STYLES.get(props.style ?? '')?.pPr?.outlineLvl !== undefined)
            own = { ...own, outlineLvl: 9 };
        blocks.push({ props: own, runs });
        inline = [];
    };
    for (const [index, node] of nodes.entries()) {
        if (node.type === 'figure') {
            // A wrapped figure floats before the paragraph that holds it; a block one breaks the paragraph.
            const figure = figureOf(node, context);
            if (inline.length > 0 && figure.some((block) => !('float' in block))) flush();
            for (const block of figure) blocks.push(block);
            continue;
        }
        if (INLINES.has(node.type ?? '')) {
            inline.push(node);
            continue;
        }
        if (inline.length > 0) flush();
        const write = BLOCKS.get(node.type ?? '');
        if (!write) throw new Error(`no docx mapping for ${node.type}`);
        const written = write(node, { ...context, first: !textblock && index === 0, headingPt: undefined });
        if (BOXED.has(node.type ?? '') && BOXED.has(nodes[index - 1]?.type ?? '')) keepApart(blocks, written);
        // A loop, not a spread: a code block of a million lines is a million arguments.
        for (const block of written) blocks.push(block);
    }
    if (inline.length > 0 || (textblock && blocks.length === 0)) flush();
    else if (textblock && blocks.every((block) => 'float' in block)) {
        useFace(context.pkg, {}, props.style);
        blocks.push({ props, runs: '', emptied: true });
    }
    return blocks;
}

const BOXED = new Set(['codeBlock', 'blockquote']);

const SPACER: Paragraph = { props: { style: 'Spacer' }, runs: '' };

// Readers draw adjacent boxes or bars as one, so the gap between them becomes a Spacer, its margins collapsed as CSS does.
function keepApart(blocks: Block[], next: Block[]): void {
    const last = blocks.at(-1);
    const first = next[0];
    if ((last && 'table' in last && !last.float) || (first && 'table' in first && !first.float)) return;
    if (!last || !first || 'table' in last || 'table' in first) {
        blocks.push(SPACER);
        return;
    }
    const after = last.props.spacing?.after ?? styleSpacing(last.props.style, 'after');
    const before = first.props.spacing?.before ?? styleSpacing(first.props.style, 'before');
    if (after > 0)
        blocks[blocks.length - 1] = { ...last, props: { ...last.props, spacing: { ...last.props.spacing, after: 0 } } };
    if (before > 0) next[0] = { ...first, props: { ...first.props, spacing: { ...first.props.spacing, before: 0 } } };
    blocks.push({
        props: { style: 'Spacer', spacing: { before: Math.max(0, after - HAIRLINE_TWIPS, before - HAIRLINE_TWIPS) } },
        runs: '',
    });
}

// Word merges adjacent tables and needs a paragraph after a flow's last one, so a Spacer stands where none does.
function blocksXml(written: Block[]): string {
    const below = (block: Block | undefined) =>
        block && 'table' in block && !block.float ? (block.after ?? TABLE_LOOK.margin) : undefined;
    const spacer = (before: number | undefined) =>
        paragraphXml(before === undefined ? SPACER : { props: { style: 'Spacer', spacing: { before } }, runs: '' });
    const blocks = written.filter((block) => 'table' in block || !block.emptied);
    return blocks
        .map((block, index) => {
            const previous = blocks[index - 1];
            const before = below(previous);
            if (!('table' in block)) return paragraphXml(before === undefined ? block : withBefore(block, before));
            const between = previous !== undefined && 'table' in previous ? spacer(before) : '';
            return `${between}${block.table}${index === blocks.length - 1 ? spacer(below(block)) : ''}`;
        })
        .join('');
}

// A plain paragraph takes its container's style and spacing; a heading in a quote takes the quote's bar directly.
function textProps(own: Pick<ParagraphProps, 'style' | 'spacing' | 'jc'>, context: Context): ParagraphProps {
    const style = own.style ?? context.style;
    return {
        style,
        pBdr: own.style && context.style === 'Quote' ? { left: QUOTE_LOOK.border } : undefined,
        spacing: own.spacing ?? (own.style || context.after === undefined ? undefined : { after: context.after }),
        ind: indentOf(style, context),
        jc: own.jc ?? context.align,
    };
}

// Direct only where the style's own indent isn't the container's.
function indentOf(style: string | undefined, context: Context): ParagraphProps['ind'] {
    const own = STYLES.get(style ?? '')?.pPr?.ind?.left ?? 0;
    return context.indent === own ? undefined : { left: context.indent };
}

// A container's bottom margin on its last block, collapsed with its own; a hairline and a floating figure keep theirs.
function withAfter(blocks: Block[], after: number): Block[] {
    const last = blocks.at(-1);
    if (!last || ('table' in last && last.float)) return blocks;
    if ('table' in last) {
        if (after <= (last.after ?? TABLE_LOOK.margin)) return blocks;
        return [...blocks.slice(0, -1), { ...last, after }];
    }
    if (last.props.style === 'PageBreak' || last.props.style === 'Spacer') return blocks;
    if (after <= (last.props.spacing?.after ?? styleSpacing(last.props.style, 'after'))) return blocks;
    return [...blocks.slice(0, -1), { ...last, props: { ...last.props, spacing: { ...last.props.spacing, after } } }];
}

function withBefore(paragraph: Paragraph, before: number): Paragraph {
    const { props } = paragraph;
    if (before <= (props.spacing?.before ?? styleSpacing(props.style, 'before'))) return paragraph;
    return { ...paragraph, props: { ...props, spacing: { ...props.spacing, before } } };
}

// What the style chain gives a paragraph: its own style, what that is based on, Normal for none.
function styleSpacing(style: string | undefined, side: 'before' | 'after' | 'line'): number {
    for (let id = style ?? 'Normal'; ; ) {
        const definition = STYLES.get(id);
        const value = definition?.pPr?.spacing?.[side];
        if (value !== undefined) return value;
        if (!definition?.basedOn) return 0;
        id = definition.basedOn;
    }
}

function textOf(node: JSONContent): string {
    return node.text ?? (node.content ?? []).map(textOf).join('');
}

// ── Lists: one abstractNum per ordered list, so adjacent lists count separately ─────────────────────────────────────

type List = { format: string; start: number; base: number };

const LIST_FORMATS = new Map([
    ['1', 'decimal'],
    ['a', 'lowerLetter'],
    ['A', 'upperLetter'],
    ['i', 'lowerRoman'],
    ['I', 'upperRoman'],
]);

// Only an outermost list's last paragraph takes the list's margin; a task list and an empty one number nothing.
function listOf(
    node: JSONContent,
    context: Context,
    tag: 'ul' | 'ol',
    numbering: Omit<List, 'base'> | undefined,
): Block[] {
    const ilvl = Math.min(context.depth, LIST_LEVELS - 1);
    const content = node.content ?? [];
    const list =
        numbering && content.some((item) => item.type === 'listItem')
            ? {
                  numId: numIdOf(context.pkg, {
                      ...numbering,
                      base: itemIndent(context) - LIST_LEVEL * (ilvl + 1),
                  }),
                  ilvl,
              }
            : undefined;
    const items = { ...context, list };
    const blocks = blocksOf(content, textProps({}, items), items, false);
    if (context.depth > 0) return blocks;
    return withAfter(blocks, proseTwips(`.eigen-prose ${tag}`, 'margin-bottom'));
}

// A bullet counts nothing, so bullet lists at one indent share their numbering: Word caps the definitions a file holds.
function numIdOf(pkg: Package, list: List): number {
    if (list.format !== 'bullet') return pkg.lists.push(list);
    const shared = pkg.bullets.get(list.base) ?? pkg.lists.push(list);
    pkg.bullets.set(list.base, shared);
    return shared;
}

// The item's text is a level in; only its first paragraph opens with the number or checkbox.
function itemOf(
    node: JSONContent,
    context: Context,
    after: number,
    open: (first: Paragraph, inner: Context) => Paragraph,
): Block[] {
    const inner = {
        ...context,
        indent: itemIndent(context),
        depth: context.depth + 1,
        after,
        list: undefined,
    };
    const props = textProps({}, inner);
    const blocks = blocksOf(node.content ?? [], props, inner, false);
    // The first block past the floats takes the number, or an empty holder above it when it is no plain paragraph.
    const found = blocks.findIndex((block) => !('float' in block));
    const index = found === -1 ? blocks.length : found;
    const first = blocks[index];
    if (first && !('table' in first) && first.props.style === inner.style)
        return blocks.with(index, open({ props: first.props, runs: first.runs }, inner));
    return blocks.toSpliced(index, 0, open({ props, runs: '' }, inner));
}

const LIST_LEVEL = proseTwips('.eigen-prose ul', 'padding-left');

// Word's nine levels; a list or quote deeper still indents no further.
const LIST_LEVELS = 9;

function itemIndent(context: Context): number {
    return context.indent + (context.depth < LIST_LEVELS ? LIST_LEVEL : 0);
}

function numberingXml(lists: List[]): string {
    const abstractNums = lists.map(({ format, start, base }, index) => {
        const levels = Array.from(
            { length: LIST_LEVELS },
            (_, ilvl) =>
                `<w:lvl w:ilvl="${ilvl}"><w:start w:val="${start}"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${format === 'bullet' ? '•' : `%${ilvl + 1}.`}"/><w:lvlJc w:val="left"/><w:pPr>${pPrXml({ ind: { left: base + LIST_LEVEL * (ilvl + 1), hanging: LIST_LEVEL } })}</w:pPr></w:lvl>`,
        );
        const nsid = (index + 1).toString(16).toUpperCase().padStart(8, '0');
        return `<w:abstractNum w:abstractNumId="${index}"><w:nsid w:val="${nsid}"/>${levels.join('')}</w:abstractNum>`;
    });
    const nums = lists.map((_, index) => `<w:num w:numId="${index + 1}"><w:abstractNumId w:val="${index}"/></w:num>`);
    return `<w:numbering xmlns:w="${W_NS}">${abstractNums.join('')}${nums.join('')}</w:numbering>`;
}

const CHECKBOX_FONT = 'MS Gothic';

// Word's checkbox in MS Gothic, as Inter has no ballot box; the tab is unstruck, so Task Done's line starts at text.
function checkboxXml(checked: boolean): string {
    const state = (name: string, glyph: string) => `<w14:${name} w14:val="${glyph}" w14:font="${CHECKBOX_FONT}"/>`;
    return [
        `<w:sdt><w:sdtPr><w14:checkbox><w14:checked w14:val="${checked ? 1 : 0}"/>${state('checkedState', '2612')}${state('uncheckedState', '2610')}</w14:checkbox></w:sdtPr>`,
        `<w:sdtContent><w:r><w:rPr>${rPrXml({ font: CHECKBOX_FONT, strike: false })}</w:rPr><w:t>${checked ? '☒' : '☐'}</w:t></w:r></w:sdtContent></w:sdt>`,
        `<w:r><w:rPr>${rPrXml({ strike: false })}</w:rPr><w:tab/></w:r>`,
    ].join('');
}

// ── Tables: the grid as the editor lays it out ─────────────────────────────────────────────────────────────────────

// Word's widest table. The cap keeps the grid, which every row is filled to, from growing with the doc.
const MAX_TABLE_COLUMNS = 63;

const CELL_TYPES = new Set(['tableCell', 'tableHeader']);

const TABLE_BORDER_SIDES = [...BORDER_SIDES, 'insideH', 'insideV'] as const;

type GridCell = { node: JSONContent; content: JSONContent[]; column: number; colspan: number; rowspan: number };

// Spans hold their columns; stray content gets a cell, one past the last column joins the cell there: no text is lost.
function tableOf(rowNodes: JSONContent[], context: Context): Block[] {
    const rows = rowNodes.map((row) =>
        (row.type === 'tableRow' ? (row.content ?? []) : [row]).map((cell) =>
            CELL_TYPES.has(cell.type ?? '') ? cell : { type: 'tableCell', content: [cell] },
        ),
    );
    const columnPx = (context.column - context.indent) / TWIPS_PER_PX;
    const carry: number[] = [];
    const holders: GridCell[] = [];
    const widths: (number | undefined)[] = [];
    const grid = rows.map((cells, rowIndex) => {
        let column = 0;
        const placed: GridCell[] = [];
        for (const node of cells) {
            while ((carry[column] ?? 0) > 0) column++;
            const last = holders[MAX_TABLE_COLUMNS - 1];
            if (column >= MAX_TABLE_COLUMNS && last) {
                for (const block of node.content ?? []) last.content.push(block);
                continue;
            }
            const colspan = clampInt(node.attrs?.['colspan'], 1, MAX_TABLE_COLUMNS - column, 1);
            const rowspan = clampInt(node.attrs?.['rowspan'], 1, rows.length - rowIndex, 1);
            const colwidth = node.attrs?.['colwidth'];
            const cell = { node, content: [...(node.content ?? [])], column, colspan, rowspan };
            for (let k = 0; k < colspan; k++) {
                const width: unknown = Array.isArray(colwidth) ? colwidth[k] : undefined;
                // At most MAX_COLWIDTH_PX, so 63 of them sum to a number and the ratios between them stay.
                widths[column + k] ??=
                    typeof width === 'number' && Number.isFinite(width) && width > 0
                        ? Math.min(width, MAX_COLWIDTH_PX)
                        : undefined;
                carry[column + k] = rowspan;
                holders[column + k] = cell;
            }
            column += colspan;
            placed.push(cell);
        }
        for (const [index, rowsLeft] of carry.entries()) carry[index] = Math.max(0, rowsLeft - 1);
        return placed;
    });
    if (widths.length === 0) return [];

    const { dxa, fixed } = gridWidths(widths, columnPx);
    const spanWidth = (column: number, colspan: number) =>
        dxa.slice(column, column + colspan).reduce((sum, width) => sum + width, 0);
    const covered = new Map<string, number>();
    for (const [rowIndex, cells] of grid.entries()) {
        for (const { column, colspan, rowspan } of cells) {
            for (let k = 1; k < rowspan; k++) covered.set(`${rowIndex + k}:${column}`, colspan);
        }
    }
    const rowsXml = grid.map((cells, rowIndex) => {
        const byColumn = new Map(cells.map((cell) => [cell.column, cell]));
        const tcs: string[] = [];
        for (let column = 0; column < dxa.length; ) {
            const cell = byColumn.get(column);
            const coveredSpan = covered.get(`${rowIndex}:${column}`);
            const colspan = cell?.colspan ?? coveredSpan ?? 1;
            const width = spanWidth(column, colspan);
            const tcPr = (merge: string) =>
                `<w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${colspan > 1 ? `<w:gridSpan w:val="${colspan}"/>` : ''}${merge}${cell?.node.type === 'tableHeader' ? `<w:shd w:val="clear" w:color="auto" w:fill="${TABLE_LOOK.headerFill}"/>` : ''}</w:tcPr>`;
            if (cell) {
                const merge = cell.rowspan > 1 ? '<w:vMerge w:val="restart"/>' : '';
                tcs.push(
                    `<w:tc>${tcPr(merge)}${cellXml(cell, width - 2 * TABLE_LOOK.padding.horizontal, context.pkg)}</w:tc>`,
                );
            } else tcs.push(`<w:tc>${tcPr(coveredSpan === undefined ? '' : '<w:vMerge/>')}<w:p/></w:tc>`);
            column += colspan;
        }
        // Only an all-header row repeats; a reader may take an explicit off as on.
        const header = cells.length > 0 && cells.every((cell) => cell.node.type === 'tableHeader');
        return `<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${tcs.join('')}</w:tr>`;
    });

    const border = TABLE_LOOK.border;
    const margin = (side: string, width: number) => `<w:${side} w:w="${width}" w:type="dxa"/>`;
    const tblPr = [
        `<w:tblW w:w="${spanWidth(0, dxa.length)}" w:type="dxa"/>`,
        `<w:tblInd w:w="${context.indent}" w:type="dxa"/>`,
        `<w:tblBorders>${bordersXml(TABLE_BORDER_SIDES, { top: border, left: border, bottom: border, right: border, insideH: border, insideV: border })}</w:tblBorders>`,
        fixed ? '<w:tblLayout w:type="fixed"/>' : '',
        `<w:tblCellMar>${margin('top', TABLE_LOOK.padding.vertical)}${margin('left', TABLE_LOOK.padding.horizontal)}${margin('bottom', TABLE_LOOK.padding.vertical)}${margin('right', TABLE_LOOK.padding.horizontal)}</w:tblCellMar>`,
    ].join('');
    const tblGrid = dxa.map((width) => `<w:gridCol w:w="${width}"/>`).join('');
    return [
        { table: `<w:tbl><w:tblPr>${tblPr}</w:tblPr><w:tblGrid>${tblGrid}</w:tblGrid>${rowsXml.join('')}</w:tbl>` },
    ];
}

// Far above any real table; a sum of MAX_TABLE_COLUMNS of them stays finite.
const MAX_COLWIDTH_PX = 1e6;

// As TableWidthClamp: known columns scale down to the column, floored; unknown ones share the rest, as width: 100%.
function gridWidths(widths: (number | undefined)[], columnPx: number): { dxa: number[]; fixed: boolean } {
    const known = widths.filter((width) => width !== undefined);
    const sum = known.reduce((total, width) => total + width, 0);
    const unknown = widths.length - known.length;
    const scale = sum > columnPx ? columnPx / sum : 1;
    const share = unknown > 0 ? Math.max(MIN_TABLE_COLUMN_PX, Math.floor((columnPx - sum * scale) / unknown)) : 0;
    const px = widths.map((width) =>
        width === undefined ? share : scale < 1 ? Math.max(MIN_TABLE_COLUMN_PX, Math.floor(width * scale)) : width,
    );
    return { dxa: px.map((width) => Math.round(width * TWIPS_PER_PX)), fixed: unknown === 0 };
}

// A cell is a flow of its own: no indent or list around it, its paragraphs flush and aligned as the cell is.
function cellXml({ node, content }: GridCell, column: number, pkg: Package): string {
    const align = node.attrs?.['align'];
    const cell: Context = {
        pkg,
        first: false,
        column,
        indent: 0,
        depth: 0,
        quotes: 0,
        after: 0,
        align: typeof align === 'string' ? JUSTIFICATION.get(align) : undefined,
    };
    const blocks = blocksOf(content, textProps({}, cell), cell, false);
    return blocks.length > 0 ? blocksXml(blocks) : paragraphXml({ props: textProps({}, cell), runs: '' });
}

const CELL_PADDING = proseValue('.eigen-prose td', 'padding');

const TABLE_LOOK = {
    border: { ...proseBorder('.eigen-prose td', 'border'), space: 0 },
    padding: {
        vertical: twips(cssPt(boxSide(CELL_PADDING, 'top'), BODY.sizePt)),
        horizontal: twips(cssPt(boxSide(CELL_PADDING, 'left'), BODY.sizePt)),
    },
    headerFill: proseColor('.eigen-prose th', 'background-color'),
    margin: twips(cssPt(boxSide(proseValue('.eigen-prose table', 'margin'), 'bottom'), BODY.sizePt)),
};

// ── Figures: the thumbnail Worker's PNG or JPEG, an SVG beside its PNG fallback ─────────────────────────────────

// One image part and relationship per media name; an SVG's PNG is its blip, the SVG its extension.
type Image = { rId: string; svgRId?: string; part: string; width: number; height: number };

const RASTER_EXTENSIONS = new Map([
    ['image/png', 'png'],
    ['image/jpeg', 'jpeg'],
]);

const FIGURE_ALIGNMENTS = new Set(['left', 'center', 'right']);

// Missing media, an external src (a docx fetches nothing) and media without a size or fallback write only the caption.
function figureOf(node: JSONContent, context: Context): Block[] {
    const attrs = node.attrs ?? {};
    const layout = attrs['layout'];
    const side = layout === 'wrap-left' ? 'left' : layout === 'wrap-right' ? 'right' : undefined;
    const alignment = attrs['alignment'];
    const jc = !side && typeof alignment === 'string' && FIGURE_ALIGNMENTS.has(alignment) ? alignment : 'center';
    const caption = attrs['caption'];
    const captionRuns = typeof caption === 'string' ? textXml(caption) : '';
    if (captionRuns) useFace(context.pkg, {}, 'Caption');
    const captionParagraph = {
        props: { style: 'Caption', ind: indentOf('Caption', context), jc },
        runs: `<w:r>${captionRuns}</w:r>`,
    };
    const mediaName = attrs['mediaName'];
    const image = typeof mediaName === 'string' ? imageOf(mediaName, context.pkg) : undefined;
    if (!image) return captionRuns ? [captionParagraph] : [];
    const columnPx = Math.floor((context.column - context.indent) / TWIPS_PER_PX);
    const width = attrs['width'];
    const set = typeof width === 'number' && Number.isFinite(width) ? Math.round(width) : 0;
    const natural = Math.min(image.width, side ? Math.floor(columnPx / 2) : columnPx);
    const cx = Math.max(1, Math.round(set > 0 ? Math.min(set, columnPx) : natural)) * EMU_PER_PX;
    const alt = attrs['alt'];
    const drawing = drawingXml(
        image,
        cx,
        // Word floors the height to whole twips and refits the width to the image's ratio, so the height is whole already.
        Math.max(EMU_PER_TWIP, Math.round((cx * image.height) / image.width / EMU_PER_TWIP) * EMU_PER_TWIP),
        typeof alt === 'string' ? alt : '',
        context.pkg,
    );
    const margin = proseValue('.eigen-prose figure', 'margin');
    if (!side) {
        const spacing = {
            before: twips(cssPt(boxSide(margin, 'top'), BODY.sizePt)),
            // The caption takes the figure's margin below.
            after: captionRuns ? 0 : twips(cssPt(boxSide(margin, 'bottom'), BODY.sizePt)),
            // Single, or LibreOffice adds 5 pt above every image.
            line: 240,
        };
        const figure: Block[] = [{ props: { spacing, ind: indentOf(undefined, context), jc }, runs: drawing }];
        if (captionRuns) figure.push(captionParagraph);
        return figure;
    }
    // A borderless floating one-cell table, the one wrap that keeps the caption under the image in every reader.
    const em = (value: number) => twips(value * BODY.sizePt);
    const sideMargin = em(FIGURE_WRAP_MARGIN_EM.side);
    const tw = cx / EMU_PER_TWIP;
    const nil = TABLE_BORDER_SIDES.map((edge) => `<w:${edge} w:val="nil"/>`).join('');
    const unpadded = BORDER_SIDES.map((edge) => `<w:${edge} w:w="0" w:type="dxa"/>`).join('');
    // A list or quote indents only the left, so a right float keeps the margin's edge.
    const x = side === 'left' && context.indent > 0 ? `w:tblpX="${context.indent}"` : `w:tblpXSpec="${side}"`;
    const tblPr = [
        `<w:tblpPr w:leftFromText="${side === 'right' ? sideMargin : 0}" w:rightFromText="${side === 'left' ? sideMargin : 0}" w:topFromText="${em(FIGURE_WRAP_MARGIN_EM.top)}" w:bottomFromText="${em(FIGURE_WRAP_MARGIN_EM.bottom)}" w:vertAnchor="text" w:horzAnchor="margin" ${x} w:tblpY="1"/>`,
        '<w:tblOverlap w:val="never"/>',
        `<w:tblW w:w="${tw}" w:type="dxa"/>`,
        `<w:tblBorders>${nil}</w:tblBorders>`,
        '<w:tblLayout w:type="fixed"/>',
        `<w:tblCellMar>${unpadded}</w:tblCellMar>`,
    ].join('');
    const cell = [
        paragraphXml({ props: { spacing: { before: 0, after: 0, line: 240 }, jc: 'center' }, runs: drawing }),
        captionRuns &&
            paragraphXml({
                props: {
                    style: 'Caption',
                    spacing: { before: styleSpacing('Caption', 'before'), after: 0 },
                    jc: 'center',
                },
                runs: `<w:r>${captionRuns}</w:r>`,
            }),
    ].join('');
    // Unsplit, or Google Docs moves the caption to the next page.
    const row = `<w:tr><w:trPr><w:cantSplit/></w:trPr><w:tc><w:tcPr><w:tcW w:w="${tw}" w:type="dxa"/></w:tcPr>${cell}</w:tc></w:tr>`;
    return [
        {
            table: `<w:tbl><w:tblPr>${tblPr}</w:tblPr><w:tblGrid><w:gridCol w:w="${tw}"/></w:tblGrid>${row}</w:tbl>`,
            float: true,
        },
    ];
}

const EMU_PER_PX = 9525;

const TWIPS_PER_PX = 15;

const EMU_PER_TWIP = 635;

// The first figure to show a media name adds its parts; no positive size, an SVG without PNG or another type adds none.
function imageOf(name: string, pkg: Package): Image | undefined {
    const known = pkg.images.get(name);
    if (known) return known;
    const media = pkg.media.get(name);
    const { width, height } = media ?? {};
    if (!media || !isPositive(width) || !isPositive(height)) return undefined;
    const raster = media.contentType === 'image/svg+xml' ? media.png : media.data;
    const extension = media.contentType === 'image/svg+xml' ? 'png' : RASTER_EXTENSIONS.get(media.contentType);
    if (!raster || !extension) return undefined;
    const n = pkg.images.size + 1;
    const add = (file: string, data: ArrayBuffer) => {
        pkg.files.push([`word/media/${file}`, data]);
        return `rId${pkg.relationships.push({ type: `${R_NS}/image`, target: `media/${file}` })}`;
    };
    const part = `image${n}.${extension}`;
    const image: Image = { rId: add(part, raster), part, width, height };
    if (media.contentType === 'image/svg+xml') image.svgRId = add(`image${n}.svg`, media.data);
    pkg.images.set(name, image);
    return image;
}

function isPositive(value: number | undefined): value is number {
    return value !== undefined && Number.isFinite(value) && value > 0;
}

// Word and LibreOffice draw the svgBlip; a reader without SVG draws the PNG.
function drawingXml(image: Image, cx: number, cy: number, alt: string, pkg: Package): string {
    const n = ++pkg.drawings;
    const descr = escapeXml(alt);
    const blip = image.svgRId
        ? `<a:blip r:embed="${image.rId}"><a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="http://schemas.microsoft.com/office/drawing/2016/SVG/main" r:embed="${image.svgRId}"/></a:ext></a:extLst></a:blip>`
        : `<a:blip r:embed="${image.rId}"/>`;
    return [
        `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`,
        `<wp:docPr id="${n}" name="Picture ${n}" descr="${descr}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>`,
        `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="${image.part}" descr="${descr}"/><pic:cNvPicPr/></pic:nvPicPr>`,
        `<pic:blipFill>${blip}<a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`,
    ].join('');
}

// ── Code blocks: one paragraph per line, lowlight's tokens as runs ─────────────────────────────────────────────────

// A token that spans lines is split at each break and keeps its color and italic on every line.
function codeLines(tree: HastNode, pkg: Package): string[] {
    const lines = [''];
    const walk = (node: HastNode, props: RunProps) => {
        if (node.type === 'text') {
            for (const [index, segment] of (node.value ?? '').split(LINE_BREAK).entries()) {
                if (index > 0) lines.push('');
                const content = textXml(segment);
                if (!content) continue;
                useFace(pkg, props, 'CodeBlock');
                const rPr = rPrXml(props);
                lines[lines.length - 1] += `<w:r>${rPr && `<w:rPr>${rPr}</w:rPr>`}${content}</w:r>`;
            }
            return;
        }
        const token = { ...props };
        for (const name of node.properties?.className ?? []) Object.assign(token, tokenLook(name));
        for (const child of node.children ?? []) walk(child, token);
    };
    walk(tree, {});
    return lines;
}

function tokenLook(className: string): RunProps {
    const selector = `.eigen-prose pre .${className}`;
    const look: RunProps = {};
    if (proseValueIfSet(selector, 'color') !== undefined) look.color = proseColor(selector, 'color');
    if (proseValueIfSet(selector, 'font-style') === 'italic') look.italic = true;
    return look;
}

const JUSTIFICATION = new Map([
    ['left', 'left'],
    ['center', 'center'],
    ['right', 'right'],
    ['justify', 'both'],
]);

function justification(node: JSONContent): string | undefined {
    const textAlign = node.attrs?.['textAlign'];
    return typeof textAlign === 'string' ? JUSTIFICATION.get(textAlign) : undefined;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(max, Math.max(min, Math.round(value)))
        : fallback;
}

// ── Inline content: one run per text node ───────────────────────────────────────────────────────────────────────

// A run is written in its paragraph's style.
const INLINES = new Map<
    string,
    (node: JSONContent, linked: boolean, context: Context, style: string | undefined, faces: RunFace[]) => string
>([
    [
        'text',
        (node, linked, context, style, faces) => {
            const content = textXml(node.text ?? '');
            if (!content) return '';
            const props = runProps(node.marks ?? [], linked, context);
            faces.push(useFace(context.pkg, props, style));
            const rPr = rPrXml(props);
            return `<w:r>${rPr && `<w:rPr>${rPr}</w:rPr>`}${content}</w:r>`;
        },
    ],
    ['hardBreak', () => '<w:r><w:br/></w:r>'],
]);

// Runs that share a link share one w:hyperlink.
function runsXml(nodes: JSONContent[], context: Context, style: string | undefined, faces: RunFace[]): string {
    const links = nodes.map((node) => hyperlinkOf(node, context.pkg.publicOrigin));
    let xml = '';
    for (let i = 0; i < nodes.length; ) {
        const link = links[i];
        let runs = '';
        do runs += INLINES.get(nodes[i].type ?? '')?.(nodes[i], link !== undefined, context, style, faces) ?? '';
        while (++i < nodes.length && links[i]?.target === link?.target && links[i]?.tooltip === link?.tooltip);
        if (!link) {
            xml += runs;
            continue;
        }
        let id = context.pkg.hyperlinks.get(link.target);
        if (!id) {
            id = `rId${context.pkg.relationships.push({ type: `${R_NS}/hyperlink`, target: link.target, external: true })}`;
            context.pkg.hyperlinks.set(link.target, id);
        }
        const tooltip = link.tooltip ? ` w:tooltip="${escapeXml(link.tooltip)}"` : '';
        xml += `<w:hyperlink r:id="${id}"${tooltip} w:history="1">${runs}</w:hyperlink>`;
    }
    return xml;
}

// Text turns each line break into w:br, a code block into a new paragraph.
const LINE_BREAK = /\r\n|[\r\n\v]/;
const TEXT_CONTROLS = new RegExp(`(${LINE_BREAK.source}|\t)`);

// Split before escaping, which drops the controls Word spells as elements.
function textXml(text: string): string {
    return text
        .split(TEXT_CONTROLS)
        .map((part, index) => {
            if (index % 2 === 1) return part === '\t' ? '<w:tab/>' : '<w:br/>';
            const escaped = escapeXmlText(part);
            return escaped && `<w:t xml:space="preserve">${escaped}</w:t>`;
        })
        .join('');
}

const MARKS = new Map<string, (attrs: Record<string, unknown>, context: Context) => RunProps>([
    ['bold', () => ({ bold: true })],
    ['italic', () => ({ italic: true })],
    ['underline', () => ({ underline: true })],
    ['strike', () => ({ strike: true })],
    ['subscript', () => ({ vertAlign: 'subscript' })],
    ['superscript', () => ({ vertAlign: 'superscript' })],
    // Direct formatting, not a style: a run holds one rStyle, and a link already takes it.
    [
        'small',
        () => {
            const sizePt = cssPt(proseValue('.eigen-prose small', 'font-size'), BODY.sizePt);
            return {
                spacing: twips(cssPt(proseValue('.eigen-prose small', 'letter-spacing'), sizePt)),
                size: halfPoints(sizePt),
            };
        },
    ],
    [
        'code',
        (_attrs, { headingPt }) => ({
            style: 'Code',
            size:
                headingPt === undefined
                    ? undefined
                    : halfPoints(cssPt(proseValue('.eigen-prose code', 'font-size'), headingPt)),
        }),
    ],
    [
        'textStyle',
        ({ color, fontFamily }) => {
            const name = typeof fontFamily === 'string' ? getFontName(fontFamily) : undefined;
            return { color: colorOf(color), font: name && EIGEN_FONT_NAMES.includes(name) ? name : undefined };
        },
    ],
    // A transparent color shades nothing; no color, or one Office can't spell (a named one), is the UA's yellow <mark>.
    [
        'highlight',
        ({ color }) =>
            typeof color === 'string' && isTransparentCssColor(color) ? {} : { shading: colorOf(color) ?? 'FFFF00' },
    ],
    // The w:hyperlink around the runs carries it.
    ['link', () => ({})],
    // A comment writes nothing; its text stays.
    ['comment', () => ({})],
]);

function runProps(marks: NonNullable<JSONContent['marks']>, linked: boolean, context: Context): RunProps {
    let props: RunProps = linked ? { style: 'Hyperlink' } : {};
    for (const mark of marks) {
        const write = MARKS.get(mark.type);
        if (!write) throw new Error(`no docx mapping for ${mark.type}`);
        props = { ...props, ...write(mark.attrs ?? {}, context) };
    }
    return props;
}

function colorOf(value: unknown): string | undefined {
    return typeof value === 'string' ? cssColorToHex(value) : undefined;
}

type Hyperlink = { target: string; tooltip: string | undefined };

function hyperlinkOf(node: JSONContent, publicOrigin: string | undefined): Hyperlink | undefined {
    const attrs = node.marks?.find((mark) => mark.type === 'link')?.attrs;
    const href = attrs?.['href'];
    if (typeof href !== 'string') return undefined;
    // Gated after the strip, or a character XML can't hold could hide a scheme; trimmed as a URL parser trims.
    const kept = stripNonXmlChars(href).replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
    if (!kept || !isAllowedUri(kept)) return undefined;
    // Outside Eigen a root-relative href means nothing.
    const absolute = kept.startsWith('//')
        ? `https:${kept}`
        : publicOrigin && kept.startsWith('/')
          ? `${publicOrigin}${kept}`
          : kept;
    // What a URI reference can't hold; `%` stays, so an encoded href encodes no further.
    const target = absolute.replace(/[^A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/gu, (character) =>
        encodeURIComponent(character),
    );
    const title = attrs?.['title'];
    return { target, tooltip: typeof title === 'string' && title ? title : undefined };
}

// ── Styles, every value from eigen-prose.css ────────────────────────────────────────────────────────────────────

// rem against the 16 px root, px at 96 dpi, em against the element's own size.
function cssPt(length: string, emPt: number): number {
    if (length.trim() === '0') return 0;
    const match = length.trim().match(/^(-?[\d.]+)(rem|em|px|pt)$/);
    if (!match) throw new Error(`eigen-prose.css length ${length} has no docx unit`);
    const [, value, unit] = match;
    return Number(value) * (unit === 'rem' ? 12 : unit === 'em' ? emPt : unit === 'px' ? 0.75 : 1);
}

function lineHeightPt(value: string, sizePt: number): number {
    return /^[\d.]+$/.test(value) ? Number(value) * sizePt : cssPt(value, sizePt);
}

function twips(pt: number): number {
    return Math.round(pt * 20);
}

function halfPoints(pt: number): number {
    return Math.round(pt * 2);
}

// A multiple of the font's own line height, so the pitch is the CSS one: Google Docs reads every atLeast as single.
function autoLine(linePt: number, sizePt: number, font: string): number {
    return Math.round((240 * linePt) / (sizePt * fontLineHeight(font)));
}

function fontLineHeight(font: string): number {
    const lineHeight = FONT_LINE_HEIGHT.get(font);
    if (lineHeight === undefined) throw new Error(`no line height for ${font}`);
    return lineHeight;
}

function proseColor(selector: string, property: string): string {
    const value = proseValue(selector, property);
    const hex = cssColorToHex(value);
    if (!hex) throw new Error(`eigen-prose.css color ${value} on ${selector} has no docx spelling`);
    return hex;
}

function proseFont(selector: string): string {
    const name = getFontName(proseValue(selector, 'font-family'));
    if (!EIGEN_FONT_NAMES.includes(name))
        throw new Error(`eigen-prose.css font ${name} on ${selector} is no Eigen font`);
    return name;
}

// One side of a box shorthand (margin, padding): one to four values, clockwise from the top.
function boxSide(shorthand: string, side: 'top' | 'right' | 'bottom' | 'left'): string {
    const [top = '', right = top, bottom = top, left = right] = shorthand.trim().split(/\s+/);
    return { top, right, bottom, left }[side];
}

// A solid border shorthand, its width in eighths of a point.
function proseBorder(selector: string, property: string): Omit<Border, 'space'> {
    const value = proseValue(selector, property);
    const [width = '', style, color = ''] = value.trim().split(/\s+/);
    if (style !== 'solid') throw new Error(`eigen-prose.css border ${value} on ${selector} has no docx spelling`);
    const hex = cssColorToHex(color);
    if (!hex) throw new Error(`eigen-prose.css border color ${color} on ${selector} has no docx spelling`);
    return { sz: Math.round(cssPt(width, BODY.sizePt) * 8), color: hex };
}

// A length an element in the body text takes, in twips.
function proseTwips(selector: string, property: string): number {
    return twips(cssPt(proseValue(selector, property), BODY.sizePt));
}

// The bar is the left border and the padding its space; the indent puts the bar where the editor draws it.
function quoteLook() {
    const border = proseBorder('.eigen-prose blockquote', 'border-left');
    const space = Math.round(cssPt(proseValue('.eigen-prose blockquote', 'padding-left'), BODY.sizePt));
    return { border: { ...border, space }, indent: twips(space + border.sz / 8) };
}

const QUOTE_LOOK = quoteLook();

const CODE_BORDER_EIGHTHS = 4;

// Shading stops at borders, so borders in the fill carry it over the padding; the indent sets the box on the column.
function codeBlockLook() {
    const padding = proseValue('.eigen-prose pre', 'padding');
    const fill = proseColor('.eigen-prose pre', 'background-color');
    const border = (side: 'top' | 'left') => ({
        sz: CODE_BORDER_EIGHTHS,
        space: Math.round(cssPt(boxSide(padding, side), BODY.sizePt)),
        color: fill,
    });
    const [vertical, horizontal] = [border('top'), border('left')];
    return {
        fill,
        borders: { top: vertical, left: horizontal, bottom: vertical, right: horizontal },
        indent: twips(horizontal.space + CODE_BORDER_EIGHTHS / 8),
    };
}

const CODE_BLOCK_LOOK = codeBlockLook();

// A heading without its own size or line height inherits the prose root's, as h5 and h6 do.
function headingMetrics(level: number) {
    const selector = `.eigen-prose h${level}`;
    const sizePt = cssPt(
        proseValueIfSet(selector, 'font-size') ?? proseValue('.eigen-prose', 'font-size'),
        BODY.sizePt,
    );
    const line = proseValueIfSet(selector, 'line-height') ?? proseValue('.eigen-prose', 'line-height');
    const tracking = proseValueIfSet(selector, 'letter-spacing');
    return {
        sizePt,
        before: twips(cssPt(proseValue(selector, 'margin-top'), sizePt)),
        after: twips(cssPt(proseValue(selector, 'margin-bottom'), sizePt)),
        line: lineHeightPt(line, sizePt),
        tracking: tracking === undefined ? undefined : twips(cssPt(tracking, sizePt)),
    };
}

type StyleDef = {
    type: 'paragraph' | 'character' | 'table' | 'numbering';
    id: string;
    name: string;
    isDefault?: true;
    basedOn?: string;
    next?: string;
    uiPriority?: number;
    semiHidden?: true;
    qFormat?: true;
    pPr?: ParagraphProps;
    rPr?: RunProps;
    tblPr?: string;
};

function styleXml(style: StyleDef): string {
    const { type, id, name, isDefault, basedOn, next, uiPriority, semiHidden, qFormat, pPr, rPr, tblPr } = style;
    return [
        `<w:style w:type="${type}"${isDefault ? ' w:default="1"' : ''} w:styleId="${id}"><w:name w:val="${name}"/>`,
        basedOn && `<w:basedOn w:val="${basedOn}"/>`,
        next && `<w:next w:val="${next}"/>`,
        uiPriority !== undefined && `<w:uiPriority w:val="${uiPriority}"/>`,
        semiHidden && '<w:semiHidden/><w:unhideWhenUsed/>',
        qFormat && '<w:qFormat/>',
        pPr && `<w:pPr>${pPrXml(pPr)}</w:pPr>`,
        rPr && `<w:rPr>${rPrXml(rPr)}</w:rPr>`,
        tblPr,
        '</w:style>',
    ]
        .filter(Boolean)
        .join('');
}

// A 1 pt line for paragraphs that hold no text of their own: a bare one is a full Normal line.
const HAIRLINE_TWIPS = 20;

const HAIRLINE: Pick<StyleDef, 'pPr' | 'rPr'> = {
    pPr: { spacing: { before: 0, after: 0, line: HAIRLINE_TWIPS, exact: true } },
    rPr: { size: 2 },
};

// No w:lang, so Word checks spelling in the reader's own language.
function stylesXml(): string {
    const defaults = `<w:docDefaults><w:rPrDefault><w:rPr>${rPrXml({ font: BODY.font, color: BODY.color, size: halfPoints(BODY.sizePt) })}</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>${pPrXml({ spacing: { before: 0, after: 0 } })}</w:pPr></w:pPrDefault></w:docDefaults>`;
    return `<w:styles xmlns:w="${W_NS}">${defaults}${[...STYLES.values()].map(styleXml).join('')}</w:styles>`;
}

const TASK_DONE = 'ul[data-type="taskList"] li[data-checked="true"] > div';

function styleDefinitions(): StyleDef[] {
    const paragraphLine = lineHeightPt(proseValue('.eigen-prose p', 'line-height'), BODY.sizePt);
    const captionPt = cssPt(proseValue('.eigen-prose figcaption', 'font-size'), BODY.sizePt);
    const codePt = cssPt(proseValue('.eigen-prose pre code', 'font-size'), BODY.sizePt);
    const codeMargin = proseValue('.eigen-prose pre', 'margin');
    const rule = { ...proseBorder('.eigen-prose hr', 'border-top'), space: 1 };
    const ruleMargin = proseValue('.eigen-prose hr', 'margin');
    const headings = [1, 2, 3, 4, 5, 6].map((level): StyleDef => {
        const { sizePt, before, after, line, tracking } = headingMetrics(level);
        return {
            type: 'paragraph',
            id: `Heading${level}`,
            name: `heading ${level}`,
            basedOn: 'Normal',
            next: 'Normal',
            uiPriority: 9,
            qFormat: true,
            pPr: {
                keepNext: true,
                keepLines: true,
                spacing: { before, after, line: autoLine(line, sizePt, BODY.font) },
                outlineLvl: level - 1,
            },
            rPr: { spacing: tracking, size: halfPoints(sizePt) },
        };
    });
    return [
        {
            type: 'paragraph',
            id: 'Normal',
            name: 'Normal',
            isDefault: true,
            qFormat: true,
            pPr: {
                spacing: {
                    after: twips(cssPt(proseValue('.eigen-prose p', 'margin-bottom'), BODY.sizePt)),
                    line: autoLine(paragraphLine, BODY.sizePt, BODY.font),
                },
            },
        },
        {
            type: 'character',
            id: 'DefaultParagraphFont',
            name: 'Default Paragraph Font',
            isDefault: true,
            uiPriority: 1,
            semiHidden: true,
        },
        {
            type: 'table',
            id: 'TableNormal',
            name: 'Normal Table',
            isDefault: true,
            uiPriority: 99,
            semiHidden: true,
            tblPr: '<w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr>',
        },
        { type: 'numbering', id: 'NoList', name: 'No List', isDefault: true, uiPriority: 99, semiHidden: true },
        ...headings,
        {
            type: 'paragraph',
            id: 'Quote',
            name: 'Quote',
            basedOn: 'Normal',
            qFormat: true,
            pPr: {
                pBdr: { left: QUOTE_LOOK.border },
                spacing: {
                    after: twips(
                        cssPt(boxSide(proseValue('.eigen-prose blockquote p', 'margin'), 'bottom'), BODY.sizePt),
                    ),
                },
                ind: { left: QUOTE_LOOK.indent },
            },
            rPr: {
                italic: proseValue('.eigen-prose blockquote', 'font-style') === 'italic' || undefined,
                color: proseColor('.eigen-prose blockquote', 'color'),
            },
        },
        {
            type: 'paragraph',
            id: 'CodeBlock',
            name: 'Code Block',
            basedOn: 'Normal',
            pPr: {
                pBdr: CODE_BLOCK_LOOK.borders,
                shading: CODE_BLOCK_LOOK.fill,
                spacing: {
                    before: twips(cssPt(boxSide(codeMargin, 'top'), BODY.sizePt)),
                    after: twips(cssPt(boxSide(codeMargin, 'bottom'), BODY.sizePt)),
                    line: autoLine(
                        lineHeightPt(proseValue('.eigen-prose pre', 'line-height'), codePt),
                        halfPoints(codePt) / 2,
                        proseFont('.eigen-prose code'),
                    ),
                },
                ind: { left: CODE_BLOCK_LOOK.indent, right: CODE_BLOCK_LOOK.indent },
                // Only the box's ends take the margin, and the lines' borders merge into one box.
                contextualSpacing: true,
            },
            rPr: {
                font: proseFont('.eigen-prose code'),
                color: proseColor('.eigen-prose pre code', 'color'),
                size: halfPoints(codePt),
            },
        },
        {
            type: 'paragraph',
            id: 'Caption',
            name: 'caption',
            basedOn: 'Normal',
            next: 'Normal',
            qFormat: true,
            pPr: {
                spacing: {
                    before: twips(cssPt(proseValue('.eigen-prose figcaption', 'margin-top'), captionPt)),
                    after: twips(cssPt(boxSide(proseValue('.eigen-prose figure', 'margin'), 'bottom'), BODY.sizePt)),
                },
                jc: JUSTIFICATION.get(proseValue('.eigen-prose figcaption', 'text-align')),
            },
            rPr: { color: proseColor('.eigen-prose figcaption', 'color'), size: halfPoints(captionPt) },
        },
        {
            type: 'paragraph',
            id: 'HorizontalRule',
            name: 'Horizontal Rule',
            basedOn: 'Normal',
            pPr: {
                pBdr: { bottom: rule },
                spacing: {
                    ...HAIRLINE.pPr?.spacing,
                    before: twips(cssPt(boxSide(ruleMargin, 'top'), BODY.sizePt)),
                    after: twips(cssPt(boxSide(ruleMargin, 'bottom'), BODY.sizePt)),
                },
            },
            rPr: HAIRLINE.rPr,
        },
        { type: 'paragraph', id: 'PageBreak', name: 'Page Break', basedOn: 'Normal', ...HAIRLINE },
        { type: 'paragraph', id: 'Spacer', name: 'Spacer', basedOn: 'Normal', ...HAIRLINE },
        {
            type: 'paragraph',
            id: 'TaskDone',
            name: 'Task Done',
            basedOn: 'Normal',
            // The editor strikes a checked item's whole content in the muted color.
            rPr: {
                strike: proseValue(TASK_DONE, 'text-decoration') === 'line-through' || undefined,
                color: proseColor(TASK_DONE, 'color'),
            },
        },
        {
            type: 'character',
            id: 'Hyperlink',
            name: 'Hyperlink',
            basedOn: 'DefaultParagraphFont',
            uiPriority: 99,
            rPr: { color: proseColor('.eigen-prose a', 'color') },
        },
        {
            type: 'character',
            id: 'Code',
            name: 'Code',
            basedOn: 'DefaultParagraphFont',
            rPr: {
                font: proseFont('.eigen-prose code'),
                color: proseColor('.eigen-prose code', 'color'),
                size: halfPoints(cssPt(proseValue('.eigen-prose code', 'font-size'), BODY.sizePt)),
                shading: proseColor('.eigen-prose code', 'background-color'),
            },
        },
    ];
}

const STYLES = new Map(styleDefinitions().map((style) => [style.id, style]));
