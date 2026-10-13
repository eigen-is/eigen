import { gradientStops } from '@workspace/lib/background';
import type { BackgroundFill, FillPaint } from '@workspace/lib/types/background';
import { stripEigenExtension } from '@workspace/lib/types/drive';
import {
    type Arrowhead,
    arrowCurveBeziers,
    arrowheadGeometry,
    arrowLabelBox,
    arrowRoute,
    type Box,
    convertToShapes,
    cornerRadius,
    diamondOutline,
    elementsInFrame,
    freedrawOutline,
    getFontMetrics,
    isBordered,
    isClosedPath,
    isTransparentColor,
    isTransparentFill,
    linearLocalToScene,
    normalizeAngle,
    type OutlineShape,
    type Point,
    parseBackgroundFill,
    parseFill,
    parsePoints,
    pointsBounds,
    rectOutline,
    type StrokeStyle,
    type TextAlign,
    type VectorArrowElement,
    type VectorElement,
    type VectorFrame,
    type VectorImageElement,
    type VectorLinearElement,
    type VectorScene,
    type VerticalAlign,
} from '@workspace/lib/vector';
import { escapeXml } from '@workspace/lib/xml';
import { JSDOM } from 'jsdom';
import { ApiError } from '../../core/errors';
import {
    A_NS,
    ASVG_NS,
    CONTENT_TYPES_NS,
    CORE_PROPERTIES_NS,
    DC_NS,
    P_NS,
    PACKAGE_RELATIONSHIPS_NS,
    R_NS,
} from '../../core/ooxml';
import { writeZip } from '../../core/zip';
import { cssColorToHex } from '../../document/colors';
import { RASTER_EXTENSIONS } from '../doc/docx-image';
import type { DocxMedia } from '../doc/to-docx';
import { isElement } from '../sanitize';

// A deck → hand-written PresentationML, one slide per frame, each element as the DrawingML shape that draws it. Takes
// the scene sanitizeSceneHtml returns, and media by name as the docx prep hands it over (an SVG beside its PNG).
export function eigenslidesToPptx(scene: VectorScene, media: DocxMedia[], title: string): Uint8Array {
    if (scene.frames.length === 0) throw new ApiError(400, 'The deck is empty');
    const size = slideSize(scene.frames[0]);
    const deck: Deck = {
        scale: size.cx / scene.frames[0].width,
        media: new Map(media.map((item) => [item.name, item])),
        images: new Map(),
        files: [],
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
    const parts: [path: string, xml: string, contentType?: string][] = [
        ['_rels/.rels', relationshipsXml(PACKAGE_RELATIONSHIPS)],
        [
            'docProps/core.xml',
            `<cp:coreProperties xmlns:cp="${CORE_PROPERTIES_NS}" xmlns:dc="${DC_NS}"><dc:title>${escapeXml(stripEigenExtension(title))}</dc:title></cp:coreProperties>`,
            'application/vnd.openxmlformats-package.core-properties+xml',
        ],
        [
            'ppt/presentation.xml',
            `<p:presentation ${NAMESPACES} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="${size.cx}" cy="${size.cy}"${size.type ? ` type="${size.type}"` : ''}/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
            `${PML}.presentation.main+xml`,
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
        ['ppt/theme/theme1.xml', THEME_XML, 'application/vnd.openxmlformats-officedocument.theme+xml'],
        ...slides.flatMap(({ xml, relationships }, i): [string, string, string?][] => [
            [`ppt/slides/slide${i + 1}.xml`, xml, `${PML}.slide+xml`],
            [`ppt/slides/_rels/slide${i + 1}.xml.rels`, relationshipsXml(relationships)],
        ]),
    ];
    const overrides = parts.map(([path, , contentType]) =>
        contentType ? `<Override PartName="/${path}" ContentType="${contentType}"/>` : '',
    );

    return writeZip([
        {
            name: '[Content_Types].xml',
            data: `${XML_DECLARATION}<Types xmlns="${CONTENT_TYPES_NS}">${DEFAULT_CONTENT_TYPES}${overrides.join('')}</Types>`,
        },
        ...parts.map(([name, xml]) => ({ name, data: `${XML_DECLARATION}${xml}` })),
        ...deck.files.map(([name, data]) => ({ name, data: new Uint8Array(data), store: true })),
    ]);
}

const PML = 'application/vnd.openxmlformats-officedocument.presentationml';
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NAMESPACES = `xmlns:a="${A_NS}" xmlns:r="${R_NS}" xmlns:p="${P_NS}"`;

const DEFAULT_CONTENT_TYPES = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Default Extension="png" ContentType="image/png"/>',
    '<Default Extension="jpeg" ContentType="image/jpeg"/>',
    '<Default Extension="svg" ContentType="image/svg+xml"/>',
].join('');

type Relationship = { type: string; target: string; external?: true };

const PACKAGE_RELATIONSHIPS: Relationship[] = [
    { type: `${R_NS}/officeDocument`, target: 'ppt/presentation.xml' },
    { type: `${PACKAGE_RELATIONSHIPS_NS}/metadata/core-properties`, target: 'docProps/core.xml' },
];

function relationshipsXml(relationships: Relationship[]): string {
    const items = relationships.map(
        ({ type, target, external }, index) =>
            `<Relationship Id="rId${index + 1}" Type="${type}" Target="${escapeXml(target)}"${external ? ' TargetMode="External"' : ''}/>`,
    );
    return `<Relationships xmlns="${PACKAGE_RELATIONSHIPS_NS}">${items.join('')}</Relationships>`;
}

// PowerPoint's two slide sizes; a deck takes the one nearest its frame's aspect, so a frame's width sets EMU per px.
const SLIDE_SIZES = [
    { cx: 12_192_000, cy: 6_858_000, type: undefined },
    { cx: 9_144_000, cy: 6_858_000, type: 'screen4x3' },
];

function slideSize(frame: VectorFrame): (typeof SLIDE_SIZES)[number] {
    const aspect = frame.width / frame.height;
    const off = (size: (typeof SLIDE_SIZES)[number]) => Math.abs(size.cx / size.cy - aspect);
    return SLIDE_SIZES.reduce((best, size) => (off(size) < off(best) ? size : best));
}

const EMU_PER_PT = 12_700;

// Text sizes and spacing in 100ths of a point, at the deck's scale.
function centipoints(slide: Slide, px: number): number {
    return Math.round((px * slide.deck.scale * 100) / EMU_PER_PT);
}

const GROUP_PROPERTIES =
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

// A white page under every slide, as an empty frame background prints on white paper.
const MASTER_XML = `<p:sldMaster ${NAMESPACES}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${GROUP_PROPERTIES}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`;

const LAYOUT_XML = `<p:sldLayout ${NAMESPACES} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GROUP_PROPERTIES}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

// Every shape writes its own colors and fonts, so the theme only has to be valid: Inter as its fonts, plain colors.
const THEME_XML = (() => {
    const colors = [
        ['dk1', '000000'],
        ['lt1', 'FFFFFF'],
        ['dk2', '1E1E1E'],
        ['lt2', 'F5F5F5'],
        ['accent1', '1971C2'],
        ['accent2', 'E03131'],
        ['accent3', '2F9E44'],
        ['accent4', 'F08C00'],
        ['accent5', '6741D9'],
        ['accent6', '0C8599'],
        ['hlink', '1971C2'],
        ['folHlink', '6741D9'],
    ].map(([name, value]) => `<a:${name}><a:srgbClr val="${value}"/></a:${name}>`);
    const font = '<a:latin typeface="Inter"/><a:ea typeface=""/><a:cs typeface=""/>';
    const placeholder = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
    const three = (xml: string) => xml.repeat(3);
    return [
        `<a:theme xmlns:a="${A_NS}" name="Eigen"><a:themeElements><a:clrScheme name="Eigen">${colors.join('')}</a:clrScheme>`,
        `<a:fontScheme name="Eigen"><a:majorFont>${font}</a:majorFont><a:minorFont>${font}</a:minorFont></a:fontScheme>`,
        `<a:fmtScheme name="Eigen"><a:fillStyleLst>${three(placeholder)}</a:fillStyleLst>`,
        `<a:lnStyleLst>${three(`<a:ln w="6350">${placeholder}</a:ln>`)}</a:lnStyleLst>`,
        `<a:effectStyleLst>${three('<a:effectStyle><a:effectLst/></a:effectStyle>')}</a:effectStyleLst>`,
        `<a:bgFillStyleLst>${three(placeholder)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`,
    ].join('');
})();

// What one export accumulates: each media name's parts once, whichever slide shows it first.
type Deck = {
    scale: number;
    media: Map<string, DocxMedia>;
    images: Map<string, Image>;
    files: [path: string, data: ArrayBuffer][];
    // The elbow router reads the shapes an arrow is bound to.
    byId: Map<string, VectorElement>;
};

type Image = { part: string; svgPart?: string; width?: number; height?: number };

type Slide = {
    deck: Deck;
    relationships: Relationship[];
    // A picture or link a slide shows twice relates once.
    rIds: Map<string, string>;
    shapes: number;
    // An arrow label's box paints the slide's solid color, where Eigen masks the shaft out under the text.
    ground: string | undefined;
};

function slideXml(
    frame: VectorFrame,
    elements: VectorElement[],
    deck: Deck,
): { xml: string; relationships: Relationship[] } {
    const background = parseBackgroundFill(frame.background);
    const slide: Slide = {
        deck,
        relationships: [{ type: `${R_NS}/slideLayout`, target: '../slideLayouts/slideLayout1.xml' }],
        rIds: new Map(),
        // The tree's own group is 1.
        shapes: 1,
        ground: background?.type === 'solid' ? background.color : undefined,
    };
    const shapes = elements.map((el) => elementXml(el, slide)).join('');
    const name = frame.name ? ` name="${escapeXml(frame.name)}"` : '';
    const xml = `<p:sld ${NAMESPACES}><p:cSld${name}>${backgroundXml(background, frame, slide)}<p:spTree>${GROUP_PROPERTIES}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
    return { xml, relationships: slide.relationships };
}

function relate(slide: Slide, type: string, target: string, external?: true): string {
    const key = `${type} ${target}`;
    let rId = slide.rIds.get(key);
    if (!rId) {
        rId = `rId${slide.relationships.push({ type: `${R_NS}/${type}`, target, external })}`;
        slide.rIds.set(key, rId);
    }
    return rId;
}

function emu(slide: Slide, px: number): number {
    return Math.round(px * slide.deck.scale);
}

// 1000ths of a percent, DrawingML's share of a whole.
function share(value: number): number {
    return Math.round(value * 100_000);
}

function degrees(radians: number): number {
    return (radians * 180) / Math.PI;
}

// Degrees clockwise as DrawingML's 60,000ths, within one turn.
function angle(degrees: number): number {
    return Math.round(normalizeAngle(degrees) * 60_000) % 21_600_000;
}

function elementXml(el: VectorElement, slide: Slide): string {
    const opacity = el.opacity / 100;
    switch (el.type) {
        case 'rectangle':
            return spXml(
                slide,
                'Rectangle',
                el,
                boxGeometry(el, slide),
                fillXml(parseFill(el.fill), opacity),
                lineXml(slide, el, opacity),
            );
        case 'ellipse':
            return spXml(
                slide,
                'Ellipse',
                el,
                presetXml('ellipse'),
                fillXml(parseFill(el.fill), opacity),
                lineXml(slide, el, opacity),
            );
        case 'diamond': {
            const radius = cornerRadius(el, 'diamond');
            const outline = diamondOutline({ x: 0, y: 0, width: el.width, height: el.height }, radius, 0);
            const geometry = radius > 0 ? outlineGeometry(outline, el, slide) : presetXml('diamond');
            return spXml(
                slide,
                'Diamond',
                el,
                geometry,
                fillXml(parseFill(el.fill), opacity),
                lineXml(slide, el, opacity),
            );
        }
        case 'pie': {
            // Eigen's angles are the box-normalized circle's; DrawingML's pie takes the angles as drawn on the ellipse.
            const visual = (stored: number) => {
                const theta = (stored * Math.PI) / 180;
                return angle(degrees(Math.atan2(el.height * Math.sin(theta), el.width * Math.cos(theta))));
            };
            const geometry =
                el.sweepAngle >= 360
                    ? presetXml('ellipse')
                    : presetXml('pie', { adj1: visual(el.startAngle), adj2: visual(el.startAngle + el.sweepAngle) });
            return spXml(slide, 'Pie', el, geometry, fillXml(parseFill(el.fill), opacity), lineXml(slide, el, opacity));
        }
        case 'image':
            return pictureXml(el, slide, opacity);
        case 'richtext': {
            const inset = el.padding + (isBordered(el) ? el.strokeWidth : 0);
            const text = textBodyXml(slide, paragraphsOf(el.html), {
                ...el,
                bold: el.fontWeight === 'bold',
                italic: el.fontStyle === 'italic',
                underline: el.textDecoration === 'underline',
                strike: el.textDecoration === 'line-through',
                inset,
                wrap: true,
                opacity,
            });
            // A rounded preset insets its text by its corners, where Eigen's keeps the box: a painted rounded box is its
            // outline, and an unpainted one shows no corners.
            const radius = cornerRadius(el);
            const painted = isBordered(el) || !isTransparentFill(parseFill(el.fill));
            const geometry =
                painted && radius > 0
                    ? outlineGeometry(
                          rectOutline({ x: 0, y: 0, width: el.width, height: el.height }, radius, 0),
                          el,
                          slide,
                      )
                    : presetXml('rect');
            return spXml(
                slide,
                'Text',
                el,
                geometry,
                fillXml(parseFill(el.fill), opacity),
                lineXml(slide, el, opacity),
                text,
            );
        }
        case 'line':
            return linearXml(el, parsePoints(el.points), slide, opacity);
        case 'freedraw':
            return freedrawXml(el, slide, opacity);
        case 'arrow':
            return arrowXml(el, slide, opacity);
        case 'chart':
            return convertToShapes(el)
                .map((shape) => elementXml(shape, slide))
                .join('');
    }
}

function spXml(slide: Slide, name: string, box: Box, geometry: string, fill: string, line: string, text = ''): string {
    const id = ++slide.shapes;
    const textBox = text ? ' txBox="1"' : '';
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name} ${id}"/><p:cNvSpPr${textBox}/><p:nvPr/></p:nvSpPr><p:spPr>${xfrmXml(slide, box)}${geometry}${fill}${line}</p:spPr>${text}</p:sp>`;
}

function xfrmXml(slide: Slide, box: Box, flipH = false, flipV = false): string {
    const rot = angle(box.angle);
    const attrs = `${rot ? ` rot="${rot}"` : ''}${flipH ? ' flipH="1"' : ''}${flipV ? ' flipV="1"' : ''}`;
    return `<a:xfrm${attrs}><a:off x="${emu(slide, box.x)}" y="${emu(slide, box.y)}"/><a:ext cx="${emu(slide, box.width)}" cy="${emu(slide, box.height)}"/></a:xfrm>`;
}

function presetXml(preset: string, guides: Record<string, number> = {}): string {
    const avs = Object.entries(guides).map(([name, value]) => `<a:gd name="${name}" fmla="val ${value}"/>`);
    return `<a:prstGeom prst="${preset}"><a:avLst>${avs.join('')}</a:avLst></a:prstGeom>`;
}

// roundRect's adj is the radius over the short side, so it draws the radius Eigen's corners give.
function boxGeometry(el: Box & { corners: 'straight' | 'curved' | 'round' }, slide: Slide): string {
    const radius = cornerRadius(el);
    const side = Math.min(el.width, el.height);
    if (radius <= 0 || emu(slide, side) === 0) return presetXml('rect');
    return presetXml('roundRect', { adj: Math.min(50_000, share(radius / side)) });
}

// A rounded outline is its core's edges pushed out by the radius, joined by arcs about the core's corners.
function outlineGeometry(outline: OutlineShape, box: Box, slide: Slide): string {
    if (outline.kind !== 'rounded') return presetXml('rect');
    const { core, radius } = outline;
    const pt = (p: Point) => `<a:pt x="${emu(slide, p.x)}" y="${emu(slide, p.y)}"/>`;
    const r = emu(slide, radius);
    if (core.length === 1) {
        const circle = `<a:moveTo>${pt({ x: core[0].x + radius, y: core[0].y })}</a:moveTo><a:arcTo wR="${r}" hR="${r}" stAng="0" swAng="21600000"/>`;
        return customXml(slide, box, `${circle}<a:close/>`, true);
    }
    // The core winds clockwise (y down), so v→w's outward normal is (dy, -dx), and its angle is where the arc starts.
    const normal = (i: number) => {
        const v = core[i % core.length];
        const w = core[(i + 1) % core.length];
        return Math.atan2(-(w.x - v.x), w.y - v.y);
    };
    let path = '';
    for (let i = 0; i < core.length; i++) {
        const w = core[(i + 1) % core.length];
        const [n, next] = [normal(i), normal(i + 1)];
        if (i === 0)
            path += `<a:moveTo>${pt({ x: core[0].x + radius * Math.cos(n), y: core[0].y + radius * Math.sin(n) })}</a:moveTo>`;
        path += `<a:lnTo>${pt({ x: w.x + radius * Math.cos(n), y: w.y + radius * Math.sin(n) })}</a:lnTo>`;
        path += `<a:arcTo wR="${r}" hR="${r}" stAng="${angle(degrees(n))}" swAng="${angle(degrees(next - n))}"/>`;
    }
    return customXml(slide, box, `${path}<a:close/>`, true);
}

function customXml(slide: Slide, box: { width: number; height: number }, path: string, filled: boolean): string {
    const w = Math.max(1, emu(slide, box.width));
    const h = Math.max(1, emu(slide, box.height));
    return `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${w}" h="${h}"${filled ? '' : ' fill="none"'}>${path}</a:path></a:pathLst></a:custGeom>`;
}

// A stored color token as DrawingML, null for transparent. A #rrggbbaa's alpha rides beside the RGB, times the element's.
function colorXml(color: string, opacity: number): string | null {
    const hex = isTransparentColor(color) ? undefined : cssColorToHex(color.slice(0, 7));
    if (!hex) return null;
    const alpha = (color.length === 9 ? Number.parseInt(color.slice(7), 16) / 255 : 1) * opacity;
    return `<a:srgbClr val="${hex}">${alpha < 1 ? `<a:alpha val="${share(alpha)}"/>` : ''}</a:srgbClr>`;
}

// The paint alone: a hatched or rough fill exports solid. A gradient takes the stops the canvas samples, its CSS angle
// (0 paints upward) turned to DrawingML's (0 paints rightward).
function fillXml(paint: FillPaint, opacity: number): string {
    if (paint.type === 'solid') {
        const color = colorXml(paint.color, opacity);
        return color ? `<a:solidFill>${color}</a:solidFill>` : '<a:noFill/>';
    }
    const stops = gradientStops(paint.from, paint.to).map(
        (stop) => `<a:gs pos="${share(stop.offset)}">${colorXml(stop.color, stop.opacity * opacity) ?? ''}</a:gs>`,
    );
    return `<a:gradFill rotWithShape="1"><a:gsLst>${stops.join('')}</a:gsLst><a:lin ang="${angle(paint.angle - 90)}" scaled="0"/></a:gradFill>`;
}

const DASHES: Record<StrokeStyle, string> = { solid: '', dashed: 'dash', dotted: 'dot' };

// DrawingML has no bar end: arrowXml draws a bar as a line of its own.
const LINE_ENDS: Record<Arrowhead, string> = {
    none: '',
    arrow: 'arrow',
    triangle: 'triangle',
    circle: 'oval',
    bar: '',
};

type Stroke = { strokeColor: string; strokeWidth: number; strokeStyle: StrokeStyle };

// Eigen draws every stroke with round caps.
function lineXml(
    slide: Slide,
    stroke: Stroke,
    opacity: number,
    ends: [Arrowhead, Arrowhead] = ['none', 'none'],
): string {
    const color = stroke.strokeWidth > 0 ? colorXml(stroke.strokeColor, opacity) : null;
    if (!color) return NO_LINE;
    const dash = DASHES[stroke.strokeStyle];
    const end = (tag: string, head: Arrowhead) =>
        LINE_ENDS[head] ? `<a:${tag} type="${LINE_ENDS[head]}" w="lg" len="lg"/>` : '';
    return [
        `<a:ln w="${emu(slide, stroke.strokeWidth)}" cap="rnd"><a:solidFill>${color}</a:solidFill>`,
        dash ? `<a:prstDash val="${dash}"/>` : '',
        `<a:round/>${end('headEnd', ends[0])}${end('tailEnd', ends[1])}</a:ln>`,
    ].join('');
}

// A two-point line is a connector the way PowerPoint draws one, from corner to corner of the box it spans and flipped
// toward its end; more points are a path.
function linearXml(
    el: VectorLinearElement | VectorArrowElement,
    points: Point[],
    slide: Slide,
    opacity: number,
    ends: [Arrowhead, Arrowhead] = ['none', 'none'],
): string {
    if (points.length === 0) return '';
    const line = lineXml(slide, el, opacity, ends);
    if (points.length === 2) {
        const [from, to] = points;
        const bounds = pointsBounds(points);
        const box = {
            x: el.x + bounds.minX,
            y: el.y + bounds.minY,
            width: bounds.maxX - bounds.minX,
            height: bounds.maxY - bounds.minY,
            angle: el.angle,
        };
        const id = ++slide.shapes;
        return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="Line ${id}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>${xfrmXml(slide, box, to.x < from.x, to.y < from.y)}${presetXml('line')}<a:noFill/>${line}</p:spPr></p:cxnSp>`;
    }
    const curved = el.roundness === 'round' && !(el.type === 'arrow' && el.elbow);
    const { box, pt } = pathFrame(el, points, slide);
    let path = `<a:moveTo>${pt(points[0])}</a:moveTo>`;
    if (curved) {
        for (const [, c1, c2, end] of arrowCurveBeziers(points)) {
            path += `<a:cubicBezTo>${pt(c1)}${pt(c2)}${pt(end)}</a:cubicBezTo>`;
        }
    } else {
        for (const p of points.slice(1)) path += `<a:lnTo>${pt(p)}</a:lnTo>`;
    }
    // Only a looping line fills, as on the canvas.
    const fill = el.type === 'line' && isClosedPath(points) ? fillXml(parseFill(el.fill), opacity) : undefined;
    const geometry = customXml(slide, box, fill ? `${path}<a:close/>` : path, fill !== undefined);
    return spXml(slide, 'Freeform', box, geometry, fill ?? '<a:noFill/>', line);
}

// A freehand stroke is ink, not a line: perfect-freehand's outline filled in the stroke color, its curve drawn as the
// canvas draws it, through the midpoints between the outline's points. A looping stroke's fill lies under it.
function freedrawXml(el: VectorLinearElement, slide: Slide, opacity: number): string {
    const points = parsePoints(el.points);
    const outline = freedrawOutline(el).map(([x, y]) => ({ x, y }));
    if (outline.length === 0) return '';
    let fill = '';
    if (isClosedPath(points)) {
        const { box, pt } = pathFrame(el, points, slide);
        const lines = points.slice(1).map((p) => `<a:lnTo>${pt(p)}</a:lnTo>`);
        const path = `<a:moveTo>${pt(points[0])}</a:moveTo>${lines.join('')}<a:close/>`;
        fill = spXml(
            slide,
            'Fill',
            box,
            customXml(slide, box, path, true),
            fillXml(parseFill(el.fill), opacity),
            NO_LINE,
        );
    }
    const { box, pt } = pathFrame(el, outline, slide);
    const mid = (a: Point, b: Point) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    const curves = outline.map(
        (p, i) => `<a:quadBezTo>${pt(p)}${pt(mid(p, outline[(i + 1) % outline.length]))}</a:quadBezTo>`,
    );
    const path = `<a:moveTo>${pt(outline[0])}</a:moveTo>${curves.join('')}<a:close/>`;
    const ink = fillXml({ type: 'solid', color: el.strokeColor }, opacity);
    return fill + spXml(slide, 'Ink', box, customXml(slide, box, path, true), ink, NO_LINE);
}

const NO_LINE = '<a:ln><a:noFill/></a:ln>';

// The box a path is drawn in, centered where the element turns so a turned path turns about the canvas's center, and
// a point of the element's local frame as a point of that path.
function pathFrame(el: Box, points: Point[], slide: Slide): { box: Box; pt: (p: Point) => string } {
    const rx = Math.max(...points.map((p) => Math.abs(p.x - el.width / 2)));
    const ry = Math.max(...points.map((p) => Math.abs(p.y - el.height / 2)));
    const left = el.width / 2 - rx;
    const top = el.height / 2 - ry;
    return {
        box: { x: el.x + left, y: el.y + top, width: 2 * rx, height: 2 * ry, angle: el.angle },
        pt: (p) => `<a:pt x="${emu(slide, p.x - left)}" y="${emu(slide, p.y - top)}"/>`,
    };
}

function arrowXml(el: VectorArrowElement, slide: Slide, opacity: number): string {
    const points = arrowRoute(el, slide.deck.byId) ?? parsePoints(el.points);
    let xml = linearXml(el, points, slide, opacity, [el.startArrowhead, el.endArrowhead]);
    for (const position of ['start', 'end'] as const) {
        const head = position === 'start' ? el.startArrowhead : el.endArrowhead;
        const bar = head === 'bar' ? arrowheadGeometry(el, points, position, head) : null;
        if (bar?.kind !== 'barbs') continue;
        const [a, b] = [linearLocalToScene(el, bar.barb1), linearLocalToScene(el, bar.barb2)];
        xml += linearXml({ ...el, x: 0, y: 0, angle: 0 }, [a, b], slide, opacity);
    }
    const label = arrowLabelBox(el, points);
    if (!label) return xml;
    const center = linearLocalToScene(el, label.center);
    // The 5 px Eigen's mask leaves around the text.
    const pad = 5;
    const box = {
        x: center.x - label.width / 2 - pad,
        y: center.y - label.height / 2 - pad,
        width: label.width + 2 * pad,
        height: label.height + 2 * pad,
        angle: el.angle,
    };
    const text = textBodyXml(
        slide,
        el.text
            .split('\n')
            .map((line) => ({ runs: [{ text: line, marks: NO_MARKS }], depth: 0, quotes: 0, spaceBefore: false })),
        {
            fontFamily: el.fontFamily,
            fontSize: el.fontSize,
            color: el.strokeColor,
            bold: false,
            italic: false,
            underline: false,
            strike: false,
            textAlign: 'center',
            verticalAlign: 'center',
            letterSpacing: 0,
            lineHeight: getFontMetrics(el.fontFamily).lineHeight,
            inset: pad,
            wrap: false,
            opacity,
        },
    );
    const ground =
        slide.ground === undefined ? '<a:noFill/>' : fillXml({ type: 'solid', color: slide.ground }, opacity);
    return xml + spXml(slide, 'Label', box, presetXml('rect'), ground, NO_LINE, text);
}

// ── Pictures and backgrounds ─────────────────────────────────────────────────────────────────────────────────────

// The first element to show a media name adds its parts; a type Office can't embed, or an SVG without its PNG, adds none.
function imageOf(name: string, deck: Deck): Image | undefined {
    const known = deck.images.get(name);
    if (known) return known;
    const media = deck.media.get(name);
    if (!media) return undefined;
    const svg = media.contentType === 'image/svg+xml';
    const raster = svg ? media.png : media.data;
    const extension = svg ? 'png' : RASTER_EXTENSIONS.get(media.contentType);
    if (!raster || !extension) return undefined;
    const n = deck.images.size + 1;
    const image: Image = { part: `image${n}.${extension}`, width: media.width, height: media.height };
    deck.files.push([`ppt/media/${image.part}`, raster]);
    if (svg) {
        image.svgPart = `image${n}.svg`;
        deck.files.push([`ppt/media/${image.svgPart}`, media.data]);
    }
    deck.images.set(name, image);
    return image;
}

function blipXml(image: Image, slide: Slide, opacity: number): string {
    const rId = relate(slide, 'image', `../media/${image.part}`);
    const alpha = opacity < 1 ? `<a:alphaModFix amt="${share(opacity)}"/>` : '';
    const svg = image.svgPart
        ? `<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="${ASVG_NS}" r:embed="${relate(slide, 'image', `../media/${image.svgPart}`)}"/></a:ext></a:extLst>`
        : '';
    return `<a:blip r:embed="${rId}">${alpha}${svg}</a:blip>`;
}

// How much of each side cover cuts off the picture, or contain leaves empty in the box: one share, on the axis where
// the picture overshoots the box. Without the picture's size, nothing is cut and the picture stretches.
function fitOf(image: Image, width: number, height: number): { wide: boolean; cut: number } | null {
    if (!image.width || !image.height || width <= 0 || height <= 0) return null;
    const picture = image.width / image.height;
    const box = width / height;
    const cut = (1 - Math.min(picture, box) / Math.max(picture, box)) / 2;
    return cut > 0 ? { wide: picture > box, cut: share(cut) } : null;
}

function cropXml(fit: { wide: boolean; cut: number } | null): string {
    if (!fit) return '';
    return fit.wide ? `<a:srcRect l="${fit.cut}" r="${fit.cut}"/>` : `<a:srcRect t="${fit.cut}" b="${fit.cut}"/>`;
}

// Contain draws the picture in the box it fits, unrounded: Eigen's corner clip misses a fitted picture's corners. Its
// border keeps the element's box, as a shape of its own.
function pictureXml(el: VectorImageElement, slide: Slide, opacity: number): string {
    const image = imageOf(el.mediaName, slide.deck);
    const border = isBordered(el)
        ? spXml(slide, 'Border', el, boxGeometry(el, slide), '<a:noFill/>', lineXml(slide, el, opacity))
        : '';
    if (!image) return border;
    const fit = fitOf(image, el.width, el.height);
    const contain = el.objectFit === 'contain' && fit;
    const box = contain
        ? {
              ...el,
              x: fit.wide ? el.x : el.x + (el.width * fit.cut) / 100_000,
              y: fit.wide ? el.y + (el.height * fit.cut) / 100_000 : el.y,
              width: fit.wide ? el.width : el.width * (1 - (2 * fit.cut) / 100_000),
              height: fit.wide ? el.height * (1 - (2 * fit.cut) / 100_000) : el.height,
          }
        : el;
    const crop = el.objectFit === 'cover' ? cropXml(fit) : '';
    const geometry = contain ? presetXml('rect') : boxGeometry(el, slide);
    const id = ++slide.shapes;
    const picture = `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill>${blipXml(image, slide, opacity)}${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrmXml(slide, box)}${geometry}</p:spPr></p:pic>`;
    return picture + border;
}

function backgroundXml(background: BackgroundFill | null, frame: VectorFrame, slide: Slide): string {
    if (!background) return '';
    if (background.type !== 'image') return `<p:bg><p:bgPr>${fillXml(background, 1)}<a:effectLst/></p:bgPr></p:bg>`;
    const image = imageOf(background.mediaName, slide.deck);
    if (!image) return '';
    const fit = fitOf(image, frame.width, frame.height);
    // Contain insets the fill rectangle on the axis the picture leaves empty.
    const insets =
        background.fit === 'contain' && fit
            ? fit.wide
                ? ` t="${fit.cut}" b="${fit.cut}"`
                : ` l="${fit.cut}" r="${fit.cut}"`
            : '';
    const crop = background.fit === 'cover' ? cropXml(fit) : '';
    return `<p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1">${blipXml(image, slide, 1)}${crop}<a:stretch><a:fillRect${insets}/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`;
}

// ── Text ─────────────────────────────────────────────────────────────────────────────────────────────────────────

type Marks = { bold: boolean; italic: boolean; underline: boolean; strike: boolean; href?: string };

const NO_MARKS: Marks = { bold: false, italic: false, underline: false, strike: false };

// A '\n' run is a line break.
type Run = { text: string; marks: Marks };

type Paragraph = {
    runs: Run[];
    // List nesting, and whether this paragraph opens its item and so draws the marker.
    depth: number;
    marker?: 'bullet' | 'number';
    quotes: number;
    // canvas-text.css's `p + p` margin.
    spaceBefore: boolean;
};

// What a text body draws with: the box's typography, which every run and empty line writes in full.
type TextBox = {
    fontFamily: string;
    fontSize: number;
    color: string;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    strike: boolean;
    textAlign: TextAlign;
    verticalAlign: VerticalAlign;
    letterSpacing: number;
    lineHeight: number;
    inset: number;
    wrap: boolean;
    opacity: number;
};

// The LightEditor's HTML as paragraphs, read the way canvas-text.css lays it out: whitespace collapses, a list item's
// first paragraph draws its marker, a quote indents.
function paragraphsOf(html: string): Paragraph[] {
    const paragraphs: Paragraph[] = [];
    const lists: ('bullet' | 'number')[] = [];
    let current: Paragraph | undefined;
    let item = false;
    let quotes = 0;
    const open = (spaceBefore: boolean): Paragraph => {
        current = { runs: [], depth: lists.length, marker: item ? lists.at(-1) : undefined, quotes, spaceBefore };
        item = false;
        paragraphs.push(current);
        return current;
    };
    const walk = (node: Node, marks: Marks): void => {
        if (node.nodeType === 3) {
            const text = (node.textContent ?? '').replace(/[\t\n\f\r ]+/g, ' ');
            if (current || text.trim()) (current ?? open(false)).runs.push({ text, marks });
            return;
        }
        if (!isElement(node)) return;
        const tag = node.localName;
        const children = (inner: Marks) => {
            for (const child of node.childNodes) walk(child, inner);
        };
        if (tag === 'br') (current ?? open(false)).runs.push({ text: '\n', marks });
        else if (tag === 'strong') children({ ...marks, bold: true });
        else if (tag === 'em') children({ ...marks, italic: true });
        else if (tag === 'u') children({ ...marks, underline: true });
        else if (tag === 's') children({ ...marks, strike: true });
        else if (tag === 'a') children({ ...marks, underline: true, href: node.getAttribute('href') ?? undefined });
        else {
            current = undefined;
            if (tag === 'p') open(node.previousElementSibling?.localName === 'p');
            if (tag === 'li') item = true;
            if (tag === 'ul' || tag === 'ol') lists.push(tag === 'ol' ? 'number' : 'bullet');
            if (tag === 'blockquote') quotes++;
            children(marks);
            if (tag === 'ul' || tag === 'ol') lists.pop();
            if (tag === 'blockquote') quotes--;
            current = undefined;
        }
    };
    for (const node of JSDOM.fragment(html).childNodes) walk(node, NO_MARKS);
    if (paragraphs.length === 0) return [{ runs: [], depth: 0, quotes: 0, spaceBefore: false }];
    return paragraphs.map((paragraph) => ({ ...paragraph, runs: trimmed(paragraph.runs) }));
}

const ANCHORS: Record<VerticalAlign, string> = { top: 't', center: 'ctr', bottom: 'b' };
const ALIGNS: Record<TextAlign, string> = { left: 'l', center: 'ctr', right: 'r', justify: 'just' };

// canvas-text.css: a list level indents 1.5em, a quote 0.75em past its 3 px bar, and draws at 70%.
const LIST_INDENT_EM = 1.5;
// The marker's hang: a disc sits close to its text, a number right-aligned in the list's indent.
const MARKER_EM = { bullet: 0.75, number: 1.5 };
const QUOTE_INDENT_EM = 0.75;
const QUOTE_BAR_PX = 3;
const QUOTE_OPACITY = 0.7;
const PARAGRAPH_GAP_EM = 0.5;

function textBodyXml(slide: Slide, paragraphs: Paragraph[], box: TextBox): string {
    const em = (n: number) => emu(slide, n * box.fontSize);
    const inset = emu(slide, box.inset);
    // An exact pitch, CSS's: what a consumer takes as a single line varies (LibreOffice draws 1.2em for every face).
    const lineSpacing = `<a:lnSpc><a:spcPts val="${centipoints(slide, box.lineHeight * box.fontSize)}"/></a:lnSpc>`;
    const body = paragraphs.map((paragraph) => {
        const margin =
            em(paragraph.depth * LIST_INDENT_EM) + paragraph.quotes * (em(QUOTE_INDENT_EM) + emu(slide, QUOTE_BAR_PX));
        const indent = paragraph.marker ? -em(MARKER_EM[paragraph.marker]) : 0;
        const level = Math.min(8, Math.max(0, paragraph.depth - 1));
        const attrs = [
            margin ? ` marL="${margin}"` : '',
            indent ? ` indent="${indent}"` : '',
            level ? ` lvl="${level}"` : '',
            ` algn="${ALIGNS[box.textAlign]}"`,
        ].join('');
        const spacing = paragraph.spaceBefore
            ? `<a:spcBef><a:spcPts val="${centipoints(slide, PARAGRAPH_GAP_EM * box.fontSize)}"/></a:spcBef>`
            : '';
        const marker =
            paragraph.marker === 'bullet'
                ? '<a:buChar char="•"/>'
                : paragraph.marker === 'number'
                  ? '<a:buAutoNum type="arabicPeriod"/>'
                  : '<a:buNone/>';
        const opacity = box.opacity * QUOTE_OPACITY ** Math.min(1, paragraph.quotes);
        const runs = paragraph.runs.map((run) => {
            const props = runPropsXml('a:rPr', box, run.marks, opacity, slide);
            return run.text === '\n' ? `<a:br>${props}</a:br>` : `<a:r>${props}<a:t>${escapeXml(run.text)}</a:t></a:r>`;
        });
        const end = runPropsXml('a:endParaRPr', box, NO_MARKS, opacity, slide);
        return `<a:p><a:pPr${attrs}>${lineSpacing}${spacing}${marker}</a:pPr>${runs.join('')}${end}</a:p>`;
    });
    const wrap = box.wrap ? 'square' : 'none';
    return `<p:txBody><a:bodyPr wrap="${wrap}" lIns="${inset}" tIns="${inset}" rIns="${inset}" bIns="${inset}" anchor="${ANCHORS[box.verticalAlign]}" rtlCol="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>${body.join('')}</p:txBody>`;
}

// CSS drops the collapsed space at a line's start and end.
function trimmed(runs: Run[]): Run[] {
    const out = runs.filter((run) => run.text !== '');
    if (out.length > 0) out[0] = { ...out[0], text: out[0].text.trimStart() };
    if (out.length > 0) out[out.length - 1] = { ...out[out.length - 1], text: out[out.length - 1].text.trimEnd() };
    return out.filter((run) => run.text !== '');
}

function runPropsXml(tag: 'a:rPr' | 'a:endParaRPr', box: TextBox, marks: Marks, opacity: number, slide: Slide): string {
    const size = Math.min(400_000, Math.max(100, centipoints(slide, box.fontSize)));
    const spacing = centipoints(slide, box.letterSpacing);
    const attrs = [
        ` sz="${size}"`,
        box.bold || marks.bold ? ' b="1"' : '',
        box.italic || marks.italic ? ' i="1"' : '',
        box.underline || marks.underline ? ' u="sng"' : '',
        box.strike || marks.strike ? ' strike="sngStrike"' : '',
        spacing !== 0 ? ` spc="${spacing}"` : '',
    ].join('');
    const color = colorXml(box.color, opacity);
    const fill = color ? `<a:solidFill>${color}</a:solidFill>` : '<a:noFill/>';
    const face = escapeXml(box.fontFamily);
    const fonts = `<a:latin typeface="${face}"/><a:ea typeface="${face}"/><a:cs typeface="${face}"/>`;
    // A link draws in the run's color, as canvas-text.css draws it: PowerPoint's own extension for that.
    const link =
        marks.href && tag === 'a:rPr'
            ? `<a:hlinkClick r:id="${relate(slide, 'hyperlink', marks.href, true)}"><a:extLst><a:ext uri="{A12FA001-AC4F-418D-AE19-62706E023703}"><ahyp:hlinkClr xmlns:ahyp="http://schemas.microsoft.com/office/drawing/2018/hyperlinkcolor" val="tx"/></a:ext></a:extLst></a:hlinkClick>`
            : '';
    return `<${tag}${attrs} dirty="0">${fill}${fonts}${link}</${tag}>`;
}
