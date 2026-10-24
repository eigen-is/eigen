import { DOCUMENT_FONT } from '@workspace/lib/constants/fonts';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import { elementsInFrame, SLIDE_SIZES, slidePxToPt, type VectorScene } from '@workspace/lib/vector';
import { ApiError } from '../../../core/errors';
import { THEME_TYPE, themeXml } from '../../../ooxml/drawingml';
import { A_NS, EMU_PER_POINT, R_NS } from '../../../ooxml/ooxml';
import { type PackagePart, type Relationship, relationshipsXml, writePackage } from '../../../ooxml/opc';
import { PML, PRESENTATION_TYPE, SCREEN_SLIDE_TYPES, SCREEN_SLIDE_WIDTH } from '../../../ooxml/presentationml';
import { OFFICE_IMAGE_CONTENT_TYPES, type OfficeMedia } from '../../office-image';
import { type Deck, LAYOUT_XML, MASTER_XML, NAMESPACES, slideXml } from './package';

// A deck → hand-written PresentationML, one slide per frame, each element as the DrawingML shape that draws it. Takes
// the scene sanitizeSceneHtml returns, and media by name as the Office media prep hands it over (an SVG beside its PNG).
export function writePptx(scene: VectorScene, { title, media }: { title: string; media: OfficeMedia[] }): Uint8Array {
    if (scene.frames.length === 0) throw new ApiError(400, 'The deck is empty');
    // The deck's own physical size: its width, and its slide size's height at the deck's pt per px.
    const { slideSize, slideWidth } = scene.meta;
    const cx = Math.round(slideWidth * EMU_PER_POINT);
    const cy = Math.round(slidePxToPt(SLIDE_SIZES[slideSize].height, slideWidth) * EMU_PER_POINT);
    const type = slideWidth === SCREEN_SLIDE_WIDTH ? ` type="${SCREEN_SLIDE_TYPES[slideSize]}"` : '';
    const deck: Deck = {
        scale: slidePxToPt(1, slideWidth) * EMU_PER_POINT,
        slideWidth,
        media: new Map(media.map((item) => [item.name, item])),
        images: new Map(),
        byId: new Map(scene.elements.map((el) => [el.id, el])),
    };
    const slides = scene.frames.map((frame) => slideXml(frame, elementsInFrame(scene.elements, frame.id), deck));

    const presentationRelationships: Relationship[] = [
        { type: `${R_NS}/slideMaster`, target: 'slideMasters/slideMaster1.xml' },
        ...slides.map((_, i) => ({ type: `${R_NS}/slide`, target: `slides/slide${i + 1}.xml` })),
        { type: `${R_NS}/theme`, target: 'theme/theme1.xml' },
        { type: `${R_NS}/presProps`, target: 'presProps.xml' },
        { type: `${R_NS}/viewProps`, target: 'viewProps.xml' },
        { type: `${R_NS}/tableStyles`, target: 'tableStyles.xml' },
    ];
    const slideIds = slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('');
    return writePackage({
        main: 'ppt/presentation.xml',
        title: stripEigenExtension(title),
        defaults: OFFICE_IMAGE_CONTENT_TYPES,
        parts: [
            [
                'ppt/presentation.xml',
                `<p:presentation ${NAMESPACES} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="${cx}" cy="${cy}"${type}/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
                PRESENTATION_TYPE,
            ],
            ['ppt/_rels/presentation.xml.rels', relationshipsXml(presentationRelationships)],
            ['ppt/presProps.xml', `<p:presentationPr ${NAMESPACES}/>`, `${PML}.presProps+xml`],
            ['ppt/viewProps.xml', `<p:viewPr ${NAMESPACES}/>`, `${PML}.viewProps+xml`],
            [
                'ppt/tableStyles.xml',
                `<a:tblStyleLst xmlns:a="${A_NS}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`,
                `${PML}.tableStyles+xml`,
            ],
            ['ppt/slideMasters/slideMaster1.xml', MASTER_XML, `${PML}.slideMaster+xml`],
            [
                'ppt/slideMasters/_rels/slideMaster1.xml.rels',
                relationshipsXml([
                    { type: `${R_NS}/slideLayout`, target: '../slideLayouts/slideLayout1.xml' },
                    { type: `${R_NS}/theme`, target: '../theme/theme1.xml' },
                ]),
            ],
            ['ppt/slideLayouts/slideLayout1.xml', LAYOUT_XML, `${PML}.slideLayout+xml`],
            [
                'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
                relationshipsXml([{ type: `${R_NS}/slideMaster`, target: '../slideMasters/slideMaster1.xml' }]),
            ],
            ['ppt/theme/theme1.xml', themeXml(DOCUMENT_FONT), THEME_TYPE],
            ...slides.flatMap(({ xml, relationships }, i): PackagePart[] => [
                [`ppt/slides/slide${i + 1}.xml`, xml, `${PML}.slide+xml`],
                [`ppt/slides/_rels/slide${i + 1}.xml.rels`, relationshipsXml(relationships)],
            ]),
        ],
        files: [...deck.images.values()].flatMap(({ part, svgPart, raster, media }) => [
            { name: `ppt/media/${part}`, data: new Uint8Array(raster), store: true },
            ...(svgPart ? [{ name: `ppt/media/${svgPart}`, data: new Uint8Array(media.data), store: true }] : []),
        ]),
    });
}
