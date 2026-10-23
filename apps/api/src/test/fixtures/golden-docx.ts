import type { JSONContent } from '@tiptap/core';
import { C_NS } from '../../lib/core/ooxml';
import { CHART_CONTENT_TYPE } from '../../lib/core/ooxml-chart';
import { writeZip } from '../../lib/core/zip';
import { toTransferableBuffer } from '../../lib/document/transform/protocol';
import { docxToPmJson } from '../../lib/import/doc/from-docx';

// Deterministic .docx fixture for the docx import work. Hand-built OOXML rather
// than a checked-in binary, so every part the importer reads is visible here:
// a styled heading, bold/italic runs, an external hyperlink, a bulleted list, and
// one embedded PNG. writeZip's fixed date keeps the bytes stable across runs.

export const GOLDEN_DOCX_HEADING = 'Quarterly Report';
export const GOLDEN_DOCX_LINK = 'https://example.com/report';
export const GOLDEN_DOCX_LIST = ['North', 'South', 'East'];
// The reader names extracted images by encounter order; the importer stores them
// under this name in the document's media/ folder.
export const GOLDEN_DOCX_IMAGE_NAME = 'image-1.png';
// One inline picture of media/pixel.png, as a run.
export const GOLDEN_DOCX_IMAGE_RUN = `<w:r><w:drawing><wp:inline><wp:extent cx="381000" cy="381000"/><wp:docPr id="1" name="Picture 1" descr="A pixel"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="pixel.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId4"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="381000" cy="381000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;

const contentTypesXml = (extra: string): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
${extra}
</Types>`;

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const documentRelsXml = (extra: string): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${GOLDEN_DOCX_LINK}" TargetMode="External"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/pixel.png"/>
<Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/>
<Relationship Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
${extra}
</Relationships>`;

const stylesXml = (extra: string): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style>
${extra}
</w:styles>`;

const numberingXml = (extra: string): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
${extra}
</w:numbering>`;

const listParagraphs = GOLDEN_DOCX_LIST.map(
    (item) =>
        `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${item}</w:t></w:r></w:p>`,
).join('');

const fontTableXml = (fonts: string): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
${fonts}
</w:fonts>`;

const documentXml = (body: string): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>
${body}
</w:body>
</w:document>`;

const footnotesXml = (footnotes: string): string => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
${footnotes}
</w:footnotes>`;

const DOCUMENT =
    documentXml(`<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${GOLDEN_DOCX_HEADING}</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Prepared by the </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>growth</w:t></w:r><w:r><w:t xml:space="preserve"> team, with </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>notes</w:t></w:r><w:r><w:t xml:space="preserve"> and a </w:t></w:r><w:hyperlink r:id="rId3"><w:r><w:t>reference</w:t></w:r></w:hyperlink><w:r><w:t>.</w:t></w:r></w:p>
${listParagraphs}
<w:p>${GOLDEN_DOCX_IMAGE_RUN}</w:p>`);

export async function buildGoldenDocx(imageBytes: Uint8Array): Promise<ArrayBuffer> {
    return zipDocx(DOCUMENT, { media: { 'word/media/pixel.png': imageBytes } });
}

// The parts a test adds to the golden package: footnotes land in word/footnotes.xml, styles join styles.xml,
// numbering numbering.xml, fonts fontTable.xml; theme is the whole theme1.xml; rels and contentTypes join theirs,
// and media maps a path to its bytes.
export type DocxParts = {
    footnotes?: string;
    styles?: string;
    numbering?: string;
    fontTable?: string;
    theme?: string;
    rels?: string;
    contentTypes?: string;
    media?: Record<string, Uint8Array>;
};

// The golden package around a body of the caller's own: its Heading1 style, bullets as numId 1 and
// decimal numbers, two levels deep, as numId 2.
export async function buildDocxWithBody(body: string, parts: DocxParts = {}): Promise<ArrayBuffer> {
    return zipDocx(documentXml(body), parts);
}

// Stored, as JSZip wrote it, so a test can find a body's text in the bytes.
function zipDocx(document: string, parts: DocxParts): ArrayBuffer {
    const { footnotes, styles = '', numbering = '', fontTable = '', theme, rels = '', contentTypes = '' } = parts;
    const media = parts.media ?? { 'word/media/pixel.png': new Uint8Array() };
    const entries: Record<string, string | Uint8Array> = {
        '[Content_Types].xml': contentTypesXml(contentTypes),
        '_rels/.rels': PACKAGE_RELS,
        'word/document.xml': document,
        'word/_rels/document.xml.rels': documentRelsXml(rels),
        'word/styles.xml': stylesXml(styles),
        'word/numbering.xml': numberingXml(numbering),
        'word/fontTable.xml': fontTableXml(fontTable),
        ...(theme && { 'word/theme/theme1.xml': theme }),
        ...media,
        ...(footnotes && { 'word/footnotes.xml': footnotesXml(footnotes) }),
    };
    return toTransferableBuffer(writeZip(Object.entries(entries).map(([name, data]) => ({ name, data, store: true }))));
}

// The namespaces a header or footer part declares, as Word's do.
export const BAND_NAMESPACES = [
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
].join(' ');

const RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const WORDPROCESSING = 'application/vnd.openxmlformats-officedocument.wordprocessingml';

// A header or footer part, word/<id>.xml, the final section names by its id; rels are its own relationships.
export type DocxBand = { id: string; kind: 'header' | 'footer'; type?: string; xml: string; rels?: string };

// The golden package with a body, a final section naming each band, its sectPr content, settings.xml's, styles and
// parts.
export async function buildDocxWithBands(
    bands: DocxBand[],
    options: {
        sectPr?: string;
        settings?: string;
        body?: string;
        styles?: string;
        media?: DocxParts['media'];
        contentTypes?: string;
    } = {},
): Promise<ArrayBuffer> {
    const encode = (text: string) => new TextEncoder().encode(text);
    const references = bands
        .map(({ id, kind, type }) => `<w:${kind}Reference${type ? ` w:type="${type}"` : ''} r:id="${id}"/>`)
        .join('');
    const media: Record<string, Uint8Array> = { 'word/media/pixel.png': new Uint8Array(), ...options.media };
    for (const { id, kind, xml, rels } of bands) {
        const tag = kind === 'header' ? 'w:hdr' : 'w:ftr';
        media[`word/${id}.xml`] = encode(`<${tag} ${BAND_NAMESPACES}>${xml}</${tag}>`);
        if (rels)
            media[`word/_rels/${id}.xml.rels`] = encode(
                `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
            );
    }
    if (options.settings)
        media['word/settings.xml'] = encode(`<w:settings ${BAND_NAMESPACES}>${options.settings}</w:settings>`);
    const body = options.body ?? '<w:p><w:r><w:t>Body</w:t></w:r></w:p>';
    return buildDocxWithBody(`${body}<w:sectPr>${references}${options.sectPr ?? ''}</w:sectPr>`, {
        styles: options.styles,
        rels: [
            ...bands.map(
                ({ id, kind }) => `<Relationship Id="${id}" Type="${RELATIONSHIP}/${kind}" Target="${id}.xml"/>`,
            ),
            ...(options.settings
                ? [`<Relationship Id="rIdSettings" Type="${RELATIONSHIP}/settings" Target="settings.xml"/>`]
                : []),
        ].join(''),
        contentTypes:
            bands
                .map(
                    ({ id, kind }) =>
                        `<Override PartName="/word/${id}.xml" ContentType="${WORDPROCESSING}.${kind}+xml"/>`,
                )
                .join('') + (options.contentTypes ?? ''),
        media,
    });
}

// A w:drawing naming a chart part: inline at Word's default 12.7 × 7.62 cm, or anchored with the anchor's own children.
export function chartRun(id: string, { extent = 'cx="4572000" cy="2743200"', anchor = '' } = {}): string {
    const tag = anchor ? 'wp:anchor' : 'wp:inline';
    return `<w:r><w:drawing><${tag}>${anchor}<wp:extent ${extent}/><wp:docPr id="3" name="Chart 3"/><a:graphic><a:graphicData uri="${C_NS}"><c:chart xmlns:c="${C_NS}" r:id="${id}"/></a:graphicData></a:graphic></${tag}></w:drawing></w:r>`;
}

// Chart parts where Word puts them, word/charts/chart1.xml on, named by rId20 on, as chart parts.
export function chartParts(parts: string[]): DocxParts {
    return {
        rels: parts
            .map(
                (_, i) =>
                    `<Relationship Id="rId${20 + i}" Type="${RELATIONSHIP}/chart" Target="charts/chart${i + 1}.xml"/>`,
            )
            .join(''),
        contentTypes: parts
            .map((_, i) => `<Override PartName="/word/charts/chart${i + 1}.xml" ContentType="${CHART_CONTENT_TYPE}"/>`)
            .join(''),
        media: Object.fromEntries(
            parts.map((xml, i) => [`word/charts/chart${i + 1}.xml`, new TextEncoder().encode(xml)]),
        ),
    };
}

// A body imported as an upload is, its parts beside the golden package's.
export async function importDocxBody(
    body: string,
    parts: DocxParts = {},
    options: { publicOrigin?: string } = {},
): Promise<ReturnType<typeof docxToPmJson>> {
    return docxToPmJson(Buffer.from(await buildDocxWithBody(body, parts)), options);
}

// Every node of a type, in document order.
export function nodesOfType(json: JSONContent, type: string): JSONContent[] {
    return [
        ...(json.type === type ? [json] : []),
        ...(json.content ?? []).flatMap((child) => nodesOfType(child, type)),
    ];
}

// Every mark of a type on any text, with the text it sits on.
export function marksOfType(json: JSONContent, type: string): { text: string; attrs: Record<string, unknown> }[] {
    return nodesOfType(json, 'text').flatMap((node) =>
        (node.marks ?? [])
            .filter((mark) => mark.type === type)
            .map((mark) => ({ text: node.text ?? '', attrs: mark.attrs ?? {} })),
    );
}
