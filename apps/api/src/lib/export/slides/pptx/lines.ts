import type {
    Arrowhead,
    Box,
    PathCommand,
    Point,
    StrokeStyle,
    VectorArrowElement,
    VectorLinearElement,
    VectorPathElement,
} from '@workspace/lib/vector';
import {
    ARROW_LABEL_PAD,
    arrowCurveBeziers,
    arrowheadGeometry,
    arrowLabelBox,
    arrowRoute,
    freedrawOutline,
    getFontMetrics,
    isClosedPath,
    isTransparentFill,
    linearLocalToScene,
    parseFill,
    parsePoints,
    pointsBounds,
    scaledPathCommands,
} from '@workspace/lib/vector';
import { colorXml } from '../../../ooxml/drawingml';
import type { Slide } from './package';
import { customXml, fillXml, presetXml, spXml, toEmu, xfrmXml } from './shapes';
import { NO_MARKS, textBodyXml } from './text';

// Lines, arrows, freehand strokes and paths, and the a:ln every stroke is written as.

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
export function lineXml(
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
        `<a:ln w="${toEmu(slide, stroke.strokeWidth)}" cap="rnd"><a:solidFill>${color}</a:solidFill>`,
        dash ? `<a:prstDash val="${dash}"/>` : '',
        `<a:round/>${end('headEnd', ends[0])}${end('tailEnd', ends[1])}</a:ln>`,
    ].join('');
}

const PATH_COMMANDS: Record<PathCommand['op'], string> = {
    M: 'moveTo',
    L: 'lnTo',
    C: 'cubicBezTo',
    Q: 'quadBezTo',
    Z: 'close',
};

// A path's commands at its box size, in the EMU of the custGeom's path, which spans the box.
export function pathXml(el: VectorPathElement, slide: Slide): string {
    return scaledPathCommands(el.path, el.width, el.height)
        .map(({ op, points }) => {
            const tag = PATH_COMMANDS[op];
            if (points.length === 0) return `<a:${tag}/>`;
            const pts = points.map((p) => `<a:pt x="${toEmu(slide, p.x)}" y="${toEmu(slide, p.y)}"/>`);
            return `<a:${tag}>${pts.join('')}</a:${tag}>`;
        })
        .join('');
}

// A two-point line is a connector the way PowerPoint draws one, from corner to corner of the box it spans and flipped
// toward its end; more points are a path.
export function linearXml(
    el: VectorLinearElement | VectorArrowElement,
    points: Point[],
    slide: Slide,
    opacity: number,
    ends: [Arrowhead, Arrowhead] = ['none', 'none'],
): string {
    if (points.length === 0) return '';
    const line = lineXml(slide, el, opacity, ends);
    if (points.length === 2) {
        const [from, to] = points.map((p) => ({ x: el.x + p.x, y: el.y + p.y }));
        return segmentXml(slide, from, to, el.angle, line);
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
    const fill = el.type === 'line' && isClosedPath(points) ? fillXml(parseFill(el.fill), opacity, box) : undefined;
    const geometry = customXml(slide, box, fill ? `${path}<a:close/>` : path, fill !== undefined);
    return spXml(slide, 'Freeform', box, geometry, fill ?? '<a:noFill/>', line);
}

// A segment of the slide, turned by angle about its middle.
function segmentXml(slide: Slide, from: Point, to: Point, angle: number, line: string): string {
    const bounds = pointsBounds([from, to]);
    const box = {
        x: bounds.minX,
        y: bounds.minY,
        width: bounds.maxX - bounds.minX,
        height: bounds.maxY - bounds.minY,
        angle,
    };
    const id = ++slide.shapes;
    return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="Line ${id}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>${xfrmXml(slide, box, to.x < from.x, to.y < from.y)}${presetXml('line')}<a:noFill/>${line}</p:spPr></p:cxnSp>`;
}

// A freehand stroke is ink, not a line: perfect-freehand's outline filled in the stroke color, its curve drawn as the
// canvas draws it, through the midpoints between the outline's points. A looping stroke's fill lies under it.
export function freedrawXml(el: VectorLinearElement, slide: Slide, opacity: number): string {
    const points = parsePoints(el.points);
    const outline = freedrawOutline(el, points).map(([x, y]) => ({ x, y }));
    if (outline.length === 0) return '';
    let fill = '';
    if (isClosedPath(points) && !isTransparentFill(parseFill(el.fill))) {
        const { box, pt } = pathFrame(el, points, slide);
        const lines = points.slice(1).map((p) => `<a:lnTo>${pt(p)}</a:lnTo>`);
        const path = `<a:moveTo>${pt(points[0])}</a:moveTo>${lines.join('')}<a:close/>`;
        fill = spXml(
            slide,
            'Fill',
            box,
            customXml(slide, box, path, true),
            fillXml(parseFill(el.fill), opacity, box),
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
    const { minX, minY, maxX, maxY } = pointsBounds(points);
    const rx = Math.max(maxX - el.width / 2, el.width / 2 - minX);
    const ry = Math.max(maxY - el.height / 2, el.height / 2 - minY);
    const left = el.width / 2 - rx;
    const top = el.height / 2 - ry;
    return {
        box: { x: el.x + left, y: el.y + top, width: 2 * rx, height: 2 * ry, angle: el.angle },
        pt: (p) => `<a:pt x="${toEmu(slide, p.x - left)}" y="${toEmu(slide, p.y - top)}"/>`,
    };
}

export function arrowXml(el: VectorArrowElement, slide: Slide, opacity: number): string {
    const points = arrowRoute(el, slide.deck.byId) ?? parsePoints(el.points);
    let xml = linearXml(el, points, slide, opacity, [el.startArrowhead, el.endArrowhead]);
    for (const position of ['start', 'end'] as const) {
        const head = position === 'start' ? el.startArrowhead : el.endArrowhead;
        const bar = head === 'bar' ? arrowheadGeometry(el, points, position, head) : null;
        if (bar?.kind !== 'barbs') continue;
        const [a, b] = [linearLocalToScene(el, bar.barb1), linearLocalToScene(el, bar.barb2)];
        xml += segmentXml(slide, a, b, 0, lineXml(slide, el, opacity));
    }
    const label = arrowLabelBox(el, points);
    if (!label) return xml;
    const center = linearLocalToScene(el, label.center);
    const lines = el.text.split('\n');
    const boxOf = (width: number) => ({
        x: center.x - width / 2 - ARROW_LABEL_PAD,
        y: center.y - label.height / 2 - ARROW_LABEL_PAD,
        width: width + 2 * ARROW_LABEL_PAD,
        height: label.height + 2 * ARROW_LABEL_PAD,
        angle: el.angle,
    });
    const text = textBodyXml(
        slide,
        lines.map((line) => ({ runs: [{ text: line, marks: NO_MARKS }], depth: 0, quotes: 0, spaceBefore: false })),
        {
            ...NO_MARKS,
            fontFamily: el.fontFamily,
            fontSize: el.fontSize,
            color: el.strokeColor,
            textAlign: 'center',
            verticalAlign: 'center',
            letterSpacing: 0,
            lineHeight: getFontMetrics(el.fontFamily).lineHeight,
            inset: ARROW_LABEL_PAD,
            wrap: false,
            opacity,
        },
    );
    // The mask paints the slide's solid color under the label; the text's own box is an em per character wide, as
    // Google Slides wraps a box set not to.
    const mask =
        slide.ground === undefined
            ? ''
            : spXml(
                  slide,
                  'Mask',
                  boxOf(label.width),
                  presetXml('rect'),
                  fillXml({ type: 'solid', color: slide.ground }, opacity),
                  NO_LINE,
              );
    const longest = lines.reduce((most, line) => Math.max(most, [...line].length), 0);
    const box = boxOf(Math.max(label.width, longest * el.fontSize));
    return xml + mask + spXml(slide, 'Label', box, presetXml('rect'), '<a:noFill/>', NO_LINE, text);
}
