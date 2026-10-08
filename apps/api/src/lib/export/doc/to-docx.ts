import type { JSONContent } from '@tiptap/core';
import { isAllowedUri } from '@tiptap/extension-link';
import { EIGEN_FONT_NAMES, EIGEN_FONTS, type EigenFont, getFontName } from '@workspace/lib/constants/fonts';
import { DEFAULT_PAGE_SETUP, pageTwips } from '@workspace/lib/docs/eigendoc';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { escapeXml, escapeXmlText, stripNonXmlChars } from '@workspace/lib/xml';
import JSZip from 'jszip';
import { common, createLowlight } from 'lowlight';
import { cssColorToHex } from '../colors';
import { proseValue, proseValueIfSet } from './prose-css';
import { type HastNode, highlightCode } from './render';

// ProseMirror JSON -> docx bytes, WordprocessingML written by hand. Runs inside the transform Worker (worker.ts owns
// execution; the main-thread orchestration lives in export-document.ts). This module must not reach the Mount or the
// preview cache — the Worker imports it. Every size, spacing and color comes from eigen-prose.css through proseValue,
// and the JSON comes off a CRDT no schema checked, so attrs are validated at use and the structure normalized.
export async function eigendocToDocx(
    json: JSONContent,
    title: string,
    publicOrigin: string | undefined,
): Promise<Uint8Array> {
    const styles = styleDefinitions();
    const pkg: Package = {
        relationships: ['styles', 'numbering', 'settings', 'fontTable'].map((type) => ({
            type: `${R_NS}/${type}`,
            target: `${type}.xml`,
        })),
        hyperlinks: new Map(),
        publicOrigin,
        styles: new Map(styles.map((style) => [style.id, style])),
        lists: [],
        checkboxes: false,
    };
    const body = paragraphsOf(json.content ?? [], {}, { pkg, first: false, indent: 0, depth: 0 }, false)
        .map(paragraphXml)
        .join('');

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
        ['word/styles.xml', stylesXml(styles), `${WML}.styles+xml`],
        ['word/numbering.xml', numberingXml(pkg.lists), `${WML}.numbering+xml`],
        ['word/settings.xml', SETTINGS_XML, `${WML}.settings+xml`],
        ['word/fontTable.xml', fontTableXml(pkg.checkboxes), `${WML}.fontTable+xml`],
        ['word/_rels/fontTable.xml.rels', relationshipsXml([])],
    ];
    const overrides = parts.map(([path, , contentType]) =>
        contentType ? `<Override PartName="/${path}" ContentType="${contentType}"/>` : '',
    );

    const zip = new JSZip();
    const options = { date: ZIP_DATE, compression: 'DEFLATE', createFolders: false } as const;
    zip.file('[Content_Types].xml', `${XML_DECLARATION}<Types ${CONTENT_TYPES}${overrides.join('')}</Types>`, options);
    for (const [path, xml] of parts) zip.file(path, `${XML_DECLARATION}${xml}`, options);
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

const CONTENT_TYPES = [
    'xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
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

// What one export accumulates as it walks: the document's relationships, one per distinct hyperlink target, and its
// lists; the styles the walk reads its own spacing from.
type Package = {
    relationships: Relationship[];
    hyperlinks: Map<string, string>;
    publicOrigin: string | undefined;
    styles: Map<string, StyleDef>;
    lists: List[];
    checkboxes: boolean;
};

// The walk's surroundings. A flow's first block drops a heading's margin above; indent is the twips the enclosing lists
// and quotes move the text in, depth the lists around it; style and after are what a plain paragraph takes in its
// container; list is the numbering an item takes; a heading scales its inline code.
type Context = {
    pkg: Package;
    first: boolean;
    indent: number;
    depth: number;
    style?: string;
    after?: number;
    list?: NumberingRef;
    headingPt?: number;
};

const PAGE = pageTwips(DEFAULT_PAGE_SETUP);

const SECTION_XML = `<w:sectPr><w:pgSz w:w="${PAGE.width}" w:h="${PAGE.height}"${PAGE.width > PAGE.height ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="${PAGE.margin.top}" w:right="${PAGE.margin.right}" w:bottom="${PAGE.margin.bottom}" w:left="${PAGE.margin.left}" w:header="${Math.min(709, PAGE.margin.top)}" w:footer="${Math.min(709, PAGE.margin.bottom)}" w:gutter="0"/></w:sectPr>`;

// Without the compatibility mode Word opens the file in Compatibility Mode.
const SETTINGS_XML = `<w:settings xmlns:w="${W_NS}"><w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

const FONT_FAMILY: Record<EigenFont['category'], string> = {
    'sans-serif': 'swiss',
    serif: 'roman',
    monospace: 'modern',
    'hand-drawn': 'script',
};

// MS Gothic draws the checkbox glyphs.
function fontTableXml(checkboxes: boolean): string {
    const fonts = EIGEN_FONTS.map(
        ({ name, category }) =>
            `<w:font w:name="${escapeXml(name)}"><w:charset w:val="00"/><w:family w:val="${FONT_FAMILY[category]}"/><w:pitch w:val="${category === 'monospace' ? 'fixed' : 'variable'}"/></w:font>`,
    );
    if (checkboxes)
        fonts.push(
            `<w:font w:name="${CHECKBOX_FONT}"><w:charset w:val="80"/><w:family w:val="modern"/><w:pitch w:val="fixed"/></w:font>`,
        );
    return `<w:fonts xmlns:w="${W_NS}">${fonts.join('')}</w:fonts>`;
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

type Paragraph = { props: ParagraphProps; runs: string };

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

const BLOCKS = new Map<string, (node: JSONContent, context: Context) => Paragraph[]>([
    [
        'paragraph',
        (node, context) =>
            paragraphsOf(node.content ?? [], textProps({ jc: justification(node) }, context), context, true),
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
            return paragraphsOf(node.content ?? [], props, { ...context, headingPt: sizePt }, true);
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
            const quote = { ...context, indent: context.indent + quoteLook().indent, style: 'Quote', after: undefined };
            const paragraphs = paragraphsOf(node.content ?? [], textProps({}, quote), quote, false);
            return withAfter(paragraphs, proseTwips('.eigen-prose blockquote', 'margin-bottom'), context.pkg);
        },
    ],
    [
        'codeBlock',
        (node, context) => {
            const language = node.attrs?.['language'];
            const tree = highlightCode(typeof language === 'string' ? language : '', textOf(node), lowlight);
            const { indent } = codeBlockLook();
            const ind = context.indent === 0 ? undefined : { left: context.indent + indent, right: indent };
            return codeLines(tree).map((runs) => ({ props: { style: 'CodeBlock', ind }, runs }));
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
                props: { ...first.props, ind: { left: inner.indent, hanging: listLevel() } },
                runs: checkboxXml(checked) + first.runs,
            }));
        },
    ],
]);

// Never fails on structure: inline content where a block belongs is wrapped in a paragraph, a nested block hoisted out.
function paragraphsOf(nodes: JSONContent[], props: ParagraphProps, context: Context, textblock: boolean): Paragraph[] {
    const paragraphs: Paragraph[] = [];
    let inline: JSONContent[] = [];
    const flush = () => {
        paragraphs.push({ props, runs: runsXml(inline, context) });
        inline = [];
    };
    for (const [index, node] of nodes.entries()) {
        if (Object.hasOwn(INLINES, node.type ?? '')) {
            inline.push(node);
            continue;
        }
        if (inline.length > 0) flush();
        const write = BLOCKS.get(node.type ?? '');
        if (!write) throw new Error(`no docx mapping for ${node.type}`);
        paragraphs.push(...write(node, { ...context, first: !textblock && index === 0, headingPt: undefined }));
    }
    if (inline.length > 0 || (textblock && paragraphs.length === 0)) flush();
    return paragraphs;
}

// A paragraph or heading where it stands: a plain one takes its container's style and spacing; a heading in a quote
// takes the quote's bar directly.
function textProps(own: Pick<ParagraphProps, 'style' | 'spacing' | 'jc'>, context: Context): ParagraphProps {
    const style = own.style ?? context.style;
    return {
        style,
        pBdr: own.style && context.style === 'Quote' ? { left: quoteLook().border } : undefined,
        spacing: own.spacing ?? (own.style || context.after === undefined ? undefined : { after: context.after }),
        ind: indentOf(style, context),
        jc: own.jc,
    };
}

// Direct only where the style's own indent isn't the container's.
function indentOf(style: string | undefined, context: Context): ParagraphProps['ind'] {
    const own = context.pkg.styles.get(style ?? '')?.pPr?.ind?.left ?? 0;
    return context.indent === own ? undefined : { left: context.indent };
}

// A container's bottom margin on its last paragraph, the larger of the two as margins collapse. A hairline keeps its
// 1 pt.
function withAfter(paragraphs: Paragraph[], after: number, pkg: Package): Paragraph[] {
    const last = paragraphs.at(-1);
    if (!last || last.props.style === 'PageBreak' || last.props.style === 'Spacer') return paragraphs;
    if (after <= (last.props.spacing?.after ?? styleSpacing(last.props.style, 'after', pkg))) return paragraphs;
    return [
        ...paragraphs.slice(0, -1),
        { ...last, props: { ...last.props, spacing: { ...last.props.spacing, after } } },
    ];
}

// What the style chain gives a paragraph: its own style, what that is based on, Normal for none.
function styleSpacing(style: string | undefined, side: 'before' | 'after', pkg: Package): number {
    for (let id = style ?? 'Normal'; ; ) {
        const definition = pkg.styles.get(id);
        const value = definition?.pPr?.spacing?.[side];
        if (value !== undefined) return value;
        if (!definition?.basedOn) return 0;
        id = definition.basedOn;
    }
}

function textOf(node: JSONContent): string {
    return node.text ?? (node.content ?? []).map(textOf).join('');
}

// ── Lists: one abstractNum per list, so adjacent lists count separately ─────────────────────────────────────────────

type List = { format: string; start: number; base: number };

const LIST_FORMATS = new Map([
    ['1', 'decimal'],
    ['a', 'lowerLetter'],
    ['A', 'upperLetter'],
    ['i', 'lowerRoman'],
    ['I', 'upperRoman'],
]);

// A task list has no numbering. Only the last paragraph of a list in no other list takes the list's margin.
function listOf(
    node: JSONContent,
    context: Context,
    tag: 'ul' | 'ol',
    numbering: Omit<List, 'base'> | undefined,
): Paragraph[] {
    const ilvl = Math.min(context.depth, 8);
    const list = numbering && {
        numId: context.pkg.lists.push({ ...numbering, base: context.indent - listLevel() * ilvl }),
        ilvl,
    };
    const items = { ...context, list };
    const paragraphs = paragraphsOf(node.content ?? [], textProps({}, items), items, false);
    if (context.depth > 0) return paragraphs;
    return withAfter(paragraphs, proseTwips(`.eigen-prose ${tag}`, 'margin-bottom'), context.pkg);
}

// The item's text is a level in; only its first paragraph opens with the number or checkbox.
function itemOf(
    node: JSONContent,
    context: Context,
    after: number,
    open: (first: Paragraph, inner: Context) => Paragraph,
): Paragraph[] {
    const inner = {
        ...context,
        indent: context.indent + listLevel(),
        depth: context.depth + 1,
        after,
        list: undefined,
    };
    const [first, ...rest] = paragraphsOf(node.content ?? [], textProps({}, inner), inner, false);
    if (!first) return [];
    return [first.props.style === inner.style ? open(first, inner) : first, ...rest];
}

function listLevel(): number {
    return proseTwips('.eigen-prose ul', 'padding-left');
}

function numberingXml(lists: List[]): string {
    const level = listLevel();
    const abstractNums = lists.map(({ format, start, base }, index) => {
        const levels = Array.from(
            { length: 9 },
            (_, ilvl) =>
                `<w:lvl w:ilvl="${ilvl}"><w:start w:val="${start}"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${format === 'bullet' ? '•' : `%${ilvl + 1}.`}"/><w:lvlJc w:val="left"/><w:pPr>${pPrXml({ ind: { left: base + level * (ilvl + 1), hanging: level } })}</w:pPr></w:lvl>`,
        );
        const nsid = (index + 1).toString(16).toUpperCase().padStart(8, '0');
        return `<w:abstractNum w:abstractNumId="${index}"><w:nsid w:val="${nsid}"/>${levels.join('')}</w:abstractNum>`;
    });
    const nums = lists.map((_, index) => `<w:num w:numId="${index + 1}"><w:abstractNumId w:val="${index}"/></w:num>`);
    return `<w:numbering xmlns:w="${W_NS}">${abstractNums.join('')}${nums.join('')}</w:numbering>`;
}

const CHECKBOX_FONT = 'MS Gothic';

// Word's checkbox control. Inter has no ballot box; MS Gothic is what Word writes and readers fall back to by glyph.
// The tab run opts out of Task Done's strike too, or the line would start before the text.
function checkboxXml(checked: boolean): string {
    const state = (name: string, glyph: string) => `<w14:${name} w14:val="${glyph}" w14:font="${CHECKBOX_FONT}"/>`;
    return [
        `<w:sdt><w:sdtPr><w14:checkbox><w14:checked w14:val="${checked ? 1 : 0}"/>${state('checkedState', '2612')}${state('uncheckedState', '2610')}</w14:checkbox></w:sdtPr>`,
        `<w:sdtContent><w:r><w:rPr>${rPrXml({ font: CHECKBOX_FONT, strike: false })}</w:rPr><w:t>${checked ? '☒' : '☐'}</w:t></w:r></w:sdtContent></w:sdt>`,
        `<w:r><w:rPr>${rPrXml({ strike: false })}</w:rPr><w:tab/></w:r>`,
    ].join('');
}

// ── Code blocks: one paragraph per line, lowlight's tokens as runs ─────────────────────────────────────────────────

const lowlight = createLowlight(common);

// A token that spans lines is split at each break and keeps its color and italic on every line.
function codeLines(tree: HastNode): string[] {
    const lines = [''];
    const walk = (node: HastNode, props: RunProps) => {
        if (node.type === 'text') {
            for (const [index, segment] of (node.value ?? '').split(LINE_BREAK).entries()) {
                if (index > 0) lines.push('');
                const content = textXml(segment);
                const rPr = rPrXml(props);
                if (content) lines[lines.length - 1] += `<w:r>${rPr && `<w:rPr>${rPr}</w:rPr>`}${content}</w:r>`;
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

const INLINES: Record<string, (node: JSONContent, linked: boolean, context: Context) => string> = {
    text: (node, linked, context) => {
        const content = textXml(node.text ?? '');
        if (!content) return '';
        const rPr = rPrXml(runProps(node.marks ?? [], linked, context));
        return `<w:r>${rPr && `<w:rPr>${rPr}</w:rPr>`}${content}</w:r>`;
    },
    hardBreak: () => '<w:r><w:br/></w:r>',
};

// Runs that share a link share one w:hyperlink.
function runsXml(nodes: JSONContent[], context: Context): string {
    const links = nodes.map((node) => hyperlinkOf(node, context.pkg.publicOrigin));
    let xml = '';
    for (let i = 0; i < nodes.length; ) {
        const link = links[i];
        let runs = '';
        do runs += INLINES[nodes[i].type ?? ''](nodes[i], link !== undefined, context);
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
            const sizePt = cssPt(proseValue('.eigen-prose small', 'font-size'), bodyPt());
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
    ['textStyle', (attrs) => ({ color: colorOf(attrs['color']), font: fontOf(attrs['fontFamily']) })],
    // No color is the UA's yellow <mark>.
    ['highlight', (attrs) => ({ shading: colorOf(attrs['color']) ?? 'FFFF00' })],
    // The w:hyperlink around the runs carries it.
    ['link', () => ({})],
    // Nothing until the comments part exists.
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

function fontOf(value: unknown): string | undefined {
    const name = typeof value === 'string' ? getFontName(value) : undefined;
    return name && EIGEN_FONT_NAMES.includes(name) ? name : undefined;
}

type Hyperlink = { target: string; tooltip: string | undefined };

function hyperlinkOf(node: JSONContent, publicOrigin: string | undefined): Hyperlink | undefined {
    const attrs = node.marks?.find((mark) => mark.type === 'link')?.attrs;
    const target = hyperlinkTarget(attrs?.['href'], publicOrigin);
    const title = attrs?.['title'];
    return target ? { target, tooltip: typeof title === 'string' && title ? title : undefined } : undefined;
}

function hyperlinkTarget(href: unknown, publicOrigin: string | undefined): string | undefined {
    if (typeof href !== 'string') return undefined;
    // Gated after the strip, or a character XML can't hold could hide a scheme from isAllowedUri.
    const kept = stripNonXmlChars(href);
    if (!kept || !isAllowedUri(kept)) return undefined;
    // Outside Eigen a root-relative href means nothing.
    const absolute = kept.startsWith('//')
        ? `https:${kept}`
        : publicOrigin && kept.startsWith('/')
          ? `${publicOrigin}${kept}`
          : kept;
    // What a URI reference can't hold; `%` stays, so an encoded href encodes no further.
    return absolute.replace(/[^A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]/gu, (character) => encodeURIComponent(character));
}

// ── Styles, every value from eigen-prose.css ────────────────────────────────────────────────────────────────────

// (usWinAscent + usWinDescent) / unitsPerEm, Word's line height; for Inter and JetBrains Mono hhea and typo agree, so
// every reader does.
const FONT_LINE_HEIGHT = new Map([
    ['Inter', 1.21],
    ['JetBrains Mono', 1.32],
]);

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
    const fontLineHeight = FONT_LINE_HEIGHT.get(font);
    if (fontLineHeight === undefined) throw new Error(`no line height for ${font}`);
    return Math.round((240 * linePt) / (sizePt * fontLineHeight));
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
    return { sz: Math.round(cssPt(width, bodyPt()) * 8), color: hex };
}

function bodyPt(): number {
    return cssPt(proseValue('.eigen-prose', 'font-size'), 12);
}

// A length an element in the body text takes, in twips.
function proseTwips(selector: string, property: string): number {
    return twips(cssPt(proseValue(selector, property), bodyPt()));
}

// The bar is the left border and the padding its space; the indent puts the bar where the editor draws it.
function quoteLook() {
    const border = proseBorder('.eigen-prose blockquote', 'border-left');
    const space = Math.round(cssPt(proseValue('.eigen-prose blockquote', 'padding-left'), bodyPt()));
    return { border: { ...border, space }, indent: twips(space + border.sz / 8) };
}

// Paragraph shading stops at the borders, so borders in the fill's color carry it over the padding. The indent
// compensates the side padding and border, so the box's outer edge sits on the text column (ruling R32).
function codeBlockLook() {
    const padding = proseValue('.eigen-prose pre', 'padding');
    const fill = proseColor('.eigen-prose pre', 'background-color');
    const border = (side: 'top' | 'left') => ({
        sz: CODE_BORDER_EIGHTHS,
        space: Math.round(cssPt(boxSide(padding, side), bodyPt())),
        color: fill,
    });
    const [vertical, horizontal] = [border('top'), border('left')];
    return {
        fill,
        borders: { top: vertical, left: horizontal, bottom: vertical, right: horizontal },
        indent: twips(horizontal.space + CODE_BORDER_EIGHTHS / 8),
    };
}

const CODE_BORDER_EIGHTHS = 4;

// A heading without its own size or line height inherits the prose root's, as h5 and h6 do.
function headingMetrics(level: number) {
    const selector = `.eigen-prose h${level}`;
    const sizePt = cssPt(proseValueIfSet(selector, 'font-size') ?? proseValue('.eigen-prose', 'font-size'), bodyPt());
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
const HAIRLINE: Pick<StyleDef, 'pPr' | 'rPr'> = {
    pPr: { spacing: { before: 0, after: 0, line: 20, exact: true } },
    rPr: { size: 2 },
};

// No w:lang, so Word checks spelling in the reader's own language.
function stylesXml(styles: StyleDef[]): string {
    const body = { font: proseFont('.eigen-prose'), sizePt: bodyPt(), color: proseColor('.eigen-prose', 'color') };
    const defaults = `<w:docDefaults><w:rPrDefault><w:rPr>${rPrXml({ font: body.font, color: body.color, size: halfPoints(body.sizePt) })}</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>${pPrXml({ spacing: { before: 0, after: 0 } })}</w:pPr></w:pPrDefault></w:docDefaults>`;
    return `<w:styles xmlns:w="${W_NS}">${defaults}${styles.map(styleXml).join('')}</w:styles>`;
}

const TASK_DONE = 'ul[data-type="taskList"] li[data-checked="true"] > div';

function styleDefinitions(): StyleDef[] {
    const body = { font: proseFont('.eigen-prose'), sizePt: bodyPt(), color: proseColor('.eigen-prose', 'color') };
    const paragraphLine = lineHeightPt(proseValue('.eigen-prose p', 'line-height'), body.sizePt);
    const captionPt = cssPt(proseValue('.eigen-prose figcaption', 'font-size'), body.sizePt);
    const quote = quoteLook();
    const code = codeBlockLook();
    const codePt = cssPt(proseValue('.eigen-prose pre code', 'font-size'), body.sizePt);
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
                spacing: { before, after, line: autoLine(line, sizePt, body.font) },
                outlineLvl: level - 1,
            },
            rPr: { spacing: tracking, size: halfPoints(sizePt) },
        };
    });
    const styles: StyleDef[] = [
        {
            type: 'paragraph',
            id: 'Normal',
            name: 'Normal',
            isDefault: true,
            qFormat: true,
            pPr: {
                spacing: {
                    after: twips(cssPt(proseValue('.eigen-prose p', 'margin-bottom'), body.sizePt)),
                    line: autoLine(paragraphLine, body.sizePt, body.font),
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
                pBdr: { left: quote.border },
                spacing: {
                    after: twips(
                        cssPt(boxSide(proseValue('.eigen-prose blockquote p', 'margin'), 'bottom'), body.sizePt),
                    ),
                },
                ind: { left: quote.indent },
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
                pBdr: code.borders,
                shading: code.fill,
                spacing: {
                    before: twips(cssPt(boxSide(codeMargin, 'top'), body.sizePt)),
                    after: twips(cssPt(boxSide(codeMargin, 'bottom'), body.sizePt)),
                    line: autoLine(
                        lineHeightPt(proseValue('.eigen-prose pre', 'line-height'), codePt),
                        halfPoints(codePt) / 2,
                        proseFont('.eigen-prose code'),
                    ),
                },
                ind: { left: code.indent, right: code.indent },
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
                    after: twips(cssPt(boxSide(proseValue('.eigen-prose figure', 'margin'), 'bottom'), body.sizePt)),
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
                    before: twips(cssPt(boxSide(ruleMargin, 'top'), body.sizePt)),
                    after: twips(cssPt(boxSide(ruleMargin, 'bottom'), body.sizePt)),
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
                size: halfPoints(cssPt(proseValue('.eigen-prose code', 'font-size'), body.sizePt)),
                shading: proseColor('.eigen-prose code', 'background-color'),
            },
        },
    ];
    return styles;
}
