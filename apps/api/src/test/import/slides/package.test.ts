import { describe, expect, test } from 'bun:test';
import { readPptx } from '../../../lib/import/slides/from-pptx';
import { readPptxPackage } from '../../../lib/import/slides/package';
import { MAX_PACKAGE_XML_BYTES, MAX_PACKAGE_XML_TAGS } from '../../../lib/ooxml/opc';
import {
    box,
    buildPptx,
    DIAGRAM_DATA_TYPE,
    dspSp,
    graphicFrame,
    NS,
    PIXEL_PNG,
    PML,
    para,
    pic,
    pptxParts,
    REL,
    rel,
    smartArt,
    sp,
    textBox,
    zipParts,
} from '../../fixtures/pptx';

// The package walk: what a pptx must be to be read, and the parts a relationship may hand the reader.

const OPTIONS = { maxMediaBytes: 35 * 1024 * 1024 };

function refusal(bytes: Uint8Array): { status: number; message: string } {
    try {
        readPptx(bytes, OPTIONS);
    } catch (error) {
        if (error instanceof Error && 'status' in error && typeof error.status === 'number')
            return { status: error.status, message: error.message };
        throw error;
    }
    throw new Error('expected a refusal');
}

const text = (words: string) => sp({ xfrm: box(0, 0, 100, 100), txBox: true, text: para(words) });
const htmlOf = (bytes: Uint8Array) =>
    readPptx(bytes, OPTIONS).slides.map((slide) =>
        slide.elements.flatMap((element) => (element.type === 'richtext' ? [element.html] : [])).join(''),
    );

describe('a pptx package', () => {
    test('is read by its relationships, its slides in p:sldIdLst order', () => {
        const parts = pptxParts({ slides: [{ shapes: text('one') }, { shapes: text('two') }] });
        // The list names the second slide part first.
        parts['ppt/presentation.xml'] = String(parts['ppt/presentation.xml']).replace(
            '<p:sldId id="256" r:id="rId10"/><p:sldId id="257" r:id="rId11"/>',
            '<p:sldId id="257" r:id="rId11"/><p:sldId id="256" r:id="rId10"/>',
        );
        expect(htmlOf(zipParts(parts))).toEqual(['<p>two</p>', '<p>one</p>']);
    });

    test('a slide listed twice is read once, where it is first listed', () => {
        const parts = pptxParts({ slides: [{ shapes: text('one') }, { shapes: text('two') }] });
        parts['ppt/presentation.xml'] = String(parts['ppt/presentation.xml']).replace(
            '<p:sldId id="256" r:id="rId10"/><p:sldId id="257" r:id="rId11"/>',
            '<p:sldId id="256" r:id="rId10"/><p:sldId id="257" r:id="rId11"/><p:sldId id="258" r:id="rId10"/>',
        );
        expect(htmlOf(zipParts(parts))).toEqual(['<p>one</p>', '<p>two</p>']);
    });

    test('a macro-enabled deck, a template and a slideshow are refused with a word on saving as .pptx', () => {
        for (const type of [
            'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml',
            `${PML}.template.main+xml`,
            `${PML}.slideshow.main+xml`,
        ]) {
            const refused = refusal(buildPptx({ slides: [{}], mainType: type }));
            expect(refused.status).toBe(400);
            expect(refused.message).toContain('.pptx');
        }
    });

    test('a package whose main part is not a presentation is no pptx', () => {
        const docx = buildPptx({
            slides: [{}],
            mainType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
        });
        expect(refusal(docx)).toEqual({ status: 400, message: 'Not a valid pptx file' });
        const parts = pptxParts({ slides: [{}] });
        delete parts['_rels/.rels'];
        expect(refusal(zipParts(parts))).toEqual({ status: 400, message: 'Not a valid pptx file' });
        expect(refusal(new TextEncoder().encode('not a zip'))).toEqual({
            status: 400,
            message: 'Not a valid pptx file',
        });
    });

    test('an encrypted package gets the password message', () => {
        const ole = new Uint8Array(4096);
        ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
        ole.set(Buffer.from('EncryptedPackage', 'utf16le'), 1024);
        const refused = refusal(ole);
        expect(refused.status).toBe(400);
        expect(refused.message).toContain('password-protected');
    });

    test('a relationship reaches only a part of the type it names, inside ppt/', () => {
        const parts = pptxParts({ slides: [{ shapes: text('kept') }, {}, {}] });
        // A "slide" that is a notes part, and one outside ppt/.
        parts['ppt/_rels/presentation.xml.rels'] = String(parts['ppt/_rels/presentation.xml.rels'])
            .replace('slides/slide2.xml', 'notesSlides/notesSlide1.xml')
            .replace('slides/slide3.xml', '../evil.xml');
        parts['ppt/notesSlides/notesSlide1.xml'] = `<p:notes ${NS}/>`;
        parts['evil.xml'] = `<p:sld ${NS}/>`;
        parts['[Content_Types].xml'] = String(parts['[Content_Types].xml']).replace(
            '</Types>',
            `<Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="${PML}.notesSlide+xml"/><Override PartName="/evil.xml" ContentType="${PML}.slide+xml"/></Types>`,
        );
        expect(htmlOf(zipParts(parts))).toEqual(['<p>kept</p>']);
    });

    test('looping and missing relationships end the chain rather than the import', () => {
        const parts = pptxParts({ slides: [{ shapes: text('first') }, { shapes: text('second') }] });
        // The first slide's layout is the slide itself; the second's layout names a master that is the layout.
        parts['ppt/slides/_rels/slide1.xml.rels'] =
            `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel('rId1', 'slideLayout', 'slide1.xml')}</Relationships>`;
        parts['ppt/slideLayouts/_rels/slideLayout1.xml.rels'] =
            `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel('rId1', 'slideMaster', 'slideLayout1.xml')}</Relationships>`;
        delete parts['ppt/slideMasters/_rels/slideMaster1.xml.rels'];
        expect(htmlOf(zipParts(parts))).toEqual(['<p>first</p>', '<p>second</p>']);
    });

    test('a damaged layout costs its looks, a damaged slide the file', () => {
        const parts = pptxParts({ slides: [{ shapes: text('stays') }] });
        parts['ppt/slideLayouts/slideLayout1.xml'] = '<p:sldLayout';
        expect(htmlOf(zipParts(parts))).toEqual(['<p>stays</p>']);
        parts['ppt/slides/slide1.xml'] = '<p:sld';
        expect(refusal(zipParts(parts))).toEqual({ status: 400, message: 'Not a valid pptx file' });
    });

    test('pictures are only png, jpeg, gif and svg parts inside ppt/, never another part an image relationship names', () => {
        const pptx = buildPptx({
            slides: [
                {
                    shapes: ['rId2', 'rId3', 'rId4', 'rId5']
                        .map((id) => pic({ xfrm: box(0, 0, 10, 10), embed: id }))
                        .join(''),
                    rels:
                        rel('rId2', 'image', '../media/a.png') +
                        rel('rId3', 'image', '../media/b.emf') +
                        rel('rId4', 'image', '../diagrams/data1.xml') +
                        rel('rId5', 'image', '../../docProps/thumbnail.png'),
                },
            ],
            files: {
                'ppt/media/a.png': PIXEL_PNG,
                'ppt/media/b.emf': PIXEL_PNG,
                'ppt/diagrams/data1.xml': '<dgm:dataModel/>',
                'docProps/thumbnail.png': PIXEL_PNG,
            },
        });
        const deck = readPptx(pptx, OPTIONS);
        expect(deck.media.map((media) => media.contentType)).toEqual(['image/png']);
        expect(deck.slides[0].elements.map((element) => element.type)).toEqual([
            'image',
            'richtext',
            'richtext',
            'richtext',
        ]);
        expect(deck.warnings).toContainEqual({ code: 'images-dropped', count: 3 });
    });

    test(`every part it parses spends the package's one budget of ${MAX_PACKAGE_XML_BYTES} bytes and ${MAX_PACKAGE_XML_TAGS} tags`, () => {
        const tooLarge = { status: 413, message: 'This presentation is too large to import' };
        const tagged = buildPptx({
            slides: [{ shapes: `<p:extLst>${'<a/>'.repeat(MAX_PACKAGE_XML_TAGS)}</p:extLst>` }],
        });
        expect(refusal(tagged)).toEqual(tooLarge);
        const padded = buildPptx({ slides: [{ shapes: ' '.repeat(MAX_PACKAGE_XML_BYTES) }] });
        expect(refusal(padded)).toEqual(tooLarge);
        // Two slides each under the budget spend it together.
        const half = { shapes: ' '.repeat(MAX_PACKAGE_XML_BYTES / 2 + 1) };
        expect(refusal(buildPptx({ slides: [half, half] }))).toEqual(tooLarge);
        // Under it, the same shapes read.
        expect(() => readPptxPackage(buildPptx({ slides: [{ shapes: '<a/>'.repeat(1000) }] }))).not.toThrow();
    });

    test('[Content_Types].xml and a chart part spend it too, refusing the file before anything is read from them', () => {
        const tooLarge = { status: 413, message: 'This presentation is too large to import' };
        const parts = pptxParts({ slides: [{ shapes: text('types') }] });
        parts['[Content_Types].xml'] = String(parts['[Content_Types].xml']).replace(
            '</Types>',
            `${' '.repeat(MAX_PACKAGE_XML_BYTES)}</Types>`,
        );
        expect(refusal(zipParts(parts))).toEqual(tooLarge);
        // A chart part past the budget refuses the deck, not only its box: a damaged one costs only its box.
        const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart';
        const chart = buildPptx({
            slides: [
                {
                    shapes: graphicFrame(C, 0, 0, 9525, 9525, `<c:chart xmlns:c="${C}" r:id="rId5"/>`),
                    rels: rel('rId5', 'chart', '../charts/chart1.xml'),
                },
            ],
            types: '<Override PartName="/ppt/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>',
            files: {
                'ppt/charts/chart1.xml': `<c:chartSpace xmlns:c="${C}">${' '.repeat(MAX_PACKAGE_XML_BYTES)}</c:chartSpace>`,
            },
        });
        expect(refusal(chart)).toEqual(tooLarge);
    });

    test('a part a relationship names as the wrong kind is still read as its own kind for another', () => {
        const deck = buildPptx({
            masters: [{ shapes: text('master') }],
            slides: [{ layout: 0, rels: rel('rId1', 'slideLayout', '../slideMasters/slideMaster1.xml') }, {}],
        });
        expect(htmlOf(deck)).toEqual(['', '<p>master</p>']);
    });

    test("SmartArt's parts are parsed only through their relationship and content type", () => {
        const drawing = dspSp({ xfrm: box(0, 0, 100, 100), text: para('drawn'), txXfrm: textBox(0, 0, 100, 100) });
        const read = (diagram: ReturnType<typeof smartArt>) =>
            htmlOf(
                buildPptx({
                    slides: [{ shapes: diagram.shapes, rels: diagram.rels }],
                    types: diagram.types,
                    files: diagram.files,
                }),
            );
        const drawn = smartArt([0, 0, 400, 200], { nodes: ['node'], drawing });
        expect(read(drawn)).toEqual(['<p>drawn</p>']);
        // A drawing of another content type is no drawing: the box keeps the data model's text.
        expect(read(smartArt([0, 0, 400, 200], { nodes: ['node'], drawing, drawingType: 'application/xml' }))).toEqual([
            '<p>SmartArt not imported</p><p>node</p>',
        ]);
        // A data part of another content type is no data model.
        const untyped = { ...drawn, types: drawn.types.replace(DIAGRAM_DATA_TYPE, 'application/xml') };
        expect(read(untyped)).toEqual(['<p>SmartArt not imported</p>']);
        // A data model without its dataModelExt names no drawing, though the slide relates one.
        const data = String(drawn.files['ppt/diagrams/data1.xml']).replace(/<dgm:extLst>.*<\/dgm:extLst>/, '');
        expect(read({ ...drawn, files: { ...drawn.files, 'ppt/diagrams/data1.xml': data } })).toEqual([
            '<p>SmartArt not imported</p><p>node</p>',
        ]);
        // A damaged drawing costs only its shapes.
        expect(read({ ...drawn, files: { ...drawn.files, 'ppt/diagrams/drawing1.xml': '<dsp:drawing' } })).toEqual([
            '<p>SmartArt not imported</p><p>node</p>',
        ]);
    });

    test('a SmartArt drawing past the parse budget refuses the deck', () => {
        const diagram = smartArt([0, 0, 400, 200], { drawing: ' '.repeat(MAX_PACKAGE_XML_BYTES) });
        const bytes = buildPptx({
            slides: [{ shapes: diagram.shapes, rels: diagram.rels }],
            types: diagram.types,
            files: diagram.files,
        });
        expect(refusal(bytes)).toEqual({ status: 413, message: 'This presentation is too large to import' });
    });

    test('the relationship types match by their last segment, as a Strict package spells them', () => {
        const parts = pptxParts({ slides: [{ shapes: text('strict') }] });
        for (const [name, part] of Object.entries(parts))
            if (name.endsWith('.rels'))
                parts[name] = String(part).replaceAll(REL, 'http://purl.oclc.org/ooxml/officeDocument/relationships');
        expect(htmlOf(zipParts(parts))).toEqual(['<p>strict</p>']);
    });
});
