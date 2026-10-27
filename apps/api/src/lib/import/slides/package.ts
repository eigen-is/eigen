// A pptx as the deck reader opens it: the presentation, its slides in order and the layouts, masters, themes, charts,
// SmartArt drawings and pictures they name, each read only through its relationships; and what one walk over the deck
// shares.

import type { NewVectorElement } from '@workspace/lib/vector';
import { ApiError } from '../../core/errors';
import type { XmlElement } from '../../core/xml';
import type { CountedWarningCode } from '../../document/transform/protocol';
import type { Budget } from '../../ooxml/budget';
import { DIAGRAM_DATA_TYPE, DIAGRAM_DRAWING_TYPE, diagramDrawingId, THEME_TYPE } from '../../ooxml/drawingml';
import { A_NS, ASVG_NS, alternativeFor, P_NS, R_NS } from '../../ooxml/ooxml';
import { chartPart } from '../../ooxml/ooxml-chart';
import type { OoxmlPackage, Part } from '../../ooxml/opc';
import { openPackage, optional, relOfType, relTarget } from '../../ooxml/opc';
import { PML, PRESENTATION_TYPE, SLIDE_LAYOUT_TYPE, SLIDE_MASTER_TYPE, SLIDE_TYPE } from '../../ooxml/presentationml';
import type { MediaPart } from '../image-types';
import { pictureMediaPart } from '../image-types';
import { IMPORT_MESSAGES, SAVE_AS_PPTX } from '../messages';
import { cachedBy, charge, childOf, childrenOf, firstChildOf, prefixedAttrOf } from './lookup';

export const MAX_SLIDES = 500;

// What PowerPoint saves a macro-enabled deck, a template and a slideshow as: each a presentation too, refused by name.
const NOT_A_PRESENTATION = new Set([
    'application/vnd.ms-powerpoint.presentation.macroenabled.main+xml',
    `${PML}.template.main+xml`,
    'application/vnd.ms-powerpoint.template.macroenabled.main+xml',
    `${PML}.slideshow.main+xml`,
    'application/vnd.ms-powerpoint.slideshow.macroenabled.main+xml',
]);

// The content parts the reader parses, by relationship type: a part is parsed only when its content type agrees, so
// a relationship can't hand the reader notes, a SmartArt graphic's layout or a part of another kind. contentTypeOf
// answers in lower case.
const PART_TYPES = {
    slide: SLIDE_TYPE.toLowerCase(),
    slideLayout: SLIDE_LAYOUT_TYPE.toLowerCase(),
    slideMaster: SLIDE_MASTER_TYPE.toLowerCase(),
    theme: THEME_TYPE,
    diagramData: DIAGRAM_DATA_TYPE.toLowerCase(),
    diagramDrawing: DIAGRAM_DRAWING_TYPE.toLowerCase(),
};
export type PartKind = keyof typeof PART_TYPES;

export type PptxPackage = {
    presentation: Part;
    // In p:sldIdLst order, each once; a slide whose relationship names no slide part is left out.
    slides: string[];
    // The part a relationship of this kind names, parsed once; a damaged layout, master or theme is none.
    related(from: Part, kind: 'slideLayout' | 'slideMaster' | 'theme'): Part | undefined;
    slide(path: string): Part | undefined;
    // The SmartArt graphic a dgm:relIds names: its data model, and the drawing Office cached of it, which a relationship
    // of the showing part names. A missing or damaged one is none.
    diagram(from: Part, relIds: XmlElement): Diagram;
    // The c:chartSpace an r:id names, parsed once; a missing or damaged one is none.
    chart(from: Part, id: string | undefined): XmlElement | undefined;
    // The picture an r:embed names, when it is one the deck can show.
    media(from: Part, id: string | undefined): MediaPart | undefined;
    readMedia: OoxmlPackage['readMedia'];
};

export type Diagram = { data: XmlElement | undefined; drawing: Part | undefined };

export type Frame = { width: number; height: number };

// What a walk over one deck shares: its budget, its pictures, its losses.
export type DeckWalk = {
    pkg: PptxPackage;
    // The frame's px per EMU, where the slide's origin lands in the frame, and the slide's extent there.
    scale: number;
    // The deck's width in pt, whose half points a text size snaps to.
    slideWidth: number;
    offset: { x: number; y: number };
    slide: Frame;
    // Children walked and elements written, each a budget: a master's shapes count again for every slide.
    shapes: Budget;
    elements: Budget;
    // The update's weight, charged as each frame and element is written.
    weight: Budget;
    // A layout's or master's elements and the children walked for them, by part and color map: read once, copied onto
    // every slide that shows them.
    decorations: Map<string, { elements: NewVectorElement[]; shapes: number }>;
    // A picture part's media name, its bytes read the first time a slide shows it; none when they don't read.
    mediaName(part: MediaPart): string | undefined;
    // Counts what the import leaves out or draws simpler, once for the shape of the file it is in (or the background),
    // however many slides show that shape.
    lost(code: CountedWarningCode, source: XmlElement): void;
};

// The package is read only through relationships and [Content_Types].xml, so an entry named outside them is never read.
export function readPptxPackage(bytes: Uint8Array): PptxPackage {
    // Every part it parses, [Content_Types].xml and the relationships too, spends the package's one parse budget.
    const pkg = openPackage(bytes, IMPORT_MESSAGES.pptx);
    const read = (path: string | undefined, kind: PartKind): Part | undefined => {
        if (!path?.startsWith('ppt/') || pkg.contentTypeOf(path) !== PART_TYPES[kind]) return undefined;
        const root = pkg.part(path);
        return root && { path, root, rels: pkg.relationships(path) };
    };

    const main = relOfType(pkg.relationships(''), 'officeDocument');
    const mainType = main && pkg.contentTypeOf(main);
    if (mainType && NOT_A_PRESENTATION.has(mainType)) throw new ApiError(400, SAVE_AS_PPTX);
    if (!main?.startsWith('ppt/') || mainType !== PRESENTATION_TYPE)
        throw new ApiError(400, IMPORT_MESSAGES.pptx.invalid);
    const root = pkg.part(main);
    if (root?.ns !== P_NS || root.local !== 'presentation') throw new ApiError(400, IMPORT_MESSAGES.pptx.invalid);
    const presentation: Part = { path: main, root, rels: pkg.relationships(main) };

    const ids = childrenOf(childOf(root, P_NS, 'sldIdLst') ?? root, P_NS, 'sldId');
    if (ids.length > MAX_SLIDES) throw new ApiError(413, IMPORT_MESSAGES.pptx.tooLarge);
    // PowerPoint lists a slide once; a list naming one again would read it again.
    const listed = ids.flatMap((id) => {
        const path = relTarget(presentation.rels, prefixedAttrOf(id, R_NS, 'id'), 'slide');
        return path && pkg.contentTypeOf(path) === PART_TYPES.slide && pkg.zip.entry(path) ? [path] : [];
    });
    const slides = [...new Set(listed)];

    // By kind too, so a part named as one kind is never handed out as another.
    const parts = new Map<string, Part | undefined>();
    const parsed = (path: string | undefined, kind: Exclude<PartKind, 'slide'>): Part | undefined => {
        if (!path) return undefined;
        const key = `${kind} ${path}`;
        if (!parts.has(key))
            parts.set(
                key,
                optional(() => read(path, kind)),
            );
        return parts.get(key);
    };
    const diagram = (from: Part, relIds: XmlElement): Diagram => {
        const data = parsed(relTarget(from.rels, prefixedAttrOf(relIds, R_NS, 'dm'), 'diagramData'), 'diagramData');
        const id = data && drawingIds(data.root, null, () => diagramDrawingId(data.root));
        return { data: data?.root, drawing: parsed(relTarget(from.rels, id, 'diagramDrawing'), 'diagramDrawing') };
    };
    return {
        presentation,
        slides,
        related: (from, kind) => parsed(relOfType(from.rels, kind), kind),
        slide: (path) => read(path, 'slide'),
        diagram,
        chart: (from, id) => chartPart(pkg, from.rels, id, 'ppt/charts/'),
        media: (from, id) => pictureMediaPart(pkg, from.rels, id, 'ppt/'),
        readMedia: pkg.readMedia,
    };
}

// A data model's drawing is looked up once, however many frames show it.
const drawingIds = cachedBy<null, string | undefined>();

function isSvgExtension(extension: XmlElement): boolean {
    return extension.ns === A_NS && extension.local === 'ext' && childOf(extension, ASVG_NS, 'svgBlip') !== undefined;
}

// The picture an a:blip shows: its svgBlip extension's, else its own.
export function blipMedia(pkg: PptxPackage, from: Part, blip: XmlElement | undefined): MediaPart | undefined {
    const extensions = blip && childOf(blip, A_NS, 'extLst');
    const extension = extensions && firstChildOf(extensions, isSvgExtension);
    const svg = extension && childOf(extension, ASVG_NS, 'svgBlip');
    return (
        pkg.media(from, svg && prefixedAttrOf(svg, R_NS, 'embed')) ??
        pkg.media(from, blip && prefixedAttrOf(blip, R_NS, 'embed'))
    );
}

// Requires names prefixes, not namespaces: PowerPoint's spellings of the namespaces this reader reads. Not a14, whose
// choice holds an equation the fallback draws as a picture, nor p14, whose ink the fallback draws too.
const PRESENTATION_PREFIXES = new Set(['p', 'a', 'r', 'mc']);

const alternativeOf = alternativeFor(PRESENTATION_PREFIXES);
const alternatives = cachedBy<null, XmlElement[]>();

// A layout's or master's is unwrapped again for every color map its shapes are read with.
export function presentationAlternative(element: XmlElement): XmlElement[] {
    return alternatives(element, null, () => {
        charge(element.children.length);
        return alternativeOf(element);
    });
}
