import JSZip from 'jszip';

// Deterministic .docx fixture for the docx import work. Hand-built OOXML rather
// than a checked-in binary, so every part the importer reads is visible here:
// a styled heading, bold/italic runs, an external hyperlink, a bulleted list, and
// one embedded PNG. Fixed zip timestamps keep the bytes stable across runs.

export const GOLDEN_DOCX_HEADING = 'Quarterly Report';
export const GOLDEN_DOCX_LINK = 'https://example.com/report';
export const GOLDEN_DOCX_LIST = ['North', 'South', 'East'];
// mammoth names extracted images by encounter order; the importer stores them
// under this name in the document's media/ folder.
export const GOLDEN_DOCX_IMAGE_NAME = 'image-0.png';

const EPOCH = new Date(Date.UTC(2024, 0, 1));

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`;

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${GOLDEN_DOCX_LINK}" TargetMode="External"/>
<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/pixel.png"/>
</Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/></w:style>
</w:styles>`;

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

const listParagraphs = GOLDEN_DOCX_LIST.map(
    (item) =>
        `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>${item}</w:t></w:r></w:p>`,
).join('');

const DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
<w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${GOLDEN_DOCX_HEADING}</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Prepared by the </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>growth</w:t></w:r><w:r><w:t xml:space="preserve"> team, with </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>notes</w:t></w:r><w:r><w:t xml:space="preserve"> and a </w:t></w:r><w:hyperlink r:id="rId3"><w:r><w:t>reference</w:t></w:r></w:hyperlink><w:r><w:t>.</w:t></w:r></w:p>
${listParagraphs}
<w:p><w:r><w:drawing><wp:inline><wp:extent cx="381000" cy="381000"/><wp:docPr id="1" name="Picture 1" descr="A pixel"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="pixel.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId4"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="381000" cy="381000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>
</w:body>
</w:document>`;

export async function buildGoldenDocx(imageBytes: Uint8Array): Promise<ArrayBuffer> {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', CONTENT_TYPES, { date: EPOCH });
    zip.file('_rels/.rels', PACKAGE_RELS, { date: EPOCH });
    zip.file('word/document.xml', DOCUMENT, { date: EPOCH });
    zip.file('word/_rels/document.xml.rels', DOCUMENT_RELS, { date: EPOCH });
    zip.file('word/styles.xml', STYLES, { date: EPOCH });
    zip.file('word/numbering.xml', NUMBERING, { date: EPOCH });
    zip.file('word/media/pixel.png', imageBytes, { date: EPOCH });
    return zip.generateAsync({ type: 'arraybuffer' });
}
