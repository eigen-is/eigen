// Each element as the DrawingML shape that draws it, its box, geometry and fill, each length in the deck's EMU; a chart
// as a graphic frame showing its own chart part.

import { gradientStops } from '@workspace/lib/background';
import { readChartLook, readChartSpec } from '@workspace/lib/charts';
import type { FillPaint } from '@workspace/lib/types/background';
import type { Box, Corners, Point, VectorChartElement, VectorElement } from '@workspace/lib/vector';
import {
    cornerRadius,
    diamondOutline,
    isBordered,
    isTransparentFill,
    normalizeAngle,
    parseFill,
    parsePoints,
    rectOutline,
} from '@workspace/lib/vector';
import { colorXml, DEGREE, HUNDRED_PERCENT, solidFillXml } from '../../../ooxml/drawingml';
import { chartGraphicXml } from '../../../ooxml/ooxml-chart-writer';
import { addOfficeChart } from '../../office-chart';
import { arrowXml, freedrawXml, linearXml, lineXml, pathXml } from './lines';
import type { Slide } from './package';
import { pictureXml } from './pictures';
import { paragraphsOf, textBodyXml } from './text';

// ST_Coordinate's bound, which every offset, extent and path point stays within.
const MAX_COORDINATE = 27_273_042_316_900;

export function toEmu(slide: Slide, px: number): number {
    return Math.min(MAX_COORDINATE, Math.max(-MAX_COORDINATE, Math.round(px * slide.deck.scale)));
}

// 1000ths of a percent, DrawingML's share of a whole.
export function share(value: number): number {
    return Math.round(value * HUNDRED_PERCENT);
}

function degrees(radians: number): number {
    return (radians * 180) / Math.PI;
}

// Degrees clockwise as DrawingML's 60,000ths, within one turn.
export function angle(value: number): number {
    return Math.round(normalizeAngle(value) * DEGREE) % (360 * DEGREE);
}

export function elementXml(el: VectorElement, slide: Slide): string {
    const opacity = el.opacity / 100;
    switch (el.type) {
        case 'rectangle':
            return spXml(
                slide,
                'Rectangle',
                el,
                boxGeometry(el),
                fillXml(parseFill(el.fill), opacity, el),
                lineXml(slide, el, opacity),
            );
        case 'ellipse':
            return spXml(
                slide,
                'Ellipse',
                el,
                presetXml('ellipse'),
                fillXml(parseFill(el.fill), opacity, el),
                lineXml(slide, el, opacity),
            );
        case 'diamond': {
            const outline = diamondOutline(
                { x: 0, y: 0, width: el.width, height: el.height },
                cornerRadius(el, 'diamond'),
                0,
            );
            const geometry =
                outline.kind === 'rounded'
                    ? outlineGeometry(outline.core, outline.radius, el, slide)
                    : presetXml('diamond');
            return spXml(
                slide,
                'Diamond',
                el,
                geometry,
                fillXml(parseFill(el.fill), opacity, el),
                lineXml(slide, el, opacity),
            );
        }
        case 'pie': {
            // Eigen's angles are the box-normalized circle's; DrawingML's pie takes the angles as drawn on the ellipse.
            const visual = (stored: number) => {
                const theta = (stored * Math.PI) / 180;
                return angle(degrees(Math.atan2(el.height * Math.sin(theta), el.width * Math.cos(theta))));
            };
            const [adj1, adj2] = [visual(el.startAngle), visual(el.startAngle + el.sweepAngle)];
            // A pie whose angles meet draws the whole disc: a slice that thin draws nothing, one that full the disc.
            if (adj1 === adj2 && el.sweepAngle < 180) return '';
            const geometry =
                el.sweepAngle >= 360 || adj1 === adj2 ? presetXml('ellipse') : presetXml('pie', { adj1, adj2 });
            // A gradient spans the whole ellipse's box here, at its angle; the canvas paints it across the slice's own.
            return spXml(
                slide,
                'Pie',
                el,
                geometry,
                fillXml(parseFill(el.fill), opacity, el),
                lineXml(slide, el, opacity),
            );
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
            const outline = rectOutline({ x: 0, y: 0, width: el.width, height: el.height }, cornerRadius(el), 0);
            const painted = isBordered(el) || !isTransparentFill(parseFill(el.fill));
            const geometry =
                painted && outline.kind === 'rounded'
                    ? outlineGeometry(outline.core, outline.radius, el, slide)
                    : presetXml('rect');
            return spXml(
                slide,
                'Text',
                el,
                geometry,
                fillXml(parseFill(el.fill), opacity, el),
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
        case 'path': {
            // An open path only strokes, as on the canvas.
            const fill = el.closed ? fillXml(parseFill(el.fill), opacity, el) : '<a:noFill/>';
            const geometry = customXml(slide, el, pathXml(el, slide), el.closed);
            return spXml(slide, 'Freeform', el, geometry, fill, lineXml(slide, el, opacity));
        }
        case 'chart':
            return chartXml(el, slide);
    }
}

// A graphic frame showing the chart's own part, drawn plain, upright and opaque: a frame turns and fades no chart, and a
// chart part paints no sketch, hatch, gradient or dash. A spec that doesn't parse or holds range data draws nothing, as
// on the canvas it draws only its placeholder. Its numbers go in a workbook of its own, which Edit Data opens.
function chartXml(el: VectorChartElement, slide: Slide): string {
    const { spec } = readChartSpec(el);
    if (!spec) return '';
    const frame = { width: el.width, height: el.height, emuPerPx: slide.deck.scale };
    const rId = addOfficeChart(
        slide.deck.charts,
        spec,
        { look: readChartLook(el), frame },
        { target: '../charts/', relate: slide.part.relate },
    );
    if (!rId) return '';
    const id = ++slide.shapes;
    const offset = `<a:off x="${toEmu(slide, el.x)}" y="${toEmu(slide, el.y)}"/>`;
    const extent = `<a:ext cx="${toEmu(slide, el.width)}" cy="${toEmu(slide, el.height)}"/>`;
    return [
        `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Chart ${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>`,
        `<p:xfrm>${offset}${extent}</p:xfrm>${chartGraphicXml(rId)}</p:graphicFrame>`,
    ].join('');
}

export function spXml(
    slide: Slide,
    name: string,
    box: Box,
    geometry: string,
    fill: string,
    line: string,
    text = '',
): string {
    const id = ++slide.shapes;
    const textBox = text ? ' txBox="1"' : '';
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name} ${id}"/><p:cNvSpPr${textBox}/><p:nvPr/></p:nvSpPr><p:spPr>${xfrmXml(slide, box)}${geometry}${fill}${line}</p:spPr>${text}</p:sp>`;
}

export function xfrmXml(slide: Slide, box: Box, flipH = false, flipV = false): string {
    const rot = angle(box.angle);
    const attrs = `${rot ? ` rot="${rot}"` : ''}${flipH ? ' flipH="1"' : ''}${flipV ? ' flipV="1"' : ''}`;
    return `<a:xfrm${attrs}><a:off x="${toEmu(slide, box.x)}" y="${toEmu(slide, box.y)}"/><a:ext cx="${toEmu(slide, box.width)}" cy="${toEmu(slide, box.height)}"/></a:xfrm>`;
}

export function presetXml(preset: string, guides: Record<string, number> = {}): string {
    const avs = Object.entries(guides).map(([name, value]) => `<a:gd name="${name}" fmla="val ${value}"/>`);
    return `<a:prstGeom prst="${preset}"><a:avLst>${avs.join('')}</a:avLst></a:prstGeom>`;
}

// roundRect's adj is the radius over the short side, so it draws the radius Eigen's corners give.
export function boxGeometry(el: Box & { corners: Corners }): string {
    const radius = cornerRadius(el);
    const side = Math.min(el.width, el.height);
    if (radius <= 0) return presetXml('rect');
    return presetXml('roundRect', { adj: Math.min(50_000, share(radius / side)) });
}

// A rounded outline is its core's edges pushed out by the radius, joined by arcs about the core's corners.
function outlineGeometry(core: Point[], radius: number, box: Box, slide: Slide): string {
    const pt = (p: Point) => `<a:pt x="${toEmu(slide, p.x)}" y="${toEmu(slide, p.y)}"/>`;
    const r = toEmu(slide, radius);
    if (core.length === 1) {
        const circle = `<a:moveTo>${pt({ x: core[0].x + radius, y: core[0].y })}</a:moveTo><a:arcTo wR="${r}" hR="${r}" stAng="0" swAng="${360 * DEGREE}"/>`;
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

export function customXml(slide: Slide, box: { width: number; height: number }, path: string, filled: boolean): string {
    const w = Math.max(1, toEmu(slide, box.width));
    const h = Math.max(1, toEmu(slide, box.height));
    return `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${w}" h="${h}"${filled ? '' : ' fill="none"'}>${path}</a:path></a:pathLst></a:custGeom>`;
}

// The paint alone: a hatched or rough fill exports solid. A gradient takes the stops the canvas samples and its CSS
// angle (0 paints upward) as DrawingML's (0 paints rightward). The canvas paints an element's in the box's own units
// (gradientVector), so stretched with the box it runs at another angle; a background is CSS's, at its own. LibreOffice
// ignores a:lin's scaled, so the angle is the stretched one.
export function fillXml(
    paint: FillPaint,
    opacity: number,
    box: { width: number; height: number } = { width: 1, height: 1 },
): string {
    if (paint.type === 'solid') return solidFillXml(paint.color, opacity);
    const stops = gradientStops(paint.from, paint.to).map(
        (stop) => `<a:gs pos="${share(stop.offset)}">${colorXml(stop.color, stop.opacity * opacity)}</a:gs>`,
    );
    const css = (paint.angle * Math.PI) / 180;
    const along = degrees(Math.atan2(-Math.cos(css) * box.width, Math.sin(css) * box.height));
    return `<a:gradFill rotWithShape="1"><a:gsLst>${stops.join('')}</a:gsLst><a:lin ang="${angle(along)}" scaled="0"/></a:gradFill>`;
}
