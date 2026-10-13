import { ApiError } from '../../core/errors';
import { A_NS, ASVG_NS, alternativeFor, P_NS, R_NS } from '../../core/ooxml';
import { openPackage, optional, type Relationship, relOfType, relsPathOf } from '../../core/opc';
import { type XmlElement, xmlAttr, xmlChild, xmlChildren } from '../../core/xml';
import type { CountedWarningCode } from '../../document/transform/protocol';
import { IMAGE_EXTENSION_BY_MIME, MIME_ALIASES } from '../image-types';
import { PRESENTATION_TOO_LARGE } from '../messages';

// The parts the reader parses, together: presentation, slides, layouts, masters and themes (a tree's cost: core/xml.ts).
// The corpus's most is 7.5 MB, a 369-slide deck.
export const MAX_PPTX_XML_BYTES = 16 * 1024 * 1024;

// A tree costs per element too, so the parts' elements have a cap of their own, counted as '<' in the bytes: the corpus's
// most is 398,000, and a million two-attribute tags peak near 600 MB.
export const MAX_PPTX_XML_TAGS = 1_000_000;

export const MAX_SLIDES = 500;

export const NOT_A_PPTX = 'Not a valid pptx file';
const PASSWORD_PROTECTED =
    'This presentation is password-protected. Remove the password in PowerPoint and import it again.';
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
// a relationship can't hand the reader notes, a diagram, a chart or a part of another kind.
const PART_TYPES = {
    slide: `${PML}.slide+xml`,
    slideLayout: `${PML}.slidelayout+xml`,
    slideMaster: `${PML}.slidemaster+xml`,
    theme: 'application/vnd.openxmlformats-officedocument.theme+xml',
};
export type PartKind = keyof typeof PART_TYPES;

// Pictures are read raw, never parsed, and only these of the types an import stores: the media a slide shows.
const SLIDE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml']);

export type Part = { path: string; root: XmlElement; rels: Map<string, Relationship> };
export type MediaPart = { path: string; contentType: string; extension: string; size: number };

export type PptxPackage = {
    presentation: Part;
    // In p:sldIdLst order; a slide whose relationship names no slide part is left out.
    slides: string[];
    // The part a relationship of this kind names, parsed once; a damaged layout, master or theme is none.
    related(from: Part, kind: Exclude<PartKind, 'slide'>): Part | undefined;
    slide(path: string): Part | undefined;
    // The picture an r:embed names, when it is one the deck can show.
    media(from: Part, id: string | undefined): MediaPart | undefined;
    readMedia(path: string): Uint8Array | undefined;
};

export type Frame = { width: number; height: number };

// What a walk over one deck shares: its budget, its pictures, its losses.
export type DeckWalk = {
    pkg: PptxPackage;
    // The frame's size, its px per EMU, where the slide's origin lands in it, and the slide's extent there.
    frame: Frame;
    scale: number;
    offset: { x: number; y: number };
    slide: Frame;
    // Children walked and elements written, each capped: a master's shapes are walked again for every slide.
    shapes: number;
    elements: number;
    // The update's weight so far, charged as each frame and element is written.
    weight: number;
    // A picture part's media name, the first time a slide shows it.
    mediaName(part: MediaPart): string;
    lost: Lost;
};

// Counts what the import leaves out or draws simpler, once for the element of the file it is in, however many slides
// show that element.
export type Lost = (code: CountedWarningCode, source: XmlElement) => void;

// The package is read only through relationships and [Content_Types].xml, so an entry named outside them is never read.
export function readPackage(bytes: Uint8Array): PptxPackage {
    const pkg = openPackage(bytes, PASSWORD_PROTECTED);
    const budget = { bytes: MAX_PPTX_XML_BYTES, tags: MAX_PPTX_XML_TAGS, charged: new Set<string>() };
    const charge = (paths: string[]) => {
        const fresh = [...new Set(paths)].filter((path) => !budget.charged.has(path));
        const declared = fresh.reduce((sum, path) => sum + (pkg.zip.entry(path)?.size ?? 0), 0);
        if (declared > budget.bytes) throw new ApiError(413, PRESENTATION_TOO_LARGE);
        budget.bytes -= declared;
        for (const path of fresh) budget.charged.add(path);
    };
    // Its elements counted before the tree is built: the second inflate is the price of refusing first.
    const counted = new Set<string>();
    const parse = (path: string): XmlElement | undefined => {
        charge([path]);
        const data = counted.has(path) ? undefined : pkg.zip.read(path);
        counted.add(path);
        for (let at = data?.indexOf(LESS_THAN) ?? -1; data && at >= 0; at = data.indexOf(LESS_THAN, at + 1)) {
            if (--budget.tags < 0) throw new ApiError(413, PRESENTATION_TOO_LARGE);
        }
        return pkg.part(path);
    };
    const relsOf = (path: string) => {
        parse(relsPathOf(path));
        return pkg.relationships(path);
    };
    const read = (path: string | undefined, kind: PartKind): Part | undefined => {
        if (!path?.startsWith('ppt/') || pkg.contentTypeOf(path) !== PART_TYPES[kind]) return undefined;
        const root = parse(path);
        return root && { path, root, rels: relsOf(path) };
    };

    const main = relOfType(relsOf(''), 'officeDocument');
    const mainType = main && pkg.contentTypeOf(main);
    if (mainType && NOT_A_PRESENTATION.has(mainType)) throw new ApiError(400, SAVE_AS_PPTX);
    if (!main?.startsWith('ppt/') || mainType !== PRESENTATION) throw new ApiError(400, NOT_A_PPTX);
    const root = parse(main);
    if (root?.ns !== P_NS || root.local !== 'presentation') throw new ApiError(400, NOT_A_PPTX);
    const presentation: Part = { path: main, root, rels: relsOf(main) };

    const ids = xmlChildren(xmlChild(root, P_NS, 'sldIdLst') ?? root, P_NS, 'sldId');
    if (ids.length > MAX_SLIDES) throw new ApiError(413, PRESENTATION_TOO_LARGE);
    const slides = ids.flatMap((id) => {
        const rel = presentation.rels.get(xmlAttr(id, R_NS, 'id') ?? '');
        const path = rel && !rel.external && rel.type.endsWith('/slide') ? rel.target : undefined;
        return path && pkg.contentTypeOf(path) === PART_TYPES.slide && pkg.zip.entry(path) ? [path] : [];
    });

    // Every content part the slides reach is charged before the first of them inflates.
    const reached = new Set<string>(slides);
    const reach = (from: string, type: Exclude<PartKind, 'slide'>) => {
        const path = relOfType(optional(() => relsOf(from)) ?? new Map(), type);
        if (path && !reached.has(path) && pkg.contentTypeOf(path) === PART_TYPES[type]) {
            reached.add(path);
            return path;
        }
        return undefined;
    };
    for (const slide of slides) {
        const layout = reach(slide, 'slideLayout');
        const master = layout && reach(layout, 'slideMaster');
        if (master) reach(master, 'theme');
    }
    charge([...reached]);

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
    return {
        presentation,
        slides,
        related,
        slide: (path) => read(path, 'slide'),
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

const LESS_THAN = 0x3c;

// The picture an a:blip shows: its svgBlip extension's, else its own.
export function blipMedia(pkg: PptxPackage, from: Part, blip: XmlElement | undefined): MediaPart | undefined {
    const extensions = blip && xmlChild(blip, A_NS, 'extLst');
    const svg = (extensions ? xmlChildren(extensions, A_NS, 'ext') : [])
        .map((ext) => xmlChild(ext, ASVG_NS, 'svgBlip'))
        .find((found) => found !== undefined);
    return pkg.media(from, svg && xmlAttr(svg, R_NS, 'embed')) ?? pkg.media(from, blip && xmlAttr(blip, R_NS, 'embed'));
}

// Requires names prefixes, not namespaces: PowerPoint's spellings of the namespaces this reader reads. Not a14, whose
// choice holds an equation the fallback draws as a picture, nor p14, whose ink the fallback draws too.
const PRESENTATION_PREFIXES = new Set(['p', 'a', 'r', 'mc']);

export const alternative = alternativeFor(PRESENTATION_PREFIXES);
