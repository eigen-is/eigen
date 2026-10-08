import type { JSONContent } from '@tiptap/core';
import { isAllowedUri } from '@tiptap/extension-link';
import { EIGEN_FONT_NAMES, EIGEN_FONTS, type EigenFont, getFontName } from '@workspace/lib/constants/fonts';
import { DEFAULT_PAGE_SETUP, pageTwips } from '@workspace/lib/docs/eigendoc';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { escapeXml, escapeXmlText, stripNonXmlChars } from '@workspace/lib/xml';
import JSZip from 'jszip';
import { cssColorToHex } from '../colors';
import { proseValue, proseValueIfSet } from './prose-css';

// ProseMirror JSON -> docx bytes, WordprocessingML written by hand. Runs inside the transform Worker (worker.ts owns
// execution; the main-thread orchestration lives in export-document.ts). This module must not reach the Mount or the
// preview cache — the Worker imports it. Every size, spacing and color comes from eigen-prose.css through proseValue,
// and the JSON comes off a CRDT no schema checked, so attrs are validated at use and the structure normalized.
export async function eigendocToDocx(
    json: JSONContent,
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
    };
    const body = paragraphsOf(json.content ?? [], {}, { pkg, first: false }, false)
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
        ['word/styles.xml', stylesXml(), `${WML}.styles+xml`],
        ['word/numbering.xml', `<w:numbering xmlns:w="${W_NS}"/>`, `${WML}.numbering+xml`],
        ['word/settings.xml', SETTINGS_XML, `${WML}.settings+xml`],
        ['word/fontTable.xml', FONT_TABLE_XML, `${WML}.fontTable+xml`],
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

// What one export accumulates as it walks: the document's relationships, one per distinct hyperlink target.
type Package = {
    relationships: Relationship[];
    hyperlinks: Map<string, string>;
    publicOrigin: string | undefined;
};

// The walk's surroundings: a flow's first block drops a heading's margin above, a heading scales its inline code.
type Context = { pkg: Package; first: boolean; headingPt?: number };

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

const FONT_TABLE_XML = `<w:fonts xmlns:w="${W_NS}">${EIGEN_FONTS.map(
    ({ name, category }) =>
        `<w:font w:name="${escapeXml(name)}"><w:charset w:val="00"/><w:family w:val="${FONT_FAMILY[category]}"/><w:pitch w:val="${category === 'monospace' ? 'fixed' : 'variable'}"/></w:font>`,
).join('')}</w:fonts>`;

// ── Properties, written in the ECMA-376 sequence: Word reports a child out of order as unreadable content ─────────

type Spacing = { before?: number; after?: number; line?: number; exact?: true };

type ParagraphProps = {
    style?: string;
    keepNext?: true;
    keepLines?: true;
    spacing?: Spacing;
    jc?: string;
    outlineLvl?: number;
};

// size in half-points, spacing in twips, colors as RRGGBB.
type RunProps = {
    style?: string;
    font?: string;
    bold?: true;
    italic?: true;
    strike?: true;
    color?: string;
    spacing?: number;
    size?: number;
    underline?: true;
    shading?: string;
    vertAlign?: 'subscript' | 'superscript';
};

type Paragraph = { props: ParagraphProps; runs: string };

function pPrXml({ style, keepNext, keepLines, spacing, jc, outlineLvl }: ParagraphProps): string {
    return [
        style && `<w:pStyle w:val="${style}"/>`,
        keepNext && '<w:keepNext/>',
        keepLines && '<w:keepLines/>',
        spacing &&
            `<w:spacing${spacing.before === undefined ? '' : ` w:before="${spacing.before}"`}${spacing.after === undefined ? '' : ` w:after="${spacing.after}"`}${spacing.line === undefined ? '' : ` w:line="${spacing.line}" w:lineRule="${spacing.exact ? 'exact' : 'auto'}"`}/>`,
        jc && `<w:jc w:val="${jc}"/>`,
        outlineLvl !== undefined && `<w:outlineLvl w:val="${outlineLvl}"/>`,
    ]
        .filter(Boolean)
        .join('');
}

function rPrXml(props: RunProps): string {
    const { style, font, bold, italic, strike, color, spacing, size, underline, shading, vertAlign } = props;
    return [
        style && `<w:rStyle w:val="${style}"/>`,
        font && `<w:rFonts w:ascii="${font}" w:hAnsi="${font}" w:eastAsia="${font}" w:cs="${font}"/>`,
        bold && '<w:b/><w:bCs/>',
        italic && '<w:i/><w:iCs/>',
        strike && '<w:strike/>',
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
    ['paragraph', (node, context) => paragraphsOf(node.content ?? [], { jc: justification(node) }, context, true)],
    [
        'heading',
        (node, context) => {
            const level = clampInt(node.attrs?.['level'], 1, 6, 1);
            const { sizePt } = headingMetrics(level);
            const firstMargin = context.first
                ? proseValueIfSet(`.eigen-prose h${level}:first-child`, 'margin-top')
                : undefined;
            const props = {
                style: `Heading${level}`,
                spacing: firstMargin === undefined ? undefined : { before: twips(cssPt(firstMargin, sizePt)) },
                jc: justification(node),
            };
            return paragraphsOf(node.content ?? [], props, { ...context, headingPt: sizePt }, true);
        },
    ],
    ['pageBreak', () => [{ props: { style: 'PageBreak' }, runs: '<w:r><w:br w:type="page"/></w:r>' }]],
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
        paragraphs.push(...write(node, { pkg: context.pkg, first: !textblock && index === 0 }));
    }
    if (inline.length > 0 || (textblock && paragraphs.length === 0)) flush();
    return paragraphs;
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

// Split before escaping, which drops the controls Word spells as elements.
function textXml(text: string): string {
    return text
        .split(/(\r\n|[\r\n\v\t])/)
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

// (usWinAscent + usWinDescent) / unitsPerEm, Word's line height; for Inter hhea and typo agree, so every reader does.
const FONT_LINE_HEIGHT = new Map([['Inter', 1.21]]);

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

function bodyPt(): number {
    return cssPt(proseValue('.eigen-prose', 'font-size'), 12);
}

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
function stylesXml(): string {
    const body = { font: proseFont('.eigen-prose'), sizePt: bodyPt(), color: proseColor('.eigen-prose', 'color') };
    const paragraphLine = lineHeightPt(proseValue('.eigen-prose p', 'line-height'), body.sizePt);
    const captionPt = cssPt(proseValue('.eigen-prose figcaption', 'font-size'), body.sizePt);
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
        { type: 'paragraph', id: 'PageBreak', name: 'Page Break', basedOn: 'Normal', ...HAIRLINE },
        { type: 'paragraph', id: 'Spacer', name: 'Spacer', basedOn: 'Normal', ...HAIRLINE },
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
    const defaults = `<w:docDefaults><w:rPrDefault><w:rPr>${rPrXml({ font: body.font, color: body.color, size: halfPoints(body.sizePt) })}</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>${pPrXml({ spacing: { before: 0, after: 0 } })}</w:pPr></w:pPrDefault></w:docDefaults>`;
    return `<w:styles xmlns:w="${W_NS}">${defaults}${styles.map(styleXml).join('')}</w:styles>`;
}
