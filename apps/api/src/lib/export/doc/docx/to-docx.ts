// The docx writer's entry: a doc's JSON, bands, page and Normal to the bytes of a Word document, run in the transform
// process. It walks the body, the notes and the bands into parts of their own, and packages them with the styles, the
// fonts and the media. What Word can't hold is counted through the loss counter the caller passes.

import type { JSONContent } from '@tiptap/core';
import type { NormalStyle, PageSetup } from '@workspace/lib/docs/eigendoc';
import { FIRST_PAGE_BAND, flattenNestedFootnotes, pageTwips } from '@workspace/lib/docs/eigendoc';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import type { EigendocBands } from '../../../document/doc';
import { codeHighlighter } from '../../../document/lowlight';
import type { LossCounter } from '../../../document/transform/protocol';
import type { PackagePart } from '../../../ooxml/opc';
import { partRelationships, relationshipsXml, relsPathOf, writePackage } from '../../../ooxml/opc';
import { NOTE_SEPARATORS, WML } from '../../../ooxml/wordml';
import { officeChartContentTypes, officeCharts } from '../../office-chart';
import type { OfficeMedia } from '../../office-image';
import { OFFICE_IMAGE_CONTENT_TYPES, officeImages } from '../../office-image';
import type { FontSlot } from './fonts';
import { embeddedFonts, fontTableXml } from './fonts';
import { numberingXml } from './numbering';
import type { Context, Package } from './package';
import { BAND_TAGS, DOCUMENT_NAMESPACES, sectionXml, separatorXml, settingsXml, withNoteNumber } from './package';
import { blocksOf, blocksXml, withoutAfter } from './paragraphs';
import { styleDefinitions, stylesXml } from './styles';

// Every look comes from eigen-prose.css. No schema checked the CRDT's JSON, so attrs are checked where they are used.
export function writeDocx(
    {
        json,
        bands,
        page: setup,
        style: normal,
    }: { json: JSONContent; bands: EigendocBands; page: PageSetup; style: NormalStyle },
    {
        title,
        media,
        publicOrigin,
        lost,
    }: { title: string; media: OfficeMedia[]; publicOrigin?: string; lost: LossCounter['lost'] },
): Uint8Array {
    const document = partRelationships();
    for (const type of ['styles', 'numbering', 'settings', 'fontTable']) document.relate(type, `${type}.xml`);
    const pkg: Package = {
        partRels: document,
        publicOrigin,
        abstractNums: [],
        numAbstracts: [],
        bullets: new Map(),
        checkboxes: false,
        languages: new Set(),
        highlight: codeHighlighter(),
        images: officeImages(media, 'word/media'),
        charts: officeCharts('word'),
        lastDrawingId: 0,
        footnotes: [],
        // A Spacer's and a figure's mark draw in the Normal's Regular.
        faces: new Map([[normal.font, new Set<FontSlot>(['Regular'])]]),
        normal,
        styles: new Map(styleDefinitions(normal).map((style) => [style.id, style])),
        lost,
    };
    const page = pageTwips(setup);
    const column = page.width - page.margin.left - page.margin.right;
    const flow: Context = { pkg, firstInFlow: false, column, indent: 0, depth: 0, orderedListsAround: 0, quotes: 0 };
    const body = blocksXml(blocksOf(json.content ?? [], {}, flow, false), pkg.styles);

    // The notes the body referenced, in Word's notes part after its two separators, each in the body's column through
    // the part's own relationships, as a band is. A nested note is its text.
    const noteParts: PackagePart[] = [];
    if (pkg.footnotes.length > 0) {
        pkg.partRels = partRelationships();
        const note: Context = { ...flow, style: 'FootnoteText' };
        const notes = pkg.footnotes.map((node, index) => {
            const blocks = blocksOf(flattenNestedFootnotes(node).content ?? [], {}, note, false);
            return `<w:footnote w:id="${index + 1}">${blocksXml(withNoteNumber(blocks), pkg.styles)}</w:footnote>`;
        });
        noteParts.push([
            'word/footnotes.xml',
            `<w:footnotes ${DOCUMENT_NAMESPACES}>${NOTE_SEPARATORS.slice(0, 2).map(separatorXml).join('')}${notes.join('')}</w:footnotes>`,
            `${WML}.footnotes+xml`,
        ]);
        if (pkg.partRels.relationships.length > 0)
            noteParts.push([relsPathOf('word/footnotes.xml'), relationshipsXml(pkg.partRels.relationships)]);
        document.relate('footnotes', 'footnotes.xml');
    }

    // Each band is a part of its own, in the body's column, its images and links related through its own rels. With page 1
    // different, a page-1 band the doc lacks is an empty part, as Word writes one.
    const bandParts: PackagePart[] = [];
    const references: string[] = [];
    for (const edge of ['header', 'footer'] as const) {
        const own = bands[edge];
        const pageOne = bands[FIRST_PAGE_BAND[edge]];
        const written: [type: 'default' | 'first', band: JSONContent | undefined][] = own ? [['default', own]] : [];
        if (setup.differentFirstPage && (own || pageOne)) written.push(['first', pageOne]);
        for (const [index, [type, band]] of written.entries()) {
            pkg.partRels = partRelationships();
            const path = `word/${edge}${index + 1}.xml`;
            const content = band
                ? blocksXml(withoutAfter(blocksOf(band.content ?? [], {}, flow, false)), pkg.styles)
                : '<w:p/>';
            bandParts.push([
                path,
                `<${BAND_TAGS[edge]} ${DOCUMENT_NAMESPACES}>${content}</${BAND_TAGS[edge]}>`,
                `${WML}.${edge}+xml`,
            ]);
            if (pkg.partRels.relationships.length > 0)
                bandParts.push([relsPathOf(path), relationshipsXml(pkg.partRels.relationships)]);
            const rId = document.relate(edge, path.slice('word/'.length));
            references.push(`<w:${edge}Reference w:type="${type}" r:id="${rId}"/>`);
        }
    }
    const fonts = embeddedFonts(pkg.faces);

    return writePackage({
        main: 'word/document.xml',
        title: stripEigenExtension(title),
        defaults: {
            ...OFFICE_IMAGE_CONTENT_TYPES,
            odttf: 'application/vnd.openxmlformats-officedocument.obfuscatedFont',
            ...officeChartContentTypes(pkg.charts),
        },
        parts: [
            [
                'word/document.xml',
                `<w:document ${DOCUMENT_NAMESPACES}><w:body>${body}${sectionXml(page, references.join(''))}</w:body></w:document>`,
                `${WML}.document.main+xml`,
            ],
            ['word/_rels/document.xml.rels', relationshipsXml(document.relationships)],
            ...noteParts,
            ...bandParts,
            ...pkg.charts.parts,
            ['word/styles.xml', stylesXml(pkg), `${WML}.styles+xml`],
            ['word/numbering.xml', numberingXml(pkg.abstractNums, pkg.numAbstracts), `${WML}.numbering+xml`],
            ['word/settings.xml', settingsXml(pkg.footnotes.length > 0), `${WML}.settings+xml`],
            ['word/fontTable.xml', fontTableXml(pkg.checkboxes, fonts.embeds), `${WML}.fontTable+xml`],
            ['word/_rels/fontTable.xml.rels', relationshipsXml(fonts.relationships)],
        ],
        files: [...fonts.files.map(([name, data]) => ({ name, data })), ...pkg.images.files, ...pkg.charts.workbooks],
    });
}
