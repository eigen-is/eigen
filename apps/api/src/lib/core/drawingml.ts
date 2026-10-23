import { escapeXml } from '@workspace/lib/xml';
import { A_NS } from './ooxml';
import { hasXmlName, type XmlElement, xmlAttr, xmlChild, xmlElements, xmlText } from './xml';

// DrawingML, the drawing vocabulary docx, xlsx and pptx share: a theme's colours, a colour element with its
// transforms, a text body's plain text, and the theme the writers write.

// A theme's colours by slot name (dk1, lt1, accent1…), each '#rrggbb'.
export type ColorScheme = ReadonlyMap<string, string>;
// What a schemeClr names to the slot it shows: bg1, tx1, bg2 and tx2 are mapped, the slots name themselves.
export type ColorMap = ReadonlyMap<string, string>;
// phClr: the colour the fillRef, lnRef or bgRef supplies when a style matrix entry is painted, '#rrggbb' or '#rrggbbaa'.
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

// What a part without a clrMap of its own shows: an xlsx, and a chart without c:clrMapOvr in a pptx or docx with none.
export const IDENTITY_COLOR_MAP: ColorMap = new Map([
    ['bg1', 'lt1'],
    ['tx1', 'dk1'],
    ['bg2', 'lt2'],
    ['tx2', 'dk2'],
    ...SCHEME_SLOTS.map((slot): [string, string] => [slot, slot]),
]);

const NO_THEME: DrawingTheme = { scheme: new Map(), map: IDENTITY_COLOR_MAP };

export const THEME_TYPE = 'application/vnd.openxmlformats-officedocument.theme+xml';

// Every shape and cell the writers write holds its own colours and fonts, so their theme only has to be valid: plain
// colours, and the document's font.
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

// A theme part's a:clrScheme; a slot with no colour is left out.
export function readColorScheme(theme: XmlElement | undefined): ColorScheme {
    const elements = theme && hasXmlName(theme, A_NS, 'theme') ? xmlChild(theme, A_NS, 'themeElements') : undefined;
    const scheme = elements && xmlChild(elements, A_NS, 'clrScheme');
    const colors = new Map<string, string>();
    for (const slot of SCHEME_SLOTS) {
        const color = scheme && drawingColor(xmlChild(scheme, A_NS, slot), NO_THEME);
        if (color) colors.set(slot, color);
    }
    return colors;
}

// A theme part with no colour map over it, as a docx's and an xlsx's charts read theirs: the slots name themselves.
export function drawingTheme(theme: XmlElement | undefined): DrawingTheme {
    return { scheme: readColorScheme(theme), map: IDENTITY_COLOR_MAP };
}

// An a:clrMap, p:clrMap or c:clrMapOvr: its attributes over the identity, each naming a slot.
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

// The colour a fill (a:solidFill, a scheme slot, a gradient stop) holds: '#rrggbb', or '#rrggbbaa' when not opaque.
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

// null: no colour element; undefined: a colour element naming nothing this theme holds.
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
            const hue = Number(attr('hue')) / 60000;
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

// The placeholder keeps its alpha, which the entry's own alpha replaces.
function placeholderRgba(color: string | undefined): Rgba | undefined {
    const [, rgb, alpha] = color?.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i) ?? [];
    const rgba = hexRgba(rgb);
    return rgba && alpha ? [rgba[0], rgba[1], rgba[2], Number.parseInt(alpha, 16) / 255] : rgba;
}

// CSS colour keywords ECMA-376 has no preset for.
const NOT_PRESETS = new Set(['transparent', 'rebeccapurple']);

// ECMA-376's preset names are CSS's colour keywords, dark, light and medium shortened.
function presetRgba(name: string | undefined): Rgba | undefined {
    if (!name || !/^[a-z]+$/i.test(name) || NOT_PRESETS.has(name.toLowerCase())) return undefined;
    const keyword = name.replace(/^(dk|lt|med)(?=[A-Z])/, (prefix) =>
        prefix === 'dk' ? 'dark' : prefix === 'lt' ? 'light' : 'medium',
    );
    return hexRgba(Bun.color(keyword.toLowerCase(), 'hex')?.slice(1));
}

// ST_Percentage: thousandths of a percent, or Strict's '50%'; as a fraction.
export function percent(value: string | undefined): number | undefined {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    const fraction = trimmed.endsWith('%') ? Number(trimmed.slice(0, -1)) / 100 : Number(trimmed) / 100000;
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

// Office's tint, shade and scRGB work in linear light; LibreOffice matches Office with a plain 2.3 gamma.
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

// A text body's (c:rich, a:txBody) plain text: a line per paragraph and per break, runs and fields joined.
// The docx import's drawingLine (import/doc/drawings.ts) walks runs the same way into rich text; to unify later.
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
