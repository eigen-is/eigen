// DrawingML, the drawing vocabulary docx, xlsx and pptx share, both ways. It resolves a colour element and its
// transforms through a theme's colours, and writes a colour and a plain theme. It names a picture's parts in its blip,
// maps text alignment, line ends and dashes onto the canvas's own, reads a text body's plain text, and anchors a
// turned picture over a spreadsheet's cells.

import type { Arrowhead, StrokeStyle, TextAlign, VerticalAlign } from '@workspace/lib/vector';
import { isTransparentColor, normalizeAngle } from '@workspace/lib/vector';
import { escapeXml } from '@workspace/lib/xml';
import type { XmlElement } from '../core/xml';
import { hasXmlName, xmlAttr, xmlChild, xmlChildren, xmlElements, xmlText } from '../core/xml';
import { A_NS, ASVG_NS, emu, R_NS } from './ooxml';

// ── Lines ───────────────────────────────────────────────────────────────────────────────────────────────────────

// The widest line ST_LineWidth allows, 1584 pt.
const MAX_LINE_WIDTH = 20_116_800;

// An a:ln width in EMU, or undefined when the file states none the schema allows. A crafted width such as 1e300
// would otherwise reach the canvas as a stroke wider than any slide.
export function lineWidthEmu(value: string | undefined): number | undefined {
    const width = emu(value);
    return width !== undefined && width >= 0 && width <= MAX_LINE_WIDTH ? width : undefined;
}

// ── Colours ─────────────────────────────────────────────────────────────────────────────────────────────────────

// A theme's colours by slot name (dk1, lt1, accent1…), each '#rrggbb'.
type ColorScheme = ReadonlyMap<string, string>;
// Maps each name a schemeClr may use onto the slot it shows. bg1, tx1, bg2 and tx2 each name a slot, and every slot
// names itself.
type ColorMap = ReadonlyMap<string, string>;
// phClr is the colour a style matrix entry is painted in, which the shape's fillRef, lnRef or bgRef supplies. It is
// '#rrggbb' or '#rrggbbaa'.
export type DrawingTheme = { scheme: ColorScheme; map: ColorMap; phClr?: string };

// A theme's slots in a:clrScheme's order.
export const SCHEME_SLOTS: readonly string[] = [
    'dk1',
    'lt1',
    'dk2',
    'lt2',
    'accent1',
    'accent2',
    'accent3',
    'accent4',
    'accent5',
    'accent6',
    'hlink',
    'folHlink',
];

// The map a part without a clrMap of its own shows its colours through: every xlsx part, and a docx's or pptx's chart
// without a c:clrMapOvr.
export const IDENTITY_COLOR_MAP: ColorMap = new Map([
    ['bg1', 'lt1'],
    ['tx1', 'dk1'],
    ['bg2', 'lt2'],
    ['tx2', 'dk2'],
    ...SCHEME_SLOTS.map((slot): [string, string] => [slot, slot]),
]);

// A part without a theme: no scheme colours, and the identity map.
export const NO_DRAWING_THEME: DrawingTheme = { scheme: new Map(), map: IDENTITY_COLOR_MAP };

// DrawingML counts an angle in 60,000ths of a degree.
export const DEGREE = 60_000;

// DrawingML counts a share of a whole (ST_Percentage) in 100,000ths, so 1,000 is one percent.
export const HUNDRED_PERCENT = 100_000;

// A theme part's a:clrScheme. A slot without a colour is left out.
export function readColorScheme(theme: XmlElement | undefined): ColorScheme {
    const elements = theme && hasXmlName(theme, A_NS, 'theme') ? xmlChild(theme, A_NS, 'themeElements') : undefined;
    const scheme = elements && xmlChild(elements, A_NS, 'clrScheme');
    const colors = new Map<string, string>();
    for (const slot of SCHEME_SLOTS) {
        const color = scheme && drawingColor(xmlChild(scheme, A_NS, slot), NO_DRAWING_THEME);
        if (color) colors.set(slot, color);
    }
    return colors;
}

// A theme part with no colour map over it, so every slot shows itself, as docx and xlsx charts read their theme.
export function drawingTheme(theme: XmlElement | undefined): DrawingTheme {
    return { scheme: readColorScheme(theme), map: IDENTITY_COLOR_MAP };
}

// An a:clrMap, p:clrMap or c:clrMapOvr: each attribute that names a slot replaces the identity map's entry.
export function readColorMap(element: XmlElement): ColorMap {
    const map = new Map(IDENTITY_COLOR_MAP);
    for (const name of IDENTITY_COLOR_MAP.keys()) {
        const slot = xmlAttr(element, '', name);
        if (slot && SCHEME_SLOTS.includes(slot)) map.set(name, slot);
    }
    return map;
}

// sRGB components and alpha, each 0–1.
type Rgba = [r: number, g: number, b: number, a: number];

// The colour a fill holds, such as an a:solidFill, a scheme slot or a gradient stop. It is '#rrggbb', or '#rrggbbaa'
// when not opaque.
export function drawingColor(fill: XmlElement | undefined, theme: DrawingTheme): string | undefined {
    for (const element of fill ? xmlElements(fill) : []) {
        if (element.ns !== A_NS) continue;
        const base = baseColor(element, theme);
        if (base === null) continue;
        if (base === undefined) return undefined;
        let rgba = base;
        for (const transform of xmlElements(element)) {
            const value = transform.ns === A_NS ? percent(xmlAttr(transform, '', 'val')) : undefined;
            if (value !== undefined) rgba = transformed(rgba, transform.local, value);
        }
        const bytes = rgba.map((component) => Math.round(clamp(component) * 255));
        const hex = bytes.map((byte) => byte.toString(16).padStart(2, '0'));
        return `#${hex.slice(0, 3).join('')}${bytes[3] === 255 ? '' : hex[3]}`;
    }
    return undefined;
}

// null when the element is no colour element. undefined when it is one but names nothing this theme holds.
function baseColor(element: XmlElement, theme: DrawingTheme): Rgba | null | undefined {
    const attr = (name: string) => xmlAttr(element, '', name);
    switch (element.local) {
        case 'srgbClr':
            return hexRgba(attr('val'));
        case 'sysClr':
            return hexRgba(attr('lastClr'));
        case 'schemeClr': {
            if (attr('val') === 'phClr') return placeholderRgba(theme.phClr);
            const slot = theme.map.get(attr('val') ?? '');
            return hexRgba(slot && theme.scheme.get(slot)?.slice(1));
        }
        case 'prstClr':
            return presetRgba(attr('val'));
        case 'scrgbClr': {
            const [r, g, b] = ['r', 'g', 'b'].map((name) => percent(attr(name)));
            return r === undefined || g === undefined || b === undefined
                ? undefined
                : [fromLinear(r), fromLinear(g), fromLinear(b), 1];
        }
        case 'hslClr': {
            const hue = Number(attr('hue')) / DEGREE;
            const sat = percent(attr('sat'));
            const lum = percent(attr('lum'));
            return Number.isFinite(hue) && sat !== undefined && lum !== undefined
                ? [...fromHsl(hue, clamp(sat), clamp(lum)), 1]
                : undefined;
        }
        default:
            return null;
    }
}

function hexRgba(hex: string | undefined): Rgba | undefined {
    if (!hex || !/^[0-9a-f]{6}$/i.test(hex)) return undefined;
    const value = Number.parseInt(hex, 16);
    return [(value >> 16) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255, 1];
}

// The placeholder keeps its alpha, which the entry's own alpha then replaces.
function placeholderRgba(color: string | undefined): Rgba | undefined {
    const [, rgb, alpha] = color?.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i) ?? [];
    const rgba = hexRgba(rgb);
    return rgba && alpha ? [rgba[0], rgba[1], rgba[2], Number.parseInt(alpha, 16) / 255] : rgba;
}

// CSS colour keywords that ECMA-376 has no preset for.
const NOT_PRESETS = new Set(['transparent', 'rebeccapurple']);

// ECMA-376's preset names are CSS's colour keywords, with dark, light and medium shortened to dk, lt and med.
function presetRgba(name: string | undefined): Rgba | undefined {
    if (!name || !/^[a-z]+$/i.test(name) || NOT_PRESETS.has(name.toLowerCase())) return undefined;
    const keyword = name.replace(/^(dk|lt|med)(?=[A-Z])/, (prefix) =>
        prefix === 'dk' ? 'dark' : prefix === 'lt' ? 'light' : 'medium',
    );
    return hexRgba(Bun.color(keyword.toLowerCase(), 'hex')?.slice(1));
}

// An ST_Percentage as a fraction. Transitional writes thousandths of a percent, and Strict writes '50%'.
export function percent(value: string | undefined): number | undefined {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    const fraction = trimmed.endsWith('%') ? Number(trimmed.slice(0, -1)) / 100 : Number(trimmed) / HUNDRED_PERCENT;
    return Number.isFinite(fraction) ? fraction : undefined;
}

function transformed(rgba: Rgba, transform: string, value: number): Rgba {
    const [r, g, b, a] = rgba;
    switch (transform) {
        case 'alpha':
            return [r, g, b, clamp(value)];
        case 'lumMod':
        case 'lumOff':
        case 'satMod': {
            const [hue, sat, lum] = toHsl(r, g, b);
            if (transform === 'satMod') return [...fromHsl(hue, clamp(sat * value), lum), a];
            return [...fromHsl(hue, sat, clamp(transform === 'lumMod' ? lum * value : lum + value)), a];
        }
        case 'tint':
        case 'shade': {
            const factor = clamp(value);
            const shift = (component: number) => {
                const linear = toLinear(component);
                return fromLinear(transform === 'tint' ? 1 - (1 - linear) * factor : linear * factor);
            };
            return [shift(r), shift(g), shift(b), a];
        }
        default:
            return rgba;
    }
}

// Office's tint, shade and scRGB work in linear light. LibreOffice matches Office with a plain 2.3 gamma.
const GAMMA = 2.3;

function toLinear(component: number): number {
    return component ** GAMMA;
}

function fromLinear(component: number): number {
    return clamp(component) ** (1 / GAMMA);
}

function clamp(value: number): number {
    return Math.min(1, Math.max(0, value));
}

// Hue in degrees, saturation and lightness 0–1.
function toHsl(r: number, g: number, b: number): [number, number, number] {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lum = (max + min) / 2;
    const delta = max - min;
    if (delta === 0) return [0, 0, lum];
    const sat = delta / (1 - Math.abs(2 * lum - 1));
    const hue = max === r ? ((g - b) / delta + 6) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
    return [hue * 60, sat, lum];
}

function fromHsl(hue: number, sat: number, lum: number): [number, number, number] {
    const chroma = (1 - Math.abs(2 * lum - 1)) * sat;
    const sector = (((hue % 360) + 360) % 360) / 60;
    const x = chroma * (1 - Math.abs((sector % 2) - 1));
    const m = lum - chroma / 2;
    const [r, g, b] =
        sector < 1
            ? [chroma, x, 0]
            : sector < 2
              ? [x, chroma, 0]
              : sector < 3
                ? [0, chroma, x]
                : sector < 4
                  ? [0, x, chroma]
                  : sector < 5
                    ? [x, 0, chroma]
                    : [chroma, 0, x];
    return [r + m, g + m, b + m];
}

// A stored colour token (#rgb, #rrggbb or #rrggbbaa) as an a:srgbClr. Its alpha, times `opacity`, goes inside as an
// a:alpha. Transparent and anything else is null.
export function colorXml(color: string, opacity = 1): string | null {
    const digits = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i)?.[1];
    if (!digits || isTransparentColor(color)) return null;
    const rgb = digits.length === 3 ? [...digits].map((digit) => digit + digit).join('') : digits.slice(0, 6);
    const alpha = (digits.length === 8 ? Number.parseInt(digits.slice(6), 16) / 255 : 1) * opacity;
    const share = alpha < 1 ? `<a:alpha val="${Math.round(alpha * HUNDRED_PERCENT)}"/>` : '';
    return `<a:srgbClr val="${rgb.toUpperCase()}">${share}</a:srgbClr>`;
}

export function solidFillXml(color: string, opacity = 1): string {
    const rgb = colorXml(color, opacity);
    return rgb ? `<a:solidFill>${rgb}</a:solidFill>` : '<a:noFill/>';
}

// ── Theme ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const THEME_TYPE = 'application/vnd.openxmlformats-officedocument.theme+xml';

// Every shape and cell the writers write holds its own colours and fonts, so the theme they package only has to be
// valid: plain colours, and the document's font.
const THEME_COLORS: Record<string, string> = {
    dk1: '000000',
    lt1: 'FFFFFF',
    dk2: '1E1E1E',
    lt2: 'F5F5F5',
    accent1: '1971C2',
    accent2: 'E03131',
    accent3: '2F9E44',
    accent4: 'F08C00',
    accent5: '6741D9',
    accent6: '0C8599',
    hlink: '1971C2',
    folHlink: '6741D9',
};

export function themeXml(font: string): string {
    const colors = SCHEME_SLOTS.map((slot) => `<a:${slot}><a:srgbClr val="${THEME_COLORS[slot]}"/></a:${slot}>`);
    const typefaces = `<a:latin typeface="${escapeXml(font)}"/><a:ea typeface=""/><a:cs typeface=""/>`;
    const placeholder = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
    const three = (xml: string) => xml.repeat(3);
    return [
        `<a:theme xmlns:a="${A_NS}" name="Eigen"><a:themeElements><a:clrScheme name="Eigen">${colors.join('')}</a:clrScheme>`,
        `<a:fontScheme name="Eigen"><a:majorFont>${typefaces}</a:majorFont><a:minorFont>${typefaces}</a:minorFont></a:fontScheme>`,
        `<a:fmtScheme name="Eigen"><a:fillStyleLst>${three(placeholder)}</a:fillStyleLst>`,
        `<a:lnStyleLst>${three(`<a:ln w="6350">${placeholder}</a:ln>`)}</a:lnStyleLst>`,
        `<a:effectStyleLst>${three('<a:effectStyle><a:effectLst/></a:effectStyle>')}</a:effectStyleLst>`,
        `<a:bgFillStyleLst>${three(placeholder)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`,
    ].join('');
}

// ── Pictures ────────────────────────────────────────────────────────────────────────────────────────────────────

// The image types a picture part is read or written as, each with its part's extension. WMF and EMF are among them,
// though no browser or sharp draws them, so a docx import keeps such a figure, with its alt text, as a broken image.
export const IMAGE_EXTENSION_BY_MIME = new Map([
    ['image/png', 'png'],
    ['image/jpeg', 'jpeg'],
    ['image/gif', 'gif'],
    ['image/webp', 'webp'],
    ['image/svg+xml', 'svg'],
    ['image/tiff', 'tiff'],
    ['image/bmp', 'bmp'],
    ['image/x-wmf', 'wmf'],
    ['image/x-emf', 'emf'],
]);

// image/jpg is a common misspelling of a part's declared type.
export const MIME_ALIASES = new Map([['image/jpg', 'image/jpeg']]);

// A picture's blip: its raster, and for an SVG the SVG's own part as the svgBlip extension, which Word, PowerPoint and
// LibreOffice draw instead. Effects go first, as CT_Blip puts them before its extensions.
export function blipXml(rId: string, svgRId: string | undefined, effects = ''): string {
    const svg = svgRId
        ? `<a:extLst><a:ext uri="{96DAC541-7B7A-43D3-8B79-37D633B846F1}"><asvg:svgBlip xmlns:asvg="${ASVG_NS}" r:embed="${svgRId}"/></a:ext></a:extLst>`
        : '';
    return effects || svg ? `<a:blip r:embed="${rId}">${effects}${svg}</a:blip>` : `<a:blip r:embed="${rId}"/>`;
}

// The parts an a:blip names, best first: its svgBlip extension's SVG, which Office draws instead, then its own raster.
// A reader falls back to the raster when it can't show the SVG's part.
export function blipEmbeds(blip: XmlElement | undefined): [svg: string | undefined, raster: string | undefined] {
    if (!blip) return [undefined, undefined];
    const extensions = xmlChild(blip, A_NS, 'extLst');
    const [svg] = extensions
        ? xmlChildren(extensions, A_NS, 'ext').flatMap((ext) => xmlChildren(ext, ASVG_NS, 'svgBlip'))
        : [];
    return [svg && xmlAttr(svg, R_NS, 'embed'), xmlAttr(blip, R_NS, 'embed')];
}

// ── Text and lines ──────────────────────────────────────────────────────────────────────────────────────────────

// A run's sz in hundredths of a point, held to the 1 to 4000 pt that ST_TextFontSize allows.
export function clampTextSize(hundredths: number): number {
    return Math.min(400_000, Math.max(100, Math.round(hundredths)));
}

// A paragraph's a:pPr algn for each canvas alignment, and back. The reader takes every justified kind as justify.
export const ALGN_BY_ALIGN: Record<TextAlign, string> = { left: 'l', center: 'ctr', right: 'r', justify: 'just' };
export const ALIGN_BY_ALGN = new Map<string, TextAlign>([
    ['l', 'left'],
    ['ctr', 'center'],
    ['r', 'right'],
    ['just', 'justify'],
    ['justLow', 'justify'],
    ['dist', 'justify'],
    ['thaiDist', 'justify'],
]);

// A text body's a:bodyPr anchor, both ways.
export const ANCHOR_BY_ALIGN: Record<VerticalAlign, string> = { top: 't', center: 'ctr', bottom: 'b' };
export const ALIGN_BY_ANCHOR = new Map<string, VerticalAlign>([
    ['t', 'top'],
    ['ctr', 'center'],
    ['b', 'bottom'],
]);

// An a:ln's headEnd or tailEnd type for each arrowhead. DrawingML has no bar end, so a writer draws a bar as a line of
// its own.
export const LINE_END_BY_ARROWHEAD: Record<Arrowhead, string> = {
    none: '',
    arrow: 'arrow',
    triangle: 'triangle',
    circle: 'oval',
    bar: '',
};

// A head or tail end as the arrowhead that draws closest.
export const ARROWHEAD_BY_LINE_END = new Map<string, Arrowhead>([
    ['triangle', 'triangle'],
    ['stealth', 'triangle'],
    ['arrow', 'arrow'],
    ['oval', 'circle'],
    ['diamond', 'circle'],
]);

// An a:ln's a:prstDash for each stroke style. A solid line writes none.
export const PRESET_DASH_BY_STYLE: Record<StrokeStyle, string> = { solid: '', dashed: 'dash', dotted: 'dot' };

// A preset dash as the stroke style that draws closest: the dots dotted, every other dash dashed.
export function strokeStyleOf(dash: string | undefined): StrokeStyle {
    return !dash || dash === 'solid' ? 'solid' : dash === 'dot' || dash === 'sysDot' ? 'dotted' : 'dashed';
}

// A text body's plain text, such as a c:rich or an a:txBody: a line per paragraph and per break, its runs and fields
// joined.
export function drawingLines(body: XmlElement): string[] {
    const lines: string[] = [];
    for (const paragraph of xmlElements(body)) {
        if (!hasXmlName(paragraph, A_NS, 'p')) continue;
        let line = '';
        for (const child of xmlElements(paragraph)) {
            if (child.ns !== A_NS) continue;
            if (child.local === 'br') {
                lines.push(line);
                line = '';
            }
            const text = (child.local === 'r' || child.local === 'fld') && xmlChild(child, A_NS, 't');
            if (text) line += xmlText(text).replace(/[\r\n]/g, ' ');
        }
        lines.push(line);
    }
    return lines;
}

// ── Spreadsheet anchors ─────────────────────────────────────────────────────────────────────────────────────────

// Whether a shape turned this far is within 45° of a quarter turn. A group scales such a shape along its swapped axes,
// and a spreadsheet anchors it by its box turned a quarter.
export function isSideways(degrees: number): boolean {
    const turn = normalizeAngle(degrees);
    return (turn >= 45 && turn < 135) || (turn >= 225 && turn < 315);
}

export type Box = { x: number; y: number; width: number; height: number };

// The cells Excel and LibreOffice place a picture turned `degrees` over: its box, or for a sideways one its box turned
// a quarter about its centre, so its sides swap. The mapping is its own inverse, so a reader takes the picture's box
// back from its anchor with it.
export function anchoredBox(box: Box, degrees: number): Box {
    if (!isSideways(degrees)) return box;
    const { x, y, width, height } = box;
    return { x: x + (width - height) / 2, y: y + (height - width) / 2, width: height, height: width };
}
