import type { NewVectorElement } from '@workspace/lib/vector';
import { ApiError } from '../../core/errors';
import { A_NS, ASVG_NS, alternativeFor, P_NS, R_NS } from '../../core/ooxml';
import { openPackage, optional, type Relationship, relOfType } from '../../core/opc';
import type { XmlElement } from '../../core/xml';
import type { CountedWarningCode } from '../../document/transform/protocol';
import { POINTS_PER_UNIT } from '../doc/package';
import { IMAGE_EXTENSION_BY_MIME, MIME_ALIASES } from '../image-types';
import { IMPORT_MESSAGES } from '../messages';
import { cachedBy, charge, childOf, childrenOf, firstChildOf, prefixedAttrOf } from './lookup';

export const MAX_SLIDES = 500;

const SAVE_AS_PPTX =
    'Only .pptx presentations can be imported. Save the file as a .pptx in PowerPoint and import it again.';

const PML = 'application/vnd.openxmlformats-officedocument.presentationml';
const PRESENTATION = `${PML}.presentation.main+xml`;
// What PowerPoint saves a macro-enabled deck, a template and a slideshow as: each a presentation too, refused by name.
const NOT_A_PRESENTATION = new Set([
    'application/vnd.ms-powerpoint.presentation.macroenabled.main+xml',
    `${PML}.template.main+xml`,
    'application/vnd.ms-powerpoint.template.macroenabled.main+xml',
    `${PML}.slideshow.main+xml`,
    'application/vnd.ms-powerpoint.slideshow.macroenabled.main+xml',
]);

// The content parts the reader parses, by relationship type: a part is parsed only when its content type agrees, so
// a relationship can't hand the reader notes, a diagram or a part of another kind.
const PART_TYPES = {
    slide: `${PML}.slide+xml`,
    slideLayout: `${PML}.slidelayout+xml`,
    slideMaster: `${PML}.slidemaster+xml`,
    theme: 'application/vnd.openxmlformats-officedocument.theme+xml',
};
export type PartKind = keyof typeof PART_TYPES;

// A graphic frame's chart, parsed only under ppt/charts/ and of this type; never its own relationships.
const CHART_TYPE = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';

// Pictures are read raw, never parsed, and only these of the types an import stores: the media a slide shows.
const SLIDE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml']);

export type Part = { path: string; root: XmlElement; rels: Map<string, Relationship> };
export type MediaPart = { path: string; contentType: string; extension: string; size: number };

export type PptxPackage = {
    presentation: Part;
    // In p:sldIdLst order, each once; a slide whose relationship names no slide part is left out.
    slides: string[];
    // The part a relationship of this kind names, parsed once; a damaged layout, master or theme is none.
    related(from: Part, kind: Exclude<PartKind, 'slide'>): Part | undefined;
    slide(path: string): Part | undefined;
    // The c:chartSpace an r:id names, parsed once; a missing or damaged one is none.
    chart(from: Part, id: string | undefined): XmlElement | undefined;
    // The picture an r:embed names, when it is one the deck can show.
    media(from: Part, id: string | undefined): MediaPart | undefined;
    readMedia(path: string): Uint8Array | undefined;
};

export type Frame = { width: number; height: number };

// What a walk over one deck shares: its budget, its pictures, its losses.
export type DeckWalk = {
    pkg: PptxPackage;
    // The frame's px per EMU, where the slide's origin lands in the frame, and the slide's extent there.
    scale: number;
    offset: { x: number; y: number };
    slide: Frame;
    // Children walked and elements written, each capped: a master's shapes count again for every slide.
    shapes: number;
    elements: number;
    // The update's weight so far, charged as each frame and element is written.
    weight: number;
    // A layout's or master's elements and the children walked for them, by part and colour map: read once, copied onto
    // every slide that shows them.
    decorations: Map<string, { elements: NewVectorElement[]; shapes: number }>;
    // A picture part's media name, its bytes read the first time a slide shows it; none when they don't read.
    mediaName(part: MediaPart): string | undefined;
    // Counts what the import leaves out or draws simpler, once for the shape of the file it is in (or the background),
    // however many slides show that shape.
    lost(code: CountedWarningCode, source: XmlElement): void;
};

// A loss in the shape or background being drawn.
export type Lost = (code: CountedWarningCode) => void;

// The package is read only through relationships and [Content_Types].xml, so an entry named outside them is never read.
export function readPackage(bytes: Uint8Array): PptxPackage {
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
    if (!main?.startsWith('ppt/') || mainType !== PRESENTATION) throw new ApiError(400, IMPORT_MESSAGES.pptx.invalid);
    const root = pkg.part(main);
    if (root?.ns !== P_NS || root.local !== 'presentation') throw new ApiError(400, IMPORT_MESSAGES.pptx.invalid);
    const presentation: Part = { path: main, root, rels: pkg.relationships(main) };

    const ids = childrenOf(childOf(root, P_NS, 'sldIdLst') ?? root, P_NS, 'sldId');
    if (ids.length > MAX_SLIDES) throw new ApiError(413, IMPORT_MESSAGES.pptx.tooLarge);
    // PowerPoint lists a slide once; a list naming one again would read it again.
    const listed = ids.flatMap((id) => {
        const rel = presentation.rels.get(prefixedAttrOf(id, R_NS, 'id') ?? '');
        const path = rel && !rel.external && rel.type.endsWith('/slide') ? rel.target : undefined;
        return path && pkg.contentTypeOf(path) === PART_TYPES.slide && pkg.zip.entry(path) ? [path] : [];
    });
    const slides = [...new Set(listed)];

    const parts = new Map<string, Part | undefined>();
    const related = (from: Part, kind: Exclude<PartKind, 'slide'>): Part | undefined => {
        const path = relOfType(from.rels, kind);
        if (!path) return undefined;
        if (!parts.has(path))
            parts.set(
                path,
                optional(() => read(path, kind)),
            );
        return parts.get(path);
    };
    const charts = new Map<string, XmlElement | undefined>();
    return {
        presentation,
        slides,
        related,
        slide: (path) => read(path, 'slide'),
        chart: (from, id) => {
            const rel = id ? from.rels.get(id) : undefined;
            const path = rel && !rel.external && rel.type.endsWith('/chart') ? rel.target : undefined;
            if (!path?.startsWith('ppt/charts/') || pkg.contentTypeOf(path) !== CHART_TYPE) return undefined;
            if (!charts.has(path))
                charts.set(
                    path,
                    optional(() => pkg.part(path)),
                );
            return charts.get(path);
        },
        media: (from, id) => {
            const rel = id ? from.rels.get(id) : undefined;
            if (!rel || rel.external || !rel.type.endsWith('/image') || !rel.target.startsWith('ppt/'))
                return undefined;
            const declared = pkg.contentTypeOf(rel.target);
            const contentType = declared && (MIME_ALIASES.get(declared) ?? declared);
            const extension =
                contentType && SLIDE_IMAGE_TYPES.has(contentType) && IMAGE_EXTENSION_BY_MIME.get(contentType);
            const entry = pkg.zip.entry(rel.target);
            return contentType && extension && entry
                ? { path: rel.target, contentType, extension, size: entry.size }
                : undefined;
        },
        readMedia: (path) => optional(() => pkg.zip.read(path)),
    };
}

export const EMU_PER_POINT = 12_700;

// ST_Coordinate in EMU, or Strict's universal measure; anything else, or past what a double holds exactly, is none.
// Past 64 characters it is none unread: no coordinate needs more, and a file's 4 MB one would be parsed at each use.
const MAX_COORDINATE_CHARS = 64;

export function emu(value: string | undefined): number | undefined {
    if (value === undefined || value.length > MAX_COORDINATE_CHARS) return undefined;
    const [, number, unit = ''] = value.trim().match(/^(-?\d+(?:\.\d+)?)([a-z]*)$/) ?? [];
    const points = POINTS_PER_UNIT.get(unit);
    const result =
        unit === '' ? Number(number) : points === undefined ? Number.NaN : Number(number) * points * EMU_PER_POINT;
    return Number.isFinite(result) && Math.abs(result) <= Number.MAX_SAFE_INTEGER ? result : undefined;
}

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

// A layout's or master's is unwrapped again for every colour map its shapes are read with.
export function alternative(element: XmlElement): XmlElement[] {
    return alternatives(element, null, () => {
        charge(element.children.length);
        return alternativeOf(element);
    });
}
