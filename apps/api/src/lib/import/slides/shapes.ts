// The pptx reader's shapes: readSlideShapes turns a slide's shape tree into canvas elements, the layout's and the
// master's shapes beneath the slide's own, groups flattened into their children, and a SmartArt graphic into the shapes
// of the drawing PowerPoint cached of it. A shape takes what it leaves out from its placeholder and the theme, and
// anything past the caps is refused. The deck reader calls it once per slide.

import { escapeHtml } from '@workspace/lib/html';
import type {
    Arrowhead,
    NewVectorElement,
    StrokeStyle,
    StyleDefaults,
    VectorElementPatch,
} from '@workspace/lib/vector';
import {
    isBordered,
    isTransparentColor,
    normalizeAngle,
    parseFill,
    SLIDES_STYLE_DEFAULTS,
    serializeFill,
    snapSlideFontSize,
    TRANSPARENT_COLOR,
} from '@workspace/lib/vector';
import { ApiError } from '../../core/errors';
import type { XmlElement } from '../../core/xml';
import { xmlAttr, xmlElements } from '../../core/xml';
import type { CountedWarningCode, Lost } from '../../document/transform/protocol';
import { CHARS_PER_UNIT } from '../../ooxml/budget';
import {
    ARROWHEAD_BY_LINE_END,
    DEFAULT_LINE_WIDTH_EMU,
    DEGREE,
    diagramTextBodies,
    drawingLines,
    isSideways,
    lineWidthEmu,
    strokeStyleOf,
} from '../../ooxml/drawingml';
import {
    A_NS,
    C_NS,
    DGM_NS,
    DSP_NS,
    isAlternateContent,
    isOn,
    OLE_NS,
    ooxmlChild,
    P_NS,
    R_NS,
    TBL_NS,
} from '../../ooxml/ooxml';
import { CHART_NOT_IMPORTED, droppedChart } from '../../ooxml/ooxml-chart';
import type { Part } from '../../ooxml/opc';
import { PICTURE_NOT_IMPORTED } from '../image-types';
import { IMPORT_MESSAGES } from '../messages';
import { frameChart } from './chart';
import { CONNECTORS, connectorArrow, freeformArrow } from './connector';
import type { GeometryPath } from './custom-geometry';
import { closedPath, customGeometry } from './custom-geometry';
import type { Guides } from './guides';
import { evaluateGuides, guideListOf } from './guides';
import type { PlaceholderKey, ShapeProperties, SlideInheritance, Xfrm } from './inherit';
import {
    decorationsOf,
    inheritedPlaceholders,
    listStyleOf,
    nonVisualOf,
    placeholderKind,
    placeholderOf,
    propertiesOf,
    readXfrm,
    spTreeOf,
} from './inherit';
import { cachedBy, charge, childOf, prefixedAttrOf } from './lookup';
import type { DeckWalk } from './package';
import { blipMedia, presentationAlternative } from './package';
import type { GroupFill } from './paint';
import { elementGradientAngle, fillIn, mutedColor, paintOf, styleFill, styleLine, textColorOf } from './paint';
import { PRESET_KINDS, presetGeometry } from './preset-geometry';
import { richTextOf, verticalTurnOf } from './text';

export const MAX_ELEMENTS = 20_000;
export const MAX_GROUP_DEPTH = 32;

// An element is a Y.Map of about twenty fields, and a string costs per character besides: the weight caps both before
// the update is built, and so the update the main thread reads back. The corpus's heaviest weighs 3,307 (a 2.4 MB
// update); at the cap a text-heavy update is about 25 MB and commits in 135 ms.
export const MAX_PPTX_WEIGHT = 50_000;

// How an imported element looks where the file says nothing: crisp, unframed, unfilled, never the editor's rounding.
export const PPTX_STYLE: StyleDefaults = {
    ...SLIDES_STYLE_DEFAULTS,
    strokeColor: TRANSPARENT_COLOR,
    corners: 'straight',
    roughness: 0,
};

// What a dropped object leaves on the slide in its place, and the warning that counts it.
const DROPPED = {
    table: { label: 'Table not imported', code: 'tables-dropped' },
    chart: { label: CHART_NOT_IMPORTED, code: 'charts-dropped' },
    diagram: { label: 'SmartArt not imported', code: 'diagrams-dropped' },
    ole: { label: 'Embedded object not imported', code: 'objects-dropped' },
    object: { label: 'Object not imported', code: 'objects-dropped' },
    picture: { label: PICTURE_NOT_IMPORTED, code: 'images-dropped' },
} satisfies Record<string, { label: string; code: CountedWarningCode }>;
type Dropped = keyof typeof DROPPED;

const GRAPHIC_KINDS = new Map<string, Dropped>([
    [TBL_NS, 'table'],
    [C_NS, 'chart'],
    [DGM_NS, 'diagram'],
    [OLE_NS, 'ole'],
]);

// The title's text, one line, for the frame's name.
const MAX_TITLE_CHARS = 100;

export type SlideShapes = { elements: NewVectorElement[]; title: string };

type Walk = {
    deck: DeckWalk;
    inheritance: SlideInheritance;
    // The part whose relationships name the pictures and the links.
    part: Part;
    // A layout's or master's shapes: its placeholders are prompts, never drawn on a slide.
    copied: boolean;
    out: SlideShapes;
    // The children this walk has walked, which a layout's or master's cached elements charge again on every slide.
    walked: number;
};

export function readSlideShapes(deck: DeckWalk, inheritance: SlideInheritance): SlideShapes {
    const out: SlideShapes = { elements: [], title: '' };
    // The frame: its name, a title of at most 100 characters, weighs nothing besides.
    deck.weight.charge(1);
    const root: Place = (shape) => ({
        ...shape,
        x: shape.x * deck.scale + deck.offset.x,
        y: shape.y * deck.scale + deck.offset.y,
        width: shape.width * deck.scale,
        height: shape.height * deck.scale,
    });
    for (const part of decorationsOf(inheritance)) {
        const walk: Walk = { deck, inheritance, part, copied: true, out, walked: 0 };
        // A slide's clrMapOvr repaints them.
        const key = `${part.path} ${JSON.stringify([...inheritance.theme.colors.map])}`;
        const known = deck.decorations.get(key);
        if (known) {
            deck.shapes.charge(known.shapes);
            for (const element of known.elements) push(walk, { ...element });
            continue;
        }
        const elements = out.elements.length;
        const tree = spTreeOf(part.root);
        if (tree) readTree(walk, xmlElements(tree), root, 0, undefined);
        deck.decorations.set(key, { elements: out.elements.slice(elements), shapes: walk.walked });
    }
    const tree = spTreeOf(inheritance.slide.root);
    const walk: Walk = { deck, inheritance, part: inheritance.slide, copied: false, out, walked: 0 };
    if (tree) readTree(walk, xmlElements(tree), root, 0, undefined);
    // A slide without a title keeps the name its cSld gives it, which the writer writes a frame's name to.
    const cSld = childOf(inheritance.slide.root, P_NS, 'cSld');
    out.title ||= clippedTitle((cSld && xmlAttr(cSld, '', 'name')?.trim()) ?? '');
    return out;
}

function readTree(walk: Walk, shapes: XmlElement[], placeIn: Place, depth: number, group: GroupFill | undefined): void {
    if (depth > MAX_GROUP_DEPTH) throw new ApiError(413, IMPORT_MESSAGES.pptx.tooLarge);
    for (const shape of shapes) {
        walk.deck.shapes.charge(1);
        walk.walked++;
        charge(1);
        if (isAlternateContent(shape)) {
            readTree(walk, presentationAlternative(shape), placeIn, depth + 1, group);
            continue;
        }
        if (!DRAWN.get(shape.ns)?.has(shape.local)) continue;
        const cNvPr = childOf(nonVisualOf(shape) ?? shape, shape.ns, 'cNvPr');
        if (cNvPr && isOn(xmlAttr(cNvPr, '', 'hidden'))) continue;
        if (shape.local === 'grpSp') {
            const grpSpPr = childOf(shape, shape.ns, 'grpSpPr');
            const xfrm = readXfrm(grpSpPr && childOf(grpSpPr, A_NS, 'xfrm'));
            const fill = fillIn(grpSpPr);
            const size = fill && xfrm ? place(placeIn, xfrm).box : { width: 1, height: 1 };
            const angle = elementGradientAngle(size.width, size.height);
            const groupFill: GroupFill | undefined =
                fill && ((lost) => paintOf(fill, walk.inheritance.theme, { group, angle, lost }) ?? group?.(lost));
            readTree(walk, xmlElements(shape), xfrm ? inGroup(placeIn, xfrm) : placeIn, depth + 1, groupFill ?? group);
            continue;
        }
        if (shape.local === 'contentPart') {
            walk.deck.lost(DROPPED.object.code, shape);
            continue;
        }
        const own = placeholderOf(shape);
        if (walk.copied && own) continue;
        const inherited = own ? inheritedPlaceholders(own, walk.inheritance) : [];
        const chain = [propertiesOf(shape), ...inherited.map((placeholder) => placeholder.properties)];
        const xfrm = chain.find((link) => link.xfrm)?.xfrm;
        if (!xfrm) continue;
        const placed = place(placeIn, xfrm);
        if (!onSlide(placed.box, walk.deck)) continue;
        // The p:style the shape paints by: a placeholder with none of its own takes its layout's or master's.
        const style = chain.find((link) => link.style)?.style;
        if (shape.local === 'graphicFrame') readGraphicFrame(walk, shape, placed, placeIn, depth);
        else if (shape.local === 'pic') readPicture(walk, shape, chain, linesOf(chain, walk, style), placed);
        else {
            // A SmartArt drawing's shape sets its text in a box of its own, turned by the shape's turn and its own.
            const text = readXfrm(childOf(shape, DSP_NS, 'txXfrm'));
            const textBox = text && place(placeIn, { ...text, rot: xfrm.rot + text.rot }).box;
            readShape(walk, { shape, own, chain, style, placed, textBox, group });
        }
    }
}

// The shapes a slide's tree holds, and those of the drawing PowerPoint caches of a SmartArt graphic.
const DRAWN = new Map([
    [P_NS, new Set(['sp', 'pic', 'cxnSp', 'grpSp', 'graphicFrame', 'contentPart'])],
    [DSP_NS, new Set(['sp', 'grpSp'])],
]);

function push(walk: Walk, element: NewVectorElement): void {
    walk.deck.elements.charge(1);
    let weight = 1;
    for (const value of Object.values(element))
        if (typeof value === 'string') weight += Math.floor(value.length / CHARS_PER_UNIT);
    walk.deck.weight.charge(weight);
    walk.out.elements.push(element);
}

// A drawn shape and what it inherits: its placeholder, what it and the layout's and master's placeholders it takes from
// state, nearest first, and where it lands.
type Leaf = {
    shape: XmlElement;
    own: PlaceholderKey | undefined;
    chain: ShapeProperties[];
    // The p:style its paint and text take.
    style: XmlElement | undefined;
    placed: Placed;
    // Where its text goes, when not in the shape's own box.
    textBox?: Box;
    group: GroupFill | undefined;
};

function readShape(walk: Walk, leaf: Leaf): void {
    const { shape, own, chain, style, placed, textBox: textAt, group } = leaf;
    const { theme } = walk.inheritance;
    const shaped = chain.find((link) => link.geometry !== undefined);
    const geometry = shaped?.geometry ?? 'rect';
    const kind = PRESET_KINDS.get(geometry);
    const native = kind !== undefined || geometry === 'pie';
    const linear = LINES.has(geometry);
    const connector = CONNECTORS.get(geometry);
    const outline = native || linear ? undefined : outlineOf(shaped?.geom, geometry, placed);
    const body = childOf(shape, shape.ns, 'txBody');
    const lines = linesOf(chain, walk, style);
    const source = body && {
        body,
        inherited: chain.slice(1),
        listStyle: listStyleOf(own, walk.inheritance),
        style,
        rels: walk.part.rels,
    };
    // Counted once for the shape, however many slides show it.
    const lost: Lost = (code) => walk.deck.lost(code, shape);
    const text = source && richTextOf(source, theme, walk.deck, lost);
    if (text && body && own && placeholderKind(own.type) === 'title' && !walk.copied) walk.out.title ||= titleOf(body);
    const { box } = placed;
    const textBox = text && source ? turned(textAt ?? box, verticalTurnOf(source, lost)) : box;
    // What the canvas never draws loses nothing: a line's fill, a dropped outline's paint, a path's unpainted part.
    const lostIf = (drawn: boolean) => (drawn ? lost : UNDRAWN);
    const paint = {
        fill: fillOf(chain, walk, { group, style, box, lost: lostIf(native || !!outline?.some((g) => g.filled)) }),
        ...strokeOf(lines, walk, lostIf(native || linear || !!outline?.some((g) => g.stroked))),
    };
    const painted = paint.fill !== TRANSPARENT_FILL_JSON || paint.strokeColor !== TRANSPARENT_COLOR;
    // A text box is the rectangle itself; any other shape carries its text in an unpainted box on top.
    const textOnTop = () =>
        text &&
        push(walk, {
            type: 'richtext',
            ...textBox,
            ...text,
            ...NO_STROKE,
            fill: TRANSPARENT_FILL_JSON,
            corners: 'straight',
        });
    const shapeAndText = (drawn: NewVectorElement) => {
        if (painted) push(walk, { ...box, ...paint, ...drawn });
        textOnTop();
    };
    if (kind?.type === 'rectangle' && kind.corners === 'straight' && !textAt) {
        if (text) {
            // The canvas insets a bordered box's text past its border too, where PowerPoint's inset runs from the edge.
            const padding = isBordered(paint) ? Math.max(0, text.padding - paint.strokeWidth) : text.padding;
            push(walk, { type: 'richtext', ...textBox, ...text, padding, ...paint, corners: 'straight' });
        } else if (painted) push(walk, { type: 'rectangle', ...box, ...paint, corners: 'straight' });
    } else if (kind) shapeAndText(kind);
    else if (geometry === 'pie') shapeAndText({ type: 'pie', ...pieAngles(shaped?.geom, placed) });
    else if (linear) {
        if (paint.strokeColor !== TRANSPARENT_COLOR) push(walk, lineOf(placed, paint, lines.lns));
        textOnTop();
    } else if (outline) {
        const ends = [arrowheadOf(lines.lns, 'headEnd'), arrowheadOf(lines.lns, 'tailEnd')];
        const headed = ends.some((end) => end !== 'none') && paint.strokeColor !== TRANSPARENT_COLOR;
        // A connector with a head is the arrow that draws it, and so is an open freeform line with one, which is how
        // the pptx export writes an arrow of more than two points. One without a head has nothing to lose as a path,
        // and a path comes back from the pptx export as it went.
        const [line, ...more] = outline;
        const freeform =
            geometry === 'custGeom' &&
            more.length === 0 &&
            line.stroked &&
            (!line.filled || paint.fill === TRANSPARENT_FILL_JSON);
        const arrow = !headed
            ? undefined
            : connector
              ? connectorArrow(connector, line.path, box, paint, ends)
              : freeform
                ? freeformArrow(line.path, box, paint, ends)
                : undefined;
        if (arrow) push(walk, arrow);
        else {
            for (const element of pathsOf(outline, box, paint)) push(walk, element);
            // A path has no arrowheads, and PowerPoint draws a line's ends only on an open one, such as an arc's.
            if (headed && outline.some((g) => g.stroked && !g.closed)) lost('shapes-simplified');
        }
        textOnTop();
    } else {
        // A custGeom or preset past the path caps or the read's budget, or a preset no definition names.
        if (painted) lost('shapes-simplified');
        textOnTop();
    }
}

function readPicture(
    walk: Walk,
    shape: XmlElement,
    chain: ShapeProperties[],
    lines: Lines,
    { box, mirrored }: Placed,
): void {
    const blipFill = ooxmlChild(shape, shape.ns, 'blipFill', presentationAlternative);
    const blip = blipFill && childOf(blipFill, A_NS, 'blip');
    const part = blipMedia(walk.deck.pkg, walk.part, blip);
    const mediaName = part && walk.deck.mediaName(part);
    if (!mediaName) {
        // A blip naming no picture is an empty placeholder's prompt, not a picture.
        if (part || (blip && (prefixedAttrOf(blip, R_NS, 'embed') || prefixedAttrOf(blip, R_NS, 'link'))))
            droppedBox(walk, shape, 'picture', box);
        return;
    }
    // An image can't mirror; a shape the canvas draws is symmetric, and its text PowerPoint never mirrors.
    const lost: Lost = (code) => walk.deck.lost(code, shape);
    if (mirrored) lost('mirrors-dropped');
    push(walk, {
        type: 'image',
        ...box,
        ...strokeOf(lines, walk, lost),
        mediaName,
        objectFit: 'fill',
        // PowerPoint's crop to a rounded rectangle, as the pptx export writes a picture's curved corners.
        corners: chain.find((link) => link.geometry !== undefined)?.geometry === 'roundRect' ? 'curved' : 'straight',
    });
}

// A chart the reader draws becomes a chart, and a SmartArt graphic the shapes of the drawing PowerPoint cached of it.
// Any other graphic, and one it can't draw, leaves a box saying what was there.
function readGraphicFrame(walk: Walk, shape: XmlElement, { box, xfrm }: Placed, placeIn: Place, depth: number): void {
    const graphic = childOf(shape, A_NS, 'graphic');
    const data = graphic && childOf(graphic, A_NS, 'graphicData');
    const kind = GRAPHIC_KINDS.get((data && xmlAttr(data, '', 'uri')) ?? '') ?? 'object';
    if (kind === 'diagram') {
        const relIds = data && childOf(data, DGM_NS, 'relIds');
        const diagram = relIds && walk.deck.pkg.diagram(walk.part, relIds);
        const drawing = diagram?.drawing;
        const tree = drawing && childOf(drawing.root, DSP_NS, 'spTree');
        const before = walk.out.elements.length;
        if (drawing && tree) {
            const inDrawing: Walk = { ...walk, part: drawing };
            readTree(inDrawing, xmlElements(tree), inFrame(placeIn, xfrm), depth + 1, undefined);
            walk.walked = inDrawing.walked;
        }
        // The drawing's shapes are loose on the slide: the canvas has no groups, and nothing lays them out again. A
        // drawing PowerPoint cached empty shows nothing, so the box stands in for it with the graphic's text.
        if (walk.out.elements.length > before) walk.deck.lost('diagrams-flattened', shape);
        else droppedBox(walk, shape, kind, box, [DROPPED.diagram.label, ...diagramLines(diagram?.data)]);
        return;
    }
    const chart =
        kind === 'chart' && data ? frameChart(walk.deck, walk.part, data, walk.inheritance.theme.colors) : undefined;
    if (chart && 'parts' in chart) push(walk, { type: 'chart', ...box, ...chart.look, ...chart.parts });
    else droppedBox(walk, shape, kind, box, chart && droppedChart(chart.unsupported));
}

const diagramTexts = cachedBy<null, string[]>();

// A SmartArt graphic's text, a line each, for the box that stands in for a graphic without a drawing.
function diagramLines(data: XmlElement | undefined): string[] {
    if (!data) return [];
    return diagramTexts(data, null, () => {
        const bodies = diagramTextBodies(data);
        charge(bodies.length);
        return bodies
            .flatMap(drawingLines)
            .map((line) => line.trim())
            .filter(Boolean);
    });
}

// A loss the user can see on the slide, saying what was there.
function droppedBox(walk: Walk, shape: XmlElement, what: Dropped, box: Box, lines = [DROPPED[what].label]): void {
    walk.deck.lost(DROPPED[what].code, shape);
    const color = textColorOf(walk.inheritance.theme.colors);
    // Unfilled, so a title or text it overlaps stays readable, as PowerPoint's chart plot area is see-through.
    push(walk, {
        type: 'richtext',
        ...box,
        html: lines.map((line) => `<p>${escapeHtml(line)}</p>`).join(''),
        fill: TRANSPARENT_FILL_JSON,
        strokeColor: mutedColor(color),
        strokeWidth: 2,
        strokeStyle: 'dashed',
        corners: 'straight',
        color,
        fontSize: snapSlideFontSize(Math.min(32, Math.max(12, box.height / 4)), walk.deck.slideWidth),
        textAlign: 'center',
        verticalAlign: 'center',
    });
}

function titleOf(body: XmlElement): string {
    return clippedTitle(drawingLines(body).join(' ').replace(/\s+/g, ' ').trim());
}

function clippedTitle(text: string): string {
    return Array.from(text).slice(0, MAX_TITLE_CHARS).join('');
}

const TRANSPARENT_FILL_JSON = PPTX_STYLE.fill;

type Stroke = { strokeColor: string; strokeWidth: number; strokeStyle: StrokeStyle };
const NO_STROKE: Stroke = { strokeColor: TRANSPARENT_COLOR, strokeWidth: PPTX_STYLE.strokeWidth, strokeStyle: 'solid' };

// The first fill the chain states, a placeholder's own before its layout's and master's; else p:style's fillRef, its
// color the style matrix entry's phClr.
function fillOf(
    chain: ShapeProperties[],
    walk: Walk,
    { group, style, box, lost }: { group: GroupFill | undefined; style: XmlElement | undefined; box: Box; lost: Lost },
): string {
    const { theme } = walk.inheritance;
    const options = { group, angle: elementGradientAngle(box.width, box.height), lost };
    const fill = chain.find((link) => link.fill)?.fill;
    const reference = style && childOf(style, A_NS, 'fillRef');
    const paint = fill
        ? paintOf(fill, theme, options)
        : reference && paintOf(styleFill(theme, xmlAttr(reference, '', 'idx')), theme, { ...options, reference });
    return paint ? serializeFill({ ...paint, style: 'solid' }) : TRANSPARENT_FILL_JSON;
}

// The a:ln the chain states, nearest first, then the lnStyleLst entry p:style's lnRef names: each of width, dash, ends
// and color comes from the first that states it.
type Lines = { lns: XmlElement[]; entry: XmlElement | undefined; reference: XmlElement | undefined };

function linesOf(chain: ShapeProperties[], walk: Walk, style: XmlElement | undefined): Lines {
    const reference = style && childOf(style, A_NS, 'lnRef');
    const entry = reference && styleLine(walk.inheritance.theme, xmlAttr(reference, '', 'idx'));
    const lns = chain.flatMap((link) => link.ln ?? []);
    return { lns: entry ? [...lns, entry] : lns, entry, reference };
}

// PowerPoint and LibreOffice draw a line 0 wide as the thinnest they can, one device pixel; the canvas's thinnest is the
// width field's first step.
const HAIRLINE_PX = 1;

// No a:ln and no lnRef, or neither stating a color, is no stroke. A gradient line strokes in its first color.
function strokeOf(lines: Lines, walk: Walk, lost: Lost): Stroke {
    const ln = lines.lns.find((found) => fillIn(found) !== undefined);
    const fill = fillIn(ln);
    const reference = ln === lines.entry ? lines.reference : undefined;
    const paint = fill && paintOf(fill, walk.inheritance.theme, { reference, lost });
    if (fill && paint?.type === 'gradient') lost('fills-simplified');
    const color = paint?.type === 'gradient' ? paint.from : paint?.color;
    if (!color || color === TRANSPARENT_COLOR) return NO_STROKE;
    const width =
        lines.lns.map((found) => lineWidthEmu(xmlAttr(found, '', 'w'))).find((found) => found !== undefined) ??
        DEFAULT_LINE_WIDTH_EMU;
    const preset = lines.lns.map((found) => childOf(found, A_NS, 'prstDash')).find((found) => found !== undefined);
    const dash = preset && xmlAttr(preset, '', 'val');
    return {
        strokeColor: color,
        strokeWidth: width > 0 ? width * walk.deck.scale : HAIRLINE_PX,
        strokeStyle: strokeStyleOf(dash),
    };
}

const LINES = new Set(['line', 'straightConnector1']);

const outlines = cachedBy<string, GeometryPath[] | undefined>();

// A custGeom's or preset's paths in the shape's own extents, its guides' w and h, mirrored as it lands; worked out once
// for its geometry however many slides show it.
function outlineOf(
    geom: XmlElement | undefined,
    geometry: string,
    { xfrm, mirrored }: Placed,
): GeometryPath[] | undefined {
    if (!geom) return undefined;
    return outlines(geom, `${xfrm.cx} ${xfrm.cy} ${mirrored}`, () =>
        geometry === 'custGeom'
            ? customGeometry(geom, xfrm.cx, xfrm.cy, mirrored)
            : presetGeometry(geometry, childOf(geom, A_NS, 'avLst'), xfrm.cx, xfrm.cy, mirrored),
    );
}

// Each geometry a path at the shape's box: a filled one in the shape's fill, shaded where it says, a stroked one in its
// line. A filled path with an open subpath fills it closed, as PowerPoint does, and strokes it open beside.
function pathsOf(outline: GeometryPath[], box: Box, paint: { fill: string } & Stroke): NewVectorElement[] {
    const paths: NewVectorElement[] = [];
    const { fill: shapeFill, ...stroke } = paint;
    for (const { path, closed, filled, stroked, shade } of outline) {
        const fill = filled ? shadedFill(shapeFill, shade) : TRANSPARENT_FILL_JSON;
        const line = stroked ? stroke : NO_STROKE;
        const fills = fill !== TRANSPARENT_FILL_JSON;
        if (!fills && line.strokeColor === TRANSPARENT_COLOR) continue;
        if (closed || !fills) paths.push({ type: 'path', ...box, path, closed, fill, ...line });
        else {
            paths.push({ type: 'path', ...box, path: closedPath(path), closed: true, fill, ...NO_STROKE });
            if (line.strokeColor !== TRANSPARENT_COLOR)
                paths.push({ type: 'path', ...box, path, closed: false, fill: TRANSPARENT_FILL_JSON, ...line });
        }
    }
    return paths;
}

// A shading path's fill, the shape's blended toward white or black, a gradient's at both ends.
function shadedFill(fill: string, shade: number | undefined): string {
    if (shade === undefined) return fill;
    const paint = parseFill(fill);
    if (paint.type === 'solid') return serializeFill({ ...paint, color: shadedAsLibreOffice(paint.color, shade) });
    return serializeFill({
        ...paint,
        from: shadedAsLibreOffice(paint.from, shade),
        to: shadedAsLibreOffice(paint.to, shade),
    });
}

// Each sRGB channel of a #rrggbb or #rrggbbaa, its alpha kept, as LibreOffice shades.
function shadedAsLibreOffice(color: string, shade: number): string {
    if (isTransparentColor(color)) return color;
    const channels = [1, 3, 5].map((at) => {
        const channel = Number.parseInt(color.slice(at, at + 2), 16);
        const blended = shade > 0 ? channel + (255 - channel) * shade : channel * (1 + shade);
        return Math.round(blended).toString(16).padStart(2, '0');
    });
    return `#${channels.join('')}${color.slice(7)}`;
}

// A pie's adj1 and adj2 are angles on the ellipse as drawn in its own box; the kind's are its box-normalized circle's,
// which a group's scale leaves alone.
function pieAngles(preset: XmlElement | undefined, placed: Placed): { startAngle: number; sweepAngle: number } {
    const { cx: width, cy: height } = placed.xfrm;
    const list = preset && childOf(preset, A_NS, 'avLst');
    const guides =
        list && pieGuides(list, `${width} ${height}`, () => evaluateGuides(width, height, guideListOf(list)));
    const degrees = (name: string, fallback: number) => {
        const value = guides?.get(name);
        return value === undefined ? fallback : value / DEGREE;
    };
    const parametric = (visual: number) => {
        const r = (visual * Math.PI) / 180;
        return normalizeAngle((Math.atan2(width * Math.sin(r), height * Math.cos(r)) * 180) / Math.PI);
    };
    const start = parametric(degrees('adj1', 0));
    const end = parametric(degrees('adj2', 270));
    const sweep = normalizeAngle(end - start) || 360;
    // A mirrored slice runs the other way round its box.
    return { startAngle: placed.mirrored ? normalizeAngle(180 - start - sweep) : start, sweepAngle: sweep };
}

// A pie's avLst evaluated once for its extents, however many shapes its placeholder places.
const pieGuides = cachedBy<string, Guides | undefined>();

// An a:ln's headEnd or tailEnd, the nearest that states one, as the arrowhead that draws closest.
function arrowheadOf(lns: XmlElement[], local: 'headEnd' | 'tailEnd'): Arrowhead {
    const decoration = lns.map((ln) => childOf(ln, A_NS, local)).find((found) => found !== undefined);
    return ARROWHEAD_BY_LINE_END.get((decoration && xmlAttr(decoration, '', 'type')) ?? 'none') ?? 'none';
}

function lineOf(placed: Placed, stroke: Stroke, lns: XmlElement[]): NewVectorElement {
    const { start, end } = placed;
    const x = Math.min(start.x, end.x);
    const y = Math.min(start.y, end.y);
    const line = {
        x,
        y,
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y),
        angle: 0,
        points: JSON.stringify([
            [start.x - x, start.y - y],
            [end.x - x, end.y - y],
        ]),
        roundness: 'sharp',
        ...stroke,
    } satisfies VectorElementPatch;
    const [startArrowhead, endArrowhead] = [arrowheadOf(lns, 'headEnd'), arrowheadOf(lns, 'tailEnd')];
    return startArrowhead === 'none' && endArrowhead === 'none'
        ? { type: 'line', ...line }
        : { type: 'arrow', ...line, startArrowhead, endArrowhead, elbow: false };
}

const UNDRAWN: Lost = () => {};

// x' = a·x + c·y, y' = b·x + d·y: a turn after the flips, as DrawingML applies them about a box's center.
type Turn = [a: number, b: number, c: number, d: number];

function apply(m: Turn, x: number, y: number): { x: number; y: number } {
    return { x: m[0] * x + m[2] * y, y: m[1] * x + m[3] * y };
}

// `rot` degrees clockwise (y down) after the flips.
function turn(rot: number, flipH: boolean, flipV: boolean): Turn {
    const r = (rot * Math.PI) / 180;
    const [cos, sin] = [Math.cos(r), Math.sin(r)];
    const [h, v] = [flipH ? -1 : 1, flipV ? -1 : 1];
    return [cos * h, sin * h, -sin * v, cos * v];
}

// A shape as DrawingML places it: its center, extents, turn and flips.
type Placement = { x: number; y: number; width: number; height: number; rot: number; flipH: boolean; flipV: boolean };

// From a shape tree's coordinates, in EMU, to the frame's px: through each enclosing group, then the slide's scale.
type Place = (shape: Placement) => Placement;

// A group lays its children out in its chOff/chExt space, scaled onto its off/ext, then flips and turns them about its
// center. As PowerPoint, LibreOffice and POI draw it, a child is never skewed: its center moves with the group, its
// turn adds the group's (negated by one flip), and its extents scale along the group's axes, swapped for a child
// turned sideways.
function inGroup(outer: Place, xfrm: Xfrm): Place {
    const child = xfrm.child ?? { x: xfrm.x, y: xfrm.y, cx: xfrm.cx, cy: xfrm.cy };
    const kx = child.cx > 0 ? xfrm.cx / child.cx : 1;
    const ky = child.cy > 0 ? xfrm.cy / child.cy : 1;
    const [cx, cy] = [xfrm.x + xfrm.cx / 2, xfrm.y + xfrm.cy / 2];
    const turned = turn(xfrm.rot, xfrm.flipH, xfrm.flipV);
    const mirrors = xfrm.flipH !== xfrm.flipV;
    return (shape) => {
        const center = apply(turned, xfrm.x + (shape.x - child.x) * kx - cx, xfrm.y + (shape.y - child.y) * ky - cy);
        const sideways = isSideways(shape.rot);
        return outer({
            x: cx + center.x,
            y: cy + center.y,
            width: shape.width * (sideways ? ky : kx),
            height: shape.height * (sideways ? kx : ky),
            rot: (mirrors ? -shape.rot : shape.rot) + xfrm.rot,
            flipH: shape.flipH !== xfrm.flipH,
            flipV: shape.flipV !== xfrm.flipV,
        });
    };
}

// A SmartArt drawing is laid out from its graphic frame's corner, at the frame's own scale.
function inFrame(outer: Place, xfrm: Xfrm): Place {
    return inGroup(outer, { ...xfrm, child: { x: 0, y: 0, cx: xfrm.cx, cy: xfrm.cy } });
}

type Box = { x: number; y: number; width: number; height: number; angle: number };

// A leaf's box in the frame. A mirrored one keeps its box, and a pie its mirrored arc.
type Placed = {
    box: Box;
    mirrored: boolean;
    start: { x: number; y: number };
    end: { x: number; y: number };
    xfrm: Xfrm;
};

function place(placeIn: Place, xfrm: Xfrm): Placed {
    const { x, y, width, height, rot, flipH, flipV } = placeIn({
        x: xfrm.x + xfrm.cx / 2,
        y: xfrm.y + xfrm.cy / 2,
        width: xfrm.cx,
        height: xfrm.cy,
        rot: xfrm.rot,
        flipH: xfrm.flipH,
        flipV: xfrm.flipV,
    });
    const corner = apply(turn(rot, flipH, flipV), width / 2, height / 2);
    return {
        // A flipV box turns half round, as PowerPoint draws its text; a flipH one keeps its turn.
        box: { x: x - width / 2, y: y - height / 2, width, height, angle: normalizeAngle(rot + (flipV ? 180 : 0)) },
        mirrored: flipH !== flipV,
        start: { x: x - corner.x, y: y - corner.y },
        end: { x: x + corner.x, y: y + corner.y },
        xfrm,
    };
}

// A box wholly off the slide (a master's guide or note, copied onto every slide) would be stored unseen past the frame,
// which the canvas clips, or drawn in the bands beside a letterboxed slide; a box a group scaled past a double is none.
function onSlide(box: Box, deck: DeckWalk): boolean {
    if (![box.x, box.y, box.width, box.height].every(Number.isFinite)) return false;
    const r = (box.angle * Math.PI) / 180;
    const [cos, sin] = [Math.abs(Math.cos(r)), Math.abs(Math.sin(r))];
    const [halfWidth, halfHeight] = [
        (box.width * cos + box.height * sin) / 2,
        (box.width * sin + box.height * cos) / 2,
    ];
    const [cx, cy] = [box.x + box.width / 2 - deck.offset.x, box.y + box.height / 2 - deck.offset.y];
    return (
        cx + halfWidth >= 0 &&
        cx - halfWidth <= deck.slide.width &&
        cy + halfHeight >= 0 &&
        cy - halfHeight <= deck.slide.height
    );
}

// A box turned about its center: a quarter turn, or three, swaps its sides.
function turned(box: Box, turn: number): Box {
    if (turn === 0) return box;
    const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
    const [width, height] = turn % 180 === 0 ? [box.width, box.height] : [box.height, box.width];
    return { x: cx - width / 2, y: cy - height / 2, width, height, angle: normalizeAngle(box.angle + turn) };
}
